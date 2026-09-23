import Foundation
import SwiftUI

/// Process entry point. `snapzy stacks …` and `snapzy mcp` run as command-line
/// tools from the same binary and exit before any UI starts; everything else
/// launches the menu bar app.
@main
enum SnapzyMain {
  static func main() {
    if let status = StackCLI.runIfRequested(CommandLine.arguments) { exit(status) }
    SnapzyApp.main()
  }
}
