import AppKit
import SwiftUI

/// Native operations remain on their existing models and supervisor. This auxiliary
/// tool deliberately bypasses the main-window façade, which routes into CinderdeckRuntime.
@MainActor
final class CinderdeckRuntimeWorkspaceTools: NSWindowController, NSWindowDelegate {
  static let shared = CinderdeckRuntimeWorkspaceTools()
  private let model = StacksViewModel(supervisor: .shared)
  private var presentedRequest: CinderdeckRuntimeUIRequest?

  private init() {
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1380, height: 860),
      styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    super.init(window: window)
    window.delegate = self
    window.minSize = NSSize(width: 1020, height: 700)
    window.isReleasedWhenClosed = false
    window.setFrameAutosaveName("CinderdeckNativeWorkspaceTools")
    // Keep the complete existing sheet/inspector wiring, including setup discovery,
    // task/workflow editors, lane management, logs, and the operational execution map.
    window.contentView = NSHostingView(rootView: WorkspaceView(model: model, runner: .shared,
      onOpenInCinderdeck: { [weak self] in self?.close() },
      onToolSheetDismiss: { [weak self] in self?.finishPresentedSheet() }))
    window.center()
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func open(_ request: CinderdeckRuntimeUIRequest) throws {
    guard let window else { throw StackControlError(code: "host_unavailable", message: "The native workspace tool is unavailable") }
    // Repeated opens can focus the same editor without losing its draft. A request
    // for another scope must wait until the user closes the existing sheet.
    if window.attachedSheet != nil || model.hasAuxiliaryUI {
      if presentedRequest == request,
        request.workspaceID == nil || model.selectedStackID == request.workspaceID {
        activate(); return
      }
      throw StackControlError(code: "busy", message: "Finish or cancel the open native editor before opening another workspace tool.")
    }

    let file: StackDefinitionFile?
    if let id = request.workspaceID {
      guard let selected = StackSupervisor.shared.files.first(where: { $0.id == id }) else {
        throw StackControlError(code: "resource_missing", message: "The requested workspace is unavailable")
      }
      file = selected
    } else { file = nil }

    switch request.surface {
    case "workspace-setup":
      guard request.workspaceID == nil, request.mode == nil else { throw StackControlError.invalid("Workspace setup does not accept a workspace or mode") }
      window.title = "Project setup — Cinderdeck"
      model.requestedSection = .services
      presentedRequest = request
      activate()
      model.create()
    case "workspace-editor":
      guard let file, file.lane == nil, model.workspaceNavigation.workspaces.contains(where: { $0.id == file.id }) else {
        throw StackControlError.invalid("Select the source workspace to edit its definition; lane snapshots cannot be edited here")
      }
      guard request.mode.map({ CinderdeckRuntimeUIRequest.workspaceEditorModes.contains($0) }) ?? true else {
        throw StackControlError.invalid("Unsupported workspace editor mode")
      }
      model.select(file.id)
      switch request.mode {
      case "tasks": model.requestedSection = .tasks
      case "workflows": model.requestedSection = .workflows
      default: model.requestedSection = .services
      }
      window.title = "Workspace tools — \(file.name) — Cinderdeck"
      presentedRequest = request
      activate()
      if request.mode == nil || request.mode == "delete" {
        model.editor = .init(file: file.file, requestsDeletion: request.mode == "delete")
      }
    case "workspace-branches":
      guard let file, request.mode == nil, let definition = file.definition, !definition.repos.isEmpty else {
        throw StackControlError.invalid("Branch switching requires an exact workspace or lane with repositories and no mode")
      }
      guard !model.isBusy(file.id) else {
        throw StackControlError(code: "busy", message: "Wait for this workspace's current operation to finish before switching branches.")
      }
      model.select(file.id)
      model.requestedSection = .services
      window.title = "Switch branches — \(file.name) — Cinderdeck"
      presentedRequest = request
      activate()
      model.openStackBranchPicker()
    case "workspace-terminal":
      guard let file, request.mode == nil else { throw StackControlError.invalid("Workspace terminal requires an exact workspace and no mode") }
      model.showLogs(stack: file.id, service: nil)
    case "execution-map":
      guard let file, request.mode == nil else { throw StackControlError.invalid("Execution map requires an exact workspace and no mode") }
      model.select(file.id)
      model.requestedSection = .laneMap
      window.title = "Execution map — \(file.name) — Cinderdeck"
      presentedRequest = request
      activate()
    default:
      throw StackControlError.invalid("Unsupported native workspace tool")
    }
  }

  private func activate() {
    showWindow(nil)
    window?.makeKeyAndOrderFront(nil)
    model.supervisor.gitMonitor.setVisible(true, source: "native-workspace-tools")
    NSApp.activate(ignoringOtherApps: true)
  }

  private func finishPresentedSheet() {
    guard let request = presentedRequest,
      request.surface == "workspace-setup" ||
        (request.surface == "workspace-editor" && (request.mode == nil || request.mode == "delete")) else { return }
    presentedRequest = nil
    close()
  }

  func windowWillClose(_ notification: Notification) {
    model.supervisor.gitMonitor.setVisible(false, source: "native-workspace-tools")
    CinderdeckRuntimeController.shared.activateOwnedWindow()
  }
}
