import SwiftUI

struct WorkspaceLaneMapCanvas: View {
  let graph: WorkspaceLaneGraph
  let layout: WorkspaceLaneMapLayout
  let sourceID: String
  let laneIDs: [String]
  let selection: WorkspaceLaneGraph.ID?
  let connected: Set<WorkspaceLaneGraph.ID>?
  let zoom: CGFloat
  let select: (WorkspaceLaneGraph.ID) -> Void
  let removableLanes: Set<String>
  let deleteLane: (String) -> Void
  @Environment(\.colorScheme) private var scheme
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    let byID = Dictionary(uniqueKeysWithValues: graph.nodes.map { ($0.id, $0) })
    let edges = graph.diagramEdges
    let hasActivity = edges.contains { byID[$0.from]?.hasLiveActivity == true && byID[$0.to]?.hasLiveActivity == true }
    ZStack(alignment: .topLeading) {
      Canvas { context, size in
        for x in stride(from: CGFloat(8), to: size.width, by: 24) {
          for y in stride(from: CGFloat(8), to: size.height, by: 24) {
            context.fill(Path(ellipseIn: CGRect(x: x, y: y, width: 1.5, height: 1.5)), with: .color(.secondary.opacity(0.18)))
          }
        }
      }.accessibilityHidden(true)
      HStack(spacing: 0) {
        columnLabel("01 / CHECKOUTS", width: WorkspaceLaneMapLayout.column * zoom)
        columnLabel("02 / SERVICES & RUNS", width: WorkspaceLaneMapLayout.column * 2 * zoom)
      }.padding(.leading, 28 * zoom).padding(.top, 14 * zoom).accessibilityHidden(true)
      ForEach(layout.bands) { band in
        let tint = band.shared ? WorkspaceLaneMapStyle.resource : color(band.id)
        RoundedRectangle(cornerRadius: 16)
          .fill(tint.opacity(scheme == .dark ? 0.035 : 0.04))
          .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(tint.opacity(0.13), lineWidth: 1))
          .overlay(alignment: .topLeading) {
            HStack(spacing: 7) {
              Circle().fill(tint).frame(width: 5, height: 5)
              Text(band.shared ? "SHARED & EXTERNAL" : band.title.uppercased())
                .font(.system(size: 9, weight: .semibold, design: .monospaced)).tracking(1).foregroundColor(tint)
                .lineLimit(1)
            }.padding(.horizontal, 16).padding(.top, 15)
          }
          .frame(width: band.frame.width * zoom, height: band.frame.height * zoom)
          .position(x: band.frame.midX * zoom, y: band.frame.midY * zoom).accessibilityHidden(true)
      }
      TimelineView(.animation(minimumInterval: 1.0 / 24, paused: reduceMotion || !hasActivity)) { timeline in
        Canvas { context, _ in
          context.scaleBy(x: zoom, y: zoom)
          for (index, edge) in edges.enumerated() {
            guard let start = layout.frames[edge.from], let end = layout.frames[edge.to] else { continue }
            let route = WorkspaceMapRoute(start: start, end: end)
            let highlighted = connected.map { $0.contains(edge.from) && $0.contains(edge.to) } ?? false
            let dimmed = connected != nil && !highlighted
            let tint = byID[edge.from].map { color($0.workspaceID) } ?? .secondary
            let active = byID[edge.from]?.hasLiveActivity == true && byID[edge.to]?.hasLiveActivity == true
            if highlighted {
              context.stroke(route.path, with: .color(tint.opacity(0.08)), lineWidth: 7)
            }
            context.stroke(route.path, with: .color(tint.opacity(dimmed ? 0.07 : highlighted ? 0.9 : 0.35)),
              style: StrokeStyle(lineWidth: highlighted ? 2 : 1.3, dash: edge.kind == .depends ? [5, 5] : []))
            context.fill(route.arrow, with: .color(tint.opacity(dimmed ? 0.08 : 0.7)))
            if active && !dimmed && !reduceMotion {
              let t = (timeline.date.timeIntervalSinceReferenceDate / 3.8 + Double(index) * 0.19).truncatingRemainder(dividingBy: 1)
              let point = route.point(at: t)
              context.fill(Path(ellipseIn: CGRect(x: point.x - 2.5, y: point.y - 2.5, width: 5, height: 5)),
                with: .color(tint.opacity(highlighted ? 1 : 0.65)))
            }
          }
        }
      }.accessibilityHidden(true).allowsHitTesting(false)
      ForEach(graph.nodes) { node in
        if let frame = layout.frames[node.id] {
          WorkspaceLaneMapBlock(node: node, tint: node.isSharedResource ? WorkspaceLaneMapStyle.resource : color(node.workspaceID),
            selected: selection == node.id, connected: connected?.contains(node.id) == true,
            dimmed: connected.map { !$0.contains(node.id) } ?? false,
            connectionCount: graph.edges.filter { $0.from == node.id }.count, select: { select(node.id) })
            .contextMenu {
              if node.isLane, removableLanes.contains(node.workspaceID) {
                Button("Delete lane…", role: .destructive) { deleteLane(node.workspaceID) }
                  .accessibilityIdentifier("workspace.lane.delete.\(node.workspaceID)")
              }
            }
            .frame(width: frame.width, height: frame.height)
            .scaleEffect(zoom)
            .frame(width: frame.width * zoom, height: frame.height * zoom)
            .position(x: frame.midX * zoom, y: frame.midY * zoom)
            .id(node.id)
        }
      }
    }.frame(width: layout.size.width * zoom, height: layout.size.height * zoom)
  }
  private func color(_ workspace: String) -> Color { WorkspaceLaneMapStyle.tint(workspace, source: sourceID, lanes: laneIDs) }
  private func columnLabel(_ title: String, width: CGFloat) -> some View {
    WorkspaceMapEyebrow(text: title).frame(width: width, alignment: .leading)
  }
}

