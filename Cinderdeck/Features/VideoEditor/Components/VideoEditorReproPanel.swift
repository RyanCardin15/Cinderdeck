import AVFoundation
import AppKit
import SwiftUI

/// Workspace output recorded with this video, following the playhead. Lines
/// after the playhead are dimmed; clicking any line or marker seeks to it.
struct VideoEditorReproPanel: View {
  @ObservedObject var state: VideoEditorState
  @ObservedObject var model: VideoEditorReproModel
  @ObservedObject var playback: VideoEditorPlaybackState
  @State private var playhead: Double = 0
  @State private var lastScrolledID: String?

  init(state: VideoEditorState) {
    self.state = state
    model = state.reproModel
    playback = state.playbackState
  }

  var body: some View {
    VStack(spacing: 0) {
      if let session = model.session {
        header(session)
        Divider()
        filters(session)
        Divider()
        list
        Divider()
        footer(session)
      }
    }
    .frame(maxHeight: .infinity, alignment: .top)
    .background(Color(nsColor: .controlBackgroundColor).opacity(0.35))
    .onReceive(playback.$currentTime) { time in
      let seconds = CMTimeGetSeconds(time)
      guard seconds.isFinite, abs(seconds - playhead) >= 0.04 else { return }
      playhead = seconds
    }
  }

  // MARK: Header

