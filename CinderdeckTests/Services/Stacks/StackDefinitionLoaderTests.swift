import Foundation
import XCTest
@testable import Cinderdeck

nonisolated enum StackTestSupport {
  static func temporaryDirectory() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("CinderdeckStacksTests-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
  }
  static func definition(_ source: String, root: URL) throws -> StackDefinition {
    let result = StackDefinitionLoader.load(source, file: root.appendingPathComponent("test.toml"))
    guard let definition = result.definition else { throw StackError.message(result.issues.map(\.message).joined(separator: "\n")) }
    return definition
  }
  static func simpleDefinition(root: URL, command: String = "sleep 300") -> StackLaunchDefinition {
    let service = ServiceDefinition(id: "test", command: command, directory: root)
    let stack = StackDefinition(id: "test", name: "Test", file: root.appendingPathComponent("test.toml"), root: root, shell: "/bin/sh", services: [service])
    return .init(stack: stack, service: service)
  }
}

final class StackDefinitionLoaderTests: XCTestCase {
  func testGenericProjectsAndDottedKeys() throws {
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let stack = try StackTestSupport.definition("""
      name = "Any project"
      shell = "/bin/sh"
      [env]
      MODE = "shared"
      [secrets]
      TOKEN = "secret-reference"
      [repos.backend]
      path = "."
      [services.api]
      repo = "backend"
      cmd = "run-any-language --dev"
      ready.http = "http://localhost:4100/health"
      env.MODE = "service"
      [services.frontend]
      cwd = "."
      cmd = "another-tool serve"
      depends_on = ["api"]
      port = 4200
      ready.port = 4200
      """, root: root)
    XCTAssertEqual(stack.repos.first?.path.path, root.path)
    XCTAssertEqual(stack.service("api")?.directory.path, root.path)
    XCTAssertEqual(stack.service("frontend")?.readiness, .port(4200))
    XCTAssertEqual(try stack.dependencyLayers(), [["api"], ["frontend"]])
  }
  func testMissingCommandUnknownRepoAndCycleAreErrors() {
    let cases = [
      "[services.a]\nport = 12": "cmd is required",
      "[services.a]\ncmd = \"true\"\nrepo = \"missing\"": "unknown repo",
      "[services.a]\ncmd = \"true\"\ndepends_on = [\"b\"]\n[services.b]\ncmd = \"true\"\ndepends_on = [\"a\"]": "Dependency cycle",
      "[services.a]\ncmd = \"true\"\ndepends_on = [\"absent\"]": "unknown service",
    ]
    for (source, expected) in cases {
      let result = StackDefinitionLoader.load(source, file: URL(fileURLWithPath: "/tmp/example.toml"), validatePaths: false)
      XCTAssertNil(result.definition)
      XCTAssertTrue(result.issues.contains { $0.message.contains(expected) }, result.issues.map(\.message).joined())
    }
  }
  func testUnknownKeysWarnAndInvalidTypesFail() {
    let source = "[services.app]\ncmd = \"true\"\nfuture = true"
    let result = StackDefinitionLoader.load(source, file: URL(fileURLWithPath: "/tmp/example.toml"), validatePaths: false)
    XCTAssertNotNil(result.definition)
    XCTAssertEqual(result.issues.first?.severity, .warning)
    for field in ["port = 0", "port = 65536", "port = 12.0", "autostart = 1", "depends_on = [3]", "ready.timeout = -1", "stop_signal = \"KILL\"", "ready.log = \"[\"", "env = 2"] {
      let invalid = StackDefinitionLoader.load(source + "\n" + field, file: URL(fileURLWithPath: "/tmp/example.toml"), validatePaths: false)
      XCTAssertNil(invalid.definition, field)
    }
  }
  func testParseErrorIncludesLineAndMissingPathExplainsFailure() {
    let bad = StackDefinitionLoader.load("name = \"Example\"\n[services.app]\ncmd = not-a-string", file: URL(fileURLWithPath: "/tmp/example.toml"))
    XCTAssertTrue(bad.issues.contains { $0.message.contains("line 3") })
    let missing = StackDefinitionLoader.load("root = \"/this-path-does-not-exist-cinderdeck\"\n[services.app]\ncmd = \"true\"", file: URL(fileURLWithPath: "/tmp/example.toml"))
    XCTAssertNil(missing.definition)
    XCTAssertTrue(missing.issues.contains { $0.message.contains("directory does not exist") })
  }

