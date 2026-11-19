import Foundation

enum CapturePromptPreferences {
  static let compactKey = "capturePromptCompactPreview"
  static let presetsKey = "capturePromptPresets"

  #if DEBUG
  private static var previewDefaults: UserDefaults?

  static func usePreviewStore(root: URL) {
    previewDefaults = UserDefaults(suiteName: "com.ryancardin.cinderdeck.capture-preview." + root.lastPathComponent)
  }
  #endif

  static var store: UserDefaults {
    #if DEBUG
    if let previewDefaults { return previewDefaults }
    #endif
    return .standard
  }

  struct Preset: Codable {
    let id: UUID
    let title: String
    let prompt: String
  }

  struct Presets: Codable {
    let presets: [Preset]
    let defaultID: UUID?
  }

  static let builtInPresets = """
    {"presets":[
      {"id":"9b43e9a2-fa23-4dcd-8dbb-5527102706b6","title":"Visual bug","prompt":"Investigate the visual bug shown in this capture. Find the relevant code, explain the likely cause, and propose a fix."},
      {"id":"b1f3b759-6f6c-404a-a55b-6fdf8197a6a2","title":"UI review","prompt":"Review this interface for layout, accessibility, and interaction issues. Prioritize the most actionable findings."},
      {"id":"a5ced317-b8aa-4bc0-9da3-4f702ed67024","title":"Explain","prompt":"Explain what this capture shows and identify the relevant parts of the project."}
    ]}
    """

  struct Snapshot: Codable, Equatable {
    let compact: Bool
    let presets: String

    var json: JSONValue { .object(["compact": .bool(compact), "presets": .string(presets)]) }
  }

  struct Request: Decodable {
    struct Update: Decodable {
      let expected: Snapshot
      let value: Snapshot
    }

    let requestID: UUID
    let update: Update?
  }

  static func snapshot(defaults: UserDefaults = store) -> Snapshot {
    Snapshot(
      compact: defaults.object(forKey: compactKey) as? Bool ?? true,
      presets: defaults.string(forKey: presetsKey) ?? builtInPresets
    )
  }

  static func handle(_ request: Request, defaults: UserDefaults = store) throws -> Snapshot {
    let saved = snapshot(defaults: defaults)
    guard let update = request.update else { return saved }
    guard update.expected == saved else {
      throw StackControlError(code: "stale_settings", message: "Capture settings changed. Reload the saved values.")
    }
    guard isValid(update.value.presets) else {
      throw StackControlError.invalid("Use up to six named capture prompts, with up to 600 characters each and 5,000 bytes total.")
    }
    defaults.set(update.value.compact, forKey: compactKey)
    defaults.set(update.value.presets, forKey: presetsKey)
    if defaults == .standard {
      CinderdeckConfigurationSyncCoordinator.shared.scheduleSync(reason: .explicitChange)
    }
    return snapshot(defaults: defaults)
  }

  static func isValid(_ source: String) -> Bool {
    guard source.utf8.count <= 5_000,
      let value = try? JSONDecoder().decode(Presets.self, from: Data(source.utf8)),
      value.presets.count <= 6
    else { return false }
    let ids = Set(value.presets.map(\.id))
    return ids.count == value.presets.count
      && (value.defaultID.map(ids.contains) ?? true)
      && value.presets.allSatisfy {
        !$0.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
          && !$0.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
          && $0.title.utf16.count <= 32
          && $0.prompt.utf16.count <= 600
      }
  }
}
