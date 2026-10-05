import Darwin
import Foundation
import XCTest
@testable import Cinderdeck

final class WorkspaceDiscoveryTests: XCTestCase {
  private var root: URL!
  override func setUpWithError() throws { root = try StackTestSupport.temporaryDirectory() }
  override func tearDownWithError() throws { try FileManager.default.removeItem(at: root) }
  private func write(_ path: String, _ source: String = "") throws {
    let file = root.appendingPathComponent(path)
    try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    try source.write(to: file, atomically: true, encoding: .utf8)
  }
  private func service(_ id: String = "web", port: String = "") -> WorkspaceDiscoveredCommand {
    .init(id: id, kind: .service, title: id, command: "sleep 300", directory: root, evidence: "fixture", runtimes: ["/bin/sh"], port: port)
  }
  func testJavaScriptDiscoveryDoesNotExecuteScriptsAndUsesDeclaredManager() throws {
    try write("package.json", #"{"packageManager":"pnpm@9.0.0","dependencies":{"vite":"*"},"scripts":{"dev":"vite","start":"touch should-not-exist","test":"vitest","build":"vite build","lint":"eslint ."}}"#)
    let result = try WorkspaceDiscovery.discover(root: root)
    let dev = try XCTUnwrap(result.commands.first { $0.kind == .service })
    XCTAssertEqual(dev.command, "pnpm run 'dev' --port {{port.dev}} --strictPort")
    XCTAssertEqual(dev.port, "5173")
    XCTAssertEqual(dev.runtimes, ["node", "pnpm"])
    XCTAssertEqual(dev.dependencyFolder, "node_modules")
    XCTAssertTrue(dev.loadsDotEnv)
    XCTAssertEqual(result.commands.filter { $0.kind == .service }.count, 1)
    XCTAssertEqual(result.commands.filter { $0.kind == .task }.count, 3)
    XCTAssertEqual(result.commands.first { $0.id == "test" }?.command, "pnpm run 'test' run")
    XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("should-not-exist").path))
  }
  func testMonorepoExcludesGeneratedAndSymlinkFoldersAndPreservesWorkingDirectories() throws {
    let manifest = #"{"scripts":{"dev":"next dev","build":"next build"}}"#
    try write("apps/web/package.json", manifest)
    try write("packages/api/package.json", #"{"scripts":{"dev":"node server.js --port 4300"}}"#)
    try write("node_modules/noise/package.json", manifest)
    try write(".build/noise/package.json", manifest)
    try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("linked"), withDestinationURL: root.appendingPathComponent("apps/web"))
    let result = try WorkspaceDiscovery.discover(root: root)
    XCTAssertEqual(result.commands.count, 3)
    XCTAssertEqual(result.commands.first { $0.id == "apps-web-dev" }?.directory, root.appendingPathComponent("apps/web", isDirectory: true))
    XCTAssertEqual(result.commands.first { $0.id == "packages-api-dev" }?.port, "4300")
  }
  func testNestedPackagesInheritManagerAndHoistedDependencies() throws {
    try write("package.json", #"{"packageManager":"pnpm@9.0.0"}"#)
    try write("apps/web/package.json", #"{"dependencies":{"vite":"*"},"scripts":{"dev":"vite"}}"#)
    try FileManager.default.createDirectory(at: root.appendingPathComponent("node_modules"), withIntermediateDirectories: true)
    let result = try WorkspaceDiscovery.discover(root: root)
    let command = try XCTUnwrap(result.commands.first)
    XCTAssertTrue(command.command.hasPrefix("pnpm run"))
    XCTAssertTrue(WorkspaceSetupCheck.hasDependencies("node_modules", directory: command.directory, root: result.root))
    XCTAssertFalse(WorkspaceSetupCheck.hasDependencies("missing", directory: command.directory, root: result.root))
  }
  func testYarnPlugAndPlayCountsAsInstalledDependencies() throws {
    try write(".pnp.cjs", "module.exports = {}")
    try FileManager.default.createDirectory(at: root.appendingPathComponent("apps/web"), withIntermediateDirectories: true)
    XCTAssertTrue(WorkspaceSetupCheck.hasDependencies("node_modules", directory: root.appendingPathComponent("apps/web"), root: root))
  }
  func testXcodeSharedSchemeProposesTestsWithMacDestination() throws {
    try write("Demo.xcodeproj/project.pbxproj", "SDKROOT = macosx;")
    try write("Demo.xcodeproj/xcshareddata/xcschemes/Demo.xcscheme", "<Scheme><TestAction><TestPlanReference reference=\"container:Demo.xctestplan\" /></TestAction></Scheme>")
    let commands = try WorkspaceDiscovery.discover(root: root).commands
    XCTAssertEqual(commands.count, 2)
    XCTAssertTrue(commands.contains { $0.command == "xcodebuild -project 'Demo.xcodeproj' -scheme 'Demo' -destination 'platform=macOS' test" })
  }
  func testManifestErrorsAndUnknownProjectsHaveActionableFallback() throws {
    try write("package.json", "{bad json")
    let result = try WorkspaceDiscovery.discover(root: root)
    XCTAssertTrue(result.commands.isEmpty)
    XCTAssertTrue(result.notes.contains { $0.contains("Fix its JSON") })
    XCTAssertTrue(result.notes.contains { $0.contains("Add a service or task") })
    XCTAssertThrowsError(try WorkspaceDiscovery.discover(root: root.appendingPathComponent("missing")))
  }
  func testNonJavaScriptManifestsAndComposeAreDetected() throws {
    try write("rust/Cargo.toml", "[package]\nname = \"demo\"")
    try write("rust/src/main.rs")
    try write("go/go.mod", "module example")
    try write("go/main.go", "package main")
    try write("python/pyproject.toml", "[project]\ndependencies = [\"pytest\"]")
    try write("python/manage.py")
    try write("python/uv.lock")
    try write("swift/Package.swift")
    try write("swift/Tests/test.swift")
    try write("Makefile", "test:\n\techo test\ndev:\n\techo dev\n")
    try write("compose.yaml", "services:\n  db:\n    image: postgres\n")
    let result = try WorkspaceDiscovery.discover(root: root)
    for id in ["rust-cargo-build", "rust-cargo-test", "rust-cargo-run", "go-go-test", "go-go-build", "go-go-run", "python-django", "python-pytest", "swift-swift-build", "swift-swift-test", "make-test", "make-dev", "containers"] {
      XCTAssertTrue(result.commands.contains { $0.id == id }, id)
    }
    XCTAssertEqual(result.commands.first { $0.id == "python-django" }?.command, "uv run python manage.py runserver 127.0.0.1:{{port.python-django}}")
    XCTAssertEqual(result.commands.first { $0.id == "containers" }?.composeFile, "compose.yaml")
  }
  func testDiscoveryIsBoundedAndDoesNotReadSymlinkManifests() throws {
    try write("a/b/c/d/package.json", #"{"scripts":{"dev":"vite"}}"#)
    try write("outside.json", #"{"scripts":{"dev":"vite"}}"#)
    try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("package.json"), withDestinationURL: root.appendingPathComponent("outside.json"))
    let result = try WorkspaceDiscovery.discover(root: root)
    XCTAssertTrue(result.commands.isEmpty)
  }
  func testPreflightReportsMissingServiceRuntimeDependenciesAndInvalidPort() async throws {
    var command = service(port: "70000")
    command.runtimes = ["cinderdeck-no-such-runtime"]
    command.dependencyFolder = "node_modules"
    let issues = await WorkspaceSetupCheck.check(root: root, commands: [command], environment: ["PATH": "/bin"])
    XCTAssertTrue(issues.contains { $0.id.hasSuffix("invalid-port") && $0.severity == .blocker })
    XCTAssertTrue(issues.contains { $0.title.contains("cinderdeck-no-such-runtime") && $0.severity == .blocker })
    XCTAssertTrue(issues.contains { $0.title.contains("dependencies") && $0.severity == .blocker })
    command.selected = false
    let excluded = await WorkspaceSetupCheck.check(root: root, commands: [command], environment: [:])
    XCTAssertTrue(excluded.isEmpty)
  }
  func testMissingTaskRuntimeDoesNotBlockStartingServices() async {
    var command = service(); command.kind = .task; command.runtimes = ["missing-test-tool"]
    let issues = await WorkspaceSetupCheck.check(root: root, commands: [command], environment: [:])
    XCTAssertEqual(issues.count, 1)
    XCTAssertEqual(issues.first?.severity, .warning)
  }
  func testEnvironmentHintsIncludeOnlyKeysAndRespectAutomaticDotEnvLoading() throws {
    try write(".env.example", "TOKEN=\nOPTIONAL=default\nPORT=3000\n")
    try write(".env.local", "TOKEN=private-sentinel-value\nOPTIONAL=\n")
    var command = service(port: "3000"); command.loadsDotEnv = true
    let hints = WorkspaceSetupCheck.environmentIssues(command: command, environment: [:])
    XCTAssertTrue(hints.first?.detail.contains("OPTIONAL") == true)
    XCTAssertFalse(hints.first?.detail.contains("TOKEN") == true)
    XCTAssertFalse(hints.first?.detail.contains("private-sentinel") == true)
    command.loadsDotEnv = false
    let manual = WorkspaceSetupCheck.environmentIssues(command: command, environment: [:])
    XCTAssertTrue(manual.first?.detail.contains("TOKEN") == true)
    XCTAssertTrue(manual.first?.detail.contains("not known to load .env") == true)
    let supplied = WorkspaceSetupCheck.environmentIssues(command: command, environment: ["TOKEN": "present", "OPTIONAL": "present"])
    XCTAssertTrue(supplied.isEmpty)
  }
  func testEnvKeyParsingHandlesCommentsExportsAndEmptyValues() {
    let source = "# COMMENT=x\nexport API_KEY='value'\nEMPTY=\"\"\nNO_VALUE= # later\nINVALID-KEY=x\nGOOD_2=x\n"
    XCTAssertEqual(WorkspaceSetupCheck.envKeys(source, filledOnly: false), ["API_KEY", "EMPTY", "NO_VALUE", "GOOD_2"])
    XCTAssertEqual(WorkspaceSetupCheck.envKeys(source, filledOnly: true), ["API_KEY", "GOOD_2"])
  }
  func testPreflightChecksOccupiedAndDuplicatePorts() async throws {
    let listener = socket(AF_INET, SOCK_STREAM, 0)
    XCTAssertGreaterThanOrEqual(listener, 0); defer { close(listener) }
    var address = sockaddr_in(); address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET); address.sin_addr.s_addr = inet_addr("127.0.0.1")
    let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(listener, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
    XCTAssertEqual(bound, 0); XCTAssertEqual(listen(listener, 2), 0)
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    let found = withUnsafeMutablePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(listener, $0, &length) } }
    XCTAssertEqual(found, 0)
    let port = String(UInt16(bigEndian: address.sin_port))
    let issues = await WorkspaceSetupCheck.check(root: root, commands: [service("web", port: port), service("api", port: port)], environment: [:])
    XCTAssertTrue(issues.contains { $0.title.contains("is in use") && $0.severity == .blocker })
    XCTAssertTrue(issues.contains { $0.title.contains("Two services") && $0.severity == .blocker })
  }
  func testFixedScriptPortCannotBeSilentlyChangedInMetadata() async {
    var command = service(port: "54321"); command.fixedPort = 3000
    let issues = await WorkspaceSetupCheck.check(root: root, commands: [command], environment: [:])
    XCTAssertTrue(issues.contains { $0.id.hasSuffix("fixed-port") })
  }
  func testCollidingMonorepoIDsUseTheirOwnPortTemplates() throws {
    let manifest = #"{"scripts":{"dev":"vite"}}"#
    try write("a-b/package.json", manifest)
    try write("a/b/package.json", manifest)
    let result = try WorkspaceDiscovery.discover(root: root)
    let commands = result.commands.filter { $0.kind == .service }
    XCTAssertEqual(Set(commands.map(\.id)).count, 2)
    for command in commands { XCTAssertTrue(command.command.contains("{{port.\(command.id)}}")) }
  }
  func testComposePreflightChecksPublishedPortsWithoutExposingRenderedValues() async throws {
    let port = try StackLaneStore.availablePort(excluding: [])
    try write("bin/docker", """
    #!/bin/sh
    case "$*" in
      "compose version") echo 'Docker Compose version v2' ;;
      *config*) echo '{"services":{"db":{"environment":{"TOKEN":"private-rendered-sentinel"},"ports":[{"published":"\(port)","target":5432,"protocol":"tcp"}]}}}' ;;
      info*) echo '27.0.0' ;;
      *) exit 1 ;;
    esac
    """)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: root.appendingPathComponent("bin/docker").path)
    var command = service("containers"); command.runtimes = ["docker"]; command.composeFile = "compose.yaml"
    let environment = ["PATH": root.appendingPathComponent("bin").path + ":/bin"]
    let issues = await WorkspaceSetupCheck.check(root: root, commands: [command, service("api", port: String(port))], environment: environment)
    XCTAssertTrue(issues.contains { $0.title.contains("Two services") })
    XCTAssertFalse(issues.contains { $0.detail.contains("private-rendered-sentinel") })
    XCTAssertFalse(issues.contains { $0.id.hasSuffix("unknown-port") })
  }
  func testComposeInvalidConfigAndStoppedEngineBlockLaunch() async throws {
    try write("bin/docker", """
    #!/bin/sh
    case "$*" in
      "compose version") echo 'Docker Compose version v2' ;;
      *) exit 1 ;;
    esac
    """)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: root.appendingPathComponent("bin/docker").path)
    var command = service("containers"); command.runtimes = ["docker"]; command.composeFile = "compose.yaml"
    let issues = await WorkspaceSetupCheck.check(root: root, commands: [command], environment: ["PATH": root.appendingPathComponent("bin").path])
    XCTAssertTrue(issues.contains { $0.id.hasSuffix("compose-config") && $0.severity == .blocker })
    XCTAssertTrue(issues.contains { $0.id.hasSuffix("docker-engine") && $0.severity == .blocker })
  }
  func testContainerDiscoversEveryGitRootIncludingWorktreeMetadataWithoutCommands() throws {
    try write("api/.git/HEAD", "ref: refs/heads/main")
    try write("web/.git", "gitdir: /tmp/worktree-metadata")
    try write("api/package.json", #"{"scripts":{"test":"echo tested"}}"#)
    let result = try WorkspaceDiscovery.discover(root: root)
    XCTAssertEqual(Set(result.repositories.map { $0.path.lastPathComponent }), ["api", "web"])
    XCTAssertTrue(result.repositories.allSatisfy { $0.laneMode == .worktree })
    let components = try WorkspaceSetupModel.components(root: root, commands: result.commands, repositories: result.repositories)
    let loaded = try XCTUnwrap(StackDefinitionLoader.load("root = \"\(root.path)\"\n" + components, file: root.appendingPathComponent("workspace.toml")).definition)
    XCTAssertEqual(loaded.repos.count, 2)
    XCTAssertEqual(loaded.tasks.first?.repo, "api")
    XCTAssertEqual(loaded.tasks.first?.directory, root.appendingPathComponent("api", isDirectory: true))
  }

  func testIndependentFoldersKeepUniqueCommandsPortTemplatesAndSharedFoldersAfterSave() throws {
    let manifest = #"{"scripts":{"dev":"vite","test":"echo tested"}}"#
    try write("one/app/.git/HEAD")
    try write("two/app/.git/HEAD")
    try write("one/app/package.json", manifest)
    try write("two/app/package.json", manifest)
    try write("docs/Makefile", "test:\n\techo docs\n")
    let first = root.appendingPathComponent("one/app", isDirectory: true)
    let second = root.appendingPathComponent("two/app", isDirectory: true)
    let docs = root.appendingPathComponent("docs", isDirectory: true)
    let result = try WorkspaceDiscovery.discover(root: first, additionalFolders: [second, docs, first])
    XCTAssertEqual(result.folders.count, 3)
    XCTAssertEqual(result.repositories.count, 3)
    XCTAssertEqual(Set(result.repositories.map(\.id)).count, 3)
    XCTAssertEqual(Set(result.commands.map(\.id)).count, 5)
    for command in result.commands where command.kind == .service { XCTAssertTrue(command.command.contains("{{port.\(command.id)}}")) }
    let source = "root = \"\(first.path)\"\n" + (try WorkspaceSetupModel.components(root: first, commands: result.commands, repositories: result.repositories))
    let loaded = try XCTUnwrap(StackDefinitionLoader.load(source, file: root.appendingPathComponent("workspace.toml")).definition)
    XCTAssertEqual(Set(loaded.services.map(\.directory)), [first, second])
    XCTAssertEqual(loaded.repo(try XCTUnwrap(loaded.tasks.first { $0.directory == docs }?.repo))?.laneMode, .shared)
    for command in loaded.services { XCTAssertEqual(loaded.repo(try XCTUnwrap(command.repo))?.path, command.directory) }
  }

  func testOverlappingFoldersDeduplicateCommandsAndSubfolderUsesItsGitRoot() throws {
    try write(".git/HEAD")
    try write("apps/web/package.json", #"{"scripts":{"dev":"vite"}}"#)
    let web = root.appendingPathComponent("apps/web", isDirectory: true)
    let overlap = try WorkspaceDiscovery.discover(root: root, additionalFolders: [web])
    XCTAssertEqual(overlap.commands.count, 1)
    XCTAssertEqual(overlap.repositories.count, 1)
    let selected = try WorkspaceDiscovery.discover(root: web)
    XCTAssertEqual(selected.repositories.first?.path.path, root.path)
    let source = "root = \"\(web.path)\"\n" + (try WorkspaceSetupModel.components(root: web, commands: selected.commands, repositories: selected.repositories))
    let loaded = try XCTUnwrap(StackDefinitionLoader.load(source, file: root.appendingPathComponent("workspace.toml")).definition)
    XCTAssertEqual(loaded.services.first?.directory, web, "A selected package must not launch at the repository root")
  }

  func testFolderOnlyWorkspaceAndLaneDefaultsSaveWithoutExecutingSetup() throws {
    try write("docs/Makefile", "test:\n\techo docs\n")
    let result = try WorkspaceDiscovery.discover(root: root)
    XCTAssertEqual(result.repositories.first?.laneMode, .shared)
    let task = try XCTUnwrap(result.commands.first)
    let source = "root = \"\(root.path)\"\n" + (try WorkspaceSetupModel.components(root: root, commands: result.commands,
      repositories: result.repositories, copyEnvironmentFiles: true, setupTask: task.id))
    let loaded = try XCTUnwrap(StackDefinitionLoader.load(source, file: root.appendingPathComponent("workspace.toml")).definition)
    XCTAssertEqual(loaded.laneSettings?.copy, [".env", ".env.local"])
    XCTAssertEqual(loaded.laneSettings?.setup, "task:" + task.id)
    var excluded = task; excluded.selected = false
    XCTAssertThrowsError(try WorkspaceSetupModel.components(root: root, commands: [excluded], setupTask: task.id))
  }

  func testNestedRepositoriesRequireAnExplicitSharedChoice() throws {
    try write(".git/HEAD")
    try write("inner/.git/HEAD")
    var result = try WorkspaceDiscovery.discover(root: root)
    XCTAssertThrowsError(try WorkspaceSetupModel.components(root: root, commands: [], repositories: result.repositories))
    let inner = try XCTUnwrap(result.repositories.firstIndex { $0.path.lastPathComponent == "inner" })
    result.repositories[inner].laneMode = .shared
    XCTAssertNoThrow(try WorkspaceSetupModel.components(root: root, commands: [], repositories: result.repositories))
  }

  func testSelectedPackageInheritsRepositoryManagerAndDependencyBoundary() throws {
    try write(".git/HEAD")
    try write("package.json", #"{"packageManager":"pnpm@9.0.0"}"#)
    try write("apps/web/package.json", #"{"dependencies":{"vite":"*"},"scripts":{"dev":"vite"}}"#)
    try FileManager.default.createDirectory(at: root.appendingPathComponent("node_modules"), withIntermediateDirectories: true)
    let web = root.appendingPathComponent("apps/web", isDirectory: true)
    let command = try XCTUnwrap(WorkspaceDiscovery.discover(root: web).commands.first)
    XCTAssertTrue(command.command.hasPrefix("pnpm run"))
    XCTAssertEqual(command.discoveryRoot?.path, root.path)
    XCTAssertTrue(WorkspaceSetupCheck.hasDependencies("node_modules", directory: web, root: try XCTUnwrap(command.discoveryRoot)))
  }

  func testUnicodeRepositoryNamesSaveValidUniqueAssociations() throws {
    try write("项目/.git/HEAD")
    try write("项目/package.json", #"{"scripts":{"test":"echo tested"}}"#)
    let scan = try WorkspaceDiscovery.discover(root: root)
    let source = "root = \"\(root.path)\"\n" + (try WorkspaceSetupModel.components(root: root, commands: scan.commands, repositories: scan.repositories))
    let loaded = try XCTUnwrap(StackDefinitionLoader.load(source, file: root.appendingPathComponent("workspace.toml")).definition)
    XCTAssertEqual(loaded.repos.first?.id, "repository")
    XCTAssertEqual(loaded.tasks.first?.repo, "repository")
  }

  @MainActor
  func testChangingCommandFolderRegistersItsRepositoryAndPreservesWorkingDirectory() throws {
    try write("app/.git/HEAD")
    try write("app/packages/web/placeholder")
    let model = WorkspaceSetupModel()
    model.commands = [service()]
    let web = root.appendingPathComponent("app/packages/web", isDirectory: true)
    model.moveCommand("web", to: web)
    XCTAssertEqual(model.repositories.first?.path, root.appendingPathComponent("app", isDirectory: true))
    let source = "root = \"\(root.path)\"\n" + (try WorkspaceSetupModel.components(root: root, commands: model.commands, repositories: model.repositories))
    let loaded = try XCTUnwrap(StackDefinitionLoader.load(source, file: root.appendingPathComponent("workspace.toml")).definition)
    XCTAssertEqual(loaded.services.first?.directory, web)
    XCTAssertEqual(loaded.services.first?.repo, "app")
  }

  func testLaneSummaryIncludesImplicitGitRootsAlongsideSharedFolders() throws {
    try write("app/.git/HEAD")
    try write("docs/placeholder")
    let app = root.appendingPathComponent("app", isDirectory: true)
    let docs = root.appendingPathComponent("docs", isDirectory: true)
    var definition = StackTestSupport.simpleDefinition(root: root).stack
    definition.repos = [.init(id: "docs", path: docs, laneMode: .shared)]
    definition.services[0].directory = app
    XCTAssertEqual(WorkspaceSetupModel.laneRepositories(in: definition).map { $0.path.path }, [app.path])
    definition.services[0].laneMode = .shared
    XCTAssertTrue(WorkspaceSetupModel.laneRepositories(in: definition).isEmpty)
    definition.services[0].laneMode = nil
    definition.services[0].repo = "docs"
    XCTAssertTrue(WorkspaceSetupModel.laneRepositories(in: definition).isEmpty)
  }

  func testLaneEnvironmentPreservesValuesAndRefusesInvalidOrDuplicateNames() throws {
    XCTAssertEqual(try WorkspaceSetupModel.laneEnvironment(" MODE=preview\nTOKEN=a=b\nEMPTY=\n"), ["MODE": "preview", "TOKEN": "a=b", "EMPTY": ""])
    for text in ["missing-equals", "BAD-NAME=value", "MODE=one\nMODE=two", "=value"] { XCTAssertThrowsError(try WorkspaceSetupModel.laneEnvironment(text)) }
  }

  @MainActor
  func testReviewedSelectionSavesValidDefinitionWithoutExecutingAndRefusesOverwrite() throws {
    try write(".git/HEAD", "ref: refs/heads/main")
    try write("package.json", #"{"scripts":{"dev":"next dev","build":"next build","test":"echo tested"}}"#)
    var result = try WorkspaceDiscovery.discover(root: root)
    result.commands[result.commands.firstIndex { $0.id == "test" }!].selected = false
    let components = try WorkspaceSetupModel.components(root: root, commands: result.commands)
    let directory = root.appendingPathComponent("definitions")
    let file = try WorkspaceDefinitionWriter.createWorkspace(name: "My project", root: root.path, directory: directory, components: components)
    let loaded = try XCTUnwrap(StackDefinitionLoader.load(String(contentsOf: file), file: file).definition)
    XCTAssertEqual(loaded.services.count, 1)
    XCTAssertEqual(loaded.tasks.map(\.id), ["build"])
    XCTAssertEqual(loaded.services.first?.command, "npm run 'dev' -- --port 3000")
    XCTAssertEqual(loaded.repos.first?.id, "project")
    XCTAssertThrowsError(try WorkspaceDefinitionWriter.createWorkspace(name: "My project", root: root.path, directory: directory, components: components))
    XCTAssertEqual(try String(contentsOf: file).contains("tested"), false)
  }
  @MainActor
  func testCreatedWorkspaceOpensTasksForProjectsWithNoServices() {
    var definition = StackTestSupport.simpleDefinition(root: root).stack
    XCTAssertEqual(WorkspaceSection.initialSection(definition), .services)
    definition.services = []
    definition.tasks = [.init(id: "build", name: "Build", command: "echo built", directory: root)]
    XCTAssertEqual(WorkspaceSection.initialSection(definition), .tasks)
    definition.tasks = []
    XCTAssertEqual(WorkspaceSection.initialSection(definition), .services)
  }
  @MainActor
  func testEditsAndFolderChangesInvalidateChecksAndProposals() {
    let model = WorkspaceSetupModel()
    model.commands = [service()]
    model.folder = root.path
    XCTAssertTrue(model.commands.isEmpty)
    XCTAssertNil(model.proposal)
    XCTAssertFalse(model.canStart)
  }
}
