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
    XCTAssertTrue(supervisor.files.isEmpty)
  }
}
