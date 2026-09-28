import CoreGraphics
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
    XCTAssertTrue(result.nodes.first { $0.id == .step(step.id) }!.hasLiveActivity)
    XCTAssertFalse(result.nodes.first { $0.id == .step(run.steps[1].id) }!.hasLiveActivity)
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

  func testConsumerTraceAndFocusKeepOnlyTheSelectedRelationship() {
    var base = file("shop")
    base.definition?.services = [service("db"), service("unrelated")]
    var first = file("first", source: "shop")
    first.definition?.services = [service("api", dependencies: ["db"])]
    first.definition?.links = [.init(id: "db", stack: "shop", service: "db", shared: true)]
    var second = file("second", source: "shop")
    second.definition?.services = [service("web", dependencies: ["db"])]
    second.definition?.links = first.definition!.links
    let result = graph([base, first, second])
    let consumers = result.traced(from: .service("shop", "db"), direction: .consumers)
    XCTAssertTrue(consumers.isSuperset(of: [.lane("shop"), .lane("first"), .lane("second"), .service("first", "api"), .service("second", "web")]))
    XCTAssertFalse(consumers.contains(.service("shop", "unrelated")))
    var simplified = result
    simplified.edges = result.diagramEdges
    for lane in ["shop", "first", "second"] {
      XCTAssertEqual(simplified.connected(to: .lane(lane)), result.connected(to: .lane(lane)))
    }
    XCTAssertLessThan(simplified.edges.count, result.edges.count)
    let focused = result.focused(on: .lane("first"))
    XCTAssertEqual(Set(focused.nodes.map(\.id)), [.lane("first"), .service("first", "api"), .service("shop", "db")])
    XCTAssertEqual(focused.sharedServices.map(\.id), [.service("shop", "db")])
    XCTAssertTrue(focused.edges.allSatisfy { edge in
      focused.nodes.contains { $0.id == edge.from } && focused.nodes.contains { $0.id == edge.to }
    })
    XCTAssertEqual(result.focused(on: .lane("removed")).nodes.count, result.nodes.count)
  }

  func testLiveProcessFactsSearchAndAttentionUseActualRuntime() {
    var base = file("shop")
    var api = service("api")
    api.port = 4321
    base.definition?.services = [api]
    let runtime = StackServiceRuntime(phase: .unhealthy, process: .init(pid: 9876, pgid: 9876, startTime: 1),
      detail: "Readiness failed", bindWarning: "Unexpected listener")
    let result = graph([base], states: ["shop": .init(services: ["api": runtime])])
    XCTAssertEqual(result.processCount, 1)
    let node = result.nodes.first { $0.id == .service("shop", "api") }!
    XCTAssertTrue(node.needsAttention)
    XCTAssertEqual(node.endpoint?.port, 4321)
    XCTAssertEqual(node.command, "run api")
    XCTAssertEqual(node.warning, "Unexpected listener")
    XCTAssertTrue(result.nodes.first { $0.id == .lane("shop") }!.isActive)
    XCTAssertEqual(result.matches(" 9876 ").map(\.id), [node.id])
    XCTAssertEqual(result.matches("4321").map(\.id), [node.id])
    XCTAssertEqual(result.matches("RUN API").map(\.id), [node.id])
    XCTAssertTrue(result.matches(" ").isEmpty)
  }

  func testLongWorkflowGrowsVerticallyWithoutMovingSharedServicesFartherRight() {
    var base = file("shop")
    base.definition?.services = [service("db")]
    var lane = file("first", source: "shop")
    lane.definition?.services = [service("api", dependencies: ["db"])]
    lane.definition?.links = [.init(id: "db", stack: "shop", service: "db", shared: true)]
    lane.definition?.tasks = [.init(id: "test", name: "Test", command: "test", directory: root, requiresServices: ["api"])]
    var run = WorkspaceRun(workspaceID: "first", workspaceName: "First", definitionID: "check", name: "Check", kind: .workflow,
      status: .running, actor: .user, steps: [.init(reference: "task:test", title: "Test", status: .running)])
    let short = WorkspaceLaneMapLayout(graph: graph([base, lane], runs: [run]))
    run.steps += (0..<20).map { _ in WorkspaceRunStep(reference: "task:test", title: "Test") }
    let longGraph = graph([base, lane], runs: [run])
    let long = WorkspaceLaneMapLayout(graph: longGraph)
    XCTAssertEqual(short.size.width, long.size.width)
    XCTAssertGreaterThan(long.size.height, short.size.height)
    XCTAssertEqual(long.frames.count, longGraph.nodes.count)
    XCTAssertEqual(long.frames[.service("shop", "db")]?.minX, short.frames[.service("shop", "db")]?.minX)
    XCTAssertEqual(long.bands.filter(\.shared).count, 1)
    for (id, frame) in long.frames {
      XCTAssertFalse(long.frames.contains { $0.key != id && $0.value.intersects(frame) })
      XCTAssertTrue(CGRect(origin: .zero, size: long.size).contains(frame))
    }
  }

  func testConnectionRoutesMeetCardBoundariesForVerticalAndReverseEdges() {
    let start = CGRect(x: 300, y: 100, width: 224, height: 128)
    let below = CGRect(x: 300, y: 280, width: 224, height: 128)
    let vertical = WorkspaceMapRoute(start: start, end: below)
    XCTAssertEqual(vertical.from.y, start.maxY)
    XCTAssertEqual(vertical.to.y, below.minY - 5)
    XCTAssertEqual(vertical.point(at: 0), vertical.from)
    XCTAssertEqual(vertical.point(at: 1), vertical.to)
    let left = CGRect(x: 16, y: 40, width: 224, height: 128)
    let reverse = WorkspaceMapRoute(start: start, end: left)
    XCTAssertEqual(reverse.from.x, start.minX)
    XCTAssertEqual(reverse.to.x, left.maxX + 5)
    XCTAssertTrue(reverse.point(at: 0.5).x.isFinite)
  }

}
