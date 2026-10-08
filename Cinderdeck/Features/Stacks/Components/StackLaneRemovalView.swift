import SwiftUI

struct StackLaneRemovalRequest: Identifiable {
  let file: StackDefinitionFile
  var keepWorktrees = true
  var id: String { file.id }
}

/// One confirmation flow for lane cards, navigation menus and the execution map.
struct StackLaneRemovalView: View {
  let request: StackLaneRemovalRequest
  @ObservedObject var viewModel: StacksViewModel
  @Environment(\.dismiss) private var dismiss
  @State private var ignored: [StackLaneIgnoredEntry] = []
  @State private var discardIgnored = false
  @State private var keepWorktrees: Bool
  @State private var deleteLogs = false
  @State private var checking = true
  @State private var working = false
  @State private var error: String?
  @State private var warnings: [String] = []
  @State private var removed = false

  private var name: String { request.file.lane?.name ?? request.file.name }
  private var entryOnly: Bool { request.file.lane == nil }

  init(request: StackLaneRemovalRequest, viewModel: StacksViewModel) {
    self.request = request
    self.viewModel = viewModel
    _keepWorktrees = State(initialValue: request.keepWorktrees)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      DeckSheetHeader(icon: "trash", title: removed ? "Lane removed" : "Remove lane “\(name)”?",
        detail: entryOnly
          ? "Remove its saved entry. Project files and worktrees stay on disk."
          : "This lane’s services will stop. Choose what happens to its files.")
        .padding(24)
      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          if !removed, !entryOnly {
            DeckSectionLabel(title: "Worktree files")
            removalChoice(keep: true, title: "Keep worktrees and their files",
              detail: "Remove the lane from Cinderdeck. Leave its folders on disk.")
            removalChoice(keep: false, title: "Delete managed worktrees",
              detail: "Delete folders created for this lane. Changed source files block deletion.")
            if checking { ProgressView("Checking lane files…").controlSize(.small) }
            if !keepWorktrees, !ignored.isEmpty {
              VStack(alignment: .leading, spacing: 10) {
                let total = ignored.compactMap(\.bytes).reduce(0, +)
                Toggle("Also delete ignored and changed copied files", isOn: $discardIgnored)
                  .toggleStyle(.checkbox).font(DeckStyle.body).disabled(working)
                  .frame(maxWidth: .infinity, alignment: .leading)
                Text("\(ignored.count) file\(ignored.count == 1 ? "" : "s") · \(ByteCountFormatter.string(fromByteCount: total, countStyle: .file))")
                  .font(DeckStyle.caption).foregroundStyle(.secondary)
                DisclosureGroup("View files") {
                  VStack(alignment: .leading, spacing: 6) {
                    ForEach(ignored, id: \.path) { entry in
                      HStack(alignment: .top) {
                        Text(entry.path).lineLimit(2).truncationMode(.middle)
                        Spacer()
                        if let note = entry.note { Text(note).foregroundStyle(DeckStyle.warning) }
                        if let bytes = entry.bytes { Text(ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)).foregroundStyle(.secondary) }
                      }.font(.system(size: 11, design: .monospaced))
                    }
                  }.padding(.top, 8)
                }.font(DeckStyle.caption)
              }.padding(14).background(DeckStyle.inset, in: RoundedRectangle(cornerRadius: 10))
            }
            Text("Git branches and adopted or shared worktrees are kept. Logs are kept unless you choose to delete them below. Active agents, runs, or shared services may prevent removal.")
              .font(DeckStyle.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if !keepWorktrees, let teardown = request.file.definition?.laneSettings?.teardown {
              Text("The lane’s teardown task (\(teardown)) will run before deletion.")
                .font(DeckStyle.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            DisclosureGroup("Service logs") {
              Toggle("Delete this lane’s service logs", isOn: $deleteLogs)
                .toggleStyle(.checkbox).font(DeckStyle.body).disabled(checking || working)
                .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 8)
            }.font(DeckStyle.caption)
          }
          if let error { Label(error, systemImage: "exclamationmark.circle").foregroundStyle(DeckStyle.danger).textSelection(.enabled).fixedSize(horizontal: false, vertical: true) }
          ForEach(warnings, id: \.self) { Text($0).foregroundStyle(DeckStyle.warning).fixedSize(horizontal: false, vertical: true) }
        }.padding(.horizontal, 24).padding(.bottom, 24)
      }.frame(maxHeight: 360)
      Divider()
      HStack(spacing: 10) {
        if working { ProgressView().controlSize(.small) }
        Spacer()
        Button(removed ? "Done" : "Cancel", role: .cancel) { dismiss() }
          .keyboardShortcut(.cancelAction).disabled(working)
        if !removed {
          Button(working ? "Removing…" : keepWorktrees || entryOnly ? "Remove lane" : "Delete lane & worktrees", role: .destructive) { remove() }
            .buttonStyle(.borderedProminent).tint(DeckStyle.danger)
            .disabled(checking || working || (!keepWorktrees && error != nil) || (!keepWorktrees && !ignored.isEmpty && !discardIgnored))
            .accessibilityIdentifier("stacks.laneRemoval.confirm")
        }
      }.controlSize(.large).padding(.horizontal, 24).padding(.vertical, 16).background(DeckStyle.inset)
    }.frame(width: 540).background(DeckStyle.canvas)
      .interactiveDismissDisabled(working)
      .task(id: keepWorktrees) { await prepare() }
  }

  private func removalChoice(keep: Bool, title: String, detail: String) -> some View {
    Button {
      keepWorktrees = keep
      discardIgnored = false
    } label: {
      HStack(alignment: .top, spacing: 12) {
        Image(systemName: keepWorktrees == keep ? "largecircle.fill.circle" : "circle")
          .foregroundStyle(keepWorktrees == keep ? DeckStyle.accent : Color.secondary).padding(.top, 2)
        VStack(alignment: .leading, spacing: 4) {
          Text(title).font(.system(size: 13, weight: .semibold)).foregroundStyle(.primary)
          Text(detail).font(DeckStyle.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        Spacer(minLength: 0)
      }.frame(maxWidth: .infinity, alignment: .leading).padding(14)
        .deckSurface(radius: 10, selected: keepWorktrees == keep)
        .contentShape(Rectangle())
    }.buttonStyle(.plain).disabled(working)
      .accessibilityLabel(title).accessibilityValue(keepWorktrees == keep ? "Selected" : "Not selected")
  }

  private func prepare() async {
    checking = true
    error = nil
    ignored = []
    defer { if !Task.isCancelled { checking = false } }
    guard !entryOnly else { return }
    do {
      guard let record = try StackLaneStore.record(id: request.id, in: viewModel.supervisor.lanesDirectory) else {
        throw StackError.message("This lane is no longer available.")
      }
      if !keepWorktrees {
        let entries = try await StackLaneStore.check(record,
          others: try StackLaneStore.records(in: viewModel.supervisor.lanesDirectory), options: .init(discardIgnored: true))
        guard !Task.isCancelled else { return }
        ignored = entries
      }
    } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
  }

  private func remove() {
    guard !working, !checking, keepWorktrees || error == nil,
      keepWorktrees || ignored.isEmpty || discardIgnored else { return }
    working = true
    error = nil
    let options = StackLaneRemovalOptions(discardIgnored: discardIgnored, keepWorktrees: keepWorktrees, deleteLogs: deleteLogs)
    Task {
      defer { working = false }
      do {
        if entryOnly {
          try await StackControlService.shared.removeLaneEntry(request.id, actor: .user)
          dismiss()
          return
        }
        let report = try await StackControlService.shared.lanes.remove(request.id, actor: .user, options: options)

        removed = true
        warnings = report.unpushed.sorted { $0.key < $1.key }.map {
          "\($0.key) has \($0.value) commit\($0.value == 1 ? "" : "s") on no remote. The branch was kept."
        }
        if warnings.isEmpty { dismiss() }
      } catch { self.error = error.localizedDescription }
    }
  }
}

/// New lane for any workspace or lane (its original workspace), and Delete for lanes.
struct StackLaneDeletionMenu: View {
  let file: StackDefinitionFile
  @ObservedObject var model: StacksViewModel
  var body: some View {
    Button("New lane…") { model.newLane(from: file) }
      .disabled(model.supervisor.isBootstrapping).accessibilityIdentifier("workspace.lane.new.\(file.id)")
    if model.workspaceNavigation.isLane(file.id) {
      Button("Delete lane…", role: .destructive) { model.deleteLane(file) }
        .disabled(model.isBusy(file.id)).accessibilityIdentifier("workspace.lane.delete.\(file.id)")
    }
  }
}
