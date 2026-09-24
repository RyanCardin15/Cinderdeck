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
    // Lay out only what is visible; a console can hold tens of thousands of lines.
    text.layoutManager?.allowsNonContiguousLayout = true
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
    let ids = lines.map(\.id)
    guard ids != coordinator.ids || allServices != coordinator.allServices else { return }
    let oldOrigin = scroll.contentView.bounds.origin
    let selected = text.selectedRange()
    let storage = text.textStorage!
    storage.beginEditing()
    // Output normally changes by appending at the end and evicting old lines from
    // the ring (anywhere in a merged view). Apply just those edits; filtering or
    // clearing rebuilds. Reparsing thousands of lines on every tick of a full,
    // noisy buffer is what made busy consoles expensive.
    var start = 0
    if allServices == coordinator.allServices, let plan = Self.edits(from: coordinator.ids, to: ids) {
      for range in plan.removed.reversed() {
        let location = coordinator.offsets[range.lowerBound]
        storage.deleteCharacters(in: NSRange(location: location, length: coordinator.offsets[range.upperBound] - location))
      }
      var kept: [Int] = [], offset = 0, removed = plan.removed.makeIterator(), nextRemoved = removed.next()
      kept.reserveCapacity(ids.count + 1)
      for index in coordinator.ids.indices {
        if let range = nextRemoved, range.contains(index) {
          if index == range.upperBound - 1 { nextRemoved = removed.next() }
          continue
        }
        kept.append(offset)
        offset += coordinator.offsets[index + 1] - coordinator.offsets[index]
      }
      kept.append(offset)
      coordinator.offsets = kept
      start = plan.kept
    } else {
      storage.setAttributedString(NSAttributedString()); coordinator.styles = [:]; coordinator.offsets = [0]
    }
    for line in lines.dropFirst(start) {
      if allServices {
        let color = Self.palette[StackPalette.serviceIndex(line.service, in: serviceOrder)]
        storage.append(NSAttributedString(string: "\(line.service) ", attributes: [.font: Self.serviceFont, .foregroundColor: color]))
        storage.append(NSAttributedString(string: "│ ", attributes: [.font: Self.regularFont, .foregroundColor: Self.separator]))
      }
      var parser = coordinator.styles[line.service] ?? .init()
      for run in parser.parse(line.text) {
        let color = run.style.foreground.map(Self.color) ?? Self.foreground
        storage.append(NSAttributedString(string: run.text, attributes: [
          .font: run.style.bold ? Self.boldFont : Self.regularFont,
          .foregroundColor: run.style.dim ? color.withAlphaComponent(0.55) : color,
        ]))
      }
      coordinator.styles[line.service] = parser
      storage.append(NSAttributedString(string: "\n"))
      coordinator.offsets.append(storage.length)
    }
    storage.endEditing()
    coordinator.ids = ids; coordinator.allServices = allServices
    if autoScroll { text.scrollToEndOfDocument(nil) }
    else {
      if selected.location + selected.length <= storage.length { text.setSelectedRange(selected) }
      scroll.contentView.scroll(to: oldOrigin); scroll.reflectScrolledClipView(scroll.contentView)
    }
  }
  /// The lines to delete from `old` (as index ranges) and how many of `new` are
  /// already on screen, when `new` is `old` minus some lines plus lines at the end.
  /// nil when most lines changed and a rebuild is cheaper.
  static func edits(from old: [UUID], to new: [UUID]) -> (removed: [Range<Int>], kept: Int)? {
    var removed: [Range<Int>] = [], i = 0, j = 0, removedCount = 0
    while i < old.count {
      if j < new.count, old[i] == new[j] { i += 1; j += 1; continue }
      if let last = removed.last, last.upperBound == i { removed[removed.count - 1] = last.lowerBound..<(i + 1) }
      else { removed.append(i..<(i + 1)) }
      removedCount += 1; i += 1
    }
    guard old.isEmpty || removedCount * 2 <= old.count else { return nil }
    return (removed, j)
  }
  static let serviceFont = NSFont.monospacedSystemFont(ofSize: 11, weight: .semibold)
  static let regularFont = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
  static let boldFont = NSFont.monospacedSystemFont(ofSize: 11, weight: .bold)
  static let separator = NSColor(white: 1, alpha: 0.18)
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
    /// Character offset where each line starts, plus the end: offsets[i]..<offsets[i + 1] is line i.
    var offsets: [Int] = [0]
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
