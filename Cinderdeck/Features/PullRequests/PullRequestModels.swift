import Foundation

nonisolated struct GitHubPageInfo: Codable, Equatable, Sendable {
  var hasNextPage: Bool
  var endCursor: String?
}

nonisolated struct GitHubConnection<Node: Codable & Sendable>: Codable, Sendable {
  var nodes: [Node]
  var pageInfo: GitHubPageInfo?
  var totalCount: Int?
}

nonisolated struct GitHubActor: Codable, Equatable, Sendable {
  var login: String
}

nonisolated struct GitHubRepository: Codable, Identifiable, Equatable, Sendable {
  var id: String
  var nameWithOwner: String
  var isPrivate: Bool
  var isArchived: Bool
  var viewerHasStarred: Bool
  var url: String
  var name: String { nameWithOwner.split(separator: "/").last.map(String.init) ?? nameWithOwner }
  var owner: String { nameWithOwner.split(separator: "/").first.map(String.init) ?? "" }
}

nonisolated struct PullRequest: Codable, Identifiable, Sendable {
  struct Repository: Codable, Sendable { var nameWithOwner: String }
  struct Label: Codable, Identifiable, Sendable { var name: String; var id: String { name } }
  struct CommitNode: Codable, Sendable {
    struct Commit: Codable, Sendable {
      struct Rollup: Codable, Sendable { var state: String }
      var statusCheckRollup: Rollup?
    }
    var commit: Commit
  }
  var id: String
  var number: Int
  var title: String
  var url: String
  var state: String
  var isDraft: Bool
  var author: GitHubActor?
  var repository: Repository
  var updatedAt: Date
  var additions: Int
  var deletions: Int
  var changedFiles: Int
  var reviewDecision: String?
  var labels: GitHubConnection<Label>
  var commits: GitHubConnection<CommitNode>
  var updatedLabel: String {
    let minutes = max(0, Int(Date().timeIntervalSince(updatedAt) / 60))
    if minutes < 1 { return "Just now" }
    if minutes < 60 { return "\(minutes)m ago" }
    if minutes < 1440 { return "\(minutes / 60)h ago" }
    return "\(minutes / 1440)d ago"
  }
  var stateLabel: String { state == "MERGED" ? "Merged" : state == "CLOSED" ? "Closed" : isDraft ? "Draft" : "Open" }
  var checks: String {
    switch commits.nodes.last?.commit.statusCheckRollup?.state {
    case "SUCCESS": return "Passed"
    case "FAILURE", "ERROR": return "Failed"
    case "PENDING", "EXPECTED": return "Pending"
    default: return "No checks"
    }
  }
  var reviewLabel: String {
    switch reviewDecision {
    case "APPROVED": return "Approved"
    case "CHANGES_REQUESTED": return "Changes requested"
    case "REVIEW_REQUIRED": return "Review required"
    default: return "No review decision"
    }
  }
}

nonisolated struct PullRequestActivity: Codable, Identifiable, Sendable {
  var id: String
  var author: GitHubActor?
  var body: String
  var createdAt: Date
  var state: String?
}

nonisolated struct PullRequestDetail: Codable, Sendable {
  var id: String
  var body: String
  var headRefName: String
  var baseRefName: String
  var headRefOid: String
  var state: String
  var isDraft: Bool
  var author: GitHubActor?
  var mergeable: String
  var reviewDecision: String?
  var reviews: GitHubConnection<PullRequestActivity>
  var comments: GitHubConnection<PullRequestActivity>
  var activity: [PullRequestActivity] { (reviews.nodes + comments.nodes).sorted { $0.createdAt < $1.createdAt } }
}

nonisolated struct PullRequestFile: Codable, Identifiable, Sendable {
  var filename: String
  var status: String
  var additions: Int
  var deletions: Int
  var patch: String?
  var id: String { filename }
}

nonisolated struct PullRequestSearchPage: Sendable {
  var requests: [PullRequest]
  var count: Int
  var pageInfo: GitHubPageInfo
}

