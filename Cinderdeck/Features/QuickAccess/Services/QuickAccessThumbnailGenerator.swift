//
//  ThumbnailGenerator.swift
//  Cinderdeck
//
//  Efficient thumbnail generation from image and video files
//

import AppKit
import AVFoundation
import Foundation
import ImageIO
import os.log

private let logger = Logger(subsystem: "Cinderdeck", category: "ThumbnailGenerator")

/// Result of thumbnail generation containing optional thumbnail and duration
struct ThumbnailResult {
  let thumbnail: NSImage?
  let duration: TimeInterval?
}

/// Utility for generating thumbnails from image and video files
enum ThumbnailGenerator {

  private static let videoExtensions: Set<String> = ["mov", "mp4", "m4v"]

  private static func isVideoFile(_ url: URL) -> Bool {
    videoExtensions.contains(url.pathExtension.lowercased())
  }

  /// Generate thumbnail from image or video URL
  /// - Parameters:
  ///   - url: Source file URL (image or video)
  ///   - maxSize: Maximum dimension for thumbnail
  /// - Returns: ThumbnailResult with thumbnail and optional duration (for videos)
  static func generate(from url: URL, maxSize: CGFloat = 200) async -> ThumbnailResult {
    let scopedAccess = await MainActor.run {
      SandboxFileAccessManager.shared.beginAccessingURL(url)
    }
    defer { scopedAccess.stop() }

    if isVideoFile(url) {
      return await generateFromVideo(url: url, maxSize: maxSize)
    } else {
      let thumbnail = await generateFromImage(url: url, maxSize: maxSize)
      return ThumbnailResult(thumbnail: thumbnail, duration: nil)
    }
  }

  /// Generate thumbnail from image file (backward compatible)
  static func generateImageThumbnail(from url: URL, maxSize: CGFloat = 200) async -> NSImage? {
    return await generateFromImage(url: url, maxSize: maxSize)
  }

  private static func normalizeRetinaLogicalSizeIfNeeded(_ image: NSImage) -> NSImage {
    guard let rep = image.representations.first, rep.pixelsWide > 0, rep.pixelsHigh > 0 else {
      return image
    }

    let currentSize = image.size
    let pixelWidth = CGFloat(rep.pixelsWide)
    let pixelHeight = CGFloat(rep.pixelsHigh)
    let scaleFactor = NSScreen.main?.backingScaleFactor ?? 1.0
    guard scaleFactor > 1 else { return image }

    let isUnscaledLogicalSize =
      abs(currentSize.width - pixelWidth) < 0.5 &&
      abs(currentSize.height - pixelHeight) < 0.5
    guard isUnscaledLogicalSize else { return image }

    image.size = NSSize(
      width: pixelWidth / scaleFactor,
      height: pixelHeight / scaleFactor
    )
    return image
  }

  /// Generate a simple placeholder thumbnail for failed loads
  static func placeholderThumbnail(size: CGFloat = 200) -> NSImage {
    let thumbSize = NSSize(width: size, height: size)
    let image = NSImage(size: thumbSize)
    image.lockFocus()
    NSColor.systemGray.withAlphaComponent(0.3).setFill()
    NSBezierPath(roundedRect: NSRect(origin: .zero, size: thumbSize), xRadius: 8, yRadius: 8).fill()
    let iconRect = NSRect(x: size * 0.3, y: size * 0.3, width: size * 0.4, height: size * 0.4)
    NSColor.systemGray.withAlphaComponent(0.5).setFill()
    NSBezierPath(ovalIn: iconRect).fill()
    image.unlockFocus()
    return image
  }

  // MARK: - Private Methods

  private static func generateFromImage(url: URL, maxSize: CGFloat) async -> NSImage? {
    // Retry with backoff: 0ms, 100ms, 300ms
    let delays: [UInt64] = [0, 100, 300]
    let screenScale = NSScreen.main?.backingScaleFactor ?? 1.0

    for (attempt, delayMs) in delays.enumerated() {
      if delayMs > 0 {
        try? await Task.sleep(nanoseconds: delayMs * 1_000_000)
      }

      guard FileManager.default.fileExists(atPath: url.path) else {
        logger.warning("File not found on attempt \(attempt + 1): \(url.lastPathComponent)")
        continue
      }

      // Decoding a full-resolution screenshot and redrawing it took tens of
      // milliseconds on the main thread after every capture. ImageIO reads only
      // the pixels the thumbnail needs, off the main actor.
      if let thumbnail = await Task.detached(priority: .userInitiated, operation: {
        downsampledImage(at: url, maxSize: maxSize, screenScale: screenScale)
      }).value {
        return NSImage(cgImage: thumbnail.image, size: thumbnail.size)
      }

      // Formats ImageIO cannot read, such as PDF.
      if let image = NSImage(contentsOf: url) {
        let normalizedImage = normalizeRetinaLogicalSizeIfNeeded(image)
        let originalSize = normalizedImage.size
        guard originalSize.width > 0, originalSize.height > 0 else { return nil }

        let scale: CGFloat
        if originalSize.width > originalSize.height {
          scale = min(maxSize / originalSize.width, 1.0)
        } else {
          scale = min(maxSize / originalSize.height, 1.0)
        }

        if scale >= 1.0 { return normalizedImage }

        let newSize = CGSize(
          width: originalSize.width * scale,
          height: originalSize.height * scale
        )

        let thumbnail = NSImage(size: newSize)
        thumbnail.lockFocus()
        NSGraphicsContext.current?.imageInterpolation = .high
        normalizedImage.draw(
          in: NSRect(origin: .zero, size: newSize),
          from: NSRect(origin: .zero, size: originalSize),
          operation: .copy,
          fraction: 1.0
        )
        thumbnail.unlockFocus()
        return thumbnail
      }

      logger.warning("NSImage load failed on attempt \(attempt + 1): \(url.lastPathComponent)")
    }

    logger.error("Thumbnail generation failed after \(delays.count) attempts: \(url.lastPathComponent)")
    return nil
  }

