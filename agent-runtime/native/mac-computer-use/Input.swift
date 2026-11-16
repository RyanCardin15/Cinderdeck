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
  private typealias SetWindowLocation = @convention(c) (CGEvent, CGPoint) -> Void
  private typealias PostToPID = @convention(c) (pid_t, CGEvent) -> Void
  private typealias MainConnection = @convention(c) () -> Int32
  private typealias CaptureWindows = @convention(c) (Int32, UnsafePointer<CGWindowID>, Int32, UInt32) -> Unmanaged<CFArray>?

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
  private static let setWindowLocation: SetWindowLocation? = symbol("CGEventSetWindowLocation", [global])
  private static let postToPID: PostToPID? = symbol("SLEventPostToPid", [skyLight, global])
  private static let mainConnection: MainConnection? = symbol("CGSMainConnectionID", [skyLight, global])
  private static let captureWindows: CaptureWindows? = symbol("SLSHWCaptureWindowList", [skyLight, global])
    ?? symbol("CGSHWCaptureWindowList", [skyLight, global])

  static func captureWindow(_ windowID: CGWindowID, pid: pid_t) throws -> CGImage {
    guard CGPreflightScreenCaptureAccess() else { throw Failed(.screen_permission) }
    func owned() -> Bool {
      guard let rows = CGWindowListCopyWindowInfo(.optionIncludingWindow, windowID) as? [[String: Any]] else { return false }
      return rows.contains { ($0[kCGWindowNumber as String] as? UInt32) == windowID
        && ($0[kCGWindowOwnerPID as String] as? Int32) == pid }
    }
    guard owned() else { throw Failed(.window_missing) }
    guard let mainConnection, let captureWindows else { throw Failed(.unavailable, "Window capture is unavailable.") }
    var id = windowID
    guard let images = captureWindows(mainConnection(), &id, 1, (1 << 11) | (1 << 8))?.takeRetainedValue(),
      CFArrayGetCount(images) == 1, let pointer = CFArrayGetValueAtIndex(images, 0) else {
      throw Failed(.unavailable, "The selected window could not be captured.")
    }
    let value = unsafeBitCast(pointer, to: CFTypeRef.self)
    guard CFGetTypeID(value) == CGImage.typeID, owned() else { throw Failed(.unavailable) }
    return value as! CGImage
  }

  static func post(_ event: CGEvent, pid: pid_t) {
    if let postToPID { postToPID(pid, event) } else { event.postToPid(pid) }
  }

  static func locate(_ event: CGEvent, in windowID: CGWindowID, pid: pid_t) throws {
    guard let rows = CGWindowListCopyWindowInfo(.optionIncludingWindow, windowID) as? [[String: Any]],
      let row = rows.first(where: { ($0[kCGWindowNumber as String] as? UInt32) == windowID }),
      (row[kCGWindowOwnerPID as String] as? Int32) == pid,
      let bounds = row[kCGWindowBounds as String] as? [String: Any],
      let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary)
    else { throw Failed(.window_missing) }
    guard let setWindowLocation else {
      throw Failed(.unsupported_action, "This macOS version cannot address background pointer events to a window.")
    }
    setWindowLocation(event, windowLocation(type: event.type, point: event.location, frame: frame))
  }

  /// Wheel hit testing consumes a local point; mouse routing consumes screen
  /// space. Treating both alike silently loses wheels on secondary displays.
  static func windowLocation(type: CGEventType, point: CGPoint, frame: CGRect) -> CGPoint {
    type == .scrollWheel ? CGPoint(x: point.x - frame.minX, y: point.y - frame.minY) : point
  }

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
  /// Focus record layout documented by yabai and Cua Driver (MIT). Only the
  /// destination receives it; defocusing the user's app would drop their typing.
  @discardableResult
  static func makeKeyWithoutActivating(pid: pid_t, windowID: CGWindowID) -> Bool {
    guard let getProcessForPID, let postEventRecordTo else { return false }
    var psn = ProcessSerialNumber()
    guard withUnsafeMutableBytes(of: &psn, { getProcessForPID(pid, $0.baseAddress!) }) == noErr
    else { return false }
    var record = [UInt8](repeating: 0, count: 0xf8)
    record[0x04] = 0xf8
    record[0x08] = 0x0d
    record[0x8a] = 0x01
    withUnsafeBytes(of: windowID.littleEndian) { bytes in
      for (offset, byte) in bytes.enumerated() { record[0x3c + offset] = byte }
    }
    let status = withUnsafeMutableBytes(of: &psn) { psnBytes in
      record.withUnsafeMutableBufferPointer { postEventRecordTo(psnBytes.baseAddress!, $0.baseAddress!) }
    }
    if status == 0 { usleep(50_000) }
    return status == 0
  }
}

