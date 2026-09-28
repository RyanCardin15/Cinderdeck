import SwiftUI

struct WorkspaceLaneMapView: View {
  @ObservedObject var model: StacksViewModel
  @ObservedObject var runner: WorkspaceRunner
  @State private var selection: WorkspaceLaneGraph.ID?
  @State private var zoom: CGFloat = 1
  private var sourceID: String { model.selectedWorkspaceID ?? model.selectedStackID ?? "" }

  var body: some View {
    let graph = WorkspaceLaneGraph(workspaceID: sourceID, files: model.files, navigation: model.workspaceNavigation,
      states: model.states, statuses: model.repoStatuses, runs: runner.runs)
    let layout = WorkspaceLaneMapLayout(graph: graph)
    let connected = selection.map { graph.connected(to: $0) }
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        VStack(alignment: .leading, spacing: 4) {
          Text("Lane map").font(.title3.bold())
          Text("\(graph.nodes.filter(\.isLane).count) checkouts · \(graph.nodes.filter { $0.serviceID != nil }.count) services")
            .font(.caption).foregroundColor(.secondary)
        }
        Spacer()
        if selection != nil {
          Button("Show all") { selection = nil }.accessibilityIdentifier("workspace.map.clear")
        }
        Button { zoom = max(0.4, zoom - 0.15) } label: { Image(systemName: "minus.magnifyingglass") }
          .help("Zoom out").accessibilityLabel("Zoom out").disabled(zoom <= 0.4)
        Button("\(Int(zoom * 100))%") { zoom = 1 }.monospacedDigit().help("Reset zoom")
        Button { zoom = min(1.6, zoom + 0.15) } label: { Image(systemName: "plus.magnifyingglass") }
          .help("Zoom in").accessibilityLabel("Zoom in").disabled(zoom >= 1.6)
      }
      GeometryReader { proxy in
        ZStack(alignment: .topTrailing) {
          ScrollView([.horizontal, .vertical]) {
            ZStack(alignment: .topLeading) {
              Canvas { context, _ in
                for edge in graph.edges {
                  guard let start = layout.frames[edge.from], let end = layout.frames[edge.to] else { continue }
                  let highlighted = connected.map { $0.contains(edge.from) && $0.contains(edge.to) } ?? false
                  let dimmed = connected != nil && !highlighted
                  let color = highlighted ? Color.accentColor : Color.secondary
                  let from = CGPoint(x: start.maxX, y: start.midY)
                  let to = CGPoint(x: end.minX - 5, y: end.midY)
                  let bend = max(36, abs(to.x - from.x) * 0.5)
                  var path = Path()
                  path.move(to: from)
                  path.addCurve(to: to, control1: CGPoint(x: from.x + bend, y: from.y), control2: CGPoint(x: to.x - bend, y: to.y))
                  context.stroke(path, with: .color(color.opacity(dimmed ? 0.1 : highlighted ? 0.85 : 0.35)),
                    style: StrokeStyle(lineWidth: highlighted ? 2.5 : 1.5, dash: edge.kind == .depends ? [5, 4] : []))
                  var arrow = Path()
                  arrow.move(to: CGPoint(x: to.x - 6, y: to.y - 4))
                  arrow.addLine(to: to)
                  arrow.addLine(to: CGPoint(x: to.x - 6, y: to.y + 4))
                  context.stroke(arrow, with: .color(color.opacity(dimmed ? 0.1 : 0.8)), lineWidth: highlighted ? 2 : 1.5)
                }
              }.accessibilityHidden(true)
              ForEach(graph.nodes) { node in
                if let frame = layout.frames[node.id] {
                  block(node, connected: connected)
                    .frame(width: frame.width, height: frame.height)
                    .position(x: frame.midX, y: frame.midY)
                }
              }
            }
            .frame(width: layout.size.width, height: layout.size.height)
            .scaleEffect(zoom, anchor: .topLeading)
            .frame(width: layout.size.width * zoom, height: layout.size.height * zoom, alignment: .topLeading)
            .padding(16)
          }
          .accessibilityIdentifier("workspace.map.canvas")
          Button("Fit") {
            zoom = min(1, max(0.4, min((proxy.size.width - 32) / layout.size.width, (proxy.size.height - 32) / layout.size.height)))
          }.padding(10).help("Fit the map in view")
        }
        .background(Color(nsColor: .textBackgroundColor).opacity(0.55), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.secondary.opacity(0.15)))
      }.frame(minHeight: 180)
      HStack(spacing: 18) {
        Label("Contains / next step", systemImage: "arrow.right")
        HStack(spacing: 5) {
          Path { $0.move(to: .zero); $0.addLine(to: CGPoint(x: 22, y: 0)) }
            .stroke(style: StrokeStyle(lineWidth: 1.5, dash: [4, 3])).frame(width: 22, height: 1).accessibilityHidden(true)
          Text("Uses a service")
        }
        Spacer()
        Text("Live services and active runs").foregroundColor(.secondary)
      }.font(.caption).foregroundColor(.secondary)
      if let node = graph.nodes.first(where: { $0.id == selection }) {
        inspector(node, graph: graph)
      } else {
        Text("Select a lane to trace what it runs and the services it uses. Select any process for its command, ports, and process ID.")
          .font(.callout).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
      }
    }
    .onAppear { if model.selectedStackID != sourceID, let id = model.selectedStackID { selection = .lane(id) } }
    .onChange(of: model.selectedStackID) { id in
      selection = id.flatMap { $0 == sourceID ? nil : .lane($0) }
    }
    .onChange(of: graph.nodes.map(\.id)) { ids in if let selection, !ids.contains(selection) { self.selection = nil } }
  }

  private func block(_ node: WorkspaceLaneGraph.Node, connected: Set<WorkspaceLaneGraph.ID>?) -> some View {
    let selected = selection == node.id
    let highlighted = connected?.contains(node.id) == true
    return Button { selection = selected ? nil : node.id } label: {
      VStack(alignment: .leading, spacing: 7) {
        HStack(spacing: 7) {
          Image(systemName: node.isLane ? "arrow.triangle.branch" : node.serviceID != nil ? "server.rack" : "terminal")
            .foregroundColor(node.isLane ? .accentColor : .secondary)
          Text(node.title).font(.system(.callout, weight: .semibold)).lineLimit(1)
          Spacer(minLength: 0)
        }
        Text(node.subtitle).font(.caption).foregroundColor(.secondary).lineLimit(2)
          .frame(maxWidth: .infinity, alignment: .leading)
        Spacer(minLength: 0)
        HStack(spacing: 5) {
          Circle().fill(statusColor(node)).frame(width: 6, height: 6)
          Text(node.status).font(.caption.weight(.medium)).lineLimit(1)
          Spacer(minLength: 0)
          if let service = node.serviceID,
             let pid = model.states[node.workspaceID]?.services[service]?.process?.pid {
            Text("PID \(String(pid))").font(.system(.caption2, design: .monospaced)).foregroundColor(.secondary)
          }
        }
      }
      .padding(13)
      .background(selected ? Color.accentColor.opacity(0.12) : Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
      .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(
        selected || highlighted ? Color.accentColor.opacity(selected ? 1 : 0.55) : Color.secondary.opacity(0.22), lineWidth: selected ? 2 : 1))
      .contentShape(RoundedRectangle(cornerRadius: 10))
    }
    .buttonStyle(.plain)
    .opacity(connected == nil || highlighted ? 1 : 0.3)
    .help([node.title, node.subtitle, node.status, node.detail].joined(separator: "\n"))
    .accessibilityLabel([node.title, node.subtitle, node.status].joined(separator: ", "))
    .accessibilityValue(selected ? "Selected" : highlighted ? "Connected" : "")
    .accessibilityIdentifier(node.isLane ? "workspace.map.lane.\(node.workspaceID)" : "workspace.map.node.\(node.workspaceID).\(node.serviceID ?? node.title)")
  }

  private func inspector(_ node: WorkspaceLaneGraph.Node, graph: WorkspaceLaneGraph) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text(node.title).font(.headline)
        Text(node.status).font(.caption).foregroundColor(statusColor(node))
        Spacer()
        if node.serviceID != nil {
          Button("Logs") { model.showLogs(stack: node.workspaceID, service: node.serviceID) }
        }
        if model.files.contains(where: { $0.id == node.workspaceID }) {
          Button(node.runID != nil ? "View runs" : "Open checkout") {
            model.select(node.workspaceID)
            model.requestedSection = node.runID != nil ? .runs : .services
          }
        }
      }
      ScrollView {
        VStack(alignment: .leading, spacing: 8) {
          Text(node.detail.isEmpty ? node.subtitle : node.detail).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
          let dependencies = graph.edges.filter { $0.from == node.id }.compactMap { edge -> String? in
            guard let target = graph.nodes.first(where: { $0.id == edge.to }) else { return nil }
            return "\(edge.kind.rawValue.capitalized) → \(target.title) · \(target.subtitle.replacingOccurrences(of: "\n", with: ", "))"
          }
          if !dependencies.isEmpty { Text(dependencies.joined(separator: "\n")).font(.caption).foregroundColor(.secondary).textSelection(.enabled) }
        }.frame(maxWidth: .infinity, alignment: .leading)
      }.frame(maxHeight: 115)
    }.padding(12).stackSurface(cornerRadius: 10)
  }

  private func statusColor(_ node: WorkspaceLaneGraph.Node) -> Color {
    if node.phase == .crashed || node.runStatus == .failed || node.status == "Needs attention" || node.status == "Unavailable" { return .red }
    if node.phase == .unhealthy || node.phase == .waiting { return .orange }
    if node.isActive || node.status == "Running" { return .green }
    if node.runStatus == .succeeded { return .green }
    return .secondary
  }
}

