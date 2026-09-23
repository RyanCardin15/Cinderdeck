//
//  SmartElementCaptureProtocols.swift
//  Cinderdeck
//
//  Protocol seams that let SmartElementCaptureController be unit-tested
//  without touching real AX APIs, real CGWindowList, or a real screenshot.
//

import AppKit
import Combine
import CoreGraphics
import Foundation

// MARK: - AX Query Service

/// Public surface of `SmartElementQueryService` consumed by the controller.
/// Existing `SmartElementQueryService` already matches this shape.
protocol SmartElementQueryProviding: AnyObject {
  var elementDetectedPublisher: AnyPublisher<CGRect?, Never> { get }
  func updateMouseLocation(pid: Int32?)
  func cancelPendingQueries()
  @discardableResult
  func ensureAccessibilityPermission() -> Bool
}

extension SmartElementQueryService: SmartElementQueryProviding {}

// MARK: - Window Owner

/// Identifies the topmost on-screen non-Cinderdeck window at a screen point.
struct SmartElementWindowOwner: Equatable {
  let pid: Int32
  let windowID: CGWindowID
  let bundleIdentifier: String?
}

protocol SmartElementWindowOwnerResolving: AnyObject {
  func resolveOwner(at point: CGPoint) -> SmartElementWindowOwner?
}

// MARK: - Capture Sink

/// Wraps the final "take a screenshot of this rect and route it through the
/// post-capture pipeline" step. Lives behind a protocol so tests can assert
/// the controller hands off the right rect without writing a real file.
@MainActor
protocol SmartElementCapturePerforming: AnyObject {
  func captureRect(_ rect: CGRect) async
}

// MARK: - Overlay Window

@MainActor
protocol SmartElementOverlayWindowProviding: AnyObject {
  var displayID: CGDirectDisplayID? { get }
  var frame: CGRect { get }
  var currentHighlightRect: CGRect? { get }
  var eventDelegate: SmartElementOverlayWindowDelegate? { get set }
  func setFrame(_ frameRect: NSRect, display flag: Bool)
  func orderFrontRegardless()
  func orderOut(_ sender: Any?)
  func close()
  func makeKey()
  func makeFirstResponder(_ responder: NSResponder?) -> Bool
  func updateBounds(_ screenFrame: CGRect)
  func updateHighlight(_ rect: CGRect?)
}

@MainActor
protocol SmartElementOverlayWindowDelegate: AnyObject {
  func smartElementOverlayWindow(_ window: SmartElementOverlayWindowProviding, mouseMovedAt point: CGPoint)
  func smartElementOverlayWindow(_ window: SmartElementOverlayWindowProviding, mouseDownAt point: CGPoint)
  func smartElementOverlayWindowDidCancel(_ window: SmartElementOverlayWindowProviding)
}

protocol SmartElementWindowListSource {
  func copyOnScreenWindowInfo() -> [[String: Any]]
}
