import AppKit
import Combine
import Foundation

nonisolated enum NativeLinkedWorkTarget: Hashable, Sendable {
  case pullRequest(String)
  case recording(UUID)
}

nonisolated struct IntegrationLinkedWorkPublication: Codable, Equatable, Sendable {
  struct Repository: Codable, Equatable, Sendable { let repositoryID: String; let head: String? }
  struct PullRequest: Codable, Equatable, Sendable { let url: String; let host: String; let repository: String; let number: Int }
  let installationID: String
  let executionHostID: String
  let environmentID: String
  let workspaceID: String
  let generation: Int
  let sessionID: String
  let featureID: String
  let checkoutID: String
  let threadID: String
  let title: String
  let provider: String
  let role: String
  let execution: String
  let connection: String
  let sourceSequence: Int64
  let repositories: [Repository]
  let pullRequests: [PullRequest]
  var recordingIDs: [String]

  static func boundedID(_ value: String) -> Bool {
    !value.isEmpty && value.utf8.count <= 160 && value == value.trimmingCharacters(in: .whitespacesAndNewlines)
      && !value.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) }
  }
  func validated() throws {
    guard [installationID, executionHostID, environmentID, workspaceID, sessionID, featureID, checkoutID, threadID, provider].allSatisfy(Self.boundedID),
      generation > 0, sourceSequence >= 0, !title.isEmpty, title.utf8.count <= 800,
      ["writer", "reviewer", "observer"].contains(role),
      ["queued", "starting", "working", "waiting_input", "waiting_approval", "idle", "finished_turn", "interrupted", "failed", "unknown"].contains(execution),
      ["connected", "reconnecting", "unavailable", "stale"].contains(connection),
      !repositories.isEmpty, repositories.count <= 64, Set(repositories.map(\.repositoryID)).count == repositories.count,
      repositories.allSatisfy({ Self.boundedID($0.repositoryID) && ($0.head == nil || $0.head!.range(of: "^[a-f0-9]{40,64}$", options: .regularExpression) != nil) }),
      pullRequests.count <= 50, Set(pullRequests.map(\.url)).count == pullRequests.count,
      recordingIDs.count <= 50, Set(recordingIDs).count == recordingIDs.count, recordingIDs.allSatisfy({ UUID(uuidString: $0) != nil }) else {
      throw StackControlError.invalid("Pass bounded session identities and observed state")
    }
    for pr in pullRequests {
      guard let url = URLComponents(string: pr.url), url.scheme == "https", url.host?.lowercased() == pr.host.lowercased(),
        url.user == nil, url.password == nil, url.port == nil, url.query == nil, url.fragment == nil,
        pr.number > 0, Self.boundedID(pr.host), pr.repository.utf8.count <= 320,
        url.path == "/\(pr.repository)/pull/\(pr.number)" || url.path == "/\(pr.repository)/-/merge_requests/\(pr.number)" else {
        throw StackControlError.invalid("A canonical hosting link is required")
      }
    }
  }
  func sameIdentity(as other: Self) -> Bool {
    installationID == other.installationID && executionHostID == other.executionHostID && environmentID == other.environmentID
      && workspaceID == other.workspaceID && generation == other.generation && sessionID == other.sessionID
      && featureID == other.featureID && checkoutID == other.checkoutID && threadID == other.threadID && role == other.role
  }
  func isAssociated(with target: NativeLinkedWorkTarget) -> Bool {
    switch target {
    case .pullRequest(let url): return pullRequests.contains { $0.url == url }
    case .recording(let id): return recordingIDs.contains { UUID(uuidString: $0) == id }
    }
  }
  func deckhandURL(development: Bool) -> URL? {
    var url = URLComponents()
    url.scheme = development ? "deckhand-dev" : "deckhand"; url.host = "app"; url.path = "/linked-work"
    url.queryItems = [URLQueryItem(name: "installation", value: installationID), URLQueryItem(name: "workspace", value: workspaceID),
      URLQueryItem(name: "generation", value: String(generation)), URLQueryItem(name: "session", value: sessionID),
      URLQueryItem(name: "thread", value: threadID), URLQueryItem(name: "environment", value: environmentID)]
    return url.url
  }
}
nonisolated struct IntegrationLinkedWorkRecord: Codable, Identifiable, Sendable {
  var id: String { publication.sessionID }
  let publication: IntegrationLinkedWorkPublication
  let actorKey: String
  let observedAt: Date
  let runtimeEpoch: String
}

