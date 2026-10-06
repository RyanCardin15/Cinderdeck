//
//  NSApplication+Activation.swift
//  Cinderdeck
//

import AppKit

extension NSApplication {
  /// Auxiliary windows must never remove Cinderdeck from the Dock or app switcher.
  @MainActor
  func maintainRegularActivationPolicy() {
    if activationPolicy() != .regular {
      _ = setActivationPolicy(.regular)
    }
  }
}
