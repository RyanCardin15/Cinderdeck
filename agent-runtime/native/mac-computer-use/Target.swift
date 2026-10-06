import AppKit
import ApplicationServices
import Foundation

private let dialogSubroles: Set<String> = ["AXDialog", "AXSystemDialog", "AXFloatingWindow"]

/// One app addressed by a command. Window and element state persists in the
/// app's ElementStore between commands.
struct Target {
  let app: AppRef
  let pid: pid_t
  let element: AXUIElement
  let store: ElementStore

  init(app: AppRef, pid: pid_t, agent: Agent) throws {
    self.app = app
    self.pid = pid
    element = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(element, 2.5)
    store = Stores.store("\(agent.id)\u{0}\(app.bundleId.lowercased())\u{0}\(pid)")
  }

  private func windows() -> [AXUIElement] {
    AX.elements(AX.copy(element, kAXWindowsAttribute)).filter {
      AX.string(AX.copy($0, kAXRoleAttribute)) == "AXWindow"
    }
  }

  private func defaultWindow(_ list: [AXUIElement]) -> AXUIElement? {
    if let focused = AX.copy(element, kAXFocusedWindowAttribute),
      CFGetTypeID(focused) == AXUIElementGetTypeID()
    {
      let focusedWindow = focused as! AXUIElement
      if let match = list.first(where: { CFEqual($0, focusedWindow) }) { return match }
    }
    if let main = list.first(where: { AX.bool(AX.copy($0, kAXMainAttribute)) == true }) {
      return main
    }
    return list.first { AX.bool(AX.copy($0, kAXMinimizedAttribute)) != true } ?? list.first
  }

  /// The window actions target: the one from the latest state read when it is
  /// still open, else the app's focused/main window.
  private func currentWindow() -> AXUIElement? {
    let list = windows()
    if let window = store.window, list.contains(where: { CFEqual($0, window) }) { return window }
    let window = defaultWindow(list)
    store.window = window
    store.windowID = window.flatMap(windowID)
    return window
  }

