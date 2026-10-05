import Foundation

/// A proposal, never an instruction to execute during discovery.
nonisolated struct WorkspaceDiscoveredCommand: Identifiable, Equatable, Sendable {
  enum Kind: String, Sendable { case service, task }
  var id: String
  var kind: Kind
  var title: String
  var command: String
  var directory: URL
  var evidence: String
  var runtimes: [String]
  var port: String = ""
  var extraPorts: [String: Int] = [:]
  var selected = true
  var loadsDotEnv = false
  var dependencyFolder: String?
  var composeFile: String?
  var fixedPort: Int?
  var discoveryRoot: URL?
}

nonisolated struct WorkspaceDiscoveryResult: Sendable {
  var root: URL
  var commands: [WorkspaceDiscoveredCommand]
  var notes: [String]
  var folders: [URL] = []
  var repositories: [RepoDefinition] = []
}

/// Bounded static inspection. Does not follow directory symlinks, read source code,
/// install dependencies, or execute scripts from the selected repository.
nonisolated enum WorkspaceDiscovery {
  static let excluded: Set<String> = [".git", "node_modules", ".build", "build", "dist", "target", ".venv", "venv", "vendor", "Pods", ".next", ".cache"]
  static func shellQuote(_ value: String) -> String { "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'" }

  static func discover(root: URL) throws -> WorkspaceDiscoveryResult {
    let root = root.standardizedFileURL.resolvingSymlinksInPath()
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: root.path, isDirectory: &isDirectory), isDirectory.boolValue else {
      throw StackError.message("Choose an existing project folder.")
    }
    var result = WorkspaceDiscoveryResult(root: root, commands: [], notes: [], folders: [root])
    var queue: [(URL, Int, String)] = [(root, 0, "")]
    var visited = 0
    while !queue.isEmpty && visited < 200 {
      let (folder, depth, relative) = queue.removeFirst(); visited += 1
      try Task.checkCancellation()
      if let repository = repositoryRoot(containing: folder), !result.repositories.contains(where: { $0.path == repository }) {
        let base = repository == root ? "project" : repositoryIdentifier(repository.lastPathComponent)
        var id = base; var suffix = 2
        while result.repositories.contains(where: { $0.id == id }) { id = base + "-" + String(suffix); suffix += 1 }
        result.repositories.append(.init(id: id, path: repository))
      }
      let prefix = relative.isEmpty ? "" : identifier(relative) + "-"
      func candidateID(_ kind: WorkspaceDiscoveredCommand.Kind, _ key: String) -> String {
        let base = prefix + key
        return result.commands.contains(where: { $0.id == base && $0.kind == kind }) ? base + "-" + String(result.commands.count) : base
      }
      func add(_ kind: WorkspaceDiscoveredCommand.Kind, _ key: String, _ title: String, _ command: String,
        _ evidence: String, _ runtimes: [String], port: Int? = nil, dotEnv: Bool = false, dependencies: String? = nil) {
        let id = candidateID(kind, key)
        result.commands.append(.init(id: id, kind: kind, title: relative.isEmpty ? title : relative + " · " + title,
          command: command, directory: folder, evidence: evidence, runtimes: runtimes,
          port: port.map(String.init) ?? "", loadsDotEnv: dotEnv, dependencyFolder: dependencies))
      }
      func exists(_ file: String) -> Bool { FileManager.default.fileExists(atPath: folder.appendingPathComponent(file).path) }
      if exists("package.json") {
        do {
          let data = try read(folder.appendingPathComponent("package.json"))
          guard let package = try JSONSerialization.jsonObject(with: Data(data.utf8)) as? [String: Any] else {
            throw StackError.message("Expected a JSON object")
          }
          let scripts = package["scripts"] as? [String: String] ?? [:]
          let manager = packageManager(package: package, directory: folder, root: repositoryRoot(containing: folder) ?? root)
          let tools = manager == "bun" ? ["bun"] : ["node", manager]
          let dependencies = (package["dependencies"] as? [String: Any] ?? [:]).merging(package["devDependencies"] as? [String: Any] ?? [:]) { first, _ in first }
          let serviceKey = ["dev", "start", "serve"].first { scripts[$0] != nil }
          if let key = serviceKey, let script = scripts[key] {
            let id = candidateID(.service, key)
            var command = manager + " run " + shellQuote(key)
            var port = explicitPort(script)
            let framework = script.range(of: #"(?:^|[\s;&])vite(?:\s|$)"#, options: .regularExpression) != nil ? "vite" : script.contains("next dev") ? "next" : script.contains("astro dev") ? "astro" : nil
            if let framework {
              port = port ?? (framework == "vite" ? (script.contains("preview") ? 4173 : 5173) : framework == "astro" ? 4321 : 3000)
              command += (manager == "npm" ? " --" : "") + " --port {{port.\(id)}}"
              if framework == "vite" { command += " --strictPort" }
            }
            add(.service, key, key.capitalized, command, "package.json → scripts.\(key)", tools, port: port,
              dotEnv: script.contains("dotenv") || script.contains("vite") || script.contains("next ") || script.contains("astro ") || script.contains("nuxt"),
              dependencies: dependencies.isEmpty ? nil : "node_modules")
            if framework == nil { result.commands[result.commands.count - 1].fixedPort = port }
          }
          for key in scripts.keys.sorted() where ["test", "build", "lint", "check", "typecheck"].contains(key) || key.hasPrefix("test:") || key.hasPrefix("build:") {
            var command = manager + " run " + shellQuote(key)
            if let script = scripts[key], script.trimmingCharacters(in: .whitespaces) == "vitest" {
              command += (manager == "npm" ? " --" : "") + " run"
            }
            add(.task, identifier(key), key.capitalized, command, "package.json → scripts.\(key)", tools, dependencies: dependencies.isEmpty ? nil : "node_modules")
          }
        } catch { result.notes.append("Could not inspect \(relative.isEmpty ? "package.json" : relative + "/package.json"). Fix its JSON or add commands manually.") }
      }
      if exists("Cargo.toml") {
        add(.task, "cargo-test", "Tests", "cargo test", "Cargo.toml", ["cargo"])
        add(.task, "cargo-build", "Build", "cargo build", "Cargo.toml", ["cargo"])
        if exists("src/main.rs") { add(.service, "cargo-run", "Application", "cargo run", "Cargo.toml + src/main.rs", ["cargo"]) }
      }
      if exists("go.mod") {
        add(.task, "go-test", "Tests", "go test ./...", "go.mod", ["go"])
        add(.task, "go-build", "Build", "go build ./...", "go.mod", ["go"])
        if exists("main.go") { add(.service, "go-run", "Application", "go run .", "go.mod + main.go", ["go"]) }
      }
      if exists("pyproject.toml") || exists("requirements.txt") || exists("manage.py") {
        let uv = exists("uv.lock")
        let python = exists(".venv/bin/python") ? "./.venv/bin/python" : "python3"
        let runtime = uv ? ["uv"] : [python]
        let runner = uv ? "uv run python" : python
        if exists("manage.py") { add(.service, "django", "Django", runner + " manage.py runserver 127.0.0.1:{{port.\(candidateID(.service, "django"))}}", "manage.py", runtime, port: 8000) }
        let manifest = (try? read(folder.appendingPathComponent("pyproject.toml"))) ?? ""
        let requirements = (try? read(folder.appendingPathComponent("requirements.txt"))) ?? ""
        if manifest.contains("pytest") || requirements.contains("pytest") {
          add(.task, "pytest", "Tests", uv ? "uv run pytest" : python + " -m pytest", "Python dependencies include pytest", runtime)
        }
        result.notes.append("\(relative.isEmpty ? "Python project" : relative): install the project's dependencies before running commands.")
      }
      if exists("Package.swift") {
        add(.task, "swift-build", "Build", "swift build", "Package.swift", ["swift"])
        if exists("Tests") { add(.task, "swift-test", "Tests", "swift test", "Package.swift + Tests", ["swift"]) }
      }
      if exists("Makefile"), let source = try? read(folder.appendingPathComponent("Makefile")) {
        for key in ["dev", "serve", "test", "build", "lint", "check"] {
          if source.range(of: "(?m)^" + key + ":[^=]", options: .regularExpression) != nil {
            add(["dev", "serve"].contains(key) ? .service : .task, "make-" + key, "Make " + key, "make " + key, "Makefile → " + key, ["make"])
          }
        }
      }
      let children: [URL]
      do { children = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey]).sorted { $0.path < $1.path } }
      catch { result.notes.append("Could not read \(relative.isEmpty ? "the selected folder" : relative). Check folder permissions."); continue }
      for child in children where child.pathExtension == "xcodeproj" {
        let values = try? child.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard values?.isDirectory == true, values?.isSymbolicLink != true else { continue }
        let project = folder.appendingPathComponent(child.lastPathComponent, isDirectory: true)
        let buildCommand = "xcodebuild -project " + shellQuote(child.lastPathComponent)
        add(.task, "xcode-build", "Build", buildCommand + " -configuration Debug build", child.lastPathComponent, ["xcodebuild"])
        let schemes = (try? FileManager.default.contentsOfDirectory(at: project.appendingPathComponent("xcshareddata/xcschemes"), includingPropertiesForKeys: nil)) ?? []
        for scheme in schemes.sorted(by: { $0.path < $1.path }) where scheme.pathExtension == "xcscheme" {
          guard let source = try? read(scheme), source.contains("<TestableReference") || source.contains("<TestPlanReference") else { continue }
          let name = scheme.deletingPathExtension().lastPathComponent
          let projectSource = (try? read(project.appendingPathComponent("project.pbxproj"))) ?? ""
          let destination = projectSource.contains("SDKROOT = macosx") ? " -destination 'platform=macOS'" : ""
          add(.task, "xcode-test-" + identifier(name), "Test " + name, buildCommand + " -scheme " + shellQuote(name) + destination + " test", child.lastPathComponent + " → shared scheme " + name, ["xcodebuild"])
          if destination.isEmpty { result.notes.append("Choose a test destination in the Xcode test command before running it.") }
        }
      }
      for filename in ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"] where exists(filename) {
        add(.service, "containers", "Containers", "docker compose -f " + shellQuote(filename) + " up", filename + " (all Compose services)", ["docker"])
        result.commands[result.commands.count - 1].composeFile = filename
        result.notes.append("\(relative.isEmpty ? filename : relative + "/" + filename): Docker Compose configuration and published ports are checked when Docker is available. Container ports stay as authored in the Compose file.")
        break
      }
      if depth < 3 {
        for child in children where !excluded.contains(child.lastPathComponent) && !child.lastPathComponent.hasPrefix(".") && !["xcodeproj", "xcworkspace"].contains(child.pathExtension) {
          let values = try? child.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
          if values?.isDirectory == true && values?.isSymbolicLink != true {
            let name = child.lastPathComponent
            queue.append((folder.appendingPathComponent(name, isDirectory: true), depth + 1, relative.isEmpty ? name : relative + "/" + name))
          }
        }
      }
    }
    if !queue.isEmpty { result.notes.append("Discovery reached its 200-folder limit. Select a smaller project folder to inspect more packages.") }
    if result.commands.isEmpty { result.notes.append("No supported commands found. Add a service or task below, or save an empty workspace.") }
    result.notes.append("Suggestions come from manifests up to three folders deep. Review commands and ports; custom scripts may need additional tools or configuration.")
    if result.repositories.isEmpty {
      result.repositories = [.init(id: "project", path: root, laneMode: .shared)]
      result.notes.append("This folder can run services and tasks without Git. Branch lanes need at least one Git repository; regular folders stay shared.")
    }
    for index in result.commands.indices { result.commands[index].discoveryRoot = repositoryRoot(containing: result.commands[index].directory) ?? root }
    var seenNotes = Set<String>()
    result.notes = result.notes.filter { seenNotes.insert($0).inserted }
    return result
  }

  /// Combine independent selections, keeping one command per physical folder and
  /// renaming its port templates together with its ID. No project commands run.
  static func discover(root: URL, additionalFolders: [URL]) throws -> WorkspaceDiscoveryResult {
    guard additionalFolders.count < 64 else { throw StackError.message("Choose up to 64 workspace folders.") }
    var scans: [WorkspaceDiscoveryResult] = []
    for folder in [root] + additionalFolders {
      let normalized = folder.standardizedFileURL.resolvingSymlinksInPath()
      if scans.contains(where: { $0.root == normalized }) { continue }
      scans.append(try discover(root: normalized))
    }
    guard scans.count > 1 else { return scans[0] }
    var result = WorkspaceDiscoveryResult(root: scans[0].root, commands: [], notes: [], folders: scans.map(\.root))
    var usedIDs = Set<String>()
    for scan in scans {
      for var command in scan.commands {
        if result.commands.contains(where: { $0.kind == command.kind && $0.directory == command.directory && $0.evidence == command.evidence }) { continue }
        let base = identifier(scan.root.lastPathComponent) + "-" + command.id
        var id = base; var suffix = 2
        while usedIDs.contains(id) { id = base + "-" + String(suffix); suffix += 1 }
        usedIDs.insert(id)
        command.command = command.command.replacingOccurrences(of: "{{port.\(command.id)}}", with: "{{port.\(id)}}")
        command.id = id
        command.title = scan.root.lastPathComponent + " · " + command.title
        result.commands.append(command)
      }
      for repo in scan.repositories where !result.repositories.contains(where: { $0.path == repo.path }) {
        let base = repositoryIdentifier(repo.path.lastPathComponent)
        var id = base; var suffix = 2
        while result.repositories.contains(where: { $0.id == id }) { id = base + "-" + String(suffix); suffix += 1 }
        result.repositories.append(.init(id: id, path: repo.path, laneMode: repo.laneMode))
      }
      result.notes += scan.notes.map { scan.root.lastPathComponent + ": " + $0 }
    }
    // A container folder is the workspace root, not a shared repository covering
    // the Git repositories below it (which would suppress their lane worktrees).
    let gitPaths = result.repositories.filter { $0.laneMode == .worktree }.map(\.path)
    result.repositories.removeAll { repo in repo.laneMode == .shared && gitPaths.contains { StackLaneStore.relative($0, to: repo.path) != nil } }
    return result
  }

  /// .git can be a directory or a worktree/submodule metadata file. Walk upward
  /// so selecting a package inside a repository still registers its Git root.
  static func repositoryRoot(containing directory: URL) -> URL? {
    var folder = directory.standardizedFileURL.resolvingSymlinksInPath()
    while true {
      if FileManager.default.fileExists(atPath: folder.appendingPathComponent(".git").path) { return folder }
      if folder.path == "/" { return nil }
      let parent = folder.deletingLastPathComponent().standardizedFileURL
      if parent.path == folder.path { return nil }
      folder = parent
    }
  }

  /// Nested packages inherit their nearest manifest/lockfile's package manager.
  static func packageManager(package: [String: Any], directory: URL, root: URL) -> String {
    var folder = directory
    var current = package
    while true {
      if let declared = (current["packageManager"] as? String)?.components(separatedBy: "@").first,
        ["npm", "pnpm", "yarn", "bun"].contains(declared) { return declared }
      for (file, manager) in [("pnpm-lock.yaml", "pnpm"), ("yarn.lock", "yarn"), ("bun.lock", "bun"), ("bun.lockb", "bun"), ("package-lock.json", "npm")] {
        if FileManager.default.fileExists(atPath: folder.appendingPathComponent(file).path) { return manager }
      }
      if folder.standardizedFileURL.path == root.standardizedFileURL.path { break }
      let parent = folder.deletingLastPathComponent().standardizedFileURL
      if parent.path == folder.path { break }
      folder = parent
      current = (try? read(folder.appendingPathComponent("package.json"))).flatMap {
        (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? [String: Any]
      } ?? [:]
    }
    return "npm"
  }

  private static func repositoryIdentifier(_ value: String) -> String {
    let id = identifier(value)
    return id.isEmpty ? "repository" : id
  }

  static func identifier(_ value: String) -> String {
    value.lowercased().replacingOccurrences(of: "[^a-z0-9_-]+", with: "-", options: .regularExpression)
      .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
  }
  static func explicitPort(_ command: String) -> Int? {
    let pattern = #"(?:--port[ =]+|-p\s+|PORT=|127\.0\.0\.1:|localhost:)(\d{2,5})\b"#
    guard let regex = try? NSRegularExpression(pattern: pattern),
      let match = regex.firstMatch(in: command, range: NSRange(command.startIndex..., in: command)),
      let range = Range(match.range(at: 1), in: command), let port = Int(command[range]), (1...65535).contains(port) else { return nil }
    return port
  }
  static func read(_ file: URL) throws -> String {
    let values = try file.resourceValues(forKeys: [.fileSizeKey, .isSymbolicLinkKey])
    guard values.isSymbolicLink != true, (values.fileSize ?? Int.max) <= 1_048_576 else {
      throw StackError.message("Manifest is a symlink or larger than 1 MB")
    }
    return try String(contentsOf: file, encoding: .utf8)
  }
}
