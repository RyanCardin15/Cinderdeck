import SwiftUI

/// Shared visual language for Stacks, matched to the history panel's glass chrome.
enum StackPalette {
  static func color(phase: StackServicePhase?) -> Color {
    switch phase {
    case .ready: return Color(red: 0.2, green: 0.78, blue: 0.45)
    case .starting, .waiting, .stopping: return Color(red: 0.98, green: 0.72, blue: 0.2)
    case .unhealthy: return .orange
    case .crashed: return Color(red: 0.95, green: 0.3, blue: 0.3)
    default: return .secondary
    }
  }
  static func color(label: String) -> Color {
    switch label.lowercased() {
    case "running", "ready": return color(phase: .ready)
    case "starting", "stopping", "waiting": return color(phase: .starting)
    case "degraded", "unhealthy": return color(phase: .unhealthy)
    case "crashed": return color(phase: .crashed)
    default: return .secondary
    }
  }
  static let agent = Color(red: 0.62, green: 0.45, blue: 0.98)
  static let branch = Color(red: 0.3, green: 0.62, blue: 0.98)
  /// Stable per-service accent used for log prefixes and service chips.
  static let services: [Color] = [
    Color(red: 0.36, green: 0.62, blue: 1.0), Color(red: 0.3, green: 0.8, blue: 0.55), Color(red: 1.0, green: 0.62, blue: 0.3),
    Color(red: 0.72, green: 0.52, blue: 1.0), Color(red: 0.3, green: 0.78, blue: 0.82), Color(red: 1.0, green: 0.45, blue: 0.62),
  ]
  /// Position in the stack when known, so neighbouring services never share a color.
  static func serviceIndex(_ name: String, in order: [String] = []) -> Int {
    if let index = order.firstIndex(of: name) { return index % services.count }
    return name.utf8.reduce(0) { $0 + Int($1) } % services.count
  }
  static func service(_ name: String, in order: [String] = []) -> Color { services[serviceIndex(name, in: order)] }
}

struct StackSurface: ViewModifier {
  var cornerRadius: CGFloat = 14
  var selected = false
  var tint: Color? = nil
  @Environment(\.colorScheme) private var colorScheme
  func body(content: Content) -> some View {
    content
      .background(
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
          .fill(colorScheme == .dark ? Color.white.opacity(0.06) : Color.white.opacity(0.62))
      )
      .background(
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
          .fill((tint ?? .clear).opacity(colorScheme == .dark ? 0.08 : 0.06))
      )
      .overlay(
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
          .strokeBorder(selected ? Color.accentColor.opacity(0.75) : (colorScheme == .dark ? Color.white.opacity(0.09) : Color.black.opacity(0.06)),
            lineWidth: selected ? 1.5 : 1)
      )
      .shadow(color: Color.black.opacity(colorScheme == .dark ? 0.16 : 0.05), radius: 6, x: 0, y: 2)
  }
}

extension View {
  func stackSurface(cornerRadius: CGFloat = 14, selected: Bool = false, tint: Color? = nil) -> some View {
    modifier(StackSurface(cornerRadius: cornerRadius, selected: selected, tint: tint))
  }
}

/// Capsule action button: `.primary(color)` is filled, `.secondary` is glass.
struct StackPillButtonStyle: ButtonStyle {
  enum Kind { case primary(Color), secondary, destructive }
  var kind: Kind = .secondary
  var compact = false
  @Environment(\.isEnabled) private var isEnabled
  @Environment(\.colorScheme) private var colorScheme
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: compact ? 10.5 : 11.5, weight: .semibold))
      .labelStyle(StackTightLabelStyle())
      .lineLimit(1)
      .padding(.horizontal, compact ? 9 : 12)
      .padding(.vertical, compact ? 4.5 : 6)
      .foregroundColor(foreground)
      .background(background, in: Capsule())
      .overlay(Capsule().strokeBorder(border, lineWidth: 1))
      .opacity(isEnabled ? (configuration.isPressed ? 0.75 : 1) : 0.45)
      .scaleEffect(configuration.isPressed ? 0.97 : 1)
      .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
  }
  private var foreground: Color {
    switch kind {
    case .primary: return .white
    case .secondary: return .primary.opacity(0.85)
    case .destructive: return StackPalette.color(phase: .crashed)
    }
  }
  private var background: AnyShapeStyle {
    switch kind {
    case .primary(let color): return AnyShapeStyle(LinearGradient(colors: [color.opacity(0.95), color.opacity(0.8)], startPoint: .top, endPoint: .bottom))
    case .secondary: return AnyShapeStyle(colorScheme == .dark ? Color.white.opacity(0.09) : Color.white.opacity(0.8))
    case .destructive: return AnyShapeStyle(StackPalette.color(phase: .crashed).opacity(0.12))
    }
  }
  private var border: Color {
    switch kind {
    case .primary: return Color.white.opacity(0.14)
    case .secondary: return colorScheme == .dark ? Color.white.opacity(0.1) : Color.black.opacity(0.07)
    case .destructive: return StackPalette.color(phase: .crashed).opacity(0.25)
    }
  }
}

