import XCTest
@testable import Cinderdeck

@MainActor
final class PullRequestsTests: XCTestCase {
  func testQueriesScopeInboxAndRepositoryWithoutHidingOtherAuthors() {
    XCTAssertEqual(PRFilters().query(login: "ryan"), "is:pr involves:ryan is:open sort:updated-desc")
    let all = PRFilters(repository: "team/project", state: .all)
    XCTAssertEqual(all.query(login: "ryan"), "is:pr repo:team/project sort:updated-desc")
    let review = PRFilters(role: .review)
    XCTAssertEqual(review.query(login: "ryan"), "is:pr review-requested:ryan is:open sort:updated-desc")
    XCTAssertEqual(PRFilters(state: .closed).query(login: "ryan"), "is:pr involves:ryan is:closed is:unmerged sort:updated-desc")
  }

  func testSimpleSearchQuotesTextAndQueryModePreservesQualifiers() {
    let simple = PRFilters(text: "fix is:closed", label: "needs review")
    XCTAssertTrue(simple.query(login: "ryan").contains(#""fix is:closed""#))
    XCTAssertTrue(simple.query(login: "ryan").contains(#"label:"needs review""#))
    let advanced = PRFilters(repository: "team/project", text: "is:merged author:@me", advanced: true)
    let query = advanced.query(login: "ryan")
    XCTAssertTrue(query.contains("is:merged author:ryan"))
    XCTAssertFalse(query.contains("is:open"))
    XCTAssertTrue(query.contains("repo:team/project"))
  }

  func testReviewValidationRejectsSelfReviewDraftAndEmptyFeedback() {
    var detail = PRFixtures.detail
    XCTAssertNotNil(PRReviewEvent.approve.validation(detail: detail, login: "AUTHOR", body: ""))
    XCTAssertNil(PRReviewEvent.comment.validation(detail: detail, login: "author", body: "A note"))
    XCTAssertNotNil(PRReviewEvent.requestChanges.validation(detail: detail, login: "reviewer", body: " \n"))
    XCTAssertNil(PRReviewEvent.approve.validation(detail: detail, login: "reviewer", body: ""))
    detail.isDraft = true
    XCTAssertNotNil(PRReviewEvent.approve.validation(detail: detail, login: "reviewer", body: ""))
    detail.state = "CLOSED"
    XCTAssertNotNil(PRReviewEvent.comment.validation(detail: detail, login: "reviewer", body: "Comment"))
  }

  func testReviewPostsExactReviewedCommitAndEventOnce() async throws {
    var writes: [[String: Any]] = []
    let service = GitHubPRService { args, payload in
      let input = try XCTUnwrap(payload)
      let json = try XCTUnwrap(JSONSerialization.jsonObject(with: input) as? [String: Any])
      if args.first == "graphql" {
        if (json["query"] as? String)?.contains("viewer { login }") == true { return Data(#"{"data":{"viewer":{"login":"reviewer"}}}"#.utf8) }
        return try PRFixtures.envelope(PRFixtures.detail)
      }
      XCTAssertEqual(args, ["repos/team/project/pulls/7/reviews", "--method", "POST"])
      writes.append(json)
      return Data(#"{"id":101,"commit_id":"reviewed-sha","state":"APPROVED"}"#.utf8)
    }
    try await service.review(request: PRFixtures.request, detail: PRFixtures.detail, login: "reviewer", event: .approve, body: "Looks good")
    XCTAssertEqual(writes.count, 1)
    XCTAssertEqual(writes.first?["commit_id"] as? String, "reviewed-sha")
    XCTAssertEqual(writes.first?["event"] as? String, "APPROVE")
    XCTAssertEqual(writes.first?["body"] as? String, "Looks good")
  }

  func testNewCommitsAndAccountChangesPreventReviewMutation() async throws {
    for accountChanged in [false, true] {
      var writes = 0
      let service = GitHubPRService { args, payload in
        if args.first != "graphql" { writes += 1; return Data() }
        let input = try XCTUnwrap(payload)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: input) as? [String: Any])
        if (json["query"] as? String)?.contains("viewer { login }") == true {
          return Data("{\"data\":{\"viewer\":{\"login\":\"\(accountChanged ? "different-account" : "reviewer")\"}}}".utf8)
        }
        var changed = PRFixtures.detail; changed.headRefOid = "new-sha"
        return try PRFixtures.envelope(changed)
      }
      do {
        try await service.review(request: PRFixtures.request, detail: PRFixtures.detail, login: "reviewer", event: .approve, body: "")
        XCTFail("Must reject stale review")
      } catch {
        XCTAssertTrue(error.localizedDescription.contains(accountChanged ? "account changed" : "New commits"))
      }
      XCTAssertEqual(writes, 0)
    }
  }

  func testPartialGraphQLErrorsAreNotDisplayedAsSuccess() async {
    let service = GitHubPRService { _, _ in Data(#"{"data":{"viewer":{"login":"reviewer"}},"errors":[{"message":"Rate limit exceeded"}]}"#.utf8) }
    do { _ = try await service.viewer(); XCTFail("Must surface error") }
    catch { XCTAssertEqual(error.localizedDescription, "Rate limit exceeded") }
  }

  func testRepositoryStarsOnlyChangeAfterServerSuccess() async throws {
    let service = PRMockService()
    let model = makeModel(service: service)
    await model.connect()
    XCTAssertEqual(model.repositories.count, 1)
    service.failStar = true
    await model.toggleStar(PRFixtures.repository)
    XCTAssertFalse(model.repositories[0].viewerHasStarred)
    XCTAssertNotNil(model.error)
    service.failStar = false
    await model.toggleStar(PRFixtures.repository)
    XCTAssertTrue(model.repositories[0].viewerHasStarred)
  }

  func testSavedViewsRestorePerAccountAndBuiltInsKeepRepositoryScope() async {
    let service = PRMockService()
    let defaults = temporaryDefaults()
    let model = PullRequestsViewModel(service: service, defaults: defaults)
    await model.connect()
    model.filters = .init(repository: "team/project", state: .draft, role: .author, text: "test")
    XCTAssertTrue(model.saveView(name: " My queue "))
    XCTAssertEqual(model.customViews.first?.name, "My queue")
    let restored = PullRequestsViewModel(service: service, defaults: defaults)
    await restored.connect()
    XCTAssertEqual(restored.filters, model.filters)
    XCTAssertEqual(restored.customViews.count, 1)
    restored.selectView(PRSavedView.defaults[0])
    XCTAssertEqual(restored.filters.repository, "team/project")
    XCTAssertEqual(restored.filters.state, .all)
    service.account = "another-user"
    await restored.connect()
    XCTAssertTrue(restored.customViews.isEmpty)
    XCTAssertNil(restored.filters.repository)
  }

  func testAgentChangesUpdateOpenWindowAndUIChangesRemainVisibleToAgents() async throws {
    let defaults = temporaryDefaults()
    let store = PRViewStore(defaults: defaults)
    let model = PullRequestsViewModel(service: PRMockService(), viewStore: store)
    let control = PRViewControlService(store: store, viewer: { "reviewer" })
    await model.connect()
    _ = try await control.handle("prs.views.upsert", params: .object([
      "account": .string("reviewer"), "id": .string("agent-view"), "name": .string("Agent view"),
      "filters": .object(["text": .string("latest")]), "select": .bool(true),
    ]))
    XCTAssertEqual(model.customViews.map(\.id), ["agent-view"])
    XCTAssertEqual(model.selectedViewID, "agent-view")
    XCTAssertEqual(model.filters.text, "latest")
    try await Task.sleep(nanoseconds: 50_000_000)
    XCTAssertEqual(model.requests.first?.title, "latest")

    model.filters.label = "UI edit"
    _ = try await control.handle("prs.views.upsert", params: .object([
      "account": .string("reviewer"), "id": .string("agent-view"),
      "filters": .object(["sort": .string("newest")]),
    ]))
    XCTAssertEqual(model.filters.label, "UI edit", "Agent edits must preserve filters even before a debounced search")
    XCTAssertEqual(model.filters.sort, .updated)
    XCTAssertEqual(model.customViews.first?.filters.sort, .newest)
    XCTAssertTrue(model.saveView(name: "Updated in UI", replacing: "agent-view"))
    let result = try await control.handle("prs.views.list", params: .object([:]))
    XCTAssertEqual(result["views"]?.arrayValue?.last?["name"]?.stringValue, "Updated in UI")
    XCTAssertEqual(result["filters"]?["label"]?.stringValue, "UI edit")
    try store.upsert(account: "another-user", view: .init(id: "other", name: "Other", filters: .init()), select: true)
    XCTAssertEqual(model.selectedViewID, "agent-view")
    model.deleteView(try XCTUnwrap(model.customViews.first))
    XCTAssertEqual(try store.load(account: "reviewer").customViews.count, 0)
    XCTAssertEqual(model.selectedViewID, "active")
  }

  func testExistingSavedViewPreferencesRemainCompatible() async throws {
    let defaults = temporaryDefaults()
    let json = #"{"customViews":[{"id":"old-id","name":"Existing tab","filters":{"repository":"team/project","state":"Draft","role":"Created by me","sort":"Newest first","text":"fix","label":"bug","advanced":false}}],"filters":{"repository":"team/project","state":"Draft","role":"Created by me","sort":"Newest first","text":"fix","label":"bug","advanced":false},"selectedViewID":"old-id"}"#
    defaults.set(Data(json.utf8), forKey: "github.prs.reviewer.v1")
    let model = PullRequestsViewModel(service: PRMockService(), defaults: defaults)
    await model.connect()
    XCTAssertEqual(model.selectedViewID, "old-id")
    XCTAssertEqual(model.customViews.first?.name, "Existing tab")
    XCTAssertEqual(model.filters, .init(repository: "team/project", state: .draft, role: .author, sort: .newest, text: "fix", label: "bug"))
  }

  func testOutOfOrderSearchAndDetailCannotReplaceCurrentSelection() async throws {
    let service = PRMockService()
    let model = makeModel(service: service)
    await model.connect()
    model.filters.text = "slow"
    model.scheduleSearch(immediate: true)
    try await Task.sleep(nanoseconds: 20_000_000)
    model.filters.text = "latest"
    model.scheduleSearch(immediate: true)
    try await Task.sleep(nanoseconds: 160_000_000)
    XCTAssertEqual(model.requests.first?.title, "latest")
    model.select("slow-detail")
    model.select("latest-detail")
    try await Task.sleep(nanoseconds: 160_000_000)
    XCTAssertEqual(model.detail?.id, "latest-detail")
  }

  func testPaginationDeduplicatesAndPreservesTotalCount() async throws {
    let service = PRMockService()
    service.paginate = true
    let model = makeModel(service: service)
    await model.connect()
    try await Task.sleep(nanoseconds: 30_000_000)
    XCTAssertTrue(model.canLoadMore)
    await model.loadMore()
    XCTAssertEqual(model.requests.map(\.id), ["PR-7", "PR-8"])
    XCTAssertFalse(model.canLoadMore)
    XCTAssertEqual(model.totalCount, 2)
  }

  func testFailedReconnectClearsCancelledSearchLoadingState() async throws {
    let service = PRMockService()
    let model = makeModel(service: service)
    await model.connect()
    model.filters.text = "slow"
    model.scheduleSearch(immediate: true)
    try await Task.sleep(nanoseconds: 20_000_000)
    XCTAssertTrue(model.loading)

    service.failViewer = true
    await model.connect()
    XCTAssertFalse(model.loading)
    XCTAssertFalse(model.connecting)
    XCTAssertFalse(model.loadingRepositories)
    XCTAssertNotNil(model.error)
    try await Task.sleep(nanoseconds: 120_000_000)
    XCTAssertTrue(model.requests.isEmpty)
    XCTAssertFalse(model.loading)
  }

  func testFilePaginationAndStarMutationUseExplicitTargets() async throws {
    var commands: [[String]] = []
    let service = GitHubPRService { args, payload in
      commands.append(args)
      if args.first == "graphql" {
        let input = try XCTUnwrap(payload)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: input) as? [String: Any])
        XCTAssertTrue((json["query"] as? String)?.contains("addStar") == true)
        XCTAssertEqual((json["variables"] as? [String: String])?["id"], "R-1")
        return Data(#"{"data":{"update":{"starrable":{"viewerHasStarred":true}}}}"#.utf8)
      }
      return Data(#"[{"filename":"File.swift","status":"modified","additions":2,"deletions":1,"patch":"@@ -1 +1 @@"}]"#.utf8)
    }
    let files = try await service.files(repository: "team/project", number: 7, page: 2)
    XCTAssertEqual(files.first?.filename, "File.swift")
    XCTAssertEqual(commands.first, ["repos/team/project/pulls/7/files?per_page=100&page=2"])
    try await service.star(repository: PRFixtures.repository, starred: true)
    XCTAssertEqual(commands.count, 2)
  }

  func testChangedAccountCannotStarFromPreviousWorkspace() async {
    let service = PRMockService()
    let model = makeModel(service: service)
    await model.connect()
    service.account = "other-person"
    await model.toggleStar(PRFixtures.repository)
    XCTAssertFalse(model.repositories[0].viewerHasStarred)
    XCTAssertTrue(model.error?.contains("account changed") == true)
  }

  func testDeepLinkAndMenuEntryExposeWorkspace() {
    XCTAssertEqual(CinderdeckDeepLinkAction(url: URL(string: "cinderdeck://prs")!), .pullRequests)
    XCTAssertEqual(MenuBarItemKind.pullRequests.group, .tools)
    XCTAssertTrue(GitHubPRService.validRepository("team/my-project"))
    XCTAssertFalse(GitHubPRService.validRepository("team/project?bad=true"))
    XCTAssertFalse(GitHubPRService.validRepository("team/project/../../"))
  }

  private func makeModel(service: PRMockService) -> PullRequestsViewModel { .init(service: service, defaults: temporaryDefaults()) }
  private func temporaryDefaults() -> UserDefaults {
    let name = "CinderdeckPRTests-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: name)!
    addTeardownBlock { defaults.removePersistentDomain(forName: name) }
    return defaults
  }
}

@MainActor
private final class PRMockService: GitHubPRServing {
  var account = "reviewer"
  var failStar = false
  var failViewer = false
  var paginate = false
  func viewer() async throws -> String {
    if failViewer { throw GitHubPRError.message("Could not connect") }
    return account
  }
  func repositories(after: String?) async throws -> GitHubConnection<GitHubRepository> {
    .init(nodes: [PRFixtures.repository], pageInfo: .init(hasNextPage: false), totalCount: 1)
  }
  func search(_ query: String, after: String?) async throws -> PullRequestSearchPage {
    if query.contains("slow") { try? await Task.sleep(nanoseconds: 100_000_000) }
    var request = PRFixtures.request
    if query.contains("latest") { request.title = "latest" }
    else if query.contains("slow") { request.title = "slow" }
    var requests = [request]
    if after != nil { var second = request; second.id = "PR-8"; second.number = 8; requests.append(second) }
    return .init(requests: requests, count: paginate ? 2 : 1, pageInfo: .init(hasNextPage: paginate && after == nil, endCursor: after == nil ? "page2" : nil))
  }
  func detail(id: String) async throws -> PullRequestDetail {
    if id == "slow-detail" { try? await Task.sleep(nanoseconds: 100_000_000) }
    var detail = PRFixtures.detail; detail.id = id; return detail
  }
  func files(repository: String, number: Int, page: Int) async throws -> [PullRequestFile] { [] }
  func star(repository: GitHubRepository, starred: Bool) async throws {
    if failStar { throw GitHubPRError.message("No permission") }
  }
  func review(request: PullRequest, detail: PullRequestDetail, login: String, event: PRReviewEvent, body: String) async throws {}
}

@MainActor
private enum PRFixtures {
  static var repository: GitHubRepository { .init(id: "R-1", nameWithOwner: "team/project", isPrivate: true, isArchived: false, viewerHasStarred: false, url: "https://github.com/team/project") }
  static var request: PullRequest {
    .init(id: "PR-7", number: 7, title: "A pull request", url: "https://github.com/team/project/pull/7", state: "OPEN", isDraft: false,
      author: .init(login: "author"), repository: .init(nameWithOwner: "team/project"), updatedAt: Date(), additions: 10, deletions: 2, changedFiles: 1,
      labels: .init(nodes: []), commits: .init(nodes: []))
  }
  static var detail: PullRequestDetail {
    .init(id: "PR-7", body: "Details", headRefName: "feature", baseRefName: "main", headRefOid: "reviewed-sha", state: "OPEN", isDraft: false,
      author: .init(login: "author"), mergeable: "MERGEABLE", reviews: .init(nodes: [], totalCount: 0), comments: .init(nodes: [], totalCount: 0))
  }
  static func envelope(_ detail: PullRequestDetail) throws -> Data {
    let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .iso8601
    let object = try JSONSerialization.jsonObject(with: encoder.encode(detail))
    return try JSONSerialization.data(withJSONObject: ["data": ["node": object]])
  }
}
