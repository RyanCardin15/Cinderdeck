import AppKit
import ApplicationServices
import ScreenCaptureKit

nonisolated struct RecentAppContextRequest: Decodable {
  let requestID: String
  let action: String
  let targetID: String?

  static func decode(_ data: Data) throws -> Self {
    guard data.count <= 2048,
      let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(object.keys).isSubset(of: ["requestID", "action", "targetID"]) else {
      throw StackControlError.invalid("Invalid app context request")
    }
    let value = try JSONDecoder().decode(Self.self, from: data)
    guard UUID(uuidString: value.requestID) != nil,
      (value.action == "list" && value.targetID == nil)
        || (value.action == "capture" && value.targetID.flatMap(UUID.init(uuidString:)) != nil) else {
      throw StackControlError.invalid("Unsupported app context request")
    }
    return value
  }
}

/// Ephemeral suggestions. Tracking records app identity only; content is read on demand.
@MainActor
final class RecentAppContext {
  static let shared = RecentAppContext()
  private var observer: NSObjectProtocol?
  private var recentPID: pid_t?
  private var targets: [String: Target] = [:]

  /// Disposable preview runs must never inspect the person's other windows.
  private func previewAllows(_ pid: pid_t) -> Bool {
    #if DEBUG
      let environment = ProcessInfo.processInfo.environment
      if environment["CINDERDECK_STACKS_PREVIEW_ROOT"]?.hasPrefix("/") == true,
        let value = environment["CINDERDECK_APP_CONTEXT_PREVIEW_PIDS"] {
        return value.split(separator: ",").compactMap { pid_t($0) }.contains(pid)
      }
    #endif
    return true
  }

  struct Target {
    let id: String
    let pid: pid_t
    let bundleID: String
    let appName: String
    let windowID: CGWindowID
    let title: String
    let tabURL: String?
    let tabTitle: String?
    let icon: String?
    let created: Date
  }

  nonisolated static func eligible(bundleID: String, regular: Bool) -> Bool {
    let id = bundleID.lowercased()
    return regular && !id.contains("cinderdeck") && ![
      "com.apple.securityagent", "com.apple.localauthentication.uiagent",
      "com.apple.loginwindow", "com.apple.keychainaccess", "com.apple.passwords",
    ].contains(id)
  }

  func start() {
    guard observer == nil else { return }
    remember(NSWorkspace.shared.frontmostApplication)
    observer = NSWorkspace.shared.notificationCenter.addObserver(
      forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
    ) { [weak self] notification in
      MainActor.assumeIsolated {
        self?.remember(notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)
      }
    }
  }

  private func remember(_ app: NSRunningApplication?) {
    guard let app, let id = app.bundleIdentifier,
      previewAllows(app.processIdentifier),
      Self.eligible(bundleID: id, regular: app.activationPolicy == .regular) else { return }
    recentPID = app.processIdentifier
  }

