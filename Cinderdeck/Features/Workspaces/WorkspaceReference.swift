import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// A small, readable snapshot for an editor chat or bug report. Build it at the
/// start of a drag/copy so paths and runtime status belong to the selected lane.
struct WorkspaceReference {
  let file: StackDefinitionFile
  var statuses: [URL: GitRepoStatus] = [:]
  var state = StackRuntimeState()

  var text: String {
    var lines = ["Cinderdeck workspace: \(file.name)", "Workspace ID: \(file.id)"]
    if let lane = file.lane {
      lines += ["Source workspace: \(lane.sourceStackID)", "Lane: \(lane.name)", "Lane folder: \(lane.directory.path)"]
    }
    lines.append("Definition: \(file.file.path)")
    guard let workspace = file.definition else {
      lines.append("Definition unavailable; inspect the workspace in Cinderdeck.")
      return lines.joined(separator: "\n")
    }
    lines += ["Project folder: \(workspace.root.path)", "Services status: \(state.label)"]
    if !workspace.repos.isEmpty {
      lines += ["", "Repositories:"]
      for repo in workspace.repos {
        lines.append("- \(repo.id): \(repo.path.path)")
        if let status = statuses[repo.path], status.error == nil {
          lines.append("  Branch: \(status.branchLabel)\(status.isDirty ? " (uncommitted changes)" : "")")
        }
      }
    }
    if !workspace.services.isEmpty || !workspace.links.isEmpty {
      lines += ["", "Services (configured addresses):"]
      for service in workspace.services {
        let phase = state.services[service.id]?.phase ?? .stopped
        lines.append("- \(service.id): \(phase.rawValue); folder: \(service.directory.path)")
        var ports = service.allPorts
        if ports[""] == nil, case .port(let port) = service.readiness { ports[""] = port }
        appendAddresses(ports, host: workspace.host, to: &lines)
      }
      for link in workspace.links {
        lines.append("- \(link.id): linked to \(link.stack)/\(link.service)\(link.shared ? " (shared)" : "")")
        var ports = link.ports
        if let port = link.port { ports[""] = port }
        appendAddresses(ports, host: link.host, to: &lines)
      }
    }
    return lines.joined(separator: "\n")
  }

  func itemProvider() -> NSItemProvider {
    let provider = NSItemProvider()
    let data = Data(text.utf8)
    provider.registerDataRepresentation(forTypeIdentifier: UTType.utf8PlainText.identifier, visibility: .all) { completion in
      completion(data, nil)
      return nil
    }
    provider.suggestedName = file.name
    return provider
  }

  func copy() {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
  }

  private func appendAddresses(_ ports: [String: Int], host: String, to lines: inout [String]) {
    for name in ports.keys.sorted() {
      guard let port = ports[name] else { continue }
      lines.append("  \(name.isEmpty ? "URL" : name): http://\(host):\(port)")
    }
  }
}

private struct WorkspaceReferenceDragModifier: ViewModifier {
  let file: StackDefinitionFile
  @ObservedObject var model: StacksViewModel

  func body(content: Content) -> some View {
    content
      .onDrag {
        WorkspaceReference(file: file, statuses: model.repoStatuses, state: model.states[file.id] ?? .init()).itemProvider()
      } preview: {
        Label(file.name, systemImage: file.lane == nil ? "square.stack.3d.up" : "arrow.triangle.branch")
          .padding(10).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))
      }
      .accessibilityHint("Drag to an editor or chat to share a workspace reference")
  }
}

extension View {
  func workspaceReferenceDrag(_ file: StackDefinitionFile, model: StacksViewModel) -> some View {
    modifier(WorkspaceReferenceDragModifier(file: file, model: model))
  }
}

struct WorkspaceReferenceCopyButton: View {
  let file: StackDefinitionFile
  @ObservedObject var model: StacksViewModel

  var body: some View {
    Button("Copy workspace reference") {
      WorkspaceReference(file: file, statuses: model.repoStatuses, state: model.states[file.id] ?? .init()).copy()
    }
  }
}
