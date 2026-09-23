#if DEBUG
import AppKit
import Foundation

/// An opt-in integration harness for exercising the real history panel without
/// capture permissions, personal configuration sync or the user's history DB.
@MainActor
enum StackPreviewHarness {
  static var root: URL? {
    guard let path = ProcessInfo.processInfo.environment["CINDERDECK_STACKS_PREVIEW_ROOT"], path.hasPrefix("/") else { return nil }
    return URL(fileURLWithPath: path, isDirectory: true)
  }
  static func startIfRequested() -> Bool {
    guard let root else { return false }
    UserDefaults.standard.setVolatileDomain([
      PreferencesKeys.stacksDirectory: root.appendingPathComponent("stacks").path,
      PreferencesKeys.stacksEnabled: true,
      PreferencesKeys.stacksNotifyOnCrash: false,
      PreferencesKeys.stacksQuitBehavior: "ask",
      PreferencesKeys.stacksAutoFetchMinutes: 0,
      PreferencesKeys.clipboardTextHistoryEnabled: false,
    ], forName: UserDefaults.argumentDomain)
    NSApp.setActivationPolicy(.regular)
    Task {
      await StackSupervisor.shared.bootstrap()
      await WorkspaceRunner.shared.recover()
      StackControlService.shared.start()
      WorkspaceWindowController.shared.show()
      let manager = HistoryFloatingManager.shared
      manager.show(section: .stacks)
      if !manager.isPinned { manager.togglePin() }
      NSApp.activate(ignoringOtherApps: true)
    }
    return true
  }
}
#endif
