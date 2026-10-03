import Foundation
import XCTest
@testable import Cinderdeck

final class IntegrationOperationsTests: XCTestCase {
  private func input(key: String = "operation", branch: String = "feature/payment") -> IntegrationOperationInput {
    .init(operationKey: key, installationID: "fixture", workspaceID: "payment", generation: 1, revision: "revision",
      method: "lane.create", arguments: .object(["workspace": .string("payment"), "branch": .string(branch), "start": .bool(false)]))
  }
  func testIdempotencyConflictOwnershipAndTerminalPersistence() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("deckhand-operations-\(UUID())")
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try IntegrationOperations(directory: root)
    let actor = StackActor(kind: .agent, name: "Deckhand", session: "server")
    let first = try await store.begin(input(), actor: actor)
    XCTAssertTrue(first.1)
    let duplicate = try await store.begin(input(), actor: actor)
    XCTAssertFalse(duplicate.1)
    XCTAssertEqual(first.0.id, duplicate.0.id)
    do { _ = try await store.begin(input(branch: "different"), actor: actor); XCTFail("Expected argument conflict") }
    catch { XCTAssertEqual((error as? StackControlError)?.code, "operation_conflict") }
    do { _ = try await store.get(key: "operation", actor: .init(kind: .agent, name: "Other", session: "different")); XCTFail("Expected ownership refusal") }
    catch { XCTAssertEqual((error as? StackControlError)?.code, "unauthorized_operation") }
    _ = try await store.transition(key: "operation", actor: actor, state: "running")
    _ = try await store.transition(key: "operation", actor: actor, state: "succeeded", result: .object(["workspaceID": .string("created-lane")]))
    let restarted = try IntegrationOperations(directory: root)
    let terminal = try await restarted.get(key: "operation", actor: actor)
    XCTAssertEqual(terminal.state, "succeeded")
    XCTAssertEqual(terminal.result?["workspaceID"], .string("created-lane"))
    do { _ = try await restarted.transition(key: "operation", actor: actor, state: "running"); XCTFail("Must never replay terminal effects") }
    catch { XCTAssertEqual((error as? StackControlError)?.code, "operation_state_changed") }
  }
  func testInterruptedIntentIsUncertainAndSameKeyNeverCreatesAgain() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("deckhand-interrupted-\(UUID())")
    defer { try? FileManager.default.removeItem(at: root) }
    let actor = StackActor(kind: .agent, name: "Deckhand", session: "server")
    let store = try IntegrationOperations(directory: root)
    let original = try await store.begin(input(), actor: actor)
    _ = try await store.transition(key: "operation", actor: actor, state: "running")
    let restarted = try IntegrationOperations(directory: root)
    let recovered = try await restarted.begin(input(), actor: actor)
    XCTAssertFalse(recovered.1)
    XCTAssertEqual(recovered.0.id, original.0.id)
    XCTAssertEqual(recovered.0.state, "unknown_outcome")
    XCTAssertEqual(recovered.0.error?.code, "unknown_outcome")
    let inspected = try await restarted.transition(key: "operation", actor: actor, state: "unknown_outcome", result: .object(["createdWorkspaceID": .string("lane")]), error: recovered.0.error)
    XCTAssertEqual(inspected.state, "unknown_outcome")
    XCTAssertEqual(inspected.result?["createdWorkspaceID"], .string("lane"))
  }
  func testReceiptWaitObservesCommittedTerminalWithoutRepeatingEffectsAndReleasesObservers() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("deckhand-wait-\(UUID())")
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try IntegrationOperations(directory: root)
    let actor = StackActor(kind: .agent, name: "Deckhand", session: "owner")
    let pending = try await store.begin(input(), actor: actor).0
    let first = Task { try await store.wait(key: "operation", actor: actor, waitMs: 25_000) }
    let second = Task { try await store.wait(key: "operation", actor: actor, waitMs: 25_000) }
    while await store.activeWaitCount < 2 { await Task.yield() }
    _ = try await store.transition(key: "operation", actor: actor, state: "running")
    let observers = await store.activeWaitCount
    XCTAssertEqual(observers, 2, "Running state does not release terminal observers")
    let succeeded = try await store.transition(key: "operation", actor: actor, state: "succeeded", result: .object(["workspaceID": .string("lane")]))
    let one = try await first.value; let two = try await second.value
    XCTAssertEqual(one.id, pending.id); XCTAssertEqual(two.id, succeeded.id)
    XCTAssertEqual(one.state, "succeeded"); XCTAssertEqual(two.result?["workspaceID"], .string("lane"))
    let remaining = await store.activeWaitCount; XCTAssertEqual(remaining, 0)
    let immediate = try await store.wait(key: "operation", actor: actor, waitMs: 25_000)
    XCTAssertEqual(immediate.id, succeeded.id)
  }
  func testReceiptWaitTimeoutCancellationLimitsAndOwnershipNeverChangeIntent() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("deckhand-wait-bounds-\(UUID())")
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try IntegrationOperations(directory: root)
    let actor = StackActor(kind: .agent, name: "Deckhand", session: "owner")
    let pending = try await store.begin(input(), actor: actor).0
    let timeout = try await store.wait(key: "operation", actor: actor, waitMs: 1)
    XCTAssertEqual(timeout.id, pending.id); XCTAssertEqual(timeout.state, "pending")
    for waitMs in [-1, 25_001] {
      do { _ = try await store.wait(key: "operation", actor: actor, waitMs: waitMs); XCTFail("Accepted invalid wait") }
      catch { XCTAssertEqual((error as? StackControlError)?.code, "invalid_params") }
    }
    do { _ = try await store.wait(key: "operation", actor: .init(kind: .agent, name: "Other", session: "other"), waitMs: 1); XCTFail("Allowed another actor to wait") }
    catch { XCTAssertEqual((error as? StackControlError)?.code, "unauthorized_operation") }
    let waits = (0..<8).map { _ in Task { try await store.wait(key: "operation", actor: actor, waitMs: 25_000) } }
    while await store.activeWaitCount < 8 { await Task.yield() }
    do { _ = try await store.wait(key: "operation", actor: actor, waitMs: 25_000); XCTFail("Exceeded observer bound") }
    catch { XCTAssertEqual((error as? StackControlError)?.code, "busy") }
    for wait in waits { wait.cancel() }
    for wait in waits { do { _ = try await wait.value; XCTFail("Cancelled wait returned success") } catch { XCTAssertTrue(error is CancellationError) } }
    let remaining = await store.activeWaitCount; XCTAssertEqual(remaining, 0)
    let unchanged = try await store.get(key: "operation", actor: actor)
    XCTAssertEqual(unchanged.id, pending.id); XCTAssertEqual(unchanged.state, "pending")
    let duplicate = try await store.begin(input(), actor: actor); XCTAssertFalse(duplicate.1)
  }
  func testReceiptWaitGlobalBoundAndRestartKeepUnknownOutcomeHonest() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("deckhand-wait-global-\(UUID())")
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try IntegrationOperations(directory: root)
    var waits: [Task<IntegrationOperationReceipt, Error>] = []
    for index in 0..<16 {
      let actor = StackActor(kind: .agent, name: "Deckhand", session: "owner-\(index)")
      let key = "operation-\(index)"
      _ = try await store.begin(input(key: key), actor: actor)
      waits += (0..<8).map { _ in Task { try await store.wait(key: key, actor: actor, waitMs: 25_000) } }
    }
    while await store.activeWaitCount < 128 { await Task.yield() }
    let extra = StackActor(kind: .agent, name: "Deckhand", session: "extra")
    _ = try await store.begin(input(key: "extra"), actor: extra)
    do { _ = try await store.wait(key: "extra", actor: extra, waitMs: 25_000); XCTFail("Exceeded global wait bound") }
    catch { XCTAssertEqual((error as? StackControlError)?.code, "busy") }
    for wait in waits { wait.cancel() }
    for wait in waits { _ = try? await wait.value }
    let remaining = await store.activeWaitCount; XCTAssertEqual(remaining, 0)
    let restarted = try IntegrationOperations(directory: root)
    let recovered = try await restarted.wait(key: "extra", actor: extra, waitMs: 25_000)
    XCTAssertEqual(recovered.state, "unknown_outcome")
    let duplicate = try await restarted.begin(input(key: "extra"), actor: extra)
    XCTAssertFalse(duplicate.1); XCTAssertEqual(duplicate.0.id, recovered.id)
  }
  @MainActor
  func testControllerRejectsUnsupportedUnknownAndMistypedInputsBeforeEffects() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("deckhand-op-control-\(UUID())")
    defer { try? FileManager.default.removeItem(at: root) }
    let defaults = UserDefaults(suiteName: "deckhand-op-control-\(UUID())")!
    defaults.set(root.path, forKey: PreferencesKeys.stacksDirectory)
    let supervisor = StackSupervisor(store: nil, defaults: defaults, logRoot: root.appendingPathComponent("logs"))
    let control = StackControlService(supervisor: supervisor, claimsFile: root.appendingPathComponent("claims.json"), integrationDirectory: root.appendingPathComponent("integration"))
    let actor = StackActor(kind: .agent, name: "Deckhand", session: "server")
    var object = try JSONValue(encoding: input()).objectValue!
    object["installationID"] = .string(try control.integrationStore().installationID)
    for (field, value, expected) in [
      ("method", JSONValue.string("git.reset"), "unsupported_capability"),
      ("arguments", .object(["workspace": .string("wrong"), "branch": .string("feature/test")]), "invalid_params"),
      ("arguments", .object(["workspace": .string("payment"), "branch": .string("feature/test"), "start": .string("false")]), "invalid_params"),
      ("arguments", .object(["workspace": .string("payment"), "branch": .string("feature/test"), "extra": .bool(true)]), "invalid_params"),
      ("generation", .number(1.5), "invalid_params"),
      ("installationID", .string("wrong"), "installation_changed"),
      ("unexpected", .bool(true), "invalid_params"),
    ] {
      var candidate = object; candidate[field] = value
      do { _ = try await control.handle("integration.operation.submit", params: .object(candidate), actor: actor); XCTFail("Expected \(expected)") }
      catch { XCTAssertEqual((error as? StackControlError)?.code, expected) }
    }
    do { _ = try await control.handle("integration.operation.submit", params: .object(object), actor: actor); XCTFail("Expected missing workspace") }
    catch { XCTAssertEqual((error as? StackControlError)?.code, "resource_missing") }
    for value in [JSONValue.string("1"), .number(1.5), .number(-1), .number(25_001), .null, .bool(true)] {
      do {
        _ = try await control.handle("integration.operation.get", params: .object(["installationID": .string(try control.integrationStore().installationID), "operationKey": .string("operation"), "waitMs": value]), actor: actor)
        XCTFail("Accepted mistyped receipt wait")
      } catch { XCTAssertEqual((error as? StackControlError)?.code, "invalid_params") }
    }
    XCTAssertTrue(supervisor.files.isEmpty)
  }
  @MainActor
  func testLifecycleArgumentsRejectMistypedOptionsAndRelativeAdoptionBeforeEffects() async throws {
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let defaults = UserDefaults(suiteName: "deckhand-lifecycle-types-\(UUID())")!
    defaults.set(root.path, forKey: PreferencesKeys.stacksDirectory)
    let supervisor = StackSupervisor(store: nil, defaults: defaults, logRoot: root.appendingPathComponent("logs"))
    let control = StackControlService(supervisor: supervisor, claimsFile: root.appendingPathComponent("claims.json"), integrationDirectory: root.appendingPathComponent("integration"))
    let installation = try control.integrationStore().installationID
    let cases: [(String, [String: JSONValue], String)] = [
      ("lane.create", ["branch": .string("branch"), "managedWriter": .string("true")], "invalid_params"),
      ("lane.create", ["branch": .string("branch"), "managedWriter": .bool(true)], "resource_missing"),
      ("lane.adopt", ["path": .string("relative")], "invalid_params"),
      ("lane.adopt", ["path": .string("/fixture\nother")], "invalid_params"),
      ("lane.adopt", ["path": .string("/fixture"), "setup": .string("false")], "invalid_params"),
      ("lane.adopt", ["path": .string("/fixture"), "name": .string("")], "invalid_params"),
      ("lane.setup", ["force": .string("true")], "invalid_params"),
      ("lane.setup", ["unexpected": .bool(true)], "invalid_params"),
      ("lane.remove", ["discard_ignored": .string("true")], "invalid_params"),
      ("lane.remove", ["force_teardown": .number(1)], "invalid_params"),
      ("lane.release", ["discard_ignored": .bool(true)], "invalid_params"),
      ("lane.release", ["force_teardown": .bool(true)], "invalid_params"),
      ("lane.adopt", ["path": .string("/fixture"), "setup": .bool(false)], "resource_missing"),
      ("lane.setup", ["force": .bool(false)], "resource_missing"),
      ("lane.remove", ["force_teardown": .bool(false)], "resource_missing"),
      ("lane.release", ["delete_logs": .bool(false)], "resource_missing"),
    ]
    for (method, values, expected) in cases {
      var arguments = values; arguments["workspace"] = .string("payment")
      let candidate = IntegrationOperationInput(operationKey: UUID().uuidString, installationID: installation,
        workspaceID: "payment", generation: 1, revision: "revision", method: method, arguments: .object(arguments))
      do { _ = try await control.handle("integration.operation.submit", params: JSONValue(encoding: candidate), actor: .user); XCTFail("Accepted \(method) \(values)") }
      catch { XCTAssertEqual((error as? StackControlError)?.code, expected) }
    }
    XCTAssertTrue(supervisor.files.isEmpty)
  }

}
