//
//  AreaSelectionOverlayLumaSamplingTests.swift
//  CinderdeckTests
//
//  Regression test for the luma-sampling coordinate mismatch:
//  backdrop captured at nominalResolution but scaleFactor set to backingScaleFactor.
//

import XCTest
import AppKit
@testable import Cinderdeck

final class AreaSelectionOverlayLumaSamplingTests: AreaSelectionOverlayTestCase {

  func testLumaSampling_derivesScaleFromImageDims_notDeclaredScaleFactor() {
    // Regression (small selection on light background mis-detected as dark→light overlay):
    // the live luma backdrop is captured at `.nominalResolution` (point-sized) but its scaleFactor was
    // set to backingScaleFactor (2x). The old sampler multiplied sample coords by that 2x, overshooting
    // and clamping the grid to the screen's right/bottom edge — so a small centered selection sampled
    // the wrong region. Here the correct region (center) is WHITE and the buggy clamp region (right
    // edge) is BLACK, so the two behaviours produce opposite overlay colors.
    UserDefaults.standard.set(false, forKey: PreferencesKeys.screenshotShowSelectionAreaOverlay)

    // View bounds are 800x600 (setUp). Image is point-sized 800x600 but the backdrop DECLARES scale 2.0,
    // reproducing the nominalResolution + backingScaleFactor mismatch.
    let image = createImageWithBlackRightStrip(size: CGSize(width: 800, height: 600), stripStartX: 720)
    let backdrop = AreaSelectionBackdrop(displayID: 0, image: image, scaleFactor: 2.0, isVisible: false)

    overlayView.setSelectionEnabled(true)
    overlayView.applyBackdrop(backdrop)
    overlayView.resetSelection()

    // Small, centered selection: correct sampling reads the white center (x ~366-433, all < 720);
    // the old 2x-overshoot sampling would clamp to x ~799 (the black strip) and wrongly flip to light.
    let selectionRect = CGRect(x: 350, y: 250, width: 100, height: 80)
    overlayView.renderManualSelection(screenRect: selectionRect, currentScreenPoint: CGPoint(x: 400, y: 290))

    guard let insideLayer = overlayView.insideSelectionOverlayLayer else {
      XCTFail("insideSelectionOverlayLayer not found")
      return
    }
    XCTAssertEqual(
      insideLayer.fillColor,
      NSColor.black.withAlphaComponent(0.12).cgColor,
      "A small centered selection over a white region must keep the dark overlay regardless of the backdrop's declared scaleFactor"
    )
  }
}
