import AppKit
import Foundation

/// Settings for an exact local source workspace. The existing native writers,
/// definition locks and lifecycle checks remain authoritative.
@MainActor
enum NativeWorkspaceSettings {
  static func handle(_ request: NativeSettingsRequest) async throws -> JSONValue {
    guard request.category == "workspaces", let id = request.payload?["workspace"]?.stringValue,
      let file = StackSupervisor.shared.files.first(where: { $0.id == id }), file.lane == nil else {
      throw StackControlError.invalid("Select an exact source workspace on this Mac")
    }
    var picked: String?
    switch request.action {
    case "workspace-read": break
    case "workspace-pick-folder", "workspace-pick-file":
      let panel = NSOpenPanel()
      panel.canChooseDirectories = request.action == "workspace-pick-folder"
      panel.canChooseFiles = !panel.canChooseDirectories
      panel.allowsMultipleSelection = false
      panel.prompt = "Add to workspace"
      NSApp.activate(ignoringOtherApps: true)
      if panel.runModal() == .OK { picked = panel.url?.path }
    case "workspace-save":
      let original = try String(contentsOf: file.file, encoding: .utf8)
      try requireRevision(request, original: original)
      let source: String
      if let advanced = request.payload?["source"]?.stringValue {
        source = advanced
      } else {
        guard let definition = file.definition, let name = request.payload?["name"]?.stringValue,
          let rawFolders = request.payload?["folders"]?.arrayValue,
          let rawFiles = request.payload?["files"]?.arrayValue else { throw StackControlError.invalid("Invalid workspace settings") }
        let folders = try rawFolders.map { value -> RepoDefinition in
          guard let id = value["id"]?.stringValue, !id.isEmpty, id.utf8.count <= 200,
            let path = value["path"]?.stringValue, path.hasPrefix("/"),
            let lane = value["lane"]?.stringValue.flatMap(StackRepoLaneMode.init(rawValue:)) else {
            throw StackControlError.invalid("Invalid workspace folder")
          }
          return RepoDefinition(id: id, path: URL(fileURLWithPath: path), laneMode: lane,
            laneFrom: value["laneFrom"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 })
        }
        guard Set(folders.map(\.id)).count == folders.count else { throw StackControlError.invalid("Folder identifiers must be unique") }
        let files = try rawFiles.map { value -> URL in
          guard case .string(let path) = value, path.hasPrefix("/") else { throw StackControlError.invalid("Invalid workspace file") }
          return URL(fileURLWithPath: path)
        }
        source = try WorkspaceSettingsWriter.source(original: original, definition: definition, name: name, folders: folders, files: files)
      }
      _ = try await StackControlService.shared.handleWorkspaceLifecycle("workspace.save", params: .object([
        "workspace": .string(id), "revision": .string(WorkspaceDefinitionWriter.revision(original)), "source": .string(source),
      ]), actor: .user)
    case "workspace-review-save":
      guard let definition = file.definition, let content = request.payload?["content"]?.stringValue,
        let revision = request.payload?["reviewRevision"]?.stringValue else { throw StackControlError.invalid("Invalid review instructions") }
      try requireRevision(request, original: String(contentsOf: file.file, encoding: .utf8))
      let saved = try WorkspaceCodeReviewSkill.load(root: definition.root)
      guard reviewRevision(saved.saved) == revision else { throw StackControlError.invalid("Review instructions changed. Reload before saving.") }
      try WorkspaceCodeReviewSkill.save(root: definition.root, original: saved.saved, content: content)
    case "workspace-delete":
      let original = try String(contentsOf: file.file, encoding: .utf8)
      try requireRevision(request, original: original)
      _ = try await StackControlService.shared.handleWorkspaceLifecycle("workspace.delete", params: .object([
        "workspace": .string(id), "revision": .string(WorkspaceDefinitionWriter.revision(original)),
      ]), actor: .user)
      return .object(["category": .string("workspaces"), "fields": .array([]), "status": .object(["removed": .bool(true)])])
    default: throw StackControlError.invalid("Unsupported workspace settings action")
    }
    return try snapshot(id, picked: picked)
  }

  private static func requireRevision(_ request: NativeSettingsRequest, original: String) throws {
    guard request.payload?["revision"]?.stringValue == WorkspaceDefinitionWriter.revision(original) else {
      throw StackControlError.invalid("Workspace changed. Reload and review it before saving.")
    }
  }

  private static func reviewRevision(_ saved: String?) -> String {
    saved.map(WorkspaceDefinitionWriter.revision) ?? "missing"
  }

  private static func snapshot(_ id: String, picked: String?) throws -> JSONValue {
    guard let file = StackSupervisor.shared.files.first(where: { $0.id == id }) else { throw StackControlError.notFound("Workspace is unavailable") }
    let source = try String(contentsOf: file.file, encoding: .utf8)
    guard source.utf8.count <= 64_000 else { throw StackControlError.invalid("This workspace definition is too large for the inline editor. Edit its definition file directly.") }
    var status: [String: JSONValue] = ["workspace": .string(id), "source": .string(source),
      "revision": .string(WorkspaceDefinitionWriter.revision(source)), "file": .string(file.file.path)]
    if let picked { status["picked"] = .string(picked) }
    if let definition = file.definition {
      status["name"] = .string(definition.name)
      status["root"] = .string(definition.root.path)
      let folders: [JSONValue] = definition.repos.map { .object(["id": .string($0.id), "path": .string($0.path.path), "lane": .string($0.laneMode.rawValue), "laneFrom": .string($0.laneFrom ?? "")]) }
      status["folders"] = .string(String(decoding: try JSONEncoder().encode(JSONValue.array(folders)), as: UTF8.self))
      status["files"] = .string(String(decoding: try JSONEncoder().encode(definition.files.map(\.path)), as: UTF8.self))
      do {
        let review = try WorkspaceCodeReviewSkill.load(root: definition.root)
        status["review"] = .string(review.content)
        status["reviewRevision"] = .string(reviewRevision(review.saved))
      } catch { status["reviewError"] = .string(error.localizedDescription) }
    } else { status["definitionError"] = .string(file.issues.map(\.message).joined(separator: "; ")) }
    return .object(["category": .string("workspaces"), "fields": .array([]), "status": .object(status)])
  }
}
