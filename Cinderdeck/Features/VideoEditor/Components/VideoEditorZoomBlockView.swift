//
//  ZoomBlockView.swift
//  Cinderdeck
//
//  Interactive zoom block displayed on timeline track
//

import SwiftUI

// MARK: - Zoom Colors

enum ZoomColors {
  // Primary colors - use system accent for native feel
  static var primary: Color { Color(NSColor.controlAccentColor) }
  static var primaryDark: Color { Color(NSColor.controlAccentColor).opacity(0.85) }

  // Semantic colors
  static let disabled = Color(NSColor.disabledControlTextColor)
  static let selected = Color.white

  // Additional semantic colors for consistency
  static var background: Color { Color(NSColor.controlBackgroundColor) }
}
