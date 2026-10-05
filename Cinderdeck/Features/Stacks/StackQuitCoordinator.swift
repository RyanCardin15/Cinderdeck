import AppKit

@MainActor
enum StackQuitCoordinator {
  private static var terminationInProgress = false

  static func shouldTerminate(_ application: NSApplication,
    beforeTermination: (@MainActor () async -> Bool)? = nil) -> NSApplication.TerminateReply {
    guard !terminationInProgress else { return .terminateLater }
    let supervisor = StackSupervisor.shared
    let runner = WorkspaceRunner.shared
    guard supervisor.hasRunningServices || runner.hasActiveRuns else {
      guard let beforeTermination else { return .terminateNow }
      terminationInProgress = true
      Task {
        let mayTerminate = await beforeTermination()
        terminationInProgress = false
        application.reply(toApplicationShouldTerminate: mayTerminate)
      }
      return .terminateLater
    }
    terminationInProgress = true
    let defaults = UserDefaults.standard
    let behavior = defaults.string(forKey: PreferencesKeys.stacksQuitBehavior) ?? "ask"
    Task {
      defer { terminationInProgress = false }
      var choice = runner.hasActiveRuns ? "ask" : behavior
      if choice != "stop" && choice != "leave" {
        let alert = NSAlert()
        alert.messageText = "Development work is still running"
        alert.informativeText = "Active tasks and workflows will be cancelled before quitting. You can stop services too, or leave services running and reconnect next time."
        alert.addButton(withTitle: "Stop services and quit")
        alert.addButton(withTitle: "Quit and leave running")
        alert.addButton(withTitle: "Cancel")
        alert.showsSuppressionButton = true
        alert.suppressionButton?.title = "Remember my choice"
        HistoryFloatingManager.shared.isPresentingAuxiliaryUI = true
        let result = alert.runModal()
        HistoryFloatingManager.shared.focusPanel()
        HistoryFloatingManager.shared.isPresentingAuxiliaryUI = false
        switch result {
        case .alertFirstButtonReturn: choice = "stop"
        case .alertSecondButtonReturn: choice = "leave"
        default: application.reply(toApplicationShouldTerminate: false); return
        }
        if alert.suppressionButton?.state == .on { defaults.set(choice, forKey: PreferencesKeys.stacksQuitBehavior) }
      }
      await runner.cancelAll()
      guard !runner.hasActiveRuns else { application.reply(toApplicationShouldTerminate: false); return }
      if choice == "stop" {
        await supervisor.stopAll()
        if supervisor.hasRunningServices {
          let alert = NSAlert()
          alert.messageText = "Some services could not be stopped"
          alert.informativeText = "Open Workspaces to review the error, or choose Leave running when quitting."
          alert.runModal()
          application.reply(toApplicationShouldTerminate: false)
          return
        }
      } else {
        await supervisor.prepareToLeaveRunning()
      }
      let mayTerminate = await beforeTermination?() ?? true
      application.reply(toApplicationShouldTerminate: mayTerminate)
    }
    return .terminateLater
  }
}
