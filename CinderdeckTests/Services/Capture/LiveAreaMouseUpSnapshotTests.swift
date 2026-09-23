//
//  LiveAreaMouseUpSnapshotTests.swift
//  CinderdeckTests
//
//  Unit tests for the live area-capture mouse-up fast-grab gating and all-or-nothing
//  per-display gather (ScreenCaptureViewModel.gatherLiveMouseUpSnapshots). The snapshot
//  provider is injected, so these run without displays or Screen Recording permission.
//

import CoreGraphics
import XCTest
@testable import Cinderdeck

@MainActor
final class LiveAreaMouseUpSnapshotTests: XCTestCase {

  // MARK: - Helpers

  private func makeSnapshot(displayID: CGDirectDisplayID) -> FrozenDisplaySnapshot? {
    guard let image = TestImageFactory.solidColor(
      width: 20,
      height: 20,
      red: 10, green: 20, blue: 30
    ) else {
      return nil
    }
    return FrozenDisplaySnapshot(
      displayID: displayID,
      screenFrame: CGRect(x: 0, y: 0, width: 10, height: 10),
      scaleFactor: 2.0,
      colorSpaceName: nil,
      image: image
    )
  }

  // MARK: - Gating

  func testShowCursor_disablesFastPath_withoutCallingProvider() {
    var providerCalls = 0
    let snapshots = ScreenCaptureViewModel.gatherLiveMouseUpSnapshots(
      displayIDs: [1],
      showCursor: true,
      excludeDesktopIcons: false,
      excludeDesktopWidgets: false
    ) { displayID in
      providerCalls += 1
      return self.makeSnapshot(displayID: displayID)
    }

    XCTAssertTrue(snapshots.isEmpty, "Cursor capture is not supported by the CG fast path")
    XCTAssertEqual(providerCalls, 0, "Gating must short-circuit before any display grab")
  }

  func testExcludeDesktopIcons_disablesFastPath() {
    let snapshots = ScreenCaptureViewModel.gatherLiveMouseUpSnapshots(
      displayIDs: [1],
      showCursor: false,
      excludeDesktopIcons: true,
      excludeDesktopWidgets: false
    ) { self.makeSnapshot(displayID: $0) }

    XCTAssertTrue(snapshots.isEmpty)
  }

  func testExcludeDesktopWidgets_disablesFastPath() {
    let snapshots = ScreenCaptureViewModel.gatherLiveMouseUpSnapshots(
      displayIDs: [1],
      showCursor: false,
      excludeDesktopIcons: false,
      excludeDesktopWidgets: true
    ) { self.makeSnapshot(displayID: $0) }

    XCTAssertTrue(snapshots.isEmpty)
  }

  // MARK: - Gather

  func testSingleDisplay_returnsItsSnapshot() {
    let snapshots = ScreenCaptureViewModel.gatherLiveMouseUpSnapshots(
      displayIDs: [7],
      showCursor: false,
      excludeDesktopIcons: false,
      excludeDesktopWidgets: false
    ) { self.makeSnapshot(displayID: $0) }

    XCTAssertEqual(snapshots.map(\.displayID), [7])
  }

  func testMultiDisplay_returnsOneSnapshotPerDisplay() {
    let displayIDs: Set<CGDirectDisplayID> = [1, 2, 3]
    let snapshots = ScreenCaptureViewModel.gatherLiveMouseUpSnapshots(
      displayIDs: displayIDs,
      showCursor: false,
      excludeDesktopIcons: false,
      excludeDesktopWidgets: false
    ) { self.makeSnapshot(displayID: $0) }

    XCTAssertEqual(Set(snapshots.map(\.displayID)), displayIDs)
    XCTAssertEqual(snapshots.count, displayIDs.count)
  }

  func testAnyDisplayGrabFailure_returnsEmpty_neverPartial() {
    // A partial result would produce a mixed-source composite (some displays from the
    // mouse-up grab, some from the later fallback path) — the contract is all-or-nothing.
    let snapshots = ScreenCaptureViewModel.gatherLiveMouseUpSnapshots(
      displayIDs: [1, 2, 3],
      showCursor: false,
      excludeDesktopIcons: false,
      excludeDesktopWidgets: false
    ) { displayID in
      displayID == 2 ? nil : self.makeSnapshot(displayID: displayID)
    }

    XCTAssertTrue(snapshots.isEmpty, "One failed display must abort the whole fast grab")
  }
}
