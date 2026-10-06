import SwiftUI

/// The same progress and completion feedback in native workspace settings.
struct DeckRefreshButton: View {
  var title = "Refresh"
  var help = "Reload saved workspace definitions from disk"
  let action: @MainActor () async -> Void
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var refreshing = false
  @State private var rotation = false

  var body: some View {
    Button {
      guard !refreshing else { return }
      refreshing = true
      Task { @MainActor in
        let started = Date()
        await action()
        let remaining = 0.45 - Date().timeIntervalSince(started)
        if remaining > 0 { try? await Task.sleep(for: .seconds(remaining)) }
        refreshing = false
      }
    } label: {
      HStack(spacing: 6) {
        Image(systemName: "arrow.clockwise")
          .rotationEffect(.degrees(rotation && !reduceMotion ? 360 : 0))
          .animation(rotation && !reduceMotion ? .linear(duration: 0.9).repeatForever(autoreverses: false) : nil, value: rotation)
        Text(refreshing ? "Refreshing…" : title)
      }
    }
    .disabled(refreshing)
    .help(help)
    .accessibilityLabel(help)
    .onChange(of: refreshing) { rotation = $0 }
  }
}
