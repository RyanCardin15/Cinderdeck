import AppKit
import AVFoundation
import Carbon.HIToolbox
import Foundation

nonisolated struct NativeSettingsRequest: Decodable, Sendable {
  let requestID: String
  let action: String
  let category: String
  let payload: JSONValue?

  static let categories: Set<String> = ["general", "appearance", "capture", "recording", "annotate", "quickAccess", "menuBar", "history", "shortcuts", "permissions", "dictation", "cloud", "github", "updates", "advanced", "workspaces", "about"]
  static let actions: Set<String> = Set(["read", "update", "permission", "choose-export-folder", "check-updates", "install-update", "github-refresh", "github-host", "github-sign-in", "github-cancel", "cloud-save", "cloud-unlock", "cloud-clear", "cloud-protection", "ocr-key", "dictation-key", "dictation-test", "dictation-stop", "config-export", "config-import", "config-open", "config-restore", "config-grant", "workspace-read", "workspace-save", "workspace-pick-folder", "workspace-pick-file", "workspace-review-save", "workspace-delete"]).union(NativeSettingsUtilities.categories.keys)

  static func decode(_ data: Data) throws -> Self {
    guard data.count <= 131_072,
      let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(object.keys).isSubset(of: ["requestID", "action", "category", "payload"]) else {
      throw StackControlError.invalid("Invalid settings request")
    }
    let request = try JSONDecoder().decode(Self.self, from: data)
    guard UUID(uuidString: request.requestID) != nil, categories.contains(request.category), actions.contains(request.action),
      data.count <= (request.action.hasPrefix("workspace-") ? 131_072 : 16_384) else {
      throw StackControlError.invalid("Unsupported settings request")
    }
    return request
  }
}

/// The private parent pipe is the only settings transport. No provider, preview,
/// control socket or remote environment receives this device-local authority.
@MainActor
enum CinderdeckNativeSettings {
  private static var cloudUnlockedUntil: Date?
  private static var dictationHasKey: Bool?

