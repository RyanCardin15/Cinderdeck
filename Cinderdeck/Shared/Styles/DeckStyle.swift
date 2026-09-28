import AppKit
import SwiftUI

/// The application chrome follows the execution map: quiet surfaces, precise
/// outlines, and color reserved for selection, actions, and runtime state.
enum DeckStyle {
  static let accent = adaptive(light: 0xB9410C, dark: 0xFF9054)
  static let success = adaptive(light: 0x16733D, dark: 0x66C88A)
  static let warning = adaptive(light: 0x946000, dark: 0xE9B75C)
  static let danger = adaptive(light: 0xBA3245, dark: 0xFF7585)
  static let canvas = adaptive(light: 0xF3F4F6, dark: 0x16191F)
  static let sidebar = adaptive(light: 0xECEEF1, dark: 0x12151A)
  static let surface = adaptive(light: 0xFFFFFF, dark: 0x20252D)
  static let inset = adaptive(light: 0xECEFF3, dark: 0x171B22)
  static let border = Color.primary.opacity(0.11)
  static let hover = Color.primary.opacity(0.055)
  static let title = Font.system(size: 23, weight: .semibold)
  static let section = Font.system(size: 15, weight: .semibold)
  static let body = Font.system(size: 13)
  static let caption = Font.system(size: 11)
  static let eyebrow = Font.system(size: 10, weight: .semibold, design: .monospaced)
  static let controlRadius: CGFloat = 8
  static let cardRadius: CGFloat = 12

  private static func adaptive(light: UInt32, dark: UInt32) -> Color {
    Color(nsColor: NSColor(name: nil) { appearance in
      let value = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
      return NSColor(srgbRed: CGFloat((value >> 16) & 255) / 255,
        green: CGFloat((value >> 8) & 255) / 255, blue: CGFloat(value & 255) / 255, alpha: 1)
    })
  }
}

struct DeckSurface: ViewModifier {
  var radius: CGFloat = DeckStyle.cardRadius
  var selected = false
  var tint: Color = DeckStyle.accent
  @Environment(\.colorSchemeContrast) private var contrast

  func body(content: Content) -> some View {
    content
      .background(DeckStyle.surface, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
      .overlay {
        RoundedRectangle(cornerRadius: radius, style: .continuous)
          .strokeBorder(selected ? tint : Color.primary.opacity(contrast == .increased ? 0.32 : 0.11),
            lineWidth: selected ? 1.5 : 1)
          .allowsHitTesting(false)
      }
  }
}

extension View {
  func deckSurface(radius: CGFloat = DeckStyle.cardRadius, selected: Bool = false, tint: Color = DeckStyle.accent) -> some View {
    modifier(DeckSurface(radius: radius, selected: selected, tint: tint))
  }
}

struct DeckSectionLabel: View {
  let title: String
  var body: some View {
    Text(title.uppercased()).font(DeckStyle.eyebrow).tracking(1.0).foregroundStyle(.secondary)
      .accessibilityAddTraits(.isHeader)
  }
}

struct DeckSheetHeader: View {
  let icon: String
  let title: String
  let detail: String

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      DeckFeatureIcon(systemName: icon, size: 40)
      VStack(alignment: .leading, spacing: 6) {
        Text(title).font(.system(size: 20, weight: .semibold)).accessibilityAddTraits(.isHeader)
        Text(detail).font(DeckStyle.body).foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
  }
}

struct DeckFeatureIcon: View {
  let systemName: String
  var size: CGFloat = 44
  var tint: Color = DeckStyle.accent
  var body: some View {
    Image(systemName: systemName)
      .font(.system(size: size * 0.43, weight: .medium))
      .foregroundStyle(tint).frame(width: size, height: size)
      .background(tint.opacity(0.10), in: RoundedRectangle(cornerRadius: size * 0.26, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: size * 0.26, style: .continuous).strokeBorder(tint.opacity(0.18)))
      .accessibilityHidden(true)
  }
}

struct DeckEmptyState<Actions: View>: View {
  let icon: String
  let title: String
  let detail: String
  var compact = false
  @ViewBuilder var actions: () -> Actions

  var body: some View {
    VStack(spacing: compact ? 10 : 16) {
      DeckFeatureIcon(systemName: icon, size: compact ? 36 : 52)
      VStack(spacing: 7) {
        Text(title).font(compact ? DeckStyle.section : .system(size: 20, weight: .semibold))
          .foregroundStyle(.primary).accessibilityAddTraits(.isHeader)
        Text(detail).font(compact ? DeckStyle.caption : DeckStyle.body)
          .foregroundStyle(.secondary).lineSpacing(3)
          .fixedSize(horizontal: false, vertical: true)
      }
      .multilineTextAlignment(.center).frame(maxWidth: 410)
      actions()
    }
    .padding(compact ? 16 : 28)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

extension DeckEmptyState where Actions == EmptyView {
  init(icon: String, title: String, detail: String, compact: Bool = false) {
    self.icon = icon; self.title = title; self.detail = detail; self.compact = compact
    actions = { EmptyView() }
  }
}

struct DeckSearchField: View {
  let placeholder: String
  @Binding var text: String
  @FocusState private var focused: Bool

  var body: some View {
    HStack(spacing: 8) {
      Image(systemName: "magnifyingglass").foregroundStyle(.secondary).accessibilityHidden(true)
      TextField(placeholder, text: $text).textFieldStyle(.plain).focused($focused)
        .accessibilityLabel(placeholder)
      if !text.isEmpty {
        Button { text = "" } label: {
          Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
        }.buttonStyle(.plain).help("Clear search").accessibilityLabel("Clear search")
      }
    }
    .font(.system(size: 12)).padding(.horizontal, 10).frame(minHeight: 32)
    .background(DeckStyle.inset, in: RoundedRectangle(cornerRadius: DeckStyle.controlRadius))
    .overlay(RoundedRectangle(cornerRadius: DeckStyle.controlRadius)
      .strokeBorder(focused ? DeckStyle.accent : DeckStyle.border, lineWidth: focused ? 1.5 : 1))
  }
}

struct DeckButtonStyle: ButtonStyle {
  var prominent = false
  var compact = false
  var tint: Color = DeckStyle.accent
  func makeBody(configuration: Configuration) -> some View {
    DeckButtonBody(label: configuration.label, pressed: configuration.isPressed,
      prominent: prominent, compact: compact, tint: tint)
  }
}

private struct DeckButtonBody<Label: View>: View {
  let label: Label
  let pressed: Bool
  let prominent: Bool
  let compact: Bool
  let tint: Color
  @Environment(\.isEnabled) private var enabled
  @State private var hovered = false

  var body: some View {
    label
      .font(.system(size: compact ? 11 : 12, weight: .semibold))
      .padding(.horizontal, compact ? 9 : 12).padding(.vertical, compact ? 5 : 7)
      .foregroundStyle(prominent ? tint : .primary)
      .background(prominent ? tint.opacity(pressed ? 0.12 : hovered ? 0.09 : 0.06)
        : pressed || hovered ? DeckStyle.hover : DeckStyle.surface,
        in: RoundedRectangle(cornerRadius: DeckStyle.controlRadius))
      .background(DeckStyle.surface, in: RoundedRectangle(cornerRadius: DeckStyle.controlRadius))
      .overlay(RoundedRectangle(cornerRadius: DeckStyle.controlRadius)
        .strokeBorder(prominent ? tint.opacity(0.35) : DeckStyle.border))
      .contentShape(RoundedRectangle(cornerRadius: DeckStyle.controlRadius))
      .opacity(enabled ? 1 : 0.42)
      .onHover { hovered = $0 }
  }
}
