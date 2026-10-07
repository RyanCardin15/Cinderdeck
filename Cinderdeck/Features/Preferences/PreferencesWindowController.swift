import AppKit

/// Compatibility adapter for native callers. Settings has no auxiliary window.
@MainActor
final class PreferencesWindowController {
  static let shared = PreferencesWindowController()
  private init() {}
  var window: NSWindow? { nil }
  var isVisible: Bool { false }
  func show(tab: PreferencesTab? = nil) { UnifiedSettingsNavigation.open(tab) }
  func close() {}
}
