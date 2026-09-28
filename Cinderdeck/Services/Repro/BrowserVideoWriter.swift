import AVFoundation
import CoreGraphics
import ImageIO

/// Serial, off-main-actor JPEG decoding and H.264 encoding. CDP supplies changed
/// frames; idle pages cost no decoding work and the final image holds until stop.
actor BrowserVideoWriter {
  private let url: URL
  private var writer: AVAssetWriter?
  private var input: AVAssetWriterInput?
  private var adaptor: AVAssetWriterInputPixelBufferAdaptor?
  private var lastBuffer: CVPixelBuffer?
  private var lastTime = -1.0
  private var width = 0
  private var height = 0
  private var finished = false
  private(set) var droppedFrames = 0

  init(url: URL) { self.url = url }

  @discardableResult
  func append(jpeg: Data, at seconds: Double) async throws -> Bool {
    guard !finished, seconds.isFinite, seconds >= 0 else { return false }
    // The capture worker coalesces and paces frames. Never drop the
    // final changed image just because it arrived shortly after the preceding one.
    if seconds <= lastTime { droppedFrames += 1; return false }
    try await waitUntilReady()
    guard !finished else { return false }
    guard let source = CGImageSourceCreateWithData(jpeg as CFData, nil),
      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
      let imageWidth = properties[kCGImagePropertyPixelWidth] as? Int,
      let imageHeight = properties[kCGImagePropertyPixelHeight] as? Int,
      (1...4096).contains(imageWidth), (1...4096).contains(imageHeight),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
      throw StackControlError(code: "browser_video_failed", message: "The browser returned an invalid or oversized video frame")
    }
    if writer == nil { try prepare(width: imageWidth, height: imageHeight) }
    guard let input, let adaptor, let pool = adaptor.pixelBufferPool else { throw failure() }
    try await waitUntilReady()
    guard !finished, input.isReadyForMoreMediaData else { return false }
    var buffer: CVPixelBuffer?
    guard CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &buffer) == kCVReturnSuccess, let buffer else { throw failure() }
    CVPixelBufferLockBaseAddress(buffer, [])
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    guard let context = CGContext(data: CVPixelBufferGetBaseAddress(buffer), width: width, height: height,
      bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(buffer), space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else { throw failure() }
    context.setFillColor(CGColor(gray: 0, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    let scale = min(Double(width) / Double(image.width), Double(height) / Double(image.height))
    let w = Double(image.width) * scale, h = Double(image.height) * scale
    context.draw(image, in: CGRect(x: (Double(width) - w) / 2, y: (Double(height) - h) / 2, width: w, height: h))
    guard adaptor.append(buffer, withPresentationTime: CMTime(seconds: seconds, preferredTimescale: 60_000)) else { throw failure() }
    lastTime = seconds; lastBuffer = buffer
    return true
  }

  func appendFinal(jpeg: Data, at seconds: Double) async throws {
    _ = try await append(jpeg: jpeg, at: max(seconds, lastTime + 0.001))
  }

  private func waitUntilReady() async throws {
    let deadline = ContinuousClock.now.advanced(by: .seconds(2))
    while !finished, let input, !input.isReadyForMoreMediaData {
      guard writer?.status == .writing, ContinuousClock.now < deadline else { throw failure() }
      try await Task.sleep(for: .milliseconds(5))
    }
  }

  private func prepare(width: Int, height: Int) throws {
    let scale = min(1, 1920.0 / Double(width), 1080.0 / Double(height))
    self.width = max(2, Int(Double(width) * scale) / 2 * 2)
    self.height = max(2, Int(Double(height) * scale) / 2 * 2)
    let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
      AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: self.width, AVVideoHeightKey: self.height,
      AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: min(12_000_000, self.width * self.height * 4),
        AVVideoExpectedSourceFrameRateKey: 30, AVVideoMaxKeyFrameIntervalKey: 60,
        AVVideoAllowFrameReorderingKey: false],
    ])
    input.expectsMediaDataInRealTime = true
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
      kCVPixelBufferWidthKey as String: self.width, kCVPixelBufferHeightKey as String: self.height,
      kCVPixelBufferCGImageCompatibilityKey as String: true,
      kCVPixelBufferCGBitmapContextCompatibilityKey as String: true,
    ])
    guard writer.canAdd(input) else { throw failure() }
    writer.add(input)
    guard writer.startWriting() else { throw failure() }
    writer.startSession(atSourceTime: .zero)
    self.writer = writer; self.input = input; self.adaptor = adaptor
  }

  func finish(at seconds: Double) async throws -> URL {
    guard !finished, let writer, let input, let adaptor, let lastBuffer else { throw failure() }
    finished = true
    // Leave a short readable final frame (also inside ReproFrames' 50ms end trim).
    let end = max(seconds, lastTime + 0.1)
    // A bounded wait drains encoder backpressure without blocking the UI or hanging stop.
    let deadline = ContinuousClock.now.advanced(by: .seconds(5))
    while !input.isReadyForMoreMediaData, writer.status == .writing, ContinuousClock.now < deadline {
      try await Task.sleep(for: .milliseconds(10))
    }
    guard input.isReadyForMoreMediaData,
      adaptor.append(lastBuffer, withPresentationTime: CMTime(seconds: end, preferredTimescale: 60_000)) else {
      writer.cancelWriting(); throw failure()
    }
    writer.endSession(atSourceTime: CMTime(seconds: end, preferredTimescale: 60_000))
    input.markAsFinished()
    await writer.finishWriting()
    guard writer.status == .completed else { throw failure() }
    try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    self.lastBuffer = nil
    return url
  }

  func cancel() {
    // A start request can finish unwinding after a concurrent user stop saved it.
    // Never let that cleanup delete an already finalized recording.
    guard !finished else { return }
    finished = true
    writer?.cancelWriting()
    lastBuffer = nil
    try? FileManager.default.removeItem(at: url)
  }

  private func failure() -> StackControlError {
    StackControlError(code: "browser_video_failed", message: writer?.error?.localizedDescription ?? "Could not encode the browser recording")
  }
}