  private func windowID(_ window: AXUIElement) -> CGWindowID? {
    if let id = PrivateAPI.windowID(of: window) { return id }
    // Public fallback: match the WindowServer entry by owner, bounds and title.
    guard let frame = AX.frame(window),
      let info = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]]
    else { return nil }
    let title = AX.string(AX.copy(window, kAXTitleAttribute)) ?? ""
    let matches = info.filter { row in
      guard (row[kCGWindowOwnerPID as String] as? Int32) == pid,
        (row[kCGWindowLayer as String] as? Int) == 0,
        let bounds = row[kCGWindowBounds as String] as? [String: Any],
        let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary)
      else { return false }
      return abs(rect.minX - frame.minX) < 3 && abs(rect.minY - frame.minY) < 3
        && abs(rect.width - frame.width) < 3 && abs(rect.height - frame.height) < 3
    }
    let titled = matches.filter { ($0[kCGWindowName as String] as? String ?? title) == title }
    let chosen = titled.count == 1 ? titled[0] : matches.count == 1 ? matches[0] : nil
    return (chosen?[kCGWindowNumber as String] as? UInt32).map { CGWindowID($0) }
  }

  func state(window index: Int?, includeScreenshot: Bool, maxNodes: Int) async throws -> [String: Any] {
    let list = windows()
    var window = currentWindow()
    if let index {
      guard list.indices.contains(index) else {
        throw Failed(.window_missing, "No window \(index); the app has \(list.count).")
      }
      window = list[index]
    }
    store.window = window
    store.windowID = window.flatMap(windowID)
    store.elements.removeAll(keepingCapacity: true)
    let windowFrame = window.flatMap(AX.frame)
    var walk = TreeWalk(
      store: store, windowFrame: windowFrame, maxNodes: maxNodes,
      deadline: Date().addingTimeInterval(4))
    var rootSiblings: [String: Int] = [:]
    if let window { walk.visit(window, parentKey: "", siblings: &rootSiblings, parent: 0, depth: 0) }
    // A focused dialog in another window, and any open context menu.
    if let focused = AX.copy(element, kAXFocusedWindowAttribute),
      CFGetTypeID(focused) == AXUIElementGetTypeID()
    {
      let dialog = focused as! AXUIElement
      if window.map({ !CFEqual($0, dialog) }) ?? true,
        dialogSubroles.contains(AX.string(AX.copy(dialog, kAXSubroleAttribute)) ?? "")
      {
        walk.visit(dialog, parentKey: "", siblings: &rootSiblings, parent: 0, depth: 0)
      }
    }
    for child in AX.elements(AX.copy(element, kAXChildrenAttribute))
    where AX.string(AX.copy(child, kAXRoleAttribute)) == "AXMenu" {
      walk.visit(child, parentKey: "", siblings: &rootSiblings, parent: 0, depth: 0, inMenu: true)
    }
    if let menuBar = AX.copy(element, kAXMenuBarAttribute),
      CFGetTypeID(menuBar) == AXUIElementGetTypeID()
    {
      var menuWalk = TreeWalk(
        store: store, windowFrame: nil, maxNodes: walk.nodes.count + 200,
        deadline: Date().addingTimeInterval(1.5))
      menuWalk.visit(
        menuBar as! AXUIElement, parentKey: "", siblings: &rootSiblings, parent: 0, depth: 0)
      walk.nodes.append(contentsOf: menuWalk.nodes)
    }

    var focusedID: Int?
    var selectedText: String?
    if let focused = AX.copy(element, kAXFocusedUIElementAttribute),
      CFGetTypeID(focused) == AXUIElementGetTypeID()
    {
      let focusedElement = focused as! AXUIElement
      focusedID = store.elements.first { CFEqual($0.value.element, focusedElement) }?.key
      selectedText = AX.string(AX.copy(focusedElement, kAXSelectedTextAttribute))
    }
    let rows: [[String: Any]] = list.enumerated().map { offset, item in
      var row: [String: Any] = [
        "index": offset, "title": AX.string(AX.copy(item, kAXTitleAttribute)) ?? "",
      ]
      if let window, CFEqual(item, window) { row["target"] = true }
      if AX.bool(AX.copy(item, kAXMinimizedAttribute)) == true { row["minimized"] = true }
      if AX.bool(AX.copy(item, kAXMainAttribute)) == true { row["main"] = true }
      return row
    }
    var result: [String: Any] = [
      "app": app.json, "windows": rows, "nodes": walk.nodes, "truncated": walk.truncated,
    ]
    if let windowFrame {
      result["window"] = [
        "title": window.flatMap { AX.string(AX.copy($0, kAXTitleAttribute)) } ?? "",
        "width": windowFrame.width, "height": windowFrame.height,
      ]
    }
    if let focusedID { result["focusedId"] = focusedID }
    if let selectedText, !selectedText.isEmpty {
      result["selectedText"] = String(selectedText.prefix(2000))
    }
    if includeScreenshot, let windowID = store.windowID {
      do {
        result["screenshot"] = try await Capture.window(windowID)
      } catch let failed as Failed {
        result["screenshotError"] = failed.reason.rawValue
      } catch {
        result["screenshotError"] = Failure.unavailable.rawValue
      }
    }
    return result
  }

  private func registered(_ id: Int) throws -> (element: AXUIElement, frame: CGRect?) {
    guard let entry = store.elements[id] else {
      throw Failed(.element_missing, "Element \(id) is not in the latest state. Read the app state again.")
    }
    // A destroyed element answers attribute reads with kAXErrorInvalidUIElement.
    var role: CFTypeRef?
    if AXUIElementCopyAttributeValue(entry.element, kAXRoleAttribute as CFString, &role)
      == .invalidUIElement
    {
      throw Failed(.element_stale, "Element \(id) no longer exists. Read the app state again.")
    }
    return (entry.element, AX.frame(entry.element) ?? entry.frame)
  }

  /// Converts window-relative points to global screen coordinates.
  private func global(_ point: CGPoint) throws -> CGPoint {
    guard let window = currentWindow(), let frame = AX.frame(window) else {
      throw Failed(.window_missing, "The app has no open window.")
    }
    return CGPoint(x: frame.minX + point.x, y: frame.minY + point.y)
  }

  /// Prepares the target window for synthesized input without activating its app.
  private func prepareInput() {
    guard let windowID = store.windowID ?? currentWindow().flatMap(windowID) else { return }
    if NSRunningApplication(processIdentifier: pid)?.isActive == true,
      let window = store.window, let focused = AX.copy(element, kAXFocusedWindowAttribute),
      CFGetTypeID(focused) == AXUIElementGetTypeID(), CFEqual(focused, window)
    {
      return
    }
    PrivateAPI.makeKeyWithoutActivating(pid: pid, windowID: windowID)
  }

  private func show(_ agent: Agent, at point: CGPoint?, click: Bool = false) async {
    guard let point else { return }
    await CursorOverlay.shared.move(agent: agent, to: point, click: click)
  }

  private func center(_ frame: CGRect?) -> CGPoint? {
    frame.map { CGPoint(x: $0.midX, y: $0.midY) }
  }

  func click(id: Int?, x: Double?, y: Double?, button: String, count: Int, agent: Agent) async throws {
    if let id {
      let entry = try registered(id)
      let actions = AX.actions(entry.element)
      // Prefer the element's own action: no synthesized pointer input at all.
      let action: String? =
        switch (button, count) {
        case ("left", 1): actions.contains("AXPress") ? "AXPress" : actions.contains("AXPick") ? "AXPick" : nil
        case ("right", 1): actions.contains("AXShowMenu") ? "AXShowMenu" : nil
        default: nil
        }
      if let action {
        await show(agent, at: center(entry.frame), click: true)
        guard AXUIElementPerformAction(entry.element, action as CFString) == .success else {
          throw Failed(.unsupported_action, "Element \(id) refused \(action).")
        }
        return
      }
      guard let point = center(entry.frame) else {
        throw Failed(.unsupported_action, "Element \(id) has no position to click.")
      }
      prepareInput()
      await show(agent, at: point, click: true)
      try Input.click(pid: pid, windowID: store.windowID, at: point, button: button, count: count)
      return
    }
    guard let x, let y else { throw Failed(.invalid_input, "Pass element_index or x and y.") }
    let point = try global(CGPoint(x: x, y: y))
    prepareInput()
    await show(agent, at: point, click: true)
    try Input.click(pid: pid, windowID: store.windowID, at: point, button: button, count: count)
  }

  func drag(from: CGPoint, to: CGPoint, agent: Agent) async throws {
    let start = try global(from), end = try global(to)
    prepareInput()
    await show(agent, at: start)
    try Input.drag(pid: pid, windowID: store.windowID, from: start, to: end)
    await show(agent, at: end)
  }

  func scroll(
    id: Int?, x: Double?, y: Double?, dx: Double, dy: Double, pages: Double?, agent: Agent
  ) async throws {
    var point: CGPoint
    var height: CGFloat = 400, width: CGFloat = 400
    if let id {
      let entry = try registered(id)
      guard let frame = entry.frame else {
        throw Failed(.unsupported_action, "Element \(id) has no position to scroll.")
      }
      point = CGPoint(x: frame.midX, y: frame.midY)
      height = frame.height
      width = frame.width
    } else if let x, let y {
      point = try global(CGPoint(x: x, y: y))
    } else {
      guard let window = currentWindow(), let frame = AX.frame(window) else {
        throw Failed(.window_missing)
      }
      point = CGPoint(x: frame.midX, y: frame.midY)
      height = frame.height
      width = frame.width
    }
    // Pages scroll by most of the visible extent, like Page Up/Down.
    // With pages, dx/dy only carry the direction.
    func unit(_ value: Double) -> Double { value == 0 ? 0 : value < 0 ? -1 : 1 }
    let deltaY = pages.map { unit(dy) * Double(height) * 0.85 * $0 } ?? dy
    let deltaX = pages.map { unit(dx) * Double(width) * 0.85 * $0 } ?? dx
    prepareInput()
    await show(agent, at: point)
    // Large deltas are split so apps that clamp a single wheel event still move.
    let steps = max(1, Int((max(abs(deltaX), abs(deltaY)) / 600).rounded(.up)))
    for _ in 0..<steps {
      try Input.scroll(
        pid: pid, windowID: store.windowID, at: point,
        dx: Int32((deltaX / Double(steps)).rounded()), dy: Int32((deltaY / Double(steps)).rounded()))
      usleep(10_000)
    }
  }

  /// Background apps do not always route Command key equivalents through
  /// their menu bar. Prefer the matching menu item's own accessibility action.
  private func shortcut(code: CGKeyCode, modifiers: [String]) -> AXUIElement? {
    guard modifiers.contains("command"), let bar = AX.copy(element, kAXMenuBarAttribute),
      CFGetTypeID(bar) == AXUIElementGetTypeID() else { return nil }
    // Many menu items expose virtual key 0 when only a character equivalent
    // was configured. Match printable shortcuts by character, never by that 0.
    let characters: [CGKeyCode: String] = [
      0:"a", 1:"s", 2:"d", 3:"f", 4:"h", 5:"g", 6:"z", 7:"x", 8:"c", 9:"v",
      11:"b", 12:"q", 13:"w", 14:"e", 15:"r", 16:"y", 17:"t", 18:"1", 19:"2", 20:"3",
      21:"4", 22:"6", 23:"5", 24:"=", 25:"9", 26:"7", 27:"-", 28:"8", 29:"0", 30:"]",
      31:"o", 32:"u", 33:"[", 34:"i", 35:"p", 37:"l", 38:"j", 39:"'", 40:"k", 41:";",
      42:"\\", 43:",", 44:"/", 45:"n", 46:"m", 47:".", 49:" ", 50:"`",
    ]
    let shifted: [String: String] = [
      "1":"!", "2":"@", "3":"#", "4":"$", "5":"%", "6":"^", "7":"&", "8":"*",
      "9":"(", "0":")", "-":"_", "=":"+", "[":"{", "]":"}", "\\":"|", ";":":",
      "'":"\"", ",":"<", ".":">", "/":"?", "`":"~",
    ]
    let character = characters[code]
    let shiftedCharacter = character.map { shifted[$0] ?? $0.uppercased() }
    let mask = (modifiers.contains("shift") ? 1 : 0)
      | (modifiers.contains("option") ? 2 : 0) | (modifiers.contains("control") ? 4 : 0)
    var stack = [bar as! AXUIElement]
    var visited = 0
    let deadline = Date().addingTimeInterval(1)
    while let item = stack.popLast(), visited < 400, Date() < deadline {
      visited += 1
      let values = AX.many(item, [kAXRoleAttribute, kAXMenuItemCmdVirtualKeyAttribute,
        kAXMenuItemCmdModifiersAttribute, kAXEnabledAttribute, kAXChildrenAttribute, kAXMenuItemCmdCharAttribute])
      let equivalent = AX.string(values[5])?.lowercased()
      let keyMatches = character.map { equivalent == $0 || (modifiers.contains("shift") && equivalent == shiftedCharacter?.lowercased()) }
        ?? ((values[1] as? NSNumber)?.intValue == Int(code))
      if AX.string(values[0]) == "AXMenuItem", keyMatches,
        let flags = values[2] as? NSNumber, flags.intValue == mask,
        AX.bool(values[3]) != false { return item }
      stack.append(contentsOf: AX.elements(values[4]).prefix(100))
    }
    return nil
  }

  func key(code: CGKeyCode, modifiers: [String], repeatCount: Int, agent: Agent) async throws {
    let flags = try Input.flags(modifiers)
    prepareInput()
    if let window = store.window, let frame = AX.frame(window) {
      await show(agent, at: CGPoint(x: frame.midX, y: frame.minY + 12))
    }
    for _ in 0..<repeatCount {
      if let item = shortcut(code: code, modifiers: modifiers),
        AXUIElementPerformAction(item, kAXPressAction as CFString) == .success { continue }
      // Select All also works in editable controls without a menu item.
      if code == 0, modifiers == ["command"],
        let focused = AX.copy(element, kAXFocusedUIElementAttribute),
        CFGetTypeID(focused) == AXUIElementGetTypeID() {
        let field = focused as! AXUIElement
        if let text = AX.string(AX.copy(field, kAXValueAttribute)) {
          var range = CFRange(location: 0, length: (text as NSString).length)
          if let value = AXValueCreate(.cfRange, &range),
            AXUIElementSetAttributeValue(field, kAXSelectedTextRangeAttribute as CFString, value) == .success { continue }
        }
      }
      try Input.key(pid: pid, code: code, flags: flags)
    }
  }

  func type(_ text: String, id: Int?, agent: Agent) async throws {
    if let id {
      let entry = try registered(id)
      guard AXUIElementSetAttributeValue(entry.element, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success else {
        throw Failed(.unsupported_action, "Element \(id) could not receive keyboard focus.")
      }
      await show(agent, at: center(entry.frame))
    }
    prepareInput()
    try Input.type(pid: pid, text: text)
  }

  func setValue(id: Int, value: String, agent: Agent) async throws {
    let entry = try registered(id)
    var settable: DarwinBoolean = false
    guard
      AXUIElementIsAttributeSettable(entry.element, kAXValueAttribute as CFString, &settable)
        == .success, settable.boolValue
    else { throw Failed(.not_settable, "Element \(id) has no editable value.") }
    await show(agent, at: center(entry.frame), click: true)
    let current = AX.copy(entry.element, kAXValueAttribute)
    let replacement: CFTypeRef =
      if let current, current is NSNumber, let number = Double(value) {
        NSNumber(value: number)
      } else {
        value as CFString
      }
    guard
      AXUIElementSetAttributeValue(entry.element, kAXValueAttribute as CFString, replacement)
        == .success
    else { throw Failed(.not_settable, "Element \(id) rejected the new value.") }
  }

  func selectText(
    id: Int, text: String, prefix: String?, suffix: String?, mode: String, agent: Agent
  ) async throws {
    let entry = try registered(id)
    guard let value = AX.string(AX.copy(entry.element, kAXValueAttribute)) else {
      throw Failed(.unsupported_action, "Element \(id) has no text.")
    }
    let haystack = value as NSString
    var location = NSNotFound
    var searchStart = 0
    while searchStart <= haystack.length {
      let found = haystack.range(
        of: text, options: [],
        range: NSRange(location: searchStart, length: haystack.length - searchStart))
      guard found.location != NSNotFound else { break }
      let before = haystack.substring(to: found.location)
      let after = haystack.substring(from: found.location + found.length)
      if (prefix.map { before.hasSuffix($0) } ?? true) && (suffix.map { after.hasPrefix($0) } ?? true) {
        location = found.location
        break
      }
      searchStart = found.location + max(1, found.length)
    }
    guard location != NSNotFound else {
      throw Failed(.text_not_found, "The text was not found in element \(id).")
    }
    let length = (text as NSString).length
    var range =
      switch mode {
      case "cursor_before": CFRange(location: location, length: 0)
      case "cursor_after": CFRange(location: location + length, length: 0)
      default: CFRange(location: location, length: length)
      }
    guard let axRange = AXValueCreate(.cfRange, &range) else { throw Failed(.unavailable) }
    AXUIElementSetAttributeValue(entry.element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    await show(agent, at: center(entry.frame))
    guard
      AXUIElementSetAttributeValue(entry.element, kAXSelectedTextRangeAttribute as CFString, axRange)
        == .success
    else { throw Failed(.unsupported_action, "Element \(id) does not support text selection.") }
  }

  func secondaryAction(id: Int, action: String, agent: Agent) async throws {
    let entry = try registered(id)
    let wanted = action.lowercased().replacingOccurrences(of: " ", with: "")
    let names = AX.actions(entry.element)
    guard
      let raw = names.first(where: { name in
        let label = (actionLabel(name) ?? String(name.dropFirst(2))).lowercased()
          .replacingOccurrences(of: " ", with: "")
        return label == wanted || name.lowercased() == wanted || name.lowercased() == "ax\(wanted)"
      })
    else {
      let available = names.compactMap(actionLabel).joined(separator: ", ")
      throw Failed(.unsupported_action, "Element \(id) supports: \(available.isEmpty ? "none" : available).")
    }
    await show(agent, at: center(entry.frame), click: true)
    guard AXUIElementPerformAction(entry.element, raw as CFString) == .success else {
      throw Failed(.unsupported_action, "Element \(id) refused \(action).")
    }
  }

  func paste(_ text: String, agent: Agent) async throws {
    prepareInput()
    try await Clipboard.paste(text, pid: pid)
  }

  func activate() async throws {
    guard let running = NSRunningApplication(processIdentifier: pid) else { throw Failed(.app_missing) }
    if let window = currentWindow() { AXUIElementPerformAction(window, kAXRaiseAction as CFString) }
    running.activate()
  }
}

/// Serialize clipboard transactions across apps and finish restoration before
/// acknowledging paste. A user's newer clipboard content always takes precedence.
@MainActor enum Clipboard {
  private static var busy = false

  static func paste(_ text: String, pid: pid_t) async throws {
    while busy { try await Task.sleep(nanoseconds: 10_000_000) }
    busy = true
    defer { busy = false }
    let board = NSPasteboard.general
    let saved = replace(with: text)
    let version = board.changeCount
    defer {
      if board.changeCount == version { restore(saved) }
    }
    try Input.key(pid: pid, code: 9, flags: .maskCommand)
    try await Task.sleep(nanoseconds: 500_000_000)
  }

  private static func replace(with text: String) -> [NSPasteboardItem] {
    let board = NSPasteboard.general
    let saved = (board.pasteboardItems ?? []).map { item in
      let copy = NSPasteboardItem()
      for type in item.types {
        if let data = item.data(forType: type) { copy.setData(data, forType: type) }
      }
      return copy
    }
    board.clearContents()
    board.setString(text, forType: .string)
    return saved
  }

  private static func restore(_ items: [NSPasteboardItem]) {
    let board = NSPasteboard.general
    board.clearContents()
    if !items.isEmpty { board.writeObjects(items) }
  }
}
