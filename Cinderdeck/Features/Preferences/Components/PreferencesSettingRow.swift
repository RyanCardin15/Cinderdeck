//
//  SettingRow.swift
//  Cinderdeck
//
//  Reusable settings row with icon, title, description, and trailing content
//

import SwiftUI

struct SettingRow<Content: View>: View {
  let icon: String
  let title: String
  let description: String?
  var tooltip: String? = nil
  @ViewBuilder let content: () -> Content

  var body: some View {
    HStack(alignment: .center, spacing: 12) {
      DeckFeatureIcon(systemName: icon, size: 30, tint: .secondary)

      VStack(alignment: .leading, spacing: 4) {
        if let tooltip {
          Text(title)
            .font(.system(size: 13, weight: .medium))
            .hint(tooltip, variant: .icon(.info))
        } else {
          Text(title)
            .font(.system(size: 13, weight: .medium))
        }
        if let description {
          Text(description)
            .font(DeckStyle.caption)
            .foregroundColor(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }

      Spacer(minLength: 16)
      content().fixedSize(horizontal: true, vertical: false)
    }
    .padding(.vertical, 8)
  }
}
