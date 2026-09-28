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
    var overrides = UserDefaults.standard.volatileDomain(forName: UserDefaults.argumentDomain)
    let captures = root.appendingPathComponent("Captures", isDirectory: true)
    try? FileManager.default.createDirectory(at: captures, withIntermediateDirectories: true)
    overrides[PreferencesKeys.exportLocation] = captures.path
    // A stored bookmark takes precedence over the path. Keep toolbar exports in the
    // fixture too, even when this Debug app has a previously saved export location.
    overrides[PreferencesKeys.exportLocationBookmark] = (try? captures.bookmarkData(
      options: .withSecurityScope, includingResourceValuesForKeys: nil, relativeTo: nil
    )) ?? Data()
    overrides.merge([
      PreferencesKeys.stacksDirectory: root.appendingPathComponent("stacks").path,
      PreferencesKeys.stacksEnabled: true,
      PreferencesKeys.stacksNotifyOnCrash: false,
      PreferencesKeys.stacksQuitBehavior: "ask",
      PreferencesKeys.stacksAutoFetchMinutes: 0,
      PreferencesKeys.clipboardTextHistoryEnabled: false,
    ]) { _, preview in preview }
    UserDefaults.standard.setVolatileDomain(overrides, forName: UserDefaults.argumentDomain)
    NSApp.setActivationPolicy(.regular)
    Task {
      await StackSupervisor.shared.bootstrap()
      await WorkspaceRunner.shared.recover()
      ReproRecorder.shared.start()
      StackControlService.shared.start()
      WorkspaceWindowController.shared.show()
      let manager = HistoryFloatingManager.shared
      manager.show(section: .stacks)
      if !manager.isPinned { manager.togglePin() }
      NSApp.activate(ignoringOtherApps: true)
      // "1" opens area selection; "toolbar" opens the real toolbar at a fixed region
      // so the workspace picker can be exercised without automating a display overlay.
      let recordingPreview = ProcessInfo.processInfo.environment["CINDERDECK_PREVIEW_RECORD"]
      if recordingPreview == "1" || recordingPreview == "toolbar" {
        let capture = ScreenCaptureViewModel()
        recordingViewModel = capture
        await capture.updatePermissionState()
        if recordingPreview == "toolbar", capture.hasPermission, let screen = NSScreen.main {
          let frame = screen.visibleFrame
          let rect = CGRect(x: frame.midX - 400, y: frame.midY - 250,
            width: min(800, frame.width), height: min(500, frame.height))
          RecordingCoordinator.shared.showToolbar(for: rect)
          // The toolbar hides itself from screen capture so it never appears in videos;
          // in the harness, let screenshots see it and its popovers.
          Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in
            MainActor.assumeIsolated { for window in NSApp.windows where window.sharingType == .none { window.sharingType = .readOnly } }
          }
        } else {
          capture.startRecordingFlow()
        }
      }
      // Opt-in visual audit surfaces. These open editors and reference panels;
      // they do not start capture, change permissions, or write user documents.
      for surface in (ProcessInfo.processInfo.environment["CINDERDECK_PREVIEW_SURFACES"] ?? "").split(separator: ",") {
        switch surface {
        case "annotate": AnnotateManager.shared.openEmptyAnnotation()
        case "video": VideoEditorManager.shared.openEmptyEditor()
        case "onboarding": CinderdeckOnboardingWindowController.shared.show()
        case "shortcuts": ShortcutOverlayManager.shared.show()
        case "uploads": _ = CloudUploadHistoryWindowController.shared.toggleWindow()
        default: break
        }
      }
      if let path = ProcessInfo.processInfo.environment["CINDERDECK_PREVIEW_VIDEO"], path.hasPrefix("/") {
        VideoEditorManager.shared.openEditor(for: URL(fileURLWithPath: path))
      }
    }
    return true
  }

  private static var recordingViewModel: ScreenCaptureViewModel?
}
#endif
