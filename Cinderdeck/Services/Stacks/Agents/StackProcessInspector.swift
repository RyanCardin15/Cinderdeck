import Darwin
import Foundation

/// Describes processes well enough to say which terminal, IDE or agent owns
/// them, e.g. "node, started from a Cursor terminal on ttys004".
nonisolated enum StackProcessInspector {
  struct Process: Sendable {
    let pid: Int32
    let parent: Int32
    let group: Int32
    let name: String
    let path: String?
    let tty: String?
  }

  static func process(_ pid: Int32) -> Process? {
    guard pid > 0 else { return nil }
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
    guard sysctl(&mib, UInt32(mib.count), &info, &size, nil, 0) == 0, size > 0 else { return nil }
    var nameBuffer = [CChar](repeating: 0, count: 256)
    var name = proc_name(pid, &nameBuffer, UInt32(nameBuffer.count)) > 0 ? String(cString: nameBuffer) : ""
    var pathBuffer = [CChar](repeating: 0, count: 4096)
    let path = proc_pidpath(pid, &pathBuffer, UInt32(pathBuffer.count)) > 0 ? String(cString: pathBuffer) : nil
    if name.isEmpty { name = path.map { ($0 as NSString).lastPathComponent } ?? "pid \(pid)" }
    let device = info.kp_eproc.e_tdev
    var tty: String?
    if device != -1, let pointer = devname(device, mode_t(S_IFCHR)) {
      let value = String(cString: pointer)
      if !value.isEmpty, value != "??" { tty = value }
    }
    return Process(pid: pid, parent: info.kp_eproc.e_ppid, group: info.kp_eproc.e_pgid, name: name, path: path, tty: tty)
  }

  /// The process and its parents, nearest first, stopping before launchd.
  static func ancestry(_ pid: Int32, limit: Int = 24) -> [Process] {
    var result: [Process] = []
    var current = pid
    var seen = Set<Int32>()
    while current > 1, result.count < limit, !seen.contains(current), let entry = Self.process(current) {
      seen.insert(current)
      result.append(entry)
      current = entry.parent
    }
    return result
  }

  private static let agentCommands: [String: String] = [
    "codex": "Codex", "claude": "Claude Code", "cursor-agent": "Cursor Agent", "aider": "Aider",
    "gemini": "Gemini CLI", "opencode": "opencode", "amp": "Amp", "goose": "Goose", "droid": "Factory Droid",
  ]
  private static let appNames: [String: String] = [
    "Visual Studio Code": "VS Code", "Code": "VS Code", "iTerm": "iTerm", "iTerm2": "iTerm",
    "Warp": "Warp", "Stable": "Warp", "WarpPreview": "Warp",
  ]

  /// Nearest recognizable host in a process chain: an agent CLI or an app bundle.
  /// Our own bundle: the `cinderdeck` CLI and MCP bridge run from it, so it is never the "host".
  private static let ownBundle = URL(fileURLWithPath: Bundle.main.bundlePath).resolvingSymlinksInPath().path + "/"

  static func host(of chain: [Process]) -> String? {
    for process in chain {
      if let path = process.path, path.hasPrefix(ownBundle) { continue }
      if let agent = agentCommands[process.name.lowercased()] { return agent }
      if let app = appName(process.path) { return app }
      if process.name == "tmux" { return "tmux" }
    }
    return nil
  }

  static func appName(_ path: String?) -> String? {
    guard let path else { return nil }
    for component in path.split(separator: "/") where component.hasSuffix(".app") {
      let name = String(component.dropLast(4))
      return appNames[name] ?? name
    }
    return nil
  }

  static func describe(_ pid: Int32) -> (host: String?, tty: String?, parents: [String]) {
    let chain = ancestry(pid)
    return (host(of: chain), chain.lazy.compactMap(\.tty).first, chain.map(\.name))
  }

  static func workingDirectories(_ pids: [Int32]) async -> [Int32: String] {
    guard !pids.isEmpty else { return [:] }
    let list = pids.map(String.init).joined(separator: ",")
    guard let result = try? await StackCommandRunner.run("/usr/sbin/lsof", ["-a", "-p", list, "-d", "cwd", "-Fn"], timeout: 5) else { return [:] }
    var directories: [Int32: String] = [:]
    var current: Int32?
    for line in result.text.split(separator: "\n") {
      if line.first == "p" { current = Int32(line.dropFirst()) }
      else if line.first == "n", let current { directories[current] = String(line.dropFirst()) }
    }
    return directories
  }

  /// All TCP listeners owned by this user, attributed to Cinderdeck services or
  /// to the terminal/app that started them.
  static func listeners(managed: [Int32: StackPortListener.Managed]) async throws -> [StackPortListener] {
    let result = try await StackCommandRunner.run("/usr/sbin/lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"], timeout: 8)
    var rows: [(pid: Int32, name: String, address: String, port: Int)] = []
    var pid: Int32?
    var name = ""
    for line in result.text.split(separator: "\n") {
      switch line.first {
      case "p": pid = Int32(line.dropFirst()); name = ""
      case "c": name = String(line.dropFirst())
      case "n":
        guard let pid else { continue }
        let address = String(line.dropFirst())
        guard let colon = address.lastIndex(of: ":"), let port = Int(address[address.index(after: colon)...]) else { continue }
        if !rows.contains(where: { $0.pid == pid && $0.port == port }) { rows.append((pid, name, address, port)) }
      default: continue
      }
    }
    let directories = await workingDirectories(Array(Set(rows.map(\.pid))))
    var details: [Int32: (host: String?, tty: String?, parents: [String], group: Int32)] = [:]
    for pid in Set(rows.map(\.pid)) {
      let chain = ancestry(pid)
      details[pid] = (host(of: chain), chain.lazy.compactMap(\.tty).first, chain.map(\.name), chain.first?.group ?? getpgid(pid))
    }
    return rows.sorted { $0.port == $1.port ? $0.pid < $1.pid : $0.port < $1.port }.map { row in
      let detail = details[row.pid]
      return StackPortListener(port: row.port, address: row.address, pid: row.pid, process: row.name,
        cwd: directories[row.pid], tty: detail?.tty, launchedFrom: detail?.host,
        parents: Array((detail?.parents ?? []).prefix(8)), managed: detail.flatMap { managed[$0.group] })
    }
  }
}
