import Foundation

/// Loads workspace definitions and lanes together, then resolves what spans
/// workspaces: `depends_on = ["backend:api"]` links and `{{port.backend:api}}`
/// templates. A lane prefers the other workspace's lane on the same branch.
nonisolated enum StackWorkspaceResolver {
  static func load(_ directory: URL) throws -> [StackDefinitionFile] {
    let bases = try StackDefinitionLoader.loadDirectory(directory)
    let lanes = try StackLaneStore.files(in: StackLaneStore.directory(for: directory), sources: bases)
    return resolve(bases + lanes)
  }

  /// The definition `definition` should use for `workspace`.
  static func target(_ workspace: String, for definition: StackDefinition, in files: [StackDefinitionFile]) -> StackDefinition? {
    if let lane = definition.lane,
      let match = files.first(where: { $0.definition?.lane?.sourceStackID == workspace && $0.definition?.lane?.name == lane.name })?.definition {
      return match
    }
    return files.first { $0.id == workspace && $0.lane == nil }?.definition
  }

  static func resolve(_ input: [StackDefinitionFile]) -> [StackDefinitionFile] {
    var files = input
    for index in files.indices {
      guard var definition = files[index].definition else { continue }
      var errors: [String] = []
      definition.links.removeAll(where: \.isExternal)
      for service in definition.services {
        for dependency in service.dependencies where dependency.contains(":") && definition.link(dependency) == nil {
          let parts = dependency.split(separator: ":", maxSplits: 1).map(String.init)
          guard parts.count == 2, let target = target(parts[0], for: definition, in: input) else {
            errors.append("services.\(service.id) depends on \(dependency), but workspace \(parts.first ?? dependency) is missing or has errors")
            continue
          }
          if let other = target.service(parts[1]) {
            definition.links.append(StackServiceLink(id: dependency, stack: target.id, service: other.id,
              port: other.port, ports: other.ports, host: target.host, shared: false))
          } else if let link = target.link(parts[1]), !link.isExternal {
            definition.links.append(StackServiceLink(id: dependency, stack: link.stack, service: link.service,
              port: link.port, ports: link.ports, host: link.host, shared: false))
          } else {
            errors.append("services.\(service.id) depends on \(dependency), but \(target.name) has no service \(parts[1])")
          }
        }
      }
      let snapshot = definition
      let context = StackTemplates.context(for: definition) { workspace, name, port in
        guard let target = target(workspace, for: snapshot, in: input) else { throw StackError.message("unknown workspace \(workspace)") }
        if let service = target.service(name) {
          guard let value = service.allPorts[port] else { throw StackError.message("\(workspace):\(name) has no \(port.isEmpty ? "port" : "port named " + port)") }
          return .value(port: value, host: target.host)
        }
        if let link = target.link(name), !link.isExternal {
          var ports = link.ports
          if let primary = link.port { ports[""] = primary }
          guard let value = ports[port] else { throw StackError.message("\(workspace):\(name) has no \(port.isEmpty ? "port" : "port named " + port)") }
          return .value(port: value, host: link.host)
        }
        throw StackError.message("\(workspace) has no service \(name)")
      }
      errors += StackTemplates.apply(to: &definition, context: context)
      if errors.isEmpty {
        files[index].definition = definition
      } else {
        files[index].issues += errors.map { .init(severity: .error, message: $0) }
        files[index].definition = nil
      }
    }
    return files
  }
}
