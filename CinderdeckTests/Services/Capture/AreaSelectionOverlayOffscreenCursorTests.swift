//
//  AreaSelectionOverlayOffscreenCursorTests.swift
//  CinderdeckTests
//
//  Regression tests for the off-screen cursor guard: once the session ends and
//  the overlay window is ordered out, the `.activeAlways` + `.mouseMoved`
//  tracking area keeps delivering `mouseMoved`/`cursorUpdate` to the view.
//  The passthrough flag is already cleared by `resetPooledWindows()` at that
//  point, so without the `window?.isVisible` guard in `applyActiveCursor()`
//  every stray event re-applies the crosshair to the real cursor — observed
//  leaking onto the Quick Access card after a successful capture.
//

import AppKit
@testable import Cinderdeck
import XCTest

final class AreaSelectionOverlayOffscreenCursorTests: AreaSelectionOverlayTestCase {
  private var recordedCursors: [NSCursor] = []
  private var hostWindow: NSWindow!

  override func setUp() {
    super.setUp()
    recordedCursors = []
    overlayView.cursorSetEffect = { [weak self] cursor in
      self?.recordedCursors.append(cursor)
    }
    // Attach the overlay to a real window that is never ordered front — exactly
    // the post-teardown state (`hidePooledWindows` orderOut → isVisible == false).
    hostWindow = NSWindow(
      contentRect: CGRect(x: 0, y: 0, width: 800, height: 600),
      styleMask: [.borderless],
      backing: .buffered,
      defer: false
    )
    hostWindow.contentView = overlayView
  }

  override func tearDown() {
    hostWindow.contentView = nil
    hostWindow.orderOut(nil)
    hostWindow = nil
    super.tearDown()
  }

  /// Drive the same cursor-touching surface a stray post-teardown event would.
  private func driveStrayEventSurface() {
    overlayView.refreshCursor()
    overlayView.reassertCursorDuringDrag()
    if let event = NSEvent.mouseEvent(
      with: .mouseMoved,
      location: CGPoint(x: 100, y: 100),
      modifierFlags: [],
      timestamp: 0,
      windowNumber: hostWindow.windowNumber,
      context: nil,
      eventNumber: 0,
      clickCount: 0,
      pressure: 0
    ) {
      overlayView.mouseMoved(with: event)
      overlayView.cursorUpdate(with: event)
    }
  }

  /// Legacy path on an ordered-out (session-ended) overlay: no real-cursor set.
  func testOffscreenOverlay_legacyPath_neverSetsRealCursor() {
    XCTAssertEqual(hostWindow.isVisible, false, "precondition: host window stays ordered out")

    driveStrayEventSurface()

    XCTAssertTrue(
      recordedCursors.isEmpty,
      "an off-screen overlay must not touch the real cursor (got \(recordedCursors.count) sets)"
    )
  }

  /// Passthrough teardown order (flag cleared by `resetPooledWindows`) on an
  /// ordered-out overlay: the stray events that follow must also stay silent.
  func testOffscreenOverlay_afterPassthroughFlagCleared_neverSetsRealCursor() {
    overlayView.setLivePassthroughInputEnabled(true)
    overlayView.resetSelection()
    overlayView.setLivePassthroughInputEnabled(false)

    driveStrayEventSurface()

    XCTAssertTrue(
      recordedCursors.isEmpty,
      "post-teardown stray events must not re-apply the crosshair (got \(recordedCursors.count) sets)"
    )
  }

  /// Contrast/sanity: a nil-window overlay (pure unit-test surface) still funnels
  /// cursor sets, proving the guard keys on window visibility, not a dead seam.
  func testNilWindowOverlay_stillSetsCursorThroughFunnel() {
    hostWindow.contentView = nil

    overlayView.refreshCursor()

    XCTAssertFalse(
      recordedCursors.isEmpty,
      "nil-window overlays must keep setting the cursor (unit-test surface unchanged)"
    )
  }
}
