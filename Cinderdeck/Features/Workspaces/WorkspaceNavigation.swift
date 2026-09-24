import Foundation

/// Runtime definitions include lane snapshots and definitions rooted in their
/// worktrees. Keep those contexts under their source workspace in navigation.
struct WorkspaceNavigation {
  let workspaces: [StackDefinitionFile]
  let unattachedLanes: [StackDefinitionFile]
  private let files: [StackDefinitionFile]
  private let sourceIDs: [String: String]

  init(files: [StackDefinitionFile], lanesDirectory: URL) {
    self.files = files
    let lanes = files.compactMap(\.lane)
    var sourceIDs: [String: String] = [:]
    var laneIDs = Set<String>()
    for file in files {
      if let lane = file.lane {
        sourceIDs[file.id] = lane.sourceStackID
        laneIDs.insert(file.id)
      } else if let root = file.definition?.root,
        let owner = lanes.filter({ Self.contains(root, in: $0.directory) })
          .max(by: { $0.directory.pathComponents.count < $1.directory.pathComponents.count }) {
        sourceIDs[file.id] = owner.sourceStackID
        laneIDs.insert(file.id)
      } else if Self.contains(file.file, in: lanesDirectory)
        || file.definition.map({ Self.contains($0.root, in: lanesDirectory) }) == true {
        // Damaged records and orphaned lane folders must remain inspectable,
        // without being presented as ordinary workspaces.
        laneIDs.insert(file.id)
      }
    }
    self.sourceIDs = sourceIDs
    workspaces = files.filter { !laneIDs.contains($0.id) }
    let workspaceIDs = Set(workspaces.map(\.id))
    unattachedLanes = files.filter {
      laneIDs.contains($0.id) && !workspaceIDs.contains(sourceIDs[$0.id] ?? "")
    }
  }

  func workspaceID(for id: String?) -> String? {
    guard let id else { return nil }
    return sourceIDs[id] ?? workspaces.first { $0.id == id }?.id
  }

  func lanes(for workspaceID: String) -> [StackDefinitionFile] {
    files.filter { sourceIDs[$0.id] == workspaceID }
  }

  private static func contains(_ path: URL, in directory: URL) -> Bool {
    path.standardizedFileURL.pathComponents.starts(with: directory.standardizedFileURL.pathComponents)
  }
}
