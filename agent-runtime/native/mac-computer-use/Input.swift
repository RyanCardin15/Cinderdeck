import AppKit
import ApplicationServices
import Foundation

/// Optional private symbols, resolved lazily with dlsym and never linked, so a
/// macOS release that drops one falls back to public behavior instead of
/// failing to launch (the same approach as BackgroundCursorControl).
enum PrivateAPI {
  private typealias GetWindow = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError
  private typealias GetProcessForPID = @convention(c) (pid_t, UnsafeMutableRawPointer) -> OSStatus
  private typealias PostEventRecordTo = @convention(c) (UnsafeMutableRawPointer, UnsafeMutablePointer<UInt8>) -> Int32

  private static let global = dlopen(nil, RTLD_LAZY)
  private static let skyLight = dlopen(
    "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY)
  private static func symbol<T>(_ name: String, _ handles: [UnsafeMutableRawPointer?]) -> T? {
    for handle in handles {
      if let handle, let pointer = dlsym(handle, name) { return unsafeBitCast(pointer, to: T.self) }
    }
    return nil
  }
  private static let getWindow: GetWindow? = symbol("_AXUIElementGetWindow", [global])
  private static let getProcessForPID: GetProcessForPID? = symbol("GetProcessForPID", [global])
  private static let postEventRecordTo: PostEventRecordTo? = symbol(
    "SLPSPostEventRecordTo", [skyLight, global])

  static var backgroundFocusAvailable: Bool {
    getProcessForPID != nil && postEventRecordTo != nil
  }

  /// The CGWindowID behind an AX window, when the private accessor exists.
  static func windowID(of element: AXUIElement) -> CGWindowID? {
    guard let getWindow else { return nil }
    var id: CGWindowID = 0
    return getWindow(element, &id) == .success && id != 0 ? id : nil
  }

  /// Makes `windowID` the key window inside its own app without raising it or
  /// activating the app, so a background WebKit/AppKit window accepts input.
  /// The two-record layout is the one documented by open-source macOS window
  /// managers (for example yabai, MIT licensed).
  @discardableResult
  static func makeKeyWithoutActivating(pid: pid_t, windowID: CGWindowID) -> Bool {
    guard let getProcessForPID, let postEventRecordTo else { return false }
    var psn = ProcessSerialNumber()
    guard withUnsafeMutableBytes(of: &psn, { getProcessForPID(pid, $0.baseAddress!) }) == noErr
    else { return false }
    var record = [UInt8](repeating: 0, count: 0xf8)
    record[0x04] = 0xf8
    record[0x3a] = 0x10
    for index in 0x20..<0x30 { record[index] = 0xff }
    withUnsafeBytes(of: windowID.littleEndian) { bytes in
      for (offset, byte) in bytes.enumerated() { record[0x3c + offset] = byte }
    }
    var ok = true
    for phase: UInt8 in [0x01, 0x02] {
      record[0x08] = phase
      let status = withUnsafeMutableBytes(of: &psn) { psnBytes in
        record.withUnsafeMutableBufferPointer { postEventRecordTo(psnBytes.baseAddress!, $0.baseAddress!) }
      }
      ok = ok && status == 0
    }
    return ok
  }
}

/// Posts synthesized events to one process. Nothing goes through the HID
/// stream, so the system pointer never moves and other apps never see them.
enum Input {
  // A private source keeps our modifier flags out of the user's combined state.
  private static let source = CGEventSource(stateID: .privateState)

  private static func post(_ event: CGEvent?, pid: pid_t, windowID: CGWindowID?) throws {
    guard CGPreflightPostEventAccess() || AXIsProcessTrusted() else {
      throw Failed(.post_event_permission)
    }
    guard let event else { throw Failed(.unavailable, "Could not create the input event.") }
    if event.type != .keyDown && event.type != .keyUp { event.flags = [] }
    if let windowID {
      event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(windowID))
      event.setIntegerValueField(
        .mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(windowID))
    }
    event.postToPid(pid)
  }