/// Curves use the closest appropriate side. Vertical step sequences and return
/// dependencies have distinct routes instead of crossing through their cards.
struct WorkspaceMapRoute {
  let from: CGPoint
  let to: CGPoint
  let c1: CGPoint
  let c2: CGPoint
  let vertical: Bool
  init(start: CGRect, end: CGRect) {
    vertical = abs(start.midX - end.midX) < 10
    if vertical {
      let downward = end.midY > start.midY
      from = CGPoint(x: start.midX, y: downward ? start.maxY : start.minY)
      to = CGPoint(x: end.midX, y: downward ? end.minY - 5 : end.maxY + 5)
      c1 = CGPoint(x: from.x, y: (from.y + to.y) / 2)
      c2 = CGPoint(x: to.x, y: (from.y + to.y) / 2)
    } else if end.minX > start.minX {
      from = CGPoint(x: start.maxX, y: start.midY)
      to = CGPoint(x: end.minX - 5, y: end.midY)
      let bend = max(30, (to.x - from.x) * 0.5)
      c1 = CGPoint(x: from.x + bend, y: from.y)
      c2 = CGPoint(x: to.x - bend, y: to.y)
    } else {
      from = CGPoint(x: start.minX, y: start.midY)
      to = CGPoint(x: end.maxX + 5, y: end.midY)
      let bend = max(30, (from.x - to.x) * 0.5)
      c1 = CGPoint(x: from.x - bend, y: from.y)
      c2 = CGPoint(x: to.x + bend, y: to.y)
    }
  }
  var path: Path {
    var path = Path(); path.move(to: from); path.addCurve(to: to, control1: c1, control2: c2); return path
  }
  var arrow: Path {
    let angle = atan2(to.y - c2.y, to.x - c2.x)
    var path = Path(); path.move(to: to)
    path.addLine(to: CGPoint(x: to.x - 7 * cos(angle - .pi / 6), y: to.y - 7 * sin(angle - .pi / 6)))
    path.addLine(to: CGPoint(x: to.x - 7 * cos(angle + .pi / 6), y: to.y - 7 * sin(angle + .pi / 6)))
    path.closeSubpath(); return path
  }
  func point(at t: Double) -> CGPoint {
    let t = CGFloat(t), u = 1 - t
    return CGPoint(x: u*u*u*from.x + 3*u*u*t*c1.x + 3*u*t*t*c2.x + t*t*t*to.x,
      y: u*u*u*from.y + 3*u*u*t*c1.y + 3*u*t*t*c2.y + t*t*t*to.y)
  }
}
