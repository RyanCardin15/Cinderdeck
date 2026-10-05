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
}
