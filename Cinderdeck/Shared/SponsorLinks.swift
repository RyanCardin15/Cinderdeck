//
//  SponsorLinks.swift
//  Cinderdeck
//
//  Shared sponsor destinations used across onboarding and preferences.
//

import Foundation
import SwiftUI

struct SponsorLink: Identifiable, Hashable {
  let id: String
  let title: String
  let subtitle: String
  let systemImage: String
  let color: Color
  let url: URL

  init(
    id: String,
    title: String,
    subtitle: String,
    systemImage: String,
    color: Color,
    url: URL
  ) {
    self.id = id
    self.title = title
    self.subtitle = subtitle
    self.systemImage = systemImage
    self.color = color
    self.url = url
  }

  func hash(into hasher: inout Hasher) { hasher.combine(id) }
  static func == (lhs: SponsorLink, rhs: SponsorLink) -> Bool { lhs.id == rhs.id }
}
