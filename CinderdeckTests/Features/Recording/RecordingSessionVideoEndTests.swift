import AVFoundation
import CoreMedia
import ScreenCaptureKit
import XCTest
@testable import Cinderdeck

/// Writes real videos through RecordingSession with frames shaped like ScreenCaptureKit's,
/// which only arrive when the screen changes.
final class RecordingSessionVideoEndTests: XCTestCase {
  private var folder: URL!

  override func setUpWithError() throws {
    folder = FileManager.default.temporaryDirectory.appendingPathComponent("RecordingSessionVideoEnd-\(UUID())", isDirectory: true)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: folder)
  }

  private func makeSession(_ url: URL) throws -> RecordingSession {
    let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
      AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 64, AVVideoHeightKey: 64,
    ])
    input.expectsMediaDataInRealTime = true
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
      kCVPixelBufferWidthKey as String: 64, kCVPixelBufferHeightKey as String: 64,
    ])
    writer.add(input)
    let session = RecordingSession()
    session.assetWriter = writer
    session.videoInput = input
    session.pixelBufferAdaptor = adaptor
    XCTAssertTrue(writer.startWriting())
    session.isCapturing = true
    return session
  }

  /// A complete frame, as ScreenCaptureKit delivers it, at `time` on the host clock.
  private func frame(at time: CMTime) throws -> CMSampleBuffer {
    var pixels: CVPixelBuffer?
    CVPixelBufferCreate(nil, 64, 64, kCVPixelFormatType_32BGRA, nil, &pixels)
    let buffer = try XCTUnwrap(pixels)
    var format: CMVideoFormatDescription?
    CMVideoFormatDescriptionCreateForImageBuffer(allocator: nil, imageBuffer: buffer, formatDescriptionOut: &format)
    var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: time, decodeTimeStamp: .invalid)
    var sample: CMSampleBuffer?
    CMSampleBufferCreateReadyWithImageBuffer(allocator: nil, imageBuffer: buffer, formatDescription: try XCTUnwrap(format),
      sampleTiming: &timing, sampleBufferOut: &sample)
    let result = try XCTUnwrap(sample)
    let attachments = try XCTUnwrap(CMSampleBufferGetSampleAttachmentsArray(result, createIfNecessary: true))
    let dictionary = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFMutableDictionary.self)
    CFDictionarySetValue(dictionary, Unmanaged.passUnretained(SCStreamFrameInfo.status.rawValue as CFString).toOpaque(),
      Unmanaged.passUnretained(NSNumber(value: SCFrameStatus.complete.rawValue)).toOpaque())
    return result
  }

  private func duration(_ url: URL) async throws -> Double {
    try await AVURLAsset(url: url).load(.duration).seconds
  }

  func testStillScreenAtTheEndKeepsTheVideoAsLongAsTheRecording() async throws {
    let url = folder.appendingPathComponent("still.mp4")
    let session = try makeSession(url)
    let start = CMClockGetTime(CMClockGetHostTimeClock())
    session.appendVideoSample(try frame(at: start))
    session.appendVideoSample(try frame(at: start + CMTime(seconds: 0.1, preferredTimescale: 600)))
    // Nothing changes on screen for the next 1.9 s, so no more frames arrive.
    session.finishInputs()
    await session.finishWriting(endingAt: start + CMTime(seconds: 2, preferredTimescale: 600), maximumDuration: 2)
    let length = try await duration(url)
    XCTAssertEqual(length, 2, accuracy: 0.05)

    let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
    generator.requestedTimeToleranceBefore = .zero
    generator.requestedTimeToleranceAfter = .zero
    let (_, actual) = try await generator.image(at: CMTime(seconds: 1.8, preferredTimescale: 600))
    XCTAssertEqual(actual.seconds, 0.1, accuracy: 0.05, "The last frame is held until the end")
  }

  func testWithoutAnEndTheVideoStopsAtTheLastChange() async throws {
    let url = folder.appendingPathComponent("unended.mp4")
    let session = try makeSession(url)
    let start = CMClockGetTime(CMClockGetHostTimeClock())
    session.appendVideoSample(try frame(at: start))
    session.appendVideoSample(try frame(at: start + CMTime(seconds: 0.1, preferredTimescale: 600)))
    session.finishInputs()
    await session.finishWriting()
    let length = try await duration(url)
    XCTAssertLessThan(length, 0.5, "Why the end must be passed: the still tail is otherwise lost")
  }

  func testEndIsNotExtendedBeyondTheRecordedLengthOrBeforeTheLastFrame() async throws {
    let url = folder.appendingPathComponent("bounded.mp4")
    let session = try makeSession(url)
    let start = CMClockGetTime(CMClockGetHostTimeClock())
    session.appendVideoSample(try frame(at: start))
    session.appendVideoSample(try frame(at: start + CMTime(seconds: 0.5, preferredTimescale: 600)))
    session.finishInputs()
    // A stop time from a mismatched clock, an hour away, is ignored.
    await session.finishWriting(endingAt: start + CMTime(seconds: 3600, preferredTimescale: 600), maximumDuration: 2)
    let length = try await duration(url)
    XCTAssertLessThan(length, 1.5)
  }

  func testPausedTimeIsLeftOutOfTheEnd() async throws {
    let url = folder.appendingPathComponent("paused.mp4")
    let session = try makeSession(url)
    let start = CMClockGetTime(CMClockGetHostTimeClock())
    session.appendVideoSample(try frame(at: start))
    // Paused for 5 s after 0.5 s, then resumed; the next frame is written 5 s earlier.
    session.setAccumulatedPauseOffset(CMTime(seconds: 5, preferredTimescale: 600))
    session.appendVideoSample(try frame(at: start + CMTime(seconds: 5.6, preferredTimescale: 600)))
    session.finishInputs()
    await session.finishWriting(endingAt: start + CMTime(seconds: 6.5, preferredTimescale: 600), maximumDuration: 1.5)
    let length = try await duration(url)
    XCTAssertEqual(length, 1.5, accuracy: 0.05)
  }
}
