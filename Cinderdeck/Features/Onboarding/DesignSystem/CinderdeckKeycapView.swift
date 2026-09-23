//
//  CinderdeckKeycapView.swift
//  Cinderdeck
//
//  Physical Mac keycap chip and row components for keyboard shortcut display.
//

import SwiftUI

struct CinderdeckKeycapChip: View {
  var label: String
  var emphasis: Bool = false

  private var height: CGFloat { 19 }

  var body: some View {
    Text(label)
      .font(.system(size: CinderdeckOnboardingType.keycap + 1, weight: .semibold, design: .rounded))
      .foregroundStyle(emphasis ? CinderdeckGlassInk.primary : CinderdeckGlassInk.muted)
      .padding(.horizontal, 5.5)
      .frame(minWidth: height, minHeight: height)
      .background {
        ZStack {
          RoundedRectangle(cornerRadius: 5.5, style: .continuous)
            .fill(Color.black.opacity(0.24))

          RoundedRectangle(cornerRadius: 5.5, style: .continuous)
            .fill(Color.white.opacity(emphasis ? 0.20 : 0.08))

          RoundedRectangle(cornerRadius: 5.5, style: .continuous)
            .strokeBorder(
              LinearGradient(
                colors: [
                  Color.white.opacity(emphasis ? 0.36 : 0.16),
                  Color.white.opacity(emphasis ? 0.10 : 0.04),
                ],
                startPoint: .top,
                endPoint: .bottom
              ),
              lineWidth: CinderdeckSurfaceGlass.specularLineWidth
            )
        }
      }
      .fixedSize()
  }
}

struct CinderdeckKeycapRow: View {
  var keys: [String]
  var emphasis: Bool = false

  var body: some View {
    HStack(spacing: 3) {
      ForEach(Array(keys.enumerated()), id: \.offset) { _, key in
        CinderdeckKeycapChip(label: key, emphasis: emphasis)
      }
    }
  }
}
