import Foundation
import XCTest
@testable import Cinderdeck

@MainActor
final class PhysicalCheckoutIdentityTests: XCTestCase {
  private func git(_ args: [String], at root: URL) async throws -> String {
    let result = try await StackCommandRunner.run("/usr/bin/git", args, directory: root)
    guard result.status == 0 else { throw StackError.message(result.errorText) }
    return result.text.trimmingCharacters(in: .whitespacesAndNewlines)
  }
  func testPhysicalIdentitySurvivesAliasesAndMovesButSeparatesWorktrees() async throws {
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let repo = root.appendingPathComponent("repo with spaces")
    _ = try await git(["init", "-b", "main", repo.path], at: root)
    _ = try await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "initial"], at: repo)
    let alias = root.appendingPathComponent("alias")
    try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: repo)
    let original = try XCTUnwrap(PhysicalCheckoutIdentity.resolve(repo))
    XCTAssertEqual(try PhysicalCheckoutIdentity.resolve(alias), original)
    let attributes = try FileManager.default.attributesOfItem(atPath: original.gitDirectory.path)
    let device = try XCTUnwrap(attributes[.systemNumber] as? NSNumber)
    let inode = try XCTUnwrap(attributes[.systemFileNumber] as? NSNumber)
    XCTAssertEqual(original.physicalID, PhysicalCheckoutIdentity.digest("\(device.uint64Value):\(inode.uint64Value)"))
    let lane = root.appendingPathComponent("lane")
    _ = try await git(["worktree", "add", "-b", "feature/test", lane.path], at: repo)
    let linked = try XCTUnwrap(PhysicalCheckoutIdentity.resolve(lane))
    XCTAssertNotEqual(linked.physicalID, original.physicalID)
    XCTAssertEqual(try linked.repositoryPhysicalID(), try original.repositoryPhysicalID())
    let moved = root.appendingPathComponent("moved")
    _ = try await git(["worktree", "move", lane.path, moved.path], at: repo)
    XCTAssertEqual(try PhysicalCheckoutIdentity.resolve(moved)?.physicalID, linked.physicalID)
    XCTAssertEqual(try PhysicalCheckoutIdentity.resolve(moved)?.repositoryPhysicalID(), try original.repositoryPhysicalID())
    let nested = repo.appendingPathComponent("nested")
    try FileManager.default.createDirectory(at: nested, withIntermediateDirectories: true)
    XCTAssertEqual(try PhysicalCheckoutIdentity.resolve(nested)?.physicalID, original.physicalID)
    let sharedScope = try await PhysicalCheckoutIdentity.repositoryScope([repo, alias])
    XCTAssertEqual(Set(sharedScope), [original.physicalID, linked.physicalID])
    try FileManager.default.removeItem(at: moved)
    let missingScope = try await PhysicalCheckoutIdentity.repositoryScope([repo])
    XCTAssertEqual(Set(missingScope), [original.physicalID, linked.physicalID], "Missing registered worktrees retain physical ownership during cleanup")
    try "invalid\nsecond-line".write(to: linked.gitDirectory.appendingPathComponent("commondir"), atomically: true, encoding: .utf8)
    XCTAssertThrowsError(try linked.repositoryPhysicalID())
  }
}