  private func header(_ session: ReproSession) -> some View {
    let summary = ReproSummary(session: session, lines: model.lines)
    return VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 8) {
        ReproVerdictBadge(verdict: summary.verdict)
        Text(session.title).font(.system(size: 13, weight: .semibold)).lineLimit(1).truncationMode(.middle)
        Spacer(minLength: 0)
        Button { state.isReproPanelVisible = false } label: { Image(systemName: "xmark").font(.system(size: 10, weight: .semibold)) }
          .buttonStyle(.plain).foregroundColor(.secondary).help("Hide logs (⇧⌘L)")
      }
      Text(summary.headline).font(.system(size: 11)).foregroundColor(.secondary).lineLimit(2)
      HStack(spacing: 10) {
        ReproStat(value: session.lineCount, label: "lines", color: .secondary)
        ReproStat(value: session.errorCount, label: "errors", color: session.errorCount > 0 ? .red : .secondary)
        ReproStat(value: session.warningCount, label: "warnings", color: session.warningCount > 0 ? .orange : .secondary)
        ReproStat(value: session.markers.count, label: "markers", color: .secondary)
      }
    }
    .padding(.horizontal, 12).padding(.vertical, 10)
  }

  // MARK: Filters

  private func filters(_ session: ReproSession) -> some View {
    VStack(spacing: 8) {
      HStack(spacing: 6) {
        Picker("Level", selection: $model.level) {
          ForEach(VideoEditorReproModel.LevelFilter.allCases) { Text($0.rawValue).tag($0) }
        }.pickerStyle(.segmented).labelsHidden()
        Menu {
          ForEach(session.sources) { source in
            Button {
              if model.hiddenSources.contains(source.id) { model.hiddenSources.remove(source.id) } else { model.hiddenSources.insert(source.id) }
            } label: {
              Label("\(source.name)  ·  \(source.lineCount)", systemImage: model.hiddenSources.contains(source.id) ? "circle" : "checkmark.circle.fill")
            }
          }
          if !model.hiddenSources.isEmpty {
            Divider()
            Button("Show all sources") { model.hiddenSources = [] }
          }
          Divider()
          Toggle("Show markers", isOn: $model.showMarkers)
        } label: {
          Image(systemName: model.hiddenSources.isEmpty ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill")
        }
        .menuStyle(.borderlessButton).fixedSize().help("Sources and markers")
      }
      HStack(spacing: 6) {
        HStack(spacing: 4) {
          Image(systemName: "magnifyingglass").font(.system(size: 11)).foregroundColor(.secondary)
          TextField("Filter output", text: $model.search).textFieldStyle(.plain).font(.system(size: 12))
          if !model.search.isEmpty {
            Button { model.search = "" } label: { Image(systemName: "xmark.circle.fill") }.buttonStyle(.plain).foregroundColor(.secondary)
          }
        }
        .padding(.horizontal, 7).padding(.vertical, 4)
        .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 6))
        jumpButton("chevron.up", help: "Previous error") { jumpToError(forward: false) }
        jumpButton("chevron.down", help: "Next error") { jumpToError(forward: true) }
        Button { model.follow.toggle() } label: {
          Image(systemName: model.follow ? "scope" : "circle.dashed").font(.system(size: 12, weight: .medium))
            .foregroundColor(model.follow ? .accentColor : .secondary).frame(width: 22, height: 22)
        }.buttonStyle(.plain).help(model.follow ? "Following the playhead" : "Follow the playhead")
      }
    }
    .padding(.horizontal, 12).padding(.vertical, 8)
  }

  private func jumpButton(_ icon: String, help: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Image(systemName: icon).font(.system(size: 11, weight: .semibold)).frame(width: 22, height: 22)
        .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 5))
    }
    .buttonStyle(.plain).disabled(model.errorTimes.isEmpty).help(model.errorTimes.isEmpty ? "No errors" : help)
  }

  // MARK: List

  private var list: some View {
    let currentID = model.entryIndex(at: playhead).map { model.entries[$0].id }
    return ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 0) {
          if model.entries.isEmpty {
            Text(model.lines.isEmpty ? "No output was captured." : "No output matches these filters.")
              .font(.system(size: 12)).foregroundColor(.secondary).frame(maxWidth: .infinity).padding(.top, 24)
          }
          ForEach(model.entries) { entry in
            row(entry, isCurrent: entry.id == currentID, isFuture: entry.t > playhead + 0.0005)
              .id(entry.id)
          }
        }
        .padding(.vertical, 4)
      }
      .onChange(of: currentID) { id in
        guard model.follow, let id, id != lastScrolledID else { return }
        lastScrolledID = id
        proxy.scrollTo(id, anchor: .center)
      }
    }
  }

  @ViewBuilder
  private func row(_ entry: VideoEditorReproEntry, isCurrent: Bool, isFuture: Bool) -> some View {
    switch entry.content {
    case .line(let line):
      Button { seek(line.t) } label: {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          Text(ReproFormat.timestamp(line.t)).font(.system(size: 10, design: .monospaced)).foregroundColor(.secondary)
          Text(model.sourceName(line.source)).font(.system(size: 10, weight: .semibold)).lineLimit(1)
            .foregroundColor(Color(hue: model.sourceHue(line.source), saturation: 0.55, brightness: 0.85))
            .frame(width: 58, alignment: .leading)
          Text(line.text).font(.system(size: 11, design: .monospaced)).foregroundColor(color(line.level))
            .frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 10).padding(.vertical, 2.5)
        .background(rowBackground(level: line.level, isCurrent: isCurrent))
        .opacity(isFuture ? 0.42 : (line.isOffscreen ? 0.6 : 1))
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .help(line.isOffscreen ? "Written before recording started or while paused" : "Jump to \(ReproFormat.timestamp(line.t))")
      .contextMenu {
        Button("Copy line") { copy(line.text) }
        Button("Copy with time and source") { copy("[\(ReproFormat.timestamp(line.t))] \(model.sourceName(line.source)) | \(line.text)") }
        Button("Show only \(model.sourceName(line.source))") {
          model.hiddenSources = Set(model.session?.sources.map(\.id) ?? []).subtracting([line.source])
        }
      }
    case .marker(let marker):
      Button { seek(marker.t) } label: {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          Text(ReproFormat.timestamp(marker.t)).font(.system(size: 10, design: .monospaced)).foregroundColor(.secondary)
          Image(systemName: ReproMarkerStyle.icon(marker)).font(.system(size: 10, weight: .bold)).foregroundColor(ReproMarkerStyle.color(marker))
          VStack(alignment: .leading, spacing: 1) {
            Text(marker.label).font(.system(size: 11, weight: .semibold))
            if let detail = marker.detail { Text(detail).font(.system(size: 10)).foregroundColor(.secondary).lineLimit(3) }
          }
          Spacer(minLength: 0)
          if let by = marker.by, marker.kind == .note || marker.kind == .check { Text(by).font(.system(size: 9)).foregroundColor(.secondary).lineLimit(1) }
        }
        .padding(.horizontal, 10).padding(.vertical, 5)
        .background(ReproMarkerStyle.color(marker).opacity(isCurrent ? 0.22 : 0.1))
        .overlay(alignment: .leading) { Rectangle().fill(ReproMarkerStyle.color(marker)).frame(width: 2) }
        .opacity(isFuture ? 0.5 : 1)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
    }
  }

  private func color(_ level: ReproLogLevel) -> Color {
    switch level { case .error: return .red; case .warning: return .orange; case .debug: return .secondary; case .info: return .primary }
  }

  private func rowBackground(level: ReproLogLevel, isCurrent: Bool) -> Color {
    if isCurrent { return Color.accentColor.opacity(0.18) }
    if level == .error { return Color.red.opacity(0.07) }
    return .clear
  }

  // MARK: Footer

  private func footer(_ session: ReproSession) -> some View {
    HStack(spacing: 8) {
      Button { exportBundle() } label: {
        if model.isExporting { ProgressView().controlSize(.small) } else { Label("Export…", systemImage: "square.and.arrow.up") }
      }
      .disabled(model.isExporting).help("Save the video, summary, logs, and diffs as a shareable folder")
      Button { copy(model.agentBrief()); model.message = "Summary copied" } label: { Label("Copy summary", systemImage: "doc.on.clipboard") }
        .help("Copy a Markdown summary with errors, markers, and the repro id for agents")
      Spacer(minLength: 0)
      if let message = model.message {
        Text(message).font(.system(size: 10)).foregroundColor(.secondary).lineLimit(1)
          .onAppear { DispatchQueue.main.asyncAfter(deadline: .now() + 3) { model.message = nil } }
      }
    }
    .controlSize(.small)
    .padding(.horizontal, 12).padding(.vertical, 8)
  }

  // MARK: Actions

  private func seek(_ t: Double) {
    state.pause()
    state.seek(to: CMTime(seconds: t, preferredTimescale: 600))
    playhead = t
  }

  private func jumpToError(forward: Bool) {
    guard let t = model.error(after: playhead, forward: forward) else { return }
    if model.level == .all, !model.search.isEmpty { model.search = "" }
    seek(t)
  }

  private func copy(_ text: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
  }

  private func exportBundle() {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.canCreateDirectories = true
    panel.prompt = "Export Here"
    panel.message = "Choose where to save the repro folder."
    panel.directoryURL = ReproExport.defaultDestination.deletingLastPathComponent()
    guard panel.runModal() == .OK, let folder = panel.url else { return }
    Task {
      if let url = await model.export(to: folder) {
        NSWorkspace.shared.activateFileViewerSelecting([url])
        model.message = "Exported"
      }
    }
  }
}

