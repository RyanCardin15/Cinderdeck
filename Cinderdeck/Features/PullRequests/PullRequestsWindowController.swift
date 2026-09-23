import AppKit
import SwiftUI

@MainActor
final class PullRequestsWindowController: NSWindowController {
  static let shared = PullRequestsWindowController()
  private let model = PullRequestsViewModel()

  init() {
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1360, height: 820),
      styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    super.init(window: window)
    window.title = "Pull requests — Cinderdeck"
    window.minSize = NSSize(width: 1040, height: 640)
    window.isReleasedWhenClosed = false
    window.setFrameAutosaveName("CinderdeckPullRequests")
    window.contentView = NSHostingView(rootView: PullRequestsView(model: model))
    window.center()
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  func show() {
    showWindow(nil)
    window?.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }
}
