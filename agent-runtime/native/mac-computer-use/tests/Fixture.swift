import AppKit
import ApplicationServices
import Foundation

// An in-process AppKit fixture: never reads another app, document or clipboard.
@main enum Fixture {
  @MainActor static func main() {
    let application = NSApplication.shared
    application.setActivationPolicy(.accessory)
    application.finishLaunching()
    let menu = NSMenu()
    let appItem = NSMenuItem(title: "Fixture", action: nil, keyEquivalent: "")
    appItem.submenu = NSMenu(title: "Fixture")
    menu.addItem(appItem)
    let edit = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
    let editMenu = NSMenu(title: "Edit")
    editMenu.addItem(NSMenuItem(title: "Select Word", action: #selector(NSTextView.selectWord(_:)), keyEquivalent: "w"))
    editMenu.addItem(NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
    edit.submenu = editMenu
    menu.addItem(edit)
    application.mainMenu = menu
    var windows: [NSWindow] = []
    for name in ["First", "Second"] {
      let window = NSWindow(
        contentRect: NSRect(x: 100, y: 100, width: 400, height: 200),
        styleMask: [.titled], backing: .buffered, defer: false)
      window.isReleasedWhenClosed = false
      window.title = name
      let field = NSTextField(frame: NSRect(x: 20, y: 80, width: 300, height: 30))
      field.stringValue = "fixture only"
      field.setAccessibilityIdentifier("fixture-field")
      window.contentView!.addSubview(field)
      window.orderBack(nil)
      windows.append(window)
    }
    if CommandLine.arguments.contains("--target") {
      emit(["ready": true, "pid": getpid()])
      application.run()
      return
    }
    Task.detached {
      do {
        try await Task.sleep(nanoseconds: 200_000_000)
        try await run()
        // Keep fixture windows alive until the checks complete.
        await MainActor.run { for window in windows { window.close() } }
        exit(0)
      } catch { emit(["error": String(describing: error)]); exit(1) }
    }
    application.run()
  }

  static func check(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() { throw Failed(.unavailable, message) }
  }

  static func nodes(_ state: [String: Any]) -> [[String: Any]] {
    state["nodes"] as? [[String: Any]] ?? []
  }

  static func run() async throws {
    let app = AppRef(bundleId: "test.computer.use.fixture", name: "Fixture", url: nil, pid: getpid())
    let alice = Agent(["id": "alice", "label": "Fixture A"])
    let a = try Target(app: app, pid: getpid(), agent: alice)
    let b = try Target(app: app, pid: getpid(), agent: Agent(["id": "bob"]))
    let first = try await a.state(window: 0, includeScreenshot: false, maxNodes: 100)
    guard let field = nodes(first).first(where: { $0["identifier"] as? String == "fixture-field" }),
      let id = field["id"] as? Int else { throw Failed(.element_missing, "Fixture field missing") }
    let title = (first["window"] as? [String: Any])?["title"] as? String
    _ = try await b.state(window: 1, includeScreenshot: false, maxNodes: 100)
    let again = try await a.state(window: nil, includeScreenshot: false, maxNodes: 100)
    try check((again["window"] as? [String: Any])?["title"] as? String == title,
      "Another conversation replaced the selected window")
    try check(nodes(again).first(where: { $0["identifier"] as? String == "fixture-field" })?["id"] as? Int == id,
      "Unchanged element index changed")
    try await a.setValue(id: id, value: "hello 🐟 world", agent: alice)
    try await a.selectText(id: id, text: "🐟", prefix: "hello ", suffix: " world", mode: "text", agent: alice)
    let edited = try await a.state(window: nil, includeScreenshot: false, maxNodes: 100)
    try check(nodes(edited).first(where: { $0["id"] as? Int == id })?["value"] as? String == "hello 🐟 world",
      "Field edit was not reflected in the next state")
    try check(edited["selectedText"] as? String == "🐟", "Unicode selection was incorrect")
    let other = try await b.state(window: nil, includeScreenshot: false, maxNodes: 100)
    try check(nodes(other).first(where: { $0["identifier"] as? String == "fixture-field" })?["value"] as? String == "fixture only",
      "Edit reached the wrong window")
    do {
      try await a.setValue(id: 999_999, value: "wrong", agent: alice)
      throw Failed(.unavailable, "Missing index was accepted")
    } catch let error as Failed { try check(error.reason == .element_missing, "Wrong missing-index error") }
    var edits: [Double] = []
    for i in 0..<20 {
      let start = Date()
      try await a.setValue(id: id, value: "fixture edit \(i)", agent: alice)
      edits.append(Date().timeIntervalSince(start) * 1000)
    }
    edits.sort()
    var elapsed: [Double] = []
    for _ in 0..<100 {
      let start = Date()
      _ = try await a.state(window: nil, includeScreenshot: false, maxNodes: 100)
      elapsed.append(Date().timeIntervalSince(start) * 1000)
    }
    elapsed.sort()
    emit(["ok": true, "checks": 7, "reads": elapsed.count,
      "editMedianMs": edits[edits.count / 2],
      "medianMs": elapsed[elapsed.count / 2], "p95Ms": elapsed[Int(Double(elapsed.count) * 0.95)]])
  }
}
