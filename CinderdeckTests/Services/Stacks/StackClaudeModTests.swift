import XCTest
@testable import Cinderdeck

final class StackClaudeModTests: XCTestCase {
  private var home: URL!

  override func setUpWithError() throws {
    home = FileManager.default.temporaryDirectory.appendingPathComponent("ClaudeMod-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    if let home { try? FileManager.default.removeItem(at: home) }
  }

  func testAppShipsTheModAsAPluginFolder() throws {
    let mod = try XCTUnwrap(StackClaudeMod.bundled())
    XCTAssertEqual(mod.entry, ".claude-plugin/plugin.json")
    XCTAssertTrue(FileManager.default.fileExists(atPath: mod.folder.appendingPathComponent("hooks/register.tsx").path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: mod.folder.appendingPathComponent(".claude-plugin/types").path),
      "Engine-written types are regenerated per load and must not ship")
  }

  func testInstallsIntoClaudeCodePluginFolderAndKeepsAPersonsOwnCopy() throws {
    XCTAssertEqual(StackClaudeMod.state(home: home), .missing)
    _ = try StackClaudeMod.install(home: home)
    let installed = home.appendingPathComponent(".claude/skills/cinderdeck")
    XCTAssertTrue(FileManager.default.fileExists(atPath: installed.appendingPathComponent(".claude-plugin/plugin.json").path))
    XCTAssertEqual(StackClaudeMod.state(home: home), .current(installed))

    try FileManager.default.removeItem(at: installed.appendingPathComponent(StackAgentSkills.markerName))
    XCTAssertEqual(StackClaudeMod.state(home: home), .userManaged(installed))
    XCTAssertTrue(try StackClaudeMod.install(home: home).contains("kept yours"))
  }

  func testReadsWhichAgentsAlreadyHaveTheMCPServer() throws {
    let support = home.appendingPathComponent("Library/Application Support")
    XCTAssertFalse(StackAgentSetup.isConfigured("claude", home: home, support: support))

    try #"{"mcpServers":{"cinderdeck":{"command":"cinderdeck","args":["mcp"]}}}"#
      .write(to: home.appendingPathComponent(".claude.json"), atomically: true, encoding: .utf8)
    try FileManager.default.createDirectory(at: home.appendingPathComponent(".codex"), withIntermediateDirectories: true)
    try "model = \"o3\"\n\n[mcp_servers.cinderdeck]\ncommand = \"cinderdeck\"\n"
      .write(to: home.appendingPathComponent(".codex/config.toml"), atomically: true, encoding: .utf8)
    let vscode = support.appendingPathComponent("Code - Insiders/User")
    try FileManager.default.createDirectory(at: vscode, withIntermediateDirectories: true)
    try "{ // comments are allowed\n \"servers\": { \"cinderdeck\": { \"type\": \"stdio\" } } }"
      .write(to: vscode.appendingPathComponent("mcp.json"), atomically: true, encoding: .utf8)

    XCTAssertTrue(StackAgentSetup.isConfigured("claude", home: home, support: support))
    XCTAssertTrue(StackAgentSetup.isConfigured("codex", home: home, support: support))
    XCTAssertTrue(StackAgentSetup.isConfigured("copilot", home: home, support: support))
    XCTAssertFalse(StackAgentSetup.isConfigured("cursor", home: home, support: support))
  }

  func testSummarizesSkillsForSettings() {
    let url = home.appendingPathComponent(".claude/skills/one")
    XCTAssertEqual(IntegrationAgentAccess.summarize([.missing, .missing], folder: ".claude/skills").state, "missing")
    XCTAssertEqual(IntegrationAgentAccess.summarize([.current(url), .missing], folder: ".claude/skills").state, "partial")
    XCTAssertEqual(IntegrationAgentAccess.summarize([.current(url), .outdated(url)], folder: ".claude/skills").state, "outdated")
    XCTAssertEqual(IntegrationAgentAccess.summarize([.userManaged(url)], folder: ".claude/skills").state, "yours")
    XCTAssertEqual(IntegrationAgentAccess.summarize([.current(url)], folder: ".claude/skills").state, "current")
  }
}
