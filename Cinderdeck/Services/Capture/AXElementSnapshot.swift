//
//  AXElementSnapshot.swift
//  Cinderdeck
//
//  Accessibility (AX) snapshot value type and the protocol seam that
//  SmartElementQueryService uses to query the AX tree. Splitting this
//  out from AXElementInspector keeps the filter/flip logic isolated
//  and testable without dragging the real AX provider into tests.
//

import AppKit
import ApplicationServices
import Foundation

// MARK: - Snapshot

/// Pure value snapshot of a single AX element at hit-test time.
/// `position`/`size` are in AX top-left global screen coordinates.
/// `parent` is lazy so the full ancestor chain is not eagerly fetched
/// (researcher-01 §7: requesting kAXParentAttribute in a batch can loop).
struct AXElementSnapshot {
  let role: String?
  let position: CGPoint
  let size: CGSize
  let containingWindowSize: CGSize?
  private let parentResolver: () -> AXElementSnapshot?

  init(
    role: String?,
    position: CGPoint,
    size: CGSize,
    containingWindowSize: CGSize? = nil,
    parent: @escaping () -> AXElementSnapshot? = { nil }
  ) {
    self.role = role
    self.position = position
    self.size = size
    self.containingWindowSize = containingWindowSize
    self.parentResolver = parent
  }

  var parent: AXElementSnapshot? { parentResolver() }
  var rect: CGRect { CGRect(origin: position, size: size) }
}

// MARK: - Protocol Seam

protocol AXSnapshotProviding {
  /// Returns the AX snapshot at the given top-left global point, scoped to `pid` when provided.
  /// Implementations must be safe to call from the main thread.
  func snapshot(at point: CGPoint, pid: Int32?) -> AXElementSnapshot?
}

// MARK: - Real AX Provider

struct AXAccessibilitySnapshotProvider: AXSnapshotProviding {

  func snapshot(at point: CGPoint, pid: Int32?) -> AXElementSnapshot? {
    let root = pid.map { AXUIElementCreateApplication($0) } ?? AXUIElementCreateSystemWide()
    var element: AXUIElement?
    let error = AXUIElementCopyElementAtPosition(root, Float(point.x), Float(point.y), &element)
    guard error == .success, let axElement = element else {
      DiagnosticLogger.shared.log(.error, .capture, "AXUIElementCopyElementAtPosition failed: \(error.rawValue)", context: ["pid": pid.map(String.init) ?? "sys"])
      return nil
    }
    return Self.snapshot(of: axElement)
  }

  fileprivate static func snapshot(of element: AXUIElement) -> AXElementSnapshot? {
    let role = stringAttribute(of: element, attribute: kAXRoleAttribute)
    guard
      let position = axValue(of: element, attribute: kAXPositionAttribute, type: .cgPoint, default: CGPoint.zero),
      let size = axValue(of: element, attribute: kAXSizeAttribute, type: .cgSize, default: CGSize.zero)
    else {
      DiagnosticLogger.shared.log(.error, .capture, "AX element missing position or size", context: ["role": role ?? "nil"])
      return nil
    }

    let windowSize = windowSize(for: element)

    return AXElementSnapshot(
      role: role,
      position: position,
      size: size,
      containingWindowSize: windowSize,
      parent: { parentSnapshot(of: element) }
    )
  }

  fileprivate static func parentSnapshot(of element: AXUIElement) -> AXElementSnapshot? {
    var parentRef: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(element, kAXParentAttribute as CFString, &parentRef)
    guard
      result == .success,
      let parentRef,
      CFGetTypeID(parentRef) == AXUIElementGetTypeID()
    else { return nil }
    return snapshot(of: parentRef as! AXUIElement)
  }

  private static func windowSize(for element: AXUIElement) -> CGSize? {
    var windowRef: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(element, kAXWindowAttribute as CFString, &windowRef)
    guard
      result == .success,
      let windowRef,
      CFGetTypeID(windowRef) == AXUIElementGetTypeID()
    else { return nil }
    let windowElement = windowRef as! AXUIElement
    return axValue(of: windowElement, attribute: kAXSizeAttribute, type: .cgSize, default: CGSize.zero)
  }

  private static func stringAttribute(of element: AXUIElement, attribute: String) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
    return value as? String
  }

  private static func axValue<T>(
    of element: AXUIElement,
    attribute: String,
    type: AXValueType,
    default defaultValue: T
  ) -> T? {
    var raw: CFTypeRef?
    guard
      AXUIElementCopyAttributeValue(element, attribute as CFString, &raw) == .success,
      let raw,
      CFGetTypeID(raw) == AXValueGetTypeID()
    else { return nil }
    let axValue = raw as! AXValue
    guard AXValueGetType(axValue) == type else { return nil }
    var value = defaultValue
    guard AXValueGetValue(axValue, type, &value) else { return nil }
    return value
  }
}
