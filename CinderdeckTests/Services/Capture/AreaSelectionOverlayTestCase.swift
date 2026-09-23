//
//  AreaSelectionOverlayTestCase.swift
//  CinderdeckTests
//
//  Shared base class for AreaSelectionOverlayView unit tests.
//  Provides setUp/tearDown boilerplate and image-creation helpers used
//  by the focused sub-test files.
//

import XCTest
import AppKit
@testable import Cinderdeck

class AreaSelectionOverlayTestCase: XCTestCase {

  var originalSettingValue: Any?
  var overlayView: AreaSelectionOverlayView!

  override func setUp() {
    super.setUp()
    originalSettingValue = UserDefaults.standard.object(forKey: PreferencesKeys.screenshotShowSelectionAreaOverlay)
    overlayView = AreaSelectionOverlayView(frame: CGRect(x: 0, y: 0, width: 800, height: 600))
  }

  override func tearDown() {
    if let originalSettingValue {
      UserDefaults.standard.set(originalSettingValue, forKey: PreferencesKeys.screenshotShowSelectionAreaOverlay)
    } else {
      UserDefaults.standard.removeObject(forKey: PreferencesKeys.screenshotShowSelectionAreaOverlay)
    }
    overlayView.clearBackdrop()
    overlayView = nil
    super.tearDown()
  }

  func createSolidColorImage(color: NSColor, size: CGSize) -> CGImage {
    let width = Int(size.width)
    let height = Int(size.height)
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    let context = CGContext(
      data: nil,
      width: width,
      height: height,
      bitsPerComponent: 8,
      bytesPerRow: width * 4,
      space: colorSpace,
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
    )
    context?.setFillColor(color.cgColor)
    context?.fill(CGRect(origin: .zero, size: size))
    return context!.makeImage()!
  }

  /// White image with a black vertical strip on the right (pixels x >= stripStartX).
  func createImageWithBlackRightStrip(size: CGSize, stripStartX: Int) -> CGImage {
    let width = Int(size.width)
    let height = Int(size.height)
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    let context = CGContext(
      data: nil,
      width: width,
      height: height,
      bitsPerComponent: 8,
      bytesPerRow: width * 4,
      space: colorSpace,
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
    )!
    context.setFillColor(NSColor.white.cgColor)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.setFillColor(NSColor.black.cgColor)
    context.fill(CGRect(x: stripStartX, y: 0, width: width - stripStartX, height: height))
    return context.makeImage()!
  }
}
