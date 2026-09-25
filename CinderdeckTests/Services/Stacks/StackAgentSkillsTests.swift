import XCTest
@testable import Cinderdeck

final class StackAgentSkillsTests: XCTestCase {
  private var root: URL!
  private var home: URL { root.appendingPathComponent("home") }
  private var source: URL { root.appendingPathComponent("skills") }

  override func setUpWithError() throws {
    root = FileManager.default.temporaryDirectory.appendingPathComponent("AgentSkills-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
    try writeSkill("record-it", body: "Record things.")
  }

  override func tearDownWithError() throws {
    if let root { try? FileManager.default.removeItem(at: root) }
  }

  private func writeSkill(_ name: String, body: String) throws {
    let folder = source.appendingPathComponent(name)
    try FileManager.default.createDirectory(at: folder.appendingPathComponent("references"), withIntermediateDirectories: true)
    try "---\nname: \(name)\ndescription: Does a thing. Use it when asked.\n---\n\n\(body)\n"
      .write(to: folder.appendingPathComponent("SKILL.md"), atomically: true, encoding: .utf8)
    try "notes".write(to: folder.appendingPathComponent("references/more.md"), atomically: true, encoding: .utf8)
  }

  private func agent(_ id: String) throws -> StackAgentSkills.Agent { try XCTUnwrap(StackAgentSkills.agent(id)) }

  func testAppShipsTheRepositorySkills() {
    let names = StackAgentSkills.skills().map(\.name)
    XCTAssertTrue(names.contains("cinderdeck-record-session"), "\(names)")
    XCTAssertTrue(names.contains("cinderdeck-parallel-lanes"), "\(names)")
    XCTAssertTrue(names.contains("cinderdeck-review-recording"), "\(names)")
  }

  func testReadsNameAndSummary() throws {
    let skill = try XCTUnwrap(StackAgentSkills.skills(in: source).first)
    XCTAssertEqual(skill.name, "record-it")
    XCTAssertEqual(skill.summary, "Does a thing.")
  }

  func testInstallsUpdatesAndReportsState() throws {
    var skills = StackAgentSkills.skills(in: source)
    let claude = try agent("claude")
    XCTAssertEqual(StackAgentSkills.state(of: skills[0], for: claude, home: home), .missing)

    _ = try StackAgentSkills.install(skills, for: claude, home: home)
    let installed = home.appendingPathComponent(".claude/skills/record-it")
    XCTAssertTrue(FileManager.default.fileExists(atPath: installed.appendingPathComponent("references/more.md").path))
    XCTAssertEqual(StackAgentSkills.state(of: skills[0], for: claude, home: home), .current(installed))

    try writeSkill("record-it", body: "Record things better.")
    skills = StackAgentSkills.skills(in: source)
    XCTAssertEqual(StackAgentSkills.state(of: skills[0], for: claude, home: home), .outdated(installed))
    _ = try StackAgentSkills.install(skills, for: claude, home: home)
    XCTAssertEqual(StackAgentSkills.state(of: skills[0], for: claude, home: home), .current(installed))
    XCTAssertTrue(try String(contentsOf: installed.appendingPathComponent("SKILL.md"), encoding: .utf8).contains("better"))
  }

  func testSharedFoldersAreReusedInsteadOfDuplicated() throws {
    let skills = StackAgentSkills.skills(in: source)
    _ = try StackAgentSkills.install(skills, for: try agent("codex"), home: home)
    let shared = home.appendingPathComponent(".agents/skills/record-it")
    // Cursor and VS Code Copilot read ~/.agents/skills, so Codex's copy already counts for them.
    XCTAssertEqual(StackAgentSkills.state(of: skills[0], for: try agent("cursor"), home: home), .current(shared))
    XCTAssertEqual(StackAgentSkills.state(of: skills[0], for: try agent("copilot"), home: home), .current(shared))
    _ = try StackAgentSkills.install(skills, for: try agent("copilot"), home: home)
    XCTAssertFalse(FileManager.default.fileExists(atPath: home.appendingPathComponent(".copilot/skills/record-it").path))
  }

  func testNeverReplacesSkillsThePersonManages() throws {
    let skills = StackAgentSkills.skills(in: source)
    let folder = home.appendingPathComponent(".claude/skills")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(at: folder.appendingPathComponent("record-it"), withDestinationURL: source.appendingPathComponent("record-it"))
    let claude = try agent("claude")
    XCTAssertEqual(StackAgentSkills.state(of: skills[0], for: claude, home: home), .userManaged(folder.appendingPathComponent("record-it")))
    let notes = try StackAgentSkills.install(skills, for: claude, home: home)
    XCTAssertTrue(notes.first?.contains("kept yours") == true, "\(notes)")
    XCTAssertFalse(FileManager.default.fileExists(atPath: source.appendingPathComponent("record-it/\(StackAgentSkills.markerName)").path),
      "Nothing is written through the link")
  }

  func testCopilotMCPConfigKeepsOtherServers() throws {
    let support = root.appendingPathComponent("Application Support")
    let url = support.appendingPathComponent("Code/User/mcp.json")
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try "{\n  // comment\n  \"servers\": { \"other\": { \"command\": \"x\" } }\n}\n".write(to: url, atomically: true, encoding: .utf8)
    _ = try StackAgentSetup.copilot(command: "/usr/local/bin/cinderdeck", support: support)
    let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    let servers = try XCTUnwrap(object["servers"] as? [String: Any])
    XCTAssertNotNil(servers["other"])
    let cinderdeck = try XCTUnwrap(servers["cinderdeck"] as? [String: Any])
    XCTAssertEqual(cinderdeck["command"] as? String, "/usr/local/bin/cinderdeck")
    XCTAssertEqual(cinderdeck["args"] as? [String], ["mcp"])
  }
}