  static func handle(_ request: NativeSettingsRequest) async throws -> JSONValue {
    if NativeSettingsUtilities.categories[request.action] != nil {
      let notice = try await NativeSettingsUtilities.handle(request)
      var result = try snapshot(request.category).objectValue!
      var status = result["status"]?.objectValue ?? [:]
      if let notice { status["notice"] = .string(notice) }
      result["status"] = .object(status)
      return .object(result)
    }
    if request.action.hasPrefix("workspace-") { return try await NativeWorkspaceSettings.handle(request) }
    switch request.action {
    case "read": break
    case "update": try update(request)
    case "choose-export-folder":
      guard request.category == "general" else { throw StackControlError.invalid("Invalid folder request") }
      let panel = NSOpenPanel()
      panel.canChooseFiles = false; panel.canChooseDirectories = true; panel.allowsMultipleSelection = false
      panel.prompt = "Choose save folder"
      NSApp.activate(ignoringOtherApps: true)
      if panel.runModal() == .OK, let url = panel.url {
        guard SandboxFileAccessManager.shared.setExportDirectory(url) else { throw StackControlError.invalid("Could not save access to this folder") }
      }
    case "check-updates":
      guard request.category == "updates" else { throw StackControlError.invalid("Invalid update request") }
      UpdaterManager.shared.checkForUpdatesInPreferences()
    case "install-update":
      guard request.category == "updates", NativeUpdateSettings.status()["canInstall"]?.boolValue == true else { throw StackControlError.invalid("No update is ready to install") }
      UpdaterManager.shared.installUpdate()
    case "config-export", "config-import", "config-open", "config-restore", "config-grant": try configurationAction(request)
    case "dictation-test", "dictation-stop":
      guard request.category == "dictation" else { throw StackControlError.invalid("Invalid dictation request") }
      if request.action == "dictation-test" {
        guard !DictationController.shared.isBusy else { throw StackControlError.invalid("Dictation is already active") }
        DictationController.shared.begin(test: true)
      } else { DictationController.shared.finish() }
    case "permission":
      guard request.category == "permissions", let pane = request.payload?["pane"]?.stringValue,
        let suffix = ["screen": "ScreenCapture", "microphone": "Microphone", "accessibility": "Accessibility", "speech": "SpeechRecognition", "files": "FilesAndFolders"][pane],
        let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_" + suffix) else {
        throw StackControlError.invalid("Unknown system permission")
      }
      NSWorkspace.shared.open(url)
    case "github-refresh", "github-host", "github-sign-in", "github-cancel":
      guard request.category == "github" else { throw StackControlError.invalid("Invalid GitHub request") }
      let model = GitHubAccountViewModel.shared
      if request.action == "github-refresh" { await model.refresh() }
      if request.action == "github-host" {
        guard let host = request.payload?["host"]?.stringValue, host.utf8.count <= 255 else { throw StackControlError.invalid("Invalid GitHub hostname") }
        await model.useHost(host)
      }
      if request.action == "github-sign-in" { model.signIn() }
      if request.action == "github-cancel" { model.cancel() }
    case "cloud-unlock":
      guard request.category == "cloud", let password = request.payload?["password"]?.stringValue else { throw StackControlError.invalid("Enter your cloud password") }
      switch CloudPasswordService.shared.verifyPassword(password) {
      case .verified: cloudUnlockedUntil = Date().addingTimeInterval(300)
      default: throw StackControlError.invalid("The cloud password could not be verified")
      }
    case "cloud-protection":
      guard request.category == "cloud", let password = request.payload?["password"]?.stringValue,
        password.utf8.count <= 4096 else { throw StackControlError.invalid("Invalid cloud protection password") }
      try requireCloudUnlocked()
      if password.isEmpty { CloudPasswordService.shared.removePassword() }
      else {
        guard password.count >= 4 else { throw StackControlError.invalid("Use at least four characters for your protection password") }
        try CloudPasswordService.shared.savePassword(password)
      }
      cloudUnlockedUntil = Date().addingTimeInterval(300)
    case "cloud-save": try await saveCloud(request)
    case "cloud-clear":
      guard request.category == "cloud" else { throw StackControlError.invalid("Invalid cloud request") }
      try requireCloudUnlocked()
      CloudManager.shared.clearConfiguration()
    case "dictation-key":
      guard request.category == "dictation", let key = request.payload?["key"]?.stringValue, key.utf8.count <= 4096 else { throw StackControlError.invalid("Invalid dictation key") }
      try DictationController.shared.save(DictationController.shared.configuration, key: key)
      dictationHasKey = !key.isEmpty
    case "ocr-key":
      guard request.category == "capture", let raw = request.payload?["id"]?.stringValue,
        let id = UUID(uuidString: raw), CustomOCRModelStore.shared.models.contains(where: { $0.id == id }),
        let key = request.payload?["key"]?.stringValue, key.utf8.count <= 4096 else { throw StackControlError.invalid("Select an existing OCR model") }
      try CustomOCRModelStore.shared.setAPIKey(key.isEmpty ? nil : key, for: id)
    default: throw StackControlError.invalid("Unsupported settings action")
    }
    return try snapshot(request.category)
  }

  static func configurationFields(_ source: String) throws -> [String: JSONValue] {
    let document = try SimpleTOMLParser.parse(source)
    func flatten(_ table: [String: SimpleTOMLValue], prefix: String = "") -> [String: JSONValue] {
      var values: [String: JSONValue] = [:]
      for (key, value) in table {
        let path = prefix.isEmpty ? key : prefix + "." + key
        switch value {
        case .table(let table): values.merge(flatten(table, prefix: path)) { _, new in new }
        case .string(let value): values[path] = .string(value)
        case .bool(let value): values[path] = .bool(value)
        case .integer(let value): values[path] = .number(Double(value))
        case .double(let value): values[path] = .number(value)
        case .array(let value): values[path] = .array(value.compactMap { $0.stringValue.map(JSONValue.string) })
        }
      }
      return values
    }
    return flatten(document.root).filter { $0.key.contains(".") }
  }

  static func category(for id: String) -> String {
    if id == "general.appearance" { return "appearance" }
    if id == "capture.naming.recording_template" || id.hasPrefix("capture.after.recording.") { return "recording" }
    let root = id.split(separator: ".").first.map(String.init) ?? ""
    return ["quick_access": "quickAccess", "menu_bar": "menuBar", "diagnostics": "advanced", "stacks": "workspaces"][root] ?? root
  }

  /// A patch contains only known leaf keys, matching types and observed values.
  /// The importer validates the entire patch before any preference changes.
  static func patchTOML(category selected: String, changes: JSONValue, current: [String: JSONValue]) throws -> String {
    guard let object = changes.objectValue, !object.isEmpty, object.count <= 256 else { throw StackControlError.invalid("No settings changes to save") }
    for id in object.keys where id.hasPrefix("shortcuts.") {
      let group = id.split(separator: ".").dropLast().joined(separator: ".")
      if current[group + ".key"] != nil {
        let required = current.keys.filter { $0.hasPrefix(group + ".") && !$0.dropFirst(group.count + 1).contains(".") }
        guard required.allSatisfy({ object[$0] != nil }) else { throw StackControlError.invalid("Save the complete shortcut, including its key and modifiers") }
      }
    }
    var writer = SimpleTOMLWriter()
    var lastSection: String?
    writer.root("schema_version", 1)
    for id in object.keys.sorted() {
      guard category(for: id) == selected, let old = current[id], let change = object[id]?.objectValue,
        Set(change.keys) == ["expected", "value"], change["expected"] == old, let value = change["value"], sameType(old, value) else {
        throw StackControlError(code: "stale_settings", message: "Settings changed or this value is unavailable. Reload and review your changes.")
      }
      let components = id.split(separator: ".").map(String.init)
      let section = components.dropLast().joined(separator: ".")
      if section != lastSection { writer.section(section); lastSection = section }
      let key = components.last!
      switch value {
      case .string(let value): writer.value(key, value)
      case .bool(let value): writer.value(key, value)
      case .number(let value):
        guard value.isFinite else { throw StackControlError.invalid("Enter a finite number") }
        writer.value(key, value)
      case .array(let value):
        guard value.allSatisfy({ if case .string = $0 { return true }; return false }) else { throw StackControlError.invalid("Choose valid list values") }
        writer.stringArray(key, value.compactMap(\.stringValue))
      default: throw StackControlError.invalid("Unsupported setting value")
      }
    }
    return writer.output
  }

  private static func sameType(_ a: JSONValue, _ b: JSONValue) -> Bool {
    switch (a, b) {
    case (.bool, .bool), (.string, .string), (.number, .number), (.array, .array): return true
    default: return false
    }
  }

  private static func update(_ request: NativeSettingsRequest) throws {
    guard let changes = request.payload?["changes"] else { throw StackControlError.invalid("Missing settings changes") }
    if request.category == "dictation" { try updateDictation(changes); return }
    if request.category == "cloud" { try requireCloudUnlocked() }
    let fields = try configurationFields(CinderdeckConfigurationExporter.exportTOML())
    let source = try patchTOML(category: request.category, changes: changes, current: fields)
    let result = CinderdeckConfigurationImporter.importTOML(source)
    guard !result.hasErrors else { throw StackControlError.invalid(result.issues.map(\.message).joined(separator: "\n")) }
    CinderdeckConfigurationSyncCoordinator.shared.scheduleSync(reason: .explicitChange)
  }

  private static func snapshot(_ selected: String) throws -> JSONValue {
    var values = try configurationFields(CinderdeckConfigurationExporter.exportTOML()).filter { category(for: $0.key) == selected }
    var status: [String: JSONValue] = [:]
    if selected == "dictation" {
      values = dictationFields()
      if dictationHasKey == nil { dictationHasKey = DictationController.shared.hasKey() }
      status["hasKey"] = .bool(dictationHasKey ?? false)
      status["phase"] = .string(DictationController.shared.phase)
      status["message"] = .string(DictationController.shared.message)
      status["transcript"] = .string(DictationController.shared.transcript)
    }
    if selected == "advanced" {
      status["configPath"] = .string(CinderdeckConfigurationService.shared.resolvedConfigFileURL.path)
      status["needsConfigAccess"] = .bool(CinderdeckConfigurationService.shared.needsUserSelectedConfigAccess)
    }
    if selected == "permissions" {
      status = ["screen": .bool(CGPreflightScreenCaptureAccess()), "microphone": .bool(AVCaptureDevice.authorizationStatus(for: .audio) == .authorized), "accessibility": .bool(AXIsProcessTrusted()), "files": .bool(SandboxFileAccessManager.shared.hasPersistedExportPermission)]
    }
    if selected == "github" {
      let model = GitHubAccountViewModel.shared
      status = ["host": .string(model.account.hostname), "login": .string(model.account.login ?? ""), "signingIn": .bool(model.signingIn), "checking": .bool(model.checking), "error": .string(model.error ?? ""), "notice": .string(model.notice ?? "")]
      status["code"] = .string(model.progress.code ?? "")
      status["url"] = .string(model.progress.url?.absoluteString ?? "")
      status["message"] = .string(model.account.message ?? "")
      status["cliInstalled"] = .bool(model.account.cliInstalled)
      status["managedByEnvironment"] = .bool(model.account.managedByEnvironment)
    }
    if selected == "menuBar" { status["hasCustomIcon"] = .bool(MenuBarIconRenderer.shared.hasCustomIcon) }
    if selected == "cloud" {
      status["configured"] = .bool(CloudManager.shared.isConfigured)
      status["enabled"] = .bool(CloudManager.shared.isEnabled)
      status["locked"] = .bool(cloudLocked)
      status["protected"] = .bool(CloudPasswordService.shared.hasPasswordConfigured)
    }
    if selected == "updates" { status = NativeUpdateSettings.status() }
    if selected == "about" {
      status = ["version": .string(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""), "build": .string(Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "")]
    }
    let fields = values.keys.sorted().map { id -> JSONValue in
      var field: [String: JSONValue] = ["id": .string(id), "value": values[id]!]
      if let options = options(for: id) { field["options"] = .array(options.map(JSONValue.string)) }
      if id == "general.language" { field["optionLabels"] = .object(Dictionary(uniqueKeysWithValues: AppLanguageManager.shared.availableOptions.map { ($0.identifier, JSONValue.string($0.displayName)) })) }
      if id == "capture.ocr.selected_model" { field["optionLabels"] = .object(Dictionary(uniqueKeysWithValues: [("builtin", JSONValue.string("Built-in text recognition"))] + CustomOCRModelStore.shared.models.map { (OCRModelSelection.custom($0.id).persistedValue, JSONValue.string($0.name)) })) }
      if id == "recording.microphone_device_id" { field["optionLabels"] = .object(Dictionary(uniqueKeysWithValues: RecordingMicrophoneDeviceProvider.availableDevices(selectedDeviceID: values[id]?.stringValue).map { ($0.id, JSONValue.string($0.displayName)) })) }
      return .object(field)
    }
    return .object(["category": .string(selected), "fields": .array(fields), "status": .object(status)])
  }

  private static func options(for id: String) -> [String]? {
    switch id {
    case "general.language": return ["system"] + AppLanguageManager.shared.availableOptions.map(\.identifier)
    case "recording.microphone_device_id": return RecordingMicrophoneDeviceProvider.availableDevices(selectedDeviceID: UserDefaults.standard.string(forKey: PreferencesKeys.recordingMicrophoneDeviceID)).map(\.id)
    case "dictation.shortcut_modifiers": return ["command", "control", "option", "shift"]
    case "general.appearance": return ["system", "light", "dark"]
    case "capture.screenshot.format": return ImageFormatOption.allCases.map(\.rawValue)
    case "recording.format": return VideoFormat.allCases.map(\.rawValue)
    case "recording.quality": return VideoQuality.allCases.map(\.rawValue)
    case "recording.output_mode": return RecordingOutputMode.allCases.map(\.rawValue)
    case "recording.keystrokes.position": return KeystrokeOverlayPosition.allCases.map(\.rawValue)
    case "recording.annotation_shortcuts.modifier": return AnnotationShortcutModifier.allCases.map(\.rawValue)
    case "menu_bar.icon_style": return MenuBarIconStyle.allCases.map(\.rawValue)
    case "quick_access.position": return QuickAccessPosition.allCases.map(\.rawValue)
    case "quick_access.trackpad_swipe_mode": return QuickAccessTrackpadSwipeMode.allCases.map(\.rawValue)
    case "quick_access.animation_style": return QuickAccessAnimationStyle.allCases.map(\.rawValue)
    case "history.background_style": return HistoryBackgroundStyle.allCases.map(\.rawValue)
    case "history.floating.position": return HistoryPanelPosition.allCases.map(\.rawValue)
    case "history.floating.default_filter": return ["all", "screenshot", "video", "gif"]
    case "cloud.provider": return CloudProviderType.allCases.map(\.rawValue)
    case "cloud.expire_time": return CloudExpireTime.allCases.map(\.rawValue)
    case "cloud.uploads_window_position": return CloudUploadFloatingPosition.allCases.map(\.rawValue)
    case "annotate.clipboard_image_open_behavior": return AnnotateClipboardImageBehavior.allCases.map(\.rawValue)
    case "annotate.default_tool": return AnnotationToolType.inlineAnnotateTools.map(\.rawValue)
    case "stacks.quit_behavior": return ["ask", "stop", "leave"]
    case "updates.channel": return UpdateChannel.allCases.map(\.rawValue)
    case "capture.ocr.selected_model": return [OCRModelSelection.builtIn.persistedValue] + CustomOCRModelStore.shared.models.map { OCRModelSelection.custom($0.id).persistedValue }
    default:
      if id.hasSuffix(".modifiers") { return ["command", "control", "option", "shift"] }
      if id.hasPrefix("quick_access.slots.") || id == "quick_access.swipe_left_action" || id == "quick_access.swipe_right_action" { return [id.hasPrefix("quick_access.slots.") ? "" : "none"] + QuickAccessActionKind.defaultOrder.map(\.rawValue) }
      if id == "quick_access.enabled_actions" || id == "quick_access.actions_order" { return QuickAccessActionKind.defaultOrder.map(\.rawValue) }
      if id == "menu_bar.item_order" || id == "menu_bar.hidden_items" { return MenuBarItemKind.allCases.map(\.rawValue) }
      return nil
    }
  }


  private static func configurationAction(_ request: NativeSettingsRequest) throws {
    guard request.category == "advanced" else { throw StackControlError.invalid("Invalid configuration action") }
    let service = CinderdeckConfigurationService.shared
    if request.action == "config-grant" {
      _ = try CinderdeckConfigurationAccessGranting.grantSuggestedConfigAccess(service: service)
      return
    }
    guard !service.needsUserSelectedConfigAccess else { throw StackControlError.invalid("Grant access to the configuration folder first") }
    if request.action == "config-export" {
      let panel = NSSavePanel(); panel.nameFieldStringValue = "config.toml"; panel.canCreateDirectories = true
      if panel.runModal() == .OK, let url = panel.url { try service.export(to: url) }
    } else if request.action == "config-import" {
      let panel = NSOpenPanel(); panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
      if panel.runModal() == .OK, let url = panel.url {
        let result = try service.importBackupReplacingManagedConfig(from: url)
        if result.hasErrors { throw StackControlError.invalid(result.issues.map(\.message).joined(separator: "\n")) }
      }
    } else if request.action == "config-open" {
      let result = try service.syncManagedConfigIfSafe()
      NSWorkspace.shared.open(result.fileURL)
    } else if request.action == "config-restore" {
      let alert = NSAlert(); alert.messageText = "Restore native settings defaults?"; alert.informativeText = "This resets capture and desktop preferences and disconnects cloud uploads. Your captures and workspaces are kept."; alert.addButton(withTitle: "Cancel"); alert.addButton(withTitle: "Restore defaults")
      if alert.runModal() == .alertSecondButtonReturn {
        let result = try service.restoreDefaultsReplacingManagedConfig()
        if result.hasErrors { throw StackControlError.invalid(result.issues.map(\.message).joined(separator: "\n")) }
      }
    }
  }

  private static var cloudLocked: Bool {
    CloudPasswordService.shared.hasPasswordConfigured && (cloudUnlockedUntil ?? .distantPast) < Date()
  }
  static func requireCloudUnlocked() throws {
    guard !(CloudPasswordService.shared.shouldRequirePasswordForEdit() && (cloudUnlockedUntil ?? .distantPast) < Date()) else { throw StackControlError.invalid("Unlock cloud settings with your protection password first") }
  }

  private static func saveCloud(_ request: NativeSettingsRequest) async throws {
    guard request.category == "cloud", let payload = request.payload?.objectValue else { throw StackControlError.invalid("Invalid cloud configuration") }
    try requireCloudUnlocked()
    let manager = CloudManager.shared
    let observed = try configurationFields(CinderdeckConfigurationExporter.exportTOML()).filter { category(for: $0.key) == "cloud" }
    let defaults = UserDefaults.standard
    guard let provider = CloudProviderType(rawValue: defaults.string(forKey: PreferencesKeys.cloudProviderType) ?? CloudProviderType.awsS3.rawValue) else { throw StackControlError.invalid("Choose a cloud provider") }
    let config = CloudConfiguration(providerType: provider, bucket: defaults.string(forKey: PreferencesKeys.cloudBucket) ?? "", region: defaults.string(forKey: PreferencesKeys.cloudRegion) ?? "us-east-1", endpoint: defaults.string(forKey: PreferencesKeys.cloudEndpoint), customDomain: defaults.string(forKey: PreferencesKeys.cloudCustomDomain), expireTime: CloudExpireTime(rawValue: defaults.string(forKey: PreferencesKeys.cloudExpireTime) ?? "7d") ?? .day7)
    guard config.isValid,
      let access = payload["accessKey"]?.stringValue, let secret = payload["secretKey"]?.stringValue,
      !access.isEmpty, !secret.isEmpty, access.utf8.count <= 4096, secret.utf8.count <= 4096 else {
      throw StackControlError.invalid("Save a valid cloud configuration and enter both credentials")
    }
    var refreshToken: String?
    if config.providerType == .googleDrive {
      let tokens = try await GoogleDriveOAuthService.shared.startAuthorization(clientId: access, clientSecret: secret)
      refreshToken = tokens.refreshToken
    }
    try await manager.validateCredentials(config: config, accessKey: access, secretKey: secret, googleRefreshToken: refreshToken)
    try requireCloudUnlocked()
    guard observed == (try configurationFields(CinderdeckConfigurationExporter.exportTOML()).filter { category(for: $0.key) == "cloud" }) else {
      throw StackControlError.invalid("Cloud configuration changed during connection. Reload before connecting again.")
    }
    try manager.saveConfiguration(config, accessKey: access, secretKey: secret, googleRefreshToken: refreshToken)
    manager.isEnabled = true
  }

  private static func dictationFields() -> [String: JSONValue] {
    let c = DictationController.shared.configuration
    return ["dictation.shortcut_key": .string(c.shortcutKeyCode.map { CinderdeckConfigurationShortcutCodec.exportKey(ShortcutConfig(keyCode: UInt32($0), modifiers: 0)) } ?? ""), "dictation.shortcut_modifiers": .array([(NSEvent.ModifierFlags.command, "command"), (.control, "control"), (.option, "option"), (.shift, "shift")].filter { NSEvent.ModifierFlags(rawValue: c.shortcutModifiers).contains($0.0) }.map { .string($0.1) }), "dictation.provider": .string(c.provider.rawValue), "dictation.on_device_only": .bool(c.onDeviceOnly), "dictation.native_language": .string(c.nativeLanguage), "dictation.endpoint": .string(c.endpoint), "dictation.model": .string(c.model), "dictation.format": .string(c.format.rawValue), "dictation.authentication": .string(c.authentication.rawValue), "dictation.header_name": .string(c.headerName), "dictation.language": .string(c.language), "dictation.global_enabled": .bool(c.globalEnabled), "dictation.hold_delay": .number(c.holdDelay)]
  }
  private static func updateDictation(_ changes: JSONValue) throws {
    let current = dictationFields()
    _ = try patchTOML(category: "dictation", changes: changes, current: current)
    var c = DictationController.shared.configuration
    for (id, change) in changes.objectValue ?? [:] {
      let v = change["value"]!
      switch id {
      case "dictation.shortcut_key", "dictation.shortcut_modifiers": break
      case "dictation.provider": guard let p = DictationConfiguration.Provider(rawValue: v.stringValue ?? "") else { throw StackControlError.invalid("Unknown dictation provider") }; c.provider = p
      case "dictation.on_device_only": c.onDeviceOnly = v.boolValue!
      case "dictation.native_language": c.nativeLanguage = v.stringValue!
      case "dictation.endpoint": c.endpoint = v.stringValue!
      case "dictation.model": c.model = v.stringValue!
      case "dictation.format": guard let f = DictationConfiguration.Format(rawValue: v.stringValue ?? "") else { throw StackControlError.invalid("Unknown API format") }; c.format = f
      case "dictation.authentication": guard let a = DictationConfiguration.Authentication(rawValue: v.stringValue ?? "") else { throw StackControlError.invalid("Unknown authentication") }; c.authentication = a
      case "dictation.header_name": c.headerName = v.stringValue!
      case "dictation.language": c.language = v.stringValue!
      case "dictation.global_enabled": c.globalEnabled = v.boolValue!
      case "dictation.hold_delay": guard case .number(let n) = v, (0.2...1).contains(n) else { throw StackControlError.invalid("Hold delay must be between 0.2 and 1 second") }; c.holdDelay = n
      default: throw StackControlError.invalid("Unknown dictation setting")
      }
    }
    let key = changes["dictation.shortcut_key"]?["value"]?.stringValue ?? current["dictation.shortcut_key"]!.stringValue!
    let modifierValue = changes["dictation.shortcut_modifiers"]?["value"] ?? current["dictation.shortcut_modifiers"]!
    guard case .array(let modifiers) = modifierValue else { throw StackControlError.invalid("Choose shortcut modifiers") }
    var flags = NSEvent.ModifierFlags()
    for modifier in modifiers {
      switch modifier.stringValue {
      case "command": flags.insert(.command)
      case "control": flags.insert(.control)
      case "option": flags.insert(.option)
      case "shift": flags.insert(.shift)
      default: throw StackControlError.invalid("Choose valid shortcut modifiers")
      }
    }
    if key.isEmpty { c.shortcutKeyCode = nil }
    else {
      guard let shortcut = CinderdeckConfigurationShortcutCodec.shortcut(key: key, modifiers: modifiers.compactMap(\.stringValue), requireModifier: true), let keyCode = UInt16(exactly: shortcut.keyCode) else { throw StackControlError.invalid("Choose a key and at least one modifier") }
      if c.globalEnabled, let conflict = GlobalShortcutKind.allCases.first(where: { KeyboardShortcutManager.shared.isShortcutEnabled(for: $0) && KeyboardShortcutManager.shared.shortcut(for: $0) == shortcut }) { throw StackControlError.invalid("That shortcut is already used by " + conflict.displayName) }
      c.shortcutKeyCode = keyCode
    }
    guard !c.globalEnabled || !flags.isEmpty else { throw StackControlError.invalid("Choose at least one modifier for hold-to-talk") }
    c.shortcutModifiers = flags.rawValue
    c.shortcutLabel = [(NSEvent.ModifierFlags.control, "⌃"), (.option, "⌥"), (.shift, "⇧"), (.command, "⌘")].filter { flags.contains($0.0) }.map { $0.1 }.joined() + (key.isEmpty ? " Hold" : " " + key)
    try DictationController.shared.save(c, key: nil)
  }
}
