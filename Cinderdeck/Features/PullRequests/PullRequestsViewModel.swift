import Combine
import Foundation

@MainActor
final class PullRequestsViewModel: ObservableObject {
  @Published private(set) var hostname: String
  @Published private(set) var organizations: [String] = []
  @Published var repositoryError: String?
  @Published var organizationError: String?
  @Published private(set) var loadingOrganizations = false
  @Published private(set) var loadingSelectedOrganization = false
  @Published private(set) var login: String?
  @Published private(set) var repositories: [GitHubRepository] = []
  @Published private(set) var requests: [PullRequest] = []
  @Published private(set) var totalCount = 0
  @Published private(set) var detail: PullRequestDetail?
  @Published private(set) var files: [PullRequestFile] = []
  @Published private(set) var customViews: [PRSavedView] = []
  @Published var filters = PRFilters() {
    didSet {
      // Persist edits immediately, before an agent can update another tab or
      // the SwiftUI search debounce runs. Applying store changes never echoes.
      if !applyingViewPreferences { savePreferences() }
    }
  }
  @Published var repositorySearch = ""
  @Published var starredOnly = false
  @Published private(set) var selectedViewID = "active"
  @Published private(set) var selectedID: String?
  @Published private(set) var connecting = false
  @Published private(set) var loadingRepositories = false
  @Published private(set) var loading = false
  @Published private(set) var loadingDetail = false
  @Published private(set) var loadingFiles = false
  @Published private(set) var submitting = false
  @Published private(set) var starring: Set<String> = []
  @Published var error: String?
  @Published var detailError: String?
  @Published var notice: String?
  @Published private(set) var lastUpdated: Date?
  @Published private(set) var pageInfo: GitHubPageInfo?
  @Published private(set) var filesHaveMore = false
  private var service: GitHubPRServing
  private let viewStore: PRViewStore
  private var viewSubscription: AnyCancellable?
  private var applyingViewPreferences = false
  private let cache: PRSearchCache
  private var displayedQuery: String?
  private var detailTask: Task<Void, Never>?
  private var discoveryTask: Task<Void, Never>?
  private var organizationTask: Task<Void, Never>?
  private var prefetchTask: Task<Void, Never>?
  private var prefetchVersion = UUID()
  private var loadedOrganizations: Set<String> = []
  private var organizationVersion = UUID()
  private var searchTask: Task<Void, Never>?
  private var searchVersion = UUID()
  private var detailVersion = UUID()
  private var accountVersion = UUID()
  private var filesPage = 0

