import AppKit

/// The main runtime window belongs to a child application; native windows do
/// not tell AppKit whether that window needs to be brought forward.
@MainActor
enum AppWindowActivationPolicy {
  static func blockingWindow(modalWindow: NSWindow?, windows: [NSWindow]) -> NSWindow? {
    if let modalWindow { return modalWindow }
    return windows.first { $0.isVisible && $0.attachedSheet != nil }
  }

  static func shouldActivateRuntime(
    keyWindow: NSWindow?, modalWindow: NSWindow?, windows: [NSWindow]
  ) -> Bool {
    guard blockingWindow(modalWindow: modalWindow, windows: windows) == nil else { return false }
    guard let keyWindow else { return true }
    return !(keyWindow.isVisible && keyWindow.isKeyWindow && !keyWindow.isMiniaturized
      && keyWindow.canBecomeKey && keyWindow.className != "NSStatusBarWindow")
  }
}
