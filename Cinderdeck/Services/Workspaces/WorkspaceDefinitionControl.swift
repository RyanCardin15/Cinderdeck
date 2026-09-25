import Foundation

/// Definition edits for agents, with the same writer, validation, and stale-file protection as the
/// Workspaces editors. Saving never starts anything; definitions reload before the result returns.
extension StackControlService {
  func handleWorkspaceDefinition(_ method: String, params: JSONValue, actor: StackActor) async throws -> JSONValue {
    if method == "workspace.create" { return try await createWorkspace(params) }
    let (file, definition, source) = try editableWorkspace(params, actor: actor)
    let saved: String
    do {
      switch method {
      case "workspace.service.save": saved = try saveService(params, in: definition, file: file.file, source: source)
      case "workspace.task.save": saved = try saveTask(params, in: definition, file: file.file, source: source)
      case "workspace.workflow.save": saved = try saveWorkflow(params, in: definition, file: file.file, source: source)
      case "workspace.item.delete": saved = try deleteItem(params, in: definition, file: file.file, source: source)
      default: throw StackControlError(code: "unknown_method", message: "Unknown workspace method \(method)")
      }
    } catch StackError.message(let message) {
      throw StackControlError(code: "invalid_definition", message: message)
    }
    await supervisor.reloadDefinitions()
    let refreshed = supervisor.files.first { $0.id == file.id } ?? file
    var result = try definitionResult(refreshed)
    result["saved"] = .string(saved)
    result["file"] = .string(file.file.path)
    return .object(result)
  }

