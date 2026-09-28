import SwiftUI

enum WorkspaceLaneMapStyle {
  static let resource = Color.teal
  static func tint(_ workspace: String, source: String, lanes: [String]) -> Color {
    if workspace == source { return .orange }
    let colors: [Color] = [.cyan, .mint, .blue, .pink, .yellow]
    let index = lanes.filter { $0 != source }.firstIndex(of: workspace) ?? 0
    return colors[index % colors.count]
  }
  static func status(_ node: WorkspaceLaneGraph.Node) -> Color {
    if node.needsAttention { return node.phase == .crashed || node.runStatus == .failed ? .red : .orange }
    if node.phase == .starting || node.phase == .waiting || node.phase == .stopping || node.runStatus == .queued { return .orange }
    if node.isActive || node.runStatus == .succeeded { return .green }
    return .secondary
  }
  static func icon(_ node: WorkspaceLaneGraph.Node) -> String {
    switch node.id {
    case .lane: return "arrow.triangle.branch"
    case .service: return node.isSharedResource ? "externaldrive.connected.to.line.below" : "server.rack"
    case .run: return "play.rectangle"
    case .step: return "terminal"
    }
  }
}

struct WorkspaceMapEyebrow: View {
  let text: String
  var body: some View {
    Text(text.uppercased()).font(.system(size: 9, weight: .semibold, design: .monospaced)).tracking(1.4).foregroundColor(.secondary)
  }
}

struct WorkspaceMapStatus: View {
  let node: WorkspaceLaneGraph.Node
  var body: some View {
    HStack(spacing: 5) {
      Image(systemName: node.needsAttention ? "exclamationmark.circle.fill" : node.isActive ? "circle.fill" : "circle")
        .font(.system(size: node.needsAttention ? 10 : 6))
      Text(node.status).font(.system(size: 10, weight: .medium)).lineLimit(1)
    }.foregroundColor(WorkspaceLaneMapStyle.status(node))
  }
}

struct WorkspaceLaneMapBlock: View {
  let node: WorkspaceLaneGraph.Node
  let tint: Color
  let selected: Bool
  let connected: Bool
  let dimmed: Bool
  let connectionCount: Int
  let select: () -> Void
  @Environment(\.colorScheme) private var scheme
  @State private var hovered = false

  var body: some View {
    Button(action: select) {
      VStack(alignment: .leading, spacing: 9) {
        HStack(spacing: 8) {
          Image(systemName: WorkspaceLaneMapStyle.icon(node)).font(.system(size: 13, weight: .semibold))
            .foregroundColor(tint).frame(width: 28, height: 28)
            .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 7))
          VStack(alignment: .leading, spacing: 3) {
            WorkspaceMapEyebrow(text: node.isSharedResource ? "Shared service" : node.kind)
            Text(node.title).font(.system(size: 12, weight: .semibold)).foregroundColor(.primary).lineLimit(1)
          }
          Spacer(minLength: 0)
          if selected { Image(systemName: "scope").font(.caption).foregroundColor(tint) }
        }
        Text(node.subtitle).font(.system(size: 10, design: node.isLane ? .monospaced : .default))
          .foregroundColor(.secondary).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
        Spacer(minLength: 0)
        HStack {
          WorkspaceMapStatus(node: node)
          Spacer(minLength: 4)
          if let process = node.process {
            Text("\(String(process.pid))").font(.system(size: 9, design: .monospaced)).foregroundColor(.secondary)
          } else if node.isLane {
            Label(String(connectionCount), systemImage: "point.3.connected.trianglepath.dotted")
              .font(.system(size: 9, design: .monospaced)).foregroundColor(.secondary)
          }
        }
      }
      .padding(13)
      .background(scheme == .dark ? Color(red: 0.105, green: 0.12, blue: 0.145) : Color(nsColor: .controlBackgroundColor),
        in: RoundedRectangle(cornerRadius: 12))
      .background(tint.opacity(0.07), in: RoundedRectangle(cornerRadius: 12))
      .overlay(alignment: .leading) {
        RoundedRectangle(cornerRadius: 2).fill(tint.opacity(selected || connected || node.isLane ? 1 : 0.45))
          .frame(width: 3).padding(.vertical, 16)
      }
      .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(
        selected ? tint : connected || hovered ? tint.opacity(0.65) : Color.primary.opacity(0.12), lineWidth: selected ? 2 : 1))
      .shadow(color: selected ? tint.opacity(0.13) : .black.opacity(scheme == .dark ? 0.2 : 0.05), radius: selected ? 12 : 4, y: 3)
      .contentShape(RoundedRectangle(cornerRadius: 12))
    }
    .buttonStyle(.plain).onHover { hovered = $0 }
    .opacity(dimmed ? 0.26 : 1)
    .help([node.title, node.subtitle, node.status, node.detail].joined(separator: "\n"))
    .accessibilityLabel([node.title, node.subtitle, node.status].joined(separator: ", "))
    .accessibilityValue(selected ? "Selected" : connected ? "Connected" : "")
    .accessibilityIdentifier(node.isLane ? "workspace.map.lane.\(node.workspaceID)" : "workspace.map.node.\(node.workspaceID).\(node.serviceID ?? node.title)")
  }
}