/// Topological columns put dependencies after their consumers. Malformed or
/// cyclic definitions remain inspectable in a final column instead of hanging.
struct WorkspaceLaneMapLayout {
  var frames: [WorkspaceLaneGraph.ID: CGRect] = [:]
  var size = CGSize(width: 280, height: 150)
  init(graph: WorkspaceLaneGraph) {
    var remaining = Set(graph.nodes.map(\.id))
    var ranks: [WorkspaceLaneGraph.ID: Int] = [:]
    while !remaining.isEmpty {
      let ready = graph.nodes.filter { node in
        remaining.contains(node.id) && !graph.edges.contains { $0.to == node.id && remaining.contains($0.from) }
      }
      if ready.isEmpty {
        let rank = (ranks.values.max() ?? 0) + 1
        for id in remaining { ranks[id] = rank }
        break
      }
      for node in ready {
        ranks[node.id] = graph.edges.filter { $0.to == node.id }.compactMap { ranks[$0.from].map { $0 + 1 } }.max() ?? 0
        remaining.remove(node.id)
      }
    }
    for column in 0...max(0, ranks.values.max() ?? 0) {
      let nodes = graph.nodes.filter { ranks[$0.id] == column }
      var nextY: CGFloat = 12
      for node in nodes {
        let parents = graph.edges.filter { $0.to == node.id }.compactMap { frames[$0.from]?.midY }
        let desiredY = parents.isEmpty ? nextY : parents.reduce(0, +) / CGFloat(parents.count) - 58
        let frame = CGRect(x: CGFloat(column) * 310 + 12, y: max(nextY, desiredY), width: 246, height: 116)
        frames[node.id] = frame
        nextY = frame.maxY + 22
        size.width = max(size.width, frame.maxX + 12)
        size.height = max(size.height, frame.maxY + 12)
      }
    }
  }
}
