import SwiftUI

struct WorkspaceLaneMapView: View {
  @ObservedObject var model: StacksViewModel
  @ObservedObject var runner: WorkspaceRunner
  @State private var selection: WorkspaceLaneGraph.ID?
  @State private var direction = WorkspaceLaneGraph.Trace.dependencies
  @State private var focus = false
  @State private var zoom: CGFloat = 0.85
  @State private var query = ""
  @State private var showOverview = true
  @State private var jump: WorkspaceMapScrollRequest?
  @State private var fitRequest = UUID()
  @FocusState private var searching: Bool
  @Environment(\.colorScheme) private var scheme
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  private var sourceID: String { model.selectedWorkspaceID ?? model.selectedStackID ?? "" }

  var body: some View {
    let graph = WorkspaceLaneGraph(workspaceID: sourceID, files: model.files, navigation: model.workspaceNavigation,
      states: model.states, statuses: model.repoStatuses, runs: runner.runs)
    let visible = focus ? graph.focused(on: selection, direction: direction) : graph
    let layout = WorkspaceLaneMapLayout(graph: visible)
    let connected = selection.map { graph.traced(from: $0, direction: direction) }
    let lanes = graph.nodes.filter(\.isLane)
    let selectedOnRight = selection.flatMap { layout.frames[$0]?.midX }.map { $0 > layout.size.width / 2 } ?? false
    VStack(alignment: .leading, spacing: 14) {
      header(graph)
      toolbar(graph)
      if !query.isEmpty { searchResults(graph) }
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 8) {
          Button { clear() } label: { Label("All checkouts", systemImage: "square.grid.2x2") }
            .buttonStyle(.bordered).tint(selection == nil ? .accentColor : .secondary)
            .accessibilityIdentifier("workspace.map.clear")
          ForEach(lanes) { lane in
            Button { choose(lane.id) } label: {
              HStack(spacing: 6) {
                Circle().fill(tint(lane.workspaceID, lanes: lanes)).frame(width: 6, height: 6)
                Text(lane.title).lineLimit(1)
                if lane.needsAttention { Image(systemName: "exclamationmark.circle").foregroundColor(.orange) }
              }
            }.buttonStyle(.bordered).tint(selection == lane.id ? tint(lane.workspaceID, lanes: lanes) : .secondary)
              .contextMenu {
                if let file = model.files.first(where: { $0.id == lane.workspaceID }) { StackLaneDeletionMenu(file: file, model: model) }
              }
          }
        }.font(.system(size: 11, weight: .medium)).controlSize(.small)
      }
      GeometryReader { viewport in
        ZStack(alignment: selectedOnRight ? .bottomLeading : .bottomTrailing) {
          ScrollView([.horizontal, .vertical]) {
            WorkspaceLaneMapCanvas(graph: visible, layout: layout, sourceID: sourceID, laneIDs: lanes.map(\.workspaceID),
              selection: selection, connected: connected, zoom: zoom, select: choose,
              removableLanes: Set(model.files.filter { $0.lane != nil && !model.isBusy($0.id) }.map(\.id)),
              deleteLane: { id in if let file = model.files.first(where: { $0.id == id }) { model.deleteLane(file) } })
              .background(WorkspaceMapScrollTarget(request: jump, frame: jump.flatMap { layout.frames[$0.node] }, zoom: zoom))
              .padding(8)
          }.accessibilityIdentifier("workspace.map.canvas")
          if showOverview && (layout.size.width * zoom > viewport.size.width || layout.size.height * zoom > viewport.size.height) {
            WorkspaceLaneMapOverview(graph: visible, layout: layout, selection: selection, connected: connected,
              color: { tint($0, lanes: lanes) }, select: choose)
              .padding(12)
          }
        }
        .background(scheme == .dark ? Color(red: 0.065, green: 0.077, blue: 0.095) : Color(nsColor: .textBackgroundColor),
          in: RoundedRectangle(cornerRadius: 16))
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.primary.opacity(0.1)))
        .onChange(of: fitRequest) { _ in
          zoom = max(0.25, min(1.25, (viewport.size.width - 24) / layout.size.width))
          if let selection { jump = WorkspaceMapScrollRequest(node: selection) }
        }
      }.frame(minHeight: 170)
      HStack(spacing: 14) {
        legend("Owns / next step", dashed: false)
        legend("Depends on", dashed: true)
        Spacer()
        Text(focus ? "FOCUSED · \(visible.nodes.count) BLOCKS" : "\(visible.diagramEdges.count) CONNECTIONS")
          .font(.system(size: 9, weight: .medium, design: .monospaced)).tracking(0.7)
        if selection != nil { Button("Clear selection") { clear() }.font(.caption).keyboardShortcut(.escape, modifiers: []) }
      }.foregroundColor(.secondary)
      if let node = graph.nodes.first(where: { $0.id == selection }) {
        WorkspaceLaneMapInspector(node: node, graph: graph, model: model,
          tint: node.isSharedResource ? WorkspaceLaneMapStyle.resource : tint(node.workspaceID, lanes: lanes), select: choose)
          .transition(.opacity)
      } else {
        HStack(spacing: 8) {
          Image(systemName: "cursorarrow.rays").foregroundColor(.accentColor)
          Text("Select a checkout to trace its world. Select a service to see what depends on it.")
            .font(.system(size: 11)).foregroundColor(.secondary)
          Spacer()
          Button("Manage lanes") { model.lanesSheet = true }.font(.system(size: 11))
        }.padding(.vertical, 3)
      }
    }
    .animation(reduceMotion ? nil : .easeInOut(duration: 0.18), value: focus)
    .onAppear { if model.selectedStackID != sourceID, let id = model.selectedStackID { selection = .lane(id) } }
    .onChange(of: model.selectedStackID) { id in
      selection = id.flatMap { $0 == sourceID ? nil : .lane($0) }; direction = .dependencies
      if let selection { jump = WorkspaceMapScrollRequest(node: selection) } else { focus = false; jump = nil }
    }
    .onChange(of: graph.nodes.map(\.id)) { ids in if let selection, !ids.contains(selection) { clear() } }
    .onChange(of: focus) { _ in fitRequest = UUID() }
    .onChange(of: direction) { _ in if focus { fitRequest = UUID() } }
    .onExitCommand { if !query.isEmpty { query = "" } else { clear() } }
  }

  private func header(_ graph: WorkspaceLaneGraph) -> some View {
    HStack(alignment: .center, spacing: 24) {
      VStack(alignment: .leading, spacing: 5) {
        HStack(spacing: 8) {
          WorkspaceMapEyebrow(text: "Workspace topology")
          HStack(spacing: 4) { Circle().fill(.green).frame(width: 4, height: 4); Text("LIVE").tracking(1) }
            .font(.system(size: 8, weight: .bold, design: .monospaced)).foregroundColor(.secondary)
        }
        Text("Execution map").font(.system(size: 25, weight: .bold, design: .rounded))
      }
      Spacer(minLength: 0)
      metric(graph.nodes.filter(\.isLane).count, "checkouts", .orange)
      metric(graph.processCount, "processes", .green)
      metric(graph.sharedServices.count, "shared", .teal)
      if let problem = graph.nodes.first(where: \.needsAttention) {
        Button { choose(problem.id) } label: {
          metric(graph.nodes.filter(\.needsAttention).count, "attention", .orange)
        }.buttonStyle(.plain).help("Inspect a block that needs attention")
      }
    }
  }
  private func metric(_ count: Int, _ label: String, _ color: Color) -> some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(String(count)).font(.system(size: 25, weight: .medium, design: .rounded)).monospacedDigit().foregroundColor(color)
      Text(label.uppercased()).font(.system(size: 8, weight: .medium, design: .monospaced)).tracking(1).foregroundColor(.secondary)
    }.accessibilityElement(children: .combine)
  }
  private func toolbar(_ graph: WorkspaceLaneGraph) -> some View {
    HStack(spacing: 8) {
      HStack(spacing: 6) {
        Button { searching = true } label: { Image(systemName: "magnifyingglass") }
          .buttonStyle(.plain).keyboardShortcut("f", modifiers: .command).accessibilityLabel("Find in map")
        TextField("Find a lane, process, or port", text: $query).textFieldStyle(.plain).focused($searching)
          .onSubmit { if let first = graph.matches(query).first { choose(first.id) } }
          .accessibilityIdentifier("workspace.map.search")
        if !query.isEmpty { Button { query = "" } label: { Image(systemName: "xmark.circle.fill") }.buttonStyle(.plain).accessibilityLabel("Clear search") }
      }.font(.system(size: 11)).padding(8).frame(minWidth: 150, maxWidth: 240)
        .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 8))
      Spacer(minLength: 0)
      if selection != nil {
        Picker("Trace direction", selection: $direction) {
          ForEach(WorkspaceLaneGraph.Trace.allCases, id: \.self) { Text($0.rawValue).tag($0) }
        }.pickerStyle(.segmented).labelsHidden().frame(width: 128).accessibilityIdentifier("workspace.map.trace")
      }
      Button { focus.toggle() } label: { Label(focus ? "Exit focus" : "Focus", systemImage: "scope") }
        .disabled(selection == nil).tint(focus ? .accentColor : .secondary)
        .help("Show only the selected block and its traced connections").accessibilityIdentifier("workspace.map.focus")
      Menu {
        Button("Zoom in") { zoom = min(1.6, zoom + 0.15) }
        Button("Zoom out") { zoom = max(0.25, zoom - 0.15) }
        Button("Actual size") { zoom = 1 }
        Button("Fit width") { fitRequest = UUID() }
        Divider()
        Toggle("Show overview", isOn: $showOverview)
      } label: { Text("\(Int(zoom * 100))%") .monospacedDigit() }.frame(width: 68).help("Zoom and overview")
      Button { fitRequest = UUID() } label: { Image(systemName: "arrow.up.left.and.arrow.down.right") }
        .help("Fit map width").accessibilityLabel("Fit map width").accessibilityIdentifier("workspace.map.fit")
    }.controlSize(.small)
  }
  private func searchResults(_ graph: WorkspaceLaneGraph) -> some View {
    let matches = graph.matches(query)
    return ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        Text(matches.isEmpty ? "No matching blocks" : "\(matches.count) found").foregroundColor(.secondary)
        ForEach(matches.prefix(12)) { node in
          Button { choose(node.id) } label: {
            Label("\(node.title) · \(node.subtitle.components(separatedBy: "\n").first ?? "")", systemImage: WorkspaceLaneMapStyle.icon(node))
          }.buttonStyle(.bordered)
        }
      }.font(.system(size: 11)).controlSize(.small)
    }
  }
  private func legend(_ title: String, dashed: Bool) -> some View {
    HStack(spacing: 5) {
      Path { $0.move(to: .zero); $0.addLine(to: CGPoint(x: 20, y: 0)) }
        .stroke(style: StrokeStyle(lineWidth: 1.5, dash: dashed ? [3, 3] : [])).frame(width: 20, height: 1).accessibilityHidden(true)
      Text(title).font(.system(size: 9))
    }
  }
  private func choose(_ id: WorkspaceLaneGraph.ID) {
    selection = id; query = ""; searching = false
    if case .lane = id { direction = .dependencies }
    jump = WorkspaceMapScrollRequest(node: id)
  }
  private func clear() { jump = nil; selection = nil; focus = false; direction = .dependencies; query = "" }
  private func tint(_ workspace: String, lanes: [WorkspaceLaneGraph.Node]) -> Color {
    WorkspaceLaneMapStyle.tint(workspace, source: sourceID, lanes: lanes.map(\.workspaceID), isReviewer: lanes.contains { $0.workspaceID == workspace && $0.isReviewerLane })
  }
}

