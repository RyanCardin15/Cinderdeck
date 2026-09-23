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
  @Published var filters = PRFilters()
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
  private let defaults: UserDefaults
  private var searchTask: Task<Void, Never>?
  private var searchVersion = UUID()
  private var detailVersion = UUID()
  private var accountVersion = UUID()
  private var filesPage = 0

  init(service: GitHubPRServing? = nil, defaults: UserDefaults = .standard) {
    self.service = service ?? GitHubPRService()
    self.defaults = defaults
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
    var next = view.filters
    if view.isBuiltIn { next.repository = filters.repository }
    selectedViewID = view.id
    filters = next
    savePreferences()
  }
  @discardableResult
  func saveView(name: String, replacing id: String? = nil) -> Bool {
    let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !name.isEmpty, name.count <= 40 else { return false }
    if let id, let index = customViews.firstIndex(where: { $0.id == id }) {
      customViews[index] = .init(id: id, name: name, filters: filters)
      selectedViewID = id
    } else {
      let view = PRSavedView(name: name, filters: filters)
      customViews.append(view); selectedViewID = view.id
    }
    savePreferences()
    return true
  }
  func deleteView(_ view: PRSavedView) {
    customViews.removeAll { $0.id == view.id }
    if selectedViewID == view.id { selectView(PRSavedView.defaults[1]) }
    savePreferences()
  }
  func moveView(_ view: PRSavedView, by offset: Int) {
    guard let index = customViews.firstIndex(where: { $0.id == view.id }), customViews.indices.contains(index + offset) else { return }
    customViews.swapAt(index, index + offset); savePreferences()
  }
  private struct Preferences: Codable {
    var customViews: [PRSavedView]; var filters: PRFilters; var selectedViewID: String
  }
  private func savePreferences() {
    guard let login else { return }
    let value = Preferences(customViews: customViews, filters: filters, selectedViewID: selectedViewID)
    if let data = try? JSONEncoder().encode(value) { defaults.set(data, forKey: "github.prs.\(login.lowercased()).v1") }
  }
  private func restoreViews(login: String) {
    customViews = []; filters = .init(); selectedViewID = "active"
    guard let data = defaults.data(forKey: "github.prs.\(login.lowercased()).v1"),
      let value = try? JSONDecoder().decode(Preferences.self, from: data) else { return }
    var seen = Set(PRSavedView.defaults.map(\.id))
    customViews = value.customViews.filter { !$0.name.isEmpty && seen.insert($0.id).inserted }
    filters = value.filters
    if let repository = filters.repository, !GitHubPRService.validRepository(repository) { filters.repository = nil }
    selectedViewID = views.contains { $0.id == value.selectedViewID } ? value.selectedViewID : "active"
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
