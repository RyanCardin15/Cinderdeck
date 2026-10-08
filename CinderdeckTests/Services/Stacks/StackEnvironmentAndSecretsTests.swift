import Foundation
import XCTest
import Security
@testable import Cinderdeck

final class StackEnvironmentAndSecretsTests: XCTestCase {
  func testLegacySecretIsCopiedToCinderdeckAndCurrentSecretWins() throws {
    let store = StackSecretsStore()
    let name = "Cinderdeck-Test-\(UUID().uuidString)"
    defer { try? store.delete(name) }
    let legacy: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "Snapzy Stacks", kSecAttrAccount as String: name]
    var add = legacy
    add[kSecValueData as String] = Data("legacy-test-value".utf8)
    XCTAssertEqual(SecItemAdd(add as CFDictionary, nil), errSecSuccess)
    XCTAssertTrue(try store.names().contains(name))
    XCTAssertEqual(try store.read(name), "legacy-test-value")
    SecItemDelete(legacy as CFDictionary)
    XCTAssertEqual(try store.read(name), "legacy-test-value")
    XCTAssertEqual(SecItemAdd(add as CFDictionary, nil), errSecSuccess)
    try store.save("current-test-value", named: name)
    XCTAssertEqual(try store.read(name), "current-test-value")
    try store.delete(name)
    XCTAssertThrowsError(try store.read(name))
  }

  func testServiceEnvironmentUsesCinderdeckIdentity() throws {
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let stack = StackDefinition(id: "fixture", name: "Fixture", file: root.appendingPathComponent("fixture.toml"),
      root: root, shell: "/bin/sh")
    let service = ServiceDefinition(id: "api", command: "true", directory: root)
    let environment = StackLaunchDefinition(stack: stack, service: service).environment(shell: [:], secrets: [:])
    XCTAssertEqual(environment["CINDERDECK_STACK"], "fixture")
    XCTAssertEqual(environment["CINDERDECK_SERVICE"], "api")
    XCTAssertNil(environment["SNAPZY_STACK"])
    XCTAssertNil(environment["SNAPZY_SERVICE"])
  }

  func testShellEnvironmentBannerCacheAndExplicitRefresh() async throws {
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let shell = root.appendingPathComponent("fixture-shell")
    func writeShell(_ value: String) throws {
      try "#!/bin/sh\nprintf 'startup banner\\n\\0CINDERDECK_ENV_BEGIN\\0STACK_FIXTURE=\(value)\\0PATH=/bin:/usr/bin\\0'\n".write(to: shell, atomically: true, encoding: .utf8)
      try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: shell.path)
    }
    try writeShell("first")
    let resolver = ShellEnvironmentResolver()
    let first = try await resolver.resolve(shell: shell.path)
    XCTAssertEqual(first["STACK_FIXTURE"], "first")
    try writeShell("second")
    let cached = try await resolver.resolve(shell: shell.path)
    let refreshed = try await resolver.resolve(shell: shell.path, refresh: true)
    XCTAssertEqual(cached["STACK_FIXTURE"], "first")
    XCTAssertEqual(refreshed["STACK_FIXTURE"], "second")
    XCTAssertEqual(refreshed["PATH"], "/bin:/usr/bin")
  }

  func testInteractiveShellFailureFallsBackToLoginShell() async throws {
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let shell = root.appendingPathComponent("fixture-shell")
    try "#!/bin/sh\nif [ \"$2\" = '-i' ]; then exit 1; fi\nprintf '\\0CINDERDECK_ENV_BEGIN\\0STACK_FALLBACK=yes\\0'\n".write(to: shell, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: shell.path)
    let environment = try await ShellEnvironmentResolver().resolve(shell: shell.path)
    XCTAssertEqual(environment["STACK_FALLBACK"], "yes")
  }

  func testLaneGitFindsExternalHelpersUsingLoginShellPath() async throws {
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let bin = root.appendingPathComponent("bin")
    try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
    let helper = bin.appendingPathComponent("git-lfs")
    try "#!/bin/sh\nprintf 'helper-found:%s' \"$GIT_TERMINAL_PROMPT\"\n".write(to: helper, atomically: true, encoding: .utf8)
    let shell = root.appendingPathComponent("fixture-shell")
    try "#!/bin/sh\nprintf '\\0CINDERDECK_ENV_BEGIN\\0PATH=\(bin.path):/usr/bin:/bin\\0'\n".write(to: shell, atomically: true, encoding: .utf8)
    for file in [helper, shell] { try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: file.path) }
    let result = try await StackLaneStore.gitResult(["-c", "alias.lfs-fixture=!git-lfs fixture", "lfs-fixture"], at: root,
      environment: ["PATH": "/usr/bin:/bin", "SHELL": shell.path])
    XCTAssertEqual(result.status, 0, result.errorText)
    XCTAssertEqual(result.text, "helper-found:0")
  }

  func testKeychainRoundTripUpdateAndDeleteOnlyOwnFixture() throws {
    let store = StackSecretsStore()
    let name = "Cinderdeck-Test-\(UUID().uuidString)"
    defer { try? store.delete(name) }
    try store.save("test-only-value", named: name)
    XCTAssertEqual(try store.read(name), "test-only-value")
    XCTAssertTrue(try store.names().contains(name))
    try store.save("updated-test-only-value", named: name)
    XCTAssertEqual(try store.read(name), "updated-test-only-value")
    try store.delete(name)
    XCTAssertThrowsError(try store.read(name)) { XCTAssertTrue($0.localizedDescription.contains("Missing Keychain secret")) }
  }
}
