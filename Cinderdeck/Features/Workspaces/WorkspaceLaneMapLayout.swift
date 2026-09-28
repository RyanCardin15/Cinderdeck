import CoreGraphics
import Foundation

/// Lane bands keep a checkout's processes together. Shared processes get a
/// separate rail; workflow length no longer pushes every service farther right.
struct WorkspaceLaneMapLayout {
  struct Band: Identifiable {
    let id: String
    let title: String
    let frame: CGRect
    var shared = false
  }
  static let cardSize = CGSize(width: 224, height: 128)
  static let column: CGFloat = 284
  var frames: [WorkspaceLaneGraph.ID: CGRect] = [:]
  var bands: [Band] = []
  var size = CGSize(width: 540, height: 200)

  init(graph: WorkspaceLaneGraph) {
    let resources = Set(graph.sharedServices.map(\.id))
    let lanes = graph.nodes.filter(\.isLane)
    // Focus on an external process may have no checkout card.
    let workspaceIDs = lanes.map(\.workspaceID) + Set(graph.nodes.filter { !resources.contains($0.id) }
      .map(\.workspaceID)).subtracting(lanes.map(\.workspaceID)).sorted()
    var y: CGFloat = 48
    var widest = 1
    for workspace in workspaceIDs {
      let lane = graph.nodes.first { $0.id == .lane(workspace) }
      let services = graph.nodes.filter { $0.workspaceID == workspace && $0.serviceID != nil && !resources.contains($0.id) }
      let runs = graph.nodes.filter { node in
        guard node.workspaceID == workspace else { return false }
        if case .run = node.id { return true }
        return false
      }
      let steps = graph.nodes.filter { node in
        guard node.workspaceID == workspace else { return false }
        if case .step = node.id { return true }
        return false
      }
      let top = y
      var nextY = y + 42
      // Local service dependencies are layered separately from workflow steps.
      var ranks: [WorkspaceLaneGraph.ID: Int] = [:]
      var remaining = Set(services.map(\.id))
      while !remaining.isEmpty {
        let ready = services.filter { node in
          remaining.contains(node.id) && !graph.edges.contains { $0.to == node.id && remaining.contains($0.from) }
        }
        if ready.isEmpty { for id in remaining { ranks[id] = 0 }; break }
        for node in ready {
          ranks[node.id] = graph.edges.filter { $0.to == node.id }.compactMap { ranks[$0.from].map { $0 + 1 } }.max() ?? 0
          remaining.remove(node.id)
        }
      }
      var columnY: [Int: CGFloat] = [:]
      for service in services {
        let column = (ranks[service.id] ?? 0) + 1
        let rowY = columnY[column] ?? nextY
        place(service.id, column: column, y: rowY)
        columnY[column] = rowY + Self.cardSize.height + 20
        widest = max(widest, column)
      }
      if let bottom = columnY.values.max() { nextY = bottom }
      for run in runs {
        place(run.id, column: 1, y: nextY)
        let runSteps = steps.filter { $0.runID == run.runID }
        for (index, step) in runSteps.enumerated() {
          place(step.id, column: 2, y: nextY + CGFloat(index) * (Self.cardSize.height + 20))
        }
        widest = max(widest, runSteps.isEmpty ? 1 : 2)
        nextY += CGFloat(max(1, runSteps.count)) * (Self.cardSize.height + 20)
      }
      // A focused step can outlive its parent in the projected graph.
      for step in steps where frames[step.id] == nil {
        place(step.id, column: 1, y: nextY)
        nextY += Self.cardSize.height + 20
      }
      let height = max(Self.cardSize.height + 66, nextY - top + 4)
      if let lane { place(lane.id, column: 0, y: top + 42) }
      bands.append(.init(id: workspace, title: lane?.title ?? workspace,
        frame: CGRect(x: 12, y: top, width: 0, height: height)))
      y = top + height + 16
    }
    let resourceColumn = max(2, widest + 1)
    let contentWidth = CGFloat(widest + 1) * Self.column + 12
    for index in bands.indices { // Fill the lane backgrounds up to the resource rail.
      let band = bands[index]
      bands[index] = .init(id: band.id, title: band.title,
        frame: CGRect(x: band.frame.minX, y: band.frame.minY, width: contentWidth - 12, height: band.frame.height))
    }
    var resourceY: CGFloat = 90
    for node in graph.nodes where resources.contains(node.id) {
      place(node.id, column: resourceColumn, y: resourceY)
      resourceY += Self.cardSize.height + 24
    }
    if !resources.isEmpty {
      bands.append(.init(id: "shared-resources", title: "Shared & external",
        frame: CGRect(x: CGFloat(resourceColumn) * Self.column + 12, y: 48,
          width: Self.cardSize.width + 32, height: max(194, max(y - 64, resourceY - 48))), shared: true))
    }
    size = CGSize(width: max(540, (frames.values.map(\.maxX).max() ?? 500) + 28),
      height: max(200, (bands.map(\.frame.maxY).max() ?? 180) + 16))
  }

  private mutating func place(_ id: WorkspaceLaneGraph.ID, column: Int, y: CGFloat) {
    frames[id] = CGRect(origin: CGPoint(x: CGFloat(column) * Self.column + 28, y: y), size: Self.cardSize)
  }
}
