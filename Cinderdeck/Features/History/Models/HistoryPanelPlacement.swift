import CoreGraphics

enum HistoryPanelPlacement {
  /// Preserve the dragged top-left corner when changing sections or expanding,
  /// while keeping the panel reachable inside the display's usable frame.
  static func resizedFrame(from frame: CGRect, to size: CGSize, visibleFrame: CGRect) -> CGRect {
    let x = min(max(frame.minX, visibleFrame.minX), max(visibleFrame.minX, visibleFrame.maxX - size.width))
    let y = min(max(frame.maxY - size.height, visibleFrame.minY), max(visibleFrame.minY, visibleFrame.maxY - size.height))
    return CGRect(origin: CGPoint(x: x, y: y), size: size)
  }
}
