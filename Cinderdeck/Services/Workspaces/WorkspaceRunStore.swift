import Foundation

@MainActor
final class WorkspaceRunStore {
  let directory: URL
  init(directory: URL) { self.directory = directory }
  static var defaultDirectory: URL {
    #if DEBUG
    if let root = StackPreviewHarness.root { return root.appendingPathComponent("Runs") }
    #endif
    return StackControlPaths.directory.appendingPathComponent("Runs")
  }
  private var index: URL { directory.appendingPathComponent("runs.json") }
  func load() throws -> [WorkspaceRun] {
    guard FileManager.default.fileExists(atPath: index.path) else { return [] }
    return try StackControlCoding.decoder().decode([WorkspaceRun].self, from: Data(contentsOf: index))
  }
  func save(_ runs: [WorkspaceRun]) throws {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    try StackControlCoding.encoder(pretty: true).encode(runs).write(to: index, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: index.path)
  }
  func logURL(_ run: UUID, _ step: UUID) -> URL {
    directory.appendingPathComponent(run.uuidString).appendingPathComponent(step.uuidString + ".log")
  }
  func removeLogs(_ run: UUID) throws {
    let url = directory.appendingPathComponent(run.uuidString)
    if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
  }
}