  init(service: GitHubPRServing? = nil, defaults: UserDefaults? = nil, cache: PRSearchCache? = nil, viewStore: PRViewStore? = nil) {
    self.service = service ?? GitHubPRService()
    self.viewStore = viewStore ?? defaults.map { PRViewStore(defaults: $0) } ?? .shared
    self.hostname = self.service.hostname
    self.cache = cache ?? PRSearchCache()
    viewSubscription = self.viewStore.changes.sink { [weak self] change in
      guard let self, self.login?.lowercased() == change.account, self.hostname == change.hostname else { return }
      let filtersChanged = self.filters != change.preferences.filters
      let organizationChanged = self.filters.organization != change.preferences.filters.organization
      self.apply(change.preferences)
      if organizationChanged { self.reloadOrganization() }
      if filtersChanged { self.scheduleSearch(immediate: true) }
    }
  }
  var views: [PRSavedView] { PRSavedView.defaults + customViews }
  var selectedRequest: PullRequest? { requests.first { $0.id == selectedID } }
  var selectedView: PRSavedView? { views.first { $0.id == selectedViewID } }
  var viewIsModified: Bool {
    guard var saved = selectedView?.filters else { return false }
    if selectedView?.isBuiltIn == true { saved.repository = filters.repository; saved.organization = filters.organization }
    return saved != filters
  }
  var visibleRepositories: [GitHubRepository] { repositoryListing.visible }
  /// The sidebar reads the filtered, sorted repositories several times per render,
  /// and renders on every keystroke and loading flag. Sort once per change instead.
  private struct RepositoryListingKey: Equatable {
    var repositories: [GitHubRepository]
    var organization: String?
    var starredOnly: Bool
    var search: String
    var login: String?
  }
  private var repositoryListingCache: (key: RepositoryListingKey, visible: [GitHubRepository], groups: [RepositoryGroup])?
  private var repositoryListing: (visible: [GitHubRepository], groups: [RepositoryGroup]) {
    let key = RepositoryListingKey(repositories: repositories, organization: filters.organization, starredOnly: starredOnly,
      search: repositorySearch, login: login)
    if let cache = repositoryListingCache, cache.key == key { return (cache.visible, cache.groups) }
    let visible = computeVisibleRepositories()
    let groups = computeRepositoryGroups(visible)
    repositoryListingCache = (key, visible, groups)
    return (visible, groups)
  }
  private func computeVisibleRepositories() -> [GitHubRepository] {
    repositories.filter { (filters.organization == nil || $0.owner.lowercased() == filters.organization?.lowercased()) && (!starredOnly || $0.viewerHasStarred) &&
      (repositorySearch.isEmpty || $0.nameWithOwner.localizedCaseInsensitiveContains(repositorySearch)) }
      .sorted {
        if $0.viewerHasStarred != $1.viewerHasStarred { return $0.viewerHasStarred }
        return $0.nameWithOwner.localizedStandardCompare($1.nameWithOwner) == .orderedAscending
      }
  }
  struct RepositoryGroup: Identifiable {
    var owner: String
    var repositories: [GitHubRepository]
    var id: String { owner }
  }
  var repositoryGroups: [RepositoryGroup] { repositoryListing.groups }
  private func computeRepositoryGroups(_ visible: [GitHubRepository]) -> [RepositoryGroup] {
    Dictionary(grouping: visible, by: \.owner)
      .map { RepositoryGroup(owner: $0.key, repositories: $0.value) }
      .sorted {
        if ($0.owner.lowercased() == login?.lowercased()) != ($1.owner.lowercased() == login?.lowercased()) {
          return $0.owner.lowercased() == login?.lowercased()
        }
        return $0.owner.localizedStandardCompare($1.owner) == .orderedAscending
      }
  }
  var searchLimitReached: Bool { requests.count >= 1000 && totalCount > requests.count }
  var canLoadMore: Bool { pageInfo?.hasNextPage == true && requests.count < 1000 }
  var query: String { filters.query(login: login ?? "") }

  var availableOrganizations: [String] {
    var names = Set(organizations + repositories.filter { $0.ownerAccount?.kind == "Organization" }.map(\.owner))
    if let organization = filters.organization { names.insert(organization) }
    return names.sorted { $0.localizedStandardCompare($1) == .orderedAscending }
  }

  func connect(hostname: String? = nil) async {
    guard !connecting, !submitting, starring.isEmpty else { return }
    if let hostname, GitHubHost.normalized(hostname) == hostname { service.hostname = hostname }
    self.hostname = service.hostname
    connecting = true
    let version = UUID(); accountVersion = version
    searchTask?.cancel(); searchVersion = UUID()
    prefetchTask?.cancel(); prefetchVersion = UUID(); cache.reset()
    discoveryTask?.cancel(); organizationTask?.cancel(); organizationVersion = UUID()
    loading = false; loadingRepositories = false; loadingOrganizations = false; loadingSelectedOrganization = false
    select(nil)
    requests = []; repositories = []; organizations = []; loadedOrganizations = []
    totalCount = 0; pageInfo = nil; displayedQuery = nil
    error = nil; repositoryError = nil; organizationError = nil
    notice = nil; login = nil; lastUpdated = nil
    customViews = []; filters = .init(); selectedViewID = "active"
    repositorySearch = ""; starredOnly = false
    do {
      let viewer = try await service.viewer()
      guard accountVersion == version else { return }
      login = viewer
      restoreViews(login: viewer)
      connecting = false
      scheduleSearch(immediate: true)
      discoveryTask = Task {
        async let memberships: () = discoverOrganizations(version: version)
        await discoverRepositories(version: version)
        await memberships
      }
      await discoveryTask?.value
    } catch {
      guard accountVersion == version else { return }
      connecting = false
      self.error = error.localizedDescription
    }
  }

