import AppKit

@MainActor
enum StackQuitCoordinator {
  static func shouldTerminate(_ application: NSApplication) -> NSApplication.TerminateReply {
    let supervisor = StackSupervisor.shared
    guard supervisor.hasRunningServices else { return .terminateNow }
    let defaults = UserDefaults.standard
    let behavior = defaults.string(forKey: PreferencesKeys.stacksQuitBehavior) ?? "ask"
    Task {
      var choice = behavior
      if behavior != "stop" && behavior != "leave" {
        let alert = NSAlert()
        alert.messageText = "Dev services are still running"
        alert.informativeText = "Stop your stacks before quitting, or leave them running. Cinderdeck can reconnect to them next time it opens."
        alert.addButton(withTitle: "Stop stacks and quit")
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
      if choice == "stop" {
        await supervisor.stopAll()
        if supervisor.hasRunningServices {
          let alert = NSAlert()
          alert.messageText = "Some services could not be stopped"
          alert.informativeText = "Open Stacks to review the error, or choose Leave running when quitting."
          alert.runModal()
          application.reply(toApplicationShouldTerminate: false)
          return
        }
      } else {
        await supervisor.prepareToLeaveRunning()
      }
      application.reply(toApplicationShouldTerminate: true)
    }
    return .terminateLater
  }
}
