import Foundation
import SwiftUI

/// Filesystem discovery is a presentation snapshot, never part of a text edit.
/// The lane store still validates fresh Git metadata before creating anything.
nonisolated struct LaneCreationRepositories: Equatable, Sendable {
  var repositories: [RepoDefinition]
  var roots: [String: URL]
  var hasIsolatedRepositories: Bool

  func modes(prefilling overrides: [String: StackLaneRepositoryMode]) -> [String: StackLaneRepositoryMode] {
    Dictionary(uniqueKeysWithValues: repositories.map { repo in
      (repo.id, roots[repo.id] == nil ? .reference : overrides[repo.id] ?? (repo.laneMode == .shared ? .reference : .worktree))
    })
  }

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

/// Typing the lane name does not rebuild the rows; only checkout, start point or branch state changes do.
struct LaneCreationRepositoryList: View, Equatable {
  let snapshot: LaneCreationRepositories
  let current: [String: String]
  let catalogs: [String: LaneBranchCatalog]
  let adopting: Bool
  let branch: String
  let branchStates: [String: LaneBranchCatalog.State]
  let progress: [URL: String]
  let selectedBases: [String: String]
  let selectedModes: [String: StackLaneRepositoryMode]
  @Binding var bases: [String: String]
  @Binding var modes: [String: StackLaneRepositoryMode]
  var fetched: (() -> Void)? = nil

  static func == (lhs: Self, rhs: Self) -> Bool {
    lhs.snapshot == rhs.snapshot && lhs.current == rhs.current && lhs.catalogs == rhs.catalogs && lhs.adopting == rhs.adopting
      && lhs.branchStates == rhs.branchStates && lhs.progress == rhs.progress && lhs.selectedBases == rhs.selectedBases
      && lhs.selectedModes == rhs.selectedModes && (lhs.branchStates.values.allSatisfy { $0 == .new } || lhs.branch == rhs.branch)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      ForEach(snapshot.repositories) { repo in
        VStack(alignment: .leading, spacing: 8) {
          HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 3) {
              Label(repo.id, systemImage: "folder").font(.callout.weight(.semibold))
              HStack(spacing: 6) {
                Text(repo.path.path).lineLimit(1).truncationMode(.middle).help(repo.path.path)
                if let branch = current[repo.id] {
                  Label(branch, systemImage: "arrow.triangle.branch").labelStyle(.titleAndIcon).font(.caption.monospaced())
                    .lineLimit(1).fixedSize()
                }
              }.font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Picker("Checkout for \(repo.id)", selection: Binding(
              get: { modes[repo.id] ?? .reference },
              set: { mode in
                modes[repo.id] = mode
                if let root = snapshot.roots[repo.id] {
                  for alias in snapshot.repositories where snapshot.roots[alias.id] == root
                    && !(alias.laneMode == .shared && alias.path.resolvingSymlinksInPath() != root) {
                    modes[alias.id] = mode
                  }
                }
              })) {
              Text("Worktree").tag(StackLaneRepositoryMode.worktree)
                .disabled(snapshot.roots[repo.id] == nil)
              Text("Reference").tag(StackLaneRepositoryMode.reference)
            }.pickerStyle(.segmented).labelsHidden().frame(width: 200)
              .help(snapshot.roots[repo.id] == nil ? "This folder is not in Git, so it can only be a reference."
                : "Worktree: isolated checkout on the lane branch. Reference: original checkout, read-only context.")
              .accessibilityLabel("Checkout for \(repo.id)")
              .accessibilityIdentifier("lane.creation.mode.\(repo.id)")
          }
          if let root = snapshot.roots[repo.id], let status = progress[root] {
            Text(status).font(.caption).foregroundStyle(.secondary)
          }
          detail(repo)
        }.padding(12).background(DeckStyle.surface, in: RoundedRectangle(cornerRadius: 10))
      }
      if snapshot.repositories.isEmpty {
        Text("Add a repository to this workspace before creating a lane.").foregroundStyle(.secondary)
      }
    }
  }

  @ViewBuilder private func detail(_ repo: RepoDefinition) -> some View {
    if modes[repo.id] != .worktree {
      Text("Original checkout, read-only context · no worktree or branch is created.")
        .font(.caption).foregroundStyle(.secondary)
    } else if !adopting, branchStates[repo.id] == .local {
      Label("Checks out the existing branch \(branch) as-is", systemImage: "checkmark.circle")
        .font(.caption).foregroundStyle(.secondary)
    } else if !adopting, branchStates[repo.id] == .remote {
      Label("Tracks the remote branch \(branch)", systemImage: "cloud")
        .font(.caption).foregroundStyle(.secondary)
    } else {
      HStack {
        Text(adopting ? "Start other worktrees from" : "Start from").font(.caption).foregroundStyle(.secondary)
        LaneBaseBranchPicker(path: repo.path, selection: Binding(
          get: { bases[repo.id] ?? "HEAD" }, set: { bases[repo.id] = $0 }), label: "Start point for \(repo.id)",
          currentBranch: current[repo.id], catalog: catalogs[repo.id], fetched: fetched)
          .accessibilityIdentifier("lane.creation.base.\(repo.id)")
        Spacer()
      }
    }
  }
}