  static func flags(_ modifiers: [String]) throws -> CGEventFlags {
    var flags: CGEventFlags = []
    for modifier in modifiers {
      switch modifier {
      case "command": flags.insert(.maskCommand)
      case "shift": flags.insert(.maskShift)
      case "option": flags.insert(.maskAlternate)
      case "control": flags.insert(.maskControl)
      case "function": flags.insert(.maskSecondaryFn)
      default: throw Failed(.invalid_input, "Unknown modifier \(modifier).")
      }
    }
    return flags
  }

  static func click(
    pid: pid_t, windowID: CGWindowID?, at point: CGPoint, button: String, count: Int
  ) throws {
    let (downType, upType, mouseButton): (CGEventType, CGEventType, CGMouseButton) =
      switch button {
      case "right": (.rightMouseDown, .rightMouseUp, .right)
      case "middle": (.otherMouseDown, .otherMouseUp, .center)
      default: (.leftMouseDown, .leftMouseUp, .left)
      }
    for click in 1...count {
      for type in [downType, upType] {
        let event = CGEvent(
          mouseEventSource: source, mouseType: type, mouseCursorPosition: point,
          mouseButton: mouseButton)
        event?.setIntegerValueField(.mouseEventClickState, value: Int64(click))
        try post(event, pid: pid, windowID: windowID)
        usleep(12_000)
      }
      if click < count { usleep(50_000) }
    }
  }

  static func drag(pid: pid_t, windowID: CGWindowID?, from: CGPoint, to: CGPoint) throws {
    try post(
      CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: from, mouseButton: .left),
      pid: pid, windowID: windowID)
    let steps = 16
    for step in 1...steps {
      let t = CGFloat(step) / CGFloat(steps)
      let point = CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)
      try post(
        CGEvent(mouseEventSource: source, mouseType: .leftMouseDragged, mouseCursorPosition: point, mouseButton: .left),
        pid: pid, windowID: windowID)
      usleep(16_000)
    }
    try post(
      CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: to, mouseButton: .left),
      pid: pid, windowID: windowID)
  }

  static func scroll(pid: pid_t, windowID: CGWindowID?, at point: CGPoint, dx: Int32, dy: Int32) throws {
    // Positive dy scrolls down; the wheel's positive direction scrolls up.
    let event = CGEvent(
      scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: -dy, wheel2: -dx,
      wheel3: 0)
    event?.location = point
    try post(event, pid: pid, windowID: windowID)
  }

  static func key(pid: pid_t, code: CGKeyCode, flags: CGEventFlags) throws {
    for down in [true, false] {
      let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
      event?.flags = flags
      try post(event, pid: pid, windowID: nil)
      usleep(4_000)
    }
  }

  static func type(pid: pid_t, text: String) throws {
    var chunk: [UInt16] = []
    func flush() throws {
      guard !chunk.isEmpty else { return }
      for down in [true, false] {
        let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
        // A previous chord can leave modifier state on the private source.
        // Plain text must not inherit Command/Option/Control from that chord.
        event?.flags = []
        chunk.withUnsafeBufferPointer {
          event?.keyboardSetUnicodeString(stringLength: $0.count, unicodeString: $0.baseAddress!)
        }
        try post(event, pid: pid, windowID: nil)
      }
      chunk.removeAll()
      usleep(2_000)
    }
    // Split only at Character boundaries; send Return/Tab as real keys.
    for character in text {
      switch character {
      case "\n", "\r", "\r\n":
        try flush()
        try key(pid: pid, code: 36, flags: [])
      case "\t":
        try flush()
        try key(pid: pid, code: 48, flags: [])
      default:
        let units = Array(String(character).utf16)
        if chunk.count + units.count > 16 { try flush() }
        chunk.append(contentsOf: units)
      }
    }
    try flush()
  }
}
