import CryptoKit
import Foundation

nonisolated struct IntegrationRecordingThumbnail: Codable, Sendable {
  let thumbnailID: String
  let sourceVersion: String
  let sha256: String
  let width: Int
  let height: Int
  let size: Int
  let version: String
}

extension StackControlService {
  private static var preparingThumbnails: [String: Task<IntegrationRecordingThumbnail, Error>] = [:]
  private var thumbnailDirectory: URL { integrationDirectory.appendingPathComponent("RecordingThumbnails", isDirectory: true) }

  func handleIntegrationRecordingThumbnail(_ method: String, params: JSONValue, session: ReproSession) async throws -> JSONValue {
    guard !session.status.isActive, session.status == .ready, let video = session.videoURL else {
      throw StackControlError(code: "thumbnail_unavailable", message: "A thumbnail is available only for a saved recording with video")
    }
    let source = try await Task.detached(priority: .utility) { try Self.recordingChunk(video, offset: 0, length: 0) }.value
    guard let sourceVersion = source["version"]?.stringValue else { throw StackControlError(code: "thumbnail_unavailable", message: "The recording video is unavailable") }
    let at = min(max(0, session.duration * 0.35), 2)
    let key = SHA256.hash(data: Data(("deckhand-thumbnail-v1\n" + session.id.uuidString + "\n" + sourceVersion + "\n" + String(at)).utf8)).map { String(format: "%02x", $0) }.joined()
    if method == "integration.recording.thumbnail.chunk", params["thumbnailID"]?.stringValue != key {
      throw StackControlError(code: "asset_changed", message: "The recording source changed; request a fresh thumbnail")
    }
    try FileManager.default.createDirectory(at: thumbnailDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let cacheRoot = thumbnailDirectory.standardizedFileURL.resolvingSymlinksInPath()
    let folder = cacheRoot.appendingPathComponent(key, isDirectory: true)
    guard folder.standardizedFileURL.resolvingSymlinksInPath().path.hasPrefix(cacheRoot.path + "/") else {
      throw StackControlError.invalid("Thumbnail escaped its owned cache")
    }
    let receiptURL = folder.appendingPathComponent("thumbnail.json")
    let receipt: IntegrationRecordingThumbnail
    if let cachedReceipt = IntegrationEvidenceResourcePath.resource(for: "thumbnail.json", in: folder),
      let data = try? Data(contentsOf: cachedReceipt), data.count <= 8192,
      let cached = try? JSONDecoder().decode(IntegrationRecordingThumbnail.self, from: data), cached.thumbnailID == key, cached.sourceVersion == sourceVersion {
      receipt = cached
    } else if method == "integration.recording.thumbnail" {
      if let pending = Self.preparingThumbnails[key] { receipt = try await pending.value }
      else {
        guard Self.preparingThumbnails.count < 2 else { throw StackControlError(code: "thumbnail_busy", message: "Thumbnail extraction is busy; retry after current images finish") }
        let retained = (try? FileManager.default.contentsOfDirectory(at: thumbnailDirectory, includingPropertiesForKeys: nil)) ?? []
        // At most 512 images of 256 KiB each; cached evidence is never exported as a bundle.
        guard retained.count + Self.preparingThumbnails.count < 512 else { throw StackControlError(code: "thumbnail_cache_full", message: "The bounded thumbnail cache is full") }
        let task = Task.detached(priority: .utility) { () throws -> IntegrationRecordingThumbnail in
          let frames = try await ReproFrames.extract(video: video, at: [at], maxDimension: 480, into: folder, names: ["preview"])
          guard let frame = frames.first, frame.data.count > 0, frame.data.count <= 262_144, frame.width > 0, frame.height > 0, max(frame.width, frame.height) <= 480 else {
            throw StackControlError(code: "thumbnail_unavailable", message: "The extracted thumbnail exceeded its bounded image size")
          }
          let after = try Self.recordingChunk(video, offset: 0, length: 0)
          guard after["version"]?.stringValue == sourceVersion else { throw StackControlError(code: "asset_changed", message: "The recording changed during thumbnail extraction") }
          let chunk = try Self.recordingChunk(frame.url, offset: 0, length: 0, mimeType: "image/jpeg")
          guard let version = chunk["version"]?.stringValue else { throw StackControlError(code: "thumbnail_unavailable", message: "Could not read the extracted thumbnail") }
          let result = IntegrationRecordingThumbnail(thumbnailID: key, sourceVersion: sourceVersion,
            sha256: SHA256.hash(data: frame.data).map { String(format: "%02x", $0) }.joined(), width: frame.width, height: frame.height, size: frame.data.count, version: version)
          try JSONEncoder().encode(result).write(to: receiptURL, options: .atomic)
          try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: receiptURL.path)
          try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: frame.url.path)
          return result
        }
        Self.preparingThumbnails[key] = task
        defer { Self.preparingThumbnails.removeValue(forKey: key) }
        receipt = try await task.value
      }
    } else { throw StackControlError(code: "thumbnail_unavailable", message: "The prepared thumbnail is no longer available") }
    guard let file = IntegrationEvidenceResourcePath.resource(for: "preview.jpg", in: folder),
      file.path.hasPrefix(thumbnailDirectory.resolvingSymlinksInPath().path + "/") else {
      throw StackControlError(code: "thumbnail_unavailable", message: "The cached thumbnail is unavailable")
    }
    let offset = method == "integration.recording.thumbnail" ? 0 : params["offset"]?.intValue ?? -1
    let length = method == "integration.recording.thumbnail" ? 0 : params["length"]?.intValue ?? -1
    guard offset >= 0, length >= 0, length <= 262_144 else { throw StackControlError.invalid("Request at most 256 KiB of a thumbnail") }
    var chunk = try await Task.detached(priority: .utility) { try Self.recordingChunk(file, offset: offset, length: length, mimeType: "image/jpeg") }.value.objectValue ?? [:]
    guard chunk["size"]?.intValue == receipt.size, chunk["version"]?.stringValue == receipt.version else {
      throw StackControlError(code: "asset_changed", message: "The immutable thumbnail cache changed")
    }
    chunk["thumbnailID"] = .string(key); chunk["sha256"] = .string(receipt.sha256)
    chunk["width"] = .number(Double(receipt.width)); chunk["height"] = .number(Double(receipt.height))
    return .object(chunk)
  }
}
