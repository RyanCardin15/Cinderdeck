import Foundation

/// Runtime definitions include lane snapshots and definitions rooted in their
/// worktrees. Keep those contexts under their source workspace in navigation.
struct WorkspaceNavigation {
  let workspaces: [StackDefinitionFile]
  let unattachedLanes: [StackDefinitionFile]
  private let sourceIDs: [String: String]
  private let workspaceIDs: Set<String>
  private let laneIDs: Set<String>
  private let unattachedIDs: Set<String>
  private let lanesByWorkspace: [String: [StackDefinitionFile]]

  init(files: [StackDefinitionFile], lanesDirectory: URL) {
    let lanes = files.compactMap(\.lane)
    var sourceIDs: [String: String] = [:]
    var laneIDs = Set<String>()
    for file in files {
      if let lane = file.lane {
        sourceIDs[file.id] = lane.sourceStackID
        laneIDs.insert(file.id)
      } else if let parent = file.parentWorkspaceID {
        sourceIDs[file.id] = parent
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
    self.workspaceIDs = workspaceIDs
    self.laneIDs = laneIDs
    unattachedLanes = files.filter {
      laneIDs.contains($0.id) && !workspaceIDs.contains(sourceIDs[$0.id] ?? "")
    }
    unattachedIDs = Set(unattachedLanes.map(\.id))
    lanesByWorkspace = Dictionary(grouping: files.filter { sourceIDs[$0.id] != nil }, by: { sourceIDs[$0.id]! })
  }

  func workspaceID(for id: String?) -> String? {
    guard let id else { return nil }
    return sourceIDs[id] ?? (workspaceIDs.contains(id) ? id : nil)
  }

  func lanes(for workspaceID: String) -> [StackDefinitionFile] {
    lanesByWorkspace[workspaceID] ?? []
  }

  func isLane(_ id: String) -> Bool { laneIDs.contains(id) }

  func isUnattached(_ id: String) -> Bool { unattachedIDs.contains(id) }

  private static func contains(_ path: URL, in directory: URL) -> Bool {
    path.standardizedFileURL.pathComponents.starts(with: directory.standardizedFileURL.pathComponents)
  }
}
