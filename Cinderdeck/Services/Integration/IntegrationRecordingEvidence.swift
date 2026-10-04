import CryptoKit
import Foundation

nonisolated struct IntegrationEvidenceAsset: Codable, Sendable {
  let id: String
  let name: String
  let kind: String
  let mimeType: String
  let size: Int
  let sha256: String?
  let state: String
  let detail: String?
  let relativePath: String?
  var version: String?
  var value: JSONValue { .object(["id": .string(id), "name": .string(name), "kind": .string(kind), "mimeType": .string(mimeType),
    "size": .number(Double(size)), "sha256": sha256.map(JSONValue.string) ?? .null, "state": .string(state), "detail": detail.map(JSONValue.string) ?? .null]) }
}
nonisolated struct IntegrationEvidencePreparation: Codable, Sendable {
  let operationKey: String
  let actorKey: String
  let installationID: String
  let workspaceID: String
  let generation: Int
  let recordingID: UUID
  let preparationID: UUID
  var state = "preparing"
  var assets: [IntegrationEvidenceAsset] = []
  var detail: String?
  var folder: String?
  var value: JSONValue { .object(["preparationID": .string(preparationID.uuidString), "recordingID": .string(recordingID.uuidString),
    "state": .string(state), "assets": .array(assets.map(\.value)), "detail": detail.map(JSONValue.string) ?? .null]) }
}
extension StackControlService {
  private static var preparingEvidence = Set<UUID>()
  private var evidenceDirectory: URL { integrationDirectory.appendingPathComponent("EvidenceBundles", isDirectory: true) }
  private func evidenceReceiptURL(_ id: UUID) -> URL { evidenceDirectory.appendingPathComponent(id.uuidString, isDirectory: true).appendingPathComponent("receipt.json") }
  private func evidenceOperationURL(actor: StackActor, key: String) -> URL {
    let digest = SHA256.hash(data: Data((actor.key + "\n" + key).utf8)).map { String(format: "%02x", $0) }.joined()
    return evidenceDirectory.appendingPathComponent("Operations", isDirectory: true).appendingPathComponent(digest + ".json")
  }
  private func saveEvidence(_ receipt: IntegrationEvidencePreparation, actor: StackActor) throws {
    let manager = FileManager.default
    let directory = evidenceReceiptURL(receipt.preparationID).deletingLastPathComponent()
    try manager.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let operations = evidenceOperationURL(actor: actor, key: receipt.operationKey).deletingLastPathComponent()
    try manager.createDirectory(at: operations, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let data = try JSONEncoder().encode(receipt)
    for url in [evidenceReceiptURL(receipt.preparationID), evidenceOperationURL(actor: actor, key: receipt.operationKey)] {
      try data.write(to: url, options: .atomic); try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
  }
  func handleIntegrationRecordingEvidence(_ method: String, params: JSONValue, session: ReproSession, actor: StackActor) async throws -> JSONValue {
    guard !session.status.isActive else { throw StackControlError(code: "recording_busy", message: "Stop and save the recording before preparing evidence") }
    guard let installation = params["installationID"]?.stringValue, let workspace = params["workspaceID"]?.stringValue,
      let generation = params["generation"]?.intValue else { throw StackControlError.invalid("Missing evidence context") }
    if method == "integration.recording.evidence.prepare" {
      guard let key = params["operationKey"]?.stringValue, !key.isEmpty, key.utf8.count <= 160 else { throw StackControlError.invalid("Pass a durable preparation key") }
      if let data = try? Data(contentsOf: evidenceOperationURL(actor: actor, key: key)),
        let old = try? JSONDecoder().decode(IntegrationEvidencePreparation.self, from: data) {
        guard old.actorKey == actor.key, old.installationID == installation, old.workspaceID == workspace, old.generation == generation, old.recordingID == session.id else { throw StackControlError(code: "operation_conflict", message: "The evidence request key belongs to another recording context") }
        return old.value
      }
      guard Self.preparingEvidence.count < 2 else { throw StackControlError(code: "preparation_busy", message: "Two evidence bundles are being prepared; inspect those receipts before starting more") }
      let entries = (try? FileManager.default.contentsOfDirectory(at: evidenceDirectory, includingPropertiesForKeys: nil)) ?? []
      guard entries.count < 1000 else { throw StackControlError(code: "storage_limit", message: "Review retained evidence preparations before preparing more") }
      let retainedBytes = Self.evidenceRetainedBytes(in: evidenceDirectory)
      guard retainedBytes <= 2_147_483_648 else { throw StackControlError(code: "storage_limit", message: "Retained evidence exceeds 2 GiB; review existing preparations before creating more") }
      if let video = session.videoURL, let info = try? video.resourceValues(forKeys: [.fileSizeKey]), (info.fileSize ?? 0) > 536_870_912 {
        throw StackControlError(code: "asset_too_large", message: "The source video exceeds the 512 MiB evidence preparation limit and remains available in its original library")
      }
      let receipt = IntegrationEvidencePreparation(operationKey: key, actorKey: actor.key, installationID: installation, workspaceID: workspace,
        generation: generation, recordingID: session.id, preparationID: UUID())
      try saveEvidence(receipt, actor: actor)
      Self.preparingEvidence.insert(receipt.preparationID)
      Task { [weak self] in
        guard let self else { return }
        defer { Self.preparingEvidence.remove(receipt.preparationID) }
        var result = receipt
        do {
          let destination = self.evidenceReceiptURL(receipt.preparationID).deletingLastPathComponent().appendingPathComponent("Files", isDirectory: true)
          let folder = try await ReproExport.export(session, to: destination, includeVideo: true)
          let existingManifest = ReproRecorder.shared.store.folder(session.id).appendingPathComponent("deckhand-evidence-v1.json")
          let evidenceManifest = folder.appendingPathComponent("deckhand-evidence-v1.json")
          if FileManager.default.fileExists(atPath: existingManifest.path) {
            try FileManager.default.copyItem(at: existingManifest, to: evidenceManifest)
          } else {
            // These are capture-time snapshots. Missing historical provenance stays missing.
            let repositories: [JSONValue] = session.workspaces.flatMap { workspace in workspace.repos.map { repo in
              var item: [String: JSONValue] = ["workspaceID": .string(workspace.id), "repositoryID": .string(repo.id), "head": repo.head.map(JSONValue.string) ?? .null,
                "changedFiles": .number(Double(repo.changedFiles.count))]
              if let keys = repo.canonicalRepositoryKeys { item["canonicalRepositoryKeys"] = .array(keys.map(JSONValue.string)) }
              if let id = repo.repositoryPhysicalId { item["repositoryPhysicalId"] = .string(id) }
              if let hash = repo.diffHash { item["diffHash"] = .string(hash) }
              if let fingerprint = repo.sourceFingerprint { item["sourceFingerprint"] = fingerprint.value }
              if let fingerprint = repo.endSourceFingerprint { item["endSourceFingerprint"] = fingerprint.value }
              if let head = repo.endHead { item["endHead"] = .string(head) }
              if let complete = repo.snapshotComplete { item["snapshotComplete"] = .bool(complete) }
              if let truncated = repo.diffTruncated { item["diffTruncated"] = .bool(truncated) }
              if let date = repo.capturedAt { item["capturedAt"] = .string(ISO8601DateFormatter().string(from: date)) }
              return .object(item)
            } }
            let manifest: JSONValue = .object(["schemaVersion": .number(1), "recordingID": .string(session.id.uuidString), "buildProof": session.buildProof?.value ?? .null,
              "installationID": .string(installation), "primaryWorkspaceID": .string(workspace), "generation": .number(Double(generation)),
              "capturedWorkspaceIDs": .array(session.workspaceIDs.map(JSONValue.string)), "repositories": .array(repositories),
              "clockQuality": .string("unknown"), "servedBuildIdentity": .null,
              "capturedAt": .string(ISO8601DateFormatter().string(from: session.createdAt)), "droppedLines": .number(Double(session.droppedLines ?? 0))])
            try JSONEncoder().encode(manifest).write(to: evidenceManifest, options: .atomic)
          }
          result.folder = folder.standardizedFileURL.resolvingSymlinksInPath().path
          result.assets = try await Task.detached(priority: .utility) { try Self.evidenceAssets(in: folder) }.value
          if !result.assets.contains(where: { $0.kind == "video" }) { result.assets.append(Self.missingEvidence(kind: "video", name: "recording", detail: "The source recording has no available video.")) }
          if !result.assets.contains(where: { $0.kind == "frame" }) { result.assets.append(Self.missingEvidence(kind: "frame", name: "frames", detail: "No frames could be extracted from the source video.")) }
          if session.workspaces.contains(where: { $0.repos.contains(where: { !$0.changedFiles.isEmpty }) }), !result.assets.contains(where: { $0.kind == "diff" }) {
            result.assets.append(Self.missingEvidence(kind: "diff", name: "captured-diff", detail: "Changed files were recorded but no captured diff file is available."))
          }
          result.assets = Array(result.assets.prefix(200)); result.state = "ready"
          result.detail = result.assets.contains(where: { $0.state != "ready" }) ? "Prepared available evidence. Missing or failed assets are listed explicitly." : "Prepared video, frames, logs and captured repository evidence. Provider acceptance has not been confirmed."
        } catch {
          result.state = "failed"; result.detail = (error as? StackControlError).map { "Evidence preparation failed: " + $0.message } ?? "Evidence preparation failed. The source recording remains in the library."
        }
        try? self.saveEvidence(result, actor: actor)
      }
      return receipt.value
    }
    guard let raw = params["preparationID"]?.stringValue, let id = UUID(uuidString: raw),
      let data = try? Data(contentsOf: evidenceReceiptURL(id)), data.count <= 262_144,
      var receipt = try? JSONDecoder().decode(IntegrationEvidencePreparation.self, from: data),
      receipt.actorKey == actor.key, receipt.recordingID == session.id, receipt.installationID == installation,
      receipt.workspaceID == workspace, receipt.generation == generation else { throw StackControlError.notFound("This evidence preparation is unavailable in the selected context") }
    if method == "integration.recording.evidence.get" {
      if receipt.state == "preparing", !Self.preparingEvidence.contains(id) {
        receipt.state = "interrupted"; receipt.detail = "Preparation was interrupted. Its source and any written assets are retained."
        try saveEvidence(receipt, actor: actor)
      }
      return receipt.value
    }
    guard method == "integration.recording.evidence.chunk", receipt.state == "ready",
      let resourceID = params["resourceID"]?.stringValue, let asset = receipt.assets.first(where: { $0.id == resourceID && $0.state == "ready" }),
      let relative = asset.relativePath, let root = receipt.folder,
      let offset = params["offset"]?.intValue, offset >= 0, let length = params["length"]?.intValue, length >= 0, length <= 262_144 else { throw StackControlError.invalid("Choose a ready evidence asset and request at most 256 KiB") }
    let folder = URL(fileURLWithPath: root, isDirectory: true).resolvingSymlinksInPath()
    guard let resource = IntegrationEvidenceResourcePath.resource(for: relative, in: folder),
      folder.path.hasPrefix(evidenceDirectory.resolvingSymlinksInPath().path + "/") else { throw StackControlError.invalid("Evidence asset escaped its owned preparation") }
    return try await Task.detached(priority: .utility) {
      let chunk = try Self.recordingChunk(resource, offset: offset, length: length, mimeType: asset.mimeType)
      guard let version = asset.version, chunk["version"]?.stringValue == version, chunk["size"]?.intValue == asset.size else { throw StackControlError(code: "asset_changed", message: "The prepared evidence bytes changed; prepare a new immutable bundle") }
      return chunk
    }.value
  }
  nonisolated private static func evidenceRetainedBytes(in directory: URL) -> Int64 {
    var total: Int64 = 0
    if let enumerator = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey], options: [.skipsHiddenFiles]) {
      for case let file as URL in enumerator {
        let info = try? file.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        if info?.isRegularFile == true { total += Int64(info?.fileSize ?? 0) }
        if total > 2_147_483_648 { break }
      }
    }
    return total
  }
  nonisolated private static func missingEvidence(kind: String, name: String, detail: String) -> IntegrationEvidenceAsset {
    IntegrationEvidenceAsset(id: UUID().uuidString, name: name, kind: kind, mimeType: "application/octet-stream", size: 0, sha256: nil, state: "missing", detail: detail, relativePath: nil)
  }
  nonisolated static func evidenceAssets(in folder: URL) throws -> [IntegrationEvidenceAsset] {
    let manager = FileManager.default
    let root = folder.standardizedFileURL.resolvingSymlinksInPath()
    guard let enumerator = manager.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey], options: [.skipsHiddenFiles]) else { return [] }
    var result: [IntegrationEvidenceAsset] = []
    var files: [URL] = []
    for case let url as URL in enumerator {
      if files.count >= 10_000 { throw StackControlError(code: "resource_limit", message: "The exported bundle has more than 10,000 entries; source evidence is retained") }
      files.append(url)
    }
    files.sort { lhs, rhs in
      func priority(_ url: URL) -> Int {
        let relative = IntegrationEvidenceResourcePath.relativePath(of: url, in: root) ?? ""
        if ["mp4", "mov"].contains(url.pathExtension.lowercased()) { return 0 }
        if relative == "recording.log" { return 1 }
        if relative == "deckhand-evidence-v1.json" { return 2 }
        if relative == "README.md" { return 3 }
        if relative.hasPrefix("frames/") { return 4 }
        if relative.hasPrefix("git/") { return 5 }
        return 6
      }
      let left = priority(lhs), right = priority(rhs)
      return left == right ? lhs.lastPathComponent < rhs.lastPathComponent : left < right
    }
    var omitted = false
    for url in files {
      let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
      guard values.isRegularFile == true, values.isSymbolicLink != true else { continue }
      guard let relative = IntegrationEvidenceResourcePath.relativePath(of: url, in: root) else { throw StackControlError.invalid("Exported evidence escaped its owned preparation") }
      let ext = url.pathExtension.lowercased()
      let kind = ["mp4", "mov"].contains(ext) ? "video" : relative.hasPrefix("frames/") ? "frame" : relative.hasPrefix("git/") ? "diff" : ext == "log" ? "logs" : ext == "json" ? "manifest" : "report"
      let mime = ext == "mp4" ? "video/mp4" : ext == "mov" ? "video/quicktime" : ["jpg", "jpeg"].contains(ext) ? "image/jpeg" : ext == "png" ? "image/png" : ext == "json" ? "application/json" : ext == "md" ? "text/markdown" : "text/plain"
      let size = values.fileSize ?? 0
      guard result.count < 196 else { omitted = true; break }
      if size > 536_870_912 {
        result.append(IntegrationEvidenceAsset(id: UUID().uuidString, name: relative, kind: kind, mimeType: mime, size: size, sha256: nil, state: "failed", detail: "Asset exceeds the 512 MiB delivery limit; its source is retained.", relativePath: nil)); continue
      }
      let before = try recordingChunk(url, offset: 0, length: 0, mimeType: mime)
      let handle = try FileHandle(forReadingFrom: url)
      var hash = SHA256()
      while let bytes = try handle.read(upToCount: 262_144), !bytes.isEmpty { hash.update(data: bytes) }
      try handle.close()
      let digest = hash.finalize().map { String(format: "%02x", $0) }.joined()
      let after = try recordingChunk(url, offset: 0, length: 0, mimeType: mime)
      guard before["version"]?.stringValue == after["version"]?.stringValue, after["size"]?.intValue == size else { throw StackControlError(code: "asset_changed", message: "Evidence changed during preparation") }
      var asset = IntegrationEvidenceAsset(id: UUID().uuidString, name: relative, kind: kind, mimeType: mime, size: size, sha256: digest, state: "ready", detail: nil, relativePath: relative)
      asset.version = after["version"]?.stringValue
      result.append(asset)
    }
    if omitted { result.append(IntegrationEvidenceAsset(id: UUID().uuidString, name: "additional-resources", kind: "manifest", mimeType: "application/json", size: 0, sha256: nil, state: "failed", detail: "Additional files are retained in the native bundle but omitted from its bounded resource list.", relativePath: nil)) }
    // A bounded draft should retain one useful representative of every asset type.
    var remaining = result.sorted { lhs, rhs in
      if lhs.name == "recording.log", rhs.name != "recording.log" { return true }
      if rhs.name == "recording.log", lhs.name != "recording.log" { return false }
      return lhs.name < rhs.name
    }
    var ordered: [IntegrationEvidenceAsset] = []
    for kind in ["video", "frame", "logs", "diff", "manifest", "report"] {
      if let index = remaining.firstIndex(where: { $0.kind == kind && $0.state == "ready" }) { ordered.append(remaining.remove(at: index)) }
    }
    return ordered + remaining
  }
}
