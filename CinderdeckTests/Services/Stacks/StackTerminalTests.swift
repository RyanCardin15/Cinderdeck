import AppKit
import XCTest
@testable import Cinderdeck

@MainActor
final class StackTerminalTests: XCTestCase {
  private var root: URL!
  private var supervisor: StackSupervisor!

  override func setUp() async throws {
    root = try StackTestSupport.temporaryDirectory()
    let defaults = UserDefaults(suiteName: "StackTerminalTests-\(UUID().uuidString)")!
    defaults.set(root.path, forKey: PreferencesKeys.stacksDirectory)
    defaults.set(false, forKey: PreferencesKeys.stacksNotifyOnCrash)
    let pool = try DatabaseManager.openDatabase(at: root.appendingPathComponent("runs.db")).dbPool
    supervisor = StackSupervisor(store: StackRunStore(pool: pool), defaults: defaults, logRoot: root.appendingPathComponent("logs"),
      environment: { _ in ProcessInfo.processInfo.environment })
    for stack in ["alpha", "beta"] {
      try """
        name = "\(stack) stack"
        [services.api]
        cmd = "echo READY-\(stack)-api; exec /bin/sleep 60"
        ready.log = "READY"
        [services.web]
        cmd = "echo READY-\(stack)-web; exec /bin/sleep 60"
        ready.log = "READY"
        """.write(to: root.appendingPathComponent("\(stack).toml"), atomically: true, encoding: .utf8)
    }
    await supervisor.reloadDefinitions()
    XCTAssertTrue(supervisor.files.allSatisfy { $0.definition != nil })
  }

  override func tearDown() async throws {
    await supervisor.stopAll()
    await supervisor.shutdownMonitoring()
    try? FileManager.default.removeItem(at: root)
    supervisor = nil
  }

  func testTerminalsKeepIndependentStackAndServiceOutput() async throws {
    let alpha = StackConsoleViewModel(file: try file("alpha"), supervisor: supervisor)
    let beta = StackConsoleViewModel(file: try file("beta"), supervisor: supervisor)
    defer { alpha.stop(); beta.stop() }
    await supervisor.start(stack: "alpha")
    await supervisor.start(stack: "beta")
    alpha.start(service: "api")
    beta.start(service: "web")
    try await waitFor { !alpha.logLines.isEmpty && !beta.logLines.isEmpty }
    XCTAssertTrue(alpha.logLines.allSatisfy { $0.text.contains("alpha-api") })
    XCTAssertTrue(beta.logLines.allSatisfy { $0.text.contains("beta-web") })

    // Rapid switching must not let an older asynchronous fetch replace the final selection.
    alpha.selectService("web")
    alpha.selectService(nil)
    alpha.selectService("api")
    try await waitFor { !alpha.logLines.isEmpty }
    XCTAssertTrue(alpha.logLines.allSatisfy { $0.service == "api" && $0.text.contains("alpha-api") })
    XCTAssertEqual(beta.logService, "web")
    XCTAssertEqual(beta.stackName, "beta stack")
    XCTAssertTrue(beta.logLines.allSatisfy { $0.text.contains("beta-web") })

    alpha.selectService(nil)
    try await waitFor { Set(alpha.logLines.map(\.service)) == ["api", "web"] }
  }

  func testWindowIsClosedUntilRequestedAndClosingPreservesRunningService() async throws {
    let controller = StackTerminalWindowController(file: try file("alpha"), supervisor: supervisor)
    defer { controller.close() }
    XCTAssertFalse(try XCTUnwrap(controller.window).isVisible)
    XCTAssertFalse(try XCTUnwrap(controller.window).isRestorable)
    await supervisor.start(stack: "alpha", services: ["api"])
    controller.show(service: "api")
    try await waitFor { !controller.viewModel.logLines.isEmpty }
    XCTAssertTrue(try XCTUnwrap(controller.window).isVisible)
    XCTAssertEqual(controller.viewModel.logService, "api")
    let identity = try XCTUnwrap(supervisor.runtime("alpha", "api").process)
    var closed = false
    controller.onClose = { closed = true }
    controller.close()
    XCTAssertTrue(closed)
    XCTAssertFalse(try XCTUnwrap(controller.window).isVisible)
    XCTAssertTrue(identity.matchesLiveProcess)
    XCTAssertEqual(supervisor.runtime("alpha", "api").process, identity)
  }

  private func file(_ id: String) throws -> StackDefinitionFile {
    try XCTUnwrap(supervisor.files.first { $0.id == id })
  }

  private func waitFor(_ condition: () -> Bool) async throws {
    for _ in 0..<100 {
      if condition() { return }
      try await Task.sleep(nanoseconds: 50_000_000)
    }
    XCTFail("Terminal output did not arrive")
    throw StackError.message("Terminal output did not arrive")
  }
}
