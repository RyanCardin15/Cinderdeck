import AppKit
import SwiftUI
import XCTest
@testable import Cinderdeck

/// Opt-in native artwork export. All repositories, processes, settings, and runs
/// belong to a temporary fixture. No GitHub requests or production commands run.
@MainActor
final class PromoSnapshotTests: XCTestCase {
  func testExportNativeScreens() async throws {
    let source = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
    guard FileManager.default.fileExists(atPath: source.appendingPathComponent(".build/promo/capture-native").path) else {
      throw XCTSkip("Run scripts/render-promo.sh --capture to export native promo screens.")
    }
    let output = source.appendingPathComponent("promo/public/screens")
    try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
    let root = URL(fileURLWithPath: "/tmp/Cinderdeck-Demo-\(UUID().uuidString.prefix(8))")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)

    let suite = "CinderdeckPromo-\(UUID())"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    defaults.set(root.path, forKey: PreferencesKeys.stacksDirectory)
    defaults.set(false, forKey: PreferencesKeys.stacksNotifyOnCrash)
    defaults.set(0, forKey: PreferencesKeys.stacksAutoFetchMinutes)
    let oldVolatile = UserDefaults.standard.volatileDomain(forName: UserDefaults.argumentDomain)
    var volatile = oldVolatile
    volatile[PreferencesKeys.historySelectedSection] = HistorySection.stacks.rawValue
    volatile[PreferencesKeys.historyBackgroundStyle] = HistoryBackgroundStyle.solid.rawValue
    volatile[PreferencesKeys.historyFloatingScale] = 1.0
    volatile[PreferencesKeys.stacksEnabled] = true
    UserDefaults.standard.setVolatileDomain(volatile, forName: UserDefaults.argumentDomain)
    defer { UserDefaults.standard.setVolatileDomain(oldVolatile, forName: UserDefaults.argumentDomain) }
    let pool = try DatabaseManager.openDatabase(at: root.appendingPathComponent("fixture.sqlite")).dbPool
    let supervisor = StackSupervisor(store: StackRunStore(pool: pool), defaults: defaults, logRoot: root.appendingPathComponent("logs"), environment: { _ in ProcessInfo.processInfo.environment })
    let runner = WorkspaceRunner(supervisor: supervisor, store: WorkspaceRunStore(directory: root.appendingPathComponent("runs")), environment: { _ in ProcessInfo.processInfo.environment })
    addTeardownBlock { @MainActor in
      await runner.cancelAll()
      await supervisor.stopAll()
      await supervisor.shutdownMonitoring()
      try? FileManager.default.removeItem(at: root)
    }
    for repo in ["web", "api"] {
      let path = root.appendingPathComponent(repo)
      try FileManager.default.createDirectory(at: path, withIntermediateDirectories: true)
      _ = try await StackCommandRunner.run("/usr/bin/git", ["init", "-b", repo == "web" ? "feature/workspace-layout" : "main"], directory: path)
    }
    let definition = """
    name = "Cinderdeck Studio"
    root = \(WorkspaceDefinitionWriter.quote(root.path))
    shell = "/bin/sh"
    [repos.web]
    path = "web"
    [repos.api]
    path = "api"
    [services.web]
    repo = "web"
    cmd = "printf 'READY\\n'; sleep 120"
    ready.log = "READY"
    [services.api]
    repo = "api"
    cmd = "printf 'READY\\n'; sleep 120"
    ready.log = "READY"
    [tasks.lint]
    name = "Lint"
    cmd = "printf 'Checking formatting and source files…\\n'; sleep 2; printf 'Lint passed.\\n'"
    [tasks.test]
    name = "Test"
    cmd = "printf 'Running the sample test suite…\\n'; sleep 2; printf 'All sample tests passed.\\n'"
    [tasks.build]
    name = "Build"
    cmd = "printf 'Building the sample project…\\n'; sleep 2; printf 'Build complete.\\n'"
    [workflows.verify]
    name = "Verify changes"
    steps = ["task:lint", "task:test", "task:build"]
    [workflows.preview]
    name = "Start preview"
    steps = ["start:api", "start:web"]
    """
    try definition.write(to: root.appendingPathComponent("studio.toml"), atomically: true, encoding: .utf8)
    try "name = \"Documentation\"\nroot = \(WorkspaceDefinitionWriter.quote(root.path))\n[tasks.check]\ncmd = \"true\"\n".write(to: root.appendingPathComponent("z-docs.toml"), atomically: true, encoding: .utf8)
    await supervisor.reloadDefinitions()
    await runner.recover()
    XCTAssertEqual(supervisor.files.count, 2)
    XCTAssertTrue(supervisor.files.allSatisfy { $0.definition != nil })
    let model = StacksViewModel(supervisor: supervisor)
    model.select("studio")
    await supervisor.start(stack: "studio")
    XCTAssertEqual(supervisor.runtime("studio", "web").phase, .ready)
    XCTAssertEqual(supervisor.runtime("studio", "api").phase, .ready)
    await supervisor.gitMonitor.refreshAll()
    try await Task.sleep(nanoseconds: 200_000_000)
    let compact = HistoryFloatingManager(previewMode: .compact)
    let expanded = HistoryFloatingManager(previewMode: .expanded)
    try await render(HistoryFloatingContentView(manager: compact, stacksViewModel: model), size: .init(width: 920, height: 316), name: "history-compact", output: output)
    try await render(HistoryFloatingContentView(manager: expanded, stacksViewModel: model), size: .init(width: 1040, height: 680), name: "history-expanded", output: output)
    try await render(HistoryFloatingContentView(manager: expanded, stacksViewModel: model), size: .init(width: 1040, height: 680), name: "history-light", output: output, dark: false)
    model.select("z-docs")
    try await render(HistoryFloatingContentView(manager: expanded, stacksViewModel: model), size: .init(width: 1040, height: 680), name: "history-tasks-only", output: output)
    model.select("studio")
    model.stackFilter = "no-matching-workspace"
    try await render(StacksTabView(viewModel: model, manager: expanded), size: .init(width: 1000, height: 530), name: "history-search-empty", output: output)
    model.stackFilter = ""
    // Long labels exercise truncation without sacrificing actions or row spacing.
    try definition.replacingOccurrences(of: "Cinderdeck Studio", with: "Cinderdeck Studio — a workspace with a deliberately long name").write(to: root.appendingPathComponent("studio.toml"), atomically: true, encoding: .utf8)
    await supervisor.reloadDefinitions()
    try await render(HistoryFloatingContentView(manager: expanded, stacksViewModel: model), size: .init(width: 1040, height: 680), name: "history-long-name", output: output)
    try definition.write(to: root.appendingPathComponent("studio.toml"), atomically: true, encoding: .utf8)
    await supervisor.reloadDefinitions()
    try await render(WorkspaceView(model: model, runner: runner, initialSection: .workflows), size: .init(width: 1160, height: 720), name: "workflows", output: output)
    let run = try runner.submit(workspace: "studio", kind: .workflow, definitionID: "verify")
    try await Task.sleep(nanoseconds: 2_800_000_000)
    try await render(WorkspaceView(model: model, runner: runner, initialSection: .runs), size: .init(width: 1160, height: 720), name: "workflow-running", output: output)
    let deadline = Date().addingTimeInterval(10)
    while runner.run(run.id)?.status.isActive == true, Date() < deadline { try await Task.sleep(nanoseconds: 100_000_000) }
    XCTAssertEqual(runner.run(run.id)?.status, .succeeded)
    XCTAssertEqual(runner.run(run.id)?.steps.map(\.exitCode), [0, 0, 0])
    try await render(WorkspaceView(model: model, runner: runner, initialSection: .runs), size: .init(width: 1160, height: 720), name: "workflow-complete", output: output)
    let service = PromoGitHubService()
    let git = PullRequestsViewModel(service: service, defaults: defaults)
    await git.connect()
    git.select("promo-pr-24")
    try await Task.sleep(nanoseconds: 300_000_000)
    XCTAssertEqual(git.requests.count, 3)
    XCTAssertNotNil(git.detail)
    try await render(PullRequestsView(model: git), size: .init(width: 1280, height: 760), name: "git-overview", output: output)
    await runner.cancelAll()
    await supervisor.stopAll()
    await supervisor.shutdownMonitoring()
  }

  private func render<V: View>(_ view: V, size: CGSize, name: String, output: URL, dark: Bool = true) async throws {
    let host = NSHostingView(rootView: view.environment(\.colorScheme, dark ? .dark : .light).tint(.orange))
    let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
    window.contentView = host
    host.frame = NSRect(origin: .zero, size: size)
    window.setContentSize(size)
    // AppKit draws native controls even though this test window is never ordered onscreen.
    defer { window.close() }
    host.layoutSubtreeIfNeeded()
    try await Task.sleep(nanoseconds: 500_000_000)
    host.layoutSubtreeIfNeeded()
    let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
    host.cacheDisplay(in: host.bounds, to: bitmap)
    let data = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
    XCTAssertGreaterThan(data.count, 20_000, "A blank screen must never enter the promo")
    try data.write(to: output.appendingPathComponent(name + ".png"))
  }
}

