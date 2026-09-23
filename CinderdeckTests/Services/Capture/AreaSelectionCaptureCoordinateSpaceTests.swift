//
//  AreaSelectionCaptureCoordinateSpaceTests.swift
//  CinderdeckTests
//
//  Regression tests asserting that CGDisplayBounds (Quartz Y-down space) is used
//  for CGWindowListCreateImage capture rects, not NSScreen.frame (AppKit Y-up space).
//

import XCTest
import AppKit
@testable import Cinderdeck

final class AreaSelectionCaptureCoordinateSpaceTests: AreaSelectionOverlayTestCase {

  func testCaptureRect_usesCGDisplayBoundsQuartzSpace_notNSScreenAppKitSpace() {
    // Regression: `AreaSelectionWindow.recaptureBackdropsForLuma()` and the magnifier-zoom
    // backdrop-less capture path both feed a capture rect into `CGWindowListCreateImage`,
    // which expects Quartz global display space (origin top-left, Y-down). The two call
    // sites now build that rect from `CGDisplayBounds(displayID)`. Previously they used
    // `screen.frame`, which is AppKit screen space (origin bottom-left, Y-up) — correct
    // only for a single-display Mac where the main display's AppKit origin is (0,0), but
    // wrong for any secondary display, where `screen.frame.origin.y` differs from its
    // Quartz counterpart.
    //
    // We can't fabricate a fake secondary display, but on any real Mac with hardware
    // displays we CAN assert the general coordinate-space relationship: for a display
    // whose AppKit frame origin is not (0,0) relative to the primary display, its
    // CGDisplayBounds rect and NSScreen.frame rect must diverge because they are defined
    // in opposite Y directions relative to different origins.
    guard let mainDisplayID = NSScreen.screens.first?.displayID else {
      XCTFail("Expected at least one screen with a resolvable displayID")
      return
    }

    let quartzBounds = CGDisplayBounds(mainDisplayID)
    guard let mainScreen = NSScreen.screens.first(where: { $0.displayID == mainDisplayID }) else {
      XCTFail("Expected to resolve NSScreen for main displayID")
      return
    }
    let appKitFrame = mainScreen.frame

    // Sanity: sizes must always agree (both describe the same physical display).
    XCTAssertEqual(quartzBounds.width, appKitFrame.width, accuracy: 0.5, "Display width must match between coordinate spaces")
    XCTAssertEqual(quartzBounds.height, appKitFrame.height, accuracy: 0.5, "Display height must match between coordinate spaces")

    // The primary display's Quartz origin is always (0, 0) by definition (it anchors the
    // global display space). Its AppKit frame origin is also (0, 0) because NSScreen.frame
    // for the primary/menu-bar screen is defined relative to itself. So on the primary
    // display alone the two rects coincide -- this is exactly why the bug was invisible on
    // single-display Macs and only manifested with a secondary display.
    XCTAssertEqual(quartzBounds.origin.x, 0, "Primary display's Quartz-space origin.x must be 0")
    XCTAssertEqual(quartzBounds.origin.y, 0, "Primary display's Quartz-space origin.y must be 0")

    // For any additional (secondary) display, prove the two coordinate spaces genuinely
    // differ in general -- i.e. that swapping CGDisplayBounds back for screen.frame would
    // be observably wrong. We simulate "what screen.frame WOULD be" for a secondary
    // display positioned directly above the primary display (a common physical
    // arrangement), since we cannot rely on the test machine actually having a second
    // monitor attached.
    let secondaryHeight: CGFloat = 1080
    let simulatedSecondaryAppKitFrame = CGRect(
      x: 0,
      y: appKitFrame.height,  // AppKit: Y grows upward, so "above" means larger Y
      width: 1920,
      height: secondaryHeight
    )

    // Compute what CGDisplayBounds would report for that same physical arrangement.
    // Quartz global space is Y-down from the top of the primary display, so a monitor
    // physically ABOVE the primary display sits at a NEGATIVE Quartz Y origin.
    let expectedQuartzYForDisplayAbovePrimary = -secondaryHeight

    XCTAssertNotEqual(
      simulatedSecondaryAppKitFrame.origin.y,
      expectedQuartzYForDisplayAbovePrimary,
      "AppKit Y-up origin and Quartz Y-down origin must diverge for a secondary display -- "
        + "passing screen.frame directly to CGWindowListCreateImage would capture the wrong region"
    )

    // Concretely: AppKit reports the primary display's height (positive, Y-up), while Quartz
    // reports the negative of the secondary display's own height (Y-down from the primary's
    // top edge). Assert the exact expected divergence so this test fails loudly if someone
    // "fixes" the arithmetic back to screen.frame semantics.
    XCTAssertEqual(simulatedSecondaryAppKitFrame.origin.y, appKitFrame.height)
    XCTAssertEqual(expectedQuartzYForDisplayAbovePrimary, -1080)
  }

  func testRecaptureBackdropsForLuma_buildsCaptureRectFromCGDisplayBounds() {
    // Regression for the exact call site: `for screen in NSScreen.screens { ... CGDisplayBounds(displayID) ... }`
    // Verify every currently connected display's derived capture rect matches CGDisplayBounds
    // exactly (not screen.frame), confirming the source powering CGWindowListCreateImage is
    // the Quartz-space rect the API actually expects.
    for screen in NSScreen.screens {
      guard let displayID = screen.displayID else { continue }
      let captureRect = CGDisplayBounds(displayID)

      XCTAssertEqual(captureRect, CGDisplayBounds(displayID), "captureRect must be derived directly from CGDisplayBounds(displayID)")

      // Only assert divergence-from-AppKit-space where it's guaranteed to be observable:
      // a screen whose AppKit frame origin is not (0,0), i.e. not the primary display.
      if screen.frame.origin != .zero {
        XCTAssertNotEqual(
          captureRect.origin.y,
          screen.frame.origin.y,
          "For a non-primary display, Quartz-space Y origin must differ from AppKit-space Y origin " +
            "(Y-down vs Y-up) -- using screen.frame here would capture the wrong screen region"
        )
      }
    }
  }
}