private struct WorkspaceLaneMapOverview: View {
  let graph: WorkspaceLaneGraph
  let layout: WorkspaceLaneMapLayout
  let selection: WorkspaceLaneGraph.ID?
  let connected: Set<WorkspaceLaneGraph.ID>?
  let color: (String) -> Color
  let select: (WorkspaceLaneGraph.ID) -> Void
  var body: some View {
    let scale = min(152 / layout.size.width, 84 / layout.size.height)
    VStack(alignment: .leading, spacing: 6) {
      WorkspaceMapEyebrow(text: "Overview · click to jump")
      ZStack(alignment: .topLeading) {
        ForEach(graph.nodes) { node in
          if let frame = layout.frames[node.id] {
            Button { select(node.id) } label: {
              RoundedRectangle(cornerRadius: 2)
                .fill((node.isSharedResource ? WorkspaceLaneMapStyle.resource : color(node.workspaceID))
                  .opacity(connected?.contains(node.id) ?? true ? 0.7 : 0.15))
                .overlay(RoundedRectangle(cornerRadius: 2).strokeBorder(selection == node.id ? Color.primary : .clear, lineWidth: 1))
            }.buttonStyle(.plain)
              .frame(width: max(8, frame.width * scale), height: max(6, frame.height * scale))
              .position(x: frame.midX * scale, y: frame.midY * scale)
              .help(node.title).accessibilityLabel("Jump to \(node.title)")
          }
        }
      }.frame(width: layout.size.width * scale, height: layout.size.height * scale)
    }.padding(10).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))
      .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.primary.opacity(0.12)))
  }
}
