import Foundation
import GRDB

/// Imports the fork's previous identity once, without moving or deleting original data.
/// Stored capture paths and user-selected folders intentionally retain their original locations.
nonisolated enum CinderdeckMigration {
  static func runIfNeeded(
    home: URL = FileManager.default.homeDirectoryForCurrentUser,
    defaults: UserDefaults = .standard,
    legacyPreferences: [String: Any]? = nil
  ) throws {
    let fm = FileManager.default
    let support = home.appendingPathComponent("Library/Application Support")
    let source = support.appendingPathComponent("Snapzy")
    let destination = support.appendingPathComponent("Cinderdeck")
    let marker = destination.appendingPathComponent(".snapzy-import-completed")
    guard !fm.fileExists(atPath: marker.path) else { return }
    try fm.createDirectory(at: destination, withIntermediateDirectories: true)

    // A database backup includes committed WAL content, even if Snapzy is still running.
    let oldDatabase = source.appendingPathComponent("snapzy.db")
    let newDatabase = destination.appendingPathComponent("cinderdeck.db")
    if fm.fileExists(atPath: oldDatabase.path), !fm.fileExists(atPath: newDatabase.path) {
      let temporary = destination.appendingPathComponent(".import-\(UUID().uuidString).db")
      defer {
        for suffix in ["", "-wal", "-shm"] { try? fm.removeItem(atPath: temporary.path + suffix) }
      }
      do {
        var configuration = Configuration()
        configuration.readonly = true
        let reader = try DatabaseQueue(path: oldDatabase.path, configuration: configuration)
        let writer = try DatabaseQueue(path: temporary.path)
        try reader.backup(to: writer)
        try writer.close()
        try reader.close()
      }
      try fm.moveItem(at: temporary, to: newDatabase)
    }
    try copyMissing(from: source, to: destination,
                    excluding: ["snapzy.db", "snapzy.db-wal", "snapzy.db-shm", "Agent", "Stacks", "Stacks-Debug"])
    // Live sockets cannot be copied. The new server regenerates its state
    // snapshot; persisted advisory claims remain useful across the rename.
    try copyMissing(from: source.appendingPathComponent("Stacks"),
                    to: destination.appendingPathComponent("Stacks"),
                    excluding: ["control.sock", "state.json"])
    let oldConfig = home.appendingPathComponent(".config/snapzy")
    let newConfig = home.appendingPathComponent(".config/cinderdeck")
    let newConfigFile = newConfig.appendingPathComponent("config.toml")
    let hadConfig = fm.fileExists(atPath: newConfigFile.path)
    try copyMissing(from: oldConfig, to: newConfig)
    if !hadConfig, fm.fileExists(atPath: newConfigFile.path) {
      let text = try String(contentsOf: newConfigFile, encoding: .utf8)
      try text.replacingOccurrences(of: "~/.config/snapzy/stacks", with: "~/.config/cinderdeck/stacks")
        .write(to: newConfigFile, atomically: true, encoding: .utf8)
    }
    try copyMissing(from: home.appendingPathComponent("Library/Logs/Snapzy"),
                    to: home.appendingPathComponent("Library/Logs/Cinderdeck"))

    let preferences = legacyPreferences ?? defaults.persistentDomain(forName: "com.trongduong.snapzy") ?? [:]
    for (key, value) in preferences where defaults.object(forKey: key) == nil {
      // Sparkle must never import the upstream feed or update authorization.
      guard !key.hasPrefix("SU") else { continue }
      if key == "stacks.directory", let path = value as? String,
         path == "~/.config/snapzy/stacks" || path == oldConfig.appendingPathComponent("stacks").path {
        defaults.set("~/.config/cinderdeck/stacks", forKey: key)
      } else if ["configuration.fileBookmark", "configuration.directoryBookmark"].contains(key),
                let data = value as? Data {
        var stale = false
        let url = try? URL(resolvingBookmarkData: data, options: [.withoutUI, .withoutMounting], bookmarkDataIsStale: &stale)
        // Use the new default for the old default; preserve deliberately selected folders.
        if url?.standardizedFileURL == oldConfig.standardizedFileURL ||
           url?.standardizedFileURL == oldConfig.appendingPathComponent("config.toml").standardizedFileURL { continue }
        defaults.set(value, forKey: key)
      } else {
        defaults.set(value, forKey: key)
      }
    }
    try Data("Imported from Snapzy without deleting the original data.\n".utf8).write(to: marker, options: .atomic)
  }

  private static func copyMissing(from source: URL, to destination: URL, excluding: Set<String> = []) throws {
    let fm = FileManager.default
    guard fm.fileExists(atPath: source.path) else { return }
    try fm.createDirectory(at: destination, withIntermediateDirectories: true)
    for item in try fm.contentsOfDirectory(at: source, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey, .isRegularFileKey]) {
      guard !excluding.contains(item.lastPathComponent) else { continue }
      let target = destination.appendingPathComponent(item.lastPathComponent)
      let values = try item.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey, .isRegularFileKey])
      // Skip any other transient sockets/devices/FIFOs in imported folders.
      guard values.isDirectory == true || values.isSymbolicLink == true || values.isRegularFile == true else { continue }
      if values.isDirectory == true && values.isSymbolicLink != true {
        try copyMissing(from: item, to: target)
      } else if !fm.fileExists(atPath: target.path) {
        try fm.copyItem(at: item, to: target)
      }
    }
  }
}
