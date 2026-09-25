//
//  SavedHistoryView.swift
//  Cinderdeck
//
//  Favorites and user groups of captures and clipboard text in the floating history panel
//

import SwiftUI

struct SavedHistoryView: View {
  @ObservedObject var manager: HistoryFloatingManager
  @ObservedObject private var collectionStore = HistoryCollectionStore.shared
  @ObservedObject private var captureStore = CaptureHistoryStore.shared
  @ObservedObject private var clipboardStore = ClipboardTextHistoryStore.shared
  @AppStorage(PreferencesKeys.historySavedCollectionID) private var storedCollectionID = ""
  @AppStorage(PreferencesKeys.historyBackgroundStyle) private var backgroundStyle: HistoryBackgroundStyle = .defaultStyle
  @State private var selectedItem: SavedHistoryItem?
  @State private var copiedTextID: UUID?
  @Environment(\.colorScheme) private var colorScheme

  private enum Entry: Identifiable {
    case capture(CaptureHistoryRecord)
    case text(ClipboardTextRecord)

    var item: SavedHistoryItem {
      switch self {
      case let .capture(record): return .capture(record.id)
      case let .text(record): return .clipboardText(record.id)
      }
    }

    var id: SavedHistoryItem { item }
  }

  private var isExpanded: Bool { manager.presentationMode == .expanded }

  private var selectedCollection: HistoryCollection? {
    collectionStore.collections.first { $0.id.uuidString == storedCollectionID }
      ?? collectionStore.favorites
  }

