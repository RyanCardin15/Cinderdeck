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
    /// An agent or Workspaces recording finished.
    case saved(ReproSession)
    /// An ordinary recording was saved with workspace logs.
    case captured(ReproSession)
  }

  final class Model: ObservableObject {
    @Published var phase: Phase = .recording
  }

  private var panel: NSPanel?
  private let model = Model()
  private var hideTask: Task<Void, Never>?

  func showRecording() { show(.recording) }
  func showFinalizing() { show(.finalizing) }

  func showSaved(_ session: ReproSession) { showBriefly(.saved(session)) }

  /// Confirms that an ordinary recording kept its workspace logs, and where.
  func showCaptured(_ session: ReproSession) { showBriefly(.captured(session)) }

  private func showBriefly(_ phase: Phase) {
    show(phase)
    hideTask = Task { [weak self] in
      try? await Task.sleep(nanoseconds: 10_000_000_000)
      guard !Task.isCancelled else { return }
      self?.hide()
    }
  }

  /// Keeps the confirmation up while the pointer is over it.
  func holdOpen(_ hovering: Bool) {
    switch model.phase {
    case .recording, .finalizing: return
    case .saved, .captured: break
    }
    if hovering { hideTask?.cancel(); hideTask = nil; return }
    guard hideTask == nil, panel?.isVisible == true else { return }
    hideTask = Task { [weak self] in
      try? await Task.sleep(nanoseconds: 4_000_000_000)
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
    let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 528, height: 64),
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
    let host = NSHostingView(rootView: ReproControlsView(model: model, recorder: .shared, controller: .shared,
      close: { [weak self] in self?.hide() }, hover: { [weak self] in self?.holdOpen($0) }))
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
  let hover: (Bool) -> Void
  @State private var pulse = false
  @State private var copied = false

  var body: some View {
    HStack(spacing: 12) {
      switch model.phase {
      case .recording: recording
      case .finalizing: finalizing
      case .saved(let session): finished(session, agent: true)
      case .captured(let session): finished(session, agent: false)
      }
    }
    .onHover(perform: hover)
    .onChange(of: model.phase) { _ in copied = false }
    .padding(.horizontal, 14)
    .frame(width: 520, height: 56)
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
        Text(recorder.live?.title ?? "Recording with logs").font(.system(size: 12, weight: .semibold)).lineLimit(1)
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

  private func finished(_ session: ReproSession, agent: Bool) -> some View {
    Group {
      Image(systemName: session.errorCount > 0 ? "text.badge.xmark" : "text.badge.checkmark")
        .foregroundColor(session.errorCount > 0 ? .orange : .green).font(.system(size: 17, weight: .semibold))
      VStack(alignment: .leading, spacing: 2) {
        Text(agent ? "Recording saved with logs" : "Logs saved with your video").font(.system(size: 12, weight: .semibold)).lineLimit(1)
        Text(detail(session)).font(.system(size: 10.5)).foregroundColor(.secondary).lineLimit(1).truncationMode(.middle)
      }
      Spacer(minLength: 4)
      Button("Show Log") {
        Task { await ReproLibraryActions.revealLog(session) }
      }
      .controlSize(.small).help(session.logFile ?? "Show the log file in Finder")
      Button(copied ? "Copied" : "Copy Log") {
        Task { await ReproLibraryActions.copyLog(session); copied = true }
      }
      .controlSize(.small).help("Copy the whole log, stamped with video times, to paste into an issue or an agent")
      if agent {
        iconButton("play.rectangle", help: "Open the video with its logs") { ReproLibraryActions.open(session); close() }
      }
      iconButton("xmark", help: "Dismiss") { close() }
    }
  }

  private func detail(_ session: ReproSession) -> String {
    var parts = ["\(session.lineCount.formatted()) lines"]
    let names = session.workspaceNames
    if !names.isEmpty { parts[0] += " from \(ReproFormat.list(names))" }
    if session.errorCount > 0 { parts.append("\(session.errorCount) error\(session.errorCount == 1 ? "" : "s")") }
    if !session.markers.filter(\.isFailure).isEmpty { parts.append("\(session.markers.filter(\.isFailure).count) failed") }
    return parts.joined(separator: " · ")
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

  /// Shows the log file in Finder: beside the video when it is there.
  static func revealLog(_ session: ReproSession) async {
    let recorder = ReproRecorder.shared
    let current = recorder.current(session.id) ?? session
    if let url = await recorder.logFileURL(for: current) {
      NSWorkspace.shared.activateFileViewerSelecting([url])
    } else {
      NSWorkspace.shared.activateFileViewerSelecting([recorder.store.folder(session.id)])
    }
  }

  /// Copies the whole log file text: header, sources, and every stamped line.
  static func copyLog(_ session: ReproSession) async {
    let recorder = ReproRecorder.shared
    let text = await recorder.logText(for: recorder.current(session.id) ?? session)
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
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
