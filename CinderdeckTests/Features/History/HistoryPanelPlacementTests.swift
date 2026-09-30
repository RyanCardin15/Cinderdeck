import CoreGraphics
import XCTest
@testable import Cinderdeck

final class HistoryPanelPlacementTests: XCTestCase {
  private let display = CGRect(x: 0, y: 25, width: 1440, height: 875)

  func testSectionResizePreservesDraggedTopLeft() {
    let frame = CGRect(x: 130, y: 440, width: 920, height: 316)
    let resized = HistoryPanelPlacement.resizedFrame(from: frame, to: CGSize(width: 920, height: 400), visibleFrame: display)
    XCTAssertEqual(resized.minX, frame.minX)
    XCTAssertEqual(resized.maxY, frame.maxY)
  }

  func testExpansionClampsToKeepWindowOnDisplay() {
    let frame = CGRect(x: 490, y: 40, width: 920, height: 316)
    let resized = HistoryPanelPlacement.resizedFrame(from: frame, to: CGSize(width: 1040, height: 680), visibleFrame: display)
    XCTAssertTrue(display.contains(resized))
    XCTAssertEqual(resized.origin, CGPoint(x: 400, y: 25))
  }

  func testSecondaryDisplaySupportsNegativeCoordinates() {
    let display = CGRect(x: -1920, y: 100, width: 1920, height: 1080)
    let frame = CGRect(x: -1800, y: 510, width: 920, height: 400)
    let resized = HistoryPanelPlacement.resizedFrame(from: frame, to: CGSize(width: 1040, height: 680), visibleFrame: display)
    XCTAssertEqual(resized.minX, -1800)
    XCTAssertEqual(resized.maxY, frame.maxY)
    XCTAssertTrue(display.contains(resized))
  }

  func testDisconnectedDisplayKeepsTheHeaderReachable() {
    let frame = CGRect(x: -1800, y: 2000, width: 920, height: 400)
    let resized = HistoryPanelPlacement.resizedFrame(from: frame, to: frame.size, visibleFrame: display)
    XCTAssertTrue(display.contains(resized))
    XCTAssertEqual(resized.origin, CGPoint(x: display.minX, y: display.maxY - frame.height))
  }
}
