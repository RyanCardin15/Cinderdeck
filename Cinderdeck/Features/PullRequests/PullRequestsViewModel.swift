import Combine
import Foundation

@MainActor
final class PullRequestsViewModel: ObservableObject {
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
  private let service: GitHubPRServing
  private let viewStore: PRViewStore
  private var viewSubscription: AnyCancellable?
  private var applyingViewPreferences = false
  private var searchTask: Task<Void, Never>?
  private var searchVersion = UUID()
  private var detailVersion = UUID()
  private var accountVersion = UUID()
  private var filesPage = 0

  init(service: GitHubPRServing? = nil, defaults: UserDefaults? = nil, viewStore: PRViewStore? = nil) {
    self.service = service ?? GitHubPRService()
    self.viewStore = viewStore ?? defaults.map { PRViewStore(defaults: $0) } ?? .shared
    viewSubscription = self.viewStore.changes.sink { [weak self] change in
      guard let self, self.login?.lowercased() == change.account else { return }
      let filtersChanged = self.filters != change.preferences.filters
      self.apply(change.preferences)
      if filtersChanged { self.scheduleSearch(immediate: true) }
    }
  }
  var views: [PRSavedView] { PRSavedView.defaults + customViews }
  var selectedRequest: PullRequest? { requests.first { $0.id == selectedID } }
  var selectedView: PRSavedView? { views.first { $0.id == selectedViewID } }
  var viewIsModified: Bool {
    guard var saved = selectedView?.filters else { return false }
    if selectedView?.isBuiltIn == true { saved.repository = filters.repository }
    return saved != filters
  }
  var visibleRepositories: [GitHubRepository] {
    repositories.filter { (!starredOnly || $0.viewerHasStarred) &&
      (repositorySearch.isEmpty || $0.nameWithOwner.localizedCaseInsensitiveContains(repositorySearch)) }
      .sorted {
        if $0.viewerHasStarred != $1.viewerHasStarred { return $0.viewerHasStarred }
        return $0.nameWithOwner.localizedStandardCompare($1.nameWithOwner) == .orderedAscending
      }
  }
  var searchLimitReached: Bool { requests.count >= 1000 && totalCount > requests.count }
  var canLoadMore: Bool { pageInfo?.hasNextPage == true && requests.count < 1000 }
  var query: String { filters.query(login: login ?? "") }

  func connect() async {
    guard !connecting, !submitting, starring.isEmpty else { return }
    connecting = true
    loadingRepositories = false
    defer { connecting = false }
    let version = UUID(); accountVersion = version
    searchTask?.cancel(); searchVersion = UUID()
    loading = false
    select(nil)
    requests = []; repositories = []; totalCount = 0; pageInfo = nil
    error = nil; notice = nil; login = nil; lastUpdated = nil
    do {
      let viewer = try await service.viewer()
      guard accountVersion == version else { return }
      login = viewer
      restoreViews(login: viewer)
      scheduleSearch(immediate: true)
      loadingRepositories = true
      defer { loadingRepositories = false }
      var cursor: String?
      repeat {
        let page = try await service.repositories(after: cursor)
        guard accountVersion == version else { return }
        let known = Set(repositories.map(\.id))
        repositories += page.nodes.filter { !known.contains($0.id) }
        cursor = page.pageInfo?.hasNextPage == true ? page.pageInfo?.endCursor : nil
      } while cursor != nil
    } catch { self.error = error.localizedDescription }
  }

  func scheduleSearch(immediate: Bool = false) {
    searchTask?.cancel()
    searchVersion = UUID()
    let version = searchVersion
    requests = []; totalCount = 0; pageInfo = nil
    select(nil)
    guard login != nil else { loading = false; return }
    loading = true
    error = nil
    savePreferences()
    searchTask = Task {
      if !immediate {
        do { try await Task.sleep(nanoseconds: 400_000_000) } catch { return }
      }
      guard !Task.isCancelled else { return }
      await fetchPage(version: version, after: nil)
    }
  }

  private func fetchPage(version: UUID, after: String?) async {
    let query = self.query
    do {
      let page = try await service.search(query, after: after)
      guard version == searchVersion, !Task.isCancelled else { return }
      let known = Set(requests.map(\.id))
      requests += page.requests.filter { !known.contains($0.id) }
      totalCount = page.count; pageInfo = page.pageInfo; lastUpdated = Date()
    } catch {
      guard version == searchVersion, !Task.isCancelled else { return }
      self.error = error.localizedDescription
    }
    if version == searchVersion { loading = false }
  }

  func loadMore() async {
    guard canLoadMore, !loading else { return }
    loading = true
    await fetchPage(version: searchVersion, after: pageInfo?.endCursor)
  }
  func selectRepository(_ repository: String?) { filters.repository = repository }
  func selectView(_ view: PRSavedView) {
    guard let login else { return }
    do {
      // Save any unsaved repository/filter changes before switching views.
      try viewStore.saveWorkspace(account: login, filters: filters, selectedViewID: selectedViewID)
      try viewStore.select(account: login, id: view.id)
    } catch { self.error = error.localizedDescription }
  }
  @discardableResult
  func saveView(name: String, replacing id: String? = nil) -> Bool {
    guard let login else { return false }
    do {
      try viewStore.upsert(account: login, view: .init(id: id ?? UUID().uuidString, name: name, filters: filters), select: true)
      return true
    } catch { self.error = error.localizedDescription; return false }
  }
  func deleteView(_ view: PRSavedView) {
    guard let login else { return }
    do { try viewStore.delete(account: login, id: view.id) }
    catch { self.error = error.localizedDescription }
  }
  func moveView(_ view: PRSavedView, by offset: Int) {
    guard let login, let index = customViews.firstIndex(where: { $0.id == view.id }), customViews.indices.contains(index + offset) else { return }
    var ids = customViews.map(\.id)
    ids.swapAt(index, index + offset)
    do { try viewStore.reorder(account: login, ids: ids) }
    catch { self.error = error.localizedDescription }
  }
  private func savePreferences() {
    guard let login else { return }
    do { try viewStore.saveWorkspace(account: login, filters: filters, selectedViewID: selectedViewID) }
    catch { self.error = error.localizedDescription }
  }
  private func restoreViews(login: String) {
    apply(PRViewStore.Preferences())
    do { apply(try viewStore.load(account: login)) }
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
    selectedID = id; detail = nil; detailError = nil; files = []; filesPage = 0; filesHaveMore = false
    let version = UUID(); detailVersion = version
    loadingFiles = false; loadingDetail = id != nil
    guard let id else { return }
    Task {
      do {
        let value = try await service.detail(id: id)
        guard detailVersion == version else { return }
        detail = value
      } catch {
        guard detailVersion == version else { return }
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
      guard detailVersion == version else { return }
      let known = Set(files.map(\.id))
      files += page.filter { !known.contains($0.id) }
      filesPage += 1
      filesHaveMore = page.count == 100 && files.count < request.changedFiles && files.count < 3000
      detailError = nil
    } catch {
      guard detailVersion == version else { return }
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
      let version = searchVersion
      Task {
        let fresh = try? await service.search(query, after: nil)
        if version == searchVersion, let fresh {
          // Preserve loaded pagination; refresh the submitted row if it is on page one.
          if let updated = fresh.requests.first(where: { $0.id == request.id }),
            let index = requests.firstIndex(where: { $0.id == request.id }) { requests[index] = updated }
        }
      }
      return nil
    } catch { return error.localizedDescription + " No automatic retry was made; check GitHub before resubmitting if the result is uncertain." }
  }
}