  private var entries: [Entry] {
    guard let selectedCollection else { return [] }
    let captures = Dictionary(captureStore.records.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    let texts = Dictionary(clipboardStore.records.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    let query = isExpanded ? manager.searchText.trimmingCharacters(in: .whitespacesAndNewlines) : ""

    return collectionStore.items(in: selectedCollection.id).compactMap { item -> Entry? in
      switch item {
      case let .capture(id):
        guard let record = captures[id],
          query.isEmpty || record.fileName.localizedCaseInsensitiveContains(query) else { return nil }
        return .capture(record)
      case let .clipboardText(id):
        guard let record = texts[id],
          query.isEmpty || record.text.localizedCaseInsensitiveContains(query) else { return nil }
        return .text(record)
      }
    }
  }

  private var selectedEntry: Entry? {
    entries.first { $0.item == selectedItem }
  }

  var body: some View {
    VStack(spacing: isExpanded ? 14 : 12) {
      collectionBar

      if let error = collectionStore.errorMessage {
        Label(error, systemImage: "exclamationmark.triangle")
          .font(.caption)
          .foregroundColor(.orange)
      }

      if entries.isEmpty {
        emptyState
      } else if isExpanded {
        expandedGrid
      } else {
        compactRow
      }
    }
    .onAppear { syncSelection() }
    .onChange(of: entries.map(\.item)) { _ in syncSelection() }
    .task(id: copiedTextID) {
      guard copiedTextID != nil else { return }
      try? await Task.sleep(nanoseconds: 2_000_000_000)
      guard !Task.isCancelled else { return }
      copiedTextID = nil
    }
    .onReceive(NotificationCenter.default.publisher(for: .historyCopySelection)) { notification in
      guard notification.object is HistoryFloatingPanel, let entry = selectedEntry else { return }
      copy(entry)
    }
    .onReceive(NotificationCenter.default.publisher(for: .historyActivateSelection)) { notification in
      guard notification.object is HistoryFloatingPanel, let entry = selectedEntry else { return }
      activate(entry)
    }
    .onReceive(NotificationCenter.default.publisher(for: .historyDeleteSelection)) { notification in
      guard notification.object is HistoryFloatingPanel, let entry = selectedEntry else { return }
      removeFromSelectedCollection(entry)
    }
    .onReceive(NotificationCenter.default.publisher(for: .historyMoveSelection)) { notification in
      guard notification.object is HistoryFloatingPanel,
        notification.userInfo?["section"] as? String == HistorySection.saved.rawValue,
        let delta = notification.userInfo?["delta"] as? Int else { return }
      let items = entries.map(\.item)
      guard !items.isEmpty else { return }
      let index = items.firstIndex { $0 == selectedItem } ?? 0
      selectedItem = items[min(max(index + delta, 0), items.count - 1)]
    }
  }

  // MARK: - Collections

  private var collectionBar: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        ForEach(collectionStore.collections) { collection in
          collectionChip(collection)
        }

        Button {
          if let group = HistoryCollectionPrompt.createGroup() {
            select(group)
          }
        } label: {
          Label("New Group", systemImage: "plus")
            .font(.system(size: 11, weight: .semibold))
            .padding(.horizontal, 11)
            .padding(.vertical, 6)
            .overlay(Capsule().strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [3, 3])))
            .foregroundColor(.secondary)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .help("Make a group for captures and copied text you want to keep")
        .accessibilityIdentifier("history.saved.newGroup")
      }
      .padding(2)
    }
  }

  private func collectionChip(_ collection: HistoryCollection) -> some View {
    let isSelected = collection.id == selectedCollection?.id
    let count = collectionStore.items(in: collection.id).count
    return Button {
      select(collection)
    } label: {
      HStack(spacing: 6) {
        Image(systemName: collection.systemIconName)
          .font(.system(size: 10, weight: .semibold))
          .foregroundColor(isSelected ? .white : (collection.isFavorites ? .yellow : .secondary))
        Text(collection.name)
          .font(.system(size: 11, weight: .semibold))
          .lineLimit(1)
        Text("\(count)")
          .font(.system(size: 9.5, weight: .bold))
          .opacity(0.7)
      }
      .foregroundColor(isSelected ? .white : .primary.opacity(0.82))
      .padding(.horizontal, 11)
      .padding(.vertical, 6)
      .background(isSelected ? AnyShapeStyle(Color.accentColor) : chipBackground, in: Capsule())
      .contentShape(Capsule())
    }
    .buttonStyle(.plain)
    .contextMenu {
      if !collection.isFavorites {
        Button("Rename…") { HistoryCollectionPrompt.rename(collection) }
        Button("Delete Group…", role: .destructive) {
          if HistoryCollectionPrompt.delete(collection), isSelected {
            storedCollectionID = ""
          }
        }
      }
    }
    .accessibilityIdentifier(collection.isFavorites ? "history.saved.favorites" : "history.saved.group")
  }

  private func select(_ collection: HistoryCollection) {
    storedCollectionID = collection.id.uuidString
    selectedItem = nil
    syncSelection()
    manager.focusPanel()
  }

  // MARK: - Items

  private var compactRow: some View {
    ScrollViewReader { proxy in
      ScrollView(.horizontal, showsIndicators: false) {
        LazyHStack(alignment: .top, spacing: 18) {
          ForEach(entries) { entry in
            entryView(entry)
              .id(entry.item)
          }
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 6)
      }
      .onChange(of: selectedItem) { item in
        if let item { withAnimation { proxy.scrollTo(item) } }
      }
    }
  }

  private var expandedGrid: some View {
    ScrollViewReader { proxy in
      ScrollView(.vertical, showsIndicators: false) {
        LazyVGrid(
          columns: Array(repeating: GridItem(.flexible(), spacing: 12, alignment: .top), count: 4),
          spacing: 12
        ) {
          ForEach(entries) { entry in
            entryView(entry)
              .id(entry.item)
          }
        }
        .padding(.horizontal, 6)
        .padding(.top, 4)
        .padding(.bottom, 14)
      }
      .onChange(of: selectedItem) { item in
        if let item { withAnimation { proxy.scrollTo(item) } }
      }
    }
  }

  @ViewBuilder
  private func entryView(_ entry: Entry) -> some View {
    switch entry {
    case let .capture(record):
      captureCard(record)
        .contextMenu {
          removeMenuItem(entry)
          Divider()
          HistoryContextMenu(record: record)
        }
    case let .text(record):
      textCard(record)
        .contextMenu {
          Button("Copy") { copy(entry) }
          removeMenuItem(entry)
          Divider()
          HistorySaveMenuItems(items: [entry.item])
          Divider()
          Button("Delete from History", role: .destructive) { clipboardStore.remove(record.id) }
        }
    }
  }

  @ViewBuilder
  private func captureCard(_ record: CaptureHistoryRecord) -> some View {
    let isSelected = selectedItem == .capture(record.id)
    if isExpanded {
      HistoryExpandedCaptureCardView(
        record: record,
        isSelected: isSelected,
        backgroundStyle: backgroundStyle,
        onTap: { select(.capture(record.id)) },
        reservedScrollAxis: .vertical
      )
      .equatable()
    } else {
      HistoryCardView(
        record: record,
        isSelected: isSelected,
        onTap: { select(.capture(record.id)) },
        reservedScrollAxis: .horizontal,
        backgroundStyle: backgroundStyle
      )
      .equatable()
      .frame(width: 196)
    }
  }

  private func textCard(_ record: ClipboardTextRecord) -> some View {
    let item = SavedHistoryItem.clipboardText(record.id)
    let isSelected = selectedItem == item
    let isCopied = copiedTextID == record.id
    return VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 6) {
        Image(systemName: "text.alignleft")
        Text("Text")
        Spacer()
        HistoryFavoriteButton(item: item, size: 11)
        HistoryGroupMenu(item: item, iconOnly: true)
      }
      .font(.caption)
      .foregroundColor(.secondary)

      Text(record.preview)
        .font(.system(size: 12.5))
        .lineLimit(isExpanded ? 7 : 6)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)

      Button {
        copy(.text(record))
      } label: {
        Label(isCopied ? "Copied" : "Copy", systemImage: isCopied ? "checkmark" : "doc.on.doc")
          .frame(maxWidth: .infinity)
      }
      .buttonStyle(.bordered)
      .controlSize(.small)
      .help("Copy this text to the clipboard (⌘C). Press Return to copy and close.")
    }
    .padding(12)
    .frame(width: isExpanded ? nil : 240)
    .frame(height: isExpanded ? 196 : nil)
    .frame(maxHeight: isExpanded ? nil : .infinity)
    .background(textCardFill, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 16, style: .continuous)
        .strokeBorder(isSelected ? Color.accentColor : Color.primary.opacity(0.08), lineWidth: isSelected ? 2 : 1)
    )
    .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    .onTapGesture(count: 2) { activate(.text(record)) }
    .onTapGesture { select(item) }
    .help(record.text.count > record.preview.count ? String(record.text.prefix(1_200)) : "")
  }

  @ViewBuilder
  private func removeMenuItem(_ entry: Entry) -> some View {
    if let selectedCollection {
      Button("Remove from \(selectedCollection.name)") { removeFromSelectedCollection(entry) }
    }
  }

  // MARK: - Empty state

  private var emptyState: some View {
    VStack(spacing: 10) {
      Image(systemName: selectedCollection?.isFavorites == false ? "folder" : "star")
        .font(.system(size: 26, weight: .medium))
        .foregroundColor(.secondary.opacity(0.7))
      Text(emptyTitle)
        .font(.system(size: 14, weight: .semibold))
      Text(emptyMessage)
        .font(.caption)
        .foregroundColor(.secondary)
        .multilineTextAlignment(.center)
        .frame(maxWidth: 420)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private var emptyTitle: String {
    if isExpanded, !manager.searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      return "No matching saved items"
    }
    return selectedCollection?.isFavorites == false ? "This group is empty" : "No favorites yet"
  }

  private var emptyMessage: String {
    if isExpanded, !manager.searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      return "Try another search."
    }
    return "Use the star or folder on copied text to save it here, or right-click a capture to save it. Saved items stay until you remove them, even after history cleanup."
  }

  // MARK: - Actions

  private func select(_ item: SavedHistoryItem) {
    selectedItem = item
    manager.focusPanel()
  }

  private func syncSelection() {
    let items = entries.map(\.item)
    if !items.contains(where: { $0 == selectedItem }) { selectedItem = items.first }
  }

  private func copy(_ entry: Entry) {
    select(entry.item)
    switch entry {
    case let .capture(record):
      HistoryWindowController.shared.copyToClipboard([record])
    case let .text(record):
      if clipboardStore.copy(record) { copiedTextID = record.id }
    }
  }

  /// Return opens a capture, or copies text and closes the panel so it is ready to paste.
  private func activate(_ entry: Entry) {
    switch entry {
    case let .capture(record):
      HistoryWindowController.shared.openItem(record)
    case let .text(record):
      if clipboardStore.copy(record) { manager.hide() }
    }
  }

  private func removeFromSelectedCollection(_ entry: Entry) {
    guard let selectedCollection else { return }
    collectionStore.remove([entry.item], from: selectedCollection.id)
  }

  private var chipBackground: AnyShapeStyle {
    colorScheme == .dark
      ? AnyShapeStyle(Color.white.opacity(0.08))
      : AnyShapeStyle(Color.black.opacity(0.05))
  }

  private var textCardFill: Color {
    if backgroundStyle == .solid {
      return colorScheme == .dark ? Color.white.opacity(0.08) : Color.white.opacity(0.92)
    }
    return colorScheme == .dark ? Color.white.opacity(0.06) : Color.white.opacity(0.7)
  }
}
