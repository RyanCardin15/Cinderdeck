import AppKit
import Foundation

/// Asks the person at this Mac whether an agent may use an app. Answers are
/// "session", "always", "once" or "deny"; no answer within two minutes denies.
enum Approval {
  static func request(appName: String, agentLabel: String) async -> String {
    await MainActor.run {
      let previous = NSWorkspace.shared.frontmostApplication
      let alert = NSAlert()
      alert.messageText = "Allow \(agentLabel) to use \(appName)?"
      alert.informativeText =
        "The agent can read \(appName)'s windows and click and type in it in the background. Cinderdeck shows the agent's own cursor; your pointer and keyboard are not used."
      alert.addButton(withTitle: "Allow for This Conversation")
      alert.addButton(withTitle: "Always Allow \(appName)")
      alert.addButton(withTitle: "Allow Once")
      alert.addButton(withTitle: "Deny")
      alert.window.level = .modalPanel
      NSApp.activate(ignoringOtherApps: true)
      let timer = Timer(timeInterval: 120, repeats: false) { _ in NSApp.abortModal() }
      RunLoop.main.add(timer, forMode: .modalPanel)
      let response = alert.runModal()
      timer.invalidate()
      previous?.activate()
      switch response {
      case .alertFirstButtonReturn: return "session"
      case .alertSecondButtonReturn: return "always"
      case .alertThirdButtonReturn: return "once"
      default: return "deny"
      }
    }
  }
}
