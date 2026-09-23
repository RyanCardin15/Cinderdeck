//
//  SmartElementWindowOwnerResolverTests.swift
//  CinderdeckTests
//
//  Unit tests for CoreGraphics window-owner resolution.
//

import AppKit
import XCTest
@testable import Cinderdeck

@MainActor
final class SmartElementWindowOwnerResolverTests: XCTestCase {
  func testEmptyList_returnsNil() {
    let resolver = makeResolver(windows: [])

    XCTAssertNil(resolver.resolveOwner(at: CGPoint(x: 10, y: 10)))
  }

  func testOwnBundleEntry_isSkipped() throws {
    let ownPID = ProcessInfo.processInfo.processIdentifier
    let ownBundleID = try XCTUnwrap(NSRunningApplication(processIdentifier: ownPID)?.bundleIdentifier)
    let resolver = makeResolver(
      windows: [windowInfo(frame: CGRect(x: 20, y: 20, width: 200, height: 120), pid: ownPID)],
      ownBundleIdentifier: ownBundleID
    )

    XCTAssertNil(resolver.resolveOwner(at: CGPoint(x: 30, y: 30)))
  }

  func testForeignEntryContainingPoint_returnsOwner() throws {
    let resolver = makeResolver(
      windows: [windowInfo(frame: CGRect(x: 20, y: 20, width: 200, height: 120), pid: 12, windowID: 77)]
    )

    let owner = try XCTUnwrap(resolver.resolveOwner(at: CGPoint(x: 30, y: 30)))

    XCTAssertEqual(owner.pid, 12)
    XCTAssertEqual(owner.windowID, 77)
  }

  func testMultipleForeignEntries_returnsFirstTopmostMatch() throws {
    let resolver = makeResolver(
      windows: [
        windowInfo(frame: CGRect(x: 20, y: 20, width: 200, height: 120), pid: 44, windowID: 10),
        windowInfo(frame: CGRect(x: 20, y: 20, width: 200, height: 120), pid: 55, windowID: 11),
      ]
    )

    let owner = try XCTUnwrap(resolver.resolveOwner(at: CGPoint(x: 30, y: 30)))

    XCTAssertEqual(owner.pid, 44)
    XCTAssertEqual(owner.windowID, 10)
  }

  func testLayerNotZero_isSkipped() {
    let resolver = makeResolver(
      windows: [windowInfo(frame: CGRect(x: 20, y: 20, width: 200, height: 120), pid: 12, layer: 1)]
    )

    XCTAssertNil(resolver.resolveOwner(at: CGPoint(x: 30, y: 30)))
  }

  func testPointOutsideAllEntries_returnsNil() {
    let resolver = makeResolver(
      windows: [windowInfo(frame: CGRect(x: 20, y: 20, width: 200, height: 120), pid: 12)]
    )

    XCTAssertNil(resolver.resolveOwner(at: CGPoint(x: 300, y: 300)))
  }

  private func makeResolver(
    windows: [[String: Any]],
    ownBundleIdentifier: String? = "com.cinderdeck.tests"
  ) -> SmartElementWindowOwnerResolver {
    SmartElementWindowOwnerResolver(
      windowListSource: FakeSmartElementWindowListSource(windows: windows),
      ownBundleIdentifier: ownBundleIdentifier
    )
  }

  private func windowInfo(
    frame: CGRect,
    pid: Int32,
    windowID: CGWindowID = 99,
    layer: Int = 0
  ) -> [String: Any] {
    [
      kCGWindowLayer as String: NSNumber(value: layer),
      kCGWindowNumber as String: NSNumber(value: windowID),
      kCGWindowOwnerPID as String: NSNumber(value: pid),
      kCGWindowBounds as String: quartzBounds(fromAppKitFrame: frame) as NSDictionary,
    ]
  }

  private func quartzBounds(fromAppKitFrame frame: CGRect) -> CFDictionary {
    let mainHeight = NSScreen.screens.first(where: { $0.displayID == CGMainDisplayID() })?.frame.height
      ?? CGDisplayBounds(CGMainDisplayID()).height
    let quartzRect = CGRect(x: frame.minX, y: mainHeight - frame.maxY, width: frame.width, height: frame.height)
    return quartzRect.dictionaryRepresentation
  }
}