@MainActor final class IntegrationLinkedWorkStore: ObservableObject {
  @Published private(set) var records: [IntegrationLinkedWorkRecord] = []
  @Published private(set) var error: String?
  private let directory: URL
  private var file: URL { directory.appendingPathComponent("linked-work.json") }
  init(directory: URL) {
    self.directory = directory
    guard FileManager.default.fileExists(atPath: file.path) else { return }
    do {
      let data = try Data(contentsOf: file)
      guard data.count <= 8 * 1024 * 1024 else { throw StackControlError.invalid("Linked-work store exceeds its bound") }
      let saved = try StackControlCoding.decoder().decode([IntegrationLinkedWorkRecord].self, from: data)
      guard saved.count <= 5000, Set(saved.map(\.id)).count == saved.count else { throw StackControlError.invalid("Invalid linked-work history") }
      for record in saved { try record.publication.validated() }
      records = saved
    } catch { self.error = "Saved linked work could not be loaded. Restore the store before publishing new projections." }
  }
  @discardableResult func publish(_ input: IntegrationLinkedWorkPublication, actorKey: String, epoch: String) throws -> IntegrationLinkedWorkRecord {
    guard error == nil else { throw StackControlError(code: "linked_work_store_unavailable", message: error!) }
    try input.validated()
    if let old = records.first(where: { $0.id == input.sessionID }) {
      guard old.actorKey == actorKey else { throw StackControlError(code: "wrong_actor", message: "This session projection belongs to another authenticated actor") }
      guard old.publication.sameIdentity(as: input) else { throw StackControlError(code: "identity_changed", message: "A saved session cannot be rebound to another context") }
      guard input.sourceSequence >= old.publication.sourceSequence else { throw StackControlError(code: "stale_projection", message: "This session projection is older than the saved observation") }
    }
    var publication = input
    if let old = records.first(where: { $0.id == input.sessionID }) {
      publication.recordingIDs = Array(Set(old.publication.recordingIDs + input.recordingIDs)).sorted()
      try publication.validated()
    }
    let record = IntegrationLinkedWorkRecord(publication: publication, actorKey: actorKey, observedAt: Date(), runtimeEpoch: epoch)
    let next = ([record] + records.filter { $0.id != record.id }).sorted { $0.observedAt > $1.observedAt }
    guard next.count <= 5000, next.filter({ $0.publication.workspaceID == input.workspaceID && $0.publication.generation == input.generation }).count <= 256 else {
      throw StackControlError(code: "linked_work_limit", message: "The linked-work history limit has been reached")
    }
    try persist(next)
    return record
  }
  /// A ready host-owned recording links only to the exact immutable session context.
  @discardableResult func attachRecording(recordingID: String, installationID: String, workspaceID: String, generation: Int, sessionID: String, featureID: String, checkoutID: String) throws -> Bool {
    guard error == nil, let index = records.firstIndex(where: { $0.id == sessionID }), let uuid = UUID(uuidString: recordingID),
      let recording = ReproStore.shared.loadSession(uuid), recording.workspaces.contains(where: { $0.id == workspaceID }) else { return false }
    let old = records[index]
    guard old.publication.installationID == installationID, old.publication.workspaceID == workspaceID, old.publication.generation == generation,
      old.publication.featureID == featureID, old.publication.checkoutID == checkoutID else { return false }
    if old.publication.recordingIDs.contains(recordingID) { return true }
    guard old.publication.recordingIDs.count < 50 else { return false }
    var publication = old.publication; publication.recordingIDs.append(recordingID); try publication.validated()
    var next = records
    // Attaching evidence must not make remembered runtime state look freshly observed.
    next[index] = .init(publication: publication, actorKey: old.actorKey, observedAt: old.observedAt, runtimeEpoch: old.runtimeEpoch)
    try persist(next)
    return true
  }
  private func persist(_ next: [IntegrationLinkedWorkRecord]) throws {
    let data = try StackControlCoding.encoder(pretty: true).encode(next)
    guard data.count <= 8 * 1024 * 1024 else { throw StackControlError.invalid("Linked-work store exceeds its bound") }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    try data.write(to: file, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    records = next
  }
}

extension StackControlService {
  func handleIntegrationLinkedWork(_ method: String, params: JSONValue, actor: StackActor) async throws -> JSONValue {
    let allowed: Set<String> = method == "integration.linked-work.publish" ? ["installationID", "publication"] : ["installationID", "executionHostID", "workspaceID", "generation"]
    guard ["integration.linked-work.publish", "integration.linked-work.list"].contains(method),
      let object = params.objectValue, Set(object.keys) == allowed else { throw StackControlError.invalid("Pass an exact linked-work context") }
    let journal = try integrationStore()
    if method == "integration.linked-work.publish" {
      guard actor.name.lowercased() == "deckhand", actor.session != nil else { throw StackControlError(code: "wrong_actor", message: "An authenticated Deckhand projection is required") }
      let publication = try StackControlCoding.decoder().decode(IntegrationLinkedWorkPublication.self, from: StackControlCoding.encoder().encode(params["publication"]!))
      try publication.validated()
      guard params["installationID"]?.stringValue == publication.installationID, publication.installationID == journal.installationID, publication.executionHostID.lowercased() == journal.executionHostID.lowercased() else { throw StackControlError(code: "installation_changed", message: "Reconnect to this execution host and installation") }
      integrationProjectionRevision += 1
      try await journal.reconcile(snapshot().workspaces, sourceRevision: integrationProjectionRevision)
      let current = try await journal.snapshot(workspaceID: publication.workspaceID, offset: 0, limit: 1)
      guard let resource = current.resources.first, resource.available, resource.generation == publication.generation else { throw StackControlError(code: "stale_generation", message: "This workspace or lane is unavailable") }
      for id in publication.recordingIDs {
        guard let uuid = UUID(uuidString: id), let session = ReproStore.shared.loadSession(uuid), session.workspaces.contains(where: { $0.id == publication.workspaceID }) else { throw StackControlError.invalid("The linked recording does not belong to this workspace") }
      }
      return try JSONValue(encoding: linkedWork.publish(publication, actorKey: actor.key, epoch: journal.runtimeEpoch))
    }
    guard params["installationID"]?.stringValue == journal.installationID, params["executionHostID"]?.stringValue?.lowercased() == journal.executionHostID.lowercased(),
      let workspace = params["workspaceID"]?.stringValue, IntegrationLinkedWorkPublication.boundedID(workspace), let generation = params["generation"]?.intValue, generation > 0 else { throw StackControlError.invalid("Select this installation and execution host") }
    return try JSONValue(encoding: linkedWork.records.filter { $0.publication.workspaceID == workspace && $0.publication.generation == generation }.prefix(256).map { $0 })
  }
}

nonisolated struct IntegrationLinkedWorkNavigation: Equatable {
  let installationID: String
  let workspaceID: String
  let generation: Int
  init?(url: URL) {
    guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false), parts.scheme == "cinderdeck", parts.host == "linked-work", parts.path.isEmpty,
      parts.user == nil, parts.password == nil, parts.port == nil, parts.fragment == nil,
      let items = parts.queryItems, items.count == 3, Set(items.map(\.name)) == ["installation", "workspace", "generation"],
      let installation = items.first(where: { $0.name == "installation" })?.value,
      let workspace = items.first(where: { $0.name == "workspace" })?.value,
      let raw = items.first(where: { $0.name == "generation" })?.value, raw.range(of: "^[1-9][0-9]{0,8}$", options: .regularExpression) != nil,
      let generation = Int(raw), IntegrationLinkedWorkPublication.boundedID(installation), IntegrationLinkedWorkPublication.boundedID(workspace) else { return nil }
    self.installationID = installation; self.workspaceID = workspace; self.generation = generation
  }
}
