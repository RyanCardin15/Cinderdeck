import AppKit
import SwiftUI

struct WorkspaceLinkedWorkView: View {
  let workspaceID: String
  @ObservedObject private var store = StackControlService.shared.linkedWork
  @State private var generation: Int?
  @State private var epoch: String?
  @State private var available = false
  @State private var error: String?
  @State private var development = false
  private var rows: [IntegrationLinkedWorkRecord] {
    store.records.filter { $0.publication.workspaceID == workspaceID }.prefix(256).map { $0 }
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack {
        Label("Linked conversations", systemImage: "person.2.badge.gearshape").font(DeckStyle.section)
        Spacer()
        Toggle("Development app", isOn: $development).toggleStyle(.checkbox).font(.caption)
        Button("Refresh context") { Task { await refresh() } }
      }
      if let message = error ?? store.error { Text(message).foregroundStyle(.orange).textSelection(.enabled) }
      if rows.isEmpty {
        VStack(alignment: .leading, spacing: 8) {
          Text("A place for the work behind this workspace").font(.title3.weight(.semibold))
          Text("Open this workspace in Deckhand and start a connected conversation. Its session, committed heads, and linked artifacts will appear here.")
            .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }.padding(20).frame(maxWidth: .infinity, alignment: .leading).background(DeckStyle.hover, in: RoundedRectangle(cornerRadius: 12))
      } else {
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 12) {
            ForEach(rows) { record in
              TimelineView(.periodic(from: .now, by: 15)) { timeline in
                card(record, now: timeline.date)
              }
            }
          }
        }
      }
    }.task(id: workspaceID) { await refresh() }
  }
  private func refresh() async {
    do {
      let journal = try StackControlService.shared.integrationStore()
      StackControlService.shared.integrationProjectionRevision += 1
      let revision = StackControlService.shared.integrationProjectionRevision
      try await journal.reconcile(StackControlService.shared.snapshot().workspaces, sourceRevision: revision)
      let snapshot = try await journal.snapshot(workspaceID: workspaceID, offset: 0, limit: 1)
      generation = snapshot.resources.first?.generation
      available = snapshot.resources.first?.available == true
      epoch = journal.runtimeEpoch
      error = nil
    } catch { self.error = "Workspace context is unavailable. Saved conversations remain visible."; available = false }
  }
  private func card(_ record: IntegrationLinkedWorkRecord, now: Date) -> some View {
    let work = record.publication
    let current = available && generation == work.generation && epoch == record.runtimeEpoch && now.timeIntervalSince(record.observedAt) >= 0 && now.timeIntervalSince(record.observedAt) < 90
    return VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top) {
        VStack(alignment: .leading, spacing: 4) {
          Text(work.title).font(.headline).textSelection(.enabled)
          Text("\(work.provider) · \(work.role.capitalized)").font(.caption).foregroundStyle(.secondary)
        }
        Spacer()
        Label(current ? work.execution.replacingOccurrences(of: "_", with: " ").capitalized : "Last observed",
          systemImage: current && work.execution == "working" ? "circle.fill" : "clock")
          .font(.caption).foregroundStyle(current ? DeckStyle.accent : Color.secondary)
        Button("Open in Deckhand") {
          guard let url = work.deckhandURL(development: development), NSWorkspace.shared.open(url) else {
            error = "Deckhand could not be opened. Install the selected app or launch it once to register its link handler."; return
          }
        }.buttonStyle(.borderedProminent)
      }
      HStack(spacing: 12) {
        Text(record.observedAt, style: .relative).font(.caption).foregroundStyle(.secondary)
        Text("Generation \(work.generation)").font(.caption.monospaced()).foregroundStyle(.secondary)
        if !current { Text("Refresh the conversation in Deckhand for current state.").font(.caption).foregroundStyle(.secondary) }
      }
      ForEach(work.repositories, id: \.repositoryID) { repo in
        HStack { Image(systemName: "arrow.triangle.branch"); Text(repo.repositoryID); Spacer(); Text(repo.head.map { String($0.prefix(12)) } ?? "Head unavailable").monospaced() }
          .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
      }
      if !work.pullRequests.isEmpty || !work.recordingIDs.isEmpty {
        HStack {
          ForEach(work.pullRequests, id: \.url) { pr in
            if let url = URL(string: pr.url) { Link("\(pr.repository) #\(pr.number)", destination: url).font(.caption) }
          }
          ForEach(work.recordingIDs, id: \.self) { id in
            Button("Recording \(id.prefix(8))") {
              guard let uuid = UUID(uuidString: id), let recording = ReproStore.shared.loadSession(uuid) else { error = "This linked recording is no longer available."; return }
              ReproLibraryActions.open(recording)
            }.font(.caption)
          }
        }
      }
    }.padding(16).frame(maxWidth: .infinity, alignment: .leading).background(DeckStyle.hover, in: RoundedRectangle(cornerRadius: 12))
  }
}


/// Explicit persisted associations enrich native inspectors without guessing from branches.
struct NativeLinkedWorkSection: View {
  let target: NativeLinkedWorkTarget
  @ObservedObject private var store = StackControlService.shared.linkedWork
  @State private var development = false
  @State private var error: String?
  private var rows: [IntegrationLinkedWorkRecord] {
    Array(store.records.lazy.filter { $0.publication.isAssociated(with: target) }.prefix(20))
  }
  var body: some View {
    if !rows.isEmpty || store.error != nil {
      VStack(alignment: .leading, spacing: 12) {
        HStack {
          Label("Linked conversations", systemImage: "person.2").font(DeckStyle.section)
          Spacer()
          Toggle("Development app", isOn: $development).toggleStyle(.checkbox).font(.caption)
        }
        if let message = error ?? store.error {
          Text(message).font(.caption).foregroundStyle(.orange).textSelection(.enabled)
        }
        ForEach(rows) { record in
          VStack(alignment: .leading, spacing: 7) {
            Text(record.publication.title).font(.headline).lineLimit(2)
            Text("\(record.publication.provider) · \(record.publication.role.capitalized)")
              .font(.caption).foregroundStyle(.secondary)
            HStack {
              Text("Last observed ").font(.caption).foregroundStyle(.secondary)
              Text(record.observedAt, style: .relative).font(.caption).foregroundStyle(.secondary)
              Spacer()
              Button("Open in Deckhand") {
                guard let url = record.publication.deckhandURL(development: development), NSWorkspace.shared.open(url) else {
                  error = "Deckhand could not be opened. Launch the selected app once to register its links."; return
                }
              }.buttonStyle(DeckButtonStyle(compact: true))
            }
          }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
            .background(DeckStyle.inset, in: RoundedRectangle(cornerRadius: DeckStyle.cardRadius))
        }
        Text("Saved links preserve the original lane. Deckhand checks its current identity when opened.")
          .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      }
    }
  }
}
