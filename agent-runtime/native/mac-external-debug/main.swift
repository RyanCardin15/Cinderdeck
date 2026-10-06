import AppKit
import ApplicationServices
import CoreImage
import CoreMedia
import Foundation
import ScreenCaptureKit

// Uses only public APIs. WebKit's own Inspector remains in the host application;
// we capture and control explicitly selected native windows rather than connecting
// to Apple's private remote-inspector Mach service or injecting into Office.
enum Failure: String, Error {
  case screen_permission, accessibility_permission, target_missing, invalid_command, unavailable, app_missing
}
// Frame stream errors arrive on capture queues; keep each JSONL line intact.
let output = NSLock()
func emit(_ value: Any) {
  guard JSONSerialization.isValidJSONObject(value),
    let data = try? JSONSerialization.data(withJSONObject: value)
  else { return }
  output.lock()
  defer { output.unlock() }
  FileHandle.standardOutput.write(data + Data([10]))
}
func epochMilliseconds() -> Double { Date().timeIntervalSince1970 * 1000 }
func windows() async throws -> [SCWindow] {
  guard CGPreflightScreenCaptureAccess() else { throw Failure.screen_permission }
  return try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
    .windows
    .filter {
      $0.windowLayer == 0 && $0.frame.width > 80 && $0.frame.height > 60
        && $0.owningApplication?.processID != getpid()
    }
}
func row(_ window: SCWindow) -> [String: Any] {
  let app = window.owningApplication!
  return [
    "id": "mac:\(app.processID):\(window.windowID)", "title": window.title ?? app.applicationName,
    "app": app.applicationName, "bundle": app.bundleIdentifier, "type": "mac-window",
    "width": window.frame.width, "height": window.frame.height,
  ]
}
struct WindowInfo {
  let frame: CGRect
  let title: String
}
// Cheap WindowServer lookup. ScreenCaptureKit enumeration is reserved for
// discovery and stream creation, not every frame read or input command.
func windowInfo(pid: pid_t, windowID: CGWindowID) throws -> WindowInfo {
  guard
    let info = CGWindowListCopyWindowInfo(.optionIncludingWindow, windowID) as? [[String: Any]],
    let selected = info.first(where: {
      ($0[kCGWindowOwnerPID as String] as? Int32) == pid
        && ($0[kCGWindowNumber as String] as? UInt32) == windowID
    }),
    let bounds = selected[kCGWindowBounds as String] as? [String: Any],
    let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary)
  else { throw Failure.target_missing }
  return WindowInfo(frame: rect, title: selected[kCGWindowName as String] as? String ?? "")
}
func hasCapturableWindow(_ pid: pid_t) -> Bool {
  let info =
    CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
    as? [[String: Any]] ?? []
  return info.contains { window in
    guard (window[kCGWindowOwnerPID as String] as? Int32) == pid,
      (window[kCGWindowLayer as String] as? Int) == 0,
      let bounds = window[kCGWindowBounds as String] as? [String: Any],
      let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary)
    else { return false }
    return rect.width > 80 && rect.height > 60
  }
}

