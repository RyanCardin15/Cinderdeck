import AppKit
import Foundation
import QuartzCore

/// Draws one cursor per agent above all windows. It is click-through, never
/// activates, and is separate from the system pointer, which stays put.
@MainActor final class CursorOverlay {
  static let shared = CursorOverlay()
  private var cursors: [String: CursorPanel] = [:]
  private let enabled = ProcessInfo.processInfo.environment["CINDERDECK_COMPUTER_USE_CURSOR"] != "0"

  nonisolated func move(agent: Agent, to point: CGPoint, click: Bool) async {
    await present(agent: agent, to: point, click: click)
  }

  nonisolated func hide(_ id: String) async {
    await dismiss(id)
  }

  private func present(agent: Agent, to point: CGPoint, click: Bool) async {
    guard enabled else { return }
    let panel = cursors[agent.id] ?? CursorPanel(agent: agent)
    cursors[agent.id] = panel
    panel.glide(to: point, click: click)
  }

  private func dismiss(_ id: String) {
    cursors.removeValue(forKey: id)?.orderOut(nil)
  }
}

@MainActor final class CursorPanel: NSPanel {
  private static let size = NSSize(width: 180, height: 48)
  private static let tip = NSPoint(x: 6, y: 42)
  private let cursor: CursorView
  private var hideTimer: Timer?
  private var placed = false

  init(agent: Agent) {
    cursor = CursorView(frame: NSRect(origin: .zero, size: Self.size), agent: agent)
    super.init(
      contentRect: NSRect(origin: .zero, size: Self.size),
      styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    isOpaque = false
    backgroundColor = .clear
    hasShadow = false
    ignoresMouseEvents = true
    isFloatingPanel = true
    hidesOnDeactivate = false
    level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.overlayWindow)))
    collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
    contentView = cursor
  }

  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }

  /// Converts a global top-left screen point to this panel's AppKit origin.
  private func origin(for point: CGPoint) -> NSPoint {
    let primaryHeight = NSScreen.screens.first?.frame.maxY ?? 0
    return NSPoint(x: point.x - Self.tip.x, y: primaryHeight - point.y - Self.tip.y)
  }

  func glide(to point: CGPoint, click: Bool) {
    hideTimer?.invalidate()
    let target = origin(for: point)
    alphaValue = 1
    if !placed || !isVisible {
      setFrameOrigin(target)
      orderFrontRegardless()
      placed = true
    } else {
      // Cursor decoration must not add 160 ms to every app action.
      NSAnimationContext.runAnimationGroup { context in
        context.duration = 0.16
        context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        animator().setFrameOrigin(target)
      }
    }
    if click { cursor.pulse() }
    hideTimer = Timer.scheduledTimer(withTimeInterval: 6, repeats: false) { [weak self] _ in
      Task { @MainActor in
        NSAnimationContext.runAnimationGroup { context in
          context.duration = 0.4
          self?.animator().alphaValue = 0
        }
      }
    }
  }
}

final class CursorView: NSView {
  private let color: NSColor
  private let label: String
  private let ring = CAShapeLayer()

  init(frame: NSRect, agent: Agent) {
    // A stable hue per agent tells parallel agents' cursors apart.
    var hash: UInt32 = 2_166_136_261
    for byte in agent.id.utf8 { hash = (hash ^ UInt32(byte)) &* 16_777_619 }
    color = NSColor(
      calibratedHue: CGFloat(hash % 360) / 360, saturation: 0.72, brightness: 0.92, alpha: 1)
    label = agent.label
    super.init(frame: frame)
    wantsLayer = true
    ring.fillColor = NSColor.clear.cgColor
    ring.strokeColor = color.cgColor
    ring.lineWidth = 2
    ring.opacity = 0
    ring.path = CGPath(ellipseIn: CGRect(x: -10, y: -10, width: 20, height: 20), transform: nil)
    ring.position = CGPoint(x: 6, y: 42)
    layer?.addSublayer(ring)
  }

  required init?(coder: NSCoder) { nil }

  override func draw(_ dirtyRect: NSRect) {
    let tip = NSPoint(x: 6, y: 42)
    let arrow = NSBezierPath()
    arrow.move(to: tip)
    arrow.line(to: NSPoint(x: tip.x, y: tip.y - 22))
    arrow.line(to: NSPoint(x: tip.x + 6, y: tip.y - 17))
    arrow.line(to: NSPoint(x: tip.x + 10, y: tip.y - 26))
    arrow.line(to: NSPoint(x: tip.x + 14, y: tip.y - 24))
    arrow.line(to: NSPoint(x: tip.x + 10, y: tip.y - 15))
    arrow.line(to: NSPoint(x: tip.x + 17, y: tip.y - 15))
    arrow.close()
    NSGraphicsContext.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowBlurRadius = 3
    shadow.shadowOffset = NSSize(width: 0, height: -1)
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.35)
    shadow.set()
    color.setFill()
    arrow.fill()
    NSGraphicsContext.restoreGraphicsState()
    NSColor.white.setStroke()
    arrow.lineWidth = 1.5
    arrow.stroke()

    let text = NSAttributedString(
      string: label,
      attributes: [
        .font: NSFont.systemFont(ofSize: 11, weight: .semibold), .foregroundColor: NSColor.white,
      ])
    let textSize = text.size()
    let pill = NSRect(x: 22, y: 2, width: min(textSize.width + 12, bounds.width - 24), height: 18)
    color.setFill()
    NSBezierPath(roundedRect: pill, xRadius: 9, yRadius: 9).fill()
    text.draw(
      with: NSRect(x: pill.minX + 6, y: pill.minY + 3, width: pill.width - 12, height: 14),
      options: [.truncatesLastVisibleLine, .usesLineFragmentOrigin])
  }

  func pulse() {
    let scale = CABasicAnimation(keyPath: "transform.scale")
    scale.fromValue = 0.4
    scale.toValue = 1.6
    let fade = CABasicAnimation(keyPath: "opacity")
    fade.fromValue = 0.9
    fade.toValue = 0
    let group = CAAnimationGroup()
    group.animations = [scale, fade]
    group.duration = 0.35
    ring.add(group, forKey: "pulse")
  }
}
