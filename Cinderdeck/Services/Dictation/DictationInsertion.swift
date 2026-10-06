import AppKit
import ApplicationServices

@MainActor
struct DictationInsertionTarget {
  let pid: pid_t
  let element: AXUIElement
  let selection: CFTypeRef?

  static func capture() -> Self? {
    guard AXIsProcessTrusted(), let app = NSWorkspace.shared.frontmostApplication else { return nil }
    let application = AXUIElementCreateApplication(app.processIdentifier)
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(application, kAXFocusedUIElementAttribute as CFString, &value) == .success,
      let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    let element = unsafeBitCast(value, to: AXUIElement.self)
    var subrole: CFTypeRef?
    AXUIElementCopyAttributeValue(element, kAXSubroleAttribute as CFString, &subrole)
    guard (subrole as? String) != kAXSecureTextFieldSubrole else { return nil }
    var selection: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, &selection) == .success else { return nil }
    return Self(pid: app.processIdentifier, element: element, selection: selection)
  }

  func isStillFocused() -> Bool {
    guard let current = Self.capture(), current.pid == pid, CFEqual(element, current.element),
      let selection, let other = current.selection, CFEqual(selection, other) else { return false }
    return true
  }

  func insert(_ text: String) -> Bool {
    guard isStillFocused() else { return false }
    // Native controls can replace just the selection without disturbing the clipboard.
    var settable: DarwinBoolean = false
    if AXUIElementIsAttributeSettable(element, kAXSelectedTextAttribute as CFString, &settable) == .success,
      settable.boolValue,
      AXUIElementSetAttributeValue(element, kAXSelectedTextAttribute as CFString, text as CFString) == .success { return true }
    // Chromium/Teams often expose a selection but not a writable selected-text attribute.
    guard NSEvent.modifierFlags.intersection([.control, .option, .command, .shift]).isEmpty,
      let down = CGEvent(keyboardEventSource: nil, virtualKey: 9, keyDown: true),
      let up = CGEvent(keyboardEventSource: nil, virtualKey: 9, keyDown: false) else { return false }
    let pasteboard = NSPasteboard.general
    let previous = (pasteboard.pasteboardItems ?? []).map { item in
      item.types.compactMap { type in item.data(forType: type).map { (type, $0) } }
    }
    pasteboard.clearContents()
    pasteboard.setString(text, forType: .string)
    pasteboard.setData(Data(), forType: NSPasteboard.PasteboardType("org.nspasteboard.TransientType"))
    let insertedChange = pasteboard.changeCount
    down.flags = .maskCommand; up.flags = .maskCommand
    down.postToPid(pid); up.postToPid(pid)
    // Restore only our own clipboard generation; a user copy always wins.
    Task { @MainActor in
      try? await Task.sleep(for: .seconds(1))
      guard pasteboard.changeCount == insertedChange else { return }
      pasteboard.clearContents()
      let items = previous.map { values in
        let item = NSPasteboardItem()
        for (type, data) in values { item.setData(data, forType: type) }
        return item
      }
      if !items.isEmpty { pasteboard.writeObjects(items) }
    }
    return true
  }
}
