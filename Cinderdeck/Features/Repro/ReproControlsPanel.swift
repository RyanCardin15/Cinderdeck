import AppKit
import SwiftUI

/// Floating controls for repros recorded without the toolbar: who is recording,
/// elapsed time, live error count, and Mark, Pause, and Stop. Cinderdeck windows
/// are excluded from these recordings, so the panel never appears in the video.
@MainActor
final class ReproControlsPanel {
  static let shared = ReproControlsPanel()

  enum Phase: Equatable {
    case recording
    case finalizing
    case saved(ReproSession)
  }

  final class Model: ObservableObject {
    @Published var phase: Phase = .recording
  }

  private var panel: NSPanel?
  private let model = Model()
  private var hideTask: Task<Void, Never>?

  func showRecording() { show(.recording) }
  func showFinalizing() { show(.finalizing) }

  func showSaved(_ session: ReproSession) {
    show(.saved(session))
    hideTask = Task { [weak self] in
      try? await Task.sleep(nanoseconds: 9_000_000_000)
      guard !Task.isCancelled else { return }
      self?.hide()
    }
  }

  func hide() {
    hideTask?.cancel(); hideTask = nil
    panel?.orderOut(nil)
  }

  private func show(_ phase: Phase) {
    hideTask?.cancel(); hideTask = nil
    model.phase = phase
    let panel = self.panel ?? makePanel()
    self.panel = panel
    if !panel.isVisible { position(panel) }
    panel.orderFrontRegardless()
  }

  private func makePanel() -> NSPanel {
    let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 440, height: 64),
      styleMask: [.nonactivatingPanel, .borderless], backing: .buffered, defer: false)
    panel.isFloatingPanel = true
    panel.level = .statusBar
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
    panel.backgroundColor = .clear
    panel.isOpaque = false
    panel.hasShadow = true
    panel.hidesOnDeactivate = false
    panel.isMovableByWindowBackground = true
    panel.sharingType = .none
    let host = NSHostingView(rootView: ReproControlsView(model: model, recorder: .shared, controller: .shared) { [weak self] in self?.hide() })
    host.frame = panel.contentRect(forFrameRect: panel.frame)
    host.autoresizingMask = [.width, .height]
    panel.contentView = host
    return panel
  }

  private func position(_ panel: NSPanel) {
    guard let screen = NSScreen.main ?? NSScreen.screens.first else { return }
    let size = panel.frame.size
    let frame = screen.visibleFrame
    panel.setFrameOrigin(NSPoint(x: frame.midX - size.width / 2, y: frame.maxY - size.height - 12))
  }
}

private struct ReproControlsView: View {
  @ObservedObject var model: ReproControlsPanel.Model
  @ObservedObject var recorder: ReproRecorder
  @ObservedObject var controller: ReproRecordingController
  @ObservedObject private var screen = ScreenRecordingManager.shared
  let close: () -> Void
  @State private var pulse = false

