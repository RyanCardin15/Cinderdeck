import SwiftUI

/// Shown on the recording bar while workspace logs are captured. Clicking it
/// marks the moment in the log, so "the bug happened here" is easy to find later.
struct RecordingLogsIndicator: View {
  @ObservedObject var recorder: ReproRecorder
  @State private var markedAt: String?
  @State private var isHovered = false

  init(recorder: ReproRecorder = .shared) { self.recorder = recorder }

  var body: some View {
    if let live = recorder.live, !live.isFinalizing {
      HStack(spacing: ToolbarConstants.itemSpacing) {
        RecordingToolbarDivider()
        Button(action: mark) {
          HStack(spacing: 5) {
            Image(systemName: markedAt == nil ? "text.alignleft" : "flag.fill")
              .font(.system(size: 12, weight: .semibold))
              .foregroundColor(markedAt == nil ? .primary.opacity(0.85) : .accentColor)
            // The recording bar is sized once, so every part keeps a fixed width.
            Text(markedAt.map { "Marked \($0)" } ?? "\(Self.compact(live.lines)) lines")
              .font(.system(size: 11, weight: .medium).monospacedDigit())
              .foregroundColor(.primary.opacity(0.8))
              .lineLimit(1).minimumScaleFactor(0.75)
              .frame(width: 72, alignment: .leading)
            Text(live.errors > 99 ? "99+" : "\(live.errors)")
              .font(.system(size: 9, weight: .bold)).foregroundColor(.white)
              .padding(.horizontal, 4).frame(minWidth: 14, minHeight: 14)
              .background(Capsule().fill(Color.red))
              .frame(width: 24)
              .opacity(live.errors > 0 && markedAt == nil ? 1 : 0)
          }
          .padding(.horizontal, 6)
          .frame(height: ToolbarConstants.iconButtonSize)
          .background(RoundedRectangle(cornerRadius: ToolbarConstants.buttonCornerRadius).fill(Color.primary.opacity(isHovered ? 0.1 : 0)))
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .help(tooltip(live))
        .accessibilityLabel("Workspace logs, \(live.lines) lines, \(live.errors) errors")
        .accessibilityHint("Marks this moment in the log")
      }
    }
  }

  private func tooltip(_ live: ReproRecorder.Live) -> String {
    let from = live.workspaces.isEmpty ? "Waiting for workspace output" : "Saving logs from \(ReproFormat.list(live.workspaces))"
    var counts = "\(live.lines.formatted()) line\(live.lines == 1 ? "" : "s")"
    if live.errors > 0 { counts += ", \(live.errors) error\(live.errors == 1 ? "" : "s")" }
    return "\(from) · \(counts). Click to mark this moment in the log."
  }

  private func mark() {
    guard let marker = try? recorder.addMarker(label: "Marked", kind: .note, by: StackActor.user.label) else { return }
    let time = ReproFormat.timestamp(marker.t, precise: false)
    markedAt = time
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { if markedAt == time { markedAt = nil } }
  }

  /// 950 → "950", 1_240 → "1.2k", 12_400 → "12k".
  static func compact(_ value: Int) -> String {
    if value < 1000 { return "\(value)" }
    if value < 10_000 { return String(format: "%.1fk", Double(value) / 1000) }
    return "\(value / 1000)k"
  }
}
