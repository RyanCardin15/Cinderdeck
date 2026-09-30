import AppKit
import SwiftUI

struct HistoryPanelDragHandle: View {
  var height: CGFloat = 30

  var body: some View {
    Image(systemName: "line.3.horizontal")
      .font(.system(size: 12, weight: .medium))
      .foregroundStyle(.secondary.opacity(0.7))
      .frame(minWidth: 24, maxWidth: .infinity, minHeight: height, maxHeight: height)
      .overlay(HistoryPanelDragRegion())
      .help("Drag to move History")
      .accessibilityLabel("Move History window")
      .accessibilityIdentifier("history.moveWindow")
  }
}

private struct HistoryPanelDragRegion: NSViewRepresentable {
  func makeNSView(context: Context) -> DragView { DragView() }
  func updateNSView(_ nsView: DragView, context: Context) {}

  final class DragView: NSView {
    private var startPoint: NSPoint?
    private var startOrigin: NSPoint?
    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .openHand) }
    override func mouseDown(with event: NSEvent) {
      guard let panel = window as? HistoryFloatingPanel else { return }
      startPoint = panel.convertPoint(toScreen: event.locationInWindow)
      startOrigin = panel.frame.origin
      NSCursor.closedHand.set()
    }

    override func mouseDragged(with event: NSEvent) {
      guard let startPoint, let startOrigin, let panel = window as? HistoryFloatingPanel else { return }
      let point = panel.convertPoint(toScreen: event.locationInWindow)
      panel.setFrameOrigin(NSPoint(x: startOrigin.x + point.x - startPoint.x, y: startOrigin.y + point.y - startPoint.y))
      panel.onDidMoveByUser?(panel.frame)
    }

    override func mouseUp(with event: NSEvent) {
      if let panel = window as? HistoryFloatingPanel, let startOrigin, startOrigin != panel.frame.origin {
        DiagnosticLogger.shared.log(.debug, .history, "Floating history window moved", context: ["frame": NSStringFromRect(panel.frame)])
      }
      startPoint = nil
      startOrigin = nil
      NSCursor.openHand.set()
    }
  }
}
