//
//  HistorySaveMenu.swift
//  Cinderdeck
//
//  Favorites and group controls shared by capture and clipboard text history
//

import AppKit
import SwiftUI

/// Context menu items that add history items to Favorites or a group.
struct HistorySaveMenuItems: View {
  let items: [SavedHistoryItem]
  @ObservedObject private var store = HistoryCollectionStore.shared

  var body: some View {
    let areFavorites = !items.isEmpty && items.allSatisfy { store.isFavorite($0) }
    Button(areFavorites ? "Remove from Favorites" : "Add to Favorites") {
      if areFavorites {
        store.remove(items, from: HistoryCollection.favoritesID)
      } else {
        store.add(items, to: HistoryCollection.favoritesID)
      }
    }

    Menu("Add to Group") {
      HistoryGroupMenuItems(items: items)
    }
  }
}

/// Direct group access for item quick actions, without a nested Save menu.
struct HistoryGroupMenu: View {
  let item: SavedHistoryItem
  var iconOnly = false
  @ObservedObject private var store = HistoryCollectionStore.shared

  private var groups: [HistoryCollection] {
    store.groups.filter { store.contains(item, in: $0.id) }
  }

  var body: some View {
    Menu {
      HistoryGroupMenuItems(items: [item])
    } label: {
      Label("Groups", systemImage: groups.isEmpty ? "folder.badge.plus" : "folder.fill")
        .labelStyle(HistoryGroupLabelStyle(iconOnly: iconOnly))
        .frame(minWidth: 24, minHeight: 24)
        .contentShape(Rectangle())
    }
    .menuStyle(.borderlessButton)
    .menuIndicator(.hidden)
    .fixedSize()
    .help(groups.isEmpty ? "Add to group" : "Groups: " + groups.map(\.name).joined(separator: ", "))
    .accessibilityLabel("Add to or remove from groups")
    .accessibilityValue(groups.isEmpty ? "No groups" : groups.map(\.name).joined(separator: ", "))
  }
}

private struct HistoryGroupLabelStyle: LabelStyle {
  let iconOnly: Bool

  func makeBody(configuration: Configuration) -> some View {
    HStack(spacing: 5) {
      configuration.icon
      if !iconOnly { configuration.title }
    }
  }
}

private struct HistoryGroupMenuItems: View {
  let items: [SavedHistoryItem]
  @ObservedObject private var store = HistoryCollectionStore.shared

  var body: some View {
    ForEach(store.groups) { group in
      Toggle(group.name, isOn: Binding(
        get: { !items.isEmpty && items.allSatisfy { store.contains($0, in: group.id) } },
        set: { isOn in
          if isOn {
            store.add(items, to: group.id)
          } else {
            store.remove(items, from: group.id)
          }
        }
      ))
    }
    if !store.groups.isEmpty { Divider() }
    Button("New Group…") {
      HistoryCollectionPrompt.createGroup(adding: items)
    }
  }
}

/// Star button that toggles one item in Favorites.
struct HistoryFavoriteButton: View {
  let item: SavedHistoryItem
  var size: CGFloat = 12
  @ObservedObject private var store = HistoryCollectionStore.shared

  var body: some View {
    let isFavorite = store.isFavorite(item)
    Button {
      store.toggleFavorite(item)
    } label: {
      Image(systemName: isFavorite ? "star.fill" : "star")
        .font(.system(size: size, weight: .semibold))
        .foregroundColor(isFavorite ? .yellow : .secondary)
        .frame(minWidth: 24, minHeight: 24)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .help(isFavorite ? "Remove from Favorites" : "Add to Favorites")
    .accessibilityLabel(isFavorite ? "Remove from Favorites" : "Add to Favorites")
    .accessibilityValue(isFavorite ? "Favorite" : "Not a favorite")
  }
}

/// Star shown on a capture thumbnail while the capture is in Favorites.
struct HistoryFavoriteBadge: View {
  let item: SavedHistoryItem
  var size: CGFloat = 24
  @ObservedObject private var store = HistoryCollectionStore.shared

  var body: some View {
    if store.isFavorite(item) {
      Image(systemName: "star.fill")
        .font(.system(size: size * 0.42, weight: .semibold))
        .foregroundColor(.yellow)
        .frame(width: size, height: size)
        .background(.regularMaterial, in: Circle())
        .accessibilityLabel("Favorite")
    }
  }
}

@MainActor
enum HistoryCollectionPrompt {
  /// Asks for a name, creates the group, and adds `items` to it.
  @discardableResult
  static func createGroup(adding items: [SavedHistoryItem] = []) -> HistoryCollection? {
    guard let name = askForName(
      title: "New Group",
      message: "Groups keep captures and copied text together. Items in a group are not removed by history cleanup.",
      confirm: "Create"
    ) else { return nil }
    let store = HistoryCollectionStore.shared
    guard let group = store.createGroup(named: name) else { return nil }
    store.add(items, to: group.id)
    return group
  }

  static func rename(_ group: HistoryCollection) {
    guard let name = askForName(title: "Rename Group", message: nil, confirm: "Rename", initialName: group.name)
    else { return }
    HistoryCollectionStore.shared.renameGroup(group.id, to: name)
  }

  /// Returns true when the user confirmed and the group was deleted.
  @discardableResult
  static func delete(_ group: HistoryCollection) -> Bool {
    let isConfirmed = HistoryFloatingManager.shared.performModalInteraction {
      let alert = NSAlert()
      alert.messageText = "Delete “\(group.name)”?"
      alert.informativeText = "Its captures and copied text stay in history."
      alert.alertStyle = .warning
      alert.addButton(withTitle: "Delete Group")
      alert.addButton(withTitle: L10n.Common.cancel)
      return alert.runModal() == .alertFirstButtonReturn
    }
    guard isConfirmed else { return false }
    HistoryCollectionStore.shared.deleteGroup(group.id)
    return true
  }

  private static func askForName(
    title: String,
    message: String?,
    confirm: String,
    initialName: String = ""
  ) -> String? {
    HistoryFloatingManager.shared.performModalInteraction {
      let alert = NSAlert()
      alert.messageText = title
      if let message { alert.informativeText = message }
      alert.addButton(withTitle: confirm)
      alert.addButton(withTitle: L10n.Common.cancel)
      let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
      field.stringValue = initialName
      field.placeholderString = "Group name"
      alert.accessoryView = field
      alert.window.initialFirstResponder = field
      guard alert.runModal() == .alertFirstButtonReturn else { return nil }
      let name = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
      return name.isEmpty ? nil : name
    }
  }
}
