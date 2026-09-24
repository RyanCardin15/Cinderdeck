import AppKit
import SwiftUI

/// Workspaces → Recordings: screen recordings saved with workspace logs. The log
/// file (every line stamped with its video time) is the main thing people take away.
struct WorkspaceReprosView: View {
  let file: StackDefinitionFile
  @ObservedObject var recorder: ReproRecorder
  @ObservedObject var controller: ReproRecordingController
  @ObservedObject var runner: WorkspaceRunner
  @State private var selected: UUID?
  @State private var allWorkspaces = false
  @State private var error: String?
  @State private var starting = false

  private var repros: [ReproSession] {
    recorder.sessions.filter { allWorkspaces || $0.workspaceIDs.contains(file.id) || $0.sources.contains { $0.workspace == file.id } }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      toolbar
      HStack(spacing: 6) {
        WorkspaceLogScopeMenu()
        Text("Change this anytime from the logs button on the recording toolbar.").font(.caption).foregroundColor(.secondary)
      }
      if let error {
        HStack { Label(error, systemImage: "exclamationmark.triangle").textSelection(.enabled); Spacer(); Button("Dismiss") { self.error = nil } }
          .font(.callout).foregroundColor(.orange)
      }
      if let live = recorder.live { liveBanner(live) }
      if repros.isEmpty && recorder.live == nil {
        emptyState
      } else {
        HSplitView {
          list.frame(minWidth: 210, idealWidth: 250, maxWidth: 320)
          if let session = repros.first(where: { $0.id == selected }) ?? repros.first {
            WorkspaceReproDetail(session: session, recorder: recorder).id(session.id)
          } else { Spacer() }
        }
      }
    }
  }

  // MARK: Toolbar

  private var toolbar: some View {
    HStack {
      Text("\(repros.count) \(repros.count == 1 ? "recording" : "recordings")").foregroundColor(.secondary)
      Picker("Show", selection: $allWorkspaces) {
        Text("With \(file.name)").tag(false)
        Text("All workspaces").tag(true)
      }.pickerStyle(.segmented).labelsHidden().fixedSize()
      Spacer()
      Menu {
        Button { record() } label: { Label("Record the screen with \(file.name) logs", systemImage: "record.circle") }
        Button { NSWorkspace.shared.open(URL(string: "cinderdeck://record")!) } label: { Label("Record an area or window…", systemImage: "rectangle.dashed") }
        if let workspace = file.definition, !(workspace.tasks.isEmpty && workspace.workflows.isEmpty) {
          Divider()
          ForEach(workspace.workflows) { workflow in
            Button { record(kind: .workflow, id: workflow.id) } label: { Label("Record workflow: \(workflow.name)", systemImage: "arrow.triangle.branch") }
          }
          ForEach(workspace.tasks) { task in
            Button { record(kind: .task, id: task.id) } label: { Label("Record task: \(task.name)", systemImage: "terminal") }
          }
        }
      } label: {
        Label(starting ? "Starting…" : "Record with Logs", systemImage: "record.circle.fill")
      } primaryAction: {
        record()
      }
      .fixedSize()
      .disabled(recorder.isCapturing || starting)
      .help("Record the screen and save \(file.name)'s logs with it, stamped with video times")
      .accessibilityIdentifier("workspace.recordRepro")
    }
  }

  private func liveBanner(_ live: ReproRecorder.Live) -> some View {
    HStack(spacing: 10) {
      Circle().fill(Color.red).frame(width: 9, height: 9)
      VStack(alignment: .leading, spacing: 2) {
        Text(live.isFinalizing ? "Saving \(live.title)…" : "Recording \(live.title)").fontWeight(.semibold).lineLimit(1)
        TimelineView(.periodic(from: .now, by: 1)) { _ in
          Text("\(ReproFormat.timestamp(recorder.now, precise: false)) · \(live.lines) lines · \(live.errors) errors · by \(live.actor)")
            .font(.caption).foregroundColor(.secondary).monospacedDigit()
        }
      }
      Spacer()
      if controller.ownsRecording && !live.isFinalizing {
        Button { _ = try? recorder.addMarker(label: "Marked by you", kind: .note, by: StackActor.user.label) } label: { Label("Mark", systemImage: "flag") }
        Button { Task { do { _ = try await controller.stop() } catch { self.error = error.localizedDescription } } } label: { Label("Stop", systemImage: "stop.fill") }
          .buttonStyle(.borderedProminent).tint(.red)
      } else if !live.isFinalizing {
        Text("Stop from the recording controls").font(.caption).foregroundColor(.secondary)
      }
    }
    .padding(10).background(Color.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
  }

  private var emptyState: some View {
    VStack(spacing: 14) {
      Image(systemName: "film.stack").font(.system(size: 34)).foregroundColor(.accentColor)
      Text("Recordings with logs").font(.title2.bold())
      Text("When you record your screen, everything \(file.name) prints is saved to a .log file next to the video. Every line is stamped with its time in the video, so you can see what the app logged at the moment something went wrong.")
        .foregroundColor(.secondary).multilineTextAlignment(.center).frame(maxWidth: 480)
      HStack {
        Button("Record Screen with Logs") { record() }.buttonStyle(.borderedProminent)
        if let workflow = file.definition?.workflows.first {
          Button("Record \(workflow.name)") { record(kind: .workflow, id: workflow.id) }
        }
      }.disabled(recorder.isCapturing || starting)
      Text("Recordings you make with the usual toolbar or shortcut show up here too, whenever this workspace is running.").font(.caption).foregroundColor(.secondary)
    }.frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  // MARK: List

  private var list: some View {
    ScrollView {
      LazyVStack(spacing: 6) {
        ForEach(repros) { session in
          Button { selected = session.id } label: { WorkspaceReproRow(session: session, selected: (selected ?? repros.first?.id) == session.id) }
            .buttonStyle(.plain)
            .contextMenu {
              Button("Open in video editor") { ReproLibraryActions.open(session) }
              Button("Export…") { ReproLibraryActions.export(session) }
              Button("Copy summary") { Task { await ReproLibraryActions.copySummary(session) } }
              Divider()
              Button("Delete…", role: .destructive) { delete(session) }
            }
        }
      }
    }
  }

  // MARK: Actions

  private func record(kind: WorkspaceRunKind? = nil, id: String? = nil) {
    guard !starting else { return }
    starting = true
    error = nil
    var options = ReproRecordingController.Options()
    options.workspaces = [file.id]
    options.maxSeconds = 1800
    Task {
      defer { starting = false }
      do {
        if let kind, let id {
          let (session, _) = try await controller.startRun(options, workspace: file.id, kind: kind, definitionID: id, actor: .user, runner: runner, origin: .workspace)
          selected = session.id
        } else {
          options.title = "\(file.name) recording"
          selected = try await controller.start(options, origin: .workspace, actor: .user).id
        }
      } catch let failure as StackControlError { error = failure.message }
      catch { self.error = error.localizedDescription }
    }
  }

  private func delete(_ session: ReproSession) {
    let alert = NSAlert()
    alert.messageText = "Delete “\(session.title)”?"
    let keepsVideo = session.videoPath.map { !$0.hasPrefix(recorder.store.folder(session.id).path) } ?? false
    alert.informativeText = keepsVideo
      ? "The video and the .log file next to it stay where they were saved. Cinderdeck's copy of the logs and markers is removed."
      : "The video, its log file, and markers are removed."
    alert.addButton(withTitle: "Delete"); alert.addButton(withTitle: "Cancel")
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    do { try recorder.delete(session.id) } catch { self.error = error.localizedDescription }
  }
}

private struct WorkspaceReproRow: View {
  let session: ReproSession
  let selected: Bool
  var body: some View {
    let summary = ReproSummary(session: session, lines: [])
    VStack(alignment: .leading, spacing: 5) {
      HStack(alignment: .firstTextBaseline) {
        Text(session.title).fontWeight(.semibold).lineLimit(1)
        Spacer(minLength: 4)
        if session.status == .ready { ReproVerdictBadge(verdict: summary.verdict) }
        else { Text(session.status.rawValue.capitalized).font(.caption2.weight(.semibold)).foregroundColor(.secondary) }
      }
      Text("\(session.createdAt.formatted(date: .abbreviated, time: .shortened)) · \(ReproFormat.duration(session.duration))")
        .font(.caption).foregroundColor(.secondary)
      if !session.workspaceNames.isEmpty {
        Label(ReproFormat.list(session.workspaceNames), systemImage: "square.stack.3d.up").font(.caption).foregroundColor(.secondary).lineLimit(1)
      }
      HStack(spacing: 8) {
        if session.actor.isAgent { Label(session.actor.name, systemImage: "sparkles").font(.caption2).foregroundColor(.purple) }
        Text("\(session.lineCount) lines").font(.caption2).foregroundColor(.secondary)
        if session.errorCount > 0 { Text("\(session.errorCount) errors").font(.caption2).foregroundColor(.red) }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading).padding(10).contentShape(Rectangle())
    .background(selected ? Color.accentColor.opacity(0.12) : .clear, in: RoundedRectangle(cornerRadius: 8))
  }
}

private struct WorkspaceReproDetail: View {
  let session: ReproSession
  @ObservedObject var recorder: ReproRecorder
  @State private var lines: [ReproLogLine] = []
  @State private var loaded = false
  @State private var renaming = false
  @State private var newTitle = ""
  @State private var copied = false

  var body: some View {
    let summary = ReproSummary(session: session, lines: lines)
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        VStack(alignment: .leading, spacing: 6) {
          HStack(alignment: .firstTextBaseline) {
            Text(session.title).font(.title3.bold()).lineLimit(2)
            if session.status == .ready { ReproVerdictBadge(verdict: summary.verdict) }
            Spacer()
          }
          Text(summary.headline).foregroundColor(.secondary)
          Text(meta).font(.caption).foregroundColor(.secondary).textSelection(.enabled)
          if let log = session.logFile {
            Label(log.replacingOccurrences(of: FileManager.default.homeDirectoryForCurrentUser.path, with: "~"), systemImage: "doc.text")
              .font(.caption).foregroundColor(.secondary).textSelection(.enabled).lineLimit(1).truncationMode(.middle)
          }
          if let detail = session.detail { Text(detail).font(.callout).foregroundColor(.orange) }
        }
        HStack {
          Button { Task { await ReproLibraryActions.revealLog(session) } } label: { Label("Show Log File", systemImage: "doc.text.magnifyingglass") }
            .buttonStyle(.borderedProminent)
            .help("The .log file with every line stamped with its video time")
          Button {
            Task { await ReproLibraryActions.copyLog(session); copied = true; try? await Task.sleep(nanoseconds: 2_000_000_000); copied = false }
          } label: { Label(copied ? "Copied" : "Copy Log", systemImage: copied ? "checkmark" : "doc.on.clipboard") }
            .help("Copy the whole log to paste into an issue or an agent")
          Button { ReproLibraryActions.open(session) } label: { Label("Open Video", systemImage: "play.rectangle") }
            .disabled(session.videoURL == nil)
            .help("Open the video in the editor with its log panel")
          Menu {
            Button("Export Bundle…") { ReproLibraryActions.export(session) }
            Button("Copy Summary for an Agent") { Task { await ReproLibraryActions.copySummary(session) } }
            Divider()
            Button("Show Video in Finder") { NSWorkspace.shared.activateFileViewerSelecting([session.videoURL ?? recorder.store.folder(session.id)]) }
            Button("Rename…") { newTitle = session.title; renaming = true }
            Button("Copy Recording ID") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(session.id.uuidString, forType: .string) }
          } label: { Image(systemName: "ellipsis.circle") }.menuStyle(.borderlessButton).fixedSize()
        }
        .disabled(session.status.isActive)

        if !session.markers.isEmpty {
          section("Timeline") {
            ForEach(session.markers) { marker in
              Button { ReproLibraryActions.open(session, at: marker.t) } label: {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                  Text(ReproFormat.timestamp(marker.t)).font(.system(.caption, design: .monospaced)).foregroundColor(.secondary)
                  Image(systemName: ReproMarkerStyle.icon(marker)).foregroundColor(ReproMarkerStyle.color(marker)).font(.caption)
                  Text(marker.label).font(.callout)
                  if let detail = marker.detail { Text(detail).font(.caption).foregroundColor(.secondary).lineLimit(1) }
                  Spacer(minLength: 0)
                }.contentShape(Rectangle())
              }.buttonStyle(.plain).help("Open the video at \(ReproFormat.timestamp(marker.t))")
            }
          }
        }

        if !summary.topErrors.isEmpty {
          section("Errors") {
            ForEach(Array(summary.topErrors.enumerated()), id: \.offset) { _, error in
              Button { ReproLibraryActions.open(session, at: error.t) } label: {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                  Text(error.time).font(.system(.caption, design: .monospaced)).foregroundColor(.secondary)
                  Text(error.source).font(.caption.weight(.semibold))
                  Text(error.text).font(.system(.caption, design: .monospaced)).foregroundColor(.red).lineLimit(2)
                  Spacer(minLength: 0)
                }.contentShape(Rectangle())
              }.buttonStyle(.plain)
            }
          }
        } else if loaded && session.lineCount > 0 {
          Label("No errors in captured output", systemImage: "checkmark.circle").foregroundColor(.green).font(.callout)
        }

        ForEach(session.workspaces, id: \.id) { workspace in
          section("\(workspace.name) when recording started") {
            ForEach(workspace.services, id: \.name) { service in
              HStack {
                Text(service.name).font(.callout.weight(.medium))
                Text(service.status).font(.caption).foregroundColor(.secondary)
                Spacer()
                if let port = service.port { Text(":\(port)").font(.caption.monospacedDigit()).foregroundColor(.secondary) }
              }
            }
            ForEach(workspace.repos, id: \.id) { repo in
              VStack(alignment: .leading, spacing: 2) {
                Label("\(repo.id): \(repo.branch) @ \(repo.head.map { String($0.prefix(8)) } ?? "?")", systemImage: "arrow.triangle.branch").font(.callout)
                if !repo.changedFiles.isEmpty {
                  Text("\(repo.changedFiles.count) uncommitted: " + repo.changedFiles.prefix(6).joined(separator: ", ") + (repo.changedFiles.count > 6 ? ", …" : ""))
                    .font(.caption).foregroundColor(.secondary).lineLimit(2)
                }
              }
            }
          }
        }

        if !session.sources.isEmpty {
          section("Sources") {
            ForEach(session.sources) { source in
              HStack {
                Image(systemName: source.kind == .task ? "terminal" : "server.rack").foregroundColor(.secondary).font(.caption)
                Text(source.name).font(.callout)
                if source.workspace != session.workspaceIDs.first { Text(source.workspaceName).font(.caption).foregroundColor(.secondary) }
                Spacer()
                Text("\(source.lineCount)").font(.caption.monospacedDigit()).foregroundColor(.secondary)
                if source.errorCount > 0 { Text("\(source.errorCount) errors").font(.caption).foregroundColor(.red) }
              }
            }
          }
        }
      }.padding(.leading, 12).padding(.bottom, 12)
    }
    .task(id: session.id) {
      lines = await recorder.lines(for: session.id)
      loaded = true
    }
    .alert("Rename recording", isPresented: $renaming) {
      TextField("Title", text: $newTitle)
      Button("Rename") { recorder.rename(session.id, to: newTitle) }
      Button("Cancel", role: .cancel) {}
    }
  }

  private var meta: String {
    var parts = [session.createdAt.formatted(date: .abbreviated, time: .shortened), ReproFormat.duration(session.duration), "by \(session.actor.label)"]
    if let capture = session.capture { parts.append(capture) }
    return parts.joined(separator: " · ")
  }

  private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: 7) {
      Text(title).font(.headline)
      content()
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .stackSurface(cornerRadius: 10)
  }
}
