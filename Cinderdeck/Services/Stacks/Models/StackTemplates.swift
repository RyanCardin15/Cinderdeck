import Foundation

/// `{{…}}` values in commands, environment values and readiness URLs. They are
/// rendered for the original checkout and again for every lane, so one definition
/// describes both. Only the namespaces below are templates; anything else, such
/// as Go's `{{.State}}`, is left as written.
nonisolated enum StackTemplates {
  static let namespaces: Set<String> = ["port", "url", "host", "lane", "repo", "workspace"]

  /// A service or port another value refers to: `{{port.api}}`, `{{url.web.hmr}}`, `{{port.backend:api}}`.
  struct ServiceReference: Equatable, Hashable, Sendable {
    var workspace: String?
    var service: String
    var port: String?
  }

  enum Lookup: Sendable {
    case value(port: Int, host: String)
    /// Leave the token as written (another workspace, before workspaces are resolved together).
    case deferred
  }

  struct Context {
    var workspace: String
    var host: String
    var lane: StackLaneInfo?
    var repos: [String: URL]
    /// A service of this workspace (or a link) and one of its ports ("" for the primary port).
    var port: (_ service: String, _ port: String) throws -> Int
    var external: (_ workspace: String, _ service: String, _ port: String) throws -> Lookup
  }

  static func containsTemplate(_ text: String) -> Bool {
    tokens(in: text).contains { $0.namespace != nil }
  }

  /// Every service another value refers to, for dependency discovery and validation.
  static func references(in text: String) -> [ServiceReference] {
    tokens(in: text).compactMap { token in
      guard let namespace = token.namespace, namespace == "port" || namespace == "url" else { return nil }
      return try? serviceReference(token.path)
    }
  }

  static func render(_ text: String, _ context: Context) throws -> String {
    var result = ""
    var cursor = text.startIndex
    for token in tokens(in: text) {
      result += text[cursor..<token.range.lowerBound]
      cursor = token.range.upperBound
      guard token.namespace != nil else { result += text[token.range]; continue }
      guard let value = try value(token, context) else { result += text[token.range]; continue }
      switch token.modifier {
      case "-": result += value.isEmpty ? token.argument : value
      case "+": result += value.isEmpty ? "" : token.argument
      default: result += value
      }
    }
    result += text[cursor...]
    return result
  }

  // MARK: Parsing

  private struct Token {
    var range: Range<String.Index>
    var namespace: String?
    var path: String
    var modifier: Character?
    var argument: String
    var key: String { (namespace ?? "") + path }
  }

  private static func tokens(in text: String) -> [Token] {
    var result: [Token] = []
    var search = text.startIndex
    while let open = text.range(of: "{{", range: search..<text.endIndex),
      let close = text.range(of: "}}", range: open.upperBound..<text.endIndex) {
      let body = text[open.upperBound..<close.lowerBound].trimmingCharacters(in: .whitespaces)
      var key = body, modifier: Character?, argument = ""
      if let marker = body.range(of: ":-") ?? body.range(of: ":+") {
        key = String(body[..<marker.lowerBound]).trimmingCharacters(in: .whitespaces)
        modifier = body[body.index(after: marker.lowerBound)]
        argument = String(body[marker.upperBound...])
      }
      let head = key.prefix { $0.isLetter }
      let namespace = namespaces.contains(String(head)) && (key.count == head.count || [".", ":"].contains(key[head.endIndex]))
        ? String(head) : nil
      result.append(Token(range: open.lowerBound..<close.upperBound, namespace: namespace,
        path: namespace == nil ? key : String(key.dropFirst(head.count)), modifier: modifier, argument: argument))
      search = close.upperBound
    }
    return result
  }

  /// `.api`, `.web.hmr`, `.backend:api`, `.backend:api.hmr`.
  private static func serviceReference(_ path: String) throws -> ServiceReference {
    guard path.hasPrefix(".") else { throw StackError.message("needs a service, e.g. {{port.api}}") }
    var rest = String(path.dropFirst())
    var workspace: String?
    if let colon = rest.firstIndex(of: ":") {
      workspace = String(rest[..<colon]); rest = String(rest[rest.index(after: colon)...])
    }
    let parts = rest.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
    guard (1...2).contains(parts.count), parts.allSatisfy(StackDefinitionLoader.validID),
      workspace.map(StackDefinitionLoader.validID) ?? true else {
      throw StackError.message("use {{port.<service>}}, {{port.<service>.<port name>}} or {{port.<workspace>:<service>}}")
    }
    return ServiceReference(workspace: workspace, service: parts[0], port: parts.count == 2 ? parts[1] : nil)
  }

  private static func value(_ token: Token, _ context: Context) throws -> String? {
    func fail(_ reason: String) -> Error { StackError.message("{{\(token.key)}}: \(reason)") }
    switch token.namespace {
    case "host":
      guard token.path.isEmpty else { throw fail("use {{host}}") }
      return context.host
    case "workspace":
      guard token.path.isEmpty else { throw fail("use {{workspace}}") }
      return context.workspace
    case "lane":
      let slug = context.lane?.effectiveSlug
      switch token.path {
      case ".slug": return slug ?? ""
      case ".ident": return slug.map(StackLaneInfo.ident) ?? ""
      case ".name": return context.lane?.name ?? ""
      case ".dir": return context.lane?.directory.path ?? ""
      default: throw fail("use lane.slug, lane.ident, lane.name or lane.dir")
      }
    case "repo":
      let id = String(token.path.dropFirst())
      guard token.path.hasPrefix("."), let path = context.repos[id] else {
        throw fail("unknown repo. Repos: " + context.repos.keys.sorted().joined(separator: ", "))
      }
      return path.path
    case "port", "url":
      let reference: ServiceReference
      do { reference = try serviceReference(token.path) } catch { throw fail(error.localizedDescription) }
      let port: Int, host: String
      do {
        if let workspace = reference.workspace {
          switch try context.external(workspace, reference.service, reference.port ?? "") {
          case .deferred: return nil
          case .value(let value, let name): port = value; host = name
          }
        } else {
          port = try context.port(reference.service, reference.port ?? ""); host = context.host
        }
      } catch { throw fail(error.localizedDescription) }
      return token.namespace == "port" ? String(port) : "http://\(host):\(port)"
    default: return nil
    }
  }

  // MARK: Rendering definitions

  /// Renders every templated value of `definition` for `context`. Values without
  /// templates are left alone; raw text is kept so the result can be rendered again.
  static func apply(to definition: inout StackDefinition, context: Context) -> [String] {
    var errors: [String] = []
    func render(_ text: String, _ field: String) -> String? {
      do { return try StackTemplates.render(text, context) } catch { errors.append("\(field): \(error.localizedDescription)"); return nil }
    }
    for (key, raw) in definition.rawEnvironment { if let value = render(raw, "env.\(key)") { definition.environment[key] = value } }
    if var settings = definition.laneSettings {
      for (key, raw) in settings.rawEnvironment { if let value = render(raw, "lanes.env.\(key)") { settings.environment[key] = value } }
      definition.laneSettings = settings
    }
    for index in definition.services.indices {
      let service = definition.services[index]
      guard let raw = service.raw else { continue }
      let prefix = "services.\(service.id)"
      if let command = raw.command, let value = render(command, prefix + ".cmd") { definition.services[index].command = value }
      for (key, text) in raw.environment { if let value = render(text, prefix + ".env.\(key)") { definition.services[index].environment[key] = value } }
      if let name = raw.readyPort {
        if let port = service.allPorts[name] { definition.services[index].readiness = .port(port) }
        else { errors.append("\(prefix).ready.port: no port named \(name)") }
      }
      if let text = raw.readyHTTP, let value = render(text, prefix + ".ready.http") {
        if let url = URL(string: value), ["http", "https"].contains(url.scheme), url.host != nil {
          definition.services[index].readiness = .http(url)
        } else if !containsTemplate(value) {
          errors.append("\(prefix).ready.http renders to \(value), which is not an http(s) URL")
        }
      }
    }
    for index in definition.tasks.indices {
      let task = definition.tasks[index]
      guard let raw = task.raw else { continue }
      let prefix = "tasks.\(task.id)"
      if let command = raw.command, let value = render(command, prefix + ".cmd") { definition.tasks[index].command = value }
      for (key, text) in raw.environment { if let value = render(text, prefix + ".env.\(key)") { definition.tasks[index].environment[key] = value } }
    }
    return errors
  }

  /// A context for one workspace. `external` resolves `{{port.<workspace>:<service>}}`.
  static func context(for definition: StackDefinition,
    external: @escaping (String, String, String) throws -> Lookup = { _, _, _ in .deferred }) -> Context {
    let services = definition.services
    let links = definition.links
    return Context(workspace: definition.sourceID, host: definition.host, lane: definition.lane,
      repos: Dictionary(definition.repos.map { ($0.id, $0.path) }, uniquingKeysWith: { first, _ in first }),
      port: { name, port in
        if let service = services.first(where: { $0.id == name }) {
          if let value = service.allPorts[port] { return value }
          throw StackError.message(port.isEmpty ? "\(name) has no port" : "\(name) has no port named \(port)")
        }
        if let link = links.first(where: { $0.id == name }) {
          if port.isEmpty, let value = link.port { return value }
          if let value = link.ports[port] { return value }
          throw StackError.message(port.isEmpty ? "\(name) has no port" : "\(name) has no port named \(port)")
        }
        throw StackError.message("unknown service \(name)")
      },
      external: external)
  }
}