  private struct Downsampled: @unchecked Sendable {
    let image: CGImage
    let size: CGSize
  }

  /// The thumbnail and the point size NSImage would give it, including the
  /// Retina adjustment `normalizeRetinaLogicalSizeIfNeeded` makes.
  private nonisolated static func downsampledImage(at url: URL, maxSize: CGFloat, screenScale: CGFloat) -> Downsampled? {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
      CGImageSourceGetCount(source) > 0,
      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
      var pixelWidth = (properties[kCGImagePropertyPixelWidth] as? NSNumber).map({ CGFloat($0.doubleValue) }),
      var pixelHeight = (properties[kCGImagePropertyPixelHeight] as? NSNumber).map({ CGFloat($0.doubleValue) }),
      pixelWidth > 0, pixelHeight > 0 else { return nil }
    var dpiWidth = (properties[kCGImagePropertyDPIWidth] as? NSNumber).map { CGFloat($0.doubleValue) } ?? 72
    var dpiHeight = (properties[kCGImagePropertyDPIHeight] as? NSNumber).map { CGFloat($0.doubleValue) } ?? 72
    if dpiWidth <= 0 { dpiWidth = 72 }
    if dpiHeight <= 0 { dpiHeight = 72 }
    if let orientation = (properties[kCGImagePropertyOrientation] as? NSNumber)?.intValue, (5...8).contains(orientation) {
      swap(&pixelWidth, &pixelHeight); swap(&dpiWidth, &dpiHeight)
    }
    var size = CGSize(width: pixelWidth * 72 / dpiWidth, height: pixelHeight * 72 / dpiHeight)
    if screenScale > 1, abs(size.width - pixelWidth) < 0.5, abs(size.height - pixelHeight) < 0.5 {
      size = CGSize(width: pixelWidth / screenScale, height: pixelHeight / screenScale)
    }
    let scale = min(maxSize / max(size.width, size.height), 1.0)
    let target = CGSize(width: size.width * scale, height: size.height * scale)
    // As many pixels as the old redraw produced on this screen, never more than the source.
    let maxPixels = min(max(pixelWidth, pixelHeight), ceil(max(target.width, target.height) * max(screenScale, 1)))
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceShouldCacheImmediately: true,
      kCGImageSourceThumbnailMaxPixelSize: maxPixels,
    ]
    guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
    return Downsampled(image: image, size: target)
  }

  private static func generateFromVideo(url: URL, maxSize: CGFloat) async -> ThumbnailResult {
    let asset = AVURLAsset(url: url)

    // Get duration
    let duration: TimeInterval?
    do {
      let cmDuration = try await asset.load(.duration)
      duration = CMTimeGetSeconds(cmDuration)
    } catch {
      duration = nil
    }

    // Generate thumbnail from first frame
    let imageGenerator = AVAssetImageGenerator(asset: asset)
    imageGenerator.appliesPreferredTrackTransform = true
    imageGenerator.maximumSize = CGSize(width: maxSize * 2, height: maxSize * 2)

    let time = CMTimeMakeWithSeconds(0, preferredTimescale: 600)

    do {
      let (cgImage, _) = try await imageGenerator.image(at: time)
      let nsImage = NSImage(cgImage: cgImage, size: NSZeroSize)
      let scaledThumbnail = scaleImage(nsImage, maxSize: maxSize)
      return ThumbnailResult(thumbnail: scaledThumbnail, duration: duration)
    } catch {
      logger.error("Failed to generate video thumbnail: \(error.localizedDescription)")
      return ThumbnailResult(thumbnail: nil, duration: duration)
    }
  }

  private static func scaleImage(_ image: NSImage, maxSize: CGFloat) -> NSImage {
    let normalizedImage = normalizeRetinaLogicalSizeIfNeeded(image)
    let originalSize = normalizedImage.size
    guard originalSize.width > 0, originalSize.height > 0 else { return image }

    let scale: CGFloat
    if originalSize.width > originalSize.height {
      scale = min(maxSize / originalSize.width, 1.0)
    } else {
      scale = min(maxSize / originalSize.height, 1.0)
    }

    if scale >= 1.0 { return normalizedImage }

    let newSize = CGSize(
      width: originalSize.width * scale,
      height: originalSize.height * scale
    )

    let thumbnail = NSImage(size: newSize)
    thumbnail.lockFocus()
    NSGraphicsContext.current?.imageInterpolation = .high
    normalizedImage.draw(
      in: NSRect(origin: .zero, size: newSize),
      from: NSRect(origin: .zero, size: originalSize),
      operation: .copy,
      fraction: 1.0
    )
    thumbnail.unlockFocus()

    return thumbnail
  }
}
