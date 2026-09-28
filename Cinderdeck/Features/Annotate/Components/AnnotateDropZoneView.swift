//
//  AnnotateDropZoneView.swift
//  Cinderdeck
//
//  Drop zone overlay shown when no image is loaded
//

import SwiftUI

/// Drop zone view displayed when annotation canvas has no image
struct AnnotateDropZoneView: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Binding var isDragOver: Bool

  var body: some View {
    VStack(spacing: 20) {
      DeckFeatureIcon(systemName: "photo.on.rectangle.angled", size: 52,
        tint: isDragOver ? DeckStyle.accent : .secondary)
      VStack(spacing: 7) {
        Text(L10n.AnnotateUI.dropImageHere).font(.system(size: 20, weight: .semibold))
        Text(L10n.AnnotateUI.captureScreenshotToAnnotate).font(DeckStyle.body).foregroundStyle(.secondary)
      }.multilineTextAlignment(.center)

      HStack(spacing: 8) {
        ForEach(["PNG", "JPG", "GIF", "HEIC"], id: \.self) { format in
          Text(format)
            .font(.caption)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(DeckStyle.inset)
            .cornerRadius(4)
        }
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(
      RoundedRectangle(cornerRadius: 12)
        .strokeBorder(
          style: StrokeStyle(lineWidth: 1, dash: [5, 4])
        )
        .foregroundColor(isDragOver ? .accentColor : .secondary.opacity(0.3))
        .padding(40)
    )
    .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: isDragOver)
  }
}

#Preview {
  AnnotateDropZoneView(isDragOver: .constant(false))
    .frame(width: 600, height: 400)
}
