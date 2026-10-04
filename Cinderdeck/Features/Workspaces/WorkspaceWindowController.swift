import AppKit
import SwiftUI

@MainActor
final class WorkspaceWindowController: NSWindowController, NSWindowDelegate {
  static let shared = WorkspaceWindowController()
  let model: StacksViewModel
  init(supervisor: StackSupervisor = .shared, runner: WorkspaceRunner = .shared) {
    model = StacksViewModel(supervisor: supervisor)
    if AgentShellController.shared.configured {
      super.init(window: nil)
      return
    }
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1380, height: 860),
      styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    super.init(window: window)
    window.delegate = self
    window.title = "Workspaces — Cinderdeck"
    window.minSize = NSSize(width: 1020, height: 700)
    window.isReleasedWhenClosed = false
    window.setFrameAutosaveName("CinderdeckWorkspaces")
    window.contentView = NSHostingView(rootView: WorkspaceView(model: model, runner: runner))
    window.center()
  }
  func windowWillClose(_ notification: Notification) {
    model.supervisor.gitMonitor.setVisible(false, source: "workspaces")
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  func show(workspace: String? = nil, section: WorkspaceSection? = nil) {
    let routeSection: String?
    switch section {
    case .services: routeSection = "services"
    case .tasks: routeSection = "tasks"
    case .workflows: routeSection = "workflows"
    case .laneMap: routeSection = "lane-map"
    case .runs: routeSection = "runs"
    case .recordings: routeSection = "recordings"
    case .linkedWork: routeSection = "agents"
    case nil: routeSection = nil
    }
    if AgentShellController.shared.show(workspaceID: workspace, section: routeSection) { return }
    if let workspace { model.select(workspace) }
    if let section { model.requestedSection = section }
    showWindow(nil)
    window?.makeKeyAndOrderFront(nil)
    model.supervisor.gitMonitor.setVisible(true, source: "workspaces")
    NSApp.activate(ignoringOtherApps: true)
  }
}
