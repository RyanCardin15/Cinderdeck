import Foundation

/// The CLI uses the MCP catalog directly, so every current and future agent operation is available
/// from a shell with the same arguments, validation, and timeout.
nonisolated enum AgentToolCLI {
  static func runLaneEdit(_ arguments: [String]) -> Int32 {
    if arguments.contains("--help") { print("cinderdeck lane edit <lane> [--name <name>] [--env KEY=VALUE ... | --clear-env] [--force]"); return 0 }
    do {
      let options = try parse(arguments, valued: ["name", "env", "as", "session"], flags: ["clear-env", "force", "json"], repeated: ["env"])
      let request = try laneEditRequest(options)
      let connection = try StackCLI.connect(StackCLI.clientInfo(options))
      print(try connection.call(request.0, request.1, timeout: request.2).prettyString())
      return 0
    } catch { return report(error) }
  }

  static func laneEditRequest(_ options: StackCLI.Options) throws -> (String, [String: JSONValue], TimeInterval) {
    guard options.positionals.count == 1 else { throw StackControlError.invalid("Use lane edit <lane> --name <name> / --env KEY=VALUE / --clear-env") }
    var params: [String: JSONValue] = ["workspace": .string(options.positionals[0])]
    if let name = options["name"] { params["name"] = .string(name) }
    if options.has("force") { params["force"] = .bool(true) }
    guard !options.has("clear-env") || options["env"] == nil else { throw StackControlError.invalid("Use --env or --clear-env, not both") }
    if let pairs = options.lists["env"] {
      var environment: [String: JSONValue] = [:]
      for pair in pairs {
        guard let equal = pair.firstIndex(of: "="), equal != pair.startIndex else { throw StackControlError.invalid("--env takes KEY=VALUE") }
        let key = String(pair[..<equal])
        guard environment[key] == nil else { throw StackControlError.invalid("Duplicate environment variable \(key)") }
        environment[key] = .string(String(pair[pair.index(after: equal)...]))
      }
      params["env"] = .object(environment)
    } else if options.has("clear-env") { params["env"] = .object([:]) }
    guard params["name"] != nil || params["env"] != nil else { throw StackControlError.invalid("Pass --name, --env, or --clear-env") }
    return try request(name: "update_lane", arguments: params)
  }

  static func run(_ arguments: [String], list: Bool = false) -> Int32 {
    if arguments.contains("--help") || arguments == ["help"] { print(usage); return 0 }
    do {
      let options = try parse(arguments, valued: ["arguments", "file", "as", "session"], flags: ["json"])
      if list {
        guard options.positionals.count <= 1, options["arguments"] == nil, options["file"] == nil else {
          throw StackControlError.invalid("Use cinderdeck tools [tool-name]")
        }
        let catalog = CinderdeckMCPServer.toolDescriptions
        if let name = options.positionals.first {
          guard let tool = catalog.first(where: { $0["name"]?.stringValue == name }) else { throw StackControlError.notFound("Unknown tool \(name)") }
          print(tool.prettyString())
        } else { print(JSONValue.array(catalog).prettyString()) }
        return 0
      }
      guard options.positionals.count == 1 else { throw StackControlError.invalid(usage) }
      let request = try request(name: options.positionals[0], arguments: object(options, key: "arguments"))
      let connection = try StackCLI.connect(StackCLI.clientInfo(options))
      print(try connection.call(request.0, request.1, timeout: request.2).prettyString())
      return 0
    } catch { return report(error) }
  }

  static func request(name: String, arguments: [String: JSONValue]) throws -> (String, [String: JSONValue], TimeInterval) {
    try CinderdeckMCPServer.validate(name, arguments)
    return try CinderdeckMCPServer.request(for: name, arguments)
  }

  static func object(_ options: StackCLI.Options, key: String = "data") throws -> [String: JSONValue] {
    guard options[key] == nil || options["file"] == nil else { throw StackControlError.invalid("Use --\(key) or --file, not both") }
    let source = try options["file"].map { try String(contentsOfFile: ($0 as NSString).expandingTildeInPath, encoding: .utf8) }
      ?? options[key] ?? "{}"
    guard let value = try? StackControlCoding.decoder().decode(JSONValue.self, from: Data(source.utf8)), let object = value.objectValue else {
      throw StackControlError.invalid("Arguments must be a JSON object")
    }
    return object
  }

  /// Strict option parsing: reject typos, missing values, duplicate options and values on switches.
  static func parse(_ arguments: [String], valued: Set<String>, flags: Set<String>, repeated: Set<String> = []) throws -> StackCLI.Options {
    var result = StackCLI.Options()
    var index = 0
    while index < arguments.count {
      let argument = arguments[index]; index += 1
      if argument == "--" { result.positionals += arguments[index...]; break }
      guard argument.hasPrefix("-"), argument != "-" else { result.positionals.append(argument); continue }
      let parts = argument.drop(while: { $0 == "-" }).split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false).map(String.init)
      let key = parts[0] == "n" ? "lines" : parts[0]
      guard valued.contains(key) || flags.contains(key) else { throw StackControlError.invalid("Unknown option: \(argument)") }
      guard repeated.contains(key) || (result[key] == nil && !result.has(key)) else { throw StackControlError.invalid("Duplicate option: --\(key)") }
      if valued.contains(key) {
        let value: String
        if parts.count == 2 { value = parts[1] }
        else {
          guard index < arguments.count, !arguments[index].hasPrefix("--") else { throw StackControlError.invalid("--\(key) requires a value") }
          value = arguments[index]; index += 1
        }
        result.values[key] = value
        if repeated.contains(key) { result.lists[key, default: []].append(value) }
      } else {
        guard parts.count == 1 else { throw StackControlError.invalid("--\(key) does not accept a value") }
        result.flags.insert(key)
      }
    }
    return result
  }

  static func report(_ error: Error) -> Int32 {
    let error = error as? StackControlError ?? .init(code: "failed", message: error.localizedDescription)
    let output: JSONValue = .object(["error": .object(["code": .string(error.code), "message": .string(error.message)])])
    FileHandle.standardError.write(Data((output.prettyString() + "\n").utf8))
    return error.code == "claimed" ? 3 : 1
  }

  static let usage = """
  cinderdeck tools [tool-name]                      List operations and their JSON argument schemas
  cinderdeck call <tool-name> --arguments '<json>'   Run any MCP operation from the CLI
  cinderdeck call <tool-name> --file <args.json>     Read arguments from a JSON file

  Calls use exactly the MCP tool names and arguments. Results and errors are JSON.
  --as <agent> / --session <id> identify the caller. Mutations are never retried.
  """
}
