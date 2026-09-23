import XCTest
@testable import Cinderdeck

@MainActor
final class PRViewControlTests: XCTestCase {
  private var defaults: UserDefaults!
  private var suite: String!
  private var store: PRViewStore!
  private var control: PRViewControlService!
  private var account = "reviewer"

  override func setUp() async throws {
    suite = "PRViewControlTests-\(UUID().uuidString)"
    defaults = UserDefaults(suiteName: suite)!
    store = PRViewStore(defaults: defaults)
    account = "reviewer"
    control = PRViewControlService(store: store, currentHost: { "github.com" }, viewer: { [unowned self] _ in self.account })
  }

  override func tearDown() async throws {
    defaults.removePersistentDomain(forName: suite)
    control = nil; store = nil; defaults = nil
  }

  private func call(_ command: String, _ params: [String: JSONValue] = [:]) async throws -> JSONValue {
    try await control.handle("prs.views.\(command)", params: .object(params))
  }

  private func upsert(_ id: String, filters: [String: JSONValue] = [:], select: Bool = false) async throws -> JSONValue {
    try await call("upsert", ["account": .string(account), "id": .string(id), "name": .string(" \(id) "), "filters": .object(filters), "select": .bool(select)])
  }

  func testCreatePatchAndRetryPreserveOtherFieldsAndRestoreExistingFormat() async throws {
    _ = try await upsert("team-reviews", filters: ["repository": .string("team/project"), "role": .string("review"),
      "advanced": .bool(true), "text": .string("is:open author:@me")], select: true)
    let patch: [String: JSONValue] = ["account": .string("REVIEWER"), "id": .string("team-reviews"), "name": .string("Renamed")]
    _ = try await call("upsert", patch)
    let result = try await call("upsert", patch)
    XCTAssertEqual(result["views"]?.arrayValue?.count, 5)
    XCTAssertEqual(result["query"]?.stringValue, "is:pr repo:team/project review-requested:reviewer is:open author:reviewer sort:updated-desc")
    let restored = try PRViewStore(defaults: defaults).load(account: "Reviewer")
    XCTAssertEqual(restored.customViews[0].name, "Renamed")
    XCTAssertEqual(restored.customViews[0].filters.repository, "team/project")
    XCTAssertEqual(restored.selectedViewID, "team-reviews")
    XCTAssertEqual(restored.filters, restored.customViews[0].filters)
    XCTAssertNotNil(defaults.data(forKey: "github.prs.github.com.reviewer.v2"))
  }

  func testAccountChangesAndMissingAccountDoNotMutatePreferences() async throws {
    _ = try await upsert("mine")
    let before = defaults.data(forKey: "github.prs.github.com.reviewer.v2")
    account = "other"
    for params: [String: JSONValue] in [["account": .string("reviewer"), "id": .string("mine")], ["id": .string("mine")]] {
      do { _ = try await call("delete", params); XCTFail("Must reject account mismatch or missing account") }
      catch let error as StackControlError { XCTAssertTrue(["account_changed", "invalid_params"].contains(error.code)) }
    }
    XCTAssertEqual(defaults.data(forKey: "github.prs.github.com.reviewer.v2"), before)
    XCTAssertNil(defaults.data(forKey: "github.prs.github.com.other.v2"))
    let result = try await call("list")
    XCTAssertEqual(result["views"]?.arrayValue?.count, 4)
    XCTAssertEqual(result["account"]?.stringValue, "other")
  }

  func testReorderRequiresCompleteUniqueIDsAndKeepsBuiltIns() async throws {
    _ = try await upsert("one"); _ = try await upsert("two")
    for ids in [["one"], ["one", "one"], ["active", "two"], ["one", "two", "extra"]] {
      do { _ = try await call("reorder", ["account": .string(account), "ids": .array(ids.map(JSONValue.string))]); XCTFail("Must reject incomplete order") }
      catch {}
      XCTAssertEqual(try store.load(account: account).customViews.map(\.id), ["one", "two"])
    }
    let result = try await call("reorder", ["account": .string(account), "ids": .array([.string("two"), .string("one")])])
    XCTAssertEqual(result["views"]?.arrayValue?.compactMap { $0["id"]?.stringValue }, ["all", "active", "reviews", "done", "two", "one"])
  }

  func testBuiltInsProtectedAndSelectionRetainsRepository() async throws {
    _ = try await upsert("mine", filters: ["repository": .string("team/project")], select: true)
    _ = try await call("select", ["account": .string(account), "id": .string("done")])
    XCTAssertEqual(try store.load(account: account).filters, PRFilters(repository: "team/project", state: .merged))
    for command in ["upsert", "delete"] {
      do { _ = try await call(command, ["account": .string(account), "id": .string("done"), "name": .string("Changed")].filter { command == "upsert" || $0.key != "name" }); XCTFail("Must protect built-ins") }
      catch {}
    }
    XCTAssertEqual(try store.load(account: account).views[3].name, "Done")
  }

