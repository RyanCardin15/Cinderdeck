import Foundation

nonisolated enum StackServicePhase: String, Codable, Sendable {
  case stopped, waiting, starting, ready, unhealthy, stopping, crashed
  var isActive: Bool { [.waiting, .starting, .ready, .unhealthy, .stopping].contains(self) }
  var permitsDependents: Bool { self == .ready || self == .unhealthy }
  var label: String {
    switch self {
    case .ready: return "Ready"
    case .unhealthy: return "Readiness failing"
    default: return rawValue.capitalized
    }
  }
}

nonisolated struct StackServiceRuntime: Sendable {
  var phase: StackServicePhase = .stopped
  var process: StackProcessIdentity?
  var startedAt: Date?
  var restartCount = 0
  var lastCrashedAt: Date?
  var detail: String?
  var conflict: StackPortConflict?
  var launchDefinition: StackLaunchDefinition?
}

nonisolated struct StackRuntimeState: Sendable {
  var services: [String: StackServiceRuntime] = [:]
  var operation: String?
  var error: String?

  var isActive: Bool { services.values.contains { $0.phase.isActive || $0.process != nil } }
  var label: String {
    let phases = services.values.map(\.phase)
    if phases.contains(.stopping) { return "Stopping" }
    if phases.contains(.crashed) || phases.contains(.unhealthy) { return "Degraded" }
    if phases.contains(.starting) || phases.contains(.waiting) { return "Starting" }
    if phases.contains(.ready) { return "Running" }
    return "Stopped"
  }
  var startedAt: Date? { services.values.compactMap(\.startedAt).min() }
}

nonisolated struct StackRestartPolicy {
  private(set) var attempts: [Date] = []
  mutating func delay(now: Date = Date()) -> TimeInterval? {
    attempts.removeAll { now.timeIntervalSince($0) >= 60 }
    guard attempts.count < 3 else { return nil }
    let delay = pow(2, Double(attempts.count))
    attempts.append(now)
    return delay
  }
}
