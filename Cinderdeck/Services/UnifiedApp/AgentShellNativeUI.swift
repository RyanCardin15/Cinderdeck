import AppKit
import Foundation

/// Only user-requested native surfaces. Agent process authority remains separate.
@MainActor
enum AgentShellNativeUI {
  private static weak var captureViewModel: ScreenCaptureViewModel?

  static func configure(_ viewModel: ScreenCaptureViewModel) { captureViewModel = viewModel }

  static func open(_ request: AgentShellUIRequest) throws {
    if let workspaceID = request.workspaceID,
      !StackSupervisor.shared.files.contains(where: { $0.id == workspaceID }) {
      throw StackControlError(code: "resource_missing", message: "The requested workspace is unavailable")
    }
    switch request.surface {
    case "workspace-setup", "workspace-editor", "execution-map", "agent-access":
      try AgentShellWorkspaceTools.shared.open(request)
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
      guard AgentShellUIRequest.captureModes.contains(mode), let viewModel = captureViewModel else {
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
