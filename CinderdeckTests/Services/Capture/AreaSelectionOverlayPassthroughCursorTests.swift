//
//  AreaSelectionOverlayPassthroughCursorTests.swift
//  CinderdeckTests
//
//  Regression tests for the live-passthrough cursor guard: while a passthrough
//  session owns the overlay, no code path may set the real system cursor (the
//  crosshair is drawn by the proxy layer instead). A cursor set that slips through
//  sticks from this background agent and leaks past teardown — observed as the
//  crosshair reappearing over the Quick Access card after capture ended.
//

import AppKit
@testable import Cinderdeck
import XCTest

final class AreaSelectionOverlayPassthroughCursorTests: AreaSelectionOverlayTestCase {
  private var recordedCursors: [NSCursor] = []

  override func setUp() {
    super.setUp()
    recordedCursors = []
    overlayView.cursorSetEffect = { [weak self] cursor in
      self?.recordedCursors.append(cursor)
    }
  }

  /// Drive the same cursor-touching call surface the controller uses when
  /// configuring a pooled window for a session (`configureSessionWindow`) and when
  /// resetting it at teardown (`resetPooledWindows`).
  private func driveControllerConfigurationSurface() {
    overlayView.setInteractionMode(.manualRegion, resetSelection: false)
    overlayView.setSelectionEnabled(true)
    overlayView.resetSelection()
    overlayView.refreshCursor()
    overlayView.reassertCursorDuringDrag()
  }

  /// With passthrough enabled FIRST (the session-start order), the whole
  /// configuration surface must stay silent on the real cursor.
  func testSessionStartOrder_passthroughFlagFirst_neverSetsRealCursor() {
    overlayView.setLivePassthroughInputEnabled(true)

    driveControllerConfigurationSurface()

    XCTAssertTrue(
      recordedCursors.isEmpty,
      "passthrough sessions must not set the real cursor (got \(recordedCursors.count) sets)"
    )
  }

  /// Teardown resets the overlay BEFORE clearing the passthrough flag — the exact
  /// `resetPooledWindows()` order. Across the full session lifecycle (start
  /// configuration through teardown reset) the real cursor must stay untouched;
  /// the flag is cleared last and nothing cursor-touching runs after it.
  func testTeardownOrder_resetBeforeFlagClear_neverSetsRealCursor() {
    overlayView.setLivePassthroughInputEnabled(true)

    // Session-start configuration surface (as above)…
    driveControllerConfigurationSurface()
    // …then the controller teardown order: resetSelection()/clearBackdrop() first,
    // flag cleared last.
    overlayView.resetSelection()
    overlayView.clearBackdrop()
    overlayView.setLivePassthroughInputEnabled(false)

    XCTAssertTrue(
      recordedCursors.isEmpty,
      "no real-cursor set may slip through anywhere across a passthrough session lifecycle"
    )
  }

  /// Contrast/sanity: the legacy window-event path (flag never set) DOES set the
  /// mode cursor through the same funnel — proving the guard above is what keeps
  /// passthrough sessions silent, not a broken recording seam.
  func testLegacyWindowEventPath_setsModeCursor() {
    driveControllerConfigurationSurface()

    XCTAssertFalse(
      recordedCursors.isEmpty,
      "legacy path must keep setting the cursor through applyActiveCursor"
    )
  }
}
