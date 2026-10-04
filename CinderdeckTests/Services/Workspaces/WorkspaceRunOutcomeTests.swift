import Foundation
import XCTest
@testable import Cinderdeck

@MainActor
final class WorkspaceRunOutcomeTests: XCTestCase {
  private let authority = WorkspaceRunAuthority(installationID: "native", workspaceID: "lane", generation: 3)
  private func failedRun() -> WorkspaceRun {
    var run = WorkspaceRun(workspaceID: "lane", workspaceName: "Lane", definitionID: "verify", name: "Verify", kind: .task, actor: .user,
      steps: [WorkspaceRunStep(reference: "task:verify", title: "Verify", command: "test exact command", directory: "/fixture")])
    run.status = .failed; run.finishedAt = Date(timeIntervalSince1970: 10)
    run.steps[0].status = .failed; run.steps[0].exitCode = 17
    run.integrationAuthority = authority
    run.sourceProvenance = .init(schemaVersion: 1, definitionHash: "definition", workflowHash: "workflow")
    return run
  }
  func testResolutionRequiresActualSuccessExplicitLineageDefinitionAndExactAuthority() {
    let failure = failedRun()
    var rerun = failure; rerun.id = UUID(); rerun.rerunOfID = failure.id
    rerun.status = .succeeded; rerun.finishedAt = Date(timeIntervalSince1970: 20)
    rerun.steps[0].status = .succeeded; rerun.steps[0].exitCode = 0
    XCTAssertTrue(WorkspaceRunOutcome.resolves(rerun, failure: failure, authority: authority))
    var changed = rerun; changed.status = .running
    XCTAssertFalse(WorkspaceRunOutcome.resolves(changed, failure: failure, authority: authority))
    changed = rerun; changed.rerunOfID = nil
    XCTAssertFalse(WorkspaceRunOutcome.resolves(changed, failure: failure, authority: authority))
    changed = rerun; changed.integrationAuthority = .init(installationID: "native", workspaceID: "lane", generation: 4)
    XCTAssertFalse(WorkspaceRunOutcome.resolves(changed, failure: failure, authority: authority))
    changed = rerun; changed.sourceProvenance = .init(schemaVersion: 1, definitionHash: "changed", workflowHash: "workflow")
    XCTAssertFalse(WorkspaceRunOutcome.resolves(changed, failure: failure, authority: authority))
    changed = rerun; changed.sourceProvenance = .init(schemaVersion: 1, definitionHash: "definition", workflowHash: "changed")
    XCTAssertFalse(WorkspaceRunOutcome.resolves(changed, failure: failure, authority: authority))
    var legacy = failure; legacy.integrationAuthority = nil
    XCTAssertFalse(WorkspaceRunOutcome.resolves(rerun, failure: legacy, authority: authority))
  }
  func testOutcomeHashIncludesEverySavedStepAndSurvivesDurableReload() throws {
    var run = failedRun()
    let hash = WorkspaceRunOutcome.digest(run)
    run.steps.append(WorkspaceRunStep(reference: "task:second", title: "Second"))
    XCTAssertNotEqual(hash, WorkspaceRunOutcome.digest(run))
    let second = WorkspaceRunOutcome.digest(run)
    run.steps[1].exitCode = 19
    XCTAssertNotEqual(second, WorkspaceRunOutcome.digest(run))
    run.outcomeHash = WorkspaceRunOutcome.digest(run); run.rerunOfID = UUID()
    let reloaded = try JSONDecoder().decode(WorkspaceRun.self, from: JSONEncoder().encode(run))
    XCTAssertEqual(reloaded.rerunOfID, run.rerunOfID)
    XCTAssertEqual(reloaded.integrationAuthority, authority)
    XCTAssertEqual(reloaded.outcomeHash, WorkspaceRunOutcome.digest(reloaded))
  }
}