  private func discoverOrganizations(version: UUID) async {
    loadingOrganizations = true
    defer { if accountVersion == version { loadingOrganizations = false } }
    do {
      var cursor: String?
      repeat {
        try Task.checkCancellation()
        let page = try await service.organizations(after: cursor)
        guard accountVersion == version, !Task.isCancelled else { return }
        organizations = Array(Set(organizations + page.nodes.map(\.login))).sorted()
        cursor = try nextCursor(page.pageInfo, previous: cursor)
      } while cursor != nil
    } catch {
      if accountVersion == version, !Task.isCancelled { organizationError = error.localizedDescription }
    }
  }

  private func discoverRepositories(version: UUID) async {
    loadingRepositories = true
    defer { if accountVersion == version { loadingRepositories = false } }
    do {
      var cursor: String?
      repeat {
        try Task.checkCancellation()
        let page = try await service.repositories(after: cursor)
        guard accountVersion == version, !Task.isCancelled else { return }
        mergeRepositories(page.nodes)
        cursor = try nextCursor(page.pageInfo, previous: cursor)
      } while cursor != nil
    } catch {
      if accountVersion == version, !Task.isCancelled { repositoryError = error.localizedDescription }
    }
  }
  private func nextCursor(_ info: GitHubPageInfo?, previous: String?) throws -> String? {
    guard info?.hasNextPage == true else { return nil }
    guard let cursor = info?.endCursor, cursor != previous else {
      throw GitHubPRError.message("GitHub did not return the next page. Reload to try again.")
    }
    return cursor
  }
  private func mergeRepositories(_ values: [GitHubRepository]) {
    var known = Set(repositories.map(\.id))
    repositories += values.filter { known.insert($0.id).inserted }
  }
  func reloadOrganization() {
    organizationTask?.cancel()
    let version = UUID(); organizationVersion = version
    guard let organization = filters.organization, !loadedOrganizations.contains(organization) else {
      loadingSelectedOrganization = false
      return
    }
    loadingSelectedOrganization = true; repositoryError = nil
    let account = accountVersion
    organizationTask = Task {
      defer { if organizationVersion == version { loadingSelectedOrganization = false } }
      do {
        var cursor: String?
        repeat {
          try Task.checkCancellation()
          let page = try await service.repositories(organization: organization, after: cursor)
          guard accountVersion == account, organizationVersion == version, !Task.isCancelled else { return }
          mergeRepositories(page.nodes)
          cursor = try nextCursor(page.pageInfo, previous: cursor)
        } while cursor != nil
        loadedOrganizations.insert(organization)
      } catch {
        if accountVersion == account, organizationVersion == version, !Task.isCancelled { repositoryError = error.localizedDescription }
      }
    }
  }

