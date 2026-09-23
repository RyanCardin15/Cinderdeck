//
//  AreaSelectionOverlayTests.swift
//  CinderdeckTests
//
//  Remaining overlay tests: coordinates indicator visibility and
//  application-window interaction mode.
//

import XCTest
import AppKit
@testable import Cinderdeck

final class AreaSelectionOverlayTests: AreaSelectionOverlayTestCase {

  func testCoordinatesIndicator_visibleOnStartSelectionWithoutMouseMove() {
    // 1. GIVEN: overlayView with selection enabled, manual mode, and not selecting
    overlayView.setSelectionEnabled(true)
    overlayView.setInteractionMode(.manualRegion, resetSelection: false)

    // 2. WHEN: resetSelection is called
    overlayView.resetSelection()

    // 3. THEN: The coordinate label text layer and background layer should be visible
    XCTAssertFalse(overlayView.testSizeIndicatorTextLayer.isHidden)
    XCTAssertFalse(overlayView.testSizeIndicatorBackgroundLayer.isHidden)
  }

  /// Regression: AppKit runs a layout pass when the freshly ordered-in overlay window is
  /// displayed — after the session-start indicator was already shown. The layout pass must
  /// re-evaluate the indicator, not hide it, so it stays visible without a mouse move.
  func testCoordinatesIndicator_survivesLayoutPassWithoutMouseMove() {
    // GIVEN: indicator shown at session start (no mouse movement yet)
    overlayView.setSelectionEnabled(true)
    overlayView.setInteractionMode(.manualRegion, resetSelection: false)
    overlayView.resetSelection()
    XCTAssertFalse(overlayView.testSizeIndicatorTextLayer.isHidden)

    // WHEN: AppKit performs a layout pass on the overlay
    overlayView.layout()

    // THEN: the coordinate indicator stays visible
    XCTAssertFalse(overlayView.testSizeIndicatorTextLayer.isHidden)
    XCTAssertFalse(overlayView.testSizeIndicatorBackgroundLayer.isHidden)
  }

  /// Regression: right after a live (backdrop-less) session starts, the async background
  /// snapshot lands and the controller re-renders the (empty) manual selection via
  /// `renderManualSelection(screenRect: nil, currentScreenPoint: nil)`. That re-render must
  /// not hide the coordinate indicator that was shown at session start.
  func testCoordinatesIndicator_survivesEmptySelectionReRenderWithoutMouseMove() {
    // GIVEN: indicator shown at session start (no mouse movement yet)
    overlayView.setSelectionEnabled(true)
    overlayView.setInteractionMode(.manualRegion, resetSelection: false)
    overlayView.resetSelection()
    XCTAssertFalse(overlayView.testSizeIndicatorTextLayer.isHidden)

    // WHEN: the controller re-renders the empty selection (async backdrop applied)
    overlayView.renderManualSelection(screenRect: nil, currentScreenPoint: nil)

    // THEN: the coordinate indicator stays visible
    XCTAssertFalse(overlayView.testSizeIndicatorTextLayer.isHidden)
    XCTAssertFalse(overlayView.testSizeIndicatorBackgroundLayer.isHidden)
  }

  /// Regression: pressing the mouse button starts a selection with a zero-size rect, which
  /// routes through the empty-rect branch of `renderManualSelection`. The coordinate
  /// indicator must stay visible until the drag produces a non-empty rect — the user
  /// should never see the crosshair label vanish between mouseDown and the first movement.
  func testCoordinatesIndicator_survivesMouseDownBeforeFirstDrag() {
    // GIVEN: indicator shown at session start
    overlayView.setSelectionEnabled(true)
    overlayView.setInteractionMode(.manualRegion, resetSelection: false)
    overlayView.resetSelection()
    XCTAssertFalse(overlayView.testSizeIndicatorTextLayer.isHidden)

    // WHEN: the user presses the mouse button (selection begins, rect still zero-size)
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
    overlayView.renderManualSelection(screenRect: .zero, currentScreenPoint: nil)

    // THEN: the coordinate indicator stays visible
    XCTAssertFalse(overlayView.testSizeIndicatorTextLayer.isHidden, "Coordinate indicator must stay visible between mouseDown and first drag")
    XCTAssertFalse(overlayView.testSizeIndicatorBackgroundLayer.isHidden, "Background layer must stay visible between mouseDown and first drag")
  }

  /// Once the drag produces a non-empty selection rect, the dimensions label owns the size
  /// indicator layers — a passive refresh (e.g. layout pass) must not bring the coordinate
  /// label back over it.
  func testCoordinateIndicator_staysHiddenWhileSelectionRectVisible() {
    // GIVEN: an in-progress drag with a non-empty selection rect
    overlayView.setSelectionEnabled(true)
    overlayView.setInteractionMode(.manualRegion, resetSelection: false)
    overlayView.resetSelection()
    overlayView.renderManualSelection(
      screenRect: CGRect(x: 10, y: 10, width: 200, height: 100),
      currentScreenPoint: nil
    )

    // WHEN: a passive re-evaluation happens (layout pass on the overlay)
    overlayView.layout()

    // THEN: the coordinate indicator is not restored over the active selection
    XCTAssertTrue(overlayView.testSizeIndicatorTextLayer.isHidden, "Coordinate indicator must not reappear while a sized selection rect is visible")
  }

  func testApplicationWindowMode_hasNoManualDragInProgress() {
    // GIVEN: application-window interaction mode
    overlayView.setSelectionEnabled(true)
    overlayView.setInteractionMode(.applicationWindow)

    // WHEN: a left mouse-down lands inside the overlay
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

    // THEN: window mode is not a manual drag, so re-assertion stays a no-op
    XCTAssertFalse(
      overlayView.isManualSelectionInProgress,
      "Application-window mode must not report a drag in progress"
    )
    overlayView.reassertCursorDuringDrag()
    XCTAssertFalse(overlayView.isManualSelectionInProgress)
  }
}
