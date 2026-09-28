import AppKit
import Foundation

/// Captures a single Chromium page over CDP. All network, image, and encoder work
/// lives off the UI actor. The controller owns the normal repro lifecycle.
actor BrowserReproCapture {
  struct Log: Sendable {
    let source: String
    let text: String
    let level: ReproLogLevel
    let at: Date
  }
  struct Info: Sendable {
    let endpoint: URL
    let pageID: String
    let url: String
    let launched: Bool

    var value: JSONValue { .object([
      "endpoint": .string(endpoint.absoluteString), "pageId": .string(pageID),
      "url": .string(url), "launched": .bool(launched),
      "control": .string("Use repro_browser (CLI repro browser), or connect Playwright/Puppeteer to endpoint and select pageId. Only this page is recorded."),
    ]) }
  }

  private let options: BrowserReproOptions
  private let video: BrowserVideoWriter
  private let onLog: @Sendable ([Log]) async -> Void
  private let onDisconnect: @Sendable (String) async -> Void
  private var connection: BrowserCDPConnection?
  private var process: Process?
  private var terminationObserver: (any NSObjectProtocol)?
  private var profile: URL?
  private var clock: ReproClock?
  private var stopped = false
  private var stopping = false
  private var lastFrameAt: ContinuousClock.Instant?
  /// Exactly one pending frame, replaced by the latest while the encoder works.
  private var pendingFrame: (base64: String, at: Date)?
  private var frameTask: Task<Void, Never>?
  private var logs: [Log] = []
  private var droppedLogs = 0
  private var flushTask: Task<Void, Never>?
  private var requests: [String: String] = [:]
  private var requestOrder: [String] = []

  init(options: BrowserReproOptions, videoURL: URL,
    onLog: @escaping @Sendable ([Log]) async -> Void,
    onDisconnect: @escaping @Sendable (String) async -> Void) {
    self.options = options
    video = BrowserVideoWriter(url: videoURL)
    self.onLog = onLog; self.onDisconnect = onDisconnect
  }

  func prepare() async throws -> Info {
    do {
      let endpoint: URL
      if let existing = options.endpoint { endpoint = existing }
      else { endpoint = try await launch() }
      var request = URLRequest(url: endpoint.appendingPathComponent("json/list"))
      request.timeoutInterval = 10
      let (data, response) = try await URLSession.shared.data(for: request)
      guard (response as? HTTPURLResponse)?.statusCode == 200, data.count <= 2 * 1024 * 1024 else {
        throw StackControlError.invalid("The CDP endpoint did not return a page list at /json/list")
      }
      let targets = try JSONDecoder().decode([JSONValue].self, from: data)
      let page = try BrowserReproOptions.choosePage(targets, id: options.pageID)
      guard let raw = page["webSocketDebuggerUrl"]?.stringValue, let socketURL = URL(string: raw),
        ["ws", "wss"].contains(socketURL.scheme ?? ""), let id = page["id"]?.stringValue else {
        throw StackControlError.invalid("The selected page has no valid CDP WebSocket address")
      }
      let connection = BrowserCDPConnection(url: socketURL)
      self.connection = connection
      await connection.start(onEvent: { [weak self] method, params in await self?.event(method, params) },
        onDisconnect: { [weak self] reason in await self?.disconnected(reason) })
      _ = try await connection.call("Page.enable")
      _ = try await connection.call("Runtime.enable")
      _ = try await connection.call("Network.enable", ["maxTotalBufferSize": .number(0), "maxResourceBufferSize": .number(0)])
      if options.endpoint == nil {
        _ = try await connection.call("Emulation.setDeviceMetricsOverride", [
          "width": .number(Double(options.width)), "height": .number(Double(options.height)),
          "deviceScaleFactor": .number(1), "mobile": .bool(false),
        ])
      }
      return Info(endpoint: endpoint, pageID: id, url: BrowserReproOptions.logURL(options.url ?? page["url"]?.stringValue ?? "about:blank"), launched: process != nil)
    } catch {
      await shutdown()
      if let error = error as? StackControlError { throw error }
      throw StackControlError(code: "browser_failed", message: "Could not connect to the browser: \(error.localizedDescription). Use a Chromium browser with remote debugging enabled.")
    }
  }

  /// Returns the exact first-frame clock shared by video, marks, and workspace logs.
  func start() async throws -> Date {
    try Task.checkCancellation()
    guard !stopped, !stopping else { throw CancellationError() }
    guard let connection else { throw StackControlError.notFound("No browser is connected") }
    let screenshot = try await connection.call("Page.captureScreenshot", ["format": .string("jpeg"), "quality": .number(80)])
    guard !stopped, !stopping else { throw CancellationError() }
    guard let base64 = screenshot["data"]?.stringValue, let data = Data(base64Encoded: base64) else {
      throw StackControlError(code: "browser_video_failed", message: "The browser did not return a first frame")
    }
    let date = Date()
    guard try await video.append(jpeg: data, at: 0) else { throw StackControlError(code: "browser_video_failed", message: "Could not save the first browser frame") }
    guard !stopped, !stopping else { throw CancellationError() }
    var clock = ReproClock(start: date)
    clock.firstFrame(at: date)
    self.clock = clock
    flushTask = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .milliseconds(200))
        guard !Task.isCancelled else { return }
        await self?.flushLogs()
      }
    }
    _ = try await connection.call("Page.startScreencast", screencastOptions)
    guard !stopped, !stopping else { throw CancellationError() }
    return date
  }

  func navigate(_ raw: String) async throws {
    let url = try BrowserReproOptions.navigationURL(raw)
    guard let connection, !stopped else { throw StackControlError.notFound("No browser is recording") }
    let result = try await connection.call("Page.navigate", ["url": .string(url)])
    if let error = result["errorText"]?.stringValue, !error.isEmpty { throw StackControlError(code: "browser_navigation_failed", message: error) }
  }

  func evaluate(_ expression: String) async throws -> JSONValue {
    guard let connection, !stopped else { throw StackControlError.notFound("No browser is recording") }
    guard expression.utf8.count <= 64 * 1024 else { throw StackControlError.invalid("Browser expressions are limited to 64 KB") }
    let result = try await connection.call("Runtime.evaluate", ["expression": .string(expression),
      "awaitPromise": .bool(true), "returnByValue": .bool(true), "userGesture": .bool(true), "timeout": .number(10_000)], timeout: 12)
    if let exception = result["exceptionDetails"] {
      throw StackControlError(code: "browser_action_failed", message: exception["exception"]?["description"]?.stringValue ?? exception["text"]?.stringValue ?? "JavaScript failed")
    }
    let value = result["result"]?["value"] ?? result["result"]?["description"] ?? .null
    guard value.compactString().utf8.count <= 512 * 1024 else { throw StackControlError.invalid("The browser result is too large. Return a smaller value.") }
    return value
  }

  func screenshot() async throws -> Data {
    guard let connection, !stopped else { throw StackControlError.notFound("No browser is recording") }
    let result = try await connection.call("Page.captureScreenshot", ["format": .string("jpeg"), "quality": .number(70)])
    guard let raw = result["data"]?.stringValue, let data = Data(base64Encoded: raw), data.count <= 2_000_000 else {
      throw StackControlError(code: "browser_error", message: "Browser screenshot is missing or too large")
    }
    return data
  }

  private var screencastOptions: [String: JSONValue] {
    ["format": .string("jpeg"), "quality": .number(80), "maxWidth": .number(1920),
      "maxHeight": .number(1080), "everyNthFrame": .number(1)]
  }

  func setPaused(_ paused: Bool, at date: Date) async {
    guard !stopped, !stopping else { return }
    if paused { clock?.pause(at: date) } else { clock?.resume(at: date) }
    // Stop frame production while paused; restarting also requests a fresh image
    // when the page changed during the pause and is now completely idle.
    if let connection {
      _ = try? await connection.call(paused ? "Page.stopScreencast" : "Page.startScreencast", paused ? [:] : screencastOptions)
    }
  }

  func stop(at date: Date) async throws -> URL {
    stopping = true
    let wasPaused = clock?.isPaused ?? false
    clock?.stop(at: date)
    // Drain frames already in flight through the reader before finalizing. Freezing
    // the clock pins them to the stop rather than stretching video during cleanup.
    if let connection { _ = try? await connection.call("Page.stopScreencast", timeout: 3) }
    stopped = true
    await frameTask?.value
    // Capture the settled last paint as well: Chromium may coalesce the very last
    // invalidation of an animation. This is a single final snapshot, never polling.
    if !wasPaused, let connection,
      let snapshot = try? await connection.call("Page.captureScreenshot", ["format": .string("jpeg"), "quality": .number(80)], timeout: 3),
      let raw = snapshot["data"]?.stringValue, let data = Data(base64Encoded: raw) {
      try? await video.appendFinal(jpeg: data, at: clock?.duration ?? 0)
    }
    flushTask?.cancel(); flushTask = nil
    await flushLogs()
    do {
      let url = try await video.finish(at: clock?.duration ?? 0)
      await shutdown()
      return url
    } catch {
      await shutdown()
      throw error
    }
  }

  func cancel() async {
    stopped = true
    frameTask?.cancel()
    await frameTask?.value
    pendingFrame = nil
    flushTask?.cancel(); flushTask = nil
    await shutdown()
    await video.cancel()
  }

  private func event(_ method: String, _ params: JSONValue) async {
    let now = Date()
    if method == "Page.screencastFrame" {
      if !stopped, let clock, !clock.isPaused,
        let raw = params["data"]?.stringValue {
        pendingFrame = (raw, now)
        if frameTask == nil { frameTask = Task { [weak self] in await self?.encodeFrames() } }
      }
      // Never hold acknowledgements behind the encoder. Otherwise Chromium can
      // lose its final paint when an animation stops under capture backpressure.
      if let id = params["sessionId"]?.intValue { await connection?.acknowledge(id) }
      return
    }
    guard clock != nil, !stopped else { return }
    switch method {
    case "Runtime.consoleAPICalled":
      let type = params["type"]?.stringValue ?? "log"
      let text = (params["args"]?.arrayValue ?? []).map { argument in
        argument["value"].map { value in
          if case .string(let text) = value { return text }
          return value.compactString()
        } ?? argument["description"]?.stringValue ?? "[object]"
      }.joined(separator: " ")
      log("browser", "\(type): \(text)", level: type == "error" || type == "assert" ? .error : type == "warning" ? .warning : type == "debug" ? .debug : .info, at: now)
    case "Runtime.exceptionThrown":
      let exception = params["exceptionDetails"]
      log("browser", exception?["exception"]?["description"]?.stringValue ?? exception?["text"]?.stringValue ?? "Uncaught JavaScript error", level: .error, at: now)
    case "Network.requestWillBeSent":
      if let id = params["requestId"]?.stringValue {
        if requests[id] == nil { requestOrder.append(id) }
        requests[id] = "\(params["request"]?["method"]?.stringValue ?? "GET") \(BrowserReproOptions.logURL(params["request"]?["url"]?.stringValue ?? ""))"
        if requestOrder.count > 2048 { requests.removeValue(forKey: requestOrder.removeFirst()) }
      }
    case "Network.responseReceived":
      let response = params["response"]
      if let status = response?["status"]?.intValue, status >= 400 {
        log("network", "HTTP \(status) \(BrowserReproOptions.logURL(response?["url"]?.stringValue ?? ""))", level: status >= 500 ? .error : .warning, at: now)
      }
    case "Network.loadingFailed", "Network.loadingFinished":
      if let id = params["requestId"]?.stringValue {
        let request = requests.removeValue(forKey: id) ?? "Request"
        requestOrder.removeAll { $0 == id }
        if method == "Network.loadingFailed" {
          log("network", "\(request): \(params["errorText"]?.stringValue ?? "failed")", level: params["canceled"]?.boolValue == true ? .info : .error, at: now)
        }
      }
    case "Page.javascriptDialogOpening":
      log("browser", "Browser dialog (\(params["type"]?.stringValue ?? "dialog")): \(params["message"]?.stringValue ?? "")", level: .warning, at: now)
    case "Inspector.detached", "Inspector.targetCrashed":
      await disconnected("The recorded browser page closed or crashed")
    default: break
    }
  }

  private func encodeFrames() async {
    defer { frameTask = nil }
    while pendingFrame != nil, !Task.isCancelled {
      if let lastFrameAt {
        do { try await Task.sleep(until: lastFrameAt.advanced(by: .milliseconds(34)), clock: .continuous) }
        catch { return }
      }
      guard !Task.isCancelled, let frame = pendingFrame, let clock else { return }
      pendingFrame = nil
      let position = clock.position(at: frame.at)
      guard position.visible || stopping else { continue }
      lastFrameAt = .now
      // Decode only frames selected for encoding. Superseded frames never
      // allocate another JPEG buffer just to have it immediately discarded.
      guard let bytes = Data(base64Encoded: frame.base64) else { continue }
      do { try await video.append(jpeg: bytes, at: position.t) }
      catch { await disconnected(error.localizedDescription); return }
    }
  }

  private func log(_ source: String, _ text: String, level: ReproLogLevel, at date: Date) {
    guard logs.count < 500 else { droppedLogs += 1; return }
    logs.append(Log(source: source, text: String(text.prefix(16_384)), level: level, at: date))
  }

  private func flushLogs() async {
    var batch = logs; logs.removeAll(keepingCapacity: true)
    if droppedLogs > 0 {
      batch.append(Log(source: "browser", text: "[Cinderdeck] \(droppedLogs) browser messages were dropped because output exceeded the capture buffer", level: .warning, at: Date()))
      droppedLogs = 0
    }
    if !batch.isEmpty { await onLog(batch) }
  }

  private func disconnected(_ reason: String) async {
    guard !stopped, !stopping else { return }
    stopped = true
    await onDisconnect(reason)
  }

  private func launch() async throws -> URL {
    let candidates = options.executable.map { [$0] } ?? [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      NSHomeDirectory() + "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ]
    guard let path = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
      throw StackControlError(code: "browser_missing", message: "Install Google Chrome, Chromium, or Microsoft Edge, or pass browser_executable (CLI --browser-executable) with an absolute Chromium executable path.")
    }
    let profile = FileManager.default.temporaryDirectory.appendingPathComponent("cinderdeck-browser-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: profile, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    self.profile = profile
    let process = Process()
    process.executableURL = URL(fileURLWithPath: path)
    process.arguments = ["--headless=new", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
      "--user-data-dir=\(profile.path)", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
      "--disable-extensions", "--disable-component-extensions-with-background-pages",
      "--window-size=\(options.width),\(options.height)", "about:blank"]
    process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
    try process.run()
    self.process = process
    terminationObserver = NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: nil) { _ in
      if process.isRunning { process.terminate() }
    }
    let deadline = ContinuousClock.now.advanced(by: .seconds(15))
    let portFile = profile.appendingPathComponent("DevToolsActivePort")
    while ContinuousClock.now < deadline {
      try Task.checkCancellation()
      guard process.isRunning else { throw StackControlError(code: "browser_failed", message: "Chromium exited before remote debugging was ready (exit \(process.terminationStatus))") }
      if let text = try? String(contentsOf: portFile, encoding: .utf8), let first = text.split(separator: "\n").first,
        let port = Int(first), (1...65535).contains(port), let url = URL(string: "http://127.0.0.1:\(port)") { return url }
      try await Task.sleep(for: .milliseconds(100))
    }
    throw StackControlError(code: "browser_timeout", message: "Chromium did not start remote debugging within 15 seconds")
  }

  private func shutdown() async {
    await connection?.close(); connection = nil
    if let terminationObserver { NotificationCenter.default.removeObserver(terminationObserver); self.terminationObserver = nil }
    if let process, process.isRunning {
      process.terminate()
      let deadline = ContinuousClock.now.advanced(by: .seconds(3))
      while process.isRunning, ContinuousClock.now < deadline { try? await Task.sleep(for: .milliseconds(50)) }
      if process.isRunning { kill(process.processIdentifier, SIGKILL) }
    }
    process = nil
    if let profile { try? FileManager.default.removeItem(at: profile); self.profile = nil }
  }
}
