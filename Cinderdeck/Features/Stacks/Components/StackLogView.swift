import AppKit
import SwiftUI

struct StackLogView: NSViewRepresentable {
  let lines: [StackLogLine]
  let allServices: Bool
  var serviceOrder: [String] = []
  let autoScroll: Bool
  let focusRequest: Int
  let onFocus: () -> Void
  var accessibilityTitle = "Service logs"
  var accessibilityID = "stacks.logs"

  func makeCoordinator() -> Coordinator { Coordinator() }
  func makeNSView(context: Context) -> NSScrollView {
    let scroll = NSScrollView()
    scroll.hasVerticalScroller = true; scroll.hasHorizontalScroller = false
    scroll.borderType = .noBorder
    scroll.drawsBackground = true; scroll.backgroundColor = Self.background
    scroll.scrollerStyle = .overlay
    let text = StackLogTextView()
    text.isEditable = false; text.isSelectable = true; text.isRichText = true
    text.isAutomaticLinkDetectionEnabled = false
    text.backgroundColor = Self.background
    text.insertionPointColor = .white
    text.selectedTextAttributes = [.backgroundColor: NSColor.systemBlue.withAlphaComponent(0.35)]
    text.textContainerInset = NSSize(width: 12, height: 10)
    text.autoresizingMask = [.width]; text.isVerticallyResizable = true
    text.isHorizontallyResizable = false
    text.textContainer?.widthTracksTextView = true
    text.setAccessibilityLabel(accessibilityTitle)
    text.setAccessibilityIdentifier(accessibilityID)
    scroll.documentView = text
    context.coordinator.text = text
    return scroll
  }
  func updateNSView(_ scroll: NSScrollView, context: Context) {
    guard let text = scroll.documentView as? StackLogTextView else { return }
    text.onFocus = onFocus
    let coordinator = context.coordinator
    if coordinator.focusRequest != focusRequest {
      coordinator.focusRequest = focusRequest
      if focusRequest > 0 { text.window?.makeFirstResponder(text) }
    }
    guard lines.map(\.id) != coordinator.ids || allServices != coordinator.allServices else { return }
    let oldOrigin = scroll.contentView.bounds.origin
    let selected = text.selectedRange()
    let storage = text.textStorage!
    storage.beginEditing()
    // Append only the new suffix. Filtering, clearing or ring eviction rebuilds
    // bounded text; ordinary noisy output doesn't reparse the existing console.
    let appends = allServices == coordinator.allServices && lines.count >= coordinator.ids.count && Array(lines.prefix(coordinator.ids.count).map(\.id)) == coordinator.ids
    let start: Int
    if appends { start = coordinator.ids.count }
    else { storage.setAttributedString(NSAttributedString()); coordinator.styles = [:]; start = 0 }
    for line in lines.dropFirst(start) {
      if allServices {
        let color = Self.palette[StackPalette.serviceIndex(line.service, in: serviceOrder)]
        storage.append(NSAttributedString(string: "\(line.service) ", attributes: [.font: NSFont.monospacedSystemFont(ofSize: 11, weight: .semibold), .foregroundColor: color]))
        storage.append(NSAttributedString(string: "│ ", attributes: [.font: NSFont.monospacedSystemFont(ofSize: 11, weight: .regular), .foregroundColor: NSColor(white: 1, alpha: 0.18)]))
      }
      var parser = coordinator.styles[line.service] ?? .init()
      for run in parser.parse(line.text) {
        let color = run.style.foreground.map(Self.color) ?? Self.foreground
        storage.append(NSAttributedString(string: run.text, attributes: [
          .font: NSFont.monospacedSystemFont(ofSize: 11, weight: run.style.bold ? .bold : .regular),
          .foregroundColor: run.style.dim ? color.withAlphaComponent(0.55) : color,
        ]))
      }
      coordinator.styles[line.service] = parser
      storage.append(NSAttributedString(string: "\n"))
    }
    storage.endEditing()
    coordinator.ids = lines.map(\.id); coordinator.allServices = allServices
    if autoScroll { text.scrollToEndOfDocument(nil) }
    else {
      if selected.location + selected.length <= storage.length { text.setSelectedRange(selected) }
      scroll.contentView.scroll(to: oldOrigin); scroll.reflectScrolledClipView(scroll.contentView)
    }
  }
  static let background = NSColor(srgbRed: 0.07, green: 0.075, blue: 0.09, alpha: 1)
  static let foreground = NSColor(white: 0.86, alpha: 1)
  static let palette: [NSColor] = StackPalette.services.map { NSColor($0) }
  static func color(_ index: Int) -> NSColor {
    let basic: [NSColor] = [NSColor(white: 0.45, alpha: 1), .systemRed, .systemGreen, .systemYellow, .systemBlue, .systemPurple, .systemCyan, .lightGray,
      NSColor(white: 0.55, alpha: 1), .systemRed, .systemGreen, .systemYellow, .systemBlue, .systemPurple, .systemCyan, .white]
    if index < 16 { return basic[max(0, index)] }
    if index >= 232 { let value = CGFloat(8 + (index - 232) * 10) / 255; return NSColor(white: value, alpha: 1) }
    let value = index - 16
    let component: (Int) -> CGFloat = { $0 == 0 ? 0 : CGFloat(55 + $0 * 40) / 255 }
    return NSColor(srgbRed: component(value / 36), green: component(value / 6 % 6), blue: component(value % 6), alpha: 1)
  }
  final class Coordinator {
    weak var text: NSTextView?
    var ids: [UUID] = []
    var styles: [String: AnsiParser.State] = [:]
    var allServices = true
    var focusRequest = 0
  }
}

private final class StackLogTextView: NSTextView {
  var onFocus: (() -> Void)?
  override func becomeFirstResponder() -> Bool {
    let result = super.becomeFirstResponder()
    if result { onFocus?() }
    return result
  }
}
