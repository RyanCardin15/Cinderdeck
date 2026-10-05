import Darwin
import CryptoKit
import Foundation

nonisolated struct IntegrationRecordingLink: Codable, Sendable {
  let operationKey: String
  let actorKey: String
  let installationID: String
  let workspaceID: String
  let generation: Int
  let capturedWorkspaceIDs: [String]
  let title: String
  let windowID: Int
  var recordingID: UUID?
  var buildReceiptID: String?
}

/// The primary lane is an association. Captured workspaces and Git snapshots remain
/// immutable in the repro; changing the association never changes what was recorded.
extension StackControlService {
  private var recordingLinksDirectory: URL { integrationDirectory.appendingPathComponent("RecordingLinks", isDirectory: true) }
  private func recordingLinks(recordingID: UUID? = nil) -> [IntegrationRecordingLink] {
    if let recordingID {
      let url = recordingLinksDirectory.appendingPathComponent("ByRecording", isDirectory: true).appendingPathComponent(recordingID.uuidString + ".json")
      if let data = try? Data(contentsOf: url), data.count <= 16_384,
        let link = try? JSONDecoder().decode(IntegrationRecordingLink.self, from: data) { return [link] }
    }
    let urls = (try? FileManager.default.contentsOfDirectory(at: recordingLinksDirectory, includingPropertiesForKeys: nil)) ?? []
    return urls.prefix(10_000).compactMap { url in
      guard let data = try? Data(contentsOf: url), data.count <= 16_384 else { return nil }
      return try? JSONDecoder().decode(IntegrationRecordingLink.self, from: data)
    }
  }
  private func recordingLinkURL(_ actor: StackActor, key: String) -> URL {
    let digest = SHA256.hash(data: Data((actor.key + "\n" + key).utf8)).map { String(format: "%02x", $0) }.joined()
    return recordingLinksDirectory.appendingPathComponent(digest + ".json")
  }
  func saveRecordingLink(_ link: IntegrationRecordingLink, actor: StackActor) throws {
    try FileManager.default.createDirectory(at: recordingLinksDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let url = recordingLinkURL(actor, key: link.operationKey)
    try JSONEncoder().encode(link).write(to: url, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    if let recordingID = link.recordingID {
      let index = recordingLinksDirectory.appendingPathComponent("ByRecording", isDirectory: true)
      try FileManager.default.createDirectory(at: index, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
      let destination = index.appendingPathComponent(recordingID.uuidString + ".json")
      try JSONEncoder().encode(link).write(to: destination, options: .atomic)
      try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
    }
  }
  private func recordingRepositoryValue(_ repo: ReproRepoState, workspaceID: String) -> JSONValue {
    var value: [String: JSONValue] = ["workspaceID": .string(workspaceID), "repositoryID": .string(repo.id), "branch": .string(repo.branch),
      "head": repo.head.map(JSONValue.string) ?? .null, "changedFiles": .number(Double(repo.changedFiles.count))]
    if let keys = repo.canonicalRepositoryKeys { value["canonicalRepositoryKeys"] = .array(keys.map(JSONValue.string)) }
    if let id = repo.repositoryPhysicalId { value["repositoryPhysicalId"] = .string(id) }
    if let complete = repo.snapshotComplete { value["snapshotComplete"] = .bool(complete) }
    if let date = repo.capturedAt { value["capturedAt"] = .string(ISO8601DateFormatter().string(from: date)) }
    if let hash = repo.diffHash { value["diffHash"] = .string(hash) }
    if let fingerprint = repo.sourceFingerprint { value["sourceFingerprint"] = fingerprint.value }
    if let fingerprint = repo.endSourceFingerprint { value["endSourceFingerprint"] = fingerprint.value }
    if let head = repo.endHead { value["endHead"] = .string(head) }
    if let truncated = repo.diffTruncated { value["diffTruncated"] = .bool(truncated) }
    return .object(value)
  }
  private func recordingValue(_ session: ReproSession, links: [IntegrationRecordingLink], actor: StackActor) -> JSONValue {
    let link = links.first { $0.recordingID == session.id }
    let videoExists = session.videoURL.map { FileManager.default.fileExists(atPath: $0.path) } ?? false
    var value: [String: JSONValue] = [
      "id": .string(session.id.uuidString), "title": .string(session.title), "state": .string(session.status.rawValue),
      "createdAt": .string(ISO8601DateFormatter().string(from: session.createdAt)), "duration": .number(session.duration),
      "actor": .string(session.actor.label), "capture": session.capture.map(JSONValue.string) ?? .null,
      "primaryWorkspaceID": link.map { .string($0.workspaceID) } ?? .null,
      "capturedWorkspaceIDs": .array(session.workspaceIDs.map(JSONValue.string)),
      "capturedWorkspaceNames": .array(session.workspaceNames.map(JSONValue.string)),
      "lineCount": .number(Double(session.lineCount)), "errorCount": .number(Double(session.errorCount)),
      "warningCount": .number(Double(session.warningCount)), "playable": .bool(!session.status.isActive && videoExists),
      "detail": session.detail.map(JSONValue.string) ?? .null,
      "paused": .bool(session.clock?.isPaused ?? false),
      "controlAllowed": .bool(ReproRecordingController.shared.activeID == session.id && ReproRecordingController.shared.activeActor?.key == actor.key),
      "markers": .array(session.markers.prefix(500).map { marker in .object([
        "id": .string(marker.id.uuidString), "t": .number(marker.t), "label": .string(marker.label),
        "outcome": marker.outcome.map { .string($0.rawValue) } ?? .null,
      ]) }),
      "repositories": .array(session.workspaces.flatMap { workspace in workspace.repos.map { repo in recordingRepositoryValue(repo, workspaceID: workspace.id) } }.prefix(128).map { $0 }),
    ]
    if let proof = session.buildProof { value["buildProof"] = proof.value }
    if let media = session.importedMedia {
      value["sourceVideoSHA256"] = .string(media.sourceSHA256)
      value["sourceVideoSizeBytes"] = .number(Double(media.sourceSize))
      value["videoSHA256"] = .string(media.videoSHA256)
      value["videoSizeBytes"] = .number(Double(media.videoSize))
    }
    let manifestURL = ReproRecorder.shared.store.folder(session.id).appendingPathComponent("deckhand-evidence-v1.json")
    if let data = try? Data(contentsOf: manifestURL), data.count <= 65_536,
      let manifest = try? JSONDecoder().decode(JSONValue.self, from: data),
      let quality = manifest["clockQuality"]?.stringValue, ["estimated", "unknown"].contains(quality) {
      value["clockQuality"] = .string(quality)
    }
    // Observed errors and explicit checks are separate facts; absence of an error
    // never manufactures a passing scenario or an exact served-build revision.
    value["checkOutcome"] = .string(session.markers.contains { $0.outcome == .fail } ? "failed" : session.markers.contains { $0.outcome == .pass } ? "passed" : "unverified")
    return .object(value)
  }
  func handleIntegrationRecording(_ method: String, params: JSONValue, actor: StackActor) async throws -> JSONValue {
    if method.hasPrefix("integration.recording.import.") { return try await handleIntegrationRecordingImport(method, params: params, actor: actor) }
    if method == "integration.recording.overview" { return try await integrationRecordingOverview(params) }
    let common: Set<String> = ["installationID", "workspaceID", "generation"]
    let allowed: Set<String>
    switch method {
    case "integration.recording.list": allowed = common.union(["limit"])
    case "integration.recording.evidence.prepare": allowed = common.union(["recordingID", "operationKey"])
    case "integration.recording.evidence.get": allowed = common.union(["recordingID", "preparationID"])
    case "integration.recording.evidence.chunk": allowed = common.union(["recordingID", "preparationID", "resourceID", "offset", "length"])
    case "integration.recording.windows": allowed = common
    case "integration.recording.get", "integration.recording.stop", "integration.recording.pause", "integration.recording.resume": allowed = common.union(["recordingID"])
    case "integration.recording.start": allowed = common.union(["operationKey", "title", "windowID", "capturedWorkspaceIDs", "buildReceiptID"])
    case "integration.recording.logs": allowed = common.union(["recordingID", "around", "level", "source"])
    case "integration.recording.thumbnail": allowed = common.union(["recordingID"])
    case "integration.recording.thumbnail.chunk": allowed = common.union(["recordingID", "thumbnailID", "offset", "length"])
    case "integration.recording.chunk": allowed = common.union(["recordingID", "offset", "length"])
    case "integration.recording.mark": allowed = common.union(["recordingID", "label", "outcome"])
    default: throw StackControlError(code: "unknown_method", message: "Unsupported recording operation")
    }
    guard let object = params.objectValue, Set(object.keys).isSubset(of: allowed),
      let installation = params["installationID"]?.stringValue,
      let workspaceID = params["workspaceID"]?.stringValue, workspaceID.utf8.count <= 160,
      let generation = params["generation"]?.intValue, generation > 0 else { throw StackControlError.invalid("Pass a bounded recording context") }
    let journal = try integrationStore()
    guard installation == journal.installationID else { throw StackControlError(code: "installation_changed", message: "Reconnect to the selected Cinderdeck installation") }
    let context = try await journal.snapshot(workspaceID: workspaceID, offset: 0, limit: 1)
    guard let resource = context.resources.first, resource.available, resource.generation == generation else {
      throw StackControlError(code: "stale_binding", message: "The recording's workspace changed or is unavailable")
    }
    let recorder = ReproRecorder.shared
    let controller = ReproRecordingController.shared
    let links = recordingLinks(recordingID: params["recordingID"]?.stringValue.flatMap(UUID.init(uuidString:)))
    func matches(_ session: ReproSession) -> Bool {
      session.workspaceIDs.contains(workspaceID) || links.contains { $0.recordingID == session.id && $0.workspaceID == workspaceID && $0.generation == generation }
    }
    if method == "integration.recording.list" {
      let limit = min(max(params["limit"]?.intValue ?? 100, 1), 100)
      var sessions = recorder.sessions
      if let active = recorder.activeSessionID.flatMap(recorder.current) { sessions.insert(active, at: 0) }
      return .array(sessions.filter(matches).prefix(limit).map { recordingValue($0, links: links, actor: actor) })
    }
    if method == "integration.recording.windows" {
      let raw = try await handleRepro("repro.windows", params: .object([:]), actor: actor)
      return .array((raw["windows"]?.arrayValue ?? []).prefix(100).map { window in .object([
        "id": window["id"] ?? .null, "app": window["app"] ?? .string(""), "title": window["title"] ?? .string(""),
      ]) })
    }
    if method == "integration.recording.start" {
      guard let key = params["operationKey"]?.stringValue, !key.isEmpty, key.utf8.count <= 100,
        let title = params["title"]?.stringValue, !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, title.utf8.count <= 200,
        let window = params["windowID"]?.intValue, window > 0, window <= Int(UInt32.max),
        let scopes = params["capturedWorkspaceIDs"]?.stringsValue, scopes.count <= 16, Set(scopes).count == scopes.count else { throw StackControlError.invalid("Choose a window, title and captured workspace scope") }
      for scope in scopes { _ = try workspaceFile(.object(["workspace": .string(scope)])) }
      if let old = links.first(where: { $0.actorKey == actor.key && $0.operationKey == key }) {
        guard old.installationID == installation, old.workspaceID == workspaceID, old.generation == generation,
          old.title == title, old.windowID == window, old.capturedWorkspaceIDs == scopes, old.buildReceiptID == params["buildReceiptID"]?.stringValue else { throw StackControlError(code: "operation_conflict", message: "Recording request key already has different parameters") }
        guard let id = old.recordingID, let session = recorder.current(id) else { throw StackControlError(code: "unknown_outcome", message: "Recording start was interrupted. Inspect the library before starting another capture.") }
        return recordingValue(session, links: links, actor: actor)
      }
      guard recorder.activeSessionID == nil else { throw StackControlError(code: "recording_busy", message: "Finish the current preview capture first") }
      var buildProof: WorkspaceBuildCaptureProof?
      if let buildID = params["buildReceiptID"]?.stringValue {
        let authority = WorkspaceRunAuthority(installationID: installation, workspaceID: workspaceID, generation: generation)
        let receipt = try supervisor.buildArtifacts.get(buildID, actor: actor, authority: authority)
        guard scopes.contains(workspaceID), let definition = supervisor.definition(workspaceID), let artifact = receipt.artifact, let launch = receipt.launch else { throw StackControlError(code: "build_unknown", message: "Capture needs the prepared artifact and actual declared service launch") }
        let observation = await declaredBuildObservation(receipt, definition: definition, phase: "start")
        guard observation.state == "matched" else { throw StackControlError(code: "build_unknown", message: observation.detail ?? "Build stamp could not be verified before capture") }
        try supervisor.buildArtifacts.update(buildID) { if $0.observations.count < 64 { $0.observations.append(observation) } }
        buildProof = .init(receiptID: buildID, artifactSHA256: artifact.sha256, launchNonceHash: launch.nonceHash, start: observation)
      }
      // Persist intent before capture, so a lost response never starts a second video.
      var link = IntegrationRecordingLink(operationKey: key, actorKey: actor.key, installationID: installation, workspaceID: workspaceID,
        generation: generation, capturedWorkspaceIDs: scopes, title: title, windowID: window)
      link.buildReceiptID = params["buildReceiptID"]?.stringValue
      try saveRecordingLink(link, actor: actor)
      var options = ReproRecordingController.Options()
      options.buildProof = buildProof
      options.title = title; options.windowID = UInt32(window); options.workspaces = Set(scopes)
      let session: ReproSession
      do { session = try await controller.start(options, origin: .workspace, actor: actor) }
      catch {
        // start() cleans failed native capture before throwing. Preserve unknown
        // intent only when a capture may still exist.
        if controller.activeID == nil { try? FileManager.default.removeItem(at: recordingLinkURL(actor, key: key)) }
        throw error
      }
      link.recordingID = session.id
      try saveRecordingLink(link, actor: actor)
      return recordingValue(session, links: links + [link], actor: actor)
    }
    guard let raw = params["recordingID"]?.stringValue, let id = UUID(uuidString: raw), let session = recorder.current(id), matches(session) else {
      throw StackControlError.notFound("This recording is not in the selected workspace")
    }
    if method.hasPrefix("integration.recording.thumbnail") { return try await handleIntegrationRecordingThumbnail(method, params: params, session: session) }
    if method.hasPrefix("integration.recording.evidence.") { return try await handleIntegrationRecordingEvidence(method, params: params, session: session, actor: actor) }
    if ["integration.recording.stop", "integration.recording.pause", "integration.recording.resume"].contains(method) {
      if method == "integration.recording.stop", !session.status.isActive { return recordingValue(session, links: links, actor: actor) }
      guard controller.activeID == id, controller.activeActor?.key == actor.key else { throw StackControlError(code: "not_owner", message: "Only the person or agent that started this capture can control it") }
      if method == "integration.recording.stop" { return recordingValue(try await controller.stop(), links: links, actor: actor) }
      let pause = method == "integration.recording.pause"
      if controller.isPaused != pause { await controller.togglePause() }
      return recordingValue(recorder.current(id) ?? session, links: links, actor: actor)
    }
    if method == "integration.recording.get" {
      // Only this selected-recording read hashes bytes. Library, timeline and frame
      // reads never repeat a whole-video hash or turn stored hashes into live proof.
      let video = session.videoURL, expected = session.importedMedia
      let root = integrationDirectory.appendingPathComponent("RecordingImports", isDirectory: true)
      let integrity = await Task.detached(priority: .utility) {
        IntegrationPreviewMediaFiles.integrity(video, root: root, expected: expected)
      }.value
      var value = recordingValue(session, links: links, actor: actor).objectValue ?? [:]
      value["videoIntegrity"] = .string(integrity)
      if integrity == "changed" { value["playable"] = .bool(false) }
      return .object(value)
    }
    if method == "integration.recording.mark" {
      guard let label = params["label"]?.stringValue, !label.isEmpty, label.utf8.count <= 500,
        let outcome = params["outcome"]?.stringValue, ["pass", "fail", "info"].contains(outcome) else { throw StackControlError.invalid("Pass a check label and outcome") }
      _ = try await handleRepro("repro.mark", params: .object(["repro": .string(raw), "label": .string(label), "outcome": .string(outcome)]), actor: actor)
      return recordingValue(recorder.current(id) ?? session, links: links, actor: actor)
    }
    if method == "integration.recording.logs" {
      let lines = await recorder.lines(for: id)
      var query = ReproLogQuery()
      if let around = params["around"]?.doubleValue {
        guard around.isFinite, around >= 0 else { throw StackControlError.invalid("Invalid timeline position") }
        query = .around(around, window: 8)
      }
      if let level = params["level"]?.stringValue, let minimum = ReproLogLevel(rawValue: level) { query.minimumLevel = minimum }
      if let source = params["source"]?.stringValue { query.sources = [source] }
      query.limit = 300
      let matched = query.filter(lines, session: session)
      return .object(["repro": .string(raw), "duration": .number(session.duration), "total": .number(Double(lines.count)),
        "returned": .number(Double(matched.count)), "lines": .array(matched.map { line in .object([
          "id": .number(Double(line.id)), "t": .number(line.t), "time": .string(ReproFormat.timestamp(line.t)),
          "source": .string(session.label(for: line.source)), "level": .string(line.level.rawValue), "text": .string(line.text), "offscreen": .bool(line.isOffscreen),
        ]) })])
    }
    guard !session.status.isActive, let video = session.videoURL,
      let offset = params["offset"]?.intValue, offset >= 0,
      let length = params["length"]?.intValue, length >= 0, length <= 262_144 else { throw StackControlError.invalid("Video is available after capture; request at most 256 KiB") }
    return try await Task.detached(priority: .utility) { try Self.recordingChunk(video, offset: offset, length: length) }.value
  }
  private func integrationRecordingOverview(_ params: JSONValue) async throws -> JSONValue {
    guard let object = params.objectValue, Set(object.keys).isSubset(of: ["installationID", "contexts"]),
      let installation = params["installationID"]?.stringValue, let contexts = params["contexts"]?.arrayValue, contexts.count <= 100 else { throw StackControlError.invalid("Pass at most 100 recording contexts") }
    let journal = try integrationStore()
    guard installation == journal.installationID else { throw StackControlError(code: "installation_changed", message: "Reconnect to the selected Cinderdeck installation") }
    let recorder = ReproRecorder.shared
    var sessions = recorder.sessions
    if let active = recorder.activeSessionID.flatMap(recorder.current) { sessions.insert(active, at: 0) }
    let links = recordingLinks()
    var seen = Set<String>()
    var summaries: [JSONValue] = []
    for context in contexts {
      guard let workspaceID = context["workspaceID"]?.stringValue, workspaceID.utf8.count <= 160,
        let generation = context["generation"]?.intValue, generation > 0, seen.insert(workspaceID).inserted else { throw StackControlError.invalid("Recording contexts must be bounded and unique") }
      let snapshot = try await journal.snapshot(workspaceID: workspaceID, offset: 0, limit: 1)
      guard snapshot.resources.first?.generation == generation else { throw StackControlError(code: "stale_binding", message: "A recording context changed generation") }
      let matching = sessions.filter { session in session.workspaceIDs.contains(workspaceID) || links.contains { $0.recordingID == session.id && $0.workspaceID == workspaceID && $0.generation == generation } }
      func playable(_ session: ReproSession) -> Bool { !session.status.isActive && session.videoURL.map { FileManager.default.fileExists(atPath: $0.path) } == true }
      let active = matching.first { $0.status.isActive }
      let latest = matching.first
      summaries.append(.object(["workspaceID": .string(workspaceID), "generation": .number(Double(generation)), "count": .number(Double(matching.count)),
        "playableCount": .number(Double(matching.filter(playable).count)),
        "active": active.map { .object(["id": .string($0.id.uuidString), "state": .string($0.status.rawValue), "title": .string($0.title)]) } ?? .null,
        "latest": latest.map { .object(["id": .string($0.id.uuidString), "title": .string($0.title), "duration": .number($0.duration), "playable": .bool(playable($0)),
          "checkOutcome": .string($0.markers.contains { $0.outcome == .fail } ? "failed" : $0.markers.contains { $0.outcome == .pass } ? "passed" : "unverified")]) } ?? .null]))
    }
    return .array(summaries)
  }
  nonisolated static func recordingChunk(_ url: URL, offset: Int, length: Int, mimeType: String? = nil) throws -> JSONValue {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    var info = stat()
    guard fstat(handle.fileDescriptor, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_uid == getuid(), info.st_size >= 0,
      info.st_size <= Int64(Int.max), offset <= Int(info.st_size) else { throw StackControlError.notFound("Recording video is missing or changed") }
    let size = Int(info.st_size)
    let version = "\(info.st_dev).\(info.st_ino).\(info.st_size).\(info.st_mtimespec.tv_sec).\(info.st_mtimespec.tv_nsec)"
    try handle.seek(toOffset: UInt64(offset))
    let bytes = try handle.read(upToCount: min(length, size - offset)) ?? Data()
    return .object(["size": .number(Double(size)), "offset": .number(Double(offset)), "data": .string(bytes.base64EncodedString()),
      "version": .string(version), "mimeType": .string(mimeType ?? (url.pathExtension.lowercased() == "mov" ? "video/quicktime" : "video/mp4"))])
  }
}
