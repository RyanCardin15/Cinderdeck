import AppKit
import SwiftUI

struct WorkspaceMapScrollRequest {
  var id = UUID()
  let node: WorkspaceLaneGraph.ID
}

/// ScrollViewReader treats an absolutely positioned node as its entire canvas.
/// Convert its actual center through the hosting view instead, after layout.
struct WorkspaceMapScrollTarget: NSViewRepresentable {
  let request: WorkspaceMapScrollRequest?
  let frame: CGRect?
  let zoom: CGFloat
  class Anchor: NSView {
    override var isFlipped: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    var lastRequest: UUID?
    var lastPoint: CGPoint?
  }
  func makeNSView(context: Context) -> Anchor { Anchor() }
  func updateNSView(_ view: Anchor, context: Context) {
    guard let request, let frame else { return }
    let point = CGPoint(x: frame.midX * zoom, y: frame.midY * zoom)
    guard view.lastRequest != request.id || view.lastPoint != point else { return }
    view.lastRequest = request.id; view.lastPoint = point
    DispatchQueue.main.async { [weak view] in
      guard let view, view.lastRequest == request.id, let scroll = view.enclosingScrollView,
        let document = scroll.documentView else { return }
      scroll.window?.contentView?.layoutSubtreeIfNeeded()
      let center = view.convert(point, to: document)
      let clip = scroll.contentView
      let bounds = CGRect(x: center.x - clip.bounds.width / 2, y: center.y - clip.bounds.height / 2,
        width: clip.bounds.width, height: clip.bounds.height)
      clip.scroll(to: clip.constrainBoundsRect(bounds).origin)
      scroll.reflectScrolledClipView(clip)
    }
  }
}
