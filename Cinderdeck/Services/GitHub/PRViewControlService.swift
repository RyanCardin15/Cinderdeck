import Foundation

/// Local view configuration only. GitHub is used to resolve the active account;
/// these methods do not post reviews or modify repositories.
@MainActor
final class PRViewControlService {
  private let store: PRViewStore
  private let viewer: () async throws -> String

  init(store: PRViewStore? = nil, viewer: (() async throws -> String)? = nil) {
    self.store = store ?? .shared
    self.viewer = viewer ?? { try await GitHubPRService().viewer() }
  }

  func handle(_ method: String, params: JSONValue) async throws -> JSONValue {
    let allowed: Set<String>
    switch method {
    case "prs.views.list": allowed = ["account"]
    case "prs.views.upsert": allowed = ["account", "id", "name", "filters", "select"]
    case "prs.views.select", "prs.views.delete": allowed = ["account", "id"]
    case "prs.views.reorder": allowed = ["account", "ids"]
    default: throw StackControlError(code: "unknown_method", message: "Unknown method \(method)")
    }
    guard let object = params.objectValue, Set(object.keys).isSubset(of: allowed) else {
      throw StackControlError.invalid("Expected an object with only: \(allowed.sorted().joined(separator: ", ")).")
    }
    let expected = try Self.string("account", in: object, required: method != "prs.views.list")
    let account = try await viewer()
    guard !account.isEmpty else { throw StackControlError.invalid("Connect a GitHub account first.") }
    if let expected, expected.caseInsensitiveCompare(account) != .orderedSame {
      throw StackControlError(code: "account_changed", message: "Active GitHub account is \(account), not \(expected). List PR views again before editing.")
    }
    // No suspension between loading, validating, and saving this account's state.
    switch method {
    case "prs.views.upsert":
      let id = try Self.string("id", in: object, required: true)!
      let existing = try store.load(account: account).views.first { $0.id == id }
      let name = try Self.string("name", in: object, required: existing == nil) ?? existing!.name
      let filters = try PRViewAPI.patch(object["filters"], onto: existing?.filters ?? PRFilters())
      let select: Bool
      if let value = object["select"] {
        guard case .bool(let flag) = value else { throw StackControlError.invalid("select must be a boolean.") }
        select = flag
      } else { select = false }
      try store.upsert(account: account, view: .init(id: id, name: name, filters: filters), select: select)
    case "prs.views.select": try store.select(account: account, id: Self.string("id", in: object, required: true)!)
    case "prs.views.delete": try store.delete(account: account, id: Self.string("id", in: object, required: true)!)
    case "prs.views.reorder":
      guard let values = object["ids"]?.arrayValue, values.allSatisfy({ if case .string = $0 { return true }; return false }) else {
        throw StackControlError.invalid("ids must be an array of custom view ids.")
      }
      try store.reorder(account: account, ids: values.compactMap(\.stringValue))
    default: break
    }
    let value = try store.load(account: account)
    return .object([
      "account": .string(account), "selectedViewID": .string(value.selectedViewID),
      "filters": PRViewAPI.encode(value.filters), "query": .string(value.filters.query(login: account)),
      "views": .array(value.views.map { view in .object([
        "id": .string(view.id), "name": .string(view.name), "builtIn": .bool(view.isBuiltIn),
        "filters": PRViewAPI.encode(view.filters), "query": .string(view.filters.query(login: account)),
      ]) }),
    ])
  }

  private static func string(_ key: String, in object: [String: JSONValue], required: Bool) throws -> String? {
    guard let value = object[key] else {
      if required { throw StackControlError.invalid("\(key) is required. List PR views first to get account and view ids.") }
      return nil
    }
    guard case .string(let string) = value, !string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      throw StackControlError.invalid("\(key) must be a non-empty string.")
    }
    return string
  }
}

/// Stable API tokens are independent of the display labels persisted by PRFilters.
nonisolated enum PRViewAPI {
  static let states: [String: PRStateFilter] = ["all": .all, "open": .open, "draft": .draft, "merged": .merged, "closed": .closed]
  static let roles: [String: PRRoleFilter] = ["anyone": .anyone, "author": .author, "review": .review, "assigned": .assigned, "involved": .involved]
  static let sorts: [String: PRSort] = ["updated": .updated, "newest": .newest, "oldest": .oldest, "comments": .comments]

  static func encode(_ filters: PRFilters) -> JSONValue {
    .object([
      "repository": filters.repository.map(JSONValue.string) ?? .null,
      "state": .string(states.first { $0.value == filters.state }!.key),
      "role": .string(roles.first { $0.value == filters.role }!.key),
      "sort": .string(sorts.first { $0.value == filters.sort }!.key),
      "text": .string(filters.text), "label": .string(filters.label), "advanced": .bool(filters.advanced),
    ])
  }

  static func patch(_ patch: JSONValue?, onto filters: PRFilters) throws -> PRFilters {
    guard let patch else { return filters }
    guard let object = patch.objectValue,
      Set(object.keys).isSubset(of: ["repository", "state", "role", "sort", "text", "label", "advanced"]) else {
      throw StackControlError.invalid("filters must contain only repository, state, role, sort, text, label, advanced.")
    }
    var filters = filters
    for (key, value) in object {
      if key == "repository", value == .null { filters.repository = nil; continue }
      if key == "advanced" {
        guard case .bool(let flag) = value else { throw StackControlError.invalid("advanced must be a boolean.") }
        filters.advanced = flag; continue
      }
      guard case .string(let text) = value else { throw StackControlError.invalid("\(key) must be a string.") }
      switch key {
      case "repository": filters.repository = text
      case "text": filters.text = text
      case "label": filters.label = text
      case "state":
        guard let state = states[text] else { throw StackControlError.invalid("Unknown state. Use: \(states.keys.sorted().joined(separator: ", ")).") }
        filters.state = state
      case "role":
        guard let role = roles[text] else { throw StackControlError.invalid("Unknown role. Use: \(roles.keys.sorted().joined(separator: ", ")).") }
        filters.role = role
      case "sort":
        guard let sort = sorts[text] else { throw StackControlError.invalid("Unknown sort. Use: \(sorts.keys.sorted().joined(separator: ", ")).") }
        filters.sort = sort
      default: break
      }
    }
    return filters
  }
}