final class Frames: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
  let targetID: String
  init(targetID: String) {
    self.targetID = targetID
    super.init()
  }
  private let lock = NSLock()
  private let context = CIContext(options: [.cacheIntermediates: false])
  // The latest complete frame stays a pixel buffer until someone reads it, so an
  // unwatched window costs no JPEG encoding and an unchanged one is encoded once.
  private var pixel: CVPixelBuffer?
  private var sequence = 0
  private var encoded: (sequence: Int, data: String)?
  private var stopped = false
  private var waiters: [UUID: (after: Int, continuation: CheckedContinuation<Void, Never>)] = [:]
  // Benchmark mode keeps when and where each repaint happened, without encoding pixels.
  private var recording = false
  private var changes: [[String: Any]] = []
  func record(_ enabled: Bool) {
    lock.lock()
    recording = enabled
    changes.removeAll()
    lock.unlock()
  }
  func changes(since: Double) -> [[String: Any]] {
    lock.lock()
    defer { lock.unlock() }
    return Array(changes.lazy.filter { ($0["t"] as? Double ?? 0) > since }.prefix(1000))
  }
  func wait(after: Int, timeout: Duration) async {
    let id = UUID()
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      lock.lock()
      if sequence > after || stopped {
        lock.unlock()
        continuation.resume()
        return
      }
      waiters[id] = (after, continuation)
      lock.unlock()
      Task.detached {
        try? await Task.sleep(for: timeout)
        self.resume(id)
      }
    }
  }
  private func resume(_ id: UUID) {
    lock.lock()
    let waiter = waiters.removeValue(forKey: id)
    lock.unlock()
    waiter?.continuation.resume()
  }
  func stop() {
    lock.lock()
    stopped = true
    pixel = nil
    let ready = Array(waiters.values)
    waiters.removeAll()
    lock.unlock()
    for waiter in ready { waiter.continuation.resume() }
  }
  // Called off the main actor: encoding a large frame must not delay input or AX.
  func latest(known: Int?) -> [String: Any] {
    lock.lock()
    let current = sequence
    let buffer = pixel
    let cached = encoded
    lock.unlock()
    if let known, known == current, current > 0 { return ["sequence": current, "unchanged": true] }
    if let cached, cached.sequence == current { return ["sequence": current, "data": cached.data] }
    guard let buffer else { return ["sequence": current, "data": ""] }
    let input = CIImage(cvPixelBuffer: buffer)
    guard let cg = context.createCGImage(input, from: input.extent) else {
      return ["sequence": current, "data": ""]
    }
    let bitmap = NSBitmapImageRep(cgImage: cg)
    guard
      let data = [0.72, 0.50, 0.32, 0.18].lazy.compactMap({ quality in
        bitmap.representation(using: .jpeg, properties: [.compressionFactor: quality])
      }).first(where: { $0.count <= 520_000 })
    else { return ["sequence": current, "data": ""] }
    let string = data.base64EncodedString()
    lock.lock()
    if (encoded?.sequence ?? -1) < current { encoded = (current, string) }
    lock.unlock()
    return ["sequence": current, "data": string]
  }
  func stream(_ stream: SCStream, didStopWithError error: Error) {
    stop()
    emit([
      "method": "Native.disconnected",
      "params": [
        "targetId": targetID, "code": (error as NSError).code, "domain": (error as NSError).domain,
      ],
    ])
  }
  func stream(
    _ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
    of type: SCStreamOutputType
  ) {
    guard type == .screen, sampleBuffer.isValid,
      let attachments = CMSampleBufferGetSampleAttachmentsArray(
        sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
      let status = attachments.first?[.status] as? Int,
      status == SCFrameStatus.complete.rawValue,
      let buffer = CMSampleBufferGetImageBuffer(sampleBuffer)
    else { return }
    lock.lock()
    if recording {
      // Presentation time is host (mach) time; convert its age to wall-clock epoch.
      let presented = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
      let age =
        presented.isValid
        ? max(0, CMTimeGetSeconds(CMTimeSubtract(CMClockGetTime(CMClockGetHostTimeClock()), presented)))
        : 0
      let width = Double(CVPixelBufferGetWidth(buffer))
      let height = Double(CVPixelBufferGetHeight(buffer))
      let rects = (attachments.first?[.dirtyRects] as? [NSDictionary] ?? []).prefix(32).compactMap {
        CGRect(dictionaryRepresentation: $0 as CFDictionary)
      }
      let normalized = rects.map {
        [$0.minX / width, $0.minY / height, $0.width / width, $0.height / height]
      }
      changes.append([
        "t": epochMilliseconds() - age * 1000,
        "area": rects.isEmpty ? 1 : min(1, rects.reduce(0) { $0 + $1.width * $1.height } / (width * height)),
        "rects": rects.isEmpty ? [[0.0, 0.0, 1.0, 1.0]] : normalized,
      ])
      if changes.count > 4000 { changes.removeFirst(changes.count - 4000) }
    }
    pixel = buffer
    sequence += 1
    let current = sequence
    let ready = waiters.filter { $0.value.after < current }
    for id in ready.keys { waiters.removeValue(forKey: id) }
    lock.unlock()
    for waiter in ready.values { waiter.continuation.resume() }
  }
}

// MARK: Accessibility snapshot

private let snapshotAttributes =
  [
    kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute,
    kAXValueAttribute, kAXPositionAttribute, kAXSizeAttribute, kAXEnabledAttribute,
    kAXFocusedAttribute, kAXSelectedAttribute, "AXPlaceholderValue", kAXHelpAttribute,
  ] as CFArray
