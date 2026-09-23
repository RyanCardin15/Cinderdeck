//
//  SmartElementWindowOwnerResolver.swift
//  Cinderdeck
//
//  Resolves the topmost foreign app window under a screen point.
//

import AppKit
import Foundation

struct CGWindowListSmartElementSource: SmartElementWindowListSource {
  func copyOnScreenWindowInfo() -> [[String: Any]] {
    (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
      as? [[String: Any]]) ?? []
  }
}

final class SmartElementWindowOwnerResolver: SmartElementWindowOwnerResolving {
  private let windowListSource: SmartElementWindowListSource
  private let ownBundleIdentifier: String?

  init(
    windowListSource: SmartElementWindowListSource = CGWindowListSmartElementSource(),
    ownBundleIdentifier: String? = Bundle.main.bundleIdentifier
  ) {
    self.windowListSource = windowListSource
    self.ownBundleIdentifier = ownBundleIdentifier
  }

  func resolveOwner(at point: CGPoint) -> SmartElementWindowOwner? {
    for windowInfo in windowListSource.copyOnScreenWindowInfo() {
      guard let owner = owner(from: windowInfo), owner.frame.contains(point) else { continue }
      return SmartElementWindowOwner(
        pid: owner.pid,
        windowID: owner.windowID,
        bundleIdentifier: owner.bundleIdentifier
      )
    }
    return nil
  }

  private func owner(from windowInfo: [String: Any]) -> WindowInfo? {
    guard
      let windowNumber = windowInfo[kCGWindowNumber as String] as? NSNumber,
      let ownerPID = windowInfo[kCGWindowOwnerPID as String] as? NSNumber,
      let layer = windowInfo[kCGWindowLayer as String] as? NSNumber,
      layer.intValue == 0,
      let bounds = windowInfo[kCGWindowBounds as String] as? NSDictionary,
      let quartzRect = CGRect(dictionaryRepresentation: bounds)?.standardized
    else {
      return nil
    }

    let bundleIdentifier = NSRunningApplication(
      processIdentifier: ownerPID.int32Value
    )?.bundleIdentifier
    if let ownBundleIdentifier, bundleIdentifier == ownBundleIdentifier {
      return nil
    }

    let frame = Self.appKitGlobalRect(fromQuartzGlobalRect: quartzRect).integral
    guard frame.width > 0, frame.height > 0 else { return nil }

    return WindowInfo(
      pid: ownerPID.int32Value,
      windowID: CGWindowID(windowNumber.uint32Value),
      bundleIdentifier: bundleIdentifier,
      frame: frame
    )
  }

  private static func appKitGlobalRect(fromQuartzGlobalRect rect: CGRect) -> CGRect {
    let mainScreenHeight = NSScreen.screens.first(where: { $0.displayID == CGMainDisplayID() })?.frame.height
      ?? CGDisplayBounds(CGMainDisplayID()).height
    return CGRect(x: rect.minX, y: mainScreenHeight - rect.maxY, width: rect.width, height: rect.height)
  }

  private struct WindowInfo {
    let pid: Int32
    let windowID: CGWindowID
    let bundleIdentifier: String?
    let frame: CGRect
  }
}
