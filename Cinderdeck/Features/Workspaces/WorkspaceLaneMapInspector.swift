import SwiftUI

struct WorkspaceLaneMapInspector: View {
  let node: WorkspaceLaneGraph.Node
  let graph: WorkspaceLaneGraph
  @ObservedObject var model: StacksViewModel
  let tint: Color
  let select: (WorkspaceLaneGraph.ID) -> Void
  @State private var copied = false

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 10) {
        Image(systemName: WorkspaceLaneMapStyle.icon(node)).foregroundColor(tint).font(.title3)
        VStack(alignment: .leading, spacing: 3) {
          Text(node.title).font(.system(size: 14, weight: .semibold)).lineLimit(1).help(node.title)
          if node.isSharedResource {
            let consumers = graph.traced(from: node.id, direction: .consumers)
            let count = graph.nodes.filter { $0.isLane && consumers.contains($0.id) }.count
            Text("Shared service · used by \(count) \(count == 1 ? "checkout" : "checkouts")")
              .font(.system(size: 10)).foregroundColor(.secondary)
          } else { WorkspaceMapEyebrow(text: node.kind + " details") }
        }
        WorkspaceMapStatus(node: node).padding(.leading, 4)
        Spacer(minLength: 4)
        if let endpoint = node.endpoint {
          Button { NSWorkspace.shared.open(endpoint) } label: { Label("Open URL", systemImage: "arrow.up.right") }
            .help(endpoint.absoluteString).disabled(node.process == nil)
        }
        if let service = node.serviceID {
          Button { model.showLogs(stack: node.workspaceID, service: service) } label: { Label("Logs", systemImage: "terminal") }
        }
        if model.files.contains(where: { $0.id == node.workspaceID }) {
          Button(node.runID != nil ? "View run" : "Open checkout") {
            model.select(node.workspaceID)
            model.requestedSection = node.runID != nil ? .runs : .services
          }
        }
      }.controlSize(.small)
      if let warning = node.warning {
        Label(warning, systemImage: "exclamationmark.triangle.fill")
          .font(.system(size: 11)).foregroundColor(.orange).lineLimit(2).help(warning).textSelection(.enabled)
      }
      HStack(alignment: .top, spacing: 20) {
        ScrollView {
          VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 16) {
              if let process = node.process {
                fact("PID", String(process.pid))
                fact("GROUP", String(process.pgid))
              }
              if let port = node.endpoint?.port { fact("PORT", String(port)) }
              if let owner = node.owner { fact("OWNER", owner) }
            }
            if let command = node.command {
              HStack(alignment: .top, spacing: 6) {
                Text("$").foregroundColor(tint)
                Text(command).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                Button {
                  NSPasteboard.general.clearContents(); NSPasteboard.general.setString(command, forType: .string)
                  copied = true
                } label: { Image(systemName: copied ? "checkmark" : "doc.on.doc") }
                  .buttonStyle(.plain).help(copied ? "Copied" : "Copy command").accessibilityLabel("Copy command")
              }.font(.system(size: 10, design: .monospaced)).padding(9)
                .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 6))
            } else {
              Text(node.subtitle).font(.system(size: 11, design: .monospaced)).foregroundColor(.secondary).textSelection(.enabled)
            }
            if let directory = node.directory {
              Button { NSWorkspace.shared.open(URL(fileURLWithPath: directory)) } label: {
                Label(directory, systemImage: "folder").font(.system(size: 10)).lineLimit(1).truncationMode(.middle)
              }.buttonStyle(.plain).foregroundColor(.secondary).help("Open " + directory)
            }
          }.frame(maxWidth: .infinity, alignment: .leading)
        }.frame(maxWidth: .infinity)
        Divider()
        connections.frame(width: 230)
      }.frame(height: 98)
    }.padding(14)
      .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 12))
      .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(tint.opacity(0.25)))
      .onChange(of: node.id) { _ in copied = false }
      .accessibilityElement(children: .contain).accessibilityIdentifier("workspace.map.inspector")
  }

  private var connections: some View {
    let outgoing = graph.edges.filter { $0.from == node.id }
    let incoming = graph.edges.filter { $0.to == node.id }
    return ScrollView {
      VStack(alignment: .leading, spacing: 7) {
        WorkspaceMapEyebrow(text: "Connections")
        if outgoing.isEmpty && incoming.isEmpty {
          Text("No connected processes yet.").font(.caption).foregroundColor(.secondary)
        }
        ForEach(outgoing) { edge in connection(edge.to, label: edge.kind == .sequence ? "Next" : edge.kind == .contains ? "Owns" : "Uses", icon: "arrow.up.right") }
        ForEach(incoming) { edge in connection(edge.from, label: edge.kind == .sequence ? "After" : edge.kind == .contains ? "In" : "Used by", icon: "arrow.down.right") }
      }.frame(maxWidth: .infinity, alignment: .leading)
    }
  }
  @ViewBuilder private func connection(_ id: WorkspaceLaneGraph.ID, label: String, icon: String) -> some View {
    if let target = graph.nodes.first(where: { $0.id == id }) {
      Button { select(id) } label: {
        HStack(spacing: 6) {
          Image(systemName: icon).foregroundColor(tint)
          Text(label).foregroundColor(.secondary)
          Text(target.title).foregroundColor(.primary).lineLimit(1)
          Spacer(minLength: 0)
        }.font(.system(size: 10))
      }.buttonStyle(.plain).help(target.subtitle)
    }
  }
  private func fact(_ label: String, _ value: String) -> some View {
    VStack(alignment: .leading, spacing: 3) {
      WorkspaceMapEyebrow(text: label)
      Text(value).font(.system(size: 10, design: .monospaced)).lineLimit(1).help(value).textSelection(.enabled)
    }
  }
}