// Unlabeled containers add depth and tokens but no information; their children
// are listed in place.
private let structuralRoles: Set<String> = [
  "", "AXGroup", "AXGenericElement", "AXUnknown", "AXSplitGroup", "AXScrollArea", "AXLayoutArea",
  "AXLayoutItem", "AXSplitter", "AXMatte",
]
private func present(_ value: AnyObject?) -> AnyObject? {
  guard let value else { return nil }
  if CFGetTypeID(value) == AXValueGetTypeID(), AXValueGetType(value as! AXValue) == .axError {
    return nil
  }
  return value
}
private func text(_ value: AnyObject?) -> String {
  switch present(value) {
  case let string as String: return string
  case let attributed as NSAttributedString: return attributed.string
  case let number as NSNumber: return number.stringValue
  default: return ""
  }
}
private func flag(_ value: AnyObject?) -> Bool { (present(value) as? NSNumber)?.boolValue ?? false }
func axFrame(_ element: AXUIElement) -> CGRect? {
  var rawPoint: CFTypeRef?
  var rawSize: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &rawPoint) == .success,
    AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &rawSize) == .success
  else { return nil }
  return axRect(rawPoint, rawSize)
}
private func axRect(_ rawPoint: AnyObject?, _ rawSize: AnyObject?) -> CGRect? {
  guard let rawPoint = present(rawPoint), let rawSize = present(rawSize),
    CFGetTypeID(rawPoint) == AXValueGetTypeID(), CFGetTypeID(rawSize) == AXValueGetTypeID()
  else { return nil }
  var point = CGPoint.zero
  var size = CGSize.zero
  guard AXValueGetValue(rawPoint as! AXValue, .cgPoint, &point),
    AXValueGetValue(rawSize as! AXValue, .cgSize, &size)
  else { return nil }
  return CGRect(origin: point, size: size)
}
private func quoted(_ raw: String, _ limit: Int) -> String {
  var value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
  if value.count > limit { value = String(value.prefix(limit)) + "…" }
  return "\""
    + value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
    .replacingOccurrences(of: "\n", with: "\\n").replacingOccurrences(of: "\r", with: "") + "\""
}
private func children(_ element: AXUIElement) -> (list: [AXUIElement], total: Int) {
  var count: CFIndex = 0
  guard
    AXUIElementGetAttributeValueCount(element, kAXChildrenAttribute as CFString, &count) == .success,
    count > 0
  else { return ([], 0) }
  if count > 300 {
    // Large grids and lists often expose only their visible portion here.
    var visible: CFTypeRef?
    if AXUIElementCopyAttributeValue(element, "AXVisibleChildren" as CFString, &visible) == .success,
      let list = visible as? [AXUIElement], !list.isEmpty
    {
      return (Array(list.prefix(300)), count)
    }
  }
  var raw: CFArray?
  guard
    AXUIElementCopyAttributeValues(
      element, kAXChildrenAttribute as CFString, 0, min(count, 300), &raw) == .success,
    let list = raw as? [AXUIElement]
  else { return ([], count) }
  return (list, count)
}
// Compact, indented outline that an agent can read and target. Coordinates are
// normalized element centers in the window, directly usable as click x/y.
func accessibilitySnapshot(root: AXUIElement, window: WindowInfo) -> (
  text: String, refs: [AXUIElement], truncated: Bool
) {
  let deadline = ContinuousClock.now.advanced(by: .seconds(3))
  let frame = window.frame
  var refs: [AXUIElement] = []
  var lines: [String] = []
  var budget = 120_000
  var truncated = false
  func visit(_ element: AXUIElement, indent: Int, level: Int) {
    if truncated { return }
    if refs.count >= 1500 || budget <= 0 || ContinuousClock.now > deadline {
      truncated = true
      return
    }
    var raw: CFArray?
    guard
      AXUIElementCopyMultipleAttributeValues(
        element, snapshotAttributes, AXCopyMultipleAttributeOptions(rawValue: 0), &raw) == .success,
      let values = raw as? [AnyObject], values.count == 12
    else { return }
    let rect = axRect(values[5], values[6])
    // Off-window subtrees (scrolled-out cells, collapsed panes) are skipped.
    if let rect, rect.width > 0, rect.height > 0, !rect.intersects(frame) { return }
    let role = text(values[0])
    let subrole = text(values[1])
    let title = text(values[2])
    let description = text(values[3])
    let placeholder = text(values[10])
    let name =
      [title, description, placeholder].first { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
      ?? (text(values[11]))
    var value = subrole == "AXSecureTextField" ? "" : text(values[4])
    if value == name { value = "" }
    let structural =
      structuralRoles.contains(role) && name.trimmingCharacters(in: .whitespaces).isEmpty
      && value.isEmpty
    var childIndent = indent
    if !structural {
      var line = String(repeating: "  ", count: min(indent, 24)) + "[e\(refs.count)] "
      line += role.hasPrefix("AX") ? String(role.dropFirst(2)) : role
      if !subrole.isEmpty, subrole != "AXUnknown" {
        line += ":" + (subrole.hasPrefix("AX") ? String(subrole.dropFirst(2)) : subrole)
      }
      if !name.isEmpty { line += " " + quoted(name, 160) }
      if subrole == "AXSecureTextField" {
        line += " = [secure]"
      } else if !value.isEmpty {
        line += " = " + quoted(value, 300)
      }
      var states: [String] = []
      if flag(values[8]) { states.append("focused") }
      if flag(values[9]) { states.append("selected") }
      if present(values[7]) != nil && !flag(values[7]) { states.append("disabled") }
      if !states.isEmpty { line += " (" + states.joined(separator: ", ") + ")" }
      if let rect, rect.width > 0, rect.height > 0, frame.width > 0, frame.height > 0 {
        let x = min(1, max(0, (rect.midX - frame.minX) / frame.width))
        let y = min(1, max(0, (rect.midY - frame.minY) / frame.height))
        line += String(
          format: " @%.3f,%.3f %.3fx%.3f", x, y, rect.width / frame.width, rect.height / frame.height)
      }
      refs.append(element)
      lines.append(line)
      budget -= line.utf8.count + 1
      childIndent += 1
    }
    guard level < 80 else { return }
    let (list, total) = children(element)
    for child in list { visit(child, indent: childIndent, level: level + 1) }
    if total > list.count, !truncated {
      lines.append(
        String(repeating: "  ", count: min(childIndent, 24))
          + "… \(total - list.count) more children not listed")
    }
  }
  visit(root, indent: 0, level: 0)
  var header =
    "Accessibility snapshot of \(quoted(window.title, 200)) (\(Int(frame.width))×\(Int(frame.height)) pt), \(refs.count) elements. "
    + "@x,y is the normalized element center for click/move/drag; [eN] refs work with press and click/move {ref} until the next snapshot."
  if truncated {
    header +=
      "\nTruncated at the 1500-element, 3-second, or 120 KB limit. Snapshot a subtree with ref to see more."
  }
  return (([header] + lines).joined(separator: "\n"), refs, truncated)
}

@MainActor final class Session {
  let windowID: CGWindowID
  let pid: pid_t
  let frames: Frames
  var stream: SCStream?
  var configuredSize = CGSize.zero
  var axWindow: AXUIElement?
  var refs: [AXUIElement] = []
  var framesPerSecond: Int32 = 3
  var sampler: Task<Void, Never>?
  var samples: [[String: Any]] = []
  init(id: String) throws {
    let parts = id.split(separator: ":")
    guard parts.count == 3, parts[0] == "mac", let pid = Int32(parts[1]),
      let window = UInt32(parts[2]), pid > 0
    else { throw Failure.invalid_command }
    self.pid = pid
    windowID = window
    frames = Frames(targetID: id)
  }
  func info() throws -> WindowInfo { try windowInfo(pid: pid, windowID: windowID) }
  func configuration(for size: CGSize) -> SCStreamConfiguration {
    let config = SCStreamConfiguration()
    let scale = min(2.0, 2048.0 / max(1, size.width), 1600.0 / max(1, size.height))
    config.width = max(1, Int(size.width * scale))
    config.height = max(1, Int(size.height * scale))
    config.minimumFrameInterval = CMTime(value: 1, timescale: framesPerSecond)
    config.queueDepth = framesPerSecond > 3 ? 5 : 3
    config.showsCursor = false
    config.capturesAudio = false
    config.ignoreShadowsSingleWindow = true
    config.scalesToFit = true
    configuredSize = size
    return config
  }
  func start() async throws {
    guard
      let window = try await windows().first(where: {
        $0.windowID == windowID && $0.owningApplication?.processID == pid
      })
    else { throw Failure.target_missing }
    let config = configuration(for: window.frame.size)
    let stream = SCStream(
      filter: SCContentFilter(desktopIndependentWindow: window), configuration: config,
      delegate: frames)
    try stream.addStreamOutput(
      frames, type: .screen,
      sampleHandlerQueue: DispatchQueue(
        label: "deckhand.external.frames", qos: .userInitiated, autoreleaseFrequency: .workItem))
    try await stream.startCapture()
    self.stream = stream
    // A minimized window produces no frames; attach anyway rather than stalling
    // the helper, and report the image as unavailable until one arrives.
    await frames.wait(after: 0, timeout: .seconds(3))
  }
  func stop() async {
    sampler?.cancel()
    sampler = nil
    try? await stream?.stopCapture()
    stream = nil
    frames.stop()
  }
  func frame(_ params: [String: Any]) async throws -> [String: Any] {
    let size = try info().frame.size
    if size != configuredSize, let stream {
      try await stream.updateConfiguration(configuration(for: size))
    }
    // After input, wait briefly for the window to repaint so the caller sees its result.
    if let after = params["after"] as? Int {
      let wait = max(0, min(1500, params["waitMs"] as? Int ?? 600))
      await frames.wait(after: after, timeout: .milliseconds(wait))
    }
    let known = params["known"] as? Int
    let frames = self.frames
    return await Task.detached(priority: .userInitiated) { frames.latest(known: known) }.value
  }
  func matches(_ element: AXUIElement, _ window: WindowInfo) -> Bool {
    guard let frame = axFrame(element) else { return false }
    var rawTitle: CFTypeRef?
    AXUIElementCopyAttributeValue(element, kAXTitleAttribute as CFString, &rawTitle)
    return abs(frame.minX - window.frame.minX) < 5 && abs(frame.minY - window.frame.minY) < 5
      && abs(frame.width - window.frame.width) < 5 && abs(frame.height - window.frame.height) < 5
      && (rawTitle as? String ?? "") == window.title
  }
  func resolveWindow(_ window: WindowInfo) throws -> AXUIElement {
    guard AXIsProcessTrusted() else { throw Failure.accessibility_permission }
    if let axWindow, matches(axWindow, window) { return axWindow }
    // AX has no public CGWindowID property. Match both title and rectangle,
    // refusing an ambiguous candidate instead of sending input to a different window.
    let app = AXUIElementCreateApplication(pid)
    var raw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &raw) == .success,
      let candidates = raw as? [AXUIElement]
    else { throw Failure.target_missing }
    let found = candidates.filter { matches($0, window) }
    guard found.count == 1, let selected = found.first else { throw Failure.target_missing }
    axWindow = selected
    return selected
  }
  func isFocused(_ selected: AXUIElement) -> Bool {
    var focused: CFTypeRef?
    return NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
      && AXUIElementCopyAttributeValue(
        AXUIElementCreateApplication(pid), kAXFocusedWindowAttribute as CFString, &focused)
        == .success
      && focused.map { CFEqual($0, selected) } == true
  }
  func focus(_ window: WindowInfo) async throws {
    let selected = try resolveWindow(window)
    // Re-raising an already focused WKWebView can clear its text selection
    // between an editing shortcut and the following text command.
    if isFocused(selected) { return }
    let app = AXUIElementCreateApplication(pid)
    var minimized: CFTypeRef?
    if AXUIElementCopyAttributeValue(selected, kAXMinimizedAttribute as CFString, &minimized)
      == .success, (minimized as? Bool) == true
    {
      AXUIElementSetAttributeValue(selected, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
    }
    AXUIElementSetAttributeValue(app, kAXFocusedWindowAttribute as CFString, selected)
    AXUIElementSetAttributeValue(selected, kAXMainAttribute as CFString, kCFBooleanTrue)
    guard AXUIElementPerformAction(selected, kAXRaiseAction as CFString) == .success else {
      throw Failure.unavailable
    }
    NSRunningApplication(processIdentifier: pid)?.activate()
    let deadline = ContinuousClock.now.advanced(by: .milliseconds(800))
    while !isFocused(selected) && ContinuousClock.now < deadline {
      try await Task.sleep(for: .milliseconds(10))
    }
    guard isFocused(selected) else { throw Failure.unavailable }
  }
  func element(_ ref: Any?) throws -> AXUIElement {
    guard let ref = ref as? String, ref.hasPrefix("e"), let index = Int(ref.dropFirst()),
      refs.indices.contains(index)
    else { throw Failure.invalid_command }
    return refs[index]
  }
  func snapshot(_ params: [String: Any]) async throws -> [String: Any] {
    // Reading never activates the window or moves the pointer.
    let window = try info()
    let root = params["ref"] == nil ? try resolveWindow(window) : try element(params["ref"])
    let result = await Task.detached(priority: .userInitiated) {
      accessibilitySnapshot(root: root, window: window)
    }.value
    refs = result.refs
    return ["text": result.text, "elements": result.refs.count, "truncated": result.truncated]
  }
  func command(_ method: String, _ params: [String: Any]) async throws -> [String: Any] {
    switch method {
    case "Native.frame": return try await frame(params)
    case "Native.snapshot": return try await snapshot(params)
    case "Native.benchmark": return try await benchmark(params["enabled"] as? Bool == true)
    case "Native.timeline":
      let since = params["since"] as? Double ?? 0
      return [
        "now": epochMilliseconds(), "changes": frames.changes(since: since),
        "samples": Array(samples.lazy.filter { ($0["t"] as? Double ?? 0) > since }.prefix(1000)),
      ]
    default: break
    }
    guard method.hasPrefix("Native.") else { throw Failure.invalid_command }
    // AppKit WebKit views require the selected window to be key before
    // native mouse/keyboard dispatch. Make that activation explicit in UI.
    try await focus(try info())
    let frame = try info().frame
    var flags: CGEventFlags = []
    for modifier in params["modifiers"] as? [String] ?? [] {
      switch modifier {
      case "meta": flags.insert(.maskCommand)
      case "alt": flags.insert(.maskAlternate)
      case "shift": flags.insert(.maskShift)
      case "control": flags.insert(.maskControl)
      default: throw Failure.invalid_command
      }
    }
    // Wall-clock time of the first dispatched event, for latency measurement.
    var at: Double?
    func post(_ event: CGEvent?, extra: CGEventFlags = []) throws {
      guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid, let event else {
        throw Failure.unavailable
      }
      if at == nil { at = epochMilliseconds() }
      event.flags = flags.union(extra)
      event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(windowID))
      event.setIntegerValueField(
        .mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(windowID))
      event.post(tap: .cghidEventTap)
    }
    func point(_ xKey: String, _ yKey: String) throws -> CGPoint {
      guard let x = params[xKey] as? Double, let y = params[yKey] as? Double, x.isFinite,
        y.isFinite, (0...1).contains(x), (0...1).contains(y)
      else { throw Failure.invalid_command }
      return CGPoint(x: frame.minX + x * frame.width, y: frame.minY + y * frame.height)
    }
    func target() throws -> CGPoint {
      guard params["ref"] != nil else { return try point("x", "y") }
      // Resolve the element's current position so scrolling since the snapshot is harmless.
      guard let rect = axFrame(try element(params["ref"])), rect.width > 0, rect.height > 0,
        frame.contains(CGPoint(x: rect.midX, y: rect.midY))
      else { throw Failure.invalid_command }
      return CGPoint(x: rect.midX, y: rect.midY)
    }
    func mouse(_ type: CGEventType, _ at: CGPoint, _ button: CGMouseButton = .left) -> CGEvent? {
      CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: at, mouseButton: button)
    }
    switch method {
    case "Native.focus": break
    case "Native.press":
      at = epochMilliseconds()
      let result = AXUIElementPerformAction(try element(params["ref"]), kAXPressAction as CFString)
      guard result == .success else {
        throw result == .actionUnsupported ? Failure.invalid_command : Failure.unavailable
      }
    case "Native.move":
      try post(mouse(.mouseMoved, try target()))
    case "Native.scroll":
      let at = try point("x", "y")
      let dx = max(-1200, min(1200, params["deltaX"] as? Int ?? 0))
      let dy = max(-1200, min(1200, params["deltaY"] as? Int ?? 0))
      let event = CGEvent(
        scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: Int32(-dy),
        wheel2: Int32(-dx), wheel3: 0)
      event?.location = at
      try post(event)
    case "Native.click":
      let at = try target()
      let right = params["button"] as? String == "right"
      let count = params["clickCount"] as? Int == 2 ? 2 : 1
      // Hover first: some web controls only arm on pointer enter.
      try post(mouse(.mouseMoved, at))
      for click in 1...count {
        let down = mouse(right ? .rightMouseDown : .leftMouseDown, at, right ? .right : .left)
        let up = mouse(right ? .rightMouseUp : .leftMouseUp, at, right ? .right : .left)
        down?.setIntegerValueField(.mouseEventClickState, value: Int64(click))
        up?.setIntegerValueField(.mouseEventClickState, value: Int64(click))
        try post(down)
        try post(up)
      }
    case "Native.drag":
      let from = try point("x", "y")
      let to = try point("toX", "toY")
      try post(mouse(.mouseMoved, from))
      try post(mouse(.leftMouseDown, from))
      do {
        for step in 1...12 {
          let t = Double(step) / 12
          try post(
            mouse(
              .leftMouseDragged,
              CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)))
          try await Task.sleep(for: .milliseconds(16))
        }
        try post(mouse(.leftMouseUp, to))
      } catch {
        // Never leave the system mouse button held down.
        mouse(.leftMouseUp, to)?.post(tap: .cghidEventTap)
        throw error
      }
    case "Native.type":
      guard let text = params["text"] as? String, text.utf16.count <= 4000 else {
        throw Failure.invalid_command
      }
      // Chunk UTF-16 only at Swift Character boundaries; never alter the user's clipboard.
      for character in text {
        let units = Array(String(character).utf16)
        let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
        let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
        units.withUnsafeBufferPointer { buffer in
          down?.keyboardSetUnicodeString(
            stringLength: buffer.count, unicodeString: buffer.baseAddress!)
          up?.keyboardSetUnicodeString(
            stringLength: buffer.count, unicodeString: buffer.baseAddress!)
        }
        try post(down)
        try post(up)
      }
    case "Native.key":
      guard let key = params["key"] as? String, let code = keyCodes[key] else {
        throw Failure.invalid_command
      }
      // AppKit marks arrows and other function keys with these flags; Excel's
      // selection-extending shortcuts depend on them.
      let extra: CGEventFlags =
        ["ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp"].contains(key)
        ? [.maskNumericPad, .maskSecondaryFn]
        : (key.count > 1 && key.hasPrefix("F"))
          || ["Home", "End", "PageUp", "PageDown", "Delete"].contains(key)
          ? .maskSecondaryFn : []
      try post(CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true), extra: extra)
      try post(CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false), extra: extra)
    default: throw Failure.invalid_command
    }
    return ["accepted": true, "at": at ?? epochMilliseconds()]
  }
  // High-rate repaint timing plus CPU/memory sampling of the app and the WebKit helper
  // processes macOS groups with it (task pane WebContent, GPU and networking).
  func benchmark(_ enabled: Bool) async throws -> [String: Any] {
    let rate: Int32 = enabled ? 60 : 3
    if rate != framesPerSecond {
      framesPerSecond = rate
      if let stream { try await stream.updateConfiguration(configuration(for: try info().frame.size)) }
    }
    frames.record(enabled)
    sampler?.cancel()
    sampler = nil
    samples.removeAll()
    var meter = ProcessMeter(pid: pid)
    if enabled {
      sampler = Task { @MainActor [weak self] in
        while !Task.isCancelled {
          let sample = meter.sample()
          guard let self else { return }
          self.samples.append(sample)
          if self.samples.count > 3000 { self.samples.removeFirst(self.samples.count - 3000) }
          try? await Task.sleep(for: .milliseconds(200))
        }
      }
    }
    return ["enabled": enabled, "processes": meter.members.count, "grouped": meter.grouped]
  }
}
// libproc's resource-coalition flavor groups an app with the XPC services launched for
// it, as Activity Monitor's Energy view does. Read-only; if unsupported, only the app
// process itself is measured.
private struct CoalitionInfo {
  var resource: UInt64 = 0
  var jetsam: UInt64 = 0
  var reserved1: UInt64 = 0
  var reserved2: UInt64 = 0
  var reserved3: UInt64 = 0
}
private func coalition(_ pid: pid_t) -> UInt64? {
  var info = CoalitionInfo()
  let size = Int32(MemoryLayout<CoalitionInfo>.size)
  return proc_pidinfo(pid, 20, 0, &info, size) == size && info.resource != 0 ? info.resource : nil
}
struct ProcessMeter {
  let pid: pid_t
  var members: [pid_t] = []
  var grouped = false
  private var refreshed = 0.0
  private var cpu: [pid_t: Double] = [:]
  private var sampledAt = 0.0
  private let timebase: Double = {
    var info = mach_timebase_info_data_t()
    mach_timebase_info(&info)
    return Double(info.numer) / Double(info.denom)
  }()
  init(pid: pid_t) {
    self.pid = pid
    refresh()
  }
  mutating func refresh() {
    refreshed = epochMilliseconds()
    guard let group = coalition(pid) else {
      members = [pid]
      return
    }
    var pids = [pid_t](repeating: 0, count: 8192)
    let count = proc_listallpids(&pids, Int32(pids.count * MemoryLayout<pid_t>.size))
    members = pids.prefix(Int(max(0, count))).filter { $0 > 0 && ($0 == pid || coalition($0) == group) }
    if !members.contains(pid) { members.append(pid) }
    grouped = members.count > 1
  }
  // CPU is percent of one core across the group since the previous sample (may exceed 100).
  mutating func sample() -> [String: Any] {
    let now = epochMilliseconds()
    if now - refreshed > 2000 { refresh() }
    var memory: UInt64 = 0
    var busy = 0.0
    var next: [pid_t: Double] = [:]
    for member in members {
      var usage = rusage_info_v4()
      let result = withUnsafeMutablePointer(to: &usage) {
        $0.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) {
          proc_pid_rusage(member, RUSAGE_INFO_V4, $0)
        }
      }
      guard result == 0 else { continue }
      let total = Double(usage.ri_user_time + usage.ri_system_time) * timebase / 1_000_000
      if let previous = cpu[member] { busy += max(0, total - previous) }
      next[member] = total
      memory += usage.ri_phys_footprint
    }
    let elapsed = sampledAt > 0 ? now - sampledAt : 0
    cpu = next
    sampledAt = now
    return [
      "t": now, "cpu": elapsed > 0 ? busy / elapsed * 100 : 0, "memory": Double(memory),
      "processes": next.count,
    ]
  }
}
// US-layout virtual key codes.
let keyCodes: [String: CGKeyCode] = [
  "Enter": 36, "Tab": 48, "Space": 49, "Escape": 53, "Backspace": 51, "Delete": 117,
  "ArrowLeft": 123, "ArrowRight": 124, "ArrowDown": 125, "ArrowUp": 126, "Home": 115, "End": 119,
  "PageUp": 116, "PageDown": 121, "F1": 122, "F2": 120, "F3": 99, "F4": 118, "F5": 96, "F6": 97,
  "F7": 98, "F8": 100, "F9": 101, "F10": 109, "F11": 103, "F12": 111, "a": 0, "s": 1, "d": 2,
  "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14,
  "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24,
  "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34,
  "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45,
  "m": 46, ".": 47, "`": 50,
]