  func scheduleSearch(immediate: Bool = false, force: Bool = false) {
    let query = self.query
    // SwiftUI can observe the same change after a tab's immediate search.
    if !force, displayedQuery == query, loading { return }
    prefetchTask?.cancel(); prefetchVersion = UUID()
    searchTask?.cancel()
    searchVersion = UUID()
    let version = searchVersion
    guard login != nil else { loading = false; return }
    let changed = displayedQuery != query
    displayedQuery = query
    if changed { select(nil) }
    error = nil
    savePreferences()
    let cached = cache.entry(for: query)
    if let cached { show(cached) }
    else if changed { requests = []; totalCount = 0; pageInfo = nil; lastUpdated = nil }
    let candidates = prefetchQueries()
    cache.retainRequests(for: Set(candidates + [query]))
    if !force, let cached, cache.isFresh(cached) {
      loading = false
      prefetch(candidates)
      return
    }
    loading = true
    searchTask = Task {
      if !immediate {
        do { try await Task.sleep(nanoseconds: 400_000_000) } catch { return }
      }
      guard !Task.isCancelled else { return }
      do {
        let entry = try await cache.load(query, service: service, force: force)
        guard version == searchVersion, !Task.isCancelled else { return }
        show(entry)
        loading = false
        prefetch(candidates)
      } catch {
        guard version == searchVersion, !Task.isCancelled else { return }
        self.error = requests.isEmpty ? error.localizedDescription : "Couldn’t refresh. Showing previously loaded results. " + error.localizedDescription
        loading = false
        // Stop speculative work after an error, including rate limits.
        prefetchTask?.cancel(); cache.retainRequests(for: [])
      }
    }
  }
  private func show(_ entry: PRSearchCache.Entry) {
    requests = entry.page.requests; totalCount = entry.page.count
    pageInfo = entry.page.pageInfo; lastUpdated = entry.updated
    if let selectedID, !requests.contains(where: { $0.id == selectedID }) { select(nil) }
  }
  private func prefetchQueries() -> [String] {
    guard let login else { return [] }
    var seen: Set<String> = [query]
    return views.compactMap { view in
      var next = view.filters
      if view.isBuiltIn { next.repository = filters.repository; next.organization = filters.organization }
      let query = next.query(login: login)
      return seen.insert(query).inserted ? query : nil
    }.prefix(8).map { $0 }
  }
  private func prefetch(_ queries: [String]) {
    prefetchTask?.cancel()
    let version = UUID(); prefetchVersion = version
    // Two background queries at most, leaving the selected view its own lane.
    prefetchTask = Task {
      await withTaskGroup(of: Void.self) { group in
        for offset in 0..<2 {
          group.addTask { @MainActor [weak self] in
            guard let self else { return }
            for index in stride(from: offset, to: queries.count, by: 2) {
              guard !Task.isCancelled, self.prefetchVersion == version else { return }
              do { _ = try await self.cache.load(queries[index], service: self.service) }
              catch {
                if self.prefetchVersion == version {
                  self.prefetchVersion = UUID()
                  self.cache.retainRequests(for: Set([self.query]))
                }
                return
              }
            }
          }
        }
      }
    }
  }

  func loadMore() async {
    guard canLoadMore, !loading, let cursor = pageInfo?.endCursor else { return }
    let version = searchVersion, query = self.query
    loading = true
    do {
      let page = try await cache.page(query, after: cursor, service: service)
      guard version == searchVersion, !Task.isCancelled else { return }
      _ = try nextCursor(page.pageInfo, previous: cursor)
      var known = Set(requests.map(\.id))
      requests += page.requests.filter { known.insert($0.id).inserted }
      totalCount = page.count; pageInfo = page.pageInfo
      cache.store(.init(page: .init(requests: requests, count: totalCount, pageInfo: page.pageInfo), updated: lastUpdated ?? Date()), for: query)
    } catch {
      guard version == searchVersion, !Task.isCancelled else { return }
      self.error = error.localizedDescription
    }
    if version == searchVersion { loading = false }
  }
  func selectRepository(_ repository: String?) {
    filters.repository = repository
    if repository == nil { filters.organization = nil; reloadOrganization() }
    scheduleSearch(immediate: true)
  }
  func selectOrganization(_ organization: String?) {
    filters.organization = organization; filters.repository = nil
    repositorySearch = ""; starredOnly = false
    reloadOrganization()
    scheduleSearch(immediate: true)
  }
  func selectView(_ view: PRSavedView) {
    guard let login else { return }
    do {
      // Save any unsaved repository/filter changes before switching views.
      try viewStore.saveWorkspace(account: login, hostname: hostname, filters: filters, selectedViewID: selectedViewID)
      try viewStore.select(account: login, hostname: hostname, id: view.id)
      scheduleSearch(immediate: true)
    } catch { self.error = error.localizedDescription }
  }
  @discardableResult
  func saveView(name: String, replacing id: String? = nil) -> Bool {
    guard let login else { return false }
    do {
      try viewStore.upsert(account: login, hostname: hostname, view: .init(id: id ?? UUID().uuidString, name: name, filters: filters), select: true)
      return true
    } catch { self.error = error.localizedDescription; return false }
  }
  func deleteView(_ view: PRSavedView) {
    guard let login else { return }
    do { try viewStore.delete(account: login, hostname: hostname, id: view.id) }
    catch { self.error = error.localizedDescription }
  }
  func moveView(_ view: PRSavedView, by offset: Int) {
    guard let login, let index = customViews.firstIndex(where: { $0.id == view.id }), customViews.indices.contains(index + offset) else { return }
    var ids = customViews.map(\.id)
    ids.swapAt(index, index + offset)
    do { try viewStore.reorder(account: login, hostname: hostname, ids: ids) }
    catch { self.error = error.localizedDescription }
  }
  private func savePreferences() {
    guard let login else { return }
    do { try viewStore.saveWorkspace(account: login, hostname: hostname, filters: filters, selectedViewID: selectedViewID) }
    catch { self.error = error.localizedDescription }
  }
  private func restoreViews(login: String) {
    apply(PRViewStore.Preferences())
    do { apply(try viewStore.load(account: login, hostname: hostname)); reloadOrganization() }
    catch { self.error = error.localizedDescription }
  }
  private func apply(_ value: PRViewStore.Preferences) {
    applyingViewPreferences = true
    defer { applyingViewPreferences = false }
    if customViews != value.customViews { customViews = value.customViews }
    if selectedViewID != value.selectedViewID { selectedViewID = value.selectedViewID }
    if filters != value.filters { filters = value.filters }
  }