struct StackTightLabelStyle: LabelStyle {
  func makeBody(configuration: Configuration) -> some View {
    HStack(spacing: 5) { configuration.icon.font(.system(size: 9.5, weight: .bold)); configuration.title }
  }
}

/// Small circular icon button with a hover highlight.
struct StackIconButton: View {
  let systemName: String
  let help: String
  var tint: Color? = nil
  var size: CGFloat = 24
  let action: () -> Void
  @State private var hovering = false
  @Environment(\.isEnabled) private var isEnabled
  @Environment(\.colorScheme) private var colorScheme
  var body: some View {
    Button(action: action) {
      Image(systemName: systemName)
        .font(.system(size: size * 0.42, weight: .semibold))
        .foregroundColor(tint ?? .primary.opacity(0.8))
        .frame(width: size, height: size)
        .background(Circle().fill(hovering && isEnabled ? (colorScheme == .dark ? Color.white.opacity(0.12) : Color.black.opacity(0.07)) : Color.clear))
        .contentShape(Circle())
    }
    .buttonStyle(.plain)
    .opacity(isEnabled ? 1 : 0.35)
    .onHover { hovering = $0 }
    .help(help)
    .accessibilityLabel(help)
  }
}

/// Tinted capsule label: ports, branches, owners, counts.
struct StackChip: View {
  var systemImage: String? = nil
  let text: String
  var tint: Color = .secondary
  var monospaced = false
  private var neutral: Bool { tint == .secondary }
  var body: some View {
    HStack(spacing: 4) {
      if let systemImage { Image(systemName: systemImage).font(.system(size: 8.5, weight: .bold)).foregroundColor(neutral ? .secondary : tint) }
      Text(text).font(monospaced ? .system(size: 10, weight: .semibold, design: .monospaced) : .system(size: 10, weight: .semibold))
        .foregroundColor(neutral ? .secondary : .primary.opacity(0.9))
        .lineLimit(1).truncationMode(.middle)
    }
    .padding(.horizontal, 7).padding(.vertical, 3)
    .background(tint.opacity(neutral ? 0.1 : 0.2), in: Capsule())
    .overlay(Capsule().strokeBorder(tint.opacity(neutral ? 0 : 0.3), lineWidth: 0.5))
  }
}

struct StackStateBadge: View {
  let label: String
  var since: Date? = nil
  var body: some View {
    HStack(spacing: 5) {
      StackStatusDot(label: label)
      Text(label).font(.system(size: 10.5, weight: .semibold))
      if let since { Text(since, style: .relative).font(.system(size: 10.5, weight: .medium)).foregroundColor(.primary.opacity(0.6)).lineLimit(1) }
    }
    .foregroundColor(label == "Stopped" ? .secondary : StackPalette.color(label: label))
    .padding(.horizontal, 8).padding(.vertical, 3.5)
    .background(StackPalette.color(label: label).opacity(label == "Stopped" ? 0.08 : 0.13), in: Capsule())
    .fixedSize()
  }
}

/// Shows which agent started a service. Nothing is shown for services you started.
struct StackOwnerBadge: View {
  let owner: StackActor?
  var compact = false
  static func help(_ owner: StackActor) -> String {
    var text = "Started by \(owner.label)"
    if let tty = owner.tty { text += " on \(tty)" }
    if let cwd = owner.cwd { text += "\n\(cwd)" }
    return text
  }
  var body: some View {
    if let owner, owner.isAgent {
      StackChip(systemImage: "sparkles", text: compact ? owner.name : owner.label, tint: StackPalette.agent)
        .help(Self.help(owner))
    }
  }
}

struct StackClaimChip: View {
  let claim: StackClaim
  var onRelease: (() -> Void)? = nil
  var body: some View {
    HStack(spacing: 5) {
      Image(systemName: "lock.fill").font(.system(size: 8.5, weight: .bold))
      Text(claim.holder.name).font(.system(size: 10, weight: .semibold))
      if let note = claim.note, !note.isEmpty { Text("· \(note)").font(.system(size: 10)).lineLimit(1).truncationMode(.tail) }
      if let onRelease {
        Button(action: onRelease) { Image(systemName: "xmark").font(.system(size: 7.5, weight: .bold)) }
          .buttonStyle(.plain).help("Release this claim").accessibilityLabel("Release claim")
      }
    }
    .foregroundColor(StackPalette.agent)
    .padding(.horizontal, 8).padding(.vertical, 3.5)
    .background(StackPalette.agent.opacity(0.13), in: Capsule())
    .help(helpText)
  }
  private var helpText: String {
    let note: String = claim.note.map { ": " + $0 } ?? ""
    let expiry: String = DateFormatter.localizedString(from: claim.expiresAt, dateStyle: .none, timeStyle: .short)
    return "\(claim.holder.label) claimed this stack\(note). Other agents must ask before changing it. Expires \(expiry)."
  }
}
