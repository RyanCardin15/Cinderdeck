//
//  QuickLookCaptureTests.swift
//  CinderdeckTests
//

import CoreGraphics
import XCTest
@testable import Cinderdeck

final class QuickLookCaptureTests: XCTestCase {
  func testQuickLookWindowIsCompositedAtItsDisplayPosition() {
    let baseImage = solidImage(width: 100, height: 100, red: 0, green: 0, blue: 0)
    let quickLookImage = solidImage(width: 20, height: 30, red: 1, green: 1, blue: 1)
    let quickLookCapture = ImmediateQuickLookCapture(
      windowID: 42,
      displayID: 1,
      frame: CGRect(x: 40, y: 30, width: 20, height: 30),
      image: quickLookImage,
      scaleFactor: 1
    )

    let result = ScreenCaptureManager.imageByCompositingQuickLookWindows(
      baseImage: baseImage,
      screenFrame: CGRect(x: 0, y: 0, width: 100, height: 100),
      captures: [quickLookCapture]
    )

    let restoredPixel = pixel(in: result, x: 45, y: 35)
    XCTAssertGreaterThan(restoredPixel.0, 200)
    XCTAssertGreaterThan(restoredPixel.1, 200)
    XCTAssertGreaterThan(restoredPixel.2, 200)

    let untouchedPixel = pixel(in: result, x: 10, y: 10)
    XCTAssertLessThan(untouchedPixel.0, 50)
    XCTAssertLessThan(untouchedPixel.1, 50)
    XCTAssertLessThan(untouchedPixel.2, 50)
  }

  private func solidImage(width: Int, height: Int, red: CGFloat, green: CGFloat, blue: CGFloat) -> CGImage {
    let context = CGContext(
      data: nil,
      width: width,
      height: height,
      bitsPerComponent: 8,
      bytesPerRow: width * 4,
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    )!
    context.setFillColor(CGColor(red: red, green: green, blue: blue, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    return context.makeImage()!
  }

  private func pixel(in image: CGImage, x: Int, y: Int) -> (UInt8, UInt8, UInt8) {
    var bytes = [UInt8](repeating: 0, count: 4)
    let context = CGContext(
      data: &bytes,
      width: 1,
      height: 1,
      bitsPerComponent: 8,
      bytesPerRow: 4,
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    )!
    context.draw(
      image,
      in: CGRect(x: -x, y: y - image.height + 1, width: image.width, height: image.height)
    )
    return (bytes[0], bytes[1], bytes[2])
  }
}
