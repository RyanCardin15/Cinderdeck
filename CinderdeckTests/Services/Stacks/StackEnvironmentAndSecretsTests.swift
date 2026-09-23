import Foundation
import XCTest
@testable import Cinderdeck

final class StackEnvironmentAndSecretsTests: XCTestCase {
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