nonisolated enum PRStateFilter: String, Codable, CaseIterable, Identifiable {
  case all = "Any state", open = "Open", draft = "Draft", merged = "Merged", closed = "Closed, unmerged"
  var id: String { rawValue }
  var query: String {
    switch self {
    case .all: return ""
    case .open: return "is:open"
    case .draft: return "is:open draft:true"
    case .merged: return "is:merged"
    case .closed: return "is:closed is:unmerged"
    }
  }
}

nonisolated enum PRRoleFilter: String, Codable, CaseIterable, Identifiable {
  case anyone = "Anyone", author = "Created by me", review = "Review requested", assigned = "Assigned to me", involved = "Involving me"
  var id: String { rawValue }
  func query(login: String) -> String {
    switch self {
    case .anyone: return ""
    case .author: return "author:\(login)"
    case .review: return "review-requested:\(login)"
    case .assigned: return "assignee:\(login)"
    case .involved: return "involves:\(login)"
    }
  }
}

nonisolated enum PRSort: String, Codable, CaseIterable, Identifiable {
  case updated = "Recently updated", newest = "Newest first", oldest = "Oldest first", comments = "Most discussed"
  var id: String { rawValue }
  var query: String {
    switch self {
    case .updated: return "sort:updated-desc"
    case .newest: return "sort:created-desc"
    case .oldest: return "sort:created-asc"
    case .comments: return "sort:comments-desc"
    }
  }
}

nonisolated struct PRFilters: Codable, Equatable, Sendable {
  var repository: String?
  var state: PRStateFilter = .open
  var role: PRRoleFilter = .anyone
  var sort: PRSort = .updated
  var text = ""
  var label = ""
  var advanced = false

  func query(login: String) -> String {
    // The global inbox is deliberately scoped to the viewer. Selecting a repo
    // removes that implicit involvement filter so all of its PRs are visible.
    let scope = repository.map { "repo:\($0)" } ?? (role == .anyone ? "involves:\(login)" : "")
    let personal = role.query(login: login)
    let labelQuery = label.trimmingCharacters(in: .whitespacesAndNewlines)
    let labelClause = labelQuery.isEmpty ? "" : "label:\(Self.quote(labelQuery))"
    let search = text.trimmingCharacters(in: .whitespacesAndNewlines)
    return ["is:pr", scope, personal, advanced ? "" : state.query, advanced ? "" : labelClause,
      advanced ? search.replacingOccurrences(of: "@me", with: login) : (search.isEmpty ? "" : Self.quote(search)), sort.query]
      .filter { !$0.isEmpty }.joined(separator: " ")
  }
  private static func quote(_ value: String) -> String {
    "\"" + value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
  }
}

nonisolated struct PRSavedView: Codable, Identifiable, Equatable, Sendable {
  var id: String = UUID().uuidString
  var name: String
  var filters: PRFilters
  static let defaults: [PRSavedView] = [
    .init(id: "all", name: "All", filters: .init(state: .all)),
    .init(id: "active", name: "Active", filters: .init()),
    .init(id: "reviews", name: "Review requests", filters: .init(role: .review)),
    .init(id: "done", name: "Done", filters: .init(state: .merged)),
  ]
  var isBuiltIn: Bool { Self.defaults.contains { $0.id == id } }
}

nonisolated enum PRReviewEvent: String, CaseIterable, Identifiable, Sendable {
  case approve = "APPROVE", requestChanges = "REQUEST_CHANGES", comment = "COMMENT"
  var id: String { rawValue }
  var title: String {
    switch self { case .approve: return "Approve"; case .requestChanges: return "Request changes"; case .comment: return "Comment" }
  }
  func validation(detail: PullRequestDetail, login: String, body: String) -> String? {
    guard detail.state == "OPEN" else { return "This pull request is no longer open." }
    if self != .comment && detail.author?.login.lowercased() == login.lowercased() {
      return "You can comment on your own pull request, but cannot approve it or request changes."
    }
    if self != .comment && detail.isDraft { return "This pull request is still a draft." }
    if self != .approve && body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "Write a comment before submitting." }
    return nil
  }
}
