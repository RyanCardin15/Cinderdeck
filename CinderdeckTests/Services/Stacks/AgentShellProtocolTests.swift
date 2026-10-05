import XCTest
@testable import Cinderdeck

final class AgentShellProtocolTests: XCTestCase {
  func testAgentAccessOpensWithoutWorkspaceOrMode() throws {
    let request = try AgentShellUIRequest.decode(Data(#"{"surface":"agent-access"}"#.utf8))
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
      XCTAssertThrowsError(try AgentShellUIRequest.decode(Data(input.utf8)), input)
    }
  }
  func testWorkspaceTerminalRequiresExactScopeAndDoesNotAcceptCommands() throws {
    let request = try AgentShellUIRequest.decode(Data(#"{"surface":"workspace-terminal","workspaceID":"fixture"}"#.utf8))
    XCTAssertEqual(request.workspaceID, "fixture")
    for input in [
      #"{"surface":"workspace-terminal"}"#,
      #"{"surface":"workspace-terminal","workspaceID":"fixture","mode":"shell"}"#,
      #"{"surface":"workspace-terminal","workspaceID":"fixture","command":"run"}"#,
    ] {
      XCTAssertThrowsError(try AgentShellUIRequest.decode(Data(input.utf8)), input)
    }
  }

}