// MARK: - Shared pieces

struct ReproVerdictBadge: View {
  let verdict: ReproSummary.Verdict
  var body: some View {
    Label(title, systemImage: icon)
      .font(.system(size: 10, weight: .semibold))
      .foregroundColor(color)
      .padding(.horizontal, 6).padding(.vertical, 2)
      .background(color.opacity(0.14), in: Capsule())
  }
  private var title: String {
    switch verdict { case .clean: return "Clean"; case .errors: return "Errors"; case .failed: return "Failed" }
  }
  private var icon: String {
    switch verdict { case .clean: return "checkmark.seal.fill"; case .errors: return "exclamationmark.triangle.fill"; case .failed: return "xmark.octagon.fill" }
  }
  var color: Color {
    switch verdict { case .clean: return .green; case .errors: return .orange; case .failed: return .red }
  }
}

struct ReproStat: View {
  let value: Int
  let label: String
  let color: Color
  var body: some View {
    HStack(spacing: 3) {
      Text(value.formatted()).font(.system(size: 11, weight: .semibold)).monospacedDigit().foregroundColor(color)
      Text(label).font(.system(size: 10)).foregroundColor(.secondary)
    }
  }
}

enum ReproMarkerStyle {
  static func color(_ marker: ReproMarker) -> Color {
    switch marker.outcome {
    case .fail: return .red
    case .pass: return .green
    default:
      switch marker.kind {
      case .serviceReady: return .green
      case .note, .check: return .purple
      case .step, .runStarted, .runFinished: return .blue
      default: return .secondary
      }
    }
  }
  static func icon(_ marker: ReproMarker) -> String {
    switch marker.kind {
    case .check: return marker.outcome == .fail ? "xmark.circle.fill" : "checkmark.circle.fill"
    case .note: return "flag.fill"
    case .step: return marker.outcome == .fail ? "xmark.circle.fill" : marker.outcome == .pass ? "checkmark.circle.fill" : "play.circle.fill"
    case .runStarted: return "play.fill"
    case .runFinished: return marker.outcome == .fail ? "xmark.octagon.fill" : "flag.checkered"
    case .serviceStarting: return "arrow.up.circle"
    case .serviceReady: return "checkmark.circle"
    case .serviceUnhealthy: return "heart.slash"
    case .serviceCrashed: return "bolt.trianglebadge.exclamationmark.fill"
    case .serviceStopped: return "stop.circle"
    }
  }
}

/// Error ticks and marker flags drawn over the editor's frame strip.
struct VideoEditorReproTimelineMarks: View {
  @ObservedObject var model: VideoEditorReproModel
  let duration: Double
  let width: CGFloat
  let height: CGFloat

  var body: some View {
    let errors = model.errorTimes
    let warnings = model.warningTimes
    let markers = model.session?.markers ?? []
    Canvas { context, size in
      guard duration > 0 else { return }
      func x(_ t: Double) -> CGFloat { CGFloat(min(max(t / duration, 0), 1)) * size.width }
      // One tick per two points keeps dense output legible.
      func ticks(_ times: [Double], color: Color, height tickHeight: CGFloat) {
        var drawn = Set<Int>()
        for t in times {
          let position = x(t)
          guard drawn.insert(Int(position / 2)).inserted else { continue }
          context.fill(Path(CGRect(x: position - 0.75, y: size.height - tickHeight, width: 1.5, height: tickHeight)), with: .color(color))
        }
      }
      ticks(warnings, color: .orange.opacity(0.85), height: 6)
      ticks(errors, color: .red, height: 10)
      for marker in markers {
        let position = x(marker.t)
        var flag = Path()
        flag.move(to: CGPoint(x: position - 4, y: 0))
        flag.addLine(to: CGPoint(x: position + 4, y: 0))
        flag.addLine(to: CGPoint(x: position, y: 6))
        flag.closeSubpath()
        context.fill(flag, with: .color(ReproMarkerStyle.color(marker)))
      }
    }
    .frame(width: width, height: height)
    .allowsHitTesting(false)
  }
}
