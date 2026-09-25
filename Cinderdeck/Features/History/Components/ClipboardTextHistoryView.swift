import SwiftUI

struct ClipboardTextHistoryView: View {
  @ObservedObject var manager: HistoryFloatingManager
  @ObservedObject var store = ClipboardTextHistoryStore.shared
  @ObservedObject private var collectionStore = HistoryCollectionStore.shared
  @Binding var selectedID: UUID?
  @Binding var selectedCollectionID: UUID?
  let isExpanded: Bool
  @AppStorage(PreferencesKeys.clipboardTextHistoryEnabled) private var isEnabled = false
  @State private var copiedID: UUID?
  @Environment(\.colorScheme) private var colorScheme

  private var records: [ClipboardTextRecord] {
    let query = isExpanded ? manager.searchText.trimmingCharacters(in: .whitespacesAndNewlines) : ""
    let now = Date()
    let filtered = store.records.filter { record in
      (query.isEmpty || record.text.localizedCaseInsensitiveContains(query)) &&
        (!isExpanded || manager.expandedTimeFilter.includes(record.copiedAt, relativeTo: now)) &&
        (selectedCollectionID.map { collectionStore.contains(.clipboardText(record.id), in: $0) } ?? true)
    }
    return isExpanded ? filtered : Array(filtered.prefix(manager.maxDisplayedItems))
  }

  private var selectedRecord: ClipboardTextRecord? {
    records.first { $0.id == selectedID }
  }

  private var selectedCollection: HistoryCollection? {
    collectionStore.collections.first { $0.id == selectedCollectionID }
  }

  var body: some View {
    VStack(spacing: 10) {
      HStack(spacing: 8) {
        Label(isEnabled ? "Saving copied text" : "Clipboard history paused",
              systemImage: isEnabled ? "clipboard" : "pause.circle")
        Text("· \(store.records.count) items · Kept on this Mac for 30 days unless saved")
          .foregroundColor(.secondary)
        Spacer()
        Button(isEnabled ? "Pause" : "Resume") { isEnabled.toggle() }
          .buttonStyle(.bordered)
          .controlSize(.small)
      }
      .font(.system(size: 11, weight: .medium))

      collectionBar

      if let error = store.errorMessage ?? collectionStore.errorMessage {
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
    .onAppear {
      if selectedCollectionID != nil, selectedCollection == nil { selectedCollectionID = nil }
      syncSelection()
    }
    .onChange(of: records.map(\.id)) { _ in syncSelection() }
    .onChange(of: collectionStore.collections.map(\.id)) { ids in
      if let selectedCollectionID, !ids.contains(selectedCollectionID) {
        self.selectedCollectionID = nil
      }
    }
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
    .onReceive(NotificationCenter.default.publisher(for: .historyMoveSelection)) { notification in
      guard notification.object is HistoryFloatingPanel,
        notification.userInfo?["section"] as? String == HistorySection.clipboard.rawValue,
        let delta = notification.userInfo?["delta"] as? Int, !records.isEmpty else { return }
      let index = records.firstIndex { $0.id == selectedID } ?? 0
      selectedID = records[min(max(index + delta, 0), records.count - 1)].id
    }
  }

  private var collectionBar: some View {
    HStack(spacing: 10) {
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 6) {
          collectionFilter(title: "All text", icon: "text.alignleft", id: nil, count: store.records.count)
          ForEach(collectionStore.collections) { collection in
            collectionFilter(
              title: collection.name,
              icon: collection.systemIconName,
              id: collection.id,
              count: collectionStore.items(in: collection.id).filter {
                if case .clipboardText = $0 { return true }
                return false
              }.count
            )
            .contextMenu {
              if !collection.isFavorites {
                Button("Rename…") { HistoryCollectionPrompt.rename(collection) }
                Button("Delete Group…", role: .destructive) { HistoryCollectionPrompt.delete(collection) }
              }
            }
          }
        }
        .padding(2)
      }
      Button {
        if let group = HistoryCollectionPrompt.createGroup() {
          selectedCollectionID = group.id
        }
      } label: {
        Label("New Group", systemImage: "folder.badge.plus")
      }
      .buttonStyle(.bordered)
      .controlSize(.small)
      .fixedSize()
      .accessibilityIdentifier("history.clipboard.newGroup")
    }
  }

