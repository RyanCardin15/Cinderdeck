import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit

/// The system screenshot service can fail to complete its first request. Resolve
/// the race once, and discard late callbacks without holding the helper's lane.
private final class CaptureRace: @unchecked Sendable {
  private let lock = NSLock()
  private var continuation: CheckedContinuation<(CGImage, Bool), Error>?
  private var fallbackStarted = false
  init(_ continuation: CheckedContinuation<(CGImage, Bool), Error>) { self.continuation = continuation }
  func finish(_ result: Result<(CGImage, Bool), Error>) {
    lock.lock()
    let pending = continuation
    continuation = nil
    lock.unlock()
    pending?.resume(with: result)
  }
  func fallback(_ capture: () throws -> CGImage) {
    lock.lock()
    let shouldStart = continuation != nil && !fallbackStarted
    if shouldStart { fallbackStarted = true }
    lock.unlock()
    guard shouldStart else { return }
    finish(Result { (try capture(), true) })
  }
}

enum Capture {
  @MainActor private static var useWindowServer = false
  @MainActor private static var busy = false

  static func race(timeout: TimeInterval = 4,
    primary: @escaping @Sendable () async throws -> CGImage,
    fallback: @escaping @Sendable () throws -> CGImage) async throws -> (CGImage, Bool) {
    try await withCheckedThrowingContinuation { continuation in
      let race = CaptureRace(continuation)
      Task.detached {
        do { race.finish(.success((try await primary(), false))) }
        catch { race.fallback(fallback) }
      }
      DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + timeout) {
        race.fallback(fallback)
      }
      DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + timeout + 2) {
        race.finish(.failure(Failed(.timeout, "Screen capture stalled. Read fresh app state to restart capture.")))
      }
    }
  }

  private static func systemImage(_ windowID: CGWindowID, width: Int, height: Int) async throws -> CGImage {
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
    guard let window = content.windows.first(where: { $0.windowID == windowID }) else { throw Failed(.window_missing) }
    let configuration = SCStreamConfiguration()
    configuration.width = width
    configuration.height = height
    configuration.showsCursor = false
    configuration.capturesAudio = false
    configuration.ignoreShadowsSingleWindow = true
    configuration.scalesToFit = true
    return try await SCScreenshotManager.captureImage(
      contentFilter: SCContentFilter(desktopIndependentWindow: window), configuration: configuration)
  }

  /// Captures one on-screen window, including when occluded, capped at 1456 px.
  @MainActor static func window(_ windowID: CGWindowID) async throws -> [String: Any] {
    while busy { try await Task.sleep(nanoseconds: 10_000_000) }
    busy = true
    defer { busy = false }
    guard CGPreflightScreenCaptureAccess() else { throw Failed(.screen_permission) }
    guard let rows = CGWindowListCopyWindowInfo(.optionIncludingWindow, windowID) as? [[String: Any]],
      let row = rows.first(where: { ($0[kCGWindowNumber as String] as? UInt32) == windowID }),
      let ownerPID = row[kCGWindowOwnerPID as String] as? Int32,
      let bounds = row[kCGWindowBounds as String] as? [String: Any],
      let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary),
      frame.width > 0, frame.height > 0 else { throw Failed(.window_missing) }
    let scale = min(1.0, 1456.0 / max(frame.width, frame.height))
    let width = max(1, Int((frame.width * scale).rounded()))
    let height = max(1, Int((frame.height * scale).rounded()))
    let image: CGImage
    if useWindowServer {
      image = try await race(timeout: 0,
        primary: { throw Failed(.unavailable) },
        fallback: { try PrivateAPI.captureWindow(windowID, pid: ownerPID) }).0
    } else {
      do {
        let (captured, fallback) = try await race(
          primary: { try await systemImage(windowID, width: width, height: height) },
          fallback: { try PrivateAPI.captureWindow(windowID, pid: ownerPID) })
        image = captured
        useWindowServer = fallback
      } catch {
        // Do not accumulate further stalled requests when both paths failed.
        useWindowServer = true
        throw error
      }
      // At most one stalled system request survives per helper process. Restarting
      // the helper restores the preferred public API for a fresh attempt.
    }
    guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
      bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { throw Failed(.unavailable) }
    context.interpolationQuality = .high
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    guard let normalized = context.makeImage() else { throw Failed(.unavailable) }
    let bitmap = NSBitmapImageRep(cgImage: normalized)
    guard let data = [0.7, 0.5, 0.35].lazy.compactMap({
      bitmap.representation(using: .jpeg, properties: [.compressionFactor: $0])
    }).first(where: { $0.count <= 900_000 }) else {
      throw Failed(.unavailable, "The screenshot was too large.")
    }
    return ["data": data.base64EncodedString(), "mimeType": "image/jpeg", "width": width,
      "height": height, "scale": Double(width) / Double(frame.width)]
  }
}
