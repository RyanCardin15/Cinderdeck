import Foundation

/// Browser capture is deliberately independent of Node, Playwright, and ScreenCaptureKit.
/// An agent can launch an isolated Chromium browser or attach to its existing CDP page.
nonisolated struct BrowserReproOptions: Sendable, Equatable {
  var url: String?
  var endpoint: URL?
  var pageID: String?
  var executable: String?
  var width = 1280
  var height = 720

  static func parse(_ params: JSONValue) throws -> Self? {
    let keys = ["headless", "cdp", "page_id", "browser_executable", "browser_width", "browser_height"]
    guard keys.contains(where: { params[$0] != nil }) else { return nil }
    var options = Self()
    if let value = params["headless"] {
      guard case .string(let url) = value else { throw StackControlError.invalid("headless must be a URL, e.g. http://localhost:3000 or about:blank") }
      options.url = try navigationURL(url)
    }
    if let value = params["cdp"] {
      guard case .string(let raw) = value, let url = URL(string: raw),
        ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.host != nil,
        url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else {
        throw StackControlError.invalid("cdp must be an HTTP debugging endpoint, e.g. http://127.0.0.1:9222 (without credentials, query, or fragment)")
      }
      options.endpoint = url
    }
    guard options.url != nil || options.endpoint != nil else { throw StackControlError.invalid("Pass headless=<url> or cdp=<endpoint> with browser options") }
    guard options.url == nil || options.endpoint == nil else { throw StackControlError.invalid("Pass headless to launch a browser or cdp to attach, not both") }
    for key in ["window", "window_id", "windowId", "display"] where params[key] != nil {
      throw StackControlError.invalid("Browser capture cannot be combined with \(key)")
    }
    guard params["system_audio"]?.boolValue != true, params["systemAudio"]?.boolValue != true else {
      throw StackControlError.invalid("Browser capture records the page without audio; omit system_audio")
    }
    if let value = params["page_id"] {
      guard options.endpoint != nil, case .string(let id) = value, !id.isEmpty else { throw StackControlError.invalid("page_id requires cdp and a nonempty page id") }
      options.pageID = id
    }
    if let value = params["browser_executable"] {
      guard options.endpoint == nil, case .string(let path) = value, path.hasPrefix("/") else {
        throw StackControlError.invalid("browser_executable is an absolute Chromium executable path, used with headless")
      }
      options.executable = path
    }
    for (key, isWidth) in [("browser_width", true), ("browser_height", false)] {
      guard let value = params[key] else { continue }
      guard options.endpoint == nil else { throw StackControlError.invalid("Viewport options are only for headless; attached pages keep their viewport") }
      guard let number = value.doubleValue, number.isFinite, number.rounded() == number, (240...3840).contains(number) else {
        throw StackControlError.invalid("\(key) must be an integer from 240 to 3840")
      }
      if isWidth { options.width = Int(number) } else { options.height = Int(number) }
    }
    return options
  }

  static func navigationURL(_ raw: String) throws -> String {
    guard raw == "about:blank" || {
      guard let url = URL(string: raw) else { return false }
      return ["http", "https"].contains(url.scheme?.lowercased() ?? "") && url.host != nil && url.user == nil && url.password == nil
    }() else { throw StackControlError.invalid("Use an http:// or https:// page URL, or about:blank") }
    return raw
  }

  /// Log URLs, never headers, cookies, bodies, or credentials. Query values may be secrets.
  static func logURL(_ raw: String) -> String {
    guard var parts = URLComponents(string: raw) else { return "(invalid URL)" }
    parts.user = nil; parts.password = nil; parts.query = nil; parts.fragment = nil
    return String((parts.string ?? "(URL)").prefix(2048))
  }

  static func choosePage(_ targets: [JSONValue], id: String?) throws -> JSONValue {
    let pages = targets.filter { $0["type"]?.stringValue == "page" && $0["webSocketDebuggerUrl"]?.stringValue != nil }
    if let id {
      guard let page = pages.first(where: { $0["id"]?.stringValue == id }) else { throw StackControlError.notFound("No browser page has id \(id). Read the endpoint's /json/list for current page ids.") }
      return page
    }
    guard pages.count == 1 else {
      let choices = pages.prefix(10).map { "\($0["id"]?.stringValue ?? "?"): \(logURL($0["url"]?.stringValue ?? ""))" }.joined(separator: ", ")
      throw StackControlError.invalid(pages.isEmpty ? "The browser has no recordable page. Open a page and try again."
        : "The browser has several pages. Pass page_id (CLI --page-id) to choose one: \(choices)")
    }
    return pages[0]
  }
}