  func handle(_ request: RecentAppContextRequest) async throws -> JSONValue {
    if request.action == "list" { return await list() }
    guard let id = request.targetID, let target = targets[id],
      Date().timeIntervalSince(target.created) < 120 else {
      throw StackControlError.invalid("This app suggestion expired. Open the + menu again.")
    }
    guard #available(macOS 14.0, *) else {
      throw StackControlError.invalid("App attachments require macOS 14 or later.")
    }
    return try await capture(target)
  }

  private func list() async -> JSONValue {
    let recentPID = self.recentPID
    let allWindows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    let windows = allWindows.filter { $0[kCGWindowOwnerPID as String] as? Int32 == recentPID }
      + allWindows.filter { $0[kCGWindowOwnerPID as String] as? Int32 != recentPID }
    let apps = Dictionary(NSWorkspace.shared.runningApplications.compactMap { app -> (pid_t, NSRunningApplication)? in
      guard previewAllows(app.processIdentifier), let id = app.bundleIdentifier, Self.eligible(bundleID: id, regular: app.activationPolicy == .regular), !app.isTerminated else { return nil }
      return (app.processIdentifier, app)
    }, uniquingKeysWith: { first, _ in first })
    var rows: [Target] = []
    for row in windows where rows.count < 24 {
      guard row[kCGWindowLayer as String] as? Int == 0,
        let pid = row[kCGWindowOwnerPID as String] as? Int32, let app = apps[pid],
        let windowID = row[kCGWindowNumber as String] as? UInt32,
        let bounds = row[kCGWindowBounds as String] as? [String: Any],
        let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary), rect.width > 80, rect.height > 60 else { continue }
      // Only inspect the most recent app's current web page; never enumerate browser history or tabs.
      let bundleID = app.bundleIdentifier!
      let page = pid == recentPID && !rows.contains(where: { $0.pid == pid })
        ? await Task.detached(priority: .userInitiated) { Self.browserPage(pid: pid, bundleID: bundleID, windowID: windowID) }.value : nil
      let title = Self.bounded(row[kCGWindowName as String] as? String ?? "", limit: 1000)
      rows.append(Target(id: UUID().uuidString, pid: pid, bundleID: app.bundleIdentifier!,
        appName: Self.bounded(app.localizedName ?? app.bundleIdentifier!, limit: 255),
        windowID: windowID, title: title, tabURL: page?.url, tabTitle: page?.title,
        icon: icon(app), created: Date()))
    }
    // A stable partition preserves WindowServer's front-to-back ordering within each app.
    rows = rows.filter { $0.pid == recentPID } + rows.filter { $0.pid != recentPID }
    rows = Array(rows.prefix(16))
    targets = targets.filter { Date().timeIntervalSince($0.value.created) < 120 }
    for row in rows { targets[row.id] = row }
    if targets.count > 64 {
      for old in targets.values.sorted(by: { $0.created > $1.created }).dropFirst(64) { targets.removeValue(forKey: old.id) }
    }
    let recent = rows.first(where: { $0.pid == recentPID })?.id
    return .object(["targets": .array(rows.map { target in
      var value: [String: JSONValue] = ["id": .string(target.id), "appName": .string(target.appName),
        "bundleID": .string(target.bundleID), "windowTitle": .string(target.title), "recent": .bool(target.id == recent)]
      if let url = target.tabURL { value["tabURL"] = .string(url) }
      if let title = target.tabTitle { value["tabTitle"] = .string(title) }
      if let icon = target.icon { value["iconDataURL"] = .string(icon) }
      return .object(value)
    }), "screenRecording": .bool(CGPreflightScreenCaptureAccess()), "accessibility": .bool(AXIsProcessTrusted())])
  }

  private func icon(_ app: NSRunningApplication) -> String? {
    guard let image = app.icon ?? app.bundleURL.map({ NSWorkspace.shared.icon(forFile: $0.path) }) else { return nil }
    return Self.iconData(image)
  }

  /// A fixed pixel bitmap avoids lockFocus's display-dependent Retina scaling.
  static func iconData(_ image: NSImage) -> String? {
    guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 64, pixelsHigh: 64,
      bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
      colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
      let context = NSGraphicsContext(bitmapImageRep: bitmap) else { return nil }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    image.draw(in: NSRect(x: 0, y: 0, width: 64, height: 64))
    NSGraphicsContext.restoreGraphicsState()
    guard let png = bitmap.representation(using: .png, properties: [:]), png.count < 64_000 else { return nil }
    return "data:image/png;base64," + png.base64EncodedString()
  }

  nonisolated private static func copy(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success ? value : nil
  }

  nonisolated private static func axWindow(_ pid: pid_t, windowID: CGWindowID) -> AXUIElement? {
    guard AXIsProcessTrusted() else { return nil }
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.15)
    guard let windows = copy(app, kAXWindowsAttribute) as? [AXUIElement],
      let row = (CGWindowListCopyWindowInfo([.optionIncludingWindow], windowID) as? [[String: Any]])?.first,
      let bounds = row[kCGWindowBounds as String] as? [String: Any],
      let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { return nil }
    let matches = windows.filter { window in
      guard let position = copy(window, kAXPositionAttribute), CFGetTypeID(position) == AXValueGetTypeID(),
        let size = copy(window, kAXSizeAttribute), CFGetTypeID(size) == AXValueGetTypeID() else { return false }
      var point = CGPoint.zero, extent = CGSize.zero
      guard AXValueGetValue(position as! AXValue, .cgPoint, &point), AXValueGetValue(size as! AXValue, .cgSize, &extent) else { return false }
      return abs(point.x - rect.minX) < 2 && abs(point.y - rect.minY) < 2
        && abs(extent.width - rect.width) < 2 && abs(extent.height - rect.height) < 2
    }
    return matches.count == 1 ? matches[0] : nil
  }

  nonisolated private static func browserPage(pid: pid_t, bundleID: String, windowID: CGWindowID) -> (url: String, title: String)? {
    guard ["com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.canary", "com.microsoft.edgemac", "com.brave.Browser", "com.apple.Safari", "company.thebrowser.Browser"].contains(bundleID),
      let window = axWindow(pid, windowID: windowID) else { return nil }
    var queue = [window], visited = 0
    let deadline = Date().addingTimeInterval(0.35)
    while !queue.isEmpty, visited < 180, Date() < deadline {
      let node = queue.removeFirst(); visited += 1
      if copy(node, kAXRoleAttribute) as? String == "AXWebArea",
        let raw = copy(node, "AXURL"), let url = (raw as? URL)?.absoluteString ?? (raw as? String),
        webURL(url) != nil {
        return (url, bounded(copy(node, kAXTitleAttribute) as? String ?? "", limit: 1000))
      }
      queue.append(contentsOf: (copy(node, kAXChildrenAttribute) as? [AXUIElement] ?? []).prefix(80))
    }
    return nil
  }

  nonisolated static func webURL(_ text: String) -> URL? {
    guard text.utf8.count <= 4096, let url = URL(string: text),
      ["https", "http"].contains(url.scheme?.lowercased() ?? ""), url.host != nil,
      url.user == nil, url.password == nil else { return nil }
    return url
  }

  /// Wire contracts count UTF-16 units, including when titles contain emoji.
  nonisolated static func bounded(_ text: String, limit: Int) -> String {
    String(decoding: text.utf16.prefix(limit), as: UTF16.self)
  }

  nonisolated private static func visibleText(pid: pid_t, windowID: CGWindowID) -> String? {
    guard let window = axWindow(pid, windowID: windowID) else { return nil }
    var queue = [window], visited = 0, lines: [String] = [], seen = Set<String>(), count = 0
    let deadline = Date().addingTimeInterval(0.6)
    while !queue.isEmpty, visited < 240, count < 14_000, Date() < deadline {
      let node = queue.removeFirst(); visited += 1
      let subrole = copy(node, kAXSubroleAttribute) as? String ?? ""
      if subrole == "AXSecureTextField" || copy(node, "AXHidden") as? Bool == true { continue }
      let role = copy(node, kAXRoleAttribute) as? String ?? ""
      if ["AXStaticText", "AXTextField", "AXTextArea", "AXHeading", "AXLink"].contains(role) {
        for attribute in [kAXSelectedTextAttribute, kAXValueAttribute, kAXTitleAttribute] {
          if count >= 14_000 { break }
          guard let text = copy(node, attribute) as? String else { continue }
          let line = String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(min(3000, 14_000 - count)))
          if !line.isEmpty, seen.insert(line).inserted { lines.append(line); count += line.count + 1 }
        }
      }
      queue.append(contentsOf: (copy(node, kAXChildrenAttribute) as? [AXUIElement] ?? []).prefix(80))
    }
    return lines.isEmpty ? nil : lines.joined(separator: "\n")
  }

  private func currentPage(_ target: Target) async -> (url: String, title: String)? {
    await Task.detached(priority: .userInitiated) { Self.browserPage(pid: target.pid, bundleID: target.bundleID, windowID: target.windowID) }.value
  }

  @available(macOS 14.0, *)
  private func capture(_ target: Target) async throws -> JSONValue {
    guard CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess() else {
      throw StackControlError.invalid("Allow Screen & System Audio Recording for Cinderdeck in System Settings → Privacy & Security, then reopen the + menu.")
    }
    guard let app = NSRunningApplication(processIdentifier: target.pid), !app.isTerminated,
      app.bundleIdentifier == target.bundleID else {
      throw StackControlError.invalid("This app closed. Open the + menu again.")
    }
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
    guard let window = content.windows.first(where: { $0.windowID == target.windowID && $0.owningApplication?.processID == target.pid }) else {
      throw StackControlError.invalid("This window closed or moved off screen. Open the + menu again.")
    }
    guard target.title.isEmpty || Self.bounded(window.title ?? "", limit: 1000) == target.title else {
      throw StackControlError.invalid("This window changed. Open the + menu again to attach its current content.")
    }
    if let url = target.tabURL {
      guard await currentPage(target)?.url == url else {
        throw StackControlError.invalid("The browser tab changed. Open the + menu again to attach the current tab.")
      }
    }
    let filter = SCContentFilter(desktopIndependentWindow: window)
    let configuration = SCStreamConfiguration()
    let scale = min(2, 1600 / max(window.frame.width, window.frame.height))
    configuration.width = max(1, Int(window.frame.width * scale))
    configuration.height = max(1, Int(window.frame.height * scale))
    configuration.showsCursor = false
    configuration.ignoreShadowsSingleWindow = true
    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
    guard let data = NSBitmapImageRep(cgImage: image).representation(using: .jpeg, properties: [.compressionFactor: 0.82]), data.count < 2_000_000 else {
      throw StackControlError.invalid("This window could not be attached. Try a smaller window.")
    }
    // Recheck after the asynchronous capture so a tab switch cannot carry the old page's metadata.
    let capturedAt = ISO8601DateFormatter().string(from: Date())
    var source: [String: JSONValue] = ["kind": .string("snap-shot"), "capturedAt": .string(capturedAt),
      "appName": .string(target.appName), "appIdentifier": .string(target.bundleID), "windowTitle": .string(target.tabTitle ?? target.title)]
    if let icon = target.icon { source["appIconDataUrl"] = .string(icon) }
    var text: [String] = ["Captured app process: pid:\(target.pid). Read current app state before controlling this process."]
    if let url = target.tabURL { text.append("Browser tab: \(target.tabTitle ?? target.title)\nURL: \(url)") }
    if let visible = await Task.detached(priority: .userInitiated, operation: { Self.visibleText(pid: target.pid, windowID: target.windowID) }).value { text.append(visible) }
    if let url = target.tabURL, await currentPage(target)?.url != url {
      throw StackControlError.invalid("The browser tab changed while capturing. Open the + menu again.")
    }
    if !text.isEmpty { source["accessibleText"] = .string(Self.bounded(text.joined(separator: "\n\n"), limit: 30_000)) }
    return .object(["data": .string(data.base64EncodedString()), "mimeType": .string("image/jpeg"),
      "source": .object(source)])
  }
}
