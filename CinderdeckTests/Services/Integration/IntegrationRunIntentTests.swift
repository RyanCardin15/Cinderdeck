import Foundation
import XCTest
@testable import Cinderdeck

final class IntegrationRunIntentTests: XCTestCase {
  func testRunAuthorityComesFromOwnedDurableIntentAndSurvivesRestart() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("deckhand-run-intent-\(UUID())")
    defer { try? FileManager.default.removeItem(at: root) }
    let actor = StackActor(kind: .agent, name: "Deckhand", session: "run-owner")
    let input = IntegrationOperationInput(operationKey: "run", installationID: "original", workspaceID: "lane", generation: 7, revision: "reviewed",
      method: "runs.start", arguments: .object(["workspace": .string("lane"), "kind": .string("task"), "definitionID": .string("verify")]))
    let store = try IntegrationOperations(directory: root)
    let (receipt, _) = try await store.begin(input, actor: actor)
    let restored = try IntegrationOperations(directory: root)
    let intent = try await restored.intent(id: receipt.id, actor: actor)
    XCTAssertEqual(intent.installationID, "original"); XCTAssertEqual(intent.workspaceID, "lane")
    XCTAssertEqual(intent.generation, 7); XCTAssertEqual(intent.revision, "reviewed")
    XCTAssertEqual(intent.arguments, input.arguments)
    do { _ = try await restored.intent(id: receipt.id, actor: .init(kind: .agent, name: "Other", session: "other")); XCTFail("Another actor cannot recover run authority") }
    catch { XCTAssertEqual((error as? StackControlError)?.code, "unauthorized_operation") }
  }
}