  func testDuplicateKeysAndMalformedStringsFailWithLineNumbers() {
    for source in ["[services.app]\ncmd = \"one\"\ncmd = \"two\"", "[services.app]\ncmd = \"one\" \"two\"", "[services.app]\ncmd = \"one\"\n[services.app]\ncmd = \"two\""] {
      let result = StackDefinitionLoader.load(source, file: URL(fileURLWithPath: "/tmp/test.toml"), validatePaths: false)
      XCTAssertNil(result.definition)
      XCTAssertTrue(result.issues.contains { $0.message.contains("line") })
    }
  }
  func testEnvironmentPrecedenceAndTildeExpansion() throws {
    var definition = StackTestSupport.simpleDefinition(root: URL(fileURLWithPath: "/tmp"))
    var stack = definition.stack
    var service = definition.service
    stack.environment = ["ORDER": "stack", "STACK_ONLY": "yes"]
    service.environment = ["ORDER": "service", "FORCE_COLOR": "0"]
    definition = .init(stack: stack, service: service)
    let env = definition.environment(shell: ["ORDER": "shell", "PATH": "/bin"], secrets: ["ORDER": "secret"])
    XCTAssertEqual(env["ORDER"], "secret")
    XCTAssertEqual(env["FORCE_COLOR"], "1")
    XCTAssertEqual(env["PATH"], "/bin")
    XCTAssertEqual(env["DOTNET_WATCH_RESTART_ON_RUDE_EDIT"], "1")
    XCTAssertEqual(StackDefinitionLoader.resolve("~/projects", relativeTo: URL(fileURLWithPath: "/tmp")), FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("projects"))
  }
  func testOptionalServicesAndAffectedRepoSets() throws {
    let stack = StackDefinitionLoader.load("""
      [repos.shared]
      path = "."
      [services.api]
      cmd = "api"
      repo = "shared"
      [services.worker]
      cmd = "worker"
      repo = "shared"
      autostart = false
      depends_on = ["api"]
      [services.web]
      cmd = "web"
      depends_on = ["worker"]
      """, file: URL(fileURLWithPath: "/tmp/example.toml"), validatePaths: false).definition!
    XCTAssertEqual(stack.affectedServices(repos: ["shared"]), ["api", "worker"])
    XCTAssertEqual(stack.includingDependents(of: ["api"]), ["api", "worker", "web"])
    XCTAssertFalse(stack.service("worker")!.autostart)
  }
}

final class GitStatusParserTests: XCTestCase {
  func testPorcelainDirtyRenamesConflictsAndAheadBehind() {
    let output = "# branch.oid abcdef0123\0# branch.head feat/x\0# branch.upstream origin/feat/x\0# branch.ab +2 -4\0" +
      "1 M. N... 100644 100644 100644 a b staged\0" +
      "1 .M N... 100644 100644 100644 a b unstaged\0" +
      "2 R. N... 100644 100644 100644 a b R100 new name\0? old name\0" +
      "? untracked file\0u UU N... 100644 100644 100644 100644 a b c conflicted\0"
    let status = GitStatusParser.parse(output)
    XCTAssertEqual(status.branch, "feat/x")
    XCTAssertEqual(status.upstream, "origin/feat/x")
    XCTAssertEqual(status.ahead, 2); XCTAssertEqual(status.behind, 4)
    XCTAssertEqual(status.changedFiles, 5); XCTAssertEqual(status.staged, 2)
    XCTAssertEqual(status.unstaged, 1); XCTAssertEqual(status.untracked, 1); XCTAssertEqual(status.conflicted, 1)
    XCTAssertEqual(status.chip, "feat/x* ↑2 ↓4")
  }
  func testDetachedCleanNoUpstreamAndOperation() {
    let status = GitStatusParser.parse("# branch.head (detached)\0# branch.oid 1234567890\0", operation: "Rebase in progress")
    XCTAssertTrue(status.isDetached); XCTAssertFalse(status.isDirty)
    XCTAssertNil(status.upstream); XCTAssertEqual(status.branchLabel, "Detached 1234567")
    XCTAssertEqual(status.operation, "Rebase in progress")
  }
}

final class GitRecentBranchesTests: XCTestCase {
  func testRecentBranchesDeDuplicateAndLimit() {
    let lines = ["checkout: moving from main to feat/a", "checkout: moving from feat/a to main", "checkout: moving from main to feat/a", "commit: message", "checkout: moving from main to abcdef1234"] + (0...10).map { "checkout: moving from main to feat/\($0)" }
    let recent = GitStatusParser.recentBranches(lines.joined(separator: "\n"))
    XCTAssertEqual(recent.count, 8); XCTAssertEqual(Array(recent.prefix(3)), ["feat/a", "main", "feat/0"])
    XCTAssertFalse(recent.contains("abcdef1234"))
  }
}

