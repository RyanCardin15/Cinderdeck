import Foundation

/// The native process owns this pipe. No URLs, filesystem paths, or commands cross it.
nonisolated struct AgentShellMessage: Encodable, Sendable {
  let type: String
  var workspaceID: String?
  var section: String?
}

nonisolated struct AgentShellUIRequest: Decodable, Equatable, Sendable {
  let surface: String
  let mode: String?
  let workspaceID: String?

  static let surfaces: Set<String> = ["workspace", "lane-map", "history", "preferences", "capture", "recording", "annotate", "updates", "workspace-setup", "workspace-editor", "workspace-terminal", "execution-map", "agent-access"]
  static let workspaceEditorModes: Set<String> = ["services", "tasks", "workflows"]
  static let captureModes: Set<String> = ["region", "window", "fullscreen", "scrolling", "ocr"]

  static func decode(_ data: Data) throws -> AgentShellUIRequest {
    guard data.count <= 16_384,
      let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(value.keys).isSubset(of: ["surface", "mode", "workspaceID"]) else {
      throw StackControlError.invalid("Invalid native UI request")
    }
    let request = try JSONDecoder().decode(Self.self, from: data)
    guard surfaces.contains(request.surface),
      request.surface != "workspace-terminal" || (request.workspaceID != nil && request.mode == nil),
      request.surface != "agent-access" || (request.mode == nil && request.workspaceID == nil),
      request.mode.map({ !$0.isEmpty && $0.utf8.count <= 80 && !$0.contains(where: { $0.isNewline || $0.isASCII && $0.asciiValue! < 32 }) }) ?? true,
      request.workspaceID.map({ !$0.isEmpty && $0.utf8.count <= 512 && !$0.contains(where: { $0.isNewline || $0.isASCII && $0.asciiValue! < 32 }) }) ?? true else {
      throw StackControlError.invalid("Unsupported native UI request")
    }
    return request
  }
}

/// FileHandle callbacks may arrive off MainActor. Keep framing bounded before hopping to UI.
nonisolated final class AgentShellOutputFramer: @unchecked Sendable {
  private let lock = NSLock()
  private var buffer = Data()
  private var discarding = false
  private let onLine: @Sendable (Data) -> Void

  init(onLine: @escaping @Sendable (Data) -> Void) { self.onLine = onLine }

  func consume(_ data: Data) {
    lock.lock()
    var lines: [Data] = []
    for byte in data {
      if byte == 10 {
        if !discarding { lines.append(buffer) }
        buffer.removeAll(keepingCapacity: true)
        discarding = false
      } else if !discarding {
        if buffer.count < 16_384 { buffer.append(byte) }
        else { buffer.removeAll(keepingCapacity: true); discarding = true }
      }
    }
    lock.unlock()
    for line in lines { onLine(line) }
  }
}
