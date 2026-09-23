import Combine
import Foundation

/// One persistence path for the PR window, CLI, and MCP. Mutations run on the
/// main actor and notify the open workspace before returning to the caller.
@MainActor
final class PRViewStore {
  static let shared = PRViewStore()

  struct Preferences: Codable, Equatable {
    var customViews: [PRSavedView] = []
    var filters = PRFilters()
    var selectedViewID = "active"
    var views: [PRSavedView] { PRSavedView.defaults + customViews }
  }

  let changes = PassthroughSubject<(account: String, hostname: String, preferences: Preferences), Never>()
  private let defaults: UserDefaults

  init(defaults: UserDefaults = .standard) { self.defaults = defaults }

  func load(account: String, hostname: String = "github.com") throws -> Preferences {
    guard let data = defaults.data(forKey: key(account, hostname: hostname)) ??
      (hostname == "github.com" ? defaults.data(forKey: "github.prs.\(account.lowercased()).v1") : nil) else { return Preferences() }
    guard var value = try? JSONDecoder().decode(Preferences.self, from: data) else {
      throw StackControlError(code: "invalid_configuration", message: "Saved PR views could not be read. Existing preferences have been preserved.")
    }
    var seen = Set(PRSavedView.defaults.map(\.id))
    value.customViews = value.customViews.filter { !$0.name.isEmpty && seen.insert($0.id).inserted }
    if let repository = value.filters.repository, !GitHubPRService.validRepository(repository) { value.filters.repository = nil }
    if let organization = value.filters.organization, !GitHubPRService.validRepository("\(organization)/repo") { value.filters.organization = nil }
    if !value.views.contains(where: { $0.id == value.selectedViewID }) { value.selectedViewID = "active" }
    return value
  }

  func saveWorkspace(account: String, hostname: String = "github.com", filters: PRFilters, selectedViewID: String) throws {
    var value = try load(account: account, hostname: hostname)
    guard value.views.contains(where: { $0.id == selectedViewID }) else { throw StackControlError.notFound("Unknown PR view: \(selectedViewID)") }
    value.filters = filters
    value.selectedViewID = selectedViewID
    try save(value, account: account, hostname: hostname)
  }

  func upsert(account: String, hostname: String = "github.com", view: PRSavedView, select: Bool = false) throws {
    guard !view.isBuiltIn else { throw StackControlError.invalid("Built-in PR views cannot be edited.") }
    guard !view.id.isEmpty, view.id.count <= 100,
      view.id.range(of: #"^[A-Za-z0-9_-]+$"#, options: .regularExpression) != nil else {
      throw StackControlError.invalid("View id must be 1–100 letters, numbers, hyphens, or underscores.")
    }
    let name = view.name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !name.isEmpty, name.count <= 40 else { throw StackControlError.invalid("View name must be 1–40 characters.") }
    if let repository = view.filters.repository, !GitHubPRService.validRepository(repository) {
      throw StackControlError.invalid("Repository must be owner/name, or null for My work.")
    }
    if let organization = view.filters.organization, !GitHubPRService.validRepository("\(organization)/repo") {
      throw StackControlError.invalid("Organization must be a GitHub organization login, or null.")
    }
    var value = try load(account: account, hostname: hostname)
    var view = view
    view.name = name
    if let index = value.customViews.firstIndex(where: { $0.id == view.id }) {
      // Follow edits to the active saved view, while preserving unsaved filters.
      if value.selectedViewID == view.id, value.filters == value.customViews[index].filters { value.filters = view.filters }
      value.customViews[index] = view
    } else { value.customViews.append(view) }
    if select { value.selectedViewID = view.id; value.filters = view.filters }
    try save(value, account: account, hostname: hostname)
  }

  func select(account: String, hostname: String = "github.com", id: String) throws {
    var value = try load(account: account, hostname: hostname)
    guard let view = value.views.first(where: { $0.id == id }) else { throw StackControlError.notFound("Unknown PR view: \(id)") }
    let repository = value.filters.repository, organization = value.filters.organization
    value.filters = view.filters
    if view.isBuiltIn { value.filters.repository = repository; value.filters.organization = organization }
    value.selectedViewID = id
    try save(value, account: account, hostname: hostname)
  }

  func delete(account: String, hostname: String = "github.com", id: String) throws {
    guard !PRSavedView.defaults.contains(where: { $0.id == id }) else { throw StackControlError.invalid("Built-in PR views cannot be deleted.") }
    var value = try load(account: account, hostname: hostname)
    // Idempotent for transport retries.
    value.customViews.removeAll { $0.id == id }
    if value.selectedViewID == id {
      let repository = value.filters.repository, organization = value.filters.organization
      value.selectedViewID = "active"
      value.filters = PRFilters(repository: repository, organization: organization)
    }
    try save(value, account: account, hostname: hostname)
  }

  func reorder(account: String, hostname: String = "github.com", ids: [String]) throws {
    var value = try load(account: account, hostname: hostname)
    guard ids.count == value.customViews.count, Set(ids) == Set(value.customViews.map(\.id)) else {
      throw StackControlError.invalid("Order must contain every custom view id exactly once; built-in tabs keep their positions.")
    }
    let views = Dictionary(uniqueKeysWithValues: value.customViews.map { ($0.id, $0) })
    value.customViews = ids.compactMap { views[$0] }
    try save(value, account: account, hostname: hostname)
  }

  private func key(_ account: String, hostname: String) -> String { "github.prs.\(hostname).\(account.lowercased()).v2" }

  private func save(_ value: Preferences, account: String, hostname: String) throws {
    defaults.set(try JSONEncoder().encode(value), forKey: key(account, hostname: hostname))
    changes.send((account.lowercased(), hostname, value))
  }
}
