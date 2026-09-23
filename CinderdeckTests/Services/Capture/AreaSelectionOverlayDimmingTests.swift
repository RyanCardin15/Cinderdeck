//
//  AreaSelectionOverlayDimmingTests.swift
//  CinderdeckTests
//
//  Unit tests for AreaSelectionOverlayView overlay rendering:
//  enabled/disabled dimming, dark/light adaptive colors, and hysteresis banding.
//

import XCTest
import AppKit
@testable import Cinderdeck

final class AreaSelectionOverlayDimmingTests: AreaSelectionOverlayTestCase {

  func testOverlayEnabled_rendersStandardDimming() {
    // GIVEN: Overlay is ON (default/true)
    UserDefaults.standard.set(true, forKey: PreferencesKeys.screenshotShowSelectionAreaOverlay)

    // WHEN: Resetting selection and rendering manual selection rect
    overlayView.setSelectionEnabled(true)
    overlayView.resetSelection()

    let selectionRect = CGRect(x: 100, y: 100, width: 200, height: 150)
    overlayView.renderManualSelection(screenRect: selectionRect, currentScreenPoint: CGPoint(x: 300, y: 250))

    // THEN:
    // - dimLayer background color should be non-nil (the standard dim color)
    // - dimLayer mask should be set to the reusableDimMaskLayer
    // - insideSelectionOverlayLayer should be hidden
    guard let dimLayer = overlayView.dimLayer,
          let insideLayer = overlayView.insideSelectionOverlayLayer else {
      XCTFail("Layers not found")
      return
    }

    XCTAssertNotNil(dimLayer.backgroundColor, "Dim layer must have background color when overlay is enabled")
    XCTAssertNotNil(dimLayer.mask, "Dim layer must have a mask when selection is active and overlay is enabled")
    XCTAssertTrue(insideLayer.isHidden, "Inside overlay layer must be hidden when overlay is enabled")
  }

  func testOverlayDisabled_rendersDarkOverlayOnLightBackdrop() {
    // GIVEN: Overlay is OFF (false) and backdrop is pure white (light background)
    UserDefaults.standard.set(false, forKey: PreferencesKeys.screenshotShowSelectionAreaOverlay)

    let whiteImage = createSolidColorImage(color: .white, size: CGSize(width: 800, height: 600))
    let backdrop = AreaSelectionBackdrop(displayID: 0, image: whiteImage, scaleFactor: 1.0)
    overlayView.applyBackdrop(backdrop)

    // WHEN: Resetting selection and rendering manual selection rect
    overlayView.setSelectionEnabled(true)
    overlayView.resetSelection()

    let selectionRect = CGRect(x: 100, y: 100, width: 200, height: 150)
    overlayView.renderManualSelection(screenRect: selectionRect, currentScreenPoint: CGPoint(x: 300, y: 250))

    // THEN:
    // - insideSelectionOverlayLayer must be visible
    // - insideSelectionOverlayLayer should use dark colors (black fill/stroke) because backdrop is light
    guard let dimLayer = overlayView.dimLayer,
          let insideLayer = overlayView.insideSelectionOverlayLayer else {
      XCTFail("Layers not found")
      return
    }

    XCTAssertNil(dimLayer.backgroundColor, "Dim layer must have nil background color when overlay is disabled")
    XCTAssertNil(dimLayer.mask, "Dim layer must not have a mask when overlay is disabled")
    XCTAssertFalse(insideLayer.isHidden, "Inside overlay layer must be visible when overlay is disabled")

    XCTAssertEqual(insideLayer.fillColor, NSColor.black.withAlphaComponent(0.12).cgColor, "Inside overlay layer must have dark fill color on light background")
    XCTAssertEqual(insideLayer.strokeColor, NSColor.black.withAlphaComponent(0.3).cgColor, "Inside overlay layer must have dark stroke color on light background")
    XCTAssertEqual(insideLayer.lineWidth, 4.0, "Inside overlay layer must have a 4.0 stroke width")
  }

  func testOverlayDisabled_rendersLightOverlayOnDarkBackdrop() {
    // GIVEN: Overlay is OFF (false) and backdrop is pure black (dark background)
    UserDefaults.standard.set(false, forKey: PreferencesKeys.screenshotShowSelectionAreaOverlay)

    let blackImage = createSolidColorImage(color: .black, size: CGSize(width: 800, height: 600))
    let backdrop = AreaSelectionBackdrop(displayID: 0, image: blackImage, scaleFactor: 1.0)
    overlayView.applyBackdrop(backdrop)

    // WHEN: Resetting selection and rendering manual selection rect
    overlayView.setSelectionEnabled(true)
    overlayView.resetSelection()

    let selectionRect = CGRect(x: 100, y: 100, width: 200, height: 150)
    overlayView.renderManualSelection(screenRect: selectionRect, currentScreenPoint: CGPoint(x: 300, y: 250))

    // THEN:
    // - insideSelectionOverlayLayer must be visible
    // - insideSelectionOverlayLayer should use light colors (white fill/stroke) because backdrop is dark (luma is 0.0 < 0.4)
    guard let insideLayer = overlayView.insideSelectionOverlayLayer else {
      XCTFail("Layers not found")
      return
    }

    XCTAssertFalse(insideLayer.isHidden, "Inside overlay layer must be visible when overlay is disabled")
    XCTAssertEqual(insideLayer.fillColor, NSColor.white.withAlphaComponent(0.15).cgColor, "Inside overlay layer must transition to light fill color on dark background")
    XCTAssertEqual(insideLayer.strokeColor, NSColor.white.withAlphaComponent(0.35).cgColor, "Inside overlay layer must transition to light stroke color on dark background")
  }

