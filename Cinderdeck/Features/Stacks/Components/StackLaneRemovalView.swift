import SwiftUI

struct StackLaneRemovalRequest: Identifiable {
  let file: StackDefinitionFile
  var keepWorktrees = false
  var id: String { file.id }
}

/// One confirmation flow for lane cards, navigation menus and the execution map.
struct StackLaneRemovalView: View {
  let request: StackLaneRemovalRequest
  @ObservedObject var viewModel: StacksViewModel
  @Environment(\.dismiss) private var dismiss
  @State private var ignored: [StackLaneIgnoredEntry] = []
  @State private var discardIgnored = true
  @State private var deleteLogs = false
  @State private var checking = true
  @State private var working = false
  @State private var error: String?
  @State private var warnings: [String] = []
  @State private var removed = false

  private var name: String { request.file.lane?.name ?? request.file.name }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(removed ? "\(name) \(request.keepWorktrees ? "released" : "deleted")"
        : "\(request.keepWorktrees ? "Release" : "Delete") \(name)?").font(.headline)
      if !removed {
        Text(request.keepWorktrees
          ? "Stops only this lane and forgets it. Its worktrees and files stay on disk; Git branches are kept."
          : "Stops only this lane\(request.file.definition?.laneSettings?.teardown.map { ", runs teardown (\($0))," } ?? ""), and removes its worktrees. Git branches and adopted worktrees are kept. Tracked or untracked changes block deletion.")
          .fixedSize(horizontal: false, vertical: true)
        if checking {
          ProgressView("Checking lane files…").controlSize(.small)
        } else if !request.keepWorktrees, !ignored.isEmpty {
          let total = ignored.compactMap(\.bytes).reduce(0, +)
          Toggle("Delete ignored files (\(ByteCountFormatter.string(fromByteCount: total, countStyle: .file)))", isOn: $discardIgnored)
            .disabled(working)
          ScrollView {
            VStack(alignment: .leading, spacing: 2) {
              ForEach(ignored, id: \.path) { entry in
                HStack {
                  Text(entry.path).lineLimit(1).truncationMode(.head)
                  Spacer()
                  if let note = entry.note { Text(note).foregroundColor(.orange) }
                  if let bytes = entry.bytes { Text(ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)).foregroundColor(.secondary) }
                }.font(.caption.monospaced())
              }
            }
          }.frame(maxHeight: 160)
        }
        Toggle("Delete this lane's service logs", isOn: $deleteLogs).disabled(checking || working)
      }
      if let error { Text(error).foregroundColor(.red).textSelection(.enabled).fixedSize(horizontal: false, vertical: true) }
      ForEach(warnings, id: \.self) { Text($0).foregroundColor(.orange).fixedSize(horizontal: false, vertical: true) }
      HStack {
        if working { ProgressView().controlSize(.small) }
        Spacer()
        Button(removed ? "Done" : "Cancel", role: .cancel) { dismiss() }
          .keyboardShortcut(.cancelAction).disabled(working)
        if !removed {
          Button(request.keepWorktrees ? "Stop and release" : "Stop and delete", role: .destructive) { remove() }
            .disabled(checking || working || error != nil || (!request.keepWorktrees && !ignored.isEmpty && !discardIgnored))
            .keyboardShortcut(.defaultAction).accessibilityIdentifier("stacks.laneRemoval.confirm")
        }
      }
    }.padding(20).frame(width: 560)
      .interactiveDismissDisabled(working)
      .task { await prepare() }
  }

  private func prepare() async {
    defer { checking = false }
    do {
      guard let record = try StackLaneStore.record(id: request.id, in: viewModel.supervisor.lanesDirectory) else {
        throw StackError.message("This lane is no longer available.")
      }
      if !request.keepWorktrees {
        ignored = try await StackLaneStore.check(record,
          others: try StackLaneStore.records(in: viewModel.supervisor.lanesDirectory), options: .init(discardIgnored: true))
      }
    } catch { self.error = error.localizedDescription }
  }

  private func remove() {
    working = true
    let options = StackLaneRemovalOptions(discardIgnored: discardIgnored, keepWorktrees: request.keepWorktrees, deleteLogs: deleteLogs)
    Task {
      defer { working = false }
      do {
        let report = try await StackControlService.shared.lanes.remove(request.id, actor: .user, options: options)
        StackControlService.shared.release(stack: request.id)
        removed = true
        warnings = report.unpushed.sorted { $0.key < $1.key }.map {
          "\($0.key) has \($0.value) commit\($0.value == 1 ? "" : "s") on no remote. The branch was kept."
        }
        if warnings.isEmpty { dismiss() }
      } catch { self.error = error.localizedDescription }
    }
  }
}

struct StackLaneDeletionMenu: View {
  let file: StackDefinitionFile
  @ObservedObject var model: StacksViewModel
  var body: some View {
    if file.lane != nil {
      Button("Delete lane…", role: .destructive) { model.deleteLane(file) }
        .disabled(model.isBusy(file.id)).accessibilityIdentifier("workspace.lane.delete.\(file.id)")
    }
  }
}
