import AVFoundation
import CryptoKit
import Foundation

/// Durable source receipt. All paths are derived from the host-owned UUID;
/// callers can never supply a path, replace a video, or retarget an operation.
nonisolated struct IntegrationPreviewImport: Codable, Sendable {
  let operationKey: String
  let actorKey: String
  let installationID: String
  let workspaceID: String
  let generation: Int
  let title: String
  let sessionID: String
  var attemptOperationKey: String?
  var buildReceiptID: String?
  var buildProof: WorkspaceBuildCaptureProof?
  let tabID: String
  let targetURL: String
  let featureID: String
  let checkoutID: String
  let clientMonotonicMs: Double
  let capturedWorkspaceIDs: [String]
  let recordingID: UUID
  let token: String
  var hostStartedAt: Date
  var state = "prepared"
  var receivedBytes = 0
  var totalBytes: Int?
  var mimeType: String?
  var firstFrameMs: Double?
  var stopMs: Double?
  var detail: String?
  var sha256: String?
  var duration: Double?
  var normalizedSHA256: String?
  var normalizedSize: Int?

  var value: JSONValue {
    var result: [String: JSONValue] = [
    "operationKey": .string(operationKey), "recordingID": .string(recordingID.uuidString), "token": .string(token),
    "state": .string(state), "receivedBytes": .number(Double(receivedBytes)),
    "hostStartedAt": .string(ISO8601DateFormatter().string(from: hostStartedAt)),
    "clockQuality": .string(firstFrameMs == nil ? "unknown" : "estimated"),
    "detail": detail.map(JSONValue.string) ?? .null, "sha256": sha256.map(JSONValue.string) ?? .null,
    "duration": duration.map(JSONValue.number) ?? .null,
    ]
    result["sourceVideoSHA256"] = sha256.map(JSONValue.string) ?? .null
    result["sourceVideoSizeBytes"] = .number(Double(receivedBytes))
    result["videoSHA256"] = normalizedSHA256.map(JSONValue.string) ?? .null
    result["videoSizeBytes"] = normalizedSize.map { .number(Double($0)) } ?? .null
    result["buildProof"] = buildProof?.value ?? .null
    return .object(result)
  }
}