@MainActor final class Helper {
  var sessions: [String: Session] = [:]
  // Session-changing work and input run in order; frames, discovery, launch and
  // permission checks run alongside so a slow launch or snapshot never stalls panels.
  var tail: Task<Void, Never>?
  func dispatch(_ id: Int, _ method: String, _ params: [String: Any]) {
    if ["Native.frame", "Native.timeline", "Native.list", "Native.open", "Native.permissions"]
      .contains(method)
    {
      Task { await self.handle(id, method, params) }
    } else {
      let previous = tail
      tail = Task {
        await previous?.value
        await self.handle(id, method, params)
      }
    }
  }
  func handle(_ id: Int, _ method: String, _ params: [String: Any]) async {
    do {
      emit(["id": id, "result": try await run(method, params)])
    } catch { emit(["id": id, "error": (error as? Failure)?.rawValue ?? "unavailable"]) }
  }
  func run(_ method: String, _ params: [String: Any]) async throws -> [String: Any] {
    let targetID = params["targetId"] as? String ?? ""
    switch method {
    case "Native.open":
      // Resolve installed apps by identity, never arbitrary executable paths or URLs.
      guard let bundleID = params["bundleId"] as? String, bundleID.utf8.count <= 240,
        bundleID.range(of: "^[a-zA-Z0-9-]+(\\.[a-zA-Z0-9-]+)+$", options: .regularExpression) != nil
      else { throw Failure.invalid_command }
      guard CGPreflightScreenCaptureAccess() else { throw Failure.screen_permission }
      guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) else {
        throw Failure.app_missing
      }
      let configuration = NSWorkspace.OpenConfiguration()
      configuration.createsNewApplicationInstance = false
      configuration.activates = true
      let app = try await NSWorkspace.shared.openApplication(at: url, configuration: configuration)
      // Office cold launches can take many seconds before the first window.
      let deadline = ContinuousClock.now.advanced(by: .seconds(app.isFinishedLaunching ? 4 : 25))
      while !hasCapturableWindow(app.processIdentifier) && ContinuousClock.now < deadline {
        try await Task.sleep(for: .milliseconds(250))
      }
      return ["opened": true, "windows": hasCapturableWindow(app.processIdentifier)]
    case "Native.list":
      return [
        "targets": try await windows().prefix(200).map(row),
        "accessibility": AXIsProcessTrusted(),
      ]
    case "Native.permissions":
      return [
        "screenRecording": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted(),
      ]
    case "Native.attach":
      guard sessions[targetID] == nil, sessions.count < 16 else { throw Failure.invalid_command }
      let session = try Session(id: targetID)
      try await session.start()
      sessions[targetID] = session
      return ["attached": true]
    case "Native.detach":
      await sessions.removeValue(forKey: targetID)?.stop()
      return ["detached": true]
    default:
      guard let session = sessions[targetID] else { throw Failure.target_missing }
      return try await session.command(method, params)
    }
  }
}
@main struct Main {
  @MainActor static func main() async {
    guard CommandLine.arguments.dropFirst().first == "--serve" else {
      emit(["error": "invalid_command"])
      return
    }
    // A hung host app must not hang snapshots or input indefinitely.
    AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 1.0)
    let helper = Helper()
    emit(["ready": true])
    // Keep AppKit's main run loop free for ScreenCaptureKit and AX while
    // stdin blocks on its own thread. The server bounds outstanding requests.
    let input = AsyncStream<String>(bufferingPolicy: .unbounded) { continuation in
      DispatchQueue.global(qos: .userInitiated).async {
        while let line = readLine() { continuation.yield(line) }
        continuation.finish()
      }
    }
    for await line in input {
      guard line.utf8.count < 32_000, let bytes = line.data(using: .utf8),
        let command = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
        let id = command["id"] as? Int, let method = command["method"] as? String
      else { continue }
      helper.dispatch(id, method, command["params"] as? [String: Any] ?? [:])
    }
    await helper.tail?.value
    for session in helper.sessions.values { await session.stop() }
  }
}
