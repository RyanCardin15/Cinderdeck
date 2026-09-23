import AVFoundation
import XCTest
@testable import Cinderdeck

@MainActor
final class PromoVideoTests: XCTestCase {
  func testBundledPromoIsPlayableAndEveryChapterDecodes() async throws {
    let url = try XCTUnwrap(PromoVideoWindowController.videoURL, "The same promo used by the README must be bundled in the app")
    let asset = AVURLAsset(url: url)
    let playable = try await asset.load(.isPlayable)
    let duration = try await asset.load(.duration)
    XCTAssertTrue(playable)
    XCTAssertEqual(duration.seconds, 48, accuracy: 0.1)
    let video = try await asset.loadTracks(withMediaType: .video)
    let audio = try await asset.loadTracks(withMediaType: .audio)
    XCTAssertEqual(video.count, 1)
    XCTAssertEqual(audio.count, 1)
    let size = try await XCTUnwrap(video.first).load(.naturalSize)
    XCTAssertEqual(size, CGSize(width: 1920, height: 1080))
    let generator = AVAssetImageGenerator(asset: asset)
    for second in [0.0, 7.5, 15, 22, 28, 31, 35, 41, 47] {
      let frame = try await generator.image(at: CMTime(seconds: second, preferredTimescale: 600))
      XCTAssertEqual(frame.image.width, 1920)
      XCTAssertEqual(frame.image.height, 1080)
    }
  }
}
