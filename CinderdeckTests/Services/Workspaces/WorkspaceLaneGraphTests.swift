import XCTest
@testable import Cinderdeck

@MainActor
final class WorkspaceLaneGraphTests: XCTestCase {
  private let root = URL(fileURLWithPath: "/tmp/lane-map-tests")
  private func file(_ id: String, source: String? = nil) -> StackDefinitionFile {
    let path = root.appendingPathComponent(id + ".toml")
    var definition = StackDefinition(id: id, name: id, file: path, root: root.appendingPathComponent(id), shell: "/bin/sh")
    if let source {
      definition.lane = .init(sourceStackID: source, name: "feature/\(id)", owner: .user,
        createdAt: Date(), directory: definition.root, ports: [:])
    }
    return .init(id: id, file: path, definition: definition)
  }
  private func service(_ id: String, dependencies: [String] = []) -> ServiceDefinition {
    .init(id: id, command: "run \(id)", directory: root, dependencies: dependencies)
  }
  private func graph(_ files: [StackDefinitionFile], states: [String: StackRuntimeState] = [:], runs: [WorkspaceRun] = []) -> WorkspaceLaneGraph {
    .init(workspaceID: "shop", files: files, navigation: .init(files: files, lanesDirectory: root.appendingPathComponent("lanes")),
      states: states, statuses: [:], runs: runs)
  }

  func testLaneHighlightFollowsSharedAndTransitiveDependenciesWithoutSelectingSibling() {
    var base = file("shop")
    base.definition?.services = [service("db", dependencies: ["infra:cache"])]
    base.definition?.links = [.init(id: "infra:cache", stack: "infra", service: "cache", shared: false)]
    var infra = file("infra")
    infra.definition?.services = [service("cache")]
    var first = file("first", source: "shop")
    first.definition?.services = [service("web", dependencies: ["db"])]
    first.definition?.links = [.init(id: "db", stack: "shop", service: "db", shared: true)]
    var second = file("second", source: "shop")
    second.definition?.services = [service("web", dependencies: ["db"])]
    second.definition?.links = first.definition!.links
    let result = graph([base, first, second, infra])
    XCTAssertEqual(result.nodes.filter { $0.id == .service("shop", "db") }.count, 1)
    let connected = result.connected(to: .lane("first"))
    XCTAssertEqual(connected, [.lane("first"), .service("first", "web"), .service("shop", "db"), .service("infra", "cache")])
    XCTAssertFalse(connected.contains(.lane("second")))
    XCTAssertFalse(connected.contains(.service("second", "web")))
    XCTAssertTrue(result.edges.contains { $0.from == .service("first", "web") && $0.to == .service("shop", "db") })
  }

  func testActiveRunShowsStepsProcessIdentityAndRequiredServicesOnlyWhileActive() {
    var base = file("shop")
    base.definition?.services = [service("api")]
    base.definition?.tasks = [.init(id: "test", name: "Test", command: "run test", directory: root, requiresServices: ["api"])]
    let step = WorkspaceRunStep(reference: "task:test", title: "Tests", command: "run test", status: .running,
      process: .init(pid: 123, pgid: 123, startTime: 1))
    var run = WorkspaceRun(workspaceID: "shop", workspaceName: "Shop", definitionID: "verify", name: "Verify", kind: .workflow,
      status: .running, actor: .user, steps: [step, .init(reference: "stop:api", title: "Stop API")])
    let result = graph([base], runs: [run])
    XCTAssertTrue(result.nodes.contains { $0.id == .step(step.id) && $0.detail.contains("PID 123") })
    XCTAssertTrue(result.edges.contains { $0.from == .step(step.id) && $0.to == .service("shop", "api") })
    XCTAssertTrue(result.edges.contains { $0.from == .step(step.id) && $0.to == .step(run.steps[1].id) && $0.kind == .sequence })
    XCTAssertTrue(result.connected(to: .lane("shop")).contains(.step(step.id)))
    run.status = .succeeded
    XCTAssertFalse(graph([base], runs: [run]).nodes.contains { $0.id == .run(run.id) })
  }

  func testLiveLaunchKeepsRemovedServicesAndTheirOriginalDependenciesVisible() {
    var base = file("shop")
    let original = service("removed", dependencies: ["old-db"])
    base.definition?.services = [service("old-db"), original]
    let launch = StackLaunchDefinition(stack: base.definition!, service: original)
    base.definition?.services = []
    let state = StackRuntimeState(services: ["removed": .init(phase: .ready, process: .init(pid: 42, pgid: 42, startTime: 1), launchDefinition: launch)])
    let result = graph([base], states: ["shop": state])
    XCTAssertTrue(result.nodes.contains { $0.id == .service("shop", "removed") && $0.detail.contains("PID 42") && $0.isActive })
    XCTAssertTrue(result.connected(to: .lane("shop")).contains(.service("shop", "old-db")))
  }

  func testBrokenLaneAndMissingDependencyStayInspectableAndCyclesTerminate() {
    var base = file("shop")
    base.definition?.services = [service("api", dependencies: ["worker", "missing"]), service("worker", dependencies: ["api"])]
    var broken = file("broken", source: "shop")
    broken.savedLane = broken.lane
    broken.definition = nil
    broken.issues = [.init(severity: .error, message: "Worktree missing")]
    let result = graph([base, broken])
    XCTAssertTrue(result.nodes.contains { $0.id == .lane("broken") && $0.status == "Needs attention" })
    XCTAssertTrue(result.nodes.contains { $0.id == .service("shop", "missing") && $0.status == "Unavailable" })
    XCTAssertEqual(result.connected(to: .lane("shop")).count, 4)
    let layout = WorkspaceLaneMapLayout(graph: result)
    XCTAssertEqual(layout.frames.count, result.nodes.count)
    for (id, frame) in layout.frames {
      XCTAssertTrue(frame.minX.isFinite && frame.minY.isFinite)
      XCTAssertFalse(layout.frames.contains { $0.key != id && $0.value.intersects(frame) })
    }
  }

  func testBranchesUseCurrentRepositoryStatusNotLaneNameAndLabelFallbacks() {
    var lane = file("first", source: "shop")
    let path = root.appendingPathComponent("app")
    let shared = root.appendingPathComponent("shared")
    lane.definition?.repos = [.init(id: "app", path: path), .init(id: "shared", path: shared, laneMode: .shared)]
    lane.laneWorktrees = [.init(source: root, path: path, branch: "saved-branch")]
    let current = WorkspaceLaneGraph.branchSummary(lane, statuses: [path: .init(branch: "changed-branch"), shared: .init(branch: "(detached)", oid: "123456789")])
    XCTAssertEqual(current, "app: changed-branch\nshared: Detached 1234567")
    let fallback = WorkspaceLaneGraph.branchSummary(lane, statuses: [:])
    XCTAssertTrue(fallback.contains("saved-branch (last known)"))
    XCTAssertTrue(fallback.contains("shared: Loading branch…"))
    XCTAssertFalse(fallback.contains("feature/first"))
  }
}