  func testDeleteActiveViewFallsBackAndIsSafeToRepeat() async throws {
    _ = try await upsert("mine", filters: ["repository": .string("team/project"), "state": .string("merged")], select: true)
    for _ in 0..<2 { _ = try await call("delete", ["account": .string(account), "id": .string("mine")]) }
    let value = try store.load(account: account)
    XCTAssertEqual(value.selectedViewID, "active")
    XCTAssertEqual(value.filters, PRFilters(repository: "team/project"))
    XCTAssertTrue(value.customViews.isEmpty)
  }

  func testPartialUpdatePreservesUnsavedFiltersUnlessExplicitlySelected() async throws {
    _ = try await upsert("mine", select: true)
    try store.saveWorkspace(account: account, filters: .init(text: "unsaved"), selectedViewID: "mine")
    _ = try await call("upsert", ["account": .string(account), "id": .string("mine"), "filters": .object(["state": .string("merged")])])
    XCTAssertEqual(try store.load(account: account).filters.text, "unsaved")
    _ = try await call("select", ["account": .string(account), "id": .string("mine")])
    XCTAssertEqual(try store.load(account: account).filters.state, .merged)
    XCTAssertEqual(try store.load(account: account).filters.text, "")
  }

  func testInvalidInputLeavesStoredBytesUnchanged() async throws {
    _ = try await upsert("mine")
    let before = defaults.data(forKey: "github.prs.github.com.reviewer.v2")
    let invalid: [[String: JSONValue]] = [
      ["filters": .object(["state": .string("typo")])], ["filters": .object(["advanced": .string("true")])],
      ["filters": .object(["repository": .string("not-a-repo")])], ["filters": .object(["lable": .string("bug")])],
      ["filters": .null], ["select": .number(1)], ["name": .string("  ")], ["name": .string(String(repeating: "x", count: 41))],
      ["id": .string("bad/id")], ["id": .number(3)], ["name": .bool(true)], ["unknown": .bool(true)],
    ]
    for patch in invalid {
      let params = ["account": JSONValue.string(account), "id": .string("mine")].merging(patch) { _, new in new }
      do { _ = try await call("upsert", params); XCTFail("Must reject \(patch)") }
      catch let error as StackControlError { XCTAssertEqual(error.code, "invalid_params") }
      XCTAssertEqual(defaults.data(forKey: "github.prs.github.com.reviewer.v2"), before)
    }
  }

  func testRepositoryNullAndEmptyTextClearSavedFilters() async throws {
    _ = try await upsert("mine", filters: ["repository": .string("team/project"), "text": .string("label:bug"), "advanced": .bool(true)])
    _ = try await call("upsert", ["account": .string(account), "id": .string("mine"), "filters": .object(["repository": .null, "text": .string(""), "advanced": .bool(false)])])
    XCTAssertEqual(try store.load(account: account).customViews[0].filters, PRFilters())
  }

  func testMalformedPersistedDataIsNeverOverwritten() async throws {
    let data = Data("broken".utf8)
    defaults.set(data, forKey: "github.prs.github.com.reviewer.v2")
    do { _ = try await upsert("new"); XCTFail("Must preserve unreadable data") }
    catch let error as StackControlError { XCTAssertEqual(error.code, "invalid_configuration") }
    XCTAssertEqual(defaults.data(forKey: "github.prs.github.com.reviewer.v2"), data)
  }

  func testCLIAndMCPUseSameContract() async throws {
    let request = try PRViewsCLI.request(["views", "upsert", "mine", "--account", account, "--name=My reviews", "--repo", "team/project", "--query", "is:open author:@me", "--select", "--json"])
    let cliResult = try await control.handle(request.method, params: .object(request.params))
    let (method, params, _) = try StackMCPServer.request(for: "list_pr_views", [:])
    let mcpResult = try await control.handle(method, params: .object(params))
    XCTAssertEqual(cliResult, mcpResult)
    let descriptions = StackMCPServer.toolDescriptions.filter { $0["name"]?.stringValue?.contains("pr_view") == true }
    XCTAssertEqual(descriptions.count, 5)
    for description in descriptions {
      let name = try XCTUnwrap(description["name"]?.stringValue)
      let (method, _, _) = try StackMCPServer.request(for: name, [:])
      XCTAssertTrue(method.hasPrefix("prs.views."))
      XCTAssertEqual(description["annotations"]?["readOnlyHint"]?.boolValue, name == "list_pr_views")
    }
  }

  func testCLIRejectsTyposMissingValuesAndConflictingOptions() {
    for arguments in [
      ["views", "upsert", "mine", "--name"], ["views", "upsert", "mine", "--acount", "reviewer"],
      ["views", "upsert", "mine"], ["views", "select", "one", "two", "--account", "reviewer"],
      ["views", "list", "--query", "ignored"], ["views", "upsert", "mine", "--account", "reviewer", "--query=x", "--text=y"],
      ["views", "upsert", "mine", "--account", "reviewer", "--repo=a/b", "--my-work"],
    ] { XCTAssertThrowsError(try PRViewsCLI.request(arguments), arguments.joined(separator: " ")) }
  }

