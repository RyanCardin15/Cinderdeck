import Foundation
import XCTest
@testable import Cinderdeck

final class ReproSourceFingerprintTests: XCTestCase {
  private func fixture(_ body: (URL) throws -> Void) throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("source-fingerprint-" + UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    try body(root)
  }
  func testTrackedBinaryAndUntrackedFixtureContentChangeTheFingerprint() throws {
    try fixture { root in
      let binary = root.appendingPathComponent("tracked.bin"), source = root.appendingPathComponent("fixture.json")
      try Data([0, 1, 2]).write(to: binary)
      try Data("{\"value\":1}".utf8).write(to: source)
      let original = ReproSourceFingerprint.capture(root: root, tracked: ["tracked.bin"], untracked: ["fixture.json"])
      XCTAssertEqual(original.state, "complete"); XCTAssertEqual(original.trackedCount, 1); XCTAssertEqual(original.untrackedCount, 1)
      XCTAssertEqual(original, ReproSourceFingerprint.capture(root: root, tracked: ["tracked.bin", "tracked.bin"], untracked: ["fixture.json"]))
      try Data([0, 1, 3]).write(to: binary)
      let trackedChange = ReproSourceFingerprint.capture(root: root, tracked: ["tracked.bin"], untracked: ["fixture.json"])
      XCTAssertNotEqual(original.hash, trackedChange.hash)
      try Data("{\"value\":2}".utf8).write(to: source)
      XCTAssertNotEqual(trackedChange.hash, ReproSourceFingerprint.capture(root: root, tracked: ["tracked.bin"], untracked: ["fixture.json"]).hash)
    }
  }
  func testIndexChangesAlterTheSnapshotEvenWhenWorkingBytesStayTheSame() throws {
    try fixture { root in
      try Data("working content".utf8).write(to: root.appendingPathComponent("app.ts"))
      let before = ReproSourceFingerprint.capture(root: root, tracked: ["app.ts"], untracked: [], indexFingerprint: String(repeating: "a", count: 64))
      let after = ReproSourceFingerprint.capture(root: root, tracked: ["app.ts"], untracked: [], indexFingerprint: String(repeating: "b", count: 64))
      XCTAssertEqual(before.state, "complete"); XCTAssertEqual(after.state, "complete"); XCTAssertNotEqual(before.hash, after.hash)
    }
  }
  func testProtectedUntrackedInputsAreExcludedAndCompletenessIsUnknown() throws {
    try fixture { root in
      try Data("one".utf8).write(to: root.appendingPathComponent(".env.private"))
      try Data("fixture".utf8).write(to: root.appendingPathComponent("data.json"))
      let before = ReproSourceFingerprint.capture(root: root, tracked: [], untracked: [".env.private", "data.json"])
      XCTAssertEqual(before.state, "unknown"); XCTAssertEqual(before.omittedCount, 1); XCTAssertEqual(before.untrackedCount, 1)
      try Data("two".utf8).write(to: root.appendingPathComponent(".env.private"))
      XCTAssertEqual(before.hash, ReproSourceFingerprint.capture(root: root, tracked: [], untracked: ["data.json", ".env.private"]).hash)
    }
  }
  func testBoundsAndMissingInputsNeverCertifyCompleteSource() throws {
    try fixture { root in
      try Data(repeating: 1, count: 16).write(to: root.appendingPathComponent("app.ts"))
      let bounded = ReproSourceFingerprint.capture(root: root, tracked: ["app.ts"], untracked: [], limits: .init(files: 2, bytesPerFile: 4, totalBytes: 8))
      XCTAssertEqual(bounded.state, "truncated"); XCTAssertEqual(bounded.omittedCount, 1)
      let deletion = ReproSourceFingerprint.capture(root: root, tracked: ["removed/file.ts"], untracked: [])
      XCTAssertEqual(deletion.state, "complete"); XCTAssertEqual(deletion.trackedCount, 1)
      XCTAssertEqual(ReproSourceFingerprint.capture(root: root, tracked: [], untracked: ["missing.ts"]).state, "unknown")
      XCTAssertEqual(ReproSourceFingerprint.capture(root: root, tracked: [], untracked: [], listingsComplete: false).state, "unknown")
    }
  }
  func testSymlinksTraversalAndUnsupportedInputsCannotEscapeTheSourceRoot() throws {
    try fixture { root in
      let outside = root.deletingLastPathComponent().appendingPathComponent("external-" + UUID().uuidString + ".ts")
      try Data("outside".utf8).write(to: outside)
      defer { try? FileManager.default.removeItem(at: outside) }
      try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("link.ts"), withDestinationURL: outside)
      try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("directory"), withDestinationURL: root.deletingLastPathComponent())
      let result = ReproSourceFingerprint.capture(root: root, tracked: ["link.ts", "directory/" + outside.lastPathComponent, "../" + outside.lastPathComponent], untracked: ["opaque.dat"])
      XCTAssertEqual(result.state, "unknown"); XCTAssertEqual(result.omittedCount, 4)
      XCTAssertEqual(result.trackedCount, 0); XCTAssertEqual(result.untrackedCount, 0)
    }
  }
  func testNullDelimitedPathsPreserveNewlinesAndRenamesAndRejectTruncation() {
    XCTAssertEqual(ReproSourceFingerprint.paths("line\nbreak.ts\0space name.ts\0"), ["line\nbreak.ts", "space name.ts"])
    XCTAssertNil(ReproSourceFingerprint.paths("partial.ts"))
    XCTAssertEqual(ReproSourceFingerprint.statusPaths("R  new name.ts\0old name.ts\0?? line\nbreak.ts\0"), ["line\nbreak.ts", "new name.ts", "old name.ts"])
    XCTAssertNil(ReproSourceFingerprint.statusPaths("R  new.ts\0"))
  }
  func testGitIgnoredInputsAreNeverEnumeratedIntoTheFingerprint() throws {
    try fixture { root in
      func git(_ arguments: [String]) throws -> String {
        let process = Process(), pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false"] + arguments; process.currentDirectoryURL = root
        var environment = ProcessInfo.processInfo.environment
        environment["GIT_CONFIG_GLOBAL"] = "/dev/null"; environment["GIT_CONFIG_NOSYSTEM"] = "1"
        process.environment = environment
        process.standardOutput = pipe; process.standardError = FileHandle.nullDevice
        try process.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile(); process.waitUntilExit()
        XCTAssertEqual(process.terminationStatus, 0)
        return String(decoding: data, as: UTF8.self)
      }
      _ = try git(["init", "-q"])
      try Data(".env.private\nprivate.fixture\n".utf8).write(to: root.appendingPathComponent(".gitignore"))
      _ = try git(["add", ".gitignore"])
      _ = try git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"])
      for name in [".env.private", "private.fixture", "public.json"] { try Data("input".utf8).write(to: root.appendingPathComponent(name)) }
      let paths = try XCTUnwrap(ReproSourceFingerprint.paths(git(["ls-files", "--others", "--exclude-standard", "-z"])))
      XCTAssertEqual(paths, ["public.json"])
      let fingerprint = ReproSourceFingerprint.capture(root: root, tracked: [], untracked: paths)
      XCTAssertEqual(fingerprint.state, "complete"); XCTAssertEqual(fingerprint.untrackedCount, 1)
    }
  }
}
