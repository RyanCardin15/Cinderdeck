import Foundation
import XCTest
@testable import Cinderdeck

@MainActor
final class WorkspaceBuildAdapterTests: XCTestCase {
  private let digest = String(repeating: "a", count: 64)
  private func input(key: String = "prepare") -> WorkspaceBuildPrepareInput {
    .init(installationID: "installation", workspaceID: "lane", generation: 3, operationKey: key, serviceID: "web",
      expectedDefinitionHash: digest, expectedWorkflowHash: digest,
      expectedRepositories: [.init(repositoryID: "app", checkoutPhysicalID: digest, repositoryPhysicalID: digest, canonicalRepositoryKeys: ["github.com/fixture/app"], head: "head")], requiredTaskIDs: ["verify"])
  }
  private var adapter: WorkspaceBuildAdapterDefinition { .init(buildTaskID: "build", requiredTaskIDs: ["verify"], artifactName: "web.js", stampPath: "/stamp", servedArtifactPath: "/artifact") }
  func testArtifactReadHashesExactBytesAndRefusesTraversalSymlinksHardlinksAndOversize() throws {
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let expected = Data("fresh built artifact".utf8)
    let artifact = root.appendingPathComponent("artifact.js")
    try expected.write(to: artifact)
    let read = try WorkspaceBuildArtifactFiles.read(root: root, name: "artifact.js")
    XCTAssertEqual(read, expected)
    XCTAssertEqual(WorkspaceBuildArtifactFiles.digest(read), WorkspaceBuildArtifactFiles.digest(expected))
    XCTAssertThrowsError(try WorkspaceBuildArtifactFiles.read(root: root, name: "../artifact.js"))
    try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("alias.js"), withDestinationURL: artifact)
    XCTAssertThrowsError(try WorkspaceBuildArtifactFiles.read(root: root, name: "alias.js"))
    let external = root.appendingPathComponent("external", isDirectory: true)
    try FileManager.default.createDirectory(at: external, withIntermediateDirectories: true)
    try expected.write(to: external.appendingPathComponent("artifact.js"))
    try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("linked"), withDestinationURL: external)
    XCTAssertThrowsError(try WorkspaceBuildArtifactFiles.read(root: root, name: "linked/artifact.js"))
    try FileManager.default.linkItem(at: artifact, to: root.appendingPathComponent("hard.js"))
    XCTAssertThrowsError(try WorkspaceBuildArtifactFiles.read(root: root, name: "hard.js"))
    try Data(repeating: 1, count: WorkspaceBuildArtifactFiles.maximumBytes + 1).write(to: root.appendingPathComponent("large.js"))
    XCTAssertThrowsError(try WorkspaceBuildArtifactFiles.read(root: root, name: "large.js"))
  }
  func testBuildIntentAndActionKeysAreDurableScopedAndNeverReplayAfterRestart() async throws {
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let actor = StackActor(kind: .agent, name: "Deckhand", session: "owner")
    let store = WorkspaceBuildStore(directory: root)
    let (receipt, created) = try store.begin(input(), adapter: adapter, actor: actor)
    XCTAssertTrue(created)
    XCTAssertFalse(try store.begin(input(), adapter: adapter, actor: actor).1)
    try store.prepareOutput(receipt.id)
    XCTAssertThrowsError(try store.prepareOutput(receipt.id))
    XCTAssertTrue(try store.action(receipt.id, key: "launch", kind: "launch"))
    XCTAssertFalse(try store.action(receipt.id, key: "launch", kind: "launch"))
    XCTAssertThrowsError(try store.action(receipt.id, key: "launch", kind: "checks"))
    let restarted = WorkspaceBuildStore(directory: root)
    let recovered = try restarted.get(operationKey: "prepare", actor: actor, authority: input().authority)
    XCTAssertEqual(recovered.id, receipt.id); XCTAssertEqual(recovered.state, "unknown")
    XCTAssertEqual(recovered.actionStates["launch"], "unknown")
    XCTAssertFalse(try restarted.begin(input(), adapter: adapter, actor: actor).1)
    XCTAssertThrowsError(try restarted.get(receipt.id, actor: .init(kind: .agent, name: "Other", session: "other"), authority: input().authority))
    XCTAssertThrowsError(try restarted.get(receipt.id, actor: actor, authority: .init(installationID: "installation", workspaceID: "lane", generation: 4)))
    let publicBytes = try JSONEncoder().encode(recovered.value)
    let publicText = String(decoding: publicBytes, as: UTF8.self)
    XCTAssertFalse(publicText.contains("actorKey"))
  }
  func testLoopbackPathsAndFreshSourceTupleCannotInventBuildProof() throws {
    for path in ["http://example.invalid/stamp", "//evil/stamp", "/../stamp", "/stamp?url=evil", "/stamp#other"] { XCTAssertFalse(WorkspaceBuildHTTP.validPath(path)) }
    XCTAssertTrue(WorkspaceBuildHTTP.validPath("/__deckhand/build"))
    let fingerprint = ReproSourceFingerprintSnapshot(schemaVersion: 1, hash: digest, state: "complete", trackedCount: 0, untrackedCount: 0, omittedCount: 0, detail: nil)
    let snapshot = WorkspaceRunRepositorySnapshot(repositoryID: "app", canonicalRepositoryKeys: ["github.com/fixture/app"], checkoutPhysicalID: digest, repositoryPhysicalID: digest, head: "head", capturedAt: Date(), fingerprint: fingerprint, complete: true)
    XCTAssertTrue(WorkspaceBuildScope.matches(input(), [snapshot]))
    let dirty = WorkspaceRunRepositorySnapshot(repositoryID: "app", canonicalRepositoryKeys: snapshot.canonicalRepositoryKeys, checkoutPhysicalID: digest, repositoryPhysicalID: digest, head: "head", capturedAt: Date(), fingerprint: .init(schemaVersion: 1, hash: digest, state: "complete", trackedCount: 0, untrackedCount: 1, omittedCount: 0, detail: nil), complete: true)
    XCTAssertFalse(WorkspaceBuildScope.matches(input(), [dirty]))
    XCTAssertFalse(WorkspaceBuildScope.matches(input(), []))
  }
  func testDeclaredScopeIncludesLaunchDependencySourceAndRefusesExternalSharedDependencies() async throws {
    let root = URL(fileURLWithPath: "/tmp/build-scope-fixture")
    var definition = StackDefinition(id: "lane", name: "Fixture", file: root.appendingPathComponent("workspace.toml"), root: root, shell: "/bin/sh")
    definition.repos = [.init(id: "app", path: root.appendingPathComponent("app")), .init(id: "api", path: root.appendingPathComponent("api")), .init(id: "unrelated", path: root.appendingPathComponent("unrelated"))]
    definition.tasks = [.init(id: "build", name: "Build", command: "build", repo: "app", directory: root.appendingPathComponent("app")), .init(id: "verify", name: "Verify", command: "verify", repo: "app", directory: root.appendingPathComponent("app"))]
    definition.services = [.init(id: "web", command: "web", repo: "app", directory: root.appendingPathComponent("app"), dependencies: ["api"], port: 40001, buildAdapter: adapter), .init(id: "api", command: "api", repo: "api", directory: root.appendingPathComponent("api"), port: 40002)]
    XCTAssertEqual(try WorkspaceBuildScope.select(definition, serviceID: "web").1.repositories.map(\.id), ["api", "app"])
    definition.services[1].dependencies = ["shared-external"]
    XCTAssertThrowsError(try WorkspaceBuildScope.select(definition, serviceID: "web"))
  }
  func testRequiredChecksNeedActualMatchedArtifactStampAndProcessAtBothEndpoints() async throws {
    let actor = StackActor(kind: .agent, name: "Deckhand", session: "owner")
    var receipt = WorkspaceBuildReceipt(id: UUID().uuidString, request: input(), adapter: adapter, actorKey: actor.key, actor: actor)
    receipt.artifact = .init(name: "web.js", sha256: digest, size: 10)
    var start = WorkspaceBuildObservation(receiptID: receipt.id, workspaceID: "lane", serviceID: "web", phase: "start")
    start.state = "matched"; start.artifactSHA256 = digest; start.servedArtifactSHA256 = digest; start.sourceUnchanged = true; start.processMatched = true; start.stampMatched = true
    var end = WorkspaceBuildObservation(receiptID: receipt.id, workspaceID: "lane", serviceID: "web", phase: "end")
    end.state = "matched"; end.artifactSHA256 = digest; end.servedArtifactSHA256 = digest; end.sourceUnchanged = true; end.processMatched = true; end.stampMatched = true
    XCTAssertTrue(WorkspaceBuildScope.observationsMatch([start, end], receipt: receipt))
    XCTAssertFalse(WorkspaceBuildScope.observationsMatch(nil, receipt: receipt))
    XCTAssertFalse(WorkspaceBuildScope.observationsMatch([end, end], receipt: receipt))
    end.processMatched = false
    XCTAssertFalse(WorkspaceBuildScope.observationsMatch([start, end], receipt: receipt))
    end.processMatched = true; end.servedArtifactSHA256 = String(repeating: "b", count: 64)
    XCTAssertFalse(WorkspaceBuildScope.observationsMatch([start, end], receipt: receipt))
    end.servedArtifactSHA256 = digest; end.stampMatched = false
    XCTAssertFalse(WorkspaceBuildScope.observationsMatch([start, end], receipt: receipt))
  }

  func testRestartPreservesInterruptedBuildAndExplicitCancellationRetryWithoutReplayingEffects() async throws {
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let actor = StackActor(kind: .agent, name: "Deckhand", session: "owner")
    let receipts = WorkspaceBuildStore(directory: root.appendingPathComponent("builds"))
    let (receipt, _) = try receipts.begin(input(), adapter: adapter, actor: actor)
    try receipts.update(receipt.id) { $0.state = "running"; $0.actionStates["prepare"] = "accepted"; $0.ownedLaunchServices = ["api": .init(pid: 12, pgid: 12, startTime: 1)] }
    let restarted = WorkspaceBuildStore(directory: root.appendingPathComponent("builds"))
    let recovered = try XCTUnwrap(restarted.current(receipt.id))
    XCTAssertEqual(recovered.state, "unknown")
    XCTAssertEqual(recovered.ownedLaunchServices?["api"]?.pid, 12)
    XCTAssertTrue(try restarted.action(receipt.id, key: "cancel-1", kind: "finish:cancel"))
    XCTAssertThrowsError(try restarted.action(receipt.id, key: "cancel-pending", kind: "finish:cancel"))
    try restarted.update(receipt.id) { $0.actionStates["cancel-1"] = "unknown" }
    XCTAssertFalse(try restarted.action(receipt.id, key: "cancel-1", kind: "finish:cancel"))
    XCTAssertTrue(try restarted.action(receipt.id, key: "explicit-cancel-2", kind: "finish:cancel"))
    XCTAssertTrue(restarted.isFinishing(receipt.id))
    XCTAssertFalse(String(decoding: try JSONEncoder().encode(recovered.value), as: UTF8.self).contains("ownedLaunchServices"))
    let (pending, _) = try restarted.begin(input(key: "not-admitted"), adapter: adapter, actor: actor)
    let fresh = WorkspaceBuildStore(directory: root.appendingPathComponent("builds"))
    XCTAssertEqual(fresh.current(pending.id)?.state, "unknown")
  }

  func testReleasedNoEffectFailuresStayWithinDurableReceiptRetention() async throws {
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let actor = StackActor(kind: .agent, name: "Deckhand", session: "owner")
    let store = WorkspaceBuildStore(directory: root)
    for index in 0..<40 {
      let (receipt, _) = try store.begin(input(key: "refused-\(index)"), adapter: adapter, actor: actor)
      try store.update(receipt.id) { $0.state = "failed"; $0.actionStates[$0.request.operationKey] = "failed" }
    }
    let restarted = WorkspaceBuildStore(directory: root)
    XCTAssertEqual(try restarted.get(operationKey: "refused-39", actor: actor, authority: input().authority).state, "failed")
    XCTAssertThrowsError(try restarted.get(operationKey: "refused-0", actor: actor, authority: input().authority))
  }

}