  func testOverlayDisabled_hysteresisBanding() {
    // GIVEN: Overlay is OFF (false)
    UserDefaults.standard.set(false, forKey: PreferencesKeys.screenshotShowSelectionAreaOverlay)

    // Create custom color image with luma = 0.55 (mid-tone)
    // 0.299*r + 0.587*g + 0.114*b = 0.55
    // Let's set r = 0.55, g = 0.55, b = 0.55 -> luma = 0.55
    let midToneColor = NSColor(red: 0.55, green: 0.55, blue: 0.55, alpha: 1.0)
    let midToneImage = createSolidColorImage(color: midToneColor, size: CGSize(width: 800, height: 600))

    // Create dark color image with luma = 0.25 (below 0.4)
    let darkColor = NSColor(red: 0.25, green: 0.25, blue: 0.25, alpha: 1.0)
    let darkImage = createSolidColorImage(color: darkColor, size: CGSize(width: 800, height: 600))

    // Create light color image with luma = 0.75 (above 0.6)
    let lightColor = NSColor(red: 0.75, green: 0.75, blue: 0.75, alpha: 1.0)
    let lightImage = createSolidColorImage(color: lightColor, size: CGSize(width: 800, height: 600))

    overlayView.setSelectionEnabled(true)

    // 1. Start with mid-tone (default is dark overlay)
    let backdropMid = AreaSelectionBackdrop(displayID: 0, image: midToneImage, scaleFactor: 1.0)
    overlayView.applyBackdrop(backdropMid)
    overlayView.resetSelection()

    let selectionRect = CGRect(x: 100, y: 100, width: 200, height: 150)
    overlayView.renderManualSelection(screenRect: selectionRect, currentScreenPoint: CGPoint(x: 300, y: 250))

    guard let insideLayer = overlayView.insideSelectionOverlayLayer else {
      XCTFail("Layers not found")
      return
    }

    // Initial state is dark, luma 0.55 doesn't cross the 0.4 lower threshold to make it light, so it stays dark.
    XCTAssertEqual(insideLayer.fillColor, NSColor.black.withAlphaComponent(0.12).cgColor, "Should start and stay dark overlay on mid-tone")

    // 2. Change backdrop to dark (luma = 0.25 < 0.4) -> should transition to light overlay
    let backdropDark = AreaSelectionBackdrop(displayID: 0, image: darkImage, scaleFactor: 1.0)
    overlayView.applyBackdrop(backdropDark)
    overlayView.renderManualSelection(screenRect: selectionRect, currentScreenPoint: CGPoint(x: 300, y: 250))

    XCTAssertEqual(insideLayer.fillColor, NSColor.white.withAlphaComponent(0.15).cgColor, "Should switch to light overlay on dark background")

    // 3. Change backdrop back to mid-tone (luma = 0.55) -> should stay light overlay (hysteresis)
    overlayView.applyBackdrop(backdropMid)
    overlayView.renderManualSelection(screenRect: selectionRect, currentScreenPoint: CGPoint(x: 300, y: 250))

    XCTAssertEqual(insideLayer.fillColor, NSColor.white.withAlphaComponent(0.15).cgColor, "Should maintain light overlay on mid-tone due to hysteresis")

    // 4. Change backdrop to light (luma = 0.75 > 0.6) -> should transition back to dark overlay
    let backdropLight = AreaSelectionBackdrop(displayID: 0, image: lightImage, scaleFactor: 1.0)
    overlayView.applyBackdrop(backdropLight)
    overlayView.renderManualSelection(screenRect: selectionRect, currentScreenPoint: CGPoint(x: 300, y: 250))

    XCTAssertEqual(insideLayer.fillColor, NSColor.black.withAlphaComponent(0.12).cgColor, "Should switch back to dark overlay on light background")
  }

  func testOverlayDisabled_invisibleBackdropDoesNotRenderButCachesPixels() {
    // GIVEN: Overlay is OFF (false)
    UserDefaults.standard.set(false, forKey: PreferencesKeys.screenshotShowSelectionAreaOverlay)

    // Create dark color image (luma < 0.4)
    let darkImage = createSolidColorImage(color: .black, size: CGSize(width: 800, height: 600))

    overlayView.setSelectionEnabled(true)

    // Apply invisible backdrop
    let backdrop = AreaSelectionBackdrop(displayID: 0, image: darkImage, scaleFactor: 1.0, isVisible: false)
    overlayView.applyBackdrop(backdrop)
    overlayView.resetSelection()

    // THEN:
    // - snapshotLayer must be hidden because backdrop.isVisible is false
    XCTAssertTrue(overlayView.testSnapshotLayer.isHidden, "Snapshot layer must remain hidden when backdrop is invisible")

    // - backdropPixelDataArray must be cached
    XCTAssertNotNil(overlayView.testBackdropPixelDataArray, "Backdrop pixels must be cached even when backdrop is invisible")

    // - When selection is made, it should correctly sample pixels and use light overlay
    let selectionRect = CGRect(x: 100, y: 100, width: 200, height: 150)
    overlayView.renderManualSelection(screenRect: selectionRect, currentScreenPoint: CGPoint(x: 300, y: 250))

    guard let insideLayer = overlayView.insideSelectionOverlayLayer else {
      XCTFail("insideSelectionOverlayLayer not found")
      return
    }

    XCTAssertFalse(insideLayer.isHidden, "Inside overlay layer must be visible when overlay is disabled")
    XCTAssertEqual(insideLayer.fillColor, NSColor.white.withAlphaComponent(0.15).cgColor, "Inside overlay layer must transition to light fill color on dark background")
  }
}