@MainActor
private final class PromoGitHubService: GitHubPRServing {
  var hostname = "github.com"
  func viewer() async throws -> String { "studio-demo" }
  func organizations(after: String?) async throws -> GitHubConnection<GitHubActor> { .init(nodes: [.init(login: "cinderdeck-demo")]) }
  func repositories(organization: String, after: String?) async throws -> GitHubConnection<GitHubRepository> { try await repositories(after: after) }
  func repositories(after: String?) async throws -> GitHubConnection<GitHubRepository> {
    .init(nodes: ["app", "api", "docs"].enumerated().map { index, name in
      .init(id: "repo-\(index)", nameWithOwner: "cinderdeck-demo/\(name)", isPrivate: false, isArchived: false, viewerHasStarred: index == 0, url: "https://github.com/cinderdeck-demo/\(name)")
    }, pageInfo: .init(hasNextPage: false))
  }
  func search(_ query: String, after: String?) async throws -> PullRequestSearchPage {
    let titles = ["Give workspaces room to breathe", "Add an ordered verification workflow", "Keep run output close at hand"]
    let rows: [PullRequest] = titles.enumerated().map { index, title in
      .init(id: "promo-pr-\(24-index)", number: 24-index, title: title, url: "https://github.com/cinderdeck-demo/app/pull/\(24-index)", state: "OPEN", isDraft: index == 2, author: .init(login: "alex"), repository: .init(nameWithOwner: "cinderdeck-demo/app"), updatedAt: Date().addingTimeInterval(Double(-index * 3600)), additions: 86-index*20, deletions: 24-index*6, changedFiles: 3, reviewDecision: index == 0 ? "APPROVED" : "REVIEW_REQUIRED", labels: .init(nodes: [.init(name: index == 0 ? "interface" : "enhancement")]), commits: .init(nodes: [.init(commit: .init(statusCheckRollup: .init(state: "SUCCESS")))]))
    }
    return .init(requests: rows, count: rows.count, pageInfo: .init(hasNextPage: false))
  }
  func detail(id: String) async throws -> PullRequestDetail {
    .init(id: id, body: "Consistent spacing across compact and expanded History. Workspace actions stay visible, with room for service status and repository details.\n\nValidated in light and dark appearance.", headRefName: "feature/workspace-layout", baseRefName: "main", headRefOid: "sample-commit", state: "OPEN", isDraft: false, author: .init(login: "alex"), mergeable: "MERGEABLE", reviewDecision: "APPROVED", reviews: .init(nodes: [], totalCount: 0), comments: .init(nodes: [], totalCount: 0))
  }
  func files(repository: String, number: Int, page: Int) async throws -> [PullRequestFile] { [] }
  func star(repository: GitHubRepository, starred: Bool) async throws { throw GitHubPRError.message("Promo fixtures are read-only") }
  func review(request: PullRequest, detail: PullRequestDetail, login: String, event: PRReviewEvent, body: String) async throws { throw GitHubPRError.message("Promo fixtures are read-only") }
}
