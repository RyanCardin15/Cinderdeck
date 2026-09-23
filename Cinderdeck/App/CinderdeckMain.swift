import Foundation
import SwiftUI

/// Process entry point. `cinderdeck stacks …` and `cinderdeck mcp` run as command-line
/// tools from the same binary and exit before any UI starts; everything else
/// launches the menu bar app.
@main
enum CinderdeckMain {
  static func main() {
    if let status = StackCLI.runIfRequested(CommandLine.arguments) { exit(status) }
    #if !DEBUG
    do {
      try CinderdeckMigration.runIfNeeded()
    } catch {
      let alert = NSAlert()
      alert.messageText = "Cinderdeck could not import your Snapzy data"
      alert.informativeText = "Your original data has not been deleted. Quit and try again after resolving this error: \(error.localizedDescription)"
      alert.addButton(withTitle: "Quit")
      alert.runModal()
      exit(1)
    }
    #endif
    CinderdeckApp.main()
  }
}