  func select(_ id: String?) {
    detailTask?.cancel()
    selectedID = id; detail = nil; detailError = nil; files = []; filesPage = 0; filesHaveMore = false
    let version = UUID(); detailVersion = version
    loadingFiles = false; loadingDetail = id != nil
    guard let id else { return }
    detailTask = Task {
      do {
        let value = try await service.detail(id: id)
        guard detailVersion == version, !Task.isCancelled else { return }
        detail = value
      } catch {
        guard detailVersion == version, !Task.isCancelled else { return }
        detailError = error.localizedDescription
      }
      if detailVersion == version { loadingDetail = false }
    }
  }
  func loadFiles() async {
    guard let request = selectedRequest, detail != nil, !loadingFiles,
      filesPage == 0 || filesHaveMore else { return }
    let version = detailVersion
    loadingFiles = true
    do {
      let page = try await service.files(repository: request.repository.nameWithOwner, number: request.number, page: filesPage + 1)
      guard detailVersion == version, !Task.isCancelled else { return }
      let known = Set(files.map(\.id))
      files += page.filter { !known.contains($0.id) }
      filesPage += 1
      filesHaveMore = page.count == 100 && files.count < request.changedFiles && files.count < 3000
      detailError = nil
    } catch {
      guard detailVersion == version, !Task.isCancelled else { return }
      detailError = error.localizedDescription
    }
    if detailVersion == version { loadingFiles = false }
  }
  func toggleStar(_ repository: GitHubRepository) async {
    guard !starring.contains(repository.id), !connecting else { return }
    starring.insert(repository.id)
    error = nil
    defer { starring.remove(repository.id) }
    do {
      guard let login, try await service.viewer().lowercased() == login.lowercased() else {
        throw GitHubPRError.message("Your GitHub account changed. Reconnect before starring repositories.")
      }
      try await service.star(repository: repository, starred: !repository.viewerHasStarred)
      if let index = repositories.firstIndex(where: { $0.id == repository.id }) { repositories[index].viewerHasStarred.toggle() }
    } catch { self.error = error.localizedDescription }
  }
  /// Capture the PR and revision when opening the composer, never the current selection.
  func submit(request: PullRequest, reviewed: PullRequestDetail, event: PRReviewEvent, body: String) async -> String? {
    guard !submitting, let login else { return "Connect to GitHub before submitting." }
    if let issue = event.validation(detail: reviewed, login: login, body: body) { return issue }
    submitting = true
    defer { submitting = false }
    do {
      try await service.review(request: request, detail: reviewed, login: login, event: event, body: body)
      notice = "\(event == .comment ? "Comment" : "Review") submitted to \(request.repository.nameWithOwner) #\(request.number)."
      if selectedID == request.id { select(request.id) }
      cache.reset()
      prefetchTask?.cancel(); prefetchVersion = UUID()
      scheduleSearch(immediate: true, force: true)
      return nil
    } catch { return error.localizedDescription + " No automatic retry was made; check GitHub before resubmitting if the result is uncertain." }
  }
}