final class AnsiParserTests: XCTestCase {
  func testColorsBoldDimResetAndCursorStripping() {
    var parser = AnsiParser.State()
    let runs = parser.parse("plain \u{1b}[1;31mred\u{1b}[2;38;5;123mdim\u{1b}[0m normal\u{1b}[2K\u{1b}[4A")
    XCTAssertEqual(runs.map(\.text).joined(), "plain reddim normal")
    XCTAssertEqual(runs[1].style.foreground, 1); XCTAssertTrue(runs[1].style.bold)
    XCTAssertEqual(runs[2].style.foreground, 123); XCTAssertTrue(runs[2].style.dim)
    XCTAssertEqual(runs[3].style, .init())
    XCTAssertEqual(AnsiParser.plainText("\u{1b}]0;title\u{7}hello\u{1b}]8;;https://example.com\u{1b}\\world\u{1b}]8;;\u{1b}\\"), "helloworld")
  }
  func testStyleContinuesAcrossLines() {
    var parser = AnsiParser.State()
    _ = parser.parse("\u{1b}[92mgreen")
    XCTAssertEqual(parser.parse("still green").first?.style.foreground, 10)
  }
}

final class LogBufferTests: XCTestCase {
  func testReadinessSurvivesNoisyOutputAndClear() async {
    let buffer = LogBuffer(service: "app", capacity: 2, readinessPattern: "^READY$")
    await buffer.consume(Data("\u{1b}[32mREADY\u{1b}[0m\n".utf8))
    for n in 0..<500 { await buffer.append("line \(n)") }
    await buffer.clear()
    let ready = await buffer.matches("^READY$")
    XCTAssertTrue(ready)
  }
  func testNewRunDoesNotMatchReadinessFromOldOutput() async throws {
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let file = root.appendingPathComponent("app.log")
    try Data("READY\n".utf8).write(to: file)
    let process = ServiceProcess()
    _ = try await process.launch(StackTestSupport.simpleDefinition(root: root, command: "echo 'starting again'; sleep 300"), environment: ProcessInfo.processInfo.environment, logURL: file)
    try await Task.sleep(nanoseconds: 100_000_000)
    let buffer = LogBuffer(service: "app", readinessPattern: "READY")
    try await buffer.follow(file, fromEnd: false)
    let ready = await buffer.matches("READY")
    XCTAssertFalse(ready)
    let lines = await buffer.snapshot()
    XCTAssertEqual(lines.map(\.text), ["starting again"])
    await buffer.close()
    try await process.stop(signal: SIGTERM, timeout: 1)
  }
  func testRingCapacityUnicodeChunksClearAndMergedOrder() async {
    let buffer = LogBuffer(service: "api", capacity: 2)
    let bytes = Array("first\nこんにちは\nlast\n".utf8)
    for byte in bytes { await buffer.consume(Data([byte])) }
    var lines = await buffer.snapshot()
    XCTAssertEqual(lines.map(\.text), ["こんにちは", "last"])
    let matches = await buffer.matches("last")
    XCTAssertTrue(matches)
    let earlier = StackLogLine(service: "web", text: "earlier", timestamp: .distantPast)
    XCTAssertEqual(LogBuffer.merged([lines, [earlier]]).first?.text, "earlier")
    await buffer.clear(); lines = await buffer.snapshot(); XCTAssertTrue(lines.isEmpty)
  }
  func testFileFollowingAndTruncation() async throws {
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let url = root.appendingPathComponent("test.log")
    try Data("old\n".utf8).write(to: url)
    let buffer = LogBuffer(service: "app")
    try await buffer.follow(url, fromEnd: true)
    let writer = try FileHandle(forWritingTo: url)
    _ = try writer.seekToEnd(); try writer.write(contentsOf: Data("new\n".utf8)); try writer.close()
    try await Task.sleep(nanoseconds: 250_000_000)
    let lines = await buffer.snapshot()
    XCTAssertEqual(lines.map(\.text), ["new"])
    let truncator = try FileHandle(forWritingTo: url)
    try truncator.truncate(atOffset: 0); try truncator.write(contentsOf: Data("x\n".utf8)); try truncator.close()
    await buffer.readAvailable()
    let after = await buffer.snapshot()
    XCTAssertEqual(after.last?.text, "x")
    await buffer.close()
  }
}
