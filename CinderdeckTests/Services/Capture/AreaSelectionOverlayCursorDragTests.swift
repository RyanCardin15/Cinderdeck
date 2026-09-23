//
//  AreaSelectionOverlayCursorDragTests.swift
//  CinderdeckTests
//
//  Unit tests for cursor re-assertion during drag and mouse-down event handling.
//

import XCTest
import AppKit
@testable import Cinderdeck

final class AreaSelectionOverlayCursorDragTests: AreaSelectionOverlayTestCase {

  func testReassertCursorDuringDrag_isNoOpWhenNotSelecting() {
    // GIVEN: manual-region mode, selection enabled, but no drag started
    overlayView.setSelectionEnabled(true)
    overlayView.resetSelection()
    XCTAssertFalse(overlayView.isManualSelectionInProgress, "No drag should be in progress after reset")

    // WHEN/THEN: re-asserting the cursor is a guarded no-op (must not crash or change drag state)
    overlayView.reassertCursorDuringDrag()
    XCTAssertFalse(overlayView.isManualSelectionInProgress, "Re-assert must not start a selection")
  }

  func testManualMouseDown_marksSelectionInProgress() {
    // GIVEN: manual-region mode (default) with selection enabled
    overlayView.setSelectionEnabled(true)
    overlayView.resetSelection()
    XCTAssertFalse(overlayView.isManualSelectionInProgress)

    // WHEN: a real left mouse-down lands inside the overlay
    guard let mouseDown = NSEvent.mouseEvent(
      with: .leftMouseDown,
      location: CGPoint(x: 120, y: 120),
      modifierFlags: [],
      timestamp: 0,
      windowNumber: 0,
      context: nil,
      eventNumber: 0,
      clickCount: 1,
      pressure: 1
    ) else {
      XCTFail("Failed to synthesize mouse-down event")
      return
    }
    overlayView.mouseDown(with: mouseDown)

    // THEN: a manual selection is in progress, so re-assertion during drag is active (not the no-op path)
    XCTAssertTrue(
      overlayView.isManualSelectionInProgress,
      "Manual selection must be in progress after a left mouse-down in manual-region mode"
    )
    overlayView.reassertCursorDuringDrag()  // must run without crashing while in progress
    XCTAssertTrue(overlayView.isManualSelectionInProgress)
  }
}
