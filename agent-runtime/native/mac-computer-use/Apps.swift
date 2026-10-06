import AppKit
import CoreServices
import Foundation

struct AppRef {
  let bundleId: String
  let name: String
  let url: URL?
  let pid: pid_t?
  var json: [String: Any] {
    var value: [String: Any] = ["bundleId": bundleId, "name": name, "running": pid != nil]
    if let pid { value["pid"] = Int(pid) }
    return value
  }
}

enum Apps {
  // Terminals and the system's credential/consent UI are never automated.
  static let blockedBundleIDs: Set<String> = [
    "com.apple.Terminal", "com.googlecode.iterm2", "dev.warp.Warp-Stable", "dev.warp.Warp",
    "net.kovidgoyal.kitty", "org.alacritty", "io.alacritty", "com.mitchellh.ghostty",
    "com.github.wez.wezterm", "co.zeit.hyper", "com.apple.SecurityAgent",
    "com.apple.LocalAuthentication.UIAgent", "com.apple.loginwindow",
    "com.apple.keychainaccess", "com.apple.Passwords",
  ].reduce(into: Set<String>()) { $0.insert($1.lowercased()) }
  private static var blocked = blockedBundleIDs
  private static let lock = NSLock()
  private static var cache: (at: Date, apps: [[String: Any]])?

  /// Blocks the Cinderdeck process tree that launched us, plus any server-supplied IDs.
  static func configureBlocklist() {
    var ancestors = Set<pid_t>()
    var pid = getppid()
    for _ in 0..<12 where pid > 1 {
      ancestors.insert(pid)
      guard let parent = parentPID(pid), parent != pid else { break }
      pid = parent
    }
    for app in NSWorkspace.shared.runningApplications where ancestors.contains(app.processIdentifier) {
      if let id = app.bundleIdentifier { blocked.insert(id.lowercased()) }
    }
    for id in (ProcessInfo.processInfo.environment["CINDERDECK_COMPUTER_USE_BLOCKED"] ?? "")
      .split(separator: ",")
    {
      blocked.insert(id.trimmingCharacters(in: .whitespaces).lowercased())
    }
  }

  static func isBlocked(_ bundleId: String) -> Bool {
    let id = bundleId.lowercased()
    return blocked.contains(id) || id.contains("cinderdeck")
  }

  private static func parentPID(_ pid: pid_t) -> pid_t? {
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
    guard sysctl(&mib, 4, &info, &size, nil, 0) == 0, size > 0 else { return nil }
    return info.kp_eproc.e_ppid
  }

  private static func running() -> [NSRunningApplication] {
    NSWorkspace.shared.runningApplications.filter {
      $0.activationPolicy != .prohibited && $0.bundleIdentifier != nil && !$0.isTerminated
    }
  }

  static func list() -> [[String: Any]] {
    lock.lock()
    defer { lock.unlock() }
    if let cache, Date().timeIntervalSince(cache.at) < 60 { return refreshRunning(cache.apps) }
    var seen = Set<String>()
    var rows: [[String: Any]] = []
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    let folders = [
      "/Applications", "/Applications/Utilities", "/System/Applications",
      "/System/Applications/Utilities", "\(home)/Applications",
    ]
    for folder in folders {
      guard let names = try? FileManager.default.contentsOfDirectory(atPath: folder) else {
        continue
      }
      for name in names where name.hasSuffix(".app") {
        let url = URL(fileURLWithPath: folder).appendingPathComponent(name)
        guard let id = Bundle(url: url)?.bundleIdentifier, !isBlocked(id),
          seen.insert(id.lowercased()).inserted
        else { continue }
        var row: [String: Any] = [
          "id": id, "displayName": FileManager.default.displayName(atPath: url.path)
            .replacingOccurrences(of: ".app", with: ""),
        ]
        if let item = MDItemCreateWithURL(kCFAllocatorDefault, url as CFURL) {
          if let used = MDItemCopyAttribute(item, "kMDItemLastUsedDate" as CFString) as? Date {
            row["lastUsedDate"] = ISO8601DateFormatter().string(from: used)
          }
          if let count = MDItemCopyAttribute(item, "kMDItemUseCount" as CFString) as? Int {
            row["useCount"] = count
          }
        }
        rows.append(row)
      }
    }
    for app in running() {
      guard let id = app.bundleIdentifier, !isBlocked(id), app.activationPolicy == .regular,
        seen.insert(id.lowercased()).inserted
      else { continue }
      rows.append(["id": id, "displayName": app.localizedName ?? id])
    }
    cache = (Date(), rows)
    return refreshRunning(rows)
  }

  private static func refreshRunning(_ rows: [[String: Any]]) -> [[String: Any]] {
    let live = Set(running().compactMap { $0.bundleIdentifier?.lowercased() })
    return rows.map { row in
      var row = row
      row["isRunning"] = live.contains((row["id"] as? String ?? "").lowercased())
      return row
    }.sorted { left, right in
      let l = left["isRunning"] as? Bool ?? false, r = right["isRunning"] as? Bool ?? false
      if l != r { return l }
      return (left["lastUsedDate"] as? String ?? "") > (right["lastUsedDate"] as? String ?? "")
    }.prefix(400).map { $0 }
  }

  /// Resolves a bundle ID, display name, or process name. Launches in the
  /// background (never activating) only when asked to.
  static func resolve(_ query: String, launch: Bool) async throws -> AppRef {
    let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !q.isEmpty, q.utf8.count <= 300 else { throw Failed(.invalid_input, "Name an app.") }
    let lower = q.lowercased()
    let candidates = running()
    let match =
      candidates.first { $0.bundleIdentifier?.lowercased() == lower }
      ?? candidates.first { $0.localizedName?.lowercased() == lower }
      ?? candidates.first { $0.executableURL?.lastPathComponent.lowercased() == lower }
    if let match, let id = match.bundleIdentifier {
      guard !isBlocked(id) else { throw Failed(.app_blocked, id) }
      return AppRef(
        bundleId: id, name: match.localizedName ?? id, url: match.bundleURL,
        pid: match.processIdentifier)
    }
    var url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: q)
    if url == nil,
      let row = list().first(where: {
        ($0["displayName"] as? String)?.lowercased() == lower
          || ($0["id"] as? String)?.lowercased() == lower
      }), let id = row["id"] as? String
    {
      url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id)
    }
    guard let url, let id = Bundle(url: url)?.bundleIdentifier else {
      throw Failed(.app_missing, q)
    }
    guard !isBlocked(id) else { throw Failed(.app_blocked, id) }
    let name = FileManager.default.displayName(atPath: url.path).replacingOccurrences(
      of: ".app", with: "")
    guard launch else { return AppRef(bundleId: id, name: name, url: url, pid: nil) }
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = false
    configuration.addsToRecentItems = false
    let launched: NSRunningApplication
    do {
      launched = try await NSWorkspace.shared.openApplication(at: url, configuration: configuration)
    } catch {
      throw Failed(.launch_failed, error.localizedDescription)
    }
    // Wait briefly for a first window so the following state read has content.
    let deadline = Date().addingTimeInterval(8)
    while Date() < deadline {
      let app = AXUIElementCreateApplication(launched.processIdentifier)
      if let windows = AX.copy(app, kAXWindowsAttribute) as? [AXUIElement], !windows.isEmpty {
        break
      }
      try await Task.sleep(nanoseconds: 200_000_000)
    }
    return AppRef(bundleId: id, name: name, url: url, pid: launched.processIdentifier)
  }
}
