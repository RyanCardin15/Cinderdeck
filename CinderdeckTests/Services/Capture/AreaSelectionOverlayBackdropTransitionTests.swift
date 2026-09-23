//
//  AreaSelectionOverlayBackdropTransitionTests.swift
//  CinderdeckTests
//
//  Unit tests for BackdropTransitionEffect.shouldCrossfade logic and
//  applyBackdrop animation behavior.
//

import XCTest
import AppKit
@testable import Cinderdeck

final class AreaSelectionOverlayBackdropTransitionTests: AreaSelectionOverlayTestCase {

  // MARK: - BackdropTransitionEffect.shouldCrossfade

  func testShouldCrossfade_falseOnFirstApply() {
    // First-apply: no prior image cached → isReapplication = false → instant, no crossfade
    XCTAssertFalse(
      BackdropTransitionEffect.shouldCrossfade(isReapplication: false, isVisible: true),
      "First-apply must never crossfade (nothing to fade from)"
    )
  }

  func testShouldCrossfade_falseForInvisibleBackdrop() {
    // Invisible (luma-only) backdrop → isVisible = false → no visual change → no crossfade
    XCTAssertFalse(
      BackdropTransitionEffect.shouldCrossfade(isReapplication: true, isVisible: false),
      "Invisible luma-only backdrops must never crossfade"
    )
  }

  func testShouldCrossfade_trueForVisibleReapplication() {
    // Visible re-application: result depends on both the master flag and reduce-motion.
    let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    let expected = BackdropTransitionEffect.isEnabled && !reduceMotion
    XCTAssertEqual(
      BackdropTransitionEffect.shouldCrossfade(isReapplication: true, isVisible: true),
      expected,
      "Visible re-application should crossfade only when isEnabled=true and reduce-motion is off"
    )
  }

  // MARK: - applyBackdrop animation behavior

  func testApplyBackdrop_animated_doesNotChangeFinalContents() {
    // GIVEN: an initial backdrop applied (so re-application logic triggers)
    let image1 = createSolidColorImage(color: .white, size: CGSize(width: 800, height: 600))
    let backdrop1 = AreaSelectionBackdrop(displayID: 0, image: image1, scaleFactor: 1.0)
    overlayView.applyBackdrop(backdrop1)
    XCTAssertNotNil(overlayView.testSnapshotLayer.contents, "Backdrop must be cached after first apply")

    // WHEN: re-applying with animated:true
    let image2 = createSolidColorImage(color: .black, size: CGSize(width: 800, height: 600))
    let backdrop2 = AreaSelectionBackdrop(displayID: 0, image: image2, scaleFactor: 1.0)
    overlayView.applyBackdrop(backdrop2, animated: true)

    // THEN: final layer contents must be the new image (animation doesn't block the swap)
    XCTAssertTrue(
      (overlayView.testSnapshotLayer.contents as AnyObject) === (image2 as AnyObject),
      "snapshotLayer.contents must be updated to the new image even when animated"
    )
    XCTAssertFalse(overlayView.testSnapshotLayer.isHidden, "Snapshot layer must remain visible for a visible backdrop")
  }

  func testApplyBackdrop_invisibleReapplication_remainsInstant() {
    // Invisible backdrops (luma-only) must never animate and layer stays hidden
    let image1 = createSolidColorImage(color: .white, size: CGSize(width: 800, height: 600))
    let backdrop1 = AreaSelectionBackdrop(displayID: 0, image: image1, scaleFactor: 1.0, isVisible: false)
    overlayView.applyBackdrop(backdrop1)

    let image2 = createSolidColorImage(color: .gray, size: CGSize(width: 800, height: 600))
    let backdrop2 = AreaSelectionBackdrop(displayID: 0, image: image2, scaleFactor: 1.0, isVisible: false)
    overlayView.applyBackdrop(backdrop2, animated: true)

    XCTAssertTrue(overlayView.testSnapshotLayer.isHidden, "Invisible backdrop must keep snapshotLayer hidden even on re-apply")
  }
}
