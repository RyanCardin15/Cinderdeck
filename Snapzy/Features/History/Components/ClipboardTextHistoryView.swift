import SwiftUI

struct ClipboardTextHistoryView: View {
  @ObservedObject var manager: HistoryFloatingManager
  @ObservedObject var store = ClipboardTextHistoryStore.shared
  @Binding var selectedID: UUID?
  @AppStorage(PreferencesKeys.clipboardTextHistoryEnabled) private var isEnabled = false
  @State private var copiedID: UUID?
  @Environment(\.colorScheme) private var colorScheme

  private var isExpanded: Bool { manager.presentationMode == .expanded }

  private var records: [ClipboardTextRecord] {
    let query = isExpanded ? manager.searchText.trimmingCharacters(in: .whitespacesAndNewlines) : ""
    let now = Date()
    let filtered = store.records.filter {
      (query.isEmpty || $0.text.localizedCaseInsensitiveContains(query)) &&
        (!isExpanded || manager.expandedTimeFilter.includes($0.copiedAt, relativeTo: now))
    }
    return isExpanded ? filtered : Array(filtered.prefix(manager.maxDisplayedItems))
  }

  private var selectedRecord: ClipboardTextRecord? {
    records.first { $0.id == selectedID }
  }

  var body: some View {
    VStack(spacing: 10) {
      HStack(spacing: 8) {
        Label(isEnabled ? "Saving copied text" : "Clipboard history paused",
              systemImage: isEnabled ? "clipboard" : "pause.circle")
        Text("· \(store.records.count) items · Kept on this Mac for 30 days")
          .foregroundColor(.secondary)
        Spacer()
        Button(isEnabled ? "Pause" : "Resume") { isEnabled.toggle() }
          .buttonStyle(.bordered)
          .controlSize(.small)
      }
      .font(.system(size: 11, weight: .medium))

      if let error = store.errorMessage {
        Label(error, systemImage: "exclamationmark.triangle")
          .font(.caption)
          .foregroundColor(.orange)
      }

      if records.isEmpty {
        emptyState
      } else if isExpanded {
        expandedContent
      } else {
        compactContent
      }
    }
    .onAppear { syncSelection() }
    .onChange(of: records.map(\.id)) { _ in syncSelection() }
    .task(id: copiedID) {
      guard copiedID != nil else { return }
      try? await Task.sleep(nanoseconds: 2_000_000_000)
      guard !Task.isCancelled else { return }
      copiedID = nil
    }
    .onReceive(NotificationCenter.default.publisher(for: .historyCopySelection)) { notification in
      guard notification.object is HistoryFloatingPanel, let record = selectedRecord else { return }
      copy(record)
    }
    .onReceive(NotificationCenter.default.publisher(for: .historyActivateSelection)) { notification in
      guard notification.object is HistoryFloatingPanel, let record = selectedRecord else { return }
      copy(record)
      manager.hide()
    }
    .onReceive(NotificationCenter.default.publisher(for: .historyDeleteSelection)) { notification in
      guard notification.object is HistoryFloatingPanel, let selectedID else { return }
      store.remove(selectedID)
    }
    .onReceive(NotificationCenter.default.publisher(for: .historyMoveClipboardSelection)) { notification in
      guard notification.object is HistoryFloatingPanel,
        let delta = notification.userInfo?["delta"] as? Int, !records.isEmpty else { return }
      let index = records.firstIndex { $0.id == selectedID } ?? 0
      selectedID = records[min(max(index + delta, 0), records.count - 1)].id
    }
  }

