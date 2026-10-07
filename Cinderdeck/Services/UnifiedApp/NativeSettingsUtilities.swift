import AppKit
import Foundation
import UniformTypeIdentifiers

/// File choosers and explicit maintenance actions used by the unified form.
@MainActor
enum NativeSettingsUtilities {
  nonisolated static let categories = ["menu-icon-import": "menuBar", "menu-icon-remove": "menuBar", "menu-reset": "menuBar",
    "history-open": "history", "history-clear": "history", "clipboard-clear": "history",
    "config-sync": "advanced", "logs-open": "advanced", "ocr-test": "capture",
    "notification-allow": "permissions", "notification-open": "permissions", "shortcuts-reset": "shortcuts",
    "cloud-export": "cloud", "cloud-import": "cloud"]

  static func handle(_ request: NativeSettingsRequest) async throws -> String? {
    guard categories[request.action] == request.category else { throw StackControlError.invalid("Invalid settings utility") }
    switch request.action {
    case "menu-icon-import":
      let panel = NSOpenPanel(); panel.allowedContentTypes = [.png]; panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
      guard panel.runModal() == .OK, let url = panel.url else { return nil }
      guard MenuBarIconRenderer.shared.saveCustomIcon(from: url) else { throw StackControlError.invalid("Choose a valid PNG menu icon") }
      MenuBarCustomizationStore.shared.setIconStyle(.custom)
    case "menu-icon-remove":
      MenuBarIconRenderer.shared.removeCustomIcon(); MenuBarCustomizationStore.shared.setIconStyle(.default)
    case "menu-reset": MenuBarCustomizationStore.shared.resetToDefaults()
    case "history-open":
      if let url = CaptureStorageManager.shared.ensureCapturesDirectory() { NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: url.path) }
    case "history-clear", "clipboard-clear":
      let clipboard = request.action == "clipboard-clear"
      let alert = NSAlert(); alert.messageText = clipboard ? "Clear clipboard text history?" : "Clear capture history?"
      alert.informativeText = clipboard ? "Saved clipboard text is removed. Favorites, groups, captures and the current clipboard are kept." : "Saved captures in Cinderdeck history will be deleted. This cannot be undone."
      alert.addButton(withTitle: "Cancel"); alert.addButton(withTitle: "Clear history")
      guard alert.runModal() == .alertSecondButtonReturn else { return nil }
      if clipboard { ClipboardTextHistoryStore.shared.clear() }
      else { HistoryWindowController.shared.deleteRecords(CaptureHistoryStore.shared.records, asksConfirmation: false) }
    case "logs-open":
      let url = DiagnosticLogger.shared.logDirectoryURL
      try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
      NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: url.path)
    case "config-sync":
      let result = try CinderdeckConfigurationService.shared.syncManagedConfigIfSafe()
      guard result.fileURL.isFileURL else { throw StackControlError.invalid("Configuration is unavailable") }
    case "notification-allow":
      guard await SystemNotificationService.shared.requestAuthorization() else { throw StackControlError.invalid("Notifications were not granted. Enable them in System Settings.") }
    case "notification-open": SystemNotificationService.shared.openSystemSettings()
    case "ocr-test":
      guard let raw = request.payload?["id"]?.stringValue, let id = UUID(uuidString: raw),
        let model = CustomOCRModelStore.shared.model(for: id) else { throw StackControlError.invalid("Save this recognition model before testing it") }
      switch await RemoteOCRProvider(model: model).testConnection() {
      case .success: return "Recognition model connection succeeded."
      case .failure(let error): throw error
      }
    case "shortcuts-reset":
      let current = try CinderdeckNativeSettings.configurationFields(CinderdeckConfigurationExporter.exportTOML())
      let defaults = try CinderdeckNativeSettings.configurationFields(CinderdeckConfigurationDefaultDocument.toml())
      let changes = defaults.filter { $0.key.hasPrefix("shortcuts.") && current[$0.key] != nil }.mapValues { $0 }
      let patch = JSONValue.object(Dictionary(uniqueKeysWithValues: changes.map { ($0.key, JSONValue.object(["expected": current[$0.key]!, "value": $0.value])) }))
      let source = try CinderdeckNativeSettings.patchTOML(category: "shortcuts", changes: patch, current: current)
      let result = CinderdeckConfigurationImporter.importTOML(source)
      if result.hasErrors { throw StackControlError.invalid(result.issues.map(\.message).joined(separator: "; ")) }
    case "cloud-export", "cloud-import":
      try CinderdeckNativeSettings.requireCloudUnlocked()
      guard let passphrase = request.payload?["passphrase"]?.stringValue, passphrase.count >= 12, passphrase.utf8.count <= 4096 else { throw StackControlError.invalid("Use an archive passphrase with at least 12 characters") }
      let manager = CloudManager.shared
      if request.action == "cloud-export" {
        let payload = try manager.exportTransferPayload()
        let panel = NSSavePanel(); panel.nameFieldStringValue = CloudCredentialTransferService.suggestedArchiveFileName(for: payload); panel.allowedContentTypes = [CloudCredentialTransferService.archiveContentType]
        guard panel.runModal() == .OK, let url = panel.url else { return nil }
        try CloudCredentialTransferService.exportArchive(payload: payload, to: url, passphrase: passphrase)
        return "Encrypted credential archive exported."
      }
      let panel = NSOpenPanel(); panel.canChooseDirectories = false; panel.allowsMultipleSelection = false; panel.allowedContentTypes = [CloudCredentialTransferService.archiveContentType]
      guard panel.runModal() == .OK, let url = panel.url else { return nil }
      let payload = try CloudCredentialTransferService.importArchive(from: url, passphrase: passphrase)
      let alert = NSAlert(); alert.messageText = "Use imported cloud credentials?"; alert.informativeText = "This replaces your cloud configuration with \(payload.providerDisplayName)."; alert.addButton(withTitle: "Cancel"); alert.addButton(withTitle: "Connect storage")
      guard alert.runModal() == .alertSecondButtonReturn else { return nil }
      let observed = CinderdeckConfigurationExporter.exportTOML()
      let access = payload.googleClientId ?? payload.accessKey, secret = payload.googleClientSecret ?? payload.secretKey
      try await manager.validateCredentials(config: payload.configuration, accessKey: access, secretKey: secret, googleRefreshToken: payload.googleRefreshToken)
      try CinderdeckNativeSettings.requireCloudUnlocked()
      guard observed == CinderdeckConfigurationExporter.exportTOML() else { throw StackControlError.invalid("Settings changed during import. Import the archive again.") }
      try manager.saveConfiguration(payload.configuration, accessKey: access, secretKey: secret, googleRefreshToken: payload.googleRefreshToken)
      manager.isEnabled = true
      return "Imported storage credentials connected."
    default: throw StackControlError.invalid("Unsupported settings utility")
    }
    CinderdeckConfigurationSyncCoordinator.shared.scheduleSync(reason: .explicitChange)
    return "Done."
  }
}
