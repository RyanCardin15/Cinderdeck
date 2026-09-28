import Foundation

/// One reader and bounded command deadlines. The consumer acknowledges frames
/// promptly and coalesces them into one pending frame outside the protocol reader.
actor BrowserCDPConnection {
  typealias EventHandler = @Sendable (String, JSONValue) async -> Void
  private let session: URLSession
  private let socket: URLSessionWebSocketTask
  private var reader: Task<Void, Never>?
  private var sequence = 0
  private var closed = false
  private var pending: [Int: CheckedContinuation<JSONValue, Error>] = [:]
  private var deadlines: [Int: Task<Void, Never>] = [:]

  init(url: URL) {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 20
    configuration.httpCookieStorage = nil
    configuration.urlCache = nil
    session = URLSession(configuration: configuration)
    socket = session.webSocketTask(with: url)
    socket.maximumMessageSize = 16 * 1024 * 1024
  }

  func start(onEvent: @escaping EventHandler, onDisconnect: @escaping @Sendable (String) async -> Void) {
    socket.resume()
    reader = Task { [weak self, socket] in
      do {
        while !Task.isCancelled {
          let message = try await socket.receive()
          let data: Data
          switch message {
          case .data(let bytes): data = bytes
          case .string(let text): data = Data(text.utf8)
          @unknown default: continue
          }
          let value = try autoreleasepool { try JSONDecoder().decode(JSONValue.self, from: data) }
          if let id = value["id"]?.intValue { await self?.resolve(id, value: value) }
          else if let method = value["method"]?.stringValue { await onEvent(method, value["params"] ?? .object([:])) }
        }
      } catch {
        guard let self, await !self.closed else { return }
        await self.close()
        await onDisconnect("Browser connection closed: \(error.localizedDescription)")
      }
    }
  }

  func call(_ method: String, _ params: [String: JSONValue] = [:], timeout: Double = 15) async throws -> JSONValue {
    try Task.checkCancellation()
    guard !closed else { throw StackControlError(code: "browser_disconnected", message: "The browser connection is closed") }
    guard pending.count < 64 else { throw StackControlError(code: "busy", message: "Too many browser commands are pending") }
    sequence += 1
    let id = sequence
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        pending[id] = continuation
        deadlines[id] = Task { [weak self] in
          try? await Task.sleep(for: .seconds(timeout))
          guard !Task.isCancelled else { return }
          await self?.reject(id, error: StackControlError(code: "browser_timeout", message: "Browser command \(method) timed out"))
        }
        Task {
          do { try await send(id: id, method: method, params: params) }
          catch { reject(id, error: error) }
        }
      }
    } onCancel: {
      Task { await self.reject(id, error: CancellationError()) }
    }
  }

  /// Frame acknowledgements must not await their response inside the event reader.
  func acknowledge(_ id: Int) async {
    guard !closed else { return }
    sequence += 1
    try? await send(id: sequence, method: "Page.screencastFrameAck", params: ["sessionId": .number(Double(id))])
  }

  private func send(id: Int, method: String, params: [String: JSONValue]) async throws {
    let data = try JSONEncoder().encode(JSONValue.object(["id": .number(Double(id)), "method": .string(method), "params": .object(params)]))
    try await socket.send(.string(String(decoding: data, as: UTF8.self)))
  }

  private func resolve(_ id: Int, value: JSONValue) {
    deadlines.removeValue(forKey: id)?.cancel()
    guard let continuation = pending.removeValue(forKey: id) else { return }
    if let error = value["error"] {
      continuation.resume(throwing: StackControlError(code: "browser_error", message: error["message"]?.stringValue ?? "Browser command failed"))
    } else { continuation.resume(returning: value["result"] ?? .object([:])) }
  }

  private func reject(_ id: Int, error: Error) {
    deadlines.removeValue(forKey: id)?.cancel()
    pending.removeValue(forKey: id)?.resume(throwing: error)
  }

  func close() {
    guard !closed else { return }
    closed = true
    reader?.cancel(); reader = nil
    socket.cancel(with: .goingAway, reason: nil)
    session.invalidateAndCancel()
    for id in Array(pending.keys) { reject(id, error: StackControlError(code: "browser_disconnected", message: "The browser connection is closed")) }
  }
}
