import Foundation

nonisolated enum PRViewsCLI {
  struct Request {
    var method: String
    var params: [String: JSONValue]
    var client: StackControlClientInfo
  }

  static func run(_ arguments: [String]) -> Int32 {
    if arguments.isEmpty || arguments.contains("--help") || arguments == ["help"] || arguments == ["views", "help"] {
      print(usage); return 0
    }
    do {
      let request = try request(arguments)
      let connection = try StackCLI.connect(request.client)
      print(try connection.call(request.method, request.params, timeout: 90).prettyString())
      return 0
    } catch {
      let error = (error as? StackControlError) ?? StackControlError(code: "failed", message: error.localizedDescription)
      let value = JSONValue.object(["error": .object(["code": .string(error.code), "message": .string(error.message)])])
      FileHandle.standardError.write(Data((value.prettyString() + "\n").utf8))
      return 1
    }
  }

  static func request(_ arguments: [String]) throws -> Request {
    guard arguments.first == "views" else { throw StackControlError.invalid("Use cinderdeck prs views <command>. See cinderdeck prs --help.") }
    let valueFlags: Set<String> = ["account", "host", "name", "repo", "org", "state", "role", "sort", "query", "text", "label", "as", "session"]
    let booleanFlags: Set<String> = ["select", "my-work", "json"]
    var values: [String: String] = [:]
    var flags = Set<String>()
    var positionals: [String] = []
    var index = 1
    while index < arguments.count {
      let argument = arguments[index]; index += 1
      if argument == "--" { positionals += arguments[index...]; break }
      if argument.hasPrefix("-") {
        guard argument.hasPrefix("--") else { throw StackControlError.invalid("Unknown option: \(argument)") }
        let parts = argument.dropFirst(2).split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
        let name = String(parts[0])
        guard values[name] == nil, !flags.contains(name) else { throw StackControlError.invalid("Duplicate option: --\(name)") }
        if valueFlags.contains(name) {
          if parts.count == 2 { values[name] = String(parts[1]) }
          else {
            guard index < arguments.count, !arguments[index].hasPrefix("--") else { throw StackControlError.invalid("--\(name) requires a value.") }
            values[name] = arguments[index]; index += 1
          }
        } else if booleanFlags.contains(name), parts.count == 1 { flags.insert(name) }
        else { throw StackControlError.invalid("Unknown option: \(argument)") }
      } else { positionals.append(argument) }
    }
    let command = positionals.first ?? "list"
    guard ["list", "upsert", "select", "delete", "reorder"].contains(command) else { throw StackControlError.invalid("Unknown PR views command: \(command)") }
    let ids = Array(positionals.dropFirst())
    if ["upsert", "select", "delete"].contains(command), ids.count != 1 {
      throw StackControlError.invalid("\(command) requires exactly one view id.")
    }
    if command == "list", !ids.isEmpty { throw StackControlError.invalid("list does not take a view id.") }
    if command != "upsert", !Set(values.keys).isSubset(of: ["account", "host", "as", "session"]) || !flags.isSubset(of: ["json"]) {
      throw StackControlError.invalid("Filter, name, and selection options are only valid for upsert.")
    }
    guard command == "list" || values["account"]?.isEmpty == false else {
      throw StackControlError.invalid("--account is required for changes. Run cinderdeck prs views list first.")
    }
    guard !(values["query"] != nil && values["text"] != nil), [values["repo"] != nil, values["org"] != nil, flags.contains("my-work")].filter({ $0 }).count <= 1 else {
      throw StackControlError.invalid("Use only one of --query/--text and one of --repo/--org/--my-work.")
    }
    var params: [String: JSONValue] = [:]
    if let host = values["host"] { params["hostname"] = .string(host) }
    if let account = values["account"] { params["account"] = .string(account) }
    if command == "reorder" { params["ids"] = .array(ids.map(JSONValue.string)) }
    else if let id = ids.first { params["id"] = .string(id) }
    if command == "upsert" {
      if let name = values["name"] { params["name"] = .string(name) }
      if flags.contains("select") { params["select"] = .bool(true) }
      var filters: [String: JSONValue] = [:]
      for key in ["state", "role", "sort", "label"] { if let value = values[key] { filters[key] = .string(value) } }
      if let repo = values["repo"] { filters["repository"] = .string(repo); filters["organization"] = .null }
      if let org = values["org"] { filters["organization"] = .string(org); filters["repository"] = .null }
      if flags.contains("my-work") { filters["repository"] = .null; filters["organization"] = .null }
      if let query = values["query"] { filters["text"] = .string(query); filters["advanced"] = .bool(true) }
      if let text = values["text"] { filters["text"] = .string(text); filters["advanced"] = .bool(false) }
      if !filters.isEmpty { params["filters"] = .object(filters) }
    }
    var identity = StackCLI.Options()
    identity.values = values
    return Request(method: "prs.views.\(command)", params: params, client: StackCLI.clientInfo(identity))
  }

  static let usage = """
  cinderdeck prs views — configure local Pull Request tabs (JSON output)

    list                                            List tabs, active filters, and account
    upsert <id> --account <login> --name <name>       Create, or patch an existing custom tab
    select <id> --account <login>                    Select a built-in or custom tab
    delete <id> --account <login>                    Delete a custom tab
    reorder [custom-id…] --account <login>            Order all custom tabs, exactly once each

  UPSERT OPTIONS (omitted fields are preserved; new tabs use default filters)
    --repo <owner/name> | --my-work                  Repository scope or personal inbox
    --org <organization>                            Organization scope (clears repository)
    --state all|open|draft|merged|closed
    --role anyone|author|review|assigned|involved
    --sort updated|newest|oldest|comments
    --query 'is:open author:@me' | --text 'words'     Query mode or simple text search
    --label <name>                                  Simple-mode label; empty string clears
    --select                                        Activate this view after saving

  --host <hostname> targets a GitHub server; default is the server selected in the app.
  Query mode replaces state/label/text; repository, organization, and role scope still apply.
  Built-in tabs cannot be edited, deleted, or reordered. Changes are local per server and account.
  Use the same id to update a tab without duplicating it. --name is required on creation.
  --json is accepted; all results and errors are JSON. --as / --session identify the agent.
  Connect agents with cinderdeck stacks setup-agents; the same MCP server exposes PR views.
  """
}