extension StackControlService {
  private var previewImportDirectory: URL { integrationDirectory.appendingPathComponent("RecordingImports", isDirectory: true) }
  private func previewImportURL(actor: StackActor, key: String) -> URL {
    let hash = SHA256.hash(data: Data((actor.key + "\n" + key).utf8)).map { String(format: "%02x", $0) }.joined()
    return previewImportDirectory.appendingPathComponent(hash + ".json")
  }
  private func previewSourceURL(_ receipt: IntegrationPreviewImport) -> URL {
    previewImportDirectory.appendingPathComponent(receipt.recordingID.uuidString + (receipt.mimeType == "video/webm" ? ".webm" : ".mp4"))
  }
  private func savePreviewImport(_ receipt: IntegrationPreviewImport, actor: StackActor) throws {
    try FileManager.default.createDirectory(at: previewImportDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let url = previewImportURL(actor: actor, key: receipt.operationKey)
    try JSONEncoder().encode(receipt).write(to: url, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
  }
  private func publishPreviewManifest(_ receipt: IntegrationPreviewImport, session: ReproSession) throws {
    let url = ReproRecorder.shared.store.folder(receipt.recordingID).appendingPathComponent("deckhand-evidence-v1.json")
    if FileManager.default.fileExists(atPath: url.path) { return }
    let repositories: [JSONValue] = session.workspaces.flatMap { workspace in workspace.repos.map { repo in
      var value: [String: JSONValue] = ["workspaceID": .string(workspace.id), "repositoryID": .string(repo.id),
        "head": repo.head.map(JSONValue.string) ?? .null, "changedFiles": .number(Double(repo.changedFiles.count))]
      if let keys = repo.canonicalRepositoryKeys { value["canonicalRepositoryKeys"] = .array(keys.map(JSONValue.string)) }
      if let id = repo.repositoryPhysicalId { value["repositoryPhysicalId"] = .string(id) }
      if let hash = repo.diffHash { value["diffHash"] = .string(hash) }
      if let fingerprint = repo.sourceFingerprint { value["sourceFingerprint"] = fingerprint.value }
      if let fingerprint = repo.endSourceFingerprint { value["endSourceFingerprint"] = fingerprint.value }
      if let head = repo.endHead { value["endHead"] = .string(head) }
      if let complete = repo.snapshotComplete { value["snapshotComplete"] = .bool(complete) }
      if let truncated = repo.diffTruncated { value["diffTruncated"] = .bool(truncated) }
      if let date = repo.capturedAt { value["capturedAt"] = .string(ISO8601DateFormatter().string(from: date)) }
      return .object(value)
    } }
    let value: JSONValue = .object([
      "schemaVersion": .number(1), "recordingID": .string(receipt.recordingID.uuidString), "origin": .string("deckhand-preview"),
      "installationID": .string(receipt.installationID), "workspaceID": .string(receipt.workspaceID), "generation": .number(Double(receipt.generation)),
      "featureID": .string(receipt.featureID), "checkoutID": .string(receipt.checkoutID), "sessionID": .string(receipt.sessionID),
      "capturedWorkspaceIDs": .array(receipt.capturedWorkspaceIDs.map(JSONValue.string)), "tabID": .string(receipt.tabID), "targetURL": .string(receipt.targetURL),
      "hostStartedAt": .string(ISO8601DateFormatter().string(from: receipt.hostStartedAt)), "clientStartMonotonicMs": .number(receipt.clientMonotonicMs),
      "clientFirstFrameEstimateMs": receipt.firstFrameMs.map(JSONValue.number) ?? .null, "clientStopMonotonicMs": receipt.stopMs.map(JSONValue.number) ?? .null,
      "clockQuality": .string(receipt.firstFrameMs == nil ? "unknown" : "estimated"), "servedBuildIdentity": session.buildProof?.value ?? .null,
      "sourceResourceID": .string(receipt.recordingID.uuidString), "sourceMimeType": receipt.mimeType.map(JSONValue.string) ?? .null,
      "sourceBytes": .number(Double(receipt.receivedBytes)), "sourceSHA256": receipt.sha256.map(JSONValue.string) ?? .null,
      "normalizedSHA256": receipt.normalizedSHA256.map(JSONValue.string) ?? .null, "duration": .number(session.duration),
      "normalizedSize": receipt.normalizedSize.map { .number(Double($0)) } ?? .null,
      "attemptOperationKey": receipt.attemptOperationKey.map(JSONValue.string) ?? .null,
      "droppedLines": .number(Double(session.droppedLines ?? 0)), "repositories": .array(repositories),
    ])
    try JSONEncoder().encode(value).write(to: url, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
  }
  func handleIntegrationRecordingImport(_ method: String, params: JSONValue, actor: StackActor) async throws -> JSONValue {
    let common: Set<String> = ["installationID", "workspaceID", "generation", "operationKey"]
    let allowed: Set<String>
    switch method {
    case "integration.recording.import.begin": allowed = common.union(["title", "sessionID", "tabID", "targetURL", "clientMonotonicMs", "capturedWorkspaceIDs", "featureID", "checkoutID", "buildReceiptID", "attemptOperationKey"])
    case "integration.recording.import.get": allowed = common
    case "integration.recording.import.event": allowed = common.union(["token", "event", "clientMonotonicMs"])
    case "integration.recording.import.chunk": allowed = common.union(["token", "offset", "totalBytes", "mimeType", "data"])
    case "integration.recording.import.finish": allowed = common.union(["token"])
    default: throw StackControlError.invalid("Unsupported preview import operation")
    }
    guard let object = params.objectValue, Set(object.keys).isSubset(of: allowed),
      let installationID = params["installationID"]?.stringValue, let workspaceID = params["workspaceID"]?.stringValue,
      let generation = params["generation"]?.intValue, generation > 0,
      let key = params["operationKey"]?.stringValue, !key.isEmpty, key.utf8.count <= 160 else { throw StackControlError.invalid("Pass a bounded preview import context") }
    let journal = try integrationStore()
    guard journal.installationID == installationID else { throw StackControlError(code: "installation_changed", message: "Reconnect the selected installation") }
    let snapshot = try await journal.snapshot(workspaceID: workspaceID, offset: 0, limit: 1)
    guard let resource = snapshot.resources.first, resource.available, resource.generation == generation else { throw StackControlError(code: "stale_binding", message: "The preview workspace is unavailable or changed") }
    let url = previewImportURL(actor: actor, key: key)
    let existing = (try? Data(contentsOf: url)).flatMap { try? JSONDecoder().decode(IntegrationPreviewImport.self, from: $0) }
    let recorder = ReproRecorder.shared
    let gateKey = actor.key + "\n" + key
    if method != "integration.recording.import.get" {
      guard IntegrationPreviewImportGate.active.insert(gateKey).inserted else {
        throw StackControlError(code: "operation_in_progress", message: "Inspect the original preview receipt before retrying")
      }
    }
    defer { if method != "integration.recording.import.get" { IntegrationPreviewImportGate.active.remove(gateKey) } }
    if method == "integration.recording.import.begin" {
      guard let title = params["title"]?.stringValue, !title.isEmpty, title.utf8.count <= 200,
        let sessionID = params["sessionID"]?.stringValue, sessionID.utf8.count <= 160,
        let tabID = params["tabID"]?.stringValue, tabID.utf8.count <= 160,
        let targetURL = params["targetURL"]?.stringValue, targetURL.utf8.count <= 2048,
        let featureID = params["featureID"]?.stringValue, featureID.utf8.count <= 160,
        let checkoutID = params["checkoutID"]?.stringValue, checkoutID.utf8.count <= 160,
        let mono = params["clientMonotonicMs"]?.doubleValue, mono.isFinite, mono >= 0,
        let scopes = params["capturedWorkspaceIDs"]?.stringsValue, scopes.count <= 16, Set(scopes).count == scopes.count else { throw StackControlError.invalid("Pass preview identity, title and explicit log scope") }
      let buildID = params["buildReceiptID"]?.stringValue
      let attemptKey = params["attemptOperationKey"]?.stringValue
      guard buildID == nil || (!buildID!.isEmpty && buildID!.utf8.count <= 160),
        attemptKey == nil || (!attemptKey!.isEmpty && attemptKey!.utf8.count <= 160) else {
        throw StackControlError.invalid("Build and attempt identity exceed their bounds")
      }
      if let old = existing {
        guard old.installationID == installationID, old.workspaceID == workspaceID, old.generation == generation,
          old.title == title, old.sessionID == sessionID, old.tabID == tabID, old.targetURL == targetURL,
          old.featureID == featureID, old.checkoutID == checkoutID, old.clientMonotonicMs == mono,
          old.capturedWorkspaceIDs == scopes, old.buildReceiptID == buildID, old.attemptOperationKey == attemptKey else { throw StackControlError(code: "operation_conflict", message: "Preview request key has different parameters") }
        return old.value
      }
      guard recorder.activeSessionID == nil, !ReproRecordingController.shared.isBusy, !RecordingCoordinator.shared.isActive else { throw StackControlError(code: "recording_busy", message: "Finish the existing native recording first") }
      let stored = (try? FileManager.default.contentsOfDirectory(at: previewImportDirectory, includingPropertiesForKeys: [.fileSizeKey])) ?? []
      let storedBytes = stored.reduce(Int64(0)) { $0 + Int64((try? $1.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) }
      guard storedBytes < 1_073_741_824, stored.filter({ $0.pathExtension == "json" }).count < 1000 else { throw StackControlError(code: "storage_limit", message: "The preview import storage limit was reached; review retained sources before capturing more") }
      for scope in scopes { _ = try workspaceFile(.object(["workspace": .string(scope)])) }
      var receipt = IntegrationPreviewImport(operationKey: key, actorKey: actor.key, installationID: installationID, workspaceID: workspaceID,
        generation: generation, title: title, sessionID: sessionID, tabID: tabID, targetURL: targetURL, featureID: featureID,
        checkoutID: checkoutID, clientMonotonicMs: mono, capturedWorkspaceIDs: scopes, recordingID: UUID(), token: UUID().uuidString + UUID().uuidString,
        hostStartedAt: Date())
      receipt.buildReceiptID = buildID; receipt.attemptOperationKey = attemptKey
      try savePreviewImport(receipt, actor: actor)
      // Keep the original session requirement and actor/context authorization. A build
      // adds stricter native ownership/lease proof; it never attests the browser target.
      do {
        if let buildID {
          let authority = WorkspaceRunAuthority(installationID: installationID, workspaceID: workspaceID, generation: generation)
          let build = try supervisor.buildArtifacts.get(buildID, actor: actor, authority: authority)
          guard scopes.contains(workspaceID), let definition = supervisor.definition(workspaceID),
            let artifact = build.artifact, let launch = build.launch else {
            throw StackControlError.invalid("Preview requires its exact prepared build and captured log scope")
          }
          let observation = await declaredBuildObservation(build, definition: definition, phase: "start")
          guard observation.state == "matched" else {
            throw StackControlError(code: "build_unknown", message: observation.detail ?? "Declared build start is unknown")
          }
          receipt.buildProof = .init(receiptID: buildID, artifactSHA256: artifact.sha256, launchNonceHash: launch.nonceHash, start: observation)
          try supervisor.buildArtifacts.update(buildID) { if $0.observations.count < 64 { $0.observations.append(observation) } }
        }
        guard recorder.activeSessionID == nil, !ReproRecordingController.shared.isBusy, !RecordingCoordinator.shared.isActive else {
          throw StackControlError(code: "recording_busy", message: "Another capture began while checking the build evidence")
        }
      } catch {
        receipt.state = "failed"; receipt.detail = error.localizedDescription
        try savePreviewImport(receipt, actor: actor)
        return receipt.value
      }
      receipt.hostStartedAt = Date()
      try savePreviewImport(receipt, actor: actor)
      let request = ReproRequest(id: receipt.recordingID, title: title, origin: .workspace, actor: actor, workspaces: Set(scopes), capture: "Deckhand preview", note: "Preview target identity is associated only; generic callers cannot attest what the video depicts.", buildProof: receipt.buildProof)
      recorder.beginBrowser(request, at: receipt.hostStartedAt)
      guard recorder.activeSessionID == receipt.recordingID else { throw StackControlError(code: "unknown_outcome", message: "Inspect the import receipt before starting another capture") }
      receipt.state = "capturing"
      try savePreviewImport(receipt, actor: actor)
      var recordingLink = IntegrationRecordingLink(operationKey: key, actorKey: actor.key, installationID: installationID, workspaceID: workspaceID,
        generation: generation, capturedWorkspaceIDs: scopes, title: title, windowID: 0, recordingID: receipt.recordingID)
      recordingLink.buildReceiptID = buildID
      try saveRecordingLink(recordingLink, actor: actor)
      Task { [weak self] in
        try? await Task.sleep(nanoseconds: 300_000_000_000)
        guard let self, ReproRecorder.shared.activeSessionID == receipt.recordingID,
          let data = try? Data(contentsOf: url), var current = try? JSONDecoder().decode(IntegrationPreviewImport.self, from: data),
          ["capturing", "uploading"].contains(current.state) else { return }
        ReproRecorder.shared.captureFailed("Preview capture exceeded its five-minute limit")
        ReproRecorder.shared.browserEvent(.stopping(Date()), id: current.recordingID)
        ReproRecorder.shared.browserEvent(.noVideo, id: current.recordingID)
        current.state = "interrupted"; current.detail = "Preview capture exceeded its five-minute limit. Original source and receipt are preserved."
        try? self.savePreviewImport(current, actor: actor)
      }
      return receipt.value
    }
    guard var receipt = existing, receipt.actorKey == actor.key, receipt.installationID == installationID,
      receipt.workspaceID == workspaceID, receipt.generation == generation else { throw StackControlError.notFound("This preview import is unavailable") }
    if method == "integration.recording.import.get" {
      if receipt.state == "validating", recorder.activeSessionID != receipt.recordingID {
        if receipt.normalizedSHA256 != nil, let saved = recorder.current(receipt.recordingID), saved.status == .ready, saved.videoURL != nil {
          try publishPreviewManifest(receipt, session: saved)
          _ = try? linkedWork.attachRecording(recordingID:receipt.recordingID.uuidString, installationID:receipt.installationID, workspaceID:receipt.workspaceID, generation:receipt.generation, sessionID:receipt.sessionID, featureID:receipt.featureID, checkoutID:receipt.checkoutID)
          receipt.state = "ready"; receipt.duration = saved.duration
          receipt.detail = "Imported MP4. Preview clock alignment is estimated; served-build revision is unknown."
        } else { receipt.state = "interrupted"; receipt.detail = "Video validation was interrupted. Its original source is preserved." }
        try savePreviewImport(receipt, actor: actor)
      }
      if ["prepared", "capturing", "uploading"].contains(receipt.state), recorder.activeSessionID != receipt.recordingID {
        receipt.state = "interrupted"; receipt.detail = "Capture was interrupted. The original source and receipt are preserved."
        try savePreviewImport(receipt, actor: actor)
      }
      return receipt.value
    }
    guard params["token"]?.stringValue == receipt.token else { throw StackControlError(code: "not_owner", message: "The import token does not match this actor") }
    if method == "integration.recording.import.event" {
      guard let event = params["event"]?.stringValue, let mono = params["clientMonotonicMs"]?.doubleValue,
        mono.isFinite, mono >= receipt.clientMonotonicMs, mono - receipt.clientMonotonicMs <= 3_600_000 else { throw StackControlError.invalid("Invalid preview clock") }
      let date = receipt.hostStartedAt.addingTimeInterval((mono - receipt.clientMonotonicMs) / 1000)
      switch event {
      case "first_frame":
        guard receipt.state == "capturing" else { return receipt.value }
        if let previous = receipt.firstFrameMs, previous != mono { throw StackControlError.invalid("The first-frame clock is immutable") }
        receipt.firstFrameMs = mono; recorder.browserEvent(.firstFrame(date), id: receipt.recordingID)
      case "stop":
        if receipt.state == "uploading" { return receipt.value }
        guard receipt.state == "capturing" else { return receipt.value }
        guard mono >= (receipt.firstFrameMs ?? receipt.clientMonotonicMs) else { throw StackControlError.invalid("Stop precedes the first frame") }
        if let proof = receipt.buildProof, proof.end == nil {
          var observation = WorkspaceBuildObservation(receiptID: proof.receiptID, workspaceID: workspaceID,
            serviceID: proof.start.serviceID, phase: "end")
          do {
            let authority = WorkspaceRunAuthority(installationID: installationID, workspaceID: workspaceID, generation: generation)
            let build = try supervisor.buildArtifacts.get(proof.receiptID, actor: actor, authority: authority)
            guard let definition = supervisor.definition(workspaceID) else {
              throw StackControlError.invalid("Build definition is unavailable at capture stop")
            }
            observation = await declaredBuildObservation(build, definition: definition, phase: "end")
            try supervisor.buildArtifacts.update(build.id) { if $0.observations.count < 64 { $0.observations.append(observation) } }
          } catch {
            // Stopping remains available after lease/source/process loss; proof is unknown.
            observation.detail = error.localizedDescription
          }
          receipt.buildProof?.end = observation
          try recorder.setImportedBuildEnd(observation, id: receipt.recordingID)
        }
        receipt.stopMs = mono; receipt.state = "uploading"; recorder.browserEvent(.stopping(date), id: receipt.recordingID)
      case "cancel":
        guard ["prepared", "capturing", "uploading"].contains(receipt.state) else { return receipt.value }
        recorder.captureFailed("Preview capture cancelled before import")
        recorder.browserEvent(.stopping(date), id: receipt.recordingID); recorder.browserEvent(.noVideo, id: receipt.recordingID)
        receipt.state = "failed"; receipt.detail = "Capture cancelled; no playable video was imported."
      default: throw StackControlError.invalid("Unknown preview event")
      }
      try savePreviewImport(receipt, actor: actor); return receipt.value
    }
    if method == "integration.recording.import.chunk" {
      guard receipt.state == "uploading", let offset = params["offset"]?.intValue, offset >= 0,
        let total = params["totalBytes"]?.intValue, total > 0, total <= 268_435_456,
        let mime = params["mimeType"]?.stringValue, ["video/mp4", "video/webm"].contains(mime),
        let base64 = params["data"]?.stringValue, base64.utf8.count <= 349_528,
        let bytes = Data(base64Encoded: base64), bytes.count > 0, bytes.count <= 262_144, bytes.base64EncodedString() == base64,
        offset + bytes.count <= total else { throw StackControlError.invalid("Upload at most 256 KiB of a bounded video") }
      guard receipt.totalBytes == nil || receipt.totalBytes == total, receipt.mimeType == nil || receipt.mimeType == mime else { throw StackControlError.invalid("Source size and format are immutable") }
      receipt.totalBytes = total; receipt.mimeType = mime
      let source = previewSourceURL(receipt)
      if !FileManager.default.fileExists(atPath: source.path) { guard offset == 0 else { throw StackControlError.invalid("Upload has a gap") }; FileManager.default.createFile(atPath: source.path, contents: nil, attributes: [.posixPermissions: 0o600]) }
      let handle = try FileHandle(forUpdating: source); defer { try? handle.close() }
      if offset < receipt.receivedBytes {
        guard offset + bytes.count <= receipt.receivedBytes else { throw StackControlError.invalid("Overlapping chunk") }
        try handle.seek(toOffset: UInt64(offset))
        guard try handle.read(upToCount: bytes.count) == bytes else { throw StackControlError(code: "operation_conflict", message: "The uploaded source bytes changed") }
        return receipt.value
      }
      guard offset == receipt.receivedBytes else { throw StackControlError.invalid("Upload has a gap") }
      try handle.seek(toOffset: UInt64(offset)); try handle.write(contentsOf: bytes); try handle.synchronize()
      receipt.receivedBytes += bytes.count; try savePreviewImport(receipt, actor: actor); return receipt.value
    }
    if receipt.state == "ready" || receipt.state == "failed" || receipt.state == "interrupted" { return receipt.value }
    guard receipt.state == "uploading", receipt.receivedBytes == receipt.totalBytes, receipt.receivedBytes > 0 else { throw StackControlError.invalid("Complete the source upload before validation") }
    receipt.state = "validating"; try savePreviewImport(receipt, actor: actor)
    let source = previewSourceURL(receipt)
    do {
      let root = previewImportDirectory
      let sourceIdentity = try await Task.detached(priority: .utility) {
        try IntegrationPreviewMediaFiles.identity(source, root: root)
      }.value
      guard sourceIdentity.size == receipt.receivedBytes else {
        throw StackControlError.invalid("Uploaded source byte count changed")
      }
      receipt.sha256 = sourceIdentity.sha256
      let asset = AVURLAsset(url: source)
      let playable = try await asset.load(.isPlayable)
      let tracks = try await asset.loadTracks(withMediaType: .video)
      let duration = try await asset.load(.duration).seconds
      guard playable, !tracks.isEmpty, duration.isFinite, duration > 0, duration <= 3600 else { throw StackControlError.invalid("This source cannot be decoded as a playable video; its original bytes are preserved") }
      let normalized = previewImportDirectory.appendingPathComponent(receipt.recordingID.uuidString + "-normalized.mp4")
      guard let exporter = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetHighestQuality), exporter.supportedFileTypes.contains(.mp4) else { throw StackControlError.invalid("The capture codec cannot be normalized to MP4; its original bytes are preserved") }
      exporter.outputURL = normalized; exporter.outputFileType = .mp4; exporter.shouldOptimizeForNetworkUse = true
      await exporter.export()
      guard exporter.status == .completed else { throw StackControlError.invalid("MP4 normalization failed; its original bytes are preserved") }
      let normalizedIdentity = try await Task.detached(priority: .utility) {
        try IntegrationPreviewMediaFiles.identity(normalized, root: root)
      }.value
      let sourceAfter = try await Task.detached(priority: .utility) {
        try IntegrationPreviewMediaFiles.identity(source, root: root)
      }.value
      guard sourceAfter == sourceIdentity else {
        throw StackControlError.invalid("Source bytes changed during normalization")
      }
      receipt.normalizedSHA256 = normalizedIdentity.sha256
      receipt.normalizedSize = normalizedIdentity.size
      let result = AVURLAsset(url: normalized)
      guard try await result.load(.isPlayable), !(try await result.loadTracks(withMediaType: .video)).isEmpty else { throw StackControlError.invalid("Normalized video is not playable") }
      receipt.duration = duration
      try savePreviewImport(receipt, actor: actor)
      try recorder.setImportedMedia(.init(sourceSHA256: sourceIdentity.sha256, sourceSize: sourceIdentity.size,
        videoSHA256: normalizedIdentity.sha256, videoSize: normalizedIdentity.size), id: receipt.recordingID)
      recorder.browserEvent(.finished(normalized), id: receipt.recordingID)
      guard let saved = await recorder.waitUntilSaved(receipt.recordingID), saved.status == .ready, saved.videoURL != nil else { throw StackControlError.invalid("The video was validated but the recording library did not finish saving it") }
      try publishPreviewManifest(receipt, session: saved)
          _ = try? linkedWork.attachRecording(recordingID:receipt.recordingID.uuidString, installationID:receipt.installationID, workspaceID:receipt.workspaceID, generation:receipt.generation, sessionID:receipt.sessionID, featureID:receipt.featureID, checkoutID:receipt.checkoutID)
      receipt.state = "ready"; receipt.detail = "Imported MP4. Preview clock alignment is estimated; served-build revision is unknown."
    } catch {
      receipt.state = "failed"; receipt.detail = (error as? LocalizedError)?.errorDescription ?? "Video import failed. The original source is preserved."
      if recorder.activeSessionID == receipt.recordingID { recorder.captureFailed(receipt.detail!); recorder.browserEvent(.noVideo, id: receipt.recordingID); _ = await recorder.waitUntilSaved(receipt.recordingID) }
    }
    try savePreviewImport(receipt, actor: actor); return receipt.value
  }
}
