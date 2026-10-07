import Foundation

typealias StackLaneProgressHandler = @MainActor @Sendable (StackLaneCreationProgress) -> Void

nonisolated enum StackLaneCreationProgress: Equatable, Sendable {
  case checkingRepositories
  case preparingWorktrees([URL])
  case checkingOut(URL)
  case updatingSubmodules(URL)
  case repositoryReady(URL)
  case copyingFiles
  case savingLane
  case loadingWorkspace
  case runningSetup(String)
  case startingServices
  case recovering
}

nonisolated struct LaneCreationProgressState: Equatable, Sendable {
  var label = "Checking repositories…"
  var repositories: [URL: String] = [:]
  private var total = 0
  private var completed = Set<URL>()

  mutating func receive(_ progress: StackLaneCreationProgress) {
    switch progress {
    case .checkingRepositories: label = "Checking repositories…"
    case .preparingWorktrees(let roots):
      total = roots.count; completed = []
      repositories = Dictionary(uniqueKeysWithValues: roots.map { ($0, "Waiting for checkout…") })
      label = "Preparing \(total) repositories…"
    case .checkingOut(let root):
      repositories[root] = "Checking out files…"
      label = "Preparing repositories · \(completed.count) of \(total) ready"
    case .updatingSubmodules(let root):
      repositories[root] = "Initializing submodules…"
    case .repositoryReady(let root):
      repositories[root] = "Ready"
      completed.insert(root)
      label = "Preparing repositories · \(completed.count) of \(total) ready"
    case .copyingFiles: label = "Copying lane files…"
    case .savingLane: label = "Saving lane…"
    case .loadingWorkspace: label = "Loading workspace…"
    case .runningSetup(let reference): label = "Running setup (\(reference))…"
    case .startingServices: label = "Starting services…"
    case .recovering: label = "Cleaning up incomplete checkouts…"
    }
  }
}
