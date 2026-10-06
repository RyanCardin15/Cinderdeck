import XCTest
@testable import Cinderdeck

final class CinderdeckRuntimeProtocolTests: XCTestCase {
  func testLaneCreationRequiresAnExactWorkspaceAndAcceptsNoCommandOrMode() throws {
    XCTAssertEqual(try CinderdeckRuntimeUIRequest.decode(Data(#"{"surface":"workspace-lane-create","workspaceID":"fixture"}"#.utf8)).workspaceID, "fixture")
    for input in [
      #"{"surface":"workspace-lane-create"}"#,
      #"{"surface":"workspace-lane-create","workspaceID":"fixture","mode":"create"}"#,
      #"{"surface":"workspace-lane-create","workspaceID":"fixture","command":"git"}"#,
    ] { XCTAssertThrowsError(try CinderdeckRuntimeUIRequest.decode(Data(input.utf8))) }
  }
  func testWorkspaceDeletionOpensScopedEditorAndRejectsArbitraryModesOrCommands() throws {
    let request = try CinderdeckRuntimeUIRequest.decode(Data(#"{"surface":"workspace-editor","workspaceID":"fixture","mode":"delete"}"#.utf8))
    XCTAssertEqual(request.mode, "delete")
    XCTAssertEqual(request.workspaceID, "fixture")
    for input in [
      #"{"surface":"workspace-editor","mode":"delete"}"#,
      #"{"surface":"workspace-editor","workspaceID":"fixture","mode":"erase-files"}"#,
      #"{"surface":"workspace-editor","workspaceID":"fixture","mode":"delete","command":"rm"}"#,
    ] {
      XCTAssertThrowsError(try CinderdeckRuntimeUIRequest.decode(Data(input.utf8)), input)
    }
  }
  func testAgentAccessOpensWithoutWorkspaceOrMode() throws {
    let request = try CinderdeckRuntimeUIRequest.decode(Data(#"{"surface":"agent-access"}"#.utf8))
    XCTAssertEqual(request.surface, "agent-access")
    XCTAssertNil(request.workspaceID)
    XCTAssertNil(request.mode)
  }

  func testAgentAccessRefusesScopeAndArbitraryCommands() {
    for input in [
      #"{"surface":"agent-access","workspaceID":"fixture"}"#,
      #"{"surface":"agent-access","mode":"install"}"#,
      #"{"surface":"agent-access","command":"install"}"#,
    ] {
      XCTAssertThrowsError(try CinderdeckRuntimeUIRequest.decode(Data(input.utf8)), input)
    }
  }
  func testWorkspaceTerminalRequiresExactScopeAndDoesNotAcceptCommands() throws {
    let request = try CinderdeckRuntimeUIRequest.decode(Data(#"{"surface":"workspace-terminal","workspaceID":"fixture"}"#.utf8))
    XCTAssertEqual(request.workspaceID, "fixture")
    for input in [
      #"{"surface":"workspace-terminal"}"#,
      #"{"surface":"workspace-terminal","workspaceID":"fixture","mode":"shell"}"#,
      #"{"surface":"workspace-terminal","workspaceID":"fixture","command":"run"}"#,
    ] {
      XCTAssertThrowsError(try CinderdeckRuntimeUIRequest.decode(Data(input.utf8)), input)
    }
  }

  func testWorkspaceBranchesRequireExactScopeAndNoModeOrCommands() throws {
    let request = try CinderdeckRuntimeUIRequest.decode(Data(#"{"surface":"workspace-branches","workspaceID":"fixture-lane"}"#.utf8))
    XCTAssertEqual(request.workspaceID, "fixture-lane")
    for input in [
      #"{"surface":"workspace-branches"}"#,
      #"{"surface":"workspace-branches","workspaceID":"fixture","mode":"main"}"#,
      #"{"surface":"workspace-branches","workspaceID":"fixture","command":"git checkout main"}"#,
    ] {
      XCTAssertThrowsError(try CinderdeckRuntimeUIRequest.decode(Data(input.utf8)), input)
    }
  }

}
