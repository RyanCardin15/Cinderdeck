import AppKit
import Foundation

/// Only user-requested native surfaces. Agent process authority remains separate.
@MainActor
enum CinderdeckRuntimeNativeUI {
  private static weak var captureViewModel: ScreenCaptureViewModel?

  static func configure(_ viewModel: ScreenCaptureViewModel) { captureViewModel = viewModel }

  static func open(_ request: CinderdeckRuntimeUIRequest) throws {
    if let workspaceID = request.workspaceID,
      !StackSupervisor.shared.files.contains(where: { $0.id == workspaceID }) {
      throw StackControlError(code: "resource_missing", message: "The requested workspace is unavailable")
    }
    switch request.surface {
    case "workspace-lane-create":
      guard let id = request.workspaceID, request.mode == nil,
        let file = StackSupervisor.shared.files.first(where: { $0.id == id }), file.lane == nil else {
        throw StackControlError.invalid("Create a lane from an exact source workspace, with no mode")
      }
      if LaneCreationWindowController.shared.focusIfPresented() { return }
      Task { @MainActor in
        do {
          _ = try await StackControlService.shared.handle("lane.create",
            params: .object(["workspace": .string(id), "start": .bool(false)]), actor: .user)
        } catch {
          if (error as? StackControlError)?.code != "cancelled" {
            let alert = NSAlert(); alert.messageText = "Could not create lane"; alert.informativeText = error.localizedDescription
            alert.runModal()
          }
        }
      }
    case "agent-access":
      // Older shells still ask for the native sheet; the setup now lives in the shell's own settings.
      guard request.workspaceID == nil, request.mode == nil else { throw StackControlError.invalid("Agent access does not accept a workspace or mode") }
      CinderdeckRuntimeController.shared.show(section: AgentAccessNavigation.section)
    case "workspace-setup", "workspace-editor", "workspace-terminal", "workspace-branches", "execution-map":
      try CinderdeckRuntimeWorkspaceTools.shared.open(request)
    case "workspace", "lane-map":
      guard request.mode == nil else { throw StackControlError.invalid("This surface does not accept a mode") }
      WorkspaceWindowController.shared.show(workspace: request.workspaceID, section: request.surface == "lane-map" ? .laneMap : nil)
    case "history":
      guard request.mode == nil else { throw StackControlError.invalid("History does not accept a mode") }
      if HistoryFloatingManager.shared.selectedSection == .stacks {
        HistoryFloatingManager.shared.selectedSection = .captures
      }
      HistoryWindowController.shared.showWindow()
    case "preferences":
      let tab: PreferencesTab?
      if let mode = request.mode {
        guard let selected = PreferencesTab(rawValue: mode) else { throw StackControlError.invalid("Unknown preferences category") }
        tab = selected
      } else { tab = nil }
      AppStatusBarController.shared.openPreferencesWindow(tab: tab)
    case "capture":
      let mode = request.mode ?? "region"
      guard CinderdeckRuntimeUIRequest.captureModes.contains(mode), let viewModel = captureViewModel else {
        throw StackControlError(code: "unsupported_capability", message: "This capture action is unavailable")
      }
      switch mode {
      case "region": viewModel.captureArea()
      case "window": viewModel.captureApplication()
      case "fullscreen": viewModel.captureFullscreen()
      case "scrolling": viewModel.captureScrolling()
      case "ocr": viewModel.captureOCR()
      default: break
      }
    case "recording":
      guard request.mode == nil || request.mode == "screen" || request.mode == "window", let viewModel = captureViewModel else {
        throw StackControlError(code: "unsupported_capability", message: "This recording action is unavailable")
      }
      guard !ReproRecordingController.shared.isBusy, !RecordingCoordinator.shared.isActive else {
        throw StackControlError(code: "busy", message: "Another recording is in progress. Stop it first.")
      }
      if let workspaceID = request.workspaceID { ReproRecorder.shared.setScope(.only([workspaceID])) }
      if request.mode == "window" { viewModel.startApplicationRecordingFlow() }
      else { viewModel.startRecordingFlow() }
    case "annotate":
      guard request.mode == nil else { throw StackControlError.invalid("Annotation does not accept a mode") }
      AnnotateManager.shared.openEmptyAnnotation()
      NSApp.activate(ignoringOtherApps: true)
    case "updates":
      guard request.mode == nil else { throw StackControlError.invalid("Updates does not accept a mode") }
      UpdaterManager.shared.checkForUpdates()
    default:
      throw StackControlError.invalid("Unsupported native surface")
    }
  }
}
