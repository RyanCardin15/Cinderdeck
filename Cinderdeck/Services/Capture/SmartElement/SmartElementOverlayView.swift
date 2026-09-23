//
//  SmartElementOverlayView.swift
//  Cinderdeck
//
//  Live smart-element punch-out overlay.
//

import AppKit
import Carbon.HIToolbox
import QuartzCore

@MainActor
protocol SmartElementOverlayViewDelegate: AnyObject {
  func smartElementOverlayView(_ view: SmartElementOverlayView, mouseMovedAt point: CGPoint)
  func smartElementOverlayView(_ view: SmartElementOverlayView, mouseDownAt point: CGPoint)
  func smartElementOverlayViewDidCancel(_ view: SmartElementOverlayView)
}

final class SmartElementOverlayView: NSView {
  weak var delegate: SmartElementOverlayViewDelegate?
  private(set) var currentHighlightRect: CGRect?

  private var dimLayer: CALayer!
  private let dimMaskLayer = CAShapeLayer()
  private var borderLayer: CAShapeLayer!

  private var disabledActions: [String: CAAction] {
    [
      "bounds": NSNull(),
      "frame": NSNull(),
      "hidden": NSNull(),
      "path": NSNull(),
      "position": NSNull(),
    ]
  }

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    configure()
  }

  required init?(coder: NSCoder) {
    super.init(coder: coder)
    configure()
  }

  override var acceptsFirstResponder: Bool { true }

  override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
    true
  }

  override func resetCursorRects() {
    super.resetCursorRects()
    addCursorRect(bounds, cursor: NSCursor.applicationWindowCursor)
  }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    trackingAreas.forEach(removeTrackingArea)
    addTrackingArea(
      NSTrackingArea(
        rect: bounds,
        options: [.activeAlways, .mouseMoved, .mouseEnteredAndExited, .inVisibleRect, .cursorUpdate],
        owner: self,
        userInfo: nil
      )
    )
  }

  override func cursorUpdate(with event: NSEvent) {
    NSCursor.applicationWindowCursor.set()
  }

  override func mouseEntered(with event: NSEvent) {
    NSCursor.applicationWindowCursor.set()
  }

  override func mouseExited(with event: NSEvent) {
    NSCursor.arrow.set()
  }

  override func layout() {
    super.layout()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    dimLayer.frame = bounds
    rebuildHighlight()
    CATransaction.commit()
  }

  override func mouseMoved(with event: NSEvent) {
    delegate?.smartElementOverlayView(self, mouseMovedAt: screenPoint(for: event))
  }

  override func mouseDown(with event: NSEvent) {
    delegate?.smartElementOverlayView(self, mouseDownAt: screenPoint(for: event))
  }

  override func keyDown(with event: NSEvent) {
    if event.keyCode == UInt16(kVK_Escape) {
      delegate?.smartElementOverlayViewDidCancel(self)
      return
    }
    super.keyDown(with: event)
  }

  override func cancelOperation(_ sender: Any?) {
    delegate?.smartElementOverlayViewDidCancel(self)
  }

  func updateHighlight(_ screenRect: CGRect?) {
    currentHighlightRect = screenRect
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    rebuildHighlight()
    CATransaction.commit()
  }

  func updateBounds(_ screenFrame: CGRect) {
    frame = CGRect(origin: .zero, size: screenFrame.size)
    updateTrackingAreas()
    needsLayout = true
  }

  private func configure() {
    wantsLayer = true
    setAccessibilityElement(false)
    setAccessibilityHidden(true)
    setAccessibilityRole(.unknown)
    setupLayers()
    updateTrackingAreas()
  }

  private func setupLayers() {
    guard let rootLayer = layer else { return }
    CATransaction.begin()
    CATransaction.setDisableActions(true)

    dimLayer = CALayer()
    dimLayer.frame = bounds
    dimLayer.backgroundColor = NSColor.black.withAlphaComponent(0.40).cgColor
    dimLayer.actions = disabledActions
    rootLayer.addSublayer(dimLayer)

    dimMaskLayer.fillRule = .evenOdd
    dimMaskLayer.actions = disabledActions

    borderLayer = CAShapeLayer()
    borderLayer.fillColor = nil
    borderLayer.strokeColor = NSColor.white.cgColor
    borderLayer.lineWidth = 2
    borderLayer.actions = disabledActions
    borderLayer.isHidden = true
    rootLayer.addSublayer(borderLayer)

    CATransaction.commit()
  }

  private func rebuildHighlight() {
    guard let localRect = localHighlightRect else {
      dimLayer.mask = nil
      borderLayer.path = nil
      borderLayer.isHidden = true
      return
    }

    let path = CGMutablePath()
    path.addRect(bounds)
    path.addRect(localRect)
    dimMaskLayer.path = path
    if dimLayer.mask !== dimMaskLayer {
      dimLayer.mask = dimMaskLayer
    }

    borderLayer.path = CGPath(rect: localRect, transform: nil)
    borderLayer.isHidden = false
  }

  private var localHighlightRect: CGRect? {
    guard let currentHighlightRect, let window else { return nil }
    let rect = currentHighlightRect
      .offsetBy(dx: -window.frame.minX, dy: -window.frame.minY)
      .intersection(bounds)
      .integral
    guard !rect.isNull, !rect.isEmpty else { return nil }
    return rect
  }

  private func screenPoint(for event: NSEvent) -> CGPoint {
    guard let window else {
      return convert(event.locationInWindow, to: nil)
    }
    return window.convertPoint(toScreen: event.locationInWindow)
  }
}
