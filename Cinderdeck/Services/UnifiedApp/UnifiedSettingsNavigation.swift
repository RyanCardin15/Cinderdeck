import AppKit

/// Every native settings entry point opens the same main-window settings shell.
enum UnifiedSettingsNavigation {
  nonisolated static let sections: Set<String> = Set(NativeSettingsRequest.categories.map { "settings:" + $0 }).union(["settings:workspace", "settings:workspace-delete", "settings:workspace-configuration"])

  nonisolated static func section(for tab: PreferencesTab?) -> String {
    "settings:" + (tab?.rawValue ?? "general")
  }

  @MainActor static func openUpdates() { present(workspaceID: nil, section: "settings:updates") }

  @MainActor static func openWorkspace(_ id: String, deleting: Bool = false, configuration: Bool = false) {
    present(workspaceID: id, section: deleting ? "settings:workspace-delete" : configuration ? "settings:workspace-configuration" : "settings:workspace")
  }

  @MainActor static func open(_ tab: PreferencesTab? = nil) {
    present(workspaceID: nil, section: section(for: tab))
  }

  @MainActor private static func present(workspaceID: String?, section: String) {
    if !CinderdeckRuntimeController.shared.show(workspaceID: workspaceID, section: section) {
      let alert = NSAlert()
      alert.messageText = "Settings requires the complete Cinderdeck app"
      alert.informativeText = "Build the unified app with scripts/build-unified.sh to open Settings."
      alert.runModal()
    }
  }
}
