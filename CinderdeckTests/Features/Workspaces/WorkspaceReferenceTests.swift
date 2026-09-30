import AppKit
import UniformTypeIdentifiers
import XCTest
@testable import Cinderdeck

@MainActor
final class WorkspaceReferenceTests: XCTestCase {
  private func fixture() -> StackDefinitionFile {
    let definitionURL = URL(fileURLWithPath: "/tmp/Workspace Reference/shop.toml")
    let root = URL(fileURLWithPath: "/tmp/Workspace Reference/project")
    var definition = StackDefinition(id: "shop", name: "Shop", file: definitionURL, root: root, shell: "/bin/sh")
    definition.repos = [.init(id: "app", path: root)]
    definition.services = [.init(id: "web", command: "PRIVATE_COMMAND", directory: root,
      port: 3000, environment: ["TOKEN": "PRIVATE_SERVICE_ENV"], ports: ["hmr": 3001])]
    definition.environment = ["API_KEY": "PRIVATE_WORKSPACE_ENV"]
    definition.secrets = ["KEY": "PRIVATE_KEYCHAIN_REF"]
    return .init(id: definition.id, file: definitionURL, definition: definition)
  }

  func testReferenceIncludesCheckoutBranchAndRuntimeAddressesWithoutEnvironment() {
    let file = fixture()
    let text = WorkspaceReference(file: file,
      statuses: [file.definition!.root: .init(branch: "fix/cart", changedFiles: 2)],
      state: .init(services: ["web": .init(phase: .ready)])).text
    XCTAssertTrue(text.contains("Cinderdeck workspace: Shop"))
    XCTAssertTrue(text.contains("Workspace ID: shop"))
    XCTAssertTrue(text.contains("Definition: /tmp/Workspace Reference/shop.toml"))
    XCTAssertTrue(text.contains("Project folder: /tmp/Workspace Reference/project"))
    XCTAssertTrue(text.contains("Branch: fix/cart (uncommitted changes)"))
    XCTAssertTrue(text.contains("web: ready"))
    XCTAssertTrue(text.contains("URL: http://localhost:3000"))
    XCTAssertTrue(text.contains("hmr: http://localhost:3001"))
    XCTAssertFalse(text.contains("PRIVATE_"))
    XCTAssertFalse(text.contains("API_KEY"))
  }

  func testLaneReferenceUsesLaneCheckoutAndPorts() {
    var file = fixture()
    let laneRoot = URL(fileURLWithPath: "/tmp/lanes/fix/repo-0")
    file.definition?.root = laneRoot
    file.definition?.repos[0] = .init(id: "app", path: laneRoot)
    file.definition?.services[0].directory = laneRoot
    file.definition?.services[0].port = 4100
    file.definition?.lane = .init(sourceStackID: "source-shop", name: "fix/cart", owner: .user,
      createdAt: Date(), directory: laneRoot.deletingLastPathComponent(), ports: ["web": 4100], host: "fix.shop.localhost")
    let text = WorkspaceReference(file: file).text
    XCTAssertTrue(text.contains("Source workspace: source-shop"))
    XCTAssertTrue(text.contains("Lane: fix/cart"))
    XCTAssertTrue(text.contains("Project folder: /tmp/lanes/fix/repo-0"))
    XCTAssertTrue(text.contains("URL: http://fix.shop.localhost:4100"))
    XCTAssertFalse(text.contains("Project folder: /tmp/Workspace Reference/project"))
    XCTAssertFalse(text.contains("http://localhost:3000"))
  }

  func testSharedServiceKeepsItsSourceAddressAndPortReadinessIsIncluded() {
    var file = fixture()
    file.definition?.services[0].port = nil
    file.definition?.services[0].readiness = .port(4200)
    file.definition?.links = [.init(id: "db", stack: "source", service: "db", port: 5432, shared: true)]
    let text = WorkspaceReference(file: file).text
    XCTAssertTrue(text.contains("URL: http://localhost:4200"))
    XCTAssertTrue(text.contains("db: linked to source/db (shared)"))
    XCTAssertTrue(text.contains("URL: http://localhost:5432"))
  }

  func testInvalidDefinitionStillHasAnInspectableReference() {
    var file = fixture()
    file.definition = nil
    let text = WorkspaceReference(file: file).text
    XCTAssertTrue(text.contains("Workspace ID: shop"))
    XCTAssertTrue(text.contains(file.file.path))
    XCTAssertTrue(text.contains("Definition unavailable"))
    XCTAssertFalse(text.contains("Services status:"))
  }

  func testDragProviderDeliversTheFullReferenceAsPlainText() async throws {
    let reference = WorkspaceReference(file: fixture())
    let provider = reference.itemProvider()
    XCTAssertTrue(provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier))
    let data: Data = try await withCheckedThrowingContinuation { continuation in
      provider.loadDataRepresentation(forTypeIdentifier: UTType.utf8PlainText.identifier) { data, error in
        if let error { continuation.resume(throwing: error) }
        else if let data { continuation.resume(returning: data) }
        else { continuation.resume(throwing: CocoaError(.fileReadUnknown)) }
      }
    }
    XCTAssertEqual(String(data: data, encoding: .utf8), reference.text)
    XCTAssertEqual(provider.suggestedName, "Shop")
  }
}
