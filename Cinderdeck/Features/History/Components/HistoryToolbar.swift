//
//  HistoryToolbar.swift
//  Cinderdeck
//
//  Top toolbar for the history browser
//

import SwiftUI

struct HistoryToolbar: View {
  @Binding var searchText: String
  let selectedCount: Int
  let canSelectAll: Bool
  let onSelectAll: () -> Void
  let onClearSelection: () -> Void
  let onDeleteSelection: () -> Void

  var body: some View {
    HStack(spacing: 12) {
      searchBar

      Spacer()

      if selectedCount > 0 {
        selectionControls
      }
    }
  }

  private var searchBar: some View {
    DeckSearchField(placeholder: "Search by filename", text: $searchText).frame(width: 260)
  }

  private var selectionControls: some View {
    HStack(spacing: 10) {
      Label(
        L10n.PreferencesHistory.selectedCaptures(selectedCount),
        systemImage: "checkmark.circle.fill"
      )
      .font(.system(size: 11, weight: .semibold))
      .foregroundColor(.primary.opacity(0.84))

      if canSelectAll {
        selectionButton(
          title: L10n.PreferencesHistory.selectAll,
          systemName: "checkmark.circle",
          action: onSelectAll
        )
      }

      selectionButton(
        title: L10n.PreferencesHistory.clearSelection,
        systemName: "xmark.circle",
        action: onClearSelection
      )

      selectionButton(
        title: L10n.Common.deleteAction,
        systemName: "trash",
        isDestructive: true,
        action: onDeleteSelection
      )
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 9)
    .deckSurface(radius: 10)
    .fixedSize(horizontal: true, vertical: false)
  }

  private func selectionButton(
    title: String,
    systemName: String,
    isDestructive: Bool = false,
    action: @escaping () -> Void
  ) -> some View {
    Button(role: isDestructive ? .destructive : nil, action: action) {
      Label(title, systemImage: systemName)
        .font(.system(size: 11, weight: .semibold))
        .lineLimit(1)
        .fixedSize(horizontal: true, vertical: false)
    }
    .buttonStyle(.plain)
    .foregroundColor(isDestructive ? DeckStyle.danger : .primary.opacity(0.82))
  }

}
