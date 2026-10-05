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
func emit(_ value: Any) {
  guard JSONSerialization.isValidJSONObject(value),
    let data = try? JSONSerialization.data(withJSONObject: value)
  else { return }
  FileHandle.standardOutput.write(data + Data([10]))
}
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
final class Frames: NSObject, SCStreamOutput, SCStreamDelegate {
  let targetID: String
  init(targetID: String) {
    self.targetID = targetID
    super.init()
  }
  private let lock = NSLock()
  private let context = CIContext(options: [.cacheIntermediates: false])
  private var image = ""
  private var sequence = 0
  private var firstFrame: CheckedContinuation<Void, Never>?
  func waitForFirstFrame() async {
    await withCheckedContinuation { continuation in
      lock.lock()
      if sequence > 0 {
        lock.unlock()
        continuation.resume()
      } else {
        firstFrame = continuation
        lock.unlock()
      }
    }
  }
  func latest() -> [String: Any] {
    lock.lock()
    defer { lock.unlock() }
    return ["data": image, "sequence": sequence]
  }
  func stream(_ stream: SCStream, didStopWithError error: Error) {
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
      let pixel = CMSampleBufferGetImageBuffer(sampleBuffer)
    else { return }
    let input = CIImage(cvPixelBuffer: pixel)
    guard let cg = context.createCGImage(input, from: input.extent) else { return }
    let bitmap = NSBitmapImageRep(cgImage: cg)
    guard
      let data = [0.72, 0.50, 0.32, 0.18].lazy.compactMap({ quality in
        bitmap.representation(using: .jpeg, properties: [.compressionFactor: quality])
      }).first(where: { $0.count <= 520_000 })
    else { return }
    lock.lock()
    image = data.base64EncodedString()
    sequence += 1
    let waiting = firstFrame
    firstFrame = nil
    lock.unlock()
    waiting?.resume()
  }
}
@MainActor final class Session {
  let windowID: CGWindowID
  let pid: pid_t
  let frames: Frames
  var stream: SCStream?
  var configuredSize = CGSize.zero
  init(id: String) throws {
    let parts = id.split(separator: ":")
    guard parts.count == 3, parts[0] == "mac", let pid = Int32(parts[1]),
      let window = UInt32(parts[2]), pid > 0
    else { throw Failure.invalid_command }
    self.pid = pid
    windowID = window
    frames = Frames(targetID: id)
  }
  func current() async throws -> SCWindow {
    guard
      let window = try await windows().first(where: {
        $0.windowID == windowID && $0.owningApplication?.processID == pid
      })
    else { throw Failure.target_missing }
    return window
  }
  func configuration(for size: CGSize) -> SCStreamConfiguration {
    let config = SCStreamConfiguration()
    let scale = min(2.0, 2048.0 / max(1, size.width), 1600.0 / max(1, size.height))
    config.width = max(1, Int(size.width * scale))
    config.height = max(1, Int(size.height * scale))
    config.minimumFrameInterval = CMTime(value: 1, timescale: 3)
    config.queueDepth = 3
    config.showsCursor = false
    config.capturesAudio = false
    config.ignoreShadowsSingleWindow = true
    config.scalesToFit = true
    configuredSize = size
    return config
  }
  func start() async throws {
    let window = try await current()
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
    await frames.waitForFirstFrame()
  }
  func focus(_ window: SCWindow, activate: Bool) throws -> AXUIElement {
    guard AXIsProcessTrusted() else { throw Failure.accessibility_permission }
    // AX has no public CGWindowID property. Match both title and rectangle,
    // refusing an ambiguous candidate instead of sending input to a different window.
    let app = AXUIElementCreateApplication(pid)
    var raw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &raw) == .success,
      let candidates = raw as? [AXUIElement]
    else { throw Failure.target_missing }
    let matches = candidates.filter { candidate in
      var rawPoint: CFTypeRef?
      var rawSize: CFTypeRef?
      var rawTitle: CFTypeRef?
      AXUIElementCopyAttributeValue(candidate, kAXPositionAttribute as CFString, &rawPoint)
      AXUIElementCopyAttributeValue(candidate, kAXSizeAttribute as CFString, &rawSize)
      AXUIElementCopyAttributeValue(candidate, kAXTitleAttribute as CFString, &rawTitle)
      guard let rawPoint, let rawSize,
        CFGetTypeID(rawPoint) == AXValueGetTypeID(), CFGetTypeID(rawSize) == AXValueGetTypeID()
      else { return false }
      var point = CGPoint.zero
      var size = CGSize.zero
      AXValueGetValue(rawPoint as! AXValue, .cgPoint, &point)
      AXValueGetValue(rawSize as! AXValue, .cgSize, &size)
      return abs(point.x - window.frame.minX) < 5 && abs(point.y - window.frame.minY) < 5
        && abs(size.width - window.frame.width) < 5 && abs(size.height - window.frame.height) < 5
        && (rawTitle as? String ?? "") == (window.title ?? "")
    }
    guard matches.count == 1, let selected = matches.first else { throw Failure.target_missing }
    var focused: CFTypeRef?
    if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
      AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &focused) == .success,
      focused.map({ CFEqual($0, selected) }) == true
    {
      // Re-raising an already focused WKWebView can clear its text selection
      // between an editing shortcut and the following text command.
      return selected
    }
    AXUIElementSetAttributeValue(app, kAXFocusedWindowAttribute as CFString, selected)
    AXUIElementSetAttributeValue(selected, kAXMainAttribute as CFString, kCFBooleanTrue)
    if activate {
      guard AXUIElementPerformAction(selected, kAXRaiseAction as CFString) == .success else {
        throw Failure.unavailable
      }
      NSRunningApplication(processIdentifier: pid)?.activate()
    }
    return selected
  }
  func command(_ method: String, _ params: [String: Any]) async throws -> [String: Any] {
    if method == "Page.captureScreenshot" {
      // Fast WindowServer identity check; do not re-enumerate all shareable
      // windows through ScreenCaptureKit for each cached-frame read.
      guard
        let info = CGWindowListCopyWindowInfo(.optionIncludingWindow, windowID) as? [[String: Any]],
        let selected = info.first(where: {
          ($0[kCGWindowOwnerPID as String] as? Int32) == pid
            && ($0[kCGWindowNumber as String] as? UInt32) == windowID
        })
      else { throw Failure.target_missing }
      if let bounds = selected[kCGWindowBounds as String] as? [String: Any],
        let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary),
        rect.size != configuredSize
      {
        try await stream?.updateConfiguration(configuration(for: rect.size))
      }
      return frames.latest()
    }
    if method == "Native.permissions" {
      return [
        "screenRecording": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted(),
      ]
    }
    guard method.hasPrefix("Native.") else { throw Failure.invalid_command }
    let window = try await current()
    // AppKit WebKit views require the selected window to be key before
    // native mouse/keyboard dispatch. Make that activation explicit in UI.
    let selected = try focus(window, activate: true)
    func isFocused() -> Bool {
      var focused: CFTypeRef?
      let app = AXUIElementCreateApplication(pid)
      return NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
        && AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &focused)
          == .success
        && focused.map { CFEqual($0, selected) } == true
    }
    let deadline = ContinuousClock.now.advanced(by: .milliseconds(500))
    while !isFocused() && ContinuousClock.now < deadline {
      try await Task.sleep(for: .milliseconds(10))
    }
    guard isFocused() else { throw Failure.unavailable }
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
    func post(_ event: CGEvent?) throws {
      guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid, let event else {
        throw Failure.unavailable
      }
      event.flags = flags
      event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(windowID))
      event.setIntegerValueField(
        .mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(windowID))
      event.post(tap: .cghidEventTap)
    }
    switch method {
    case "Native.focus": break
    case "Native.click", "Native.scroll":
      guard let x = params["x"] as? Double, let y = params["y"] as? Double, x.isFinite, y.isFinite,
        (0...1).contains(x), (0...1).contains(y)
      else { throw Failure.invalid_command }
      let point = CGPoint(
        x: window.frame.minX + x * window.frame.width,
        y: window.frame.minY + y * window.frame.height)
      if method == "Native.scroll" {
        let dx = max(-1200, min(1200, params["deltaX"] as? Int ?? 0))
        let dy = max(-1200, min(1200, params["deltaY"] as? Int ?? 0))
        let event = CGEvent(
          scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: Int32(-dy),
          wheel2: Int32(-dx), wheel3: 0)
        event?.location = point
        try post(event)
      } else {
        let right = params["button"] as? String == "right"
        let down = CGEvent(
          mouseEventSource: nil, mouseType: right ? .rightMouseDown : .leftMouseDown,
          mouseCursorPosition: point, mouseButton: right ? .right : .left)
        let up = CGEvent(
          mouseEventSource: nil, mouseType: right ? .rightMouseUp : .leftMouseUp,
          mouseCursorPosition: point, mouseButton: right ? .right : .left)
        let count = params["clickCount"] as? Int == 2 ? 2 : 1
        down?.setIntegerValueField(.mouseEventClickState, value: Int64(count))
        up?.setIntegerValueField(.mouseEventClickState, value: Int64(count))
        try post(down)
        try post(up)
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
      let keys: [String: CGKeyCode] = [
        "Enter": 36, "Tab": 48, "Escape": 53, "Backspace": 51, "Delete": 117, "ArrowLeft": 123,
        "ArrowRight": 124, "ArrowDown": 125, "ArrowUp": 126, "Home": 115, "End": 119, "PageUp": 116,
        "PageDown": 121, "F6": 97, "F7": 98, "F8": 100, "a": 0, "c": 8, "v": 9, "x": 7, "z": 6,
        "n": 45, "o": 31, "s": 1, "w": 13, "f": 3, "p": 35,
      ]
      guard let key = params["key"] as? String, let code = keys[key] else {
        throw Failure.invalid_command
      }
      let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)
      let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
      try post(down)
      try post(up)
    default: throw Failure.invalid_command
    }
    return ["accepted": true]
  }
}
@main struct Main {
  @MainActor static func main() async {
    guard CommandLine.arguments.dropFirst().first == "--serve" else {
      emit(["error": "invalid_command"])
      return
    }
    var sessions: [String: Session] = [:]
    emit(["ready": true])
    // Keep AppKit's main run loop free for ScreenCaptureKit and AX while
    // stdin blocks on its own thread. Await one command at a time.
    let input = AsyncStream<String>(bufferingPolicy: .bufferingOldest(32)) { continuation in
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
      do {
        let params = command["params"] as? [String: Any] ?? [:]
        let targetID = params["targetId"] as? String ?? ""
        let result: [String: Any]
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
          _ = try await NSWorkspace.shared.openApplication(at: url, configuration: configuration)
          let deadline = ContinuousClock.now.advanced(by: .seconds(4))
          while !(try await windows()).contains(where: { $0.owningApplication?.bundleIdentifier == bundleID })
            && ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(200))
          }
          result = ["opened": true]
        case "Native.list":
          result = [
            "targets": try await windows().prefix(200).map(row),
            "accessibility": AXIsProcessTrusted(),
          ]
        case "Native.attach":
          guard sessions[targetID] == nil, sessions.count < 16 else {
            throw Failure.invalid_command
          }
          let session = try Session(id: targetID)
          try await session.start()
          sessions[targetID] = session
          result = ["attached": true]
        case "Native.detach":
          if let session = sessions.removeValue(forKey: targetID) {
            try? await session.stream?.stopCapture()
          }
          result = ["detached": true]
        default:
          guard let session = sessions[targetID] else { throw Failure.target_missing }
          result = try await session.command(method, params)
        }
        emit(["id": id, "result": result])
      } catch { emit(["id": id, "error": (error as? Failure)?.rawValue ?? "unavailable"]) }
    }
    for session in sessions.values { try? await session.stream?.stopCapture() }
  }
}
