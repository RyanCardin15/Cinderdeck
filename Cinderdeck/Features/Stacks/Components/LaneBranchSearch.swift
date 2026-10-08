import SwiftUI

/// Local and remote branch names of one repository (or several, merged), read once per sheet.
nonisolated struct LaneBranchCatalog: Equatable, Sendable {
  /// Local branch names, sorted.
  var locals: [String] = []
  /// Remote-tracking names such as "origin/main", sorted.
  var remotes: [String] = []

  init(locals: [String] = [], remotes: [String] = []) { self.locals = locals; self.remotes = remotes }
  init(_ branches: [GitBranch]) {
    locals = branches.filter { !$0.isRemote }.map(\.name)
    remotes = branches.filter(\.isRemote).map(\.displayName)
  }
  static func merged(_ catalogs: [LaneBranchCatalog]) -> LaneBranchCatalog {
    LaneBranchCatalog(locals: Array(Set(catalogs.flatMap(\.locals))).sorted(),
      remotes: Array(Set(catalogs.flatMap(\.remotes))).sorted())
  }

  enum State: Equatable, Sendable { case new, local, remote }
  /// What happens to `branch` in this repository: checked out, tracked from a remote, or created.
  func state(of branch: String) -> State {
    if locals.contains(branch) { return .local }
    if remotes.contains(where: { $0.split(separator: "/", maxSplits: 1).dropFirst().first.map(String.init) == branch }) { return .remote }
    return .new
  }
  /// Local names plus remote names without their remote, for generated-name collisions.
  var names: Set<String> {
    Set(locals).union(remotes.compactMap { $0.split(separator: "/", maxSplits: 1).dropFirst().first.map(String.init) })
  }
}

/// A compact, searchable branch list: local branches first, remotes on search or on request.
/// Large repositories never build thousands of menu items up front.
struct LaneBranchSearchList: View {
  enum Purpose { case startPoint, laneBranch }
  let paths: [URL]
  let purpose: Purpose
  let currentBranch: String?
  let preloaded: LaneBranchCatalog?
  let pick: (String) -> Void
  var fetched: (() -> Void)? = nil
  @State private var catalog: LaneBranchCatalog?
  @State private var query = ""
  @State private var showRemotes = false
  @State private var fetching = false
  @State private var problem: String?
  @FocusState private var focused: Bool
  private static let limit = 200

