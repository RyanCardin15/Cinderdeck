import Foundation

@MainActor
protocol GitHubPRServing {
  var hostname: String { get set }
  func organizations(after: String?) async throws -> GitHubConnection<GitHubActor>
  func repositories(organization: String, after: String?) async throws -> GitHubConnection<GitHubRepository>
  func viewer() async throws -> String
  func repositories(after: String?) async throws -> GitHubConnection<GitHubRepository>
  func search(_ query: String, after: String?) async throws -> PullRequestSearchPage
  func detail(id: String) async throws -> PullRequestDetail
  func files(repository: String, number: Int, page: Int) async throws -> [PullRequestFile]
  func star(repository: GitHubRepository, starred: Bool) async throws
  func review(request: PullRequest, detail: PullRequestDetail, login: String, event: PRReviewEvent, body: String) async throws
}

nonisolated enum GitHubPRError: LocalizedError {
  case message(String)
  var errorDescription: String? { if case .message(let message) = self { return message }; return nil }
}

/// Reuses GitHub CLI's secure authentication without reading or storing tokens.
/// Requests are argument arrays, never shell strings. Mutations are never retried.
@MainActor
final class GitHubPRService: GitHubPRServing {
  typealias Transport = ([String], Data?) async throws -> Data
  var hostname: String
  private let transport: Transport?
  private let configuration: () async throws -> GitHubCLIConfiguration
  init(hostname: String = GitHubHost.current,
    configuration: @escaping () async throws -> GitHubCLIConfiguration = { try await GitHubCLI.configuration() },
    transport: Transport? = nil) {
    self.hostname = hostname
    self.transport = transport
    self.configuration = configuration
  }
  private func send(_ args: [String], _ payload: Data?) async throws -> Data {
    try Task.checkCancellation()
    if let transport { return try await transport(args, payload) }
    let host = hostname
    let configuration = try await configuration()
    return try await Self.execute(args, payload: payload, hostname: host, configuration: configuration)
  }

