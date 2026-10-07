import Foundation
import SwiftUI

/// Filesystem discovery is a presentation snapshot, never part of a text edit.
/// The lane store still validates fresh Git metadata before creating anything.
nonisolated struct LaneCreationRepositories: Equatable, Sendable {
  var repositories: [RepoDefinition]
  var roots: [String: URL]
  var hasIsolatedRepositories: Bool

  @concurrent static func read(_ source: StackDefinition) async -> Self {
    let explicit = source.repos
    let explicitRoots = explicit.map { WorkspaceDiscovery.repositoryRoot(containing: $0.path) }
    let isolated = WorkspaceSetupModel.laneRepositories(in: source)
    var repositories = explicit
    var roots: [String: URL] = [:]
    for (repo, root) in zip(explicit, explicitRoots) { roots[repo.id] = root }
    for var repo in isolated where !explicitRoots.contains(repo.path) {
      if repositories.contains(where: { $0.id == repo.id }) {
        var suffix = 2
        while repositories.contains(where: { $0.id == "\(repo.id)-\(suffix)" }) { suffix += 1 }
        repo = RepoDefinition(id: "\(repo.id)-\(suffix)", path: repo.path)
      }
      repositories.append(repo)
      roots[repo.id] = repo.path
    }
    return Self(repositories: repositories, roots: roots, hasIsolatedRepositories: !isolated.isEmpty)
  }
}

/// Changing the lane name or branch does not rebuild potentially large pickers.
struct LaneCreationRepositoryList: View, Equatable {
  let snapshot: LaneCreationRepositories
  let current: [String: String]
  let adopting: Bool
  let progress: [URL: String]
  let selectedBases: [String: String]
  @Binding var bases: [String: String]

  static func == (lhs: Self, rhs: Self) -> Bool {
    lhs.snapshot == rhs.snapshot && lhs.current == rhs.current && lhs.adopting == rhs.adopting
      && lhs.progress == rhs.progress && lhs.selectedBases == rhs.selectedBases
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      ForEach(snapshot.repositories) { repo in
        VStack(alignment: .leading, spacing: 8) {
          HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 3) {
              Label(repo.id, systemImage: "folder").font(.callout.weight(.semibold))
              Text(repo.path.path).font(.caption).foregroundStyle(.secondary)
                .lineLimit(1).truncationMode(.middle).help(repo.path.path)
            }
            Spacer()
            Label(current[repo.id] ?? "Reading…", systemImage: "arrow.triangle.branch")
              .font(.caption.monospaced()).foregroundStyle(.secondary)
              .textSelection(.enabled).frame(maxWidth: 250, alignment: .trailing)
          }
          if let root = snapshot.roots[repo.id], let status = progress[root] {
            Text(status).font(.caption).foregroundStyle(.secondary)
          }
          if repo.laneMode == .shared {
            Text("Shared folder · uses the workspace's existing checkout").font(.caption).foregroundStyle(.secondary)
          } else {
            HStack {
              Text(adopting ? "Base for additional worktrees" : "Start from").font(.caption).foregroundStyle(.secondary)
              LaneBaseBranchPicker(path: repo.path, selection: Binding(
                get: { bases[repo.id] ?? "HEAD" }, set: { bases[repo.id] = $0 }), label: "Base branch for \(repo.id)")
                .accessibilityIdentifier("lane.creation.base.\(repo.id)")
              Spacer()
            }
          }
        }.padding(12).background(DeckStyle.surface, in: RoundedRectangle(cornerRadius: 10))
      }
      if !snapshot.hasIsolatedRepositories {
        Text("Add a Git repository to this workspace and choose Isolate in lanes in workspace settings.").foregroundStyle(.secondary)
      }
    }
  }
}