  private var emptyState: some View {
    VStack(spacing: 10) {
      Image(systemName: "doc.on.clipboard")
        .font(.system(size: 28))
        .foregroundColor(.secondary)
      Text(store.records.isEmpty ? "Your copied text will appear here" : "No matching text")
        .font(.headline)
      Text(store.records.isEmpty
        ? "Copy text in any app to keep it here. Images, files, and text marked sensitive are skipped."
        : "Try another search or time filter.")
        .font(.caption)
        .foregroundColor(.secondary)
        .multilineTextAlignment(.center)
      if !isEnabled {
        Button("Enable clipboard text history") { isEnabled = true }
          .buttonStyle(.borderedProminent)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private var compactContent: some View {
    ScrollViewReader { proxy in
      ScrollView(.horizontal) {
        LazyHStack(spacing: 12) {
          ForEach(records) { record in
            VStack(alignment: .leading, spacing: 10) {
              HStack {
                Label("Text", systemImage: "text.alignleft")
                Spacer()
                Text(record.copiedAt, style: .time)
              }
              .font(.caption)
              .foregroundColor(.secondary)
              Text(record.preview)
                .font(.system(size: 13))
                .lineLimit(6)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
              HStack {
                Button("View text") {
                  select(record)
                  manager.showExpanded()
                }
                Spacer()
                copyButton(record)
              }
              .buttonStyle(.bordered)
              .controlSize(.small)
            }
            .padding(14)
            .frame(width: 258)
            .frame(maxHeight: .infinity)
            .background(cardFill, in: RoundedRectangle(cornerRadius: 16))
            .overlay(selectionBorder(record))
            .contentShape(Rectangle())
            .onTapGesture { select(record) }
            .contextMenu { contextMenu(record) }
            .id(record.id)
          }
        }
        .padding(3)
      }
      .onChange(of: selectedID) { id in
        if let id { withAnimation { proxy.scrollTo(id) } }
      }
    }
  }

  private var expandedContent: some View {
    HStack(spacing: 16) {
      ScrollViewReader { proxy in
        ScrollView {
          LazyVStack(spacing: 8) {
            ForEach(records) { record in
              Button { select(record) } label: {
                VStack(alignment: .leading, spacing: 8) {
                  Text(record.preview)
                    .font(.system(size: 13))
                    .lineLimit(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                  Text(record.copiedAt, format: .dateTime.month(.abbreviated).day().hour().minute())
                    .font(.caption)
                    .foregroundColor(.secondary)
                }
                .padding(12)
                .background(cardFill, in: RoundedRectangle(cornerRadius: 12))
                .overlay(selectionBorder(record))
              }
              .buttonStyle(.plain)
              .contextMenu { contextMenu(record) }
              .id(record.id)
            }
          }
          .padding(3)
        }
        .onChange(of: selectedID) { id in
          if let id { withAnimation { proxy.scrollTo(id) } }
        }
      }
      .frame(width: 310)

      if let record = selectedRecord {
        VStack(alignment: .leading, spacing: 14) {
          HStack {
            Label("Clipboard text", systemImage: "text.alignleft")
              .font(.headline)
            Spacer()
            copyButton(record)
              .buttonStyle(.borderedProminent)
          }
          Divider()
          ScrollView {
            Text(record.text)
              .font(.system(size: 14))
              .textSelection(.enabled)
              .frame(maxWidth: .infinity, alignment: .topLeading)
              .padding(.trailing, 8)
          }
          .id(record.id)
          Divider()
          HStack {
            Text("\(record.text.count.formatted()) characters")
            Spacer()
            Button("Delete", role: .destructive) { store.remove(record.id) }
          }
          .font(.caption)
          .foregroundColor(.secondary)
        }
        .padding(18)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(cardFill, in: RoundedRectangle(cornerRadius: 16))
      }
    }
  }

  private var cardFill: Color {
    colorScheme == .dark ? Color.white.opacity(0.06) : Color.white.opacity(0.6)
  }

  private func selectionBorder(_ record: ClipboardTextRecord) -> some View {
    RoundedRectangle(cornerRadius: isExpanded ? 12 : 16)
      .strokeBorder(selectedID == record.id ? Color.accentColor : Color.primary.opacity(0.08),
                    lineWidth: selectedID == record.id ? 2 : 1)
  }

  private func copyButton(_ record: ClipboardTextRecord) -> some View {
    Button {
      copy(record)
    } label: {
      Label(copiedID == record.id ? "Copied" : "Copy", systemImage: copiedID == record.id ? "checkmark" : "doc.on.doc")
    }
    .help("Copy this text to the clipboard (⌘C)")
  }

  @ViewBuilder
  private func contextMenu(_ record: ClipboardTextRecord) -> some View {
    Button("Copy") { copy(record) }
    Button("View text") {
      select(record)
      manager.showExpanded()
    }
    Divider()
    Button("Delete", role: .destructive) { store.remove(record.id) }
  }

  private func select(_ record: ClipboardTextRecord) {
    selectedID = record.id
    manager.focusPanel()
  }

  private func copy(_ record: ClipboardTextRecord) {
    select(record)
    if store.copy(record) { copiedID = record.id }
  }

  private func syncSelection() {
    if !records.contains(where: { $0.id == selectedID }) { selectedID = records.first?.id }
  }
}
