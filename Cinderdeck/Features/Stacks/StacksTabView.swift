import SwiftUI

/// Whole cards share the available width; selection and paging always agree.
struct StackCompactPage {
  static let spacing: CGFloat = 12
  let capacity: Int
  let cardWidth: CGFloat
  let range: Range<Int>
  let hasMultiplePages: Bool
  var rangeLabel: String {
    range.count == 1 ? "\(range.upperBound)" : "\(range.lowerBound + 1)–\(range.upperBound)"
  }

  init(width: CGFloat, count: Int, selectedIndex: Int) {
    let available = max(0, width - 8)
    capacity = max(1, min(3, Int((available + Self.spacing) / (270 + Self.spacing))))
    cardWidth = (available - CGFloat(capacity - 1) * Self.spacing) / CGFloat(capacity)
    let selection = min(max(0, selectedIndex), max(0, count - 1))
    let start = selection / capacity * capacity
    range = start..<min(start + capacity, count)
    hasMultiplePages = count > capacity
  }
}

struct StackStatusDot: View {
  var phase: StackServicePhase?
  var label: String = "Stopped"
  var size: CGFloat = 8
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  private var text: String { phase?.label ?? label }
  private var color: Color { phase.map { StackPalette.color(phase: $0) } ?? StackPalette.color(label: label) }
  private var pulsing: Bool {
    guard !reduceMotion else { return false }
    if let phase { return phase == .starting || phase == .waiting || phase == .stopping }
    return label == "Starting" || label == "Stopping"
  }
  private var stopped: Bool { phase.map { $0 == .stopped } ?? (label == "Stopped") }
  var body: some View {
    TimelineView(.animation(minimumInterval: 0.5, paused: !pulsing)) { context in
      ZStack {
        if !stopped {
          Circle().fill(color.opacity(0.25)).frame(width: size + 5, height: size + 5)
        }
        if phase == .unhealthy || label == "Degraded" {
          Image(systemName: "exclamationmark.triangle.fill").font(.system(size: size)).foregroundColor(color)
        } else if stopped {
          Circle().strokeBorder(Color.secondary.opacity(0.7), lineWidth: 1.3).frame(width: size, height: size)
        } else {
          Circle().fill(color).frame(width: size, height: size)
        }
      }
      .opacity(pulsing ? (Int(context.date.timeIntervalSince1970 * 2) % 2 == 0 ? 0.45 : 1) : 1)
    }.frame(width: size + 6, height: size + 6).accessibilityLabel(text)
  }
}
