import AppKit
import SwiftUI

@MainActor
final class StackTerminalWindowController: NSWindowController, NSWindowDelegate {
  let viewModel: StackConsoleViewModel
  var onClose: (() -> Void)?

  init(file: StackDefinitionFile, supervisor: StackSupervisor) {
    viewModel = StackConsoleViewModel(file: file, supervisor: supervisor)
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 940, height: 480),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered, defer: false)
    super.init(window: window)
    window.title = "\(file.name) — Terminal"
    window.identifier = NSUserInterfaceItemIdentifier("stacks.terminal.\(file.id)")
    window.isReleasedWhenClosed = false
    window.isRestorable = false
    window.contentMinSize = NSSize(width: 640, height: 260)
    window.backgroundColor = StackLogView.background
    window.appearance = NSAppearance(named: .darkAqua)
    window.contentView = NSHostingView(rootView: StackConsoleView(viewModel: viewModel))
    window.delegate = self
    window.center()
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func show(service: String?) {
    viewModel.start(service: service)
    if window?.isMiniaturized == true { window?.deminiaturize(nil) }
    showWindow(nil)
    window?.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    // The hosting view must be in a visible window before focusing its NSTextView.
    DispatchQueue.main.async { [weak self] in self?.viewModel.focusLogs() }
  }

  func windowWillClose(_ notification: Notification) {
    viewModel.stop()
    onClose?()
  }
}
