import Foundation
import XCTest
@testable import Cinderdeck

@MainActor final class IntegrationLinkedWorkTests: XCTestCase {
  private func publication(sequence: Int64 = 1, workspace: String = "lane") -> IntegrationLinkedWorkPublication {
    .init(installationID: "installation", executionHostID: "host", environmentID: "environment", workspaceID: workspace,
      generation: 7, sessionID: "session", featureID: "feature", checkoutID: "checkout", threadID: "thread", title: "A connected feature",
      provider: "codex", role: "writer", execution: "working", connection: "connected", sourceSequence: sequence,
      repositories: [.init(repositoryID: "frontend", head: String(repeating: "a", count: 40))],
      pullRequests: [.init(url: "https://github.com/example/repo/pull/1", host: "github.com", repository: "example/repo", number: 1)], recordingIDs: [])
  }
  func testPublicationAcceptsCurrentAndLegacyRuntimeActorsWithoutRelaxingIdentityChecks() async throws {
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let suite = "cinderdeck-linked-work-\(UUID())"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }
    defaults.set(root.path, forKey: PreferencesKeys.stacksDirectory)
    let supervisor = StackSupervisor(store: nil, defaults: defaults, logRoot: root.appendingPathComponent("logs"))
    let control = StackControlService(supervisor: supervisor, integrationDirectory: root.appendingPathComponent("integration"))
    let params = JSONValue.object(["installationID": .string("installation"), "publication": try JSONValue(encoding: publication())])
    for (name, session, expected) in [
      ("Cinderdeck", "runtime", "installation_changed"),
      ("Deckhand", "runtime", "installation_changed"),
      ("Other app", "runtime", "wrong_actor"),
      ("Cinderdeck", nil, "wrong_actor"),
    ] as [(String, String?, String)] {
      do {
        _ = try await control.handleIntegrationLinkedWork("integration.linked-work.publish", params: params, actor: StackActor(kind: .agent, name: name, session: session))
        XCTFail("Expected \(expected)")
      } catch {
        XCTAssertEqual((error as? StackControlError)?.code, expected)
      }
    }
  }
  func testInspectorAssociationsRequireExactHostedPRAndRecordingIdentity() throws {
    var work = publication()
    let recording = UUID()
    work.recordingIDs = [recording.uuidString.lowercased()]
    XCTAssertTrue(work.isAssociated(with: .pullRequest("https://github.com/example/repo/pull/1")))
    for url in ["https://other.example/example/repo/pull/1", "https://github.com/fork/repo/pull/1", "https://github.com/example/repo/pull/2"] {
      XCTAssertFalse(work.isAssociated(with: .pullRequest(url)))
    }
    XCTAssertTrue(work.isAssociated(with: .recording(recording)))
    XCTAssertFalse(work.isAssociated(with: .recording(UUID())))
  }
  func testPersistsOwnedImmutableIdentityAndRefusesOlderProjection() async throws {
    let directory = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = IntegrationLinkedWorkStore(directory: directory)
    _ = try store.publish(publication(), actorKey: "deckhand#owner", epoch: "old-runtime")
    let relaunched = IntegrationLinkedWorkStore(directory: directory)
    XCTAssertEqual(relaunched.records.count, 1)
    XCTAssertEqual(relaunched.records.first?.runtimeEpoch, "old-runtime", "A restart preserves history, not live observation")
    XCTAssertThrowsError(try relaunched.publish(publication(), actorKey: "deckhand#other", epoch: "new-runtime"))
    XCTAssertThrowsError(try relaunched.publish(publication(workspace: "other-lane"), actorKey: "deckhand#owner", epoch: "new-runtime"))
    XCTAssertThrowsError(try relaunched.publish(publication(sequence: 0), actorKey: "deckhand#owner", epoch: "new-runtime"))
    _ = try relaunched.publish(publication(sequence: 2), actorKey: "deckhand#owner", epoch: "new-runtime")
    XCTAssertEqual(relaunched.records.first?.publication.sourceSequence, 2)
    let permissions = try FileManager.default.attributesOfItem(atPath: directory.appendingPathComponent("linked-work.json").path)[.posixPermissions] as? NSNumber
    XCTAssertEqual(permissions?.intValue, 0o600)
  }
  func testCorruptHistoryCannotBeOverwrittenAndNavigationRejectsExtraCommands() async throws {
    let directory = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    try Data("invalid".utf8).write(to: directory.appendingPathComponent("linked-work.json"))
    let store = IntegrationLinkedWorkStore(directory: directory)
    XCTAssertNotNil(store.error)
    XCTAssertThrowsError(try store.publish(publication(), actorKey: "owner", epoch: "runtime"))
    let valid = "cinderdeck://linked-work?installation=installation&workspace=lane&generation=7"
    XCTAssertNotNil(IntegrationLinkedWorkNavigation(url: try XCTUnwrap(URL(string: valid))))
    for value in [valid + "&file=/tmp/run", valid + "&workspace=other", valid + "#run", valid.replacingOccurrences(of: "generation=7", with: "generation=0"), valid.replacingOccurrences(of: "//linked-work", with: "//user@linked-work")] {
      XCTAssertNil(IntegrationLinkedWorkNavigation(url: try XCTUnwrap(URL(string: value))))
    }
  }
}
