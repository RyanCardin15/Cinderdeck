//
//  AXElementInspectorTests.swift
//  CinderdeckTests
//
//  Unit tests for the AXElementInspector filter + Y-flip helpers used by
//  SmartElementQueryService.
//

import AppKit
import XCTest
@testable import Cinderdeck

final class AXElementInspectorTests: XCTestCase {

  // MARK: - Y-flip

  func testScreenRect_flipsAxTopLeftToAppKitBottomLeft_onPrimaryDisplay() throws {
    // Resolve the same screen the inspector uses for its baseline so this test
    // is robust against unusual NSScreen.screens orderings on CI.
    guard let primary = NSScreen.screens.first(where: { $0.displayID == CGMainDisplayID() }) else {
      throw XCTSkip("Headless CI lacks a main NSScreen.")
    }
    let primaryHeight = primary.frame.height
    let axRect = CGRect(x: 100, y: 50, width: 200, height: 80)

    let flipped = try XCTUnwrap(AXElementInspector.screenRect(forTopLeftRect: axRect))

    XCTAssertEqual(flipped.origin.x, 100)
    XCTAssertEqual(flipped.size.width, 200)
    XCTAssertEqual(flipped.size.height, 80)
    XCTAssertEqual(flipped.origin.y, primaryHeight - axRect.maxY)
  }

  func testScreenRect_returnsNil_whenRectIsFarOffAllScreens() {
    let axRect = CGRect(x: -10_000, y: -10_000, width: 50, height: 50)
    XCTAssertNil(AXElementInspector.screenRect(forTopLeftRect: axRect))
  }

  // MARK: - Parent walk filter

  func testFindMeaningful_acceptsAXButtonOfReasonableSize() {
    let button = AXElementSnapshot(
      role: "AXButton",
      position: CGPoint(x: 100, y: 100),
      size: CGSize(width: 80, height: 32),
      containingWindowSize: CGSize(width: 800, height: 600)
    )
    let found = AXElementInspector.findMeaningful(button)
    XCTAssertEqual(found?.role, "AXButton")
    XCTAssertEqual(found?.size, CGSize(width: 80, height: 32))
  }

  func testFindMeaningful_rejectsAXApplication() {
    let app = AXElementSnapshot(
      role: "AXApplication",
      position: .zero,
      size: CGSize(width: 1920, height: 1080)
    )
    XCTAssertNil(AXElementInspector.findMeaningful(app))
  }

  func testFindMeaningful_walksFromTinyChildToAcceptableParent() {
    let parentButton = AXElementSnapshot(
      role: "AXButton",
      position: CGPoint(x: 100, y: 100),
      size: CGSize(width: 80, height: 32),
      containingWindowSize: CGSize(width: 800, height: 600)
    )
    let tinyChild = AXElementSnapshot(
      role: "AXStaticText",
      position: CGPoint(x: 110, y: 105),
      size: CGSize(width: 4, height: 4),   // below 12pt threshold
      containingWindowSize: CGSize(width: 800, height: 600),
      parent: { parentButton }
    )

    let found = AXElementInspector.findMeaningful(tinyChild)
    XCTAssertEqual(found?.role, "AXButton")
  }

  func testFindMeaningful_rejectsElementCoveringNearlyEntireWindow() {
    let oversized = AXElementSnapshot(
      role: "AXGroup",
      position: .zero,
      size: CGSize(width: 800, height: 595),
      containingWindowSize: CGSize(width: 800, height: 600)
    )
    XCTAssertNil(AXElementInspector.findMeaningful(oversized))
  }

  func testFindMeaningful_stopsAtMaxDepth() {
    func chain(depth: Int) -> AXElementSnapshot {
      AXElementSnapshot(
        role: "AXUnknown",
        position: .zero,
        size: CGSize(width: 1, height: 1),
        parent: depth > 0 ? { chain(depth: depth - 1) } : { nil }
      )
    }
    let root = chain(depth: AXElementInspector.maxParentDepth + 4)
    XCTAssertNil(AXElementInspector.findMeaningful(root))
  }
}
