import AppKit
import ApplicationServices
import Foundation

// Background computer use for Mac apps. Reads an app's accessibility tree and
// acts on its elements without moving the user's pointer or activating the app:
// element actions go through Accessibility, and coordinate/keyboard input is
// posted to the target process only. Cinderdeck draws a separate agent cursor.
// JSONL over stdin/stdout, one JSON object per line, answered by request id.

enum Failure: String, Error {
  case accessibility_permission, screen_permission, post_event_permission, app_missing,
    app_blocked, window_missing, element_stale, element_missing, unsupported_action,
    invalid_input, screen_locked, not_settable, text_not_found, launch_failed, unavailable
}

struct Failed: Error {
  let reason: Failure
  let detail: String
  init(_ reason: Failure, _ detail: String = "") {
    self.reason = reason
    self.detail = detail
  }
}

private let output = DispatchQueue(label: "deckhand.computer-use.output")
func emit(_ value: [String: Any]) {
  guard JSONSerialization.isValidJSONObject(value),
    let data = try? JSONSerialization.data(withJSONObject: value)
  else { return }
  output.sync { FileHandle.standardOutput.write(data + Data([10])) }
}

/// Serializes work per key (one lane per app) while different apps run concurrently.
final class Lanes: @unchecked Sendable {
  private let lock = NSLock()
  private var tails: [String: (id: UUID, task: Task<Void, Never>)] = [:]
  private func completed(_ key: String, _ id: UUID) {
    lock.lock()
    defer { lock.unlock() }
    if tails[key]?.id == id { tails.removeValue(forKey: key) }
  }
  func run(_ key: String, _ operation: @escaping @Sendable () async -> Void) {
    lock.lock()
    let previous = tails[key]?.task
    let id = UUID()
    let task = Task.detached {
      await previous?.value
      await operation()
      self.completed(key, id)
    }
    tails[key] = (id, task)
    lock.unlock()
  }
}

struct Agent {
  let id: String
  let label: String
  init(_ raw: Any?) {
    let value = raw as? [String: Any] ?? [:]
    id = String((value["id"] as? String ?? "agent").prefix(120))
    label = String((value["label"] as? String ?? "Agent").prefix(60))
  }
}

func screenLocked() -> Bool {
  guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
  return session["CGSSessionScreenIsLocked"] as? Bool ?? false
}

func permissions() -> [String: Any] {
  [
    "accessibility": AXIsProcessTrusted(),
    "screenRecording": CGPreflightScreenCaptureAccess(),
    "postEvents": CGPreflightPostEventAccess(),
    "screenLocked": screenLocked(),
    "backgroundFocus": PrivateAPI.backgroundFocusAvailable,
  ]
}

func requireControl() throws {
  guard AXIsProcessTrusted() else { throw Failed(.accessibility_permission) }
  guard !screenLocked() else { throw Failed(.screen_locked) }
}