/// Background actions use one process and never move the system pointer.
/// Only the explicitly requested foreground drag uses the global HID stream.
enum Input {
  // A private source keeps our modifier flags out of the user's combined state.
  private static let source = CGEventSource(stateID: .privateState)
  private static let pointerSource = CGEventSource(stateID: .hidSystemState)

  private static func post(_ event: CGEvent?, pid: pid_t, windowID: CGWindowID?) throws {
    guard CGPreflightPostEventAccess() || AXIsProcessTrusted() else {
      throw Failed(.post_event_permission)
    }
    guard let event else { throw Failed(.unavailable, "Could not create the input event.") }
    if event.type != .keyDown && event.type != .keyUp { event.flags = [] }
    if let windowID {
      event.setIntegerValueField(.eventTargetUnixProcessID, value: Int64(pid))
      // Preserve the destination window when AppKit decodes a process event.
      if let destination = CGEventField(rawValue: 0x33) {
        event.setIntegerValueField(destination, value: Int64(windowID))
      }
      event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(windowID))
      event.setIntegerValueField(
        .mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(windowID))
      try PrivateAPI.locate(event, in: windowID, pid: pid)
    }
    PrivateAPI.post(event, pid: pid)
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
    let group = Int64(DispatchTime.now().uptimeNanoseconds & 0x7fff_ffff)
    func send(_ type: CGEventType, _ location: CGPoint, phase: Int64, count: Int64) throws {
      let event = mouseEvent(type, at: location, button: mouseButton, windowID: windowID)
      event?.setIntegerValueField(.mouseEventNumber, value: phase)
      event?.setIntegerValueField(.mouseEventClickState, value: count)
      if let field = CGEventField(rawValue: 58) { event?.setIntegerValueField(field, value: group) }
      try post(event, pid: pid, windowID: windowID)
    }
    let (downType, upType, mouseButton): (CGEventType, CGEventType, CGMouseButton) =
      switch button {
      case "right": (.rightMouseDown, .rightMouseUp, .right)
      case "middle": (.otherMouseDown, .otherMouseUp, .center)
      default: (.leftMouseDown, .leftMouseUp, .left)
      }
    try send(.mouseMoved, point, phase: 2, count: 0)
    usleep(15_000)
    if button == "left", NSRunningApplication(processIdentifier: pid)?.isActive != true {
      try send(downType, CGPoint(x: -1, y: -1), phase: 1, count: 1)
      usleep(1_000)
      try send(upType, CGPoint(x: -1, y: -1), phase: 2, count: 1)
      usleep(100_000)
    }
    for click in 1...count {
      for type in [downType, upType] {
        try send(type, point, phase: 3, count: Int64(click))
        usleep(28_000)
      }
      if click < count { usleep(50_000) }
    }
  }

  private static func mouseEvent(_ type: CGEventType, at point: CGPoint, button: CGMouseButton, windowID: CGWindowID?) -> CGEvent? {
    guard let event = CGEvent(mouseEventSource: pointerSource, mouseType: type,
      mouseCursorPosition: point, mouseButton: button) else { return nil }
    event.setIntegerValueField(.mouseEventButtonNumber, value: Int64(button.rawValue))
    event.setIntegerValueField(.mouseEventSubtype, value: 3)
    event.setIntegerValueField(.mouseEventNumber, value: 3)
    event.setIntegerValueField(.mouseEventClickState, value: 1)
    return event
  }

  static func drag(pid: pid_t, windowID: CGWindowID?, from: CGPoint, to: CGPoint) throws {
    let group = Int64(DispatchTime.now().uptimeNanoseconds & 0x7fff_ffff)
    func send(_ type: CGEventType, at point: CGPoint) throws {
      let event = mouseEvent(type, at: point, button: .left, windowID: windowID)
      if let field = CGEventField(rawValue: 58) { event?.setIntegerValueField(field, value: group) }
      try post(event, pid: pid, windowID: windowID)
    }
    try send(.mouseMoved, at: from)
    usleep(15_000)
    try send(.leftMouseDown, at: from)
    usleep(28_000)
    let steps = 16
    for step in 1...steps {
      let t = CGFloat(step) / CGFloat(steps)
      let point = CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)
      try send(.leftMouseDragged, at: point)
      usleep(16_000)
    }
    try send(.leftMouseUp, at: to)
  }

  static func scroll(pid: pid_t, windowID: CGWindowID?, at point: CGPoint, dx: Int32, dy: Int32) throws {
    try post(mouseEvent(.mouseMoved, at: point, button: .left, windowID: windowID), pid: pid, windowID: windowID)
    usleep(12_000)
    // Positive dy scrolls down; the wheel's positive direction scrolls up.
    let event = CGEvent(
      scrollWheelEvent2Source: pointerSource, units: .pixel, wheelCount: 2, wheel1: -dy, wheel2: -dx,
      wheel3: 0)
    event?.location = point
    try post(event, pid: pid, windowID: windowID)
  }

  /// Explicit foreground fallback. Never selected automatically by background actions.
  static func foregroundDrag(pid: pid_t, from: CGPoint, to: CGPoint, verify: () throws -> Void) throws {
    guard CGPreflightPostEventAccess() || AXIsProcessTrusted(),
      let original = CGEvent(source: nil)?.location else { throw Failed(.post_event_permission) }
    try verify()
    guard !CGEventSource.buttonState(.combinedSessionState, button: .left) else {
      throw Failed(.invalid_input, "The left mouse button is already held. Wait for the person to finish their gesture.")
    }
    var last = from, pressed = false, completed = false
    func unchangedPointer() -> Bool {
      guard let current = CGEvent(source: nil)?.location else { return false }
      return hypot(current.x - last.x, current.y - last.y) < 3
    }
    defer {
      if pressed {
        // Cancel the original native drag before releasing our synthetic button
        // at the current pointer, so interruption cannot drop into another app.
        try? key(pid: pid, code: 53, flags: [])
        let up = CGEvent(mouseEventSource: pointerSource, mouseType: .leftMouseUp,
          mouseCursorPosition: CGEvent(source: nil)?.location ?? last, mouseButton: .left)
        up?.flags = []
        up?.post(tap: .cghidEventTap)
      }
      if completed && unchangedPointer() { CGWarpMouseCursorPosition(original) }
    }
    func send(_ type: CGEventType, at point: CGPoint) throws {
      try verify()
      guard let event = CGEvent(mouseEventSource: pointerSource, mouseType: type,
        mouseCursorPosition: point, mouseButton: .left) else { throw Failed(.unavailable) }
      event.flags = []
      event.setIntegerValueField(.mouseEventClickState, value: 1)
      CGWarpMouseCursorPosition(point)
      last = point
      event.post(tap: .cghidEventTap)
    }
    try send(.mouseMoved, at: from)
    usleep(40_000)
    try send(.leftMouseDown, at: from)
    pressed = true
    usleep(80_000)
    for step in 1...32 {
      guard unchangedPointer() else { throw Failed(.invalid_input, "The person moved the pointer; the drag stopped. Read fresh state before continuing.") }
      let t = CGFloat(step) / 32
      try send(.leftMouseDragged, at: CGPoint(x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t))
      usleep(20_000)
    }
    try send(.leftMouseUp, at: to)
    pressed = false
    usleep(40_000)
    completed = true
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
