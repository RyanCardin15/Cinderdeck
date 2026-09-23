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

  func testWarmTabsAndCustomQueriesOpenImmediatelyWithoutAnotherRequest() async throws {
    let service = PRMockService()
    let defaults = temporaryDefaults()
    let setup = PullRequestsViewModel(service: service, defaults: defaults)
    await setup.connect()
    setup.filters = .init(text: "label:urgent", advanced: true)
    XCTAssertTrue(setup.saveView(name: "Urgent"))
    setup.selectView(PRSavedView.defaults[1])
    let model = PullRequestsViewModel(service: service, defaults: defaults)
    await model.connect()
    try await eventually { Set(service.searchQueries).count >= 5 }
    try await Task.sleep(nanoseconds: 30_000_000)
    let count = service.searchQueries.count
    for view in model.views {
      model.selectView(view)
      XCTAssertFalse(model.loading, view.name)
      XCTAssertFalse(model.requests.isEmpty, view.name)
    }
    XCTAssertEqual(service.searchQueries.count, count)
  }

  func testCacheJoinsInFlightRequestAndLimitsParallelSearches() async throws {
    let service = PRMockService(); service.searchDelay = 80_000_000
    let cache = PRSearchCache()
    let first = Task { try await cache.load("same", service: service) }
    let second = Task { try await cache.load("same", service: service) }
    _ = try await first.value; _ = try await second.value
    XCTAssertEqual(service.searchQueries, ["same"])
    let tasks = (0..<10).map { index in Task { try await cache.load("query-\(index)", service: service) } }
    for task in tasks { _ = try await task.value }
    XCTAssertEqual(service.maximumConcurrentSearches, 3)
  }

  func testStaleRefreshKeepsResultsAndTimestampOnFailure() async throws {
    var clock = Date()
    let cache = PRSearchCache(now: { clock })
    let service = PRMockService()
    let model = PullRequestsViewModel(service: service, defaults: temporaryDefaults(), cache: cache)
    await model.connect()
    try await eventually { !model.loading }
    let updated = model.lastUpdated
    clock = clock.addingTimeInterval(61)
    service.failSearch = true; service.searchDelay = 30_000_000
    model.scheduleSearch(immediate: true)
    XCTAssertTrue(model.loading)
    XCTAssertEqual(model.requests.first?.id, "PR-7")
    try await eventually { !model.loading }
    XCTAssertEqual(model.requests.first?.id, "PR-7")
    XCTAssertEqual(model.lastUpdated, updated)
    XCTAssertTrue(model.error?.contains("previously loaded") == true)
  }

  func testCachedPaginationRestoresAllLoadedRows() async throws {
    let service = PRMockService(); service.paginate = true
    let model = makeModel(service: service)
    await model.connect()
    try await eventually { !model.loading }
    await model.loadMore()
    model.selectView(PRSavedView.defaults[2])
    model.selectView(PRSavedView.defaults[1])
    XCTAssertEqual(model.requests.map(\.id), ["PR-7", "PR-8"])
    XCTAssertFalse(model.canLoadMore)
  }

  func testOrganizationSelectionLoadsEveryPageAndKeepsScopeAcrossBuiltIns() async throws {
    let service = PRMockService(); service.organizationPagination = true
    let model = makeModel(service: service)
    await model.connect()
    XCTAssertEqual(model.organizations, ["other-team", "team"])
    model.selectRepository("team/project")
    model.selectOrganization("other-team")
    XCTAssertNil(model.filters.repository)
    try await eventually { !model.loadingSelectedOrganization }
    XCTAssertEqual(model.visibleRepositories.map(\.nameWithOwner).sorted(), ["other-team/one", "other-team/two"])
    XCTAssertEqual(service.organizationCursors, [nil, "next"])
    XCTAssertTrue(model.query.contains("org:other-team"))
    XCTAssertFalse(model.query.contains("involves:"))
    model.selectView(PRSavedView.defaults[2])
    XCTAssertEqual(model.filters.organization, "other-team")
    XCTAssertTrue(model.query.contains("review-requested:reviewer"))
    model.selectRepository(nil)
    XCTAssertNil(model.filters.organization)
  }

  func testDiscoveryFailureDoesNotMakeSuccessfulSearchLookEmptyOrFailed() async throws {
    let service = PRMockService(); service.failRepositories = true
    let model = makeModel(service: service)
    await model.connect()
    try await eventually { !model.loading }
    XCTAssertNil(model.error)
    XCTAssertNotNil(model.repositoryError)
    XCTAssertFalse(model.requests.isEmpty)
  }

  func testSameLoginOnDifferentHostsHasSeparateViewsAndNoCachedRows() async throws {
    let service = PRMockService()
    let model = makeModel(service: service)
    await model.connect()
    try await eventually { !model.loading }
    model.filters.text = "personal"
    XCTAssertTrue(model.saveView(name: "Personal"))
    service.searchDelay = 80_000_000
    await model.connect(hostname: "github.company.test")
    XCTAssertEqual(model.hostname, "github.company.test")
    XCTAssertTrue(model.customViews.isEmpty)
    XCTAssertTrue(model.requests.isEmpty)
    model.filters.text = "enterprise"
    XCTAssertTrue(model.saveView(name: "Enterprise"))
    await model.connect(hostname: "github.com")
    XCTAssertEqual(model.customViews.map(\.name), ["Personal"])
    XCTAssertEqual(model.filters.text, "personal")
  }

  func testManualRefreshBypassesFreshCache() async throws {
    let service = PRMockService()
    let model = makeModel(service: service)
    await model.connect()
    try await eventually { !model.loading }
    let query = model.query
    let count = service.searchQueries.filter { $0 == query }.count
    model.scheduleSearch(immediate: true, force: true)
    try await eventually { !model.loading }
    XCTAssertEqual(service.searchQueries.filter { $0 == query }.count, count + 1)
  }

  func testTimeoutRetriesOnceWithSmallerPageButRateLimitDoesNotRetry() async throws {
    for message in ["GitHub query timed out", "API rate limit exceeded", "Command timed out after 45 seconds", "Query timed out: rate limit exceeded"] {
      var sizes: [Int] = []
      let service = GitHubPRService { _, payload in
        let input = try XCTUnwrap(payload)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: input) as? [String: Any])
        let variables = try XCTUnwrap(json["variables"] as? [String: Any])
        sizes.append(try XCTUnwrap(variables["first"] as? Int))
        throw GitHubPRError.message(message)
      }
      do { _ = try await service.search("is:pr", after: "cursor"); XCTFail("Expected failure") }
      catch { XCTAssertEqual(error.localizedDescription, message) }
      XCTAssertEqual(sizes, message == "GitHub query timed out" ? [25, 10] : [25])
    }
  }

  func testRepositoryDiscoveryIncludesOwnerAffiliationsAndOrganizationCursor() async throws {
    let service = GitHubPRService { _, payload in
      let input = try XCTUnwrap(payload)
      let json = try XCTUnwrap(JSONSerialization.jsonObject(with: input) as? [String: Any])
      let query = try XCTUnwrap(json["query"] as? String)
      let variables = try XCTUnwrap(json["variables"] as? [String: Any])
      if query.contains("organization(login:") {
        XCTAssertEqual(variables["organization"] as? String, "other-team")
        XCTAssertEqual(variables["after"] as? String, "next")
        return Data(#"{"data":{"organization":{"repositories":{"nodes":[],"pageInfo":{"hasNextPage":false}}}}}"#.utf8)
      }
      XCTAssertTrue(query.contains("ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]"))
      return Data(#"{"data":{"viewer":{"repositories":{"nodes":[],"pageInfo":{"hasNextPage":false}}}}}"#.utf8)
    }
    _ = try await service.repositories(after: nil)
    _ = try await service.repositories(organization: "other-team", after: "next")
  }

  func testCacheResetPreventsLateResultsFromReappearing() async throws {
    let service = PRMockService()
    let cache = PRSearchCache()
    let task = Task { try await cache.load("slow", service: service) }
    try await Task.sleep(nanoseconds: 10_000_000)
    cache.reset()
    do { _ = try await task.value; XCTFail("Cancelled data must not reappear") }
    catch { XCTAssertTrue(error is CancellationError) }
    XCTAssertNil(cache.entry(for: "slow"))
  }

  func testBackgroundSearchFailureDoesNotReplaceSelectedResults() async throws {
    let service = PRMockService()
    service.failedQuery = "review-requested:"
    let model = makeModel(service: service)
    await model.connect()
    try await eventually { service.searchQueries.contains { $0.contains("review-requested:") } }
    try await Task.sleep(nanoseconds: 30_000_000)
    XCTAssertNil(model.error)
    XCTAssertFalse(model.loading)
    XCTAssertEqual(model.requests.first?.id, "PR-7")
    model.selectView(PRSavedView.defaults[2])
    try await eventually { !model.loading }
    XCTAssertNotNil(model.error)
    XCTAssertTrue(model.requests.isEmpty)
  }

  func testOrganizationsIncludeOutsideCollaborationsButExcludePersonalOwners() async {
    let service = PRMockService()
    var organizationRepo = PRFixtures.repository
    organizationRepo.id = "outside"; organizationRepo.nameWithOwner = "outside-org/repo"
    organizationRepo.ownerAccount = .init(kind: "Organization")
    var personalRepo = PRFixtures.repository
    personalRepo.id = "person"; personalRepo.nameWithOwner = "someone-else/repo"
    personalRepo.ownerAccount = .init(kind: "User")
    service.extraRepositories = [organizationRepo, personalRepo]
    let model = makeModel(service: service)
    await model.connect()
    XCTAssertEqual(model.availableOrganizations, ["outside-org", "team"])
  }

  private func eventually(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
    let deadline = Date().addingTimeInterval(3)
    while !condition(), Date() < deadline { try await Task.sleep(nanoseconds: 10_000_000) }
    XCTAssertTrue(condition(), file: file, line: line)
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
  var hostname = "github.com"
  var searchQueries: [String] = []
  var searchDelay: UInt64 = 0
  var failSearch = false
  var failedQuery: String?
  var extraRepositories: [GitHubRepository] = []
  var failRepositories = false
  var activeSearches = 0
  var maximumConcurrentSearches = 0
  var organizationPagination = false
  var organizationCursors: [String?] = []
  func organizations(after: String?) async throws -> GitHubConnection<GitHubActor> {
    if organizationPagination {
      return .init(nodes: [.init(login: after == nil ? "team" : "other-team")], pageInfo: .init(hasNextPage: after == nil, endCursor: after == nil ? "next" : nil))
    }
    return .init(nodes: [.init(login: "team")], pageInfo: .init(hasNextPage: false))
  }
  func repositories(organization: String, after: String?) async throws -> GitHubConnection<GitHubRepository> {
    if organizationPagination {
      organizationCursors.append(after)
      var repo = PRFixtures.repository
      repo.id = after ?? "first"
      repo.nameWithOwner = "\(organization)/\(after == nil ? "one" : "two")"
      return .init(nodes: [repo], pageInfo: .init(hasNextPage: after == nil, endCursor: after == nil ? "next" : nil))
    }
    return try await repositories(after: after)
  }
  var account = "reviewer"
  var failStar = false
  var failViewer = false
  var paginate = false
  func viewer() async throws -> String {
    if failViewer { throw GitHubPRError.message("Could not connect") }
    return account
  }
  func repositories(after: String?) async throws -> GitHubConnection<GitHubRepository> {
    if failRepositories { throw GitHubPRError.message("Repository access failed") }
    return .init(nodes: [PRFixtures.repository] + extraRepositories, pageInfo: .init(hasNextPage: false), totalCount: 1)
  }
  func search(_ query: String, after: String?) async throws -> PullRequestSearchPage {
    searchQueries.append(query)
    activeSearches += 1; maximumConcurrentSearches = max(maximumConcurrentSearches, activeSearches)
    defer { activeSearches -= 1 }
    if searchDelay > 0 { try await Task.sleep(nanoseconds: searchDelay) }
    if failSearch || failedQuery.map({ query.contains($0) }) == true { throw GitHubPRError.message("Network unavailable") }
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
