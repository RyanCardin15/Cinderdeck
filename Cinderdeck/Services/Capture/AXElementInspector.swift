//
//  AXElementInspector.swift
//  Cinderdeck
//
//  Filter + coordinate-flip helpers used by SmartElementQueryService.
//  Walks the AX snapshot parent chain to find a "meaningful" element
//  and converts AX top-left global rects into AppKit bottom-left.
//

import AppKit
import Foundation

enum AXElementInspector {

  /// Roles that produce a "good capture target". Narrowest interactive first.
  static let acceptableRoles: Set<String> = [
    "AXButton", "AXLink", "AXCheckBox", "AXRadioButton",
    "AXTextField", "AXTextArea", "AXPopUpButton", "AXMenuItem",
    "AXImage", "AXCell", "AXStaticText", "AXGroup",
    "AXScrollArea", "AXSheet", "AXWebArea", "AXMenu",
    "AXMenuBar", "AXSplitGroup", "AXTable", "AXOutline",
    "AXRow", "AXColumn", "AXToolbar",
    // Website specific roles
    "AXHeading", "AXParagraph", "AXList", "AXForm", "AXGrid",
    "AXDocument", "AXLandmark", "AXRegion", "AXBlockQuote",
    "AXComboBox", "AXSlider", "AXDisclosureTriangle", "AXTabGroup"
  ]

  /// Roles to reject outright — too coarse or non-renderable.
  static let rejectedRoles: Set<String> = [
    "AXApplication", "AXSystemWide", "AXUnknown",
  ]

  static let minSide: CGFloat = 12
  static let maxParentDepth = 25
  static let windowFillThreshold: CGFloat = 0.95

  /// Walks up the parent chain until it finds an element matching the
  /// acceptable-role / reasonable-size criteria. Returns nil if no
  /// suitable candidate is found within `maxParentDepth` levels.
  static func findMeaningful(_ snapshot: AXElementSnapshot) -> AXElementSnapshot? {
    var current: AXElementSnapshot? = snapshot
    var depth = 0
    while let candidate = current, depth < maxParentDepth {
      if isMeaningful(candidate, atDepth: depth) {
        DiagnosticLogger.shared.log(.debug, .capture, "findMeaningful: accepted element at depth \(depth)", context: ["role": candidate.role ?? "nil"])
        return candidate
      }
      current = candidate.parent
      depth += 1
    }
    if depth >= maxParentDepth {
      DiagnosticLogger.shared.log(.debug, .capture, "findMeaningful: reached maxParentDepth without success")
    }
    return nil
  }

  static func isMeaningful(_ snapshot: AXElementSnapshot, atDepth depth: Int = 0) -> Bool {
    guard let role = snapshot.role else {
      DiagnosticLogger.shared.log(.debug, .capture, "isMeaningful(depth: \(depth)): false (role is nil)")
      return false
    }
    
    if rejectedRoles.contains(role) {
      DiagnosticLogger.shared.log(.debug, .capture, "isMeaningful(depth: \(depth)): false (rejected role)", context: ["role": role])
      return false
    }
    
    if !acceptableRoles.contains(role) {
      DiagnosticLogger.shared.log(.debug, .capture, "isMeaningful(depth: \(depth)): false (role not in acceptableRoles)", context: ["role": role])
      return false
    }
    
    let size = snapshot.size
    guard size.width >= minSide, size.height >= minSide else {
      DiagnosticLogger.shared.log(.debug, .capture, "isMeaningful(depth: \(depth)): false (size too small)", context: ["role": role, "size": "\(size.width)x\(size.height)"])
      return false
    }
    
    if let windowSize = snapshot.containingWindowSize, windowSize.width > 0, windowSize.height > 0 {
      let areaRatio = (size.width * size.height) / (windowSize.width * windowSize.height)
      if areaRatio > windowFillThreshold {
        DiagnosticLogger.shared.log(.debug, .capture, "isMeaningful(depth: \(depth)): false (window ratio > \(windowFillThreshold))", context: ["role": role, "ratio": "\(areaRatio)"])
        return false
      }
    }
    
    return true
  }

  /// Flips an AX top-left rect into AppKit bottom-left global coordinates
  /// using the screen that contains the rect. Returns nil if no screen matches.
  static func screenRect(forTopLeftRect axRect: CGRect) -> CGRect? {
    let primaryHeight = NSScreen.screens.first(where: { $0.displayID == CGMainDisplayID() })?.frame.height
      ?? CGDisplayBounds(CGMainDisplayID()).height
    // AppKit frames are in bottom-left. Flip the AX rect into AppKit space
    // using the primary-display height, then verify a screen contains it.
    let flippedProbe = CGRect(
      x: axRect.origin.x,
      y: primaryHeight - axRect.maxY,
      width: axRect.width,
      height: axRect.height
    )
    let screen = NSScreen.screens.first(where: { $0.frame.intersects(flippedProbe) })
      ?? NSScreen.screens.first(where: { $0.frame.contains(flippedProbe.origin) })
    guard screen != nil else { return nil }
    return flippedProbe.integral
  }
}