  var body: some View {
    HStack(spacing: 12) {
      switch model.phase {
      case .recording: recording
      case .finalizing: finalizing
      case .saved(let session): saved(session)
      }
    }
    .padding(.horizontal, 14)
    .frame(width: 440, height: 56)
    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.primary.opacity(0.08)))
    .padding(4)
  }

  // MARK: Recording

  private var recording: some View {
    Group {
      Circle().fill(Color.red).frame(width: 10, height: 10)
        .opacity(screen.isPaused ? 0.35 : (pulse ? 0.45 : 1))
        .animation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true), value: pulse)
        .onAppear { pulse = true }
      VStack(alignment: .leading, spacing: 2) {
        Text(recorder.live?.title ?? "Recording repro").font(.system(size: 12, weight: .semibold)).lineLimit(1)
        TimelineView(.periodic(from: .now, by: 1)) { _ in
          Text(subtitle).font(.system(size: 10.5)).foregroundColor(.secondary).monospacedDigit().lineLimit(1)
        }
      }
      Spacer(minLength: 4)
      if let live = recorder.live, live.errors > 0 {
        Label("\(live.errors)", systemImage: "exclamationmark.triangle.fill")
          .font(.system(size: 11, weight: .semibold)).foregroundColor(.red)
          .help(live.lastError ?? "Errors in captured output")
      }
      iconButton(screen.isPaused ? "play.fill" : "pause.fill", help: screen.isPaused ? "Resume" : "Pause") {
        ScreenRecordingManager.shared.togglePause()
      }
      iconButton("flag.fill", help: "Add a marker at this moment") {
        _ = try? recorder.addMarker(label: "Marked by you", kind: .note, by: StackActor.user.label)
      }
      Button {
        Task { _ = try? await controller.stop() }
      } label: {
        Label("Stop", systemImage: "stop.fill").font(.system(size: 11, weight: .semibold))
      }
      .buttonStyle(.borderedProminent).tint(.red).controlSize(.small)
      .help("Stop recording and save the repro")
    }
  }

  private var subtitle: String {
    var parts: [String] = []
    if let actor = controller.activeActor, actor.isAgent { parts.append("for \(actor.name)") }
    parts.append(ReproFormat.timestamp(recorder.now, precise: false))
    if let live = recorder.live {
      parts.append("\(live.lines.formatted()) lines")
      if live.sources > 0 { parts.append("\(live.sources) source\(live.sources == 1 ? "" : "s")") }
      if live.markers > 0 { parts.append("\(live.markers) marker\(live.markers == 1 ? "" : "s")") }
    }
    if screen.isPaused { parts.append("paused") }
    return parts.joined(separator: " · ")
  }

  // MARK: Finalizing and saved

  private var finalizing: some View {
    Group {
      ProgressView().controlSize(.small)
      Text("Saving repro…").font(.system(size: 12, weight: .semibold))
      Spacer()
    }
  }

  private func saved(_ session: ReproSession) -> some View {
    let summary = ReproSummary(session: session, lines: [])
    return Group {
      Image(systemName: "checkmark.circle.fill").foregroundColor(.green).font(.system(size: 18))
      VStack(alignment: .leading, spacing: 2) {
        Text("Repro saved").font(.system(size: 12, weight: .semibold))
        Text("\(ReproFormat.duration(session.duration)) · \(summary.headline)").font(.system(size: 10.5)).foregroundColor(.secondary).lineLimit(1)
      }
      Spacer(minLength: 4)
      Button("Open") {
        ReproLibraryActions.open(session)
        close()
      }.controlSize(.small)
      iconButton("folder", help: "Show in Finder") {
        NSWorkspace.shared.activateFileViewerSelecting([session.videoURL ?? recorder.store.folder(session.id)])
      }
      iconButton("xmark", help: "Dismiss") { close() }
    }
  }

  private func iconButton(_ icon: String, help: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Image(systemName: icon).font(.system(size: 11, weight: .semibold)).frame(width: 26, height: 26)
        .background(Color.primary.opacity(0.07), in: Circle())
    }
    .buttonStyle(.plain).help(help)
  }
}

/// Actions shared by the controls, Workspaces, and the control API.
@MainActor
enum ReproLibraryActions {
  /// Opens the video in the editor with its logs, optionally at a moment.
  static func open(_ session: ReproSession, at t: Double? = nil) {
    guard let video = session.videoURL, FileManager.default.fileExists(atPath: video.path) else {
      NSWorkspace.shared.activateFileViewerSelecting([ReproRecorder.shared.store.folder(session.id)])
      return
    }
    if let t { VideoEditorReproModel.requestSeek(t, video: video) }
    VideoEditorManager.shared.openEditor(for: video)
    NSApp.activate(ignoringOtherApps: true)
  }

  static func copySummary(_ session: ReproSession) async {
    let lines = await ReproRecorder.shared.lines(for: session.id)
    let text = ReproReport.markdown(session, lines: lines, videoFile: session.videoPath)
      + "\n---\nCinderdeck repro id: `\(session.id.uuidString)`. Agents can inspect it with `repro_summary`, `repro_logs`, and `repro_frame`.\n"
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
  }

  static func export(_ session: ReproSession) {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.canCreateDirectories = true
    panel.prompt = "Export Here"
    panel.message = "Choose where to save the repro folder."
    guard panel.runModal() == .OK, let folder = panel.url else { return }
    Task {
      do {
        let url = try await ReproExport.export(session, to: folder)
        NSWorkspace.shared.activateFileViewerSelecting([url])
      } catch {
        let alert = NSAlert()
        alert.messageText = "Could not export the repro"
        alert.informativeText = error.localizedDescription
        alert.runModal()
      }
    }
  }
}