  private func createWorkspace(_ params: JSONValue) async throws -> JSONValue {
    guard let name = params["name"]?.stringValue, !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      throw StackControlError.invalid("Pass name")
    }
    guard let folder = params["folder"]?.stringValue, !folder.isEmpty else { throw StackControlError.invalid("Pass folder: the project folder commands run in by default") }
    let root = (folder as NSString).expandingTildeInPath
    guard root.hasPrefix("/") else { throw StackControlError.invalid("folder must be an absolute path or start with ~") }
    let file: URL
    do { file = try WorkspaceDefinitionWriter.createWorkspace(name: name, root: root, id: params["id"]?.stringValue, directory: supervisor.definitionsDirectory) }
    catch { throw StackControlError(code: "invalid_definition", message: error.localizedDescription) }
    await supervisor.reloadDefinitions()
    let id = file.deletingPathExtension().lastPathComponent
    guard let created = supervisor.files.first(where: { $0.id == id }) else { return .object(["created": .string(id), "file": .string(file.path)]) }
    var result = try definitionResult(created)
    result["created"] = .string(id)
    result["file"] = .string(file.path)
    return .object(result)
  }

  /// The saved definition and service status; run history stays in workspace_details.
  private func definitionResult(_ file: StackDefinitionFile) throws -> [String: JSONValue] {
    ["workspace": try JSONValue(encoding: stackSnapshot(file)), "tasks": try JSONValue(encoding: file.definition?.tasks ?? []),
      "workflows": try JSONValue(encoding: file.definition?.workflows ?? [])]
  }

  /// The workspace's file and a definition parsed from its current contents, so edits never merge onto a stale reload.
  private func editableWorkspace(_ params: JSONValue, actor: StackActor) throws -> (StackDefinitionFile, StackDefinition, String) {
    let file = try workspaceFile(params)
    if let lane = file.lane {
      throw StackControlError(code: "lane", message: lane.pinned
        ? "\(file.name) is a pinned lane that keeps the definition saved when it was created. Unpin it (unpin_lane) so it follows \(lane.sourceStackID), then edit \(lane.sourceStackID)."
        : "\(file.name) is a worktree lane and follows \(lane.sourceStackID). Edit \(lane.sourceStackID) for components and [lanes] defaults; use update_lane for this lane's name or environment overrides.")
    }
    try checkClaim(file.id, actor: actor, force: params["force"]?.boolValue == true)
    let source: String
    do { source = try String(contentsOf: file.file, encoding: .utf8) }
    catch { throw StackControlError.notFound("Cannot read \(file.file.path): \(error.localizedDescription)") }
    let loaded = StackDefinitionLoader.load(source, file: file.file)
    guard let definition = loaded.definition else {
      throw StackControlError(code: "invalid_definition", message: "\(file.file.path) has errors. Fix them first: " + loaded.issues.map(\.message).joined(separator: "; "))
    }
    return (file, definition, source)
  }

  private func componentID(_ params: JSONValue, _ key: String) throws -> String {
    guard let id = params[key]?.stringValue?.trimmingCharacters(in: .whitespaces), StackDefinitionLoader.validID(id) else {
      throw StackControlError.invalid("Pass \(key): an id of letters, numbers, hyphens, or underscores")
    }
    return id
  }

  private func environment(_ value: JSONValue?) throws -> [String: String]? {
    guard let value, value != .null else { return nil }
    guard let object = value.objectValue else { throw StackControlError.invalid("env must be an object of NAME: \"value\" strings") }
    var result: [String: String] = [:]
    for (key, raw) in object {
      guard key.range(of: "^[A-Za-z_][A-Za-z0-9_]*$", options: .regularExpression) != nil else { throw StackControlError.invalid("Invalid environment variable name \(key)") }
      guard let text = raw.stringValue else { throw StackControlError.invalid("env.\(key) must be a string") }
      result[key] = text
    }
    return result
  }

  /// Optional repo id: a string sets it, "" or null clears it, absent keeps `current`.
  private func repoParameter(_ params: JSONValue, in definition: StackDefinition, current: String?) throws -> String? {
    guard let raw = params["repo"] else { return current }
    guard let id = raw.stringValue?.trimmingCharacters(in: .whitespaces), !id.isEmpty else { return nil }
    guard definition.repo(id) != nil else {
      throw StackControlError.notFound("Unknown repo \(id). Repos: " + definition.repos.map(\.id).joined(separator: ", "))
    }
    return id
  }

  private func isRunning(_ workspace: String, service: String) -> Bool {
    let runtime = supervisor.runtime(workspace, service)
    return runtime.phase.isActive || runtime.process != nil
  }

  private func saveService(_ params: JSONValue, in definition: StackDefinition, file: URL, source: String) throws -> String {
    let id = try componentID(params, "service")
    let existing = definition.service(id)
    var service = existing ?? ServiceDefinition(id: id, command: "", repo: nil, directory: definition.root)
    var changes: [(section: String, replacement: String)] = []
    if let command = params["cmd"]?.stringValue { service.command = command; service.raw?.command = nil }
    guard !service.command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw StackControlError.invalid("Pass cmd for a new service") }
    let previousRepo = service.repo
    service.repo = try repoParameter(params, in: definition, current: service.repo)
    var base = service.repo.flatMap { definition.repo($0)?.path } ?? definition.root
    if let cwd = params["cwd"]?.stringValue, !cwd.isEmpty {
      service.directory = StackDefinitionLoader.resolve(cwd, relativeTo: base)
    } else if existing == nil || service.repo != previousRepo {
      service.directory = base
    }
    // Like Add project: a new service in a Git working tree also tracks that folder's branch.
    if existing == nil, service.repo == nil, params["add_repo"]?.boolValue != false,
      FileManager.default.fileExists(atPath: service.directory.appendingPathComponent(".git").path) {
      if let match = definition.repos.first(where: { $0.path.standardizedFileURL.path == service.directory.standardizedFileURL.path }) {
        service.repo = match.id
      } else if definition.repo(id) == nil {
        changes.append(("repos." + id, WorkspaceDefinitionWriter.repo(id: id, path: service.directory)))
        service.repo = id
      }
      if service.repo != nil { base = service.directory }
    }
    if let dependencies = params["depends_on"]?.stringsValue { service.dependencies = dependencies }
    if let raw = params["port"] {
      if raw == .null || raw.intValue == 0 { service.port = nil }
      else {
        guard let port = raw.intValue, (1...65535).contains(port) else { throw StackControlError.invalid("port must be an integer from 1 to 65535") }
        service.port = port
      }
    }
    if let ports = params["ports"]?.objectValue {
      var named: [String: Int] = [:]
      for (name, value) in ports {
        guard StackDefinitionLoader.validID(name), let port = value.intValue, (1...65535).contains(port) else {
          throw StackControlError.invalid("ports must map names to integers from 1 to 65535")
        }
        named[name] = port
      }
      service.ports = named
    }
    if let ready = params["ready"]?.stringValue?.trimmingCharacters(in: .whitespaces) {
      service.raw?.readyHTTP = nil; service.raw?.readyPort = nil
      let named = ready.lowercased().hasPrefix("port:") ? String(ready.dropFirst(5)).trimmingCharacters(in: .whitespaces) : ""
      if StackTemplates.containsTemplate(ready) { service.raw = (service.raw ?? StackRawValues()); service.raw?.readyHTTP = ready }
      else if !named.isEmpty, Int(named) == nil {
        guard let port = service.allPorts[named] else { throw StackControlError.invalid("ready port:\(named) names no port of \(id)") }
        service.readiness = .port(port)
        service.raw = (service.raw ?? StackRawValues()); service.raw?.readyPort = named
      } else { service.readiness = try readiness(ready) }
    } else if existing == nil, let port = service.port {
      service.readiness = .port(port)
    }
    if let seconds = params["ready_timeout"]?.doubleValue {
      guard seconds.isFinite, seconds > 0, seconds <= 3600 else { throw StackControlError.invalid("ready_timeout must be greater than 0 and at most 3600 seconds") }
      service.readyTimeout = seconds
    }
    if let environment = try environment(params["env"]) { service.environment = environment; service.raw?.environment = [:] }
    if let autostart = params["autostart"]?.boolValue { service.autostart = autostart }
    if let raw = params["lane"] {
      if raw == .null || raw.stringValue == "" { service.laneMode = nil }
      else if let mode = raw.stringValue.flatMap(StackServiceLaneMode.init(rawValue:)) { service.laneMode = mode }
      else { throw StackControlError.invalid("lane must be isolate, shared or off") }
    }
    changes.append(("services." + id, WorkspaceDefinitionWriter.service(service, base: base)))
    try WorkspaceDefinitionWriter.save(file: file, original: source, changes: changes)
    return "services." + id
  }

  private func readiness(_ text: String) throws -> StackReadiness {
    let lower = text.lowercased()
    if lower.isEmpty || lower == "none" || lower == "alive" { return .alive }
    if lower.hasPrefix("http://") || lower.hasPrefix("https://") {
      guard let url = URL(string: text), url.host != nil else { throw StackControlError.invalid("ready URL is not valid") }
      return .http(url)
    }
    if lower.hasPrefix("port:") {
      guard let port = Int(text.dropFirst(5).trimmingCharacters(in: .whitespaces)), (1...65535).contains(port) else {
        throw StackControlError.invalid("ready port must be an integer from 1 to 65535")
      }
      return .port(port)
    }
    if lower.hasPrefix("log:") {
      let pattern = String(text.dropFirst(4)).trimmingCharacters(in: .whitespaces)
      guard !pattern.isEmpty, (try? NSRegularExpression(pattern: pattern)) != nil else { throw StackControlError.invalid("ready log pattern is not a valid regular expression") }
      return .log(pattern)
    }
    throw StackControlError.invalid("ready must be port:<port>, an http(s) URL, log:<regex>, or none")
  }

  private func saveTask(_ params: JSONValue, in definition: StackDefinition, file: URL, source: String) throws -> String {
    let id = try componentID(params, "task")
    let existing = definition.task(id)
    var converted: ServiceDefinition?
    if let serviceID = params["from_service"]?.stringValue {
      guard let service = definition.service(serviceID) else { throw StackControlError.notFound("Unknown service \(serviceID)") }
      guard existing == nil else { throw StackControlError.invalid("Task \(id) already exists. Choose a different task id.") }
      guard workspaceRunner.activeRun(definition.id) == nil, !isRunning(definition.id, service: serviceID) else {
        throw StackControlError(code: "busy", message: "Stop \(serviceID) and finish active runs before moving it to Tasks")
      }
      converted = service
    }
    var task = existing ?? WorkspaceTaskDefinition(id: id, name: params["name"]?.stringValue ?? id, command: converted?.command ?? "",
      repo: converted?.repo, directory: converted?.directory ?? definition.root, environment: converted?.environment ?? [:],
      requiresServices: converted?.dependencies ?? [])
    if let name = params["name"]?.stringValue, !name.trimmingCharacters(in: .whitespaces).isEmpty { task.name = name }
    if let command = params["cmd"]?.stringValue { task.command = command; task.raw?.command = nil }
    guard !task.command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw StackControlError.invalid("Pass cmd for a new task") }
    let previousRepo = task.repo
    task.repo = try repoParameter(params, in: definition, current: task.repo)
    let base = task.repo.flatMap { definition.repo($0)?.path } ?? definition.root
    if let cwd = params["cwd"]?.stringValue, !cwd.isEmpty { task.directory = StackDefinitionLoader.resolve(cwd, relativeTo: base) }
    else if task.repo != previousRepo { task.directory = base }
    if let services = params["requires_services"]?.stringsValue { task.requiresServices = services }
    if let seconds = params["timeout"]?.doubleValue {
      guard seconds.isFinite, seconds > 0, seconds <= 3600 else { throw StackControlError.invalid("timeout must be greater than 0 and at most 3600 seconds") }
      task.timeout = seconds
    }
    if let environment = try environment(params["env"]) { task.environment = environment; task.raw?.environment = [:] }
    var changes: [(section: String, replacement: String)] = [("tasks." + id, WorkspaceDefinitionWriter.task(task))]
    if let converted {
      changes.insert(("services." + converted.id, ""), at: 0)
      do { try WorkspaceDefinitionWriter.save(file: file, original: source, changes: changes) }
      catch StackError.message(let message) where !message.hasPrefix("This workspace changed") {
        throw StackError.message("Update references to \(converted.id) before moving it to Tasks: " + message)
      }
    } else {
      try WorkspaceDefinitionWriter.save(file: file, original: source, changes: changes)
    }
    return "tasks." + id
  }

  private func saveWorkflow(_ params: JSONValue, in definition: StackDefinition, file: URL, source: String) throws -> String {
    let id = try componentID(params, "workflow")
    var workflow = definition.workflow(id) ?? WorkspaceWorkflowDefinition(id: id, name: id, steps: [])
    if let name = params["name"]?.stringValue, !name.trimmingCharacters(in: .whitespaces).isEmpty { workflow.name = name }
    if let steps = params["steps"]?.stringsValue { workflow.steps = steps }
    guard !workflow.steps.isEmpty else { throw StackControlError.invalid("Pass steps, e.g. [\"task:lint\", \"start:api\", \"task:test\"]") }
    if let cleanup = params["cleanup_services"]?.boolValue { workflow.cleanupServices = cleanup }
    try WorkspaceDefinitionWriter.save(file: file, original: source, section: "workflows." + id, replacement: WorkspaceDefinitionWriter.workflow(workflow))
    return "workflows." + id
  }

  private func deleteItem(_ params: JSONValue, in definition: StackDefinition, file: URL, source: String) throws -> String {
    let kinds = ["service": "services", "task": "tasks", "workflow": "workflows"]
    guard let kind = params["kind"]?.stringValue?.lowercased(), let table = kinds[kind] else {
      throw StackControlError.invalid("kind must be service, task, or workflow")
    }
    let id = try componentID(params, "id")
    let exists: Bool
    switch kind {
    case "service": exists = definition.service(id) != nil
    case "task": exists = definition.task(id) != nil
    default: exists = definition.workflow(id) != nil
    }
    guard exists else { throw StackControlError.notFound("\(definition.name) has no \(kind) \(id)") }
    if kind == "service", isRunning(definition.id, service: id) {
      throw StackControlError(code: "busy", message: "Stop \(id) before deleting it")
    }
    do { try WorkspaceDefinitionWriter.save(file: file, original: source, section: table + "." + id, replacement: "") }
    catch StackError.message(let message) where !message.hasPrefix("This workspace changed") {
      throw StackError.message("Update references to \(kind) \(id) first: " + message)
    }
    return table + "." + id
  }
}
