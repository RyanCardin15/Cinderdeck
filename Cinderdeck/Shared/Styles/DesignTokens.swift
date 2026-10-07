//
//  DesignTokens.swift
//  Cinderdeck
//
//  Centralized design tokens for consistent UI across the app.
//  Based on 8pt grid system.
//

import SwiftUI

// MARK: - Spacing (8pt Grid)

enum Spacing {
  static let xs: CGFloat = 4    // Tight spacing (icons, compact lists)
  static let sm: CGFloat = 8    // Standard gap
  static let md: CGFloat = 16   // Section padding
  static let lg: CGFloat = 24   // Large gaps
  static let xl: CGFloat = 32   // Major sections
}

// MARK: - Sizing

enum Size {
  // Corner radii
  static let radiusXs: CGFloat = 4
  static let radiusSm: CGFloat = 6
  static let radiusMd: CGFloat = 8
  static let radiusLg: CGFloat = 12

  // Strokes
  static let strokeDefault: CGFloat = 1
  static let strokeSelected: CGFloat = 2
}

// MARK: - Typography

enum Typography {
  static let labelSmall: Font = .system(size: 11)
  static let labelMedium: Font = .system(size: 11, weight: .medium)
  static let sectionHeader: Font = .system(size: 12, weight: .semibold)
  static let body: Font = .system(size: 12)
}

// MARK: - Toolbar Item Style

struct ToolbarButton: View {
  let icon: String
  var selectedIcon: String? = nil
  let isSelected: Bool
  var highlightColor: Color = .primary
  var selectedForegroundColor: Color? = nil
  var selectedBadgeIcon: String? = nil

  let action: () -> Void

  @State private var isHovering = false

  var body: some View {
    Button(action: action) {
      Image(systemName: displayedIcon)
        .font(.system(size: 14, weight: .medium))
        .foregroundColor(foregroundColor)
        .frame(width: 30, height: 30)
        .background(
          RoundedRectangle(cornerRadius: 6)
            .fill(backgroundColor)
        )
        .contentShape(RoundedRectangle(cornerRadius: 6))
        .overlay(alignment: .topTrailing) {
          if let selectedBadgeIcon, isSelected {
            Image(systemName: selectedBadgeIcon)
              .font(.system(size: 7, weight: .bold))
              .foregroundColor(highlightColor)
              .frame(width: 12, height: 12)
              .background(Circle().fill(DeckStyle.surface))
              .offset(x: 3, y: -3)
          }
        }
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(isSelected ? .isSelected : [])
    .onHover { isHovering = $0 }
  }

  private var backgroundColor: Color {
    if isSelected {
      return highlightColor.opacity(0.15)
    } else if isHovering {
      return Color.primary.opacity(0.1)
    }
    return Color.clear
  }

  private var displayedIcon: String {
    if isSelected {
      return selectedIcon ?? icon
    }
    return icon
  }

  private var foregroundColor: Color {
    if isSelected {
      return selectedForegroundColor ?? highlightColor
    }
    return .primary
  }
}

struct ToolbarDivider: View {
  var body: some View {
    Rectangle()
      .fill(Color(nsColor: .separatorColor))
      .frame(width: 1, height: 20)
      .padding(.horizontal, 4)
  }
}

// MARK: - Colors (Semantic)

enum SidebarColors {
  // Backgrounds
  static let itemDefault = Color.primary.opacity(0.05)
  static let itemHover = Color.primary.opacity(0.10)
  static let itemSelected = Color.accentColor.opacity(0.15)

  // Borders
  static let borderHover = Color.secondary.opacity(0.5)
  static let borderSelected = Color.accentColor

  // Text
  static let labelPrimary = Color.primary
  static let labelSecondary = Color.secondary

  // Actions
  static let actionButton = Color.primary.opacity(0.08)
  static let actionButtonHover = Color.primary.opacity(0.15)
}

// MARK: - Grid Configuration

enum GridConfig {
  static let backgroundColumns = 6
  static let colorColumns = 8
  static let gap = Spacing.sm
}

// MARK: - Sidebar Item Style Modifier

struct SidebarItemStyle: ViewModifier {
  let isSelected: Bool
  let cornerRadius: CGFloat

  @State private var isHovering = false

  init(isSelected: Bool, cornerRadius: CGFloat = Size.radiusMd) {
    self.isSelected = isSelected
    self.cornerRadius = cornerRadius
  }

  func body(content: Content) -> some View {
    content
      .aspectRatio(1, contentMode: .fit)
      .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
      .overlay(
        RoundedRectangle(cornerRadius: cornerRadius)
          .fill(isHovering && !isSelected ? SidebarColors.itemHover.opacity(0.35) : Color.clear)
      )
      .overlay(
        RoundedRectangle(cornerRadius: cornerRadius)
          .strokeBorder(borderColor, lineWidth: Size.strokeSelected)
      )
      .onHover { isHovering = $0 }
  }

  private var borderColor: Color {
    if isSelected { return SidebarColors.borderSelected }
    if isHovering { return SidebarColors.borderHover }
    return .clear
  }

}

// MARK: - Color Swatch Style Modifier

struct ColorSwatchStyle: ViewModifier {
  let isSelected: Bool

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var isHovering = false

  init(isSelected: Bool) {
    self.isSelected = isSelected
  }

  func body(content: Content) -> some View {
    content
      .aspectRatio(1, contentMode: .fit)
      .clipShape(Circle())
      .overlay(
        Circle()
          .stroke(borderColor, lineWidth: borderWidth)
      )
      .scaleEffect(isHovering && !isSelected && !reduceMotion ? 1.06 : 1.0)
      .animation(reduceMotion ? nil : .easeInOut(duration: 0.15), value: isHovering)
      .onHover { isHovering = $0 }
  }

  private var borderColor: Color {
    if isSelected { return SidebarColors.borderSelected }
    if isHovering { return SidebarColors.borderHover }
    return Color.secondary.opacity(0.3)
  }

  private var borderWidth: CGFloat {
    isSelected ? Size.strokeSelected : Size.strokeDefault
  }
}

// MARK: - Action Button Style (for + buttons)

struct ActionButtonStyle: ViewModifier {
  let cornerRadius: CGFloat

  @State private var isHovering = false

  init(cornerRadius: CGFloat = Size.radiusMd) {
    self.cornerRadius = cornerRadius
  }

  func body(content: Content) -> some View {
    content
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .aspectRatio(1, contentMode: .fit)
      .background(
        RoundedRectangle(cornerRadius: cornerRadius)
          .fill(isHovering ? SidebarColors.actionButtonHover : SidebarColors.actionButton)
      )
      .overlay(
        RoundedRectangle(cornerRadius: cornerRadius)
          .strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [4]))
          .foregroundColor(isHovering ? .primary.opacity(0.5) : .primary.opacity(0.3))
      )
      .onHover { isHovering = $0 }
  }
}

// MARK: - View Extensions

extension View {
  func sidebarItemStyle(isSelected: Bool, cornerRadius: CGFloat = Size.radiusMd) -> some View {
    modifier(SidebarItemStyle(isSelected: isSelected, cornerRadius: cornerRadius))
  }

  func colorSwatchStyle(isSelected: Bool) -> some View {
    modifier(ColorSwatchStyle(isSelected: isSelected))
  }

  func actionButtonStyle(cornerRadius: CGFloat = Size.radiusMd) -> some View {
    modifier(ActionButtonStyle(cornerRadius: cornerRadius))
  }
}