  func testEveryCLIActionUsesSharedStoreIncludingOrganizationAndHost() async throws {
    var verifiedHosts: [String] = []
    let control = PRViewControlService(store: store, currentHost: { "github.com" }, viewer: { host in
      verifiedHosts.append(host)
      return "reviewer"
    })
    func cli(_ args: [String]) async throws -> JSONValue {
      let request = try PRViewsCLI.request(["views"] + args + ["--host", "github.company.test", "--account", "reviewer"])
      return try await control.handle(request.method, params: .object(request.params))
    }
    _ = try await cli(["upsert", "one", "--name", "Organization", "--org", "team", "--select"])
    _ = try await cli(["upsert", "one", "--query", "is:merged", "--sort", "newest"])
    _ = try await cli(["upsert", "two", "--name", "Second"])
    let reordered = try await cli(["reorder", "two", "one"])
    XCTAssertEqual(reordered["views"]?.arrayValue?.suffix(2).compactMap { $0["id"]?.stringValue }, ["two", "one"])
    let selected = try await cli(["select", "one"])
    XCTAssertEqual(selected["query"]?.stringValue, "is:pr org:team is:merged sort:created-desc")
    _ = try await cli(["select", "reviews"])
    XCTAssertEqual(try store.load(account: account, hostname: "github.company.test").filters.organization, "team")
    _ = try await cli(["select", "one"])
    _ = try await cli(["delete", "one"])
    let listed = try await cli(["list"])
    XCTAssertEqual(listed["selectedViewID"]?.stringValue, "active")
    XCTAssertEqual(listed["filters"]?["organization"]?.stringValue, "team")
    XCTAssertEqual(listed["hostname"]?.stringValue, "github.company.test")
    XCTAssertEqual(listed["views"]?.arrayValue?.count, 5)
    XCTAssertTrue(verifiedHosts.allSatisfy { $0 == "github.company.test" })
    XCTAssertTrue(try store.load(account: account).customViews.isEmpty)
  }

  func testChangingSelectedHostDuringIdentityLookupDoesNotWrite() async throws {
    var host = "github.com"
    let control = PRViewControlService(store: store, currentHost: { host }, viewer: { _ in
      host = "github.company.test"
      return "reviewer"
    })
    do {
      _ = try await control.handle("prs.views.upsert", params: .object(["account": .string(account), "id": .string("mine"), "name": .string("Mine")]))
      XCTFail("Must reject a host switch during account lookup")
    } catch let error as StackControlError { XCTAssertEqual(error.code, "host_changed") }
    XCTAssertNil(defaults.data(forKey: "github.prs.github.com.reviewer.v2"))
    XCTAssertNil(defaults.data(forKey: "github.prs.github.company.test.reviewer.v2"))
  }

  func testHostAndOrganizationValidationCannotOverwritePreferences() async throws {
    _ = try await upsert("mine")
    let before = defaults.data(forKey: "github.prs.github.com.reviewer.v2")
    for patch: [String: JSONValue] in [
      ["hostname": .string("https://github.com")],
      ["filters": .object(["organization": .string("team/project")])],
    ] {
      let params = ["account": JSONValue.string(account), "id": .string("mine")].merging(patch) { _, new in new }
      do { _ = try await call("upsert", params); XCTFail("Must reject invalid host or organization") }
      catch let error as StackControlError { XCTAssertEqual(error.code, "invalid_params") }
      XCTAssertEqual(defaults.data(forKey: "github.prs.github.com.reviewer.v2"), before)
    }
  }

  func testLocalSocketRoundTripPersistsCLIRequest() async throws {
    let path = "/tmp/pr-views-\(UUID().uuidString.prefix(8)).sock"
    let control = self.control!
    let server = StackControlSocketServer(path: path) { data, _ in
      let request = try! StackControlCoding.decoder().decode(StackControlRequest.self, from: data)
      var response = StackControlResponse(id: request.id)
      do { response.result = try await control.handle(request.method, params: request.params ?? .object([:])) }
      catch { response.error = (error as? StackControlError) ?? .invalid(error.localizedDescription) }
      return try! StackControlCoding.encoder().encode(response)
    }
    try server.start()
    defer { server.stop() }
    let result = try await Task.detached {
      let request = try PRViewsCLI.request(["views", "upsert", "socket-view", "--account", "reviewer", "--name", "Socket view", "--role", "review", "--select"])
      let connection = try StackControlConnection(path: path, client: request.client)
      return try connection.call(request.method, request.params, timeout: 5)
    }.value
    XCTAssertEqual(result["selectedViewID"]?.stringValue, "socket-view")
    XCTAssertEqual(try store.load(account: account).customViews[0].filters.role, .review)
  }
}