  private static func execute(_ args: [String], payload: Data?, hostname: String, configuration: GitHubCLIConfiguration) async throws -> Data {
    guard GitHubHost.normalized(hostname) == hostname else { throw GitHubPRError.message("Enter a valid GitHub hostname in Preferences.") }
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("cinderdeck-github-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    defer { try? FileManager.default.removeItem(at: directory) }
    var arguments = ["api", "--hostname", hostname] + args
    if let payload {
      let file = directory.appendingPathComponent("request.json")
      try payload.write(to: file, options: .atomic)
      try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
      arguments += ["--input", file.path]
    }
    let result = try await StackCommandRunner.run(configuration.executable, arguments, directory: directory, environment: configuration.environment, timeout: 45)
    guard result.status == 0 else {
      // gh can return a structured GraphQL error in stdout even on failure.
      if let envelope = try? JSONDecoder().decode(GitHubErrorEnvelope.self, from: result.output),
        let message = envelope.errors?.first?.message ?? envelope.message {
        throw GitHubPRError.message(message)
      }
      throw GitHubPRError.message(result.errorText.isEmpty ? "GitHub could not complete the request. Check your connection and sign-in, then retry." : String(result.errorText.prefix(1500)))
    }
    return result.output
  }

  private struct GitHubErrorEnvelope: Decodable {
    struct Issue: Decodable { var message: String }
    var errors: [Issue]?
    var message: String?
  }
  private struct Envelope<T: Decodable>: Decodable { var data: T?; var errors: [GitHubErrorEnvelope.Issue]? }
  private func graph<T: Decodable>(_ query: String, variables: [String: Any] = [:], as type: T.Type) async throws -> T {
    let payload = try JSONSerialization.data(withJSONObject: ["query": query, "variables": variables])
    let response = try await send(["graphql"], payload)
    let envelope = try Self.decoder().decode(Envelope<T>.self, from: response)
    if let error = envelope.errors?.first { throw GitHubPRError.message(error.message) }
    guard let data = envelope.data else { throw GitHubPRError.message("GitHub returned an empty response.") }
    return data
  }
  static func decoder() -> JSONDecoder {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return decoder
  }
  func viewer() async throws -> String {
    struct Result: Decodable { var viewer: GitHubActor }
    return try await graph("query { viewer { login } }", as: Result.self).viewer.login
  }
  func repositories(after: String?) async throws -> GitHubConnection<GitHubRepository> {
    struct Viewer: Decodable { var repositories: GitHubConnection<GitHubRepository> }
    struct Result: Decodable { var viewer: Viewer }
    return try await graph("""
      query($after: String) { viewer { repositories(first: 100, after: $after,
        affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER],
        ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], orderBy: {field: UPDATED_AT, direction: DESC}) {
        nodes { id nameWithOwner isPrivate isArchived viewerHasStarred url ownerAccount: owner { kind: __typename } }
        totalCount pageInfo { hasNextPage endCursor }
      } } }
      """, variables: ["after": after as Any? ?? NSNull()], as: Result.self).viewer.repositories
  }
  func organizations(after: String?) async throws -> GitHubConnection<GitHubActor> {
    struct Viewer: Decodable { var organizations: GitHubConnection<GitHubActor> }
    struct Result: Decodable { var viewer: Viewer }
    return try await graph("""
      query($after: String) { viewer { organizations(first: 100, after: $after) {
        nodes { login } pageInfo { hasNextPage endCursor }
      } } }
      """, variables: ["after": after as Any? ?? NSNull()], as: Result.self).viewer.organizations
  }
  func repositories(organization: String, after: String?) async throws -> GitHubConnection<GitHubRepository> {
    struct Organization: Decodable { var repositories: GitHubConnection<GitHubRepository> }
    struct Result: Decodable { var organization: Organization? }
    let result = try await graph("""
      query($organization: String!, $after: String) { organization(login: $organization) {
        repositories(first: 100, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
          nodes { id nameWithOwner isPrivate isArchived viewerHasStarred url ownerAccount: owner { kind: __typename } }
          totalCount pageInfo { hasNextPage endCursor }
        }
      } }
      """, variables: ["organization": organization, "after": after as Any? ?? NSNull()], as: Result.self)
    guard let organization = result.organization else { throw GitHubPRError.message("This organization is not accessible with your current GitHub connection.") }
    return organization.repositories
  }
  static let summaryFields = """
    id number title url state isDraft updatedAt additions deletions changedFiles reviewDecision
    author { login } repository { nameWithOwner } labels(first: 10) { nodes { name } }
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
    """
  func search(_ query: String, after: String?) async throws -> PullRequestSearchPage {
    do { return try await search(query, after: after, pageSize: 25) }
    catch {
      try Task.checkCancellation()
      let message = error.localizedDescription.lowercased()
      guard !message.contains("rate limit"), !message.hasPrefix("command timed out"),
        message.contains("timed out") || message.contains("timeout") || message.contains("wasn't able to respond to your request in time") else { throw error }
      // A smaller read can recover from GitHub's GraphQL processing timeout.
      // Never retry auth/rate-limit errors or any mutation.
      return try await search(query, after: after, pageSize: 10)
    }
  }
  private func search(_ query: String, after: String?, pageSize: Int) async throws -> PullRequestSearchPage {
    struct Search: Decodable { var nodes: [PullRequest]; var issueCount: Int; var pageInfo: GitHubPageInfo }
    struct Result: Decodable { var search: Search }
    let data = try await graph("""
      query($query: String!, $after: String, $first: Int!) { search(query: $query, type: ISSUE, first: $first, after: $after) {
        issueCount pageInfo { hasNextPage endCursor } nodes { ... on PullRequest { \(Self.summaryFields) } }
      } }
      """, variables: ["query": query, "after": after as Any? ?? NSNull(), "first": pageSize], as: Result.self).search
    return .init(requests: data.nodes, count: data.issueCount, pageInfo: data.pageInfo)
  }
  func detail(id: String) async throws -> PullRequestDetail {
    struct Result: Decodable { var node: PullRequestDetail? }
    let result = try await graph("""
      query($id: ID!) { node(id: $id) { ... on PullRequest {
        id body headRefName baseRefName headRefOid state isDraft author { login } mergeable reviewDecision
        reviews(last: 50) { totalCount nodes { id author { login } body createdAt state } }
        comments(last: 50) { totalCount nodes { id author { login } body createdAt } }
      } } }
      """, variables: ["id": id], as: Result.self)
    guard let detail = result.node else { throw GitHubPRError.message("This pull request is no longer accessible.") }
    return detail
  }
  func files(repository: String, number: Int, page: Int) async throws -> [PullRequestFile] {
    guard Self.validRepository(repository), number > 0, page > 0 else { throw GitHubPRError.message("Invalid pull request.") }
    return try Self.decoder().decode([PullRequestFile].self,
      from: await send(["repos/\(repository)/pulls/\(number)/files?per_page=100&page=\(page)"], nil))
  }
  static func validRepository(_ name: String) -> Bool {
    name.split(separator: "/", omittingEmptySubsequences: false).count == 2 &&
      name.range(of: #"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"#, options: .regularExpression) != nil
  }
  func star(repository: GitHubRepository, starred: Bool) async throws {
    struct Result: Decodable { var update: Update; struct Update: Decodable { var starrable: Star; struct Star: Decodable { var viewerHasStarred: Bool } } }
    let result = try await graph("""
      mutation($id: ID!) { update: \(starred ? "addStar" : "removeStar")(input: {starrableId: $id}) {
        starrable { viewerHasStarred }
      } }
      """, variables: ["id": repository.id], as: Result.self)
    guard result.update.starrable.viewerHasStarred == starred else { throw GitHubPRError.message("GitHub did not update the repository star. Refresh and try again.") }
  }
  func review(request: PullRequest, detail: PullRequestDetail, login: String, event: PRReviewEvent, body: String) async throws {
    guard request.id == detail.id, Self.validRepository(request.repository.nameWithOwner), request.number > 0 else {
      throw GitHubPRError.message("Select this pull request again before reviewing it.")
    }
    // Revalidate both identity and the reviewed revision immediately before posting.
    guard try await viewer().lowercased() == login.lowercased() else {
      throw GitHubPRError.message("Your GitHub account changed. Reconnect before submitting a review.")
    }
    let current = try await self.detail(id: request.id)
    if let issue = event.validation(detail: current, login: login, body: body) { throw GitHubPRError.message(issue) }
    guard current.headRefOid == detail.headRefOid else { throw GitHubPRError.message("New commits were pushed. Refresh and review the latest changes before submitting.") }
    let payload = try JSONSerialization.data(withJSONObject: ["event": event.rawValue, "body": body, "commit_id": detail.headRefOid])
    let response = try await send(["repos/\(request.repository.nameWithOwner)/pulls/\(request.number)/reviews", "--method", "POST"], payload)
    struct Receipt: Decodable { var id: Int; var commit_id: String; var state: String }
    let receipt = try Self.decoder().decode(Receipt.self, from: response)
    let expectedState = event == .approve ? "APPROVED" : event == .requestChanges ? "CHANGES_REQUESTED" : "COMMENTED"
    guard receipt.id > 0, receipt.commit_id == detail.headRefOid, receipt.state == expectedState else {
      throw GitHubPRError.message("GitHub returned an unexpected review result. Check the pull request before resubmitting.")
    }
  }
}
