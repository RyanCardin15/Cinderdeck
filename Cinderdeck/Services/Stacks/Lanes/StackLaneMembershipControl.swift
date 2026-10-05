import Foundation

extension StackControlService {
  /// Repair membership without recreating the lane or moving its worktrees.
  func attachLane(_ id: String, to workspace: String, actor: StackActor) async throws {
    try await supervisor.withDefinitionLock(workspace: id) {
      let files = try StackWorkspaceResolver.load(supervisor.definitionsDirectory)
      let navigation = WorkspaceNavigation(files: files, lanesDirectory: supervisor.lanesDirectory)
      guard let file = navigation.unattachedLanes.first(where: { $0.id == id }) else {
        throw StackError.message("This lane is no longer without a workspace. Refresh and try again.")
      }
      guard let source = navigation.workspaces.first(where: { $0.id == workspace })?.definition else {
        throw StackError.message("Choose an available workspace with a valid definition.")
      }


      try requireStoppedForDefinition(id)
      if var record = try StackLaneStore.record(id: id, in: supervisor.lanesDirectory) {
        let others = try StackLaneStore.records(in: supervisor.lanesDirectory)
        guard !others.contains(where: { $0.id != id && $0.info.sourceStackID == workspace
          && $0.info.name.caseInsensitiveCompare(record.info.name) == .orderedSame }) else {
          throw StackError.message("That workspace already has a lane named \(record.info.name).")
        }
        let roots = source.repos.isEmpty ? [source.root] : source.repos.filter { $0.laneMode == .worktree }.map(\.path)
        guard !roots.isEmpty, roots.allSatisfy({ StackLaneStore.remap($0, worktrees: record.worktrees) != nil }) else {
          throw StackError.message("This workspace uses different repositories. Choose the workspace for this lane's original repositories.")
        }
        record.info.sourceStackID = workspace
        record.info.host = source.laneSettings?.hosts == true
          ? "\(record.info.effectiveSlug).\(StackLaneInfo.hostLabel(workspace)).localhost" : nil
        if !record.info.pinned {
          let used = Set(others.flatMap { $0.info.ports.values }
            + files.compactMap(\.definition).flatMap { definition in
              definition.services.flatMap { $0.allPorts.values } + definition.tasks.flatMap { $0.allPorts.values }
            })
          record.info.ports = try StackLaneStore.extend(record.info.ports,
            adding: StackLaneStore.requiredPortKeys(source, worktrees: record.worktrees), excluding: used)
          let derived = StackLaneStore.derive(record, source: source)
          let candidate = StackDefinitionFile(id: id, file: source.file, definition: derived.definition, issues: derived.issues)
          let resolved = StackWorkspaceResolver.resolve(files.filter { $0.id != id } + [candidate])
          let errors = resolved.first { $0.id == id }?.issues.filter { $0.severity == .error } ?? []
          guard errors.isEmpty else { throw StackError.message(errors.map(\.message).joined(separator: "\n")) }
        }
        try StackLaneStore.write(record, in: supervisor.lanesDirectory)
      } else {
        guard file.file.pathExtension.lowercased() == "toml" else {
          throw StackError.message("Repair this lane's record before adding it to a workspace.")
        }
        let original = try String(contentsOf: file.file, encoding: .utf8)
        let updated = try WorkspaceDefinitionWriter.metadata(original, values: ["workspace": workspace])
        try WorkspaceDefinitionWriter.saveSource(file: file.file, original: original, source: updated)
      }
    }
    await supervisor.recordEvent(stack: id, service: nil, kind: "laneAttached", detail: workspace, actor: actor)
  }

  /// An inferred lane or unreadable record has no trustworthy worktree ownership.
  /// Remove only its definition/manifest, leaving all project files on disk.
  func removeLaneEntry(_ id: String, actor: StackActor) async throws {
    let files = try StackWorkspaceResolver.load(supervisor.definitionsDirectory)
    let navigation = WorkspaceNavigation(files: files, lanesDirectory: supervisor.lanesDirectory)
    guard let file = files.first(where: { $0.id == id }), navigation.isLane(id), file.lane == nil else {
      throw StackError.message("This lane changed. Close the confirmation and try again.")
    }
    if file.file.pathExtension.lowercased() == "toml" {
      let revision = WorkspaceDefinitionWriter.revision(try String(contentsOf: file.file, encoding: .utf8))
      _ = try await handleWorkspaceLifecycle("workspace.delete",
        params: .object(["workspace": .string(id), "revision": .string(revision), "lane_entry": .bool(true)]), actor: actor)
    } else {
      try await supervisor.withDefinitionLock(workspace: id) {

        try requireStoppedForDefinition(id)
        guard file.file.standardizedFileURL == StackLaneStore.manifest(id: id, in: supervisor.lanesDirectory).standardizedFileURL,
          (try? StackLaneStore.record(id: id, in: supervisor.lanesDirectory)) == nil else {
          throw StackError.message("This lane changed. Close the confirmation and try again.")
        }
        try FileManager.default.removeItem(at: file.file)
      }

    }
  }
}
