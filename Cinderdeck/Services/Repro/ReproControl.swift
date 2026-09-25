import AppKit
import Foundation

/// `repro.*` methods on the control socket, used by the MCP tools and
/// `cinderdeck repro`. Times are seconds on the video timeline.
extension StackControlService {
  func handleRepro(_ method: String, params: JSONValue, actor: StackActor) async throws -> JSONValue {
    let recorder = ReproRecorder.shared
    let controller = ReproRecordingController.shared
    switch method {
    case "repro.start":
      var options = ReproRecordingController.Options()
      options.title = params["title"]?.stringValue
      options.display = params["display"]?.stringValue
      options.window = params["window"]?.stringValue
      if let raw = params["window_id"] ?? params["windowId"] {
        guard let value = raw.intValue, value > 0, value <= Int(UInt32.max) else { throw StackControlError.invalid("window_id must be a window id from list_repro_windows") }
        options.windowID = CGWindowID(value)
      }
      options.note = params["note"]?.stringValue
      options.systemAudio = params["system_audio"]?.boolValue ?? params["systemAudio"]?.boolValue ?? false
      if let seconds = params["max_seconds"]?.doubleValue ?? params["maxSeconds"]?.doubleValue {
        guard seconds.isFinite, seconds > 0 else { throw StackControlError.invalid("max_seconds must be positive") }
        options.maxSeconds = seconds
      }
      if let names = params["workspaces"]?.stringsValue, !names.isEmpty {
        options.workspaces = Set(try names.map { try workspaceFile(.object(["workspace": .string($0)])).id })
      }
      let task = params["task"]?.stringValue, workflow = params["workflow"]?.stringValue
      // logs: false records a plain video: no workspace output, only markers and lines the agent adds.
      let logsOff = params["logs"]?.boolValue == false
      if logsOff {
        guard task == nil, workflow == nil else { throw StackControlError.invalid("logs: false cannot record a task or workflow run; its output is the point") }
        guard params["workspace"] == nil, params["workspaces"] == nil else { throw StackControlError.invalid("Pass workspace or logs: false, not both") }
        options.workspaces = []
      }
      if task != nil || workflow != nil {
        guard task == nil || workflow == nil else { throw StackControlError.invalid("Pass task or workflow, not both") }
        guard let workspaceName = params["workspace"]?.stringValue ?? options.workspaces?.first else {
          throw StackControlError.invalid("Pass workspace with task or workflow")
        }
        let file = try workspaceFile(.object(["workspace": .string(workspaceName)]))
        try checkClaim(file.id, actor: actor, force: params["force"]?.boolValue == true)
        let kind: WorkspaceRunKind = task != nil ? .task : .workflow
        let (session, run) = try await controller.startRun(options, workspace: file.id, kind: kind, definitionID: task ?? workflow ?? "",
          actor: actor, runner: workspaceRunner)
        var result = reproPayload(session, lines: [], compact: true)
        result["run"] = try JSONValue(encoding: run)
        result["next"] = .string("Recording while \(run.name) runs; it stops about 1.5s after the run finishes. Call wait_for_repro with this repro id, then repro_summary.")
        return .object(result)
      }
      if let workspace = params["workspace"]?.stringValue, options.workspaces == nil {
        options.workspaces = [try workspaceFile(.object(["workspace": .string(workspace)])).id]
      }
      let session = try await controller.start(options, origin: .agent, actor: actor)
      var result = reproPayload(session, lines: [], compact: true)
      result["next"] = .string("Recording. Reproduce the issue, call mark_repro at each step (outcome pass/fail for checks), then stop_repro_recording.")
      return .object(result)

    case "repro.windows":
      let candidates = try await controller.windows()
      let screens = NSScreen.screens
      let query = params["query"]?.stringValue?.trimmingCharacters(in: .whitespaces).lowercased() ?? ""
      let matching = candidates.filter { candidate in
        query.isEmpty || candidate.ownerName.lowercased().contains(query) || (candidate.target.title ?? "").lowercased().contains(query)
      }
      return .object(["windows": .array(matching.enumerated().map { index, candidate in
        let target = candidate.target
        var object: [String: JSONValue] = [
          "id": .number(Double(target.windowID)), "app": .string(candidate.ownerName), "title": .string(target.title ?? ""),
          "order": .number(Double(index)),
          "frame": .object(["x": .number(target.frame.minX), "y": .number(target.frame.minY),
            "width": .number(target.frame.width), "height": .number(target.frame.height)]),
        ]
        if let pid = target.ownerPID { object["pid"] = .number(Double(pid)) }
        if let bundle = target.bundleIdentifier { object["bundleId"] = .string(bundle) }
        if let display = screens.firstIndex(where: { $0.displayID == target.displayID }) { object["display"] = .number(Double(display + 1)) }
        return .object(object)
      }), "next": .string("Record one with start_repro_recording window_id=<id> (CLI: repro start --window-id <id>). order 0 is frontmost.")])

    case "repro.log":
      var entries: [ReproRecorder.ExternalLine] = []
      func level(_ value: JSONValue?) throws -> ReproLogLevel? {
        guard let raw = value?.stringValue?.lowercased(), !raw.isEmpty else { return nil }
        let normalized = raw == "warn" ? "warning" : raw == "log" ? "info" : raw
        guard let value = ReproLogLevel(rawValue: normalized) else { throw StackControlError.invalid("level must be debug, info, warning, or error") }
        return value
      }
      let defaultLevel = try level(params["level"])
      if let text = params["text"]?.stringValue {
        entries += text.split(whereSeparator: \.isNewline).map { ReproRecorder.ExternalLine(text: String($0), level: defaultLevel) }
      }
      for item in params["lines"]?.arrayValue ?? [] {
        if let text = item.stringValue {
          entries.append(.init(text: text, level: defaultLevel))
        } else if let object = item.objectValue, let text = object["text"]?.stringValue {
          // at: epoch seconds, or ISO 8601, for lines read after the fact, such as a console buffer.
          var at: Date?
          if let seconds = object["at"]?.doubleValue { at = Date(timeIntervalSince1970: seconds > 1e11 ? seconds / 1000 : seconds) }
          else if let iso = object["at"]?.stringValue { at = ISO8601DateFormatter().date(from: iso) }
          entries.append(.init(text: text, at: at, level: try level(object["level"]) ?? defaultLevel))
        } else {
          throw StackControlError.invalid("Each line is a string or {text, at?, level?}")
        }
      }
      guard !entries.isEmpty else { throw StackControlError.invalid("Pass text or lines") }
      let source = params["source"]?.stringValue ?? "agent"
      let added: ReproRecorder.Added
      do { added = try await recorder.append(entries, source: source, to: params["repro"]?.stringValue) }
      catch let error as StackControlError { throw error }
      catch { throw Self.reproWriteError(error) }
      var result: [String: JSONValue] = ["added": .number(Double(added.count)), "source": .string(source), "repro": .string(added.repro.uuidString)]
      if added.late {
        result["late"] = .bool(true)
        result["note"] = .string("The recording had already stopped, so these lines were added to its saved log. Lines without at are placed at the end of the video.")
      } else {
        result["t"] = .number((recorder.now * 1000).rounded() / 1000)
      }
      return .object(result)

    case "repro.stop":
      if controller.ownsRecording {
        let saved = try await controller.stop()
        return .object(reproPayload(saved, lines: await recorder.lines(for: saved.id)))
      }
      if recorder.isCapturing {
        throw StackControlError(code: "busy", message: "A person is recording with the toolbar. They stop it; the repro is saved automatically.")
      }
      // Idempotent: a repro that already stopped (for example after its run finished) is returned as is.
      let session = await settled(try recorder.resolve(params["repro"]?.stringValue))
      return .object(reproPayload(session, lines: await recorder.lines(for: session.id)))

    case "repro.cancel":
      guard controller.ownsRecording else { throw StackControlError.notFound("No agent or workspace repro is recording") }
      await controller.cancel()
      return .object(["cancelled": .bool(true)])

    case "repro.status":
      var result: [String: JSONValue] = ["recording": .bool(recorder.isCapturing)]
      if let live = recorder.live {
        result["active"] = .object([
          "repro": .string(live.id.uuidString), "title": .string(live.title), "by": .string(live.actor),
          "elapsed": .number((recorder.now * 10).rounded() / 10), "lines": .number(Double(live.lines)),
          "errors": .number(Double(live.errors)), "warnings": .number(Double(live.warnings)), "markers": .number(Double(live.markers)),
          "paused": .bool(live.isPaused), "stopping": .bool(live.isFinalizing),
          "startedByAgent": .bool(controller.ownsRecording), "lastError": live.lastError.map(JSONValue.string) ?? .null,
        ])
      }
      if let run = controller.linkedRun { result["run"] = .string(run.uuidString) }
      result["recordingScope"] = .object(["mode": .string(recorder.scope.mode),
        "workspaces": .array(recorder.scope.workspaces.map(JSONValue.string))])
      return .object(result)

    case "repro.mark":
      guard let label = params["label"]?.stringValue else { throw StackControlError.invalid("Pass label") }
      var outcome: ReproMarker.Outcome?
      if let raw = params["outcome"]?.stringValue?.lowercased(), !raw.isEmpty {
        guard let value = ReproMarker.Outcome(rawValue: raw) else { throw StackControlError.invalid("outcome must be pass, fail, or info") }
        outcome = value
      }
      let marked: (marker: ReproMarker, repro: UUID, late: Bool)
      do {
        marked = try await recorder.mark(label: label, detail: params["detail"]?.stringValue, outcome: outcome,
          kind: outcome == nil || outcome == .info ? .note : .check, by: actor.label, to: params["repro"]?.stringValue)
      } catch let error as StackControlError { throw error }
      catch { throw Self.reproWriteError(error) }
      var result: [String: JSONValue] = ["marker": markerValue(marked.marker), "repro": .string(marked.repro.uuidString)]
      if marked.late {
        result["late"] = .bool(true)
        result["note"] = .string("The recording had already stopped, so this marker was added at the end of the video. Mark before stopping.")
      }
      return .object(result)

    case "repro.list":
      let workspace = try params["workspace"]?.stringValue.map { try workspaceFile(.object(["workspace": .string($0)])).id }
      let limit = min(max(params["limit"]?.intValue ?? 20, 1), 200)
      var sessions = recorder.sessions
      if let current = recorder.activeSessionID.flatMap(recorder.current) { sessions.insert(current, at: 0) }
      let filtered = sessions.filter { workspace == nil || $0.workspaceIDs.contains(workspace!) || $0.sources.contains { $0.workspace == workspace! } }
      return .array(filtered.prefix(limit).map { .object(reproPayload($0, lines: [], compact: true)) })

    case "repro.get":
      let session = await settled(try recorder.resolve(params["repro"]?.stringValue))
      var result = reproPayload(session, lines: await recorder.lines(for: session.id))
      result["workspaces"] = try JSONValue(encoding: session.workspaces)
      result["sources"] = .array(session.sources.map { source in
        .object(["id": .string(source.id), "name": .string(source.name), "workspace": .string(source.workspace), "kind": .string(source.kind.rawValue),
          "lines": .number(Double(source.lineCount)), "errors": .number(Double(source.errorCount)), "warnings": .number(Double(source.warningCount))])
      })
      return .object(result)

    case "repro.logs":
      let session = await settled(try recorder.resolve(params["repro"]?.stringValue))
      let lines = await recorder.lines(for: session.id)
      var query = ReproLogQuery()
      if let around = try time(params["around"], session: session, lines: lines) {
        query = .around(around, window: min(max(params["window"]?.doubleValue ?? 5, 0.1), 600))
      }
      if let from = try time(params["from"], session: session, lines: lines) { query.from = from }
      if let to = try time(params["to"], session: session, lines: lines) { query.to = to }
      if let sources = params["source"]?.stringsValue ?? params["sources"]?.stringsValue { query.sources = Set(sources) }
      if let level = params["level"]?.stringValue?.lowercased(), !level.isEmpty {
        guard let value = ReproLogLevel(rawValue: level == "warn" ? "warning" : level) else {
          throw StackControlError.invalid("level must be debug, info, warning, or error")
        }
        query.minimumLevel = value
      }
      query.text = params["grep"]?.stringValue
      query.includeOffscreen = params["offscreen"]?.boolValue ?? true
      query.limit = min(max(params["lines"]?.intValue ?? 300, 1), 5000)
      let matched = query.filter(lines, session: session)
      return .object([
        "repro": .string(session.id.uuidString), "duration": .number(session.duration),
        "total": .number(Double(lines.count)), "returned": .number(Double(matched.count)),
        "lines": .array(matched.map { lineValue($0, session: session) }),
      ])

    case "repro.frame":
      let session = await settled(try recorder.resolve(params["repro"]?.stringValue))
      guard let video = session.videoURL, FileManager.default.fileExists(atPath: video.path) else {
        throw StackControlError.notFound(session.status.isActive ? "The video is available after the repro stops."
          : session.videoPath == nil ? (session.detail ?? "This repro has no video.") : "This repro's video was moved or deleted.")
      }
      let lines = await recorder.lines(for: session.id)
      var moments: [Double] = []
      if let values = params["times"]?.arrayValue ?? params["at"]?.arrayValue {
        moments = try values.map { value in
          guard let t = try time(value, session: session, lines: lines) else { throw StackControlError.invalid("Unrecognized time \(value.prettyString())") }
          return t
        }
      } else {
        let marker = params["marker"]?.stringValue.map { JSONValue.string("marker:" + $0) }
        // Default to the first error; a clean repro shows its final frame.
        let fallback = JSONValue.string(lines.contains { $0.level == .error && !$0.isOffscreen } ? "first_error" : "end")
        if let t = try time(params["at"] ?? marker ?? fallback, session: session, lines: lines) { moments = [t] }
      }
      guard !moments.isEmpty else { throw StackControlError.invalid("Pass at (seconds, mm:ss, first_error, last_error, or marker:<label>)") }
      guard moments.count <= 6 else { throw StackControlError.invalid("Request at most 6 frames at once") }
      let size = min(max(params["max_size"]?.intValue ?? (moments.count > 1 ? 960 : 1280), 320), 2048)
      let frames: [ReproFrames.Frame]
      do { frames = try await ReproFrames.extract(video: video, at: moments, maxDimension: size, into: recorder.store.framesFolder(session.id)) }
      catch { throw StackControlError(code: "failed", message: "Could not read a frame: \(error.localizedDescription)") }
      let span = min(max(params["window"]?.doubleValue ?? 3, 0), 60)
      // Control messages are limited to 4 MB; later frames fall back to their file path.
      var budget = 3_000_000
      return .object([
        "repro": .string(session.id.uuidString),
        "frames": .array(frames.map { frame in
          // When output is dense, keep the lines nearest the frame rather than the earliest.
          let nearby = ReproLogQuery(from: max(0, frame.t - span), to: frame.t + min(span, 1), limit: 40, anchor: frame.t).filter(lines)
          var object: [String: JSONValue] = [
            "t": .number(frame.t), "time": .string(ReproFormat.timestamp(frame.t)), "path": .string(frame.url.path),
            "width": .number(Double(frame.width)), "height": .number(Double(frame.height)), "mimeType": .string("image/jpeg"),
            "markers": .array(session.markers.filter { abs($0.t - frame.t) <= max(span, 1) }.map { markerValue($0) }),
            "logs": .array(nearby.map { lineValue($0, session: session) }),
          ]
          let encoded = frame.data.base64EncodedString()
          if encoded.utf8.count <= budget {
            budget -= encoded.utf8.count
            object["imageBase64"] = .string(encoded)
          } else {
            object["note"] = .string("Image omitted to stay within the message size limit. Read it from path, or request fewer or smaller frames.")
          }
          return .object(object)
        }),
      ])

    case "repro.export":
      let session = await settled(try recorder.resolve(params["repro"]?.stringValue))
      guard !session.status.isActive else { throw StackControlError(code: "busy", message: "Stop the repro before exporting it") }
      let destination = params["destination"]?.stringValue.map { URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath, isDirectory: true) }
      let url = try await ReproExport.export(session, to: destination, zip: params["zip"]?.boolValue ?? false,
        includeVideo: params["video"]?.boolValue ?? true)
      return .object(["repro": .string(session.id.uuidString), "path": .string(url.path),
        "readme": .string(url.pathExtension == "zip" ? "" : url.appendingPathComponent("README.md").path)])

    case "repro.delete":
      guard let query = params["repro"]?.stringValue, !["latest", "last", "active", "current"].contains(query.lowercased()) else {
        throw StackControlError.invalid("Pass the exact repro id to delete")
      }
      let session = try recorder.resolve(query)
      guard session.id.uuidString.caseInsensitiveCompare(query.trimmingCharacters(in: .whitespaces)) == .orderedSame else {
        throw StackControlError.invalid("Pass the full repro id to delete (\(session.id.uuidString))")
      }
      do { try recorder.delete(session.id) } catch { throw StackControlError(code: "busy", message: error.localizedDescription) }
      return .object(["deleted": .string(session.id.uuidString)])

    case "repro.wait":
      let session = try recorder.resolve(params["repro"]?.stringValue ?? "latest")
      let timeout = min(max(params["timeout"]?.doubleValue ?? 600, 1), 3600)
      let deadline = Date().addingTimeInterval(timeout)
      // Also waits while the stopped repro's log file is written, before it joins the library.
      while recorder.isRecordingOrSaving(session.id), Date() < deadline { try? await Task.sleep(nanoseconds: 250_000_000) }
      guard !recorder.isRecordingOrSaving(session.id) else {
        let saving = recorder.activeSessionID != session.id
        throw StackControlError(code: "wait_timeout", message: saving ? "The repro is still being saved. Wait again."
          : "The repro is still recording. Stop it with stop_repro_recording or wait again.")
      }
      guard let saved = recorder.current(session.id) else { throw StackControlError.notFound("The repro was discarded before it was saved") }
      return .object(reproPayload(saved, lines: await recorder.lines(for: saved.id)))

    case "repro.dump":
      let session = await settled(try recorder.resolve(params["repro"]?.stringValue))
      guard !session.status.isActive else { throw StackControlError(code: "busy", message: "The log file is written when the recording stops") }
      guard let url = await recorder.logFileURL(for: session) else { throw StackControlError.notFound("This recording has no saved output") }
      let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
      return .object(["repro": .string(session.id.uuidString), "path": .string(url.path), "bytes": .number(Double(size)),
        "lines": .number(Double(session.lineCount)), "library": .string(recorder.store.logURL(session.id).path)])

    case "repro.scope":
      if let mode = params["mode"]?.stringValue?.lowercased() {
        switch mode {
        case "running", "all", "auto": recorder.setScope(.running)
        case "off", "none": recorder.setScope(.off)
        case "selected", "only":
          guard let names = params["workspaces"]?.stringsValue, !names.isEmpty else { throw StackControlError.invalid("Pass workspaces with mode selected") }
          recorder.setScope(.only(Set(try names.map { try workspaceFile(.object(["workspace": .string($0)])).id })))
        default: throw StackControlError.invalid("mode must be running, selected, or off")
        }
      }
      let names = Dictionary(uniqueKeysWithValues: supervisor.files.map { ($0.id, $0.name) })
      return .object(["mode": .string(recorder.scope.isOff ? "off" : recorder.scope.mode),
        "workspaces": .array(recorder.scope.workspaces.map(JSONValue.string)),
        "summary": .string(recorder.scope.summary(names: names)),
        "logNextToVideo": .bool(recorder.logsNextToVideo)])

    case "repro.open":
      let session = try recorder.resolve(params["repro"]?.stringValue)
      guard let video = session.videoURL, FileManager.default.fileExists(atPath: video.path) else {
        throw StackControlError.notFound("This repro has no video to open yet")
      }
      VideoEditorManager.shared.openEditor(for: video)
      NSApp.activate(ignoringOtherApps: true)
      return .object(["opened": .string(session.id.uuidString)])

    default:
      throw StackControlError(code: "unknown_method", message: "Unknown repro method \(method)")
    }
  }

  // MARK: Values

  /// A repro that stopped moments ago is still placing its lines on the video; read it once saved.
  private func settled(_ session: ReproSession) async -> ReproSession {
    let recorder = ReproRecorder.shared
    guard recorder.activeSessionID != session.id, recorder.isRecordingOrSaving(session.id) else { return session }
    return await recorder.waitUntilSaved(session.id) ?? session
  }

  /// Errors from adding lines or marks, with the next step for the common one.
  private static func reproWriteError(_ error: Error) -> StackControlError {
    let message = error.localizedDescription
    if message == "No repro is recording" {
      return .notFound("No repro is recording, and none stopped in the last \(Int(ReproRecorder.lateWindow / 60)) minutes. Start one with start_repro_recording, or pass repro=<id> to add to a saved one.")
    }
    return .invalid(message)
  }

  /// Seconds, "mm:ss.sss", "first_error", "last_error", "end", or "marker:<label or id>".
  private func time(_ value: JSONValue?, session: ReproSession, lines: [ReproLogLine]) throws -> Double? {
    guard let value else { return nil }
    if case .number(let number) = value { return max(0, number) }
    guard let text = value.stringValue?.trimmingCharacters(in: .whitespaces), !text.isEmpty else { return nil }
    switch text.lowercased() {
    case "first_error", "first-error", "error":
      guard let line = session.firstErrorLine.flatMap({ id in lines.first { $0.id == id } }) ?? lines.first(where: { $0.level == .error && !$0.isOffscreen }) else {
        throw StackControlError.notFound("This repro has no error output")
      }
      return line.t
    case "last_error", "last-error":
      guard let line = lines.last(where: { $0.level == .error && !$0.isOffscreen }) else { throw StackControlError.notFound("This repro has no error output") }
      return line.t
    case "end": return session.duration
    case "start": return 0
    default: break
    }
    if text.lowercased().hasPrefix("marker:") {
      let key = String(text.dropFirst(7)).trimmingCharacters(in: .whitespaces).lowercased()
      guard let marker = session.markers.first(where: { $0.id.uuidString.lowercased().hasPrefix(key) && key.count >= 4 })
        ?? session.markers.first(where: { $0.label.lowercased() == key })
        ?? session.markers.first(where: { $0.label.lowercased().contains(key) })
        ?? (key == "fail" || key == "failure" ? session.markers.first(where: \.isFailure) : nil) else {
        throw StackControlError.notFound("No marker matches \"\(key)\"")
      }
      return marker.t
    }
    guard let seconds = ReproFormat.parseTime(text) else { throw StackControlError.invalid("Unrecognized time \"\(text)\"") }
    return seconds
  }

  private func markerValue(_ marker: ReproMarker) -> JSONValue {
    var object: [String: JSONValue] = ["id": .string(marker.id.uuidString), "t": .number(marker.t),
      "time": .string(ReproFormat.timestamp(marker.t)), "kind": .string(marker.kind.rawValue), "label": .string(marker.label)]
    if let detail = marker.detail { object["detail"] = .string(detail) }
    if let outcome = marker.outcome { object["outcome"] = .string(outcome.rawValue) }
    if let by = marker.by { object["by"] = .string(by) }
    return .object(object)
  }

  private func lineValue(_ line: ReproLogLine, session: ReproSession) -> JSONValue {
    var object: [String: JSONValue] = ["t": .number((line.t * 1000).rounded() / 1000), "time": .string(ReproFormat.timestamp(line.t)),
      "source": .string(session.label(for: line.source)), "level": .string(line.level.rawValue), "text": .string(line.text)]
    if line.isOffscreen { object["offscreen"] = .bool(true) }
    return .object(object)
  }

  func reproPayload(_ session: ReproSession, lines: [ReproLogLine], compact: Bool = false) -> [String: JSONValue] {
    let formatter = ISO8601DateFormatter()
    var object: [String: JSONValue] = [
      "repro": .string(session.id.uuidString), "title": .string(session.title), "status": .string(session.status.rawValue),
      "origin": .string(session.origin.rawValue), "by": .string(session.actor.label),
      "recordedAt": .string(formatter.string(from: session.createdAt)),
      "duration": .number((session.duration * 100).rounded() / 100), "lines": .number(Double(session.lineCount)),
      "errors": .number(Double(session.errorCount)), "warnings": .number(Double(session.warningCount)),
      "workspaces": .array(session.workspaceIDs.map(JSONValue.string)),
      "folder": .string(ReproRecorder.shared.store.folder(session.id).path),
    ]
    if let capture = session.capture { object["capture"] = .string(capture) }
    if let video = session.videoPath { object["video"] = .string(video) }
    if let log = session.logFile { object["logFile"] = .string(log) }
    if !session.workspaceNames.isEmpty { object["workspaceNames"] = .array(session.workspaceNames.map(JSONValue.string)) }
    if let detail = session.detail { object["detail"] = .string(detail) }
    if session.truncated { object["truncated"] = .bool(true) }
    guard !compact || !session.status.isActive else { return object }
    let summary = ReproSummary(session: session, lines: lines)
    object["verdict"] = .string(summary.verdict.rawValue)
    object["headline"] = .string(summary.headline)
    if compact { return object }
    object["summary"] = (try? JSONValue(encoding: summary)) ?? .null
    object["markers"] = .array(session.markers.map(markerValue))
    object["runs"] = (try? JSONValue(encoding: session.runs)) ?? .null
    object["sourceNames"] = .array(session.sources.map { .string($0.name) })
    return object
  }
}
