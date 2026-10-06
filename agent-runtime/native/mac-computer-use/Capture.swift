import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit

enum Capture {
  /// Captures one window, even when it is behind other windows, at logical
  /// (point) resolution capped at 1456 px on the long side. Coordinates in the
  /// image map to window points by dividing by `scale`.
  static func window(_ windowID: CGWindowID) async throws -> [String: Any] {
    guard CGPreflightScreenCaptureAccess() else { throw Failed(.screen_permission) }
    let content = try await SCShareableContent.excludingDesktopWindows(
      false, onScreenWindowsOnly: false)
    guard let window = content.windows.first(where: { $0.windowID == windowID }) else {
      throw Failed(.window_missing)
    }
    let size = window.frame.size
    let scale = min(1.0, 1456.0 / max(1, max(size.width, size.height)))
    let configuration = SCStreamConfiguration()
    configuration.width = max(1, Int((size.width * scale).rounded()))
    configuration.height = max(1, Int((size.height * scale).rounded()))
    configuration.showsCursor = false
    configuration.capturesAudio = false
    configuration.ignoreShadowsSingleWindow = true
    configuration.scalesToFit = true
    let image = try await SCScreenshotManager.captureImage(
      contentFilter: SCContentFilter(desktopIndependentWindow: window),
      configuration: configuration)
    let bitmap = NSBitmapImageRep(cgImage: image)
    guard
      let data = [0.7, 0.5, 0.35].lazy.compactMap({
        bitmap.representation(using: .jpeg, properties: [.compressionFactor: $0])
      }).first(where: { $0.count <= 900_000 })
    else { throw Failed(.unavailable, "The screenshot was too large.") }
    return [
      "data": data.base64EncodedString(), "mimeType": "image/jpeg",
      "width": image.width, "height": image.height,
      "scale": Double(image.width) / Double(max(1, size.width)),
    ]
  }
}
