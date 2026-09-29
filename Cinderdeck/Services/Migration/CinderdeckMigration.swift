import Foundation
import GRDB

/// Imports the fork's previous identity once, without moving or deleting original data.
/// Existing capture files stay in place; future exports use the current identity.
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
    let marker = destination.appendingPathComponent(".legacy-import-completed")
    let previousMarker = destination.appendingPathComponent(".snapzy-import-completed")
    if fm.fileExists(atPath: marker.path) || fm.fileExists(atPath: previousMarker.path) {
      try repairIdentity(home: home, defaults: defaults)
      if fm.fileExists(atPath: previousMarker.path) {
        if !fm.fileExists(atPath: marker.path) { try fm.moveItem(at: previousMarker, to: marker) }
        else { try fm.removeItem(at: previousMarker) }
      }
      return
    }
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
                    excluding: ["snapzy.db", "snapzy.db-wal", "snapzy.db-shm", "Agent", "Stacks", "Stacks-Debug", ".snapzy-import-completed"])
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
    try repairIdentity(home: home, defaults: defaults)
    try Data("Legacy data imported into Cinderdeck; original files preserved.\n".utf8).write(to: marker, options: .atomic)
  }

  /// Also runs for installations that already completed the original import.
  /// Repair the TOML before automatic import can restore old export settings.
  static func repairIdentity(
    home: URL = FileManager.default.homeDirectoryForCurrentUser,
    defaults: UserDefaults = .standard
  ) throws {
    for key in ["screenshot.fileNameTemplate", "recording.fileNameTemplate"] {
      if let value = defaults.string(forKey: key) {
        let updated = CinderdeckIdentity.captureTemplate(value)
        if updated != value { defaults.set(updated, forKey: key) }
      }
    }
    if defaults.string(forKey: "cloud.providerType") == "google_drive",
       let folder = defaults.string(forKey: "cloud.bucket") {
      let updated = CinderdeckIdentity.googleDriveFolder(folder)
      if updated != folder { defaults.set(updated, forKey: "cloud.bucket") }
    }
    if let path = defaults.string(forKey: "exportLocation") {
      let updated = CinderdeckIdentity.exportPath(path)
      if updated != path {
        defaults.set(updated, forKey: "exportLocation")
        defaults.removeObject(forKey: "exportLocation.bookmark")
      }
    }
    if let bookmark = bookmarkURL(defaults.data(forKey: "exportLocation.bookmark")),
       CinderdeckIdentity.exportPath(bookmark.path) != bookmark.path {
      if defaults.string(forKey: "exportLocation") == nil {
        defaults.set(CinderdeckIdentity.exportPath(bookmark.path), forKey: "exportLocation")
      }
      defaults.removeObject(forKey: "exportLocation.bookmark")
    }

    let oldConfig = home.appendingPathComponent(".config/snapzy").standardizedFileURL
    var configURLs = Set([home.appendingPathComponent(".config/cinderdeck/config.toml")])
    for key in ["configuration.fileBookmark", "configuration.directoryBookmark"] {
      guard let url = bookmarkURL(defaults.data(forKey: key)) else { continue }
      if url == oldConfig || url == oldConfig.appendingPathComponent("config.toml") {
        defaults.removeObject(forKey: key)
      } else {
        configURLs.insert(key == "configuration.directoryBookmark" ? url.appendingPathComponent("config.toml") : url)
      }
    }
    for url in configURLs where FileManager.default.fileExists(atPath: url.path) {
      let accessed = url.startAccessingSecurityScopedResource()
      defer { if accessed { url.stopAccessingSecurityScopedResource() } }
      let original = try String(contentsOf: url, encoding: .utf8)
      let updated = CinderdeckIdentity.configuration(original)
      if updated != original { try updated.write(to: url, atomically: true, encoding: .utf8) }
    }
  }

  private static func bookmarkURL(_ data: Data?) -> URL? {
    guard let data else { return nil }
    var stale = false
    return try? URL(resolvingBookmarkData: data, options: [.withoutUI, .withoutMounting],
                    bookmarkDataIsStale: &stale).standardizedFileURL
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

/// Only old product names in export settings are changed. Project paths,
/// comments, credentials, and previously saved files are left intact.
nonisolated enum CinderdeckIdentity {
  static func captureTemplate(_ value: String) -> String {
    value.replacingOccurrences(of: "snapzy", with: "Cinderdeck", options: .caseInsensitive)
  }

  static func exportPath(_ path: String) -> String {
    path.components(separatedBy: "/").map {
      $0.caseInsensitiveCompare("Snapzy") == .orderedSame ? "Cinderdeck" : $0
    }.joined(separator: "/")
  }

  static func googleDriveFolder(_ name: String) -> String {
    name.caseInsensitiveCompare("Snapzy") == .orderedSame ? "Cinderdeck" : name
  }

  static func configuration(_ source: String) -> String {
    var paths = [["general", "export_location"], ["capture", "naming", "screenshot_template"],
                 ["capture", "naming", "recording_template"], ["cloud", "folder_name"]]
    if let document = try? SimpleTOMLParser.parse(source),
       document.value(at: ["cloud", "provider"])?.stringValue == "google_drive" {
      paths.append(["cloud", "bucket"])
    }
    var section = ""
    return source.components(separatedBy: "\n").map { line in
      let trimmed = line.trimmingCharacters(in: .whitespaces)
      if trimmed.hasPrefix("[") {
        section = line
        return line
      }
      guard let document = try? SimpleTOMLParser.parse(section + "\n" + line) else { return line }
      for path in paths {
        guard let value = document.value(at: path)?.stringValue else { continue }
        let updated: String
        if path == ["general", "export_location"] { updated = exportPath(value) }
        else if path.first == "cloud" { updated = googleDriveFolder(value) }
        else { updated = captureTemplate(value) }
        guard updated != value,
              let assignment = line.firstIndex(of: "="),
              let range = line.range(of: #""(?:\\.|[^"\\])*""#, options: .regularExpression,
                                     range: line.index(after: assignment)..<line.endIndex) else { return line }
        let escaped = updated.replacingOccurrences(of: "\\", with: "\\\\")
          .replacingOccurrences(of: "\"", with: "\\\"")
          .replacingOccurrences(of: "\n", with: "\\n").replacingOccurrences(of: "\t", with: "\\t")
        return line.replacingCharacters(in: range, with: "\"\(escaped)\"")
      }
      return line
    }.joined(separator: "\n")
  }
}