  private func collectionFilter(title: String, icon: String, id: UUID?, count: Int) -> some View {
    let isSelected = selectedCollectionID == id
    return Button {
      selectedCollectionID = id
      manager.focusPanel()
    } label: {
      HStack(spacing: 5) {
        Label(title, systemImage: icon)
        Text(count.formatted()).opacity(0.7)
      }
      .font(.system(size: 11, weight: .semibold))
      .lineLimit(1)
      .padding(.horizontal, 10)
      .padding(.vertical, 7)
      .foregroundColor(isSelected ? .white : .primary)
      .background(isSelected ? Color.accentColor : Color.primary.opacity(0.06), in: Capsule())
      .contentShape(Capsule())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(title)
    .accessibilityValue("\(count) text items")
    .accessibilityAddTraits(isSelected ? [.isSelected] : [])
    .accessibilityIdentifier("history.clipboard.collection.\(id?.uuidString ?? "all")")
  }

  private var emptyState: some View {
    VStack(spacing: 10) {
      Image(systemName: selectedCollection?.systemIconName ?? "doc.on.clipboard")
        .font(.system(size: 28))
        .foregroundColor(.secondary)
      Text(emptyTitle)
        .font(.headline)
      Text(emptyMessage)
        .font(.caption)
        .foregroundColor(.secondary)
        .multilineTextAlignment(.center)
      if selectedCollectionID != nil {
        Button("Show all text") { selectedCollectionID = nil }
          .buttonStyle(.bordered)
      } else if !isEnabled {
        Button("Enable clipboard text history") { isEnabled = true }
          .buttonStyle(.borderedProminent)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private var emptyTitle: String {
    if let selectedCollection {
      return selectedCollection.isFavorites ? "No favorite text matches" : "No text matches in \(selectedCollection.name)"
    }
    return store.records.isEmpty ? "Your copied text will appear here" : "No matching text"
  }

  private var emptyMessage: String {
    if selectedCollectionID != nil {
      return "Use the star or folder on any text item to save it here. If it is already saved, try another search or time filter."
    }
    return store.records.isEmpty
      ? "Copy text in any app to keep it here. Images, files, and text marked sensitive are skipped."
      : "Try another search or time filter."
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
                HistoryFavoriteButton(item: .clipboardText(record.id), size: 11)
                HistoryGroupMenu(item: .clipboardText(record.id), iconOnly: true)
              }
              .font(.caption)
              .foregroundColor(.secondary)
              Text(record.preview)
                .font(.system(size: 13))
                .lineLimit(6)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
              groupMembership(record)
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
              VStack(alignment: .leading, spacing: 8) {
                Button { select(record) } label: {
                  Text(record.preview)
                    .font(.system(size: 13))
                    .lineLimit(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("View text: \(record.preview)")
                groupMembership(record)
                HStack(spacing: 6) {
                  Text(record.copiedAt, format: .dateTime.month(.abbreviated).day().hour().minute())
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
                  Spacer(minLength: 0)
                  HistoryFavoriteButton(item: .clipboardText(record.id), size: 12)
                    .accessibilityIdentifier("history.clipboard.favorite.\(record.id)")
                  HistoryGroupMenu(item: .clipboardText(record.id), iconOnly: true)
                    .accessibilityIdentifier("history.clipboard.groups.\(record.id)")
                  copyButton(record, iconOnly: true)
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("history.clipboard.copy.\(record.id)")
                }
              }
              .padding(12)
              .background(cardFill, in: RoundedRectangle(cornerRadius: 12))
              .overlay(selectionBorder(record))
              .contentShape(Rectangle())
              .onTapGesture { select(record) }
              .accessibilityElement(children: .contain)
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
            HistoryFavoriteButton(item: .clipboardText(record.id), size: 14)
            HistoryGroupMenu(item: .clipboardText(record.id))
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

  private func copyButton(_ record: ClipboardTextRecord, iconOnly: Bool = false) -> some View {
    Button {
      copy(record)
    } label: {
      if iconOnly {
        Image(systemName: copiedID == record.id ? "checkmark" : "doc.on.doc")
          .frame(width: 24, height: 24)
          .contentShape(Rectangle())
      } else {
        Label(copiedID == record.id ? "Copied" : "Copy", systemImage: copiedID == record.id ? "checkmark" : "doc.on.doc")
      }
    }
    .accessibilityLabel(copiedID == record.id ? "Copied" : "Copy text")
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
    HistorySaveMenuItems(items: [.clipboardText(record.id)])
    Divider()
    Button("Delete", role: .destructive) { store.remove(record.id) }
  }

  @ViewBuilder
  private func groupMembership(_ record: ClipboardTextRecord) -> some View {
    let groups = collectionStore.groups.filter { collectionStore.contains(.clipboardText(record.id), in: $0.id) }
    if !groups.isEmpty {
      Label(groups.map(\.name).joined(separator: ", "), systemImage: "folder")
        .font(.system(size: 10, weight: .medium))
        .foregroundColor(.secondary)
        .lineLimit(1)
        .help(groups.map(\.name).joined(separator: ", "))
    }
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