  private var trimmed: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
  private func matches(_ name: String) -> Bool { trimmed.isEmpty || name.localizedCaseInsensitiveContains(trimmed) }
  private var locals: [String] { (catalog?.locals ?? []).filter(matches) }
  private var remotes: [String] { showRemotes || !trimmed.isEmpty ? (catalog?.remotes ?? []).filter(matches) : [] }
  /// Remote picks become local branch names when choosing the lane's own branch.
  private func value(remote: String) -> String {
    purpose == .laneBranch ? remote.split(separator: "/", maxSplits: 1).dropFirst().joined() : remote
  }
  private var firstMatch: String? {
    if let local = locals.first { return local }
    if let remote = remotes.first { return value(remote: remote) }
    return trimmed.isEmpty ? nil : trimmed
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        TextField(purpose == .laneBranch ? "Search existing branches" : "Search branches, or type a tag or commit", text: $query)
          .textFieldStyle(.roundedBorder).focused($focused)
          .onSubmit { if let firstMatch { pick(firstMatch) } }
          .accessibilityIdentifier("lane.branchSearch.query")
        Button { Task { await fetch() } } label: {
          if fetching { ProgressView().controlSize(.small) } else { Image(systemName: "arrow.down.circle") }
        }.buttonStyle(.borderless).disabled(fetching).help("Fetch remote branches")
          .accessibilityLabel("Fetch remote branches")
      }
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 2) {
          if purpose == .startPoint && trimmed.isEmpty {
            row("Current branch" + (currentBranch.map { " (\($0))" } ?? ""), icon: "smallcircle.filled.circle") { pick("HEAD") }
          }
          if catalog == nil {
            ProgressView("Reading branches…").controlSize(.small).padding(6)
          }
          ForEach(locals.prefix(Self.limit), id: \.self) { name in
            row(name, icon: "arrow.triangle.branch") { pick(name) }
          }
          if !remotes.isEmpty {
            Text("Remote").font(.caption2.weight(.semibold)).foregroundStyle(.secondary).padding(.top, 6)
            ForEach(remotes.prefix(Self.limit), id: \.self) { name in
              row(name, icon: "cloud") { pick(value(remote: name)) }
            }
          }
          if !trimmed.isEmpty, !locals.contains(trimmed), !remotes.contains(trimmed) {
            row(purpose == .laneBranch ? "New branch “\(trimmed)”" : "Use “\(trimmed)”", icon: "plus") { pick(trimmed) }
          }
          if locals.count > Self.limit || remotes.count > Self.limit {
            Text("Showing the first \(Self.limit). Type to narrow the list.").font(.caption).foregroundStyle(.secondary)
          }
        }
      }.frame(height: 260)
      HStack {
        if catalog?.remotes.isEmpty == false && trimmed.isEmpty {
          Toggle("Show remote branches", isOn: $showRemotes).toggleStyle(.checkbox).font(.caption)
        }
        Spacer()
        if let problem { Text(problem).font(.caption).foregroundStyle(.red).lineLimit(2) }
      }
    }
    .padding(12).frame(width: 340)
    .task {
      focused = true
      if let preloaded { catalog = preloaded } else { await load() }
    }
  }

  private func row(_ title: String, icon: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Label(title, systemImage: icon).lineLimit(1).truncationMode(.middle)
        .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
        .padding(.vertical, 3).padding(.horizontal, 6)
    }.buttonStyle(.plain)
  }

  private func load() async {
    do {
      let lists = try await StackLaneStore.mapRepositories(paths) { try await LaneBranchReader.shared.branches(at: $0) }
      catalog = .merged(lists.map(LaneBranchCatalog.init))
      problem = nil
    } catch { catalog = LaneBranchCatalog(); problem = "Could not read branches: \(error.localizedDescription)" }
  }

  private func fetch() async {
    fetching = true; defer { fetching = false }
    do {
      _ = try await StackLaneStore.mapRepositories(paths) { try await LaneBranchReader.shared.fetch(at: $0) }
      problem = nil
    } catch { problem = "Fetch failed: \(error.localizedDescription)" }
    await load()
    showRemotes = true
    fetched?()
  }
}

/// A start-point chooser: the current branch by default, any branch, tag or commit on request.
/// Branches are read only when the popover opens, unless the sheet already has them.
struct LaneBaseBranchPicker: View {
  let path: URL
  @Binding var selection: String
  let label: String
  var currentBranch: String? = nil
  var catalog: LaneBranchCatalog? = nil
  var fetched: (() -> Void)? = nil
  @State private var open = false

  private var title: String {
    selection == "HEAD" ? "Current branch" + (currentBranch.map { " (\($0))" } ?? "") : selection
  }

  var body: some View {
    Button { open = true } label: {
      HStack(spacing: 4) {
        Text(title).lineLimit(1).truncationMode(.middle)
        Image(systemName: "chevron.up.chevron.down").font(.caption2).foregroundStyle(.secondary)
      }.frame(minWidth: 160, maxWidth: 280, alignment: .leading)
    }
    .accessibilityLabel(label).accessibilityValue(title)
    .help("Start new branches from this branch, tag or commit")
    .popover(isPresented: $open, arrowEdge: .bottom) {
      LaneBranchSearchList(paths: [path], purpose: .startPoint, currentBranch: currentBranch, preloaded: catalog,
        pick: { selection = $0; open = false }, fetched: fetched)
    }
  }
}