func handle(_ method: String, _ params: [String: Any]) async throws -> [String: Any] {
  let agent = Agent(params["agent"])
  switch method {
  case "permissions":
    return permissions()
  case "requestPermissions":
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    _ = AXIsProcessTrustedWithOptions(options)
    _ = CGRequestScreenCaptureAccess()
    _ = CGRequestPostEventAccess()
    return permissions()
  case "listApps":
    return ["apps": Apps.list()]
  case "resolveApp":
    let app = try await Apps.resolve(
      params["app"] as? String ?? "", launch: params["launch"] as? Bool ?? false)
    return app.json
  case "requestAccess":
    let decision = await Approval.request(
      appName: params["appName"] as? String ?? "this app",
      agentLabel: agent.label)
    return ["decision": decision]
  case "release":
    await CursorOverlay.shared.hide(agent.id)
    return ["released": true]
  default:
    break
  }
  try requireControl()
  let app = try await Apps.resolve(params["app"] as? String ?? "", launch: method == "getState")
  guard let pid = app.pid else { throw Failed(.app_missing, "\(app.name) is not running.") }
  let target = try Target(app: app, pid: pid, agent: agent)
  switch method {
  case "getState":
    return try await target.state(
      window: params["window"] as? Int,
      includeScreenshot: params["includeScreenshot"] as? Bool ?? true,
      maxNodes: min(max(params["maxNodes"] as? Int ?? 1200, 50), 2500))
  case "click":
    try await target.click(
      id: params["id"] as? Int, x: params["x"] as? Double, y: params["y"] as? Double,
      button: params["button"] as? String ?? "left",
      count: min(max(params["count"] as? Int ?? 1, 1), 3), agent: agent)
  case "drag":
    guard let fx = params["fromX"] as? Double, let fy = params["fromY"] as? Double,
      let tx = params["toX"] as? Double, let ty = params["toY"] as? Double
    else { throw Failed(.invalid_input) }
    try await target.drag(from: CGPoint(x: fx, y: fy), to: CGPoint(x: tx, y: ty), agent: agent)
  case "scroll":
    try await target.scroll(
      id: params["id"] as? Int, x: params["x"] as? Double, y: params["y"] as? Double,
      dx: params["dx"] as? Double ?? 0, dy: params["dy"] as? Double ?? 0,
      pages: params["pages"] as? Double, agent: agent)
  case "key":
    guard let keyCode = params["keyCode"] as? Int else { throw Failed(.invalid_input) }
    try await target.key(
      code: CGKeyCode(keyCode), modifiers: params["modifiers"] as? [String] ?? [],
      repeatCount: min(max(params["repeat"] as? Int ?? 1, 1), 50), agent: agent)
  case "type":
    guard let text = params["text"] as? String, text.utf16.count <= 20_000 else {
      throw Failed(.invalid_input)
    }
    try await target.type(text, id: params["id"] as? Int, agent: agent)
  case "setValue":
    guard let id = params["id"] as? Int, let value = params["value"] as? String else {
      throw Failed(.invalid_input)
    }
    try await target.setValue(id: id, value: value, agent: agent)
  case "selectText":
    guard let id = params["id"] as? Int, let text = params["text"] as? String else {
      throw Failed(.invalid_input)
    }
    try await target.selectText(
      id: id, text: text, prefix: params["prefix"] as? String,
      suffix: params["suffix"] as? String, mode: params["mode"] as? String ?? "text",
      agent: agent)
  case "secondaryAction":
    guard let id = params["id"] as? Int, let action = params["action"] as? String else {
      throw Failed(.invalid_input)
    }
    try await target.secondaryAction(id: id, action: action, agent: agent)
  case "paste":
    guard let text = params["text"] as? String, text.utf16.count <= 200_000 else {
      throw Failed(.invalid_input)
    }
    try await target.paste(text, agent: agent)
  case "activate":
    try await target.activate()
  default:
    throw Failed(.invalid_input, "Unknown method \(method).")
  }
  return ["ok": true]
}

#if !COMPUTER_USE_TESTS
@main enum Main {
  static func main() {
    guard CommandLine.arguments.dropFirst().first == "--serve" else {
      emit(["error": "invalid_input"])
      exit(2)
    }
    let application = NSApplication.shared
    // Accessory: no Dock icon or menu bar, and never activated by our own windows.
    application.setActivationPolicy(.accessory)
    application.finishLaunching()
    Apps.configureBlocklist()
    let lanes = Lanes()
    Thread.detachNewThread {
      while let line = readLine() {
        guard line.utf8.count < 1_000_000, let bytes = line.data(using: .utf8),
          let command = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
          let id = command["id"] as? Int, let method = command["method"] as? String
        else { continue }
        let params = command["params"] as? [String: Any] ?? [:]
        // Actions for one app run in order; different apps proceed in parallel.
        let lane = (params["app"] as? String).map { "app:\($0.lowercased())" } ?? "id:\(id)"
        lanes.run(lane) {
          do {
            emit(["id": id, "result": try await handle(method, params)])
          } catch let failed as Failed {
            emit(["id": id, "error": failed.reason.rawValue, "detail": failed.detail])
          } catch let failure as Failure {
            emit(["id": id, "error": failure.rawValue])
          } catch {
            emit(["id": id, "error": Failure.unavailable.rawValue])
          }
        }
      }
      // The server closed our stdin: stop. Only our own process exits.
      exit(0)
    }
    emit(["ready": true, "permissions": permissions()])
    application.run()
  }
}

#endif
