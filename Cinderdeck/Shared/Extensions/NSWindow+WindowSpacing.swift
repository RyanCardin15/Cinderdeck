//
//  NSWindow+WindowSpacing.swift
//  Cinderdeck
//
//  Unified window spacing configuration for toolbar, content, and bottom bar
//

import AppKit
import SwiftUI

// MARK: - Window Spacing Configuration

/// Unified configuration for window spacing across toolbar, content, and bottom bar
struct WindowSpacingConfiguration {
  // MARK: Toolbar

  /// Toolbar horizontal padding
  var toolbarHPadding: CGFloat = 16

  /// Toolbar vertical padding
  var toolbarVPadding: CGFloat = 8

  /// Spacing between toolbar items
  var toolbarItemSpacing: CGFloat = 8

  // MARK: Content

  /// Content area horizontal padding
  var contentHPadding: CGFloat = 16

  /// Content area top padding
  var contentTopPadding: CGFloat = 12

  /// Content area bottom padding
  var contentBottomPadding: CGFloat = 12

  // MARK: Bottom Bar

  /// Bottom bar horizontal padding
  var bottomBarHPadding: CGFloat = 16

  /// Bottom bar vertical padding
  var bottomBarVPadding: CGFloat = 10

  // MARK: Traffic Lights

  /// Gap after traffic lights before content starts
  var trafficLightsGap: CGFloat = 12

  static let `default` = WindowSpacingConfiguration()
}

// MARK: - SwiftUI View Extensions

extension View {

  // MARK: Toolbar Modifiers

  /// Apply toolbar padding only
  func windowToolbarPadding(_ config: WindowSpacingConfiguration = .default) -> some View {
    self
      .padding(.horizontal, config.toolbarHPadding)
      .padding(.vertical, config.toolbarVPadding)
  }

  // MARK: Bottom Bar Modifiers

  /// Apply bottom bar padding only
  func windowBottomBarPadding(_ config: WindowSpacingConfiguration = .default) -> some View {
    self
      .padding(.horizontal, config.bottomBarHPadding)
      .padding(.vertical, config.bottomBarVPadding)
  }

  // MARK: Content Modifiers

  /// Apply content horizontal padding only
  func windowContentHPadding(_ config: WindowSpacingConfiguration = .default) -> some View {
    self.padding(.horizontal, config.contentHPadding)
  }

  // MARK: Traffic Lights Modifier

  /// Apply leading inset to account for traffic light buttons
  func windowTrafficLightsInset(_ config: WindowSpacingConfiguration = .default) -> some View {
    let trafficConfig = TrafficLightConfiguration.default
    let width = trafficConfig.horizontalOffset +
                (3 * 14) +
                (2 * trafficConfig.buttonSpacing) +
                config.trafficLightsGap
    return self.padding(.leading, width)
  }
}
