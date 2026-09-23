import Darwin
import Foundation

// MARK: - Actors and claims

/// Who performed a stack action. Agents are identified from the calling
/// process tree (for example "Cursor" or "Codex") plus any name they supply.
nonisolated struct StackActor: Codable, Equatable, Hashable, Sendable {
  enum Kind: String, Codable, Sendable { case user, agent }
  var kind: Kind
  var name: String
  var session: String?
  /// App or CLI the caller runs inside, detected from its parent processes.
  var host: String?
  var pid: Int32?
  var tty: String?
  var cwd: String?

  static let user = StackActor(kind: .user, name: "You")
  var isAgent: Bool { kind == .agent }
  /// Identity used for claims: the same agent name and session is the same holder.
  var key: String { kind == .user ? "user" : name.lowercased() + "#" + (session ?? "") }
  var label: String {
    guard isAgent else { return "You" }
    var text = name
    if let session, !session.isEmpty { text += " · " + session }
    if let host, host.caseInsensitiveCompare(name) != .orderedSame { text += " in " + host }
    return text
  }
}

/// An advisory lease. While a stack is claimed, other agents must pass
/// `force` to change it. The Cinderdeck UI is never blocked.
nonisolated struct StackClaim: Codable, Equatable, Sendable {
  let stackID: String
  var holder: StackActor
  var note: String?
  var since: Date
  var expiresAt: Date
  var isExpired: Bool { expiresAt <= Date() }
}

// MARK: - Wire format (newline-delimited JSON over a Unix socket)

nonisolated struct StackControlClientInfo: Codable, Sendable {
  var name: String?
  var session: String?
  var cwd: String?
}

nonisolated struct StackControlRequest: Codable, Sendable {
  var id: Int
  var method: String
  var params: JSONValue?
  var client: StackControlClientInfo?
}

nonisolated struct StackControlError: Codable, Error, LocalizedError, Sendable {
  var code: String
  var message: String
  var errorDescription: String? { message }
  static func invalid(_ message: String) -> Self { .init(code: "invalid_params", message: message) }
  static func notFound(_ message: String) -> Self { .init(code: "not_found", message: message) }
}

nonisolated struct StackControlResponse: Codable, Sendable {
  var id: Int
  var result: JSONValue?
  var error: StackControlError?
}

// MARK: - Snapshots (also written to state.json)

nonisolated struct StackServiceSnapshot: Codable, Sendable {
  let name: String
  let phase: String
  let status: String
  let ready: Bool
  let pid: Int32?
  let pgid: Int32?
  let port: Int?
  let url: String?
  let startedAt: Date?
  let restarts: Int
  let detail: String?
  let owner: StackActor?
  let repo: String?
  let branch: String?
  let cwd: String?
  let command: String?
  let dependsOn: [String]
  let autostart: Bool
  let logFile: String
}

nonisolated struct StackRepoSnapshot: Codable, Sendable {
  let id: String
  let path: String
  let branch: String
  let dirty: Bool
  let changedFiles: Int
  let ahead: Int
  let behind: Int
  let upstream: String?
  let operation: String?
  let error: String?
}

nonisolated struct StackSnapshot: Codable, Sendable {
  let id: String
  let name: String
  let file: String
  let state: String
  let operation: String?
  let definitionChanged: Bool
  let issues: [String]
  let claim: StackClaim?
  let services: [StackServiceSnapshot]
  let repos: [StackRepoSnapshot]
}

nonisolated struct StacksSnapshot: Codable, Sendable {
  var version = 1
  let updatedAt: Date
  let appRunning: Bool
  let appPID: Int32
  let socket: String
  let stacksDirectory: String
  let logsDirectory: String
  let stacks: [StackSnapshot]
}

nonisolated struct StackPortListener: Codable, Sendable {
  struct Managed: Codable, Sendable { let stack: String; let stackName: String; let service: String }
  let port: Int
  let address: String
  let pid: Int32
  let process: String
  let cwd: String?
  let tty: String?
  /// App or agent CLI the process was started from, such as "Cursor" or "Terminal".
  let launchedFrom: String?
  let parents: [String]
  let managed: Managed?
}

// MARK: - Paths

nonisolated enum StackControlPaths {
  static var directory: URL {
    #if DEBUG
    if let root = ProcessInfo.processInfo.environment["CINDERDECK_STACKS_PREVIEW_ROOT"], root.hasPrefix("/") {
      return URL(fileURLWithPath: root, isDirectory: true).appendingPathComponent("Agent", isDirectory: true)
    }
    let folder = "Stacks-Debug"
    #else
    let folder = "Stacks"
    #endif
    return FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/Application Support/Cinderdeck", isDirectory: true)
      .appendingPathComponent(folder, isDirectory: true)
  }

  static var socket: URL {
    if let override = ProcessInfo.processInfo.environment["CINDERDECK_STACKS_SOCKET"], override.hasPrefix("/") {
      return URL(fileURLWithPath: override)
    }
    let preferred = directory.appendingPathComponent("control.sock")
    // sockaddr_un.sun_path holds 104 bytes including the terminator.
    if preferred.path.utf8.count < 100 { return preferred }
    return URL(fileURLWithPath: "/tmp/cinderdeck-stacks-\(getuid()).sock")
  }

  static var state: URL { directory.appendingPathComponent("state.json") }
  static var claims: URL { directory.appendingPathComponent("claims.json") }

  static func ensureDirectory() throws {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
  }
}

// MARK: - Coding helpers

nonisolated enum StackControlCoding {
  static func encoder(pretty: Bool = false) -> JSONEncoder {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    encoder.outputFormatting = pretty ? [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes] : [.sortedKeys, .withoutEscapingSlashes]
    return encoder
  }
  static func decoder() -> JSONDecoder {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return decoder
  }
}

/// A small dynamic JSON value for request parameters and results.
nonisolated enum JSONValue: Codable, Equatable, Sendable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSONValue])
  case object([String: JSONValue])

  init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() { self = .null }
    else if let value = try? container.decode(Bool.self) { self = .bool(value) }
    else if let value = try? container.decode(Double.self) { self = .number(value) }
    else if let value = try? container.decode(String.self) { self = .string(value) }
    else if let value = try? container.decode([JSONValue].self) { self = .array(value) }
    else { self = .object(try container.decode([String: JSONValue].self)) }
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .null: try container.encodeNil()
    case .bool(let value): try container.encode(value)
    case .number(let value):
      if value.rounded() == value, abs(value) < 9_007_199_254_740_992 { try container.encode(Int64(value)) }
      else { try container.encode(value) }
    case .string(let value): try container.encode(value)
    case .array(let value): try container.encode(value)
    case .object(let value): try container.encode(value)
    }
  }

  init<T: Encodable>(encoding value: T) throws {
    let data = try StackControlCoding.encoder().encode(value)
    self = try StackControlCoding.decoder().decode(JSONValue.self, from: data)
  }

  func decode<T: Decodable>(_ type: T.Type) throws -> T {
    try StackControlCoding.decoder().decode(type, from: try StackControlCoding.encoder().encode(self))
  }

  subscript(key: String) -> JSONValue? {
    if case .object(let object) = self { return object[key] }
    return nil
  }

  var stringValue: String? {
    switch self {
    case .string(let value): return value
    case .number(let value): return value.rounded() == value ? String(Int(value)) : String(value)
    default: return nil
    }
  }
  var intValue: Int? {
    switch self {
    case .number(let value): return Int(exactly: value.rounded())
    case .string(let value): return Int(value)
    default: return nil
    }
  }
  var doubleValue: Double? {
    switch self {
    case .number(let value): return value
    case .string(let value): return Double(value)
    default: return nil
    }
  }
  var boolValue: Bool? {
    switch self {
    case .bool(let value): return value
    case .string(let value): return ["true", "1", "yes"].contains(value.lowercased()) ? true : ["false", "0", "no"].contains(value.lowercased()) ? false : nil
    case .number(let value): return value != 0
    default: return nil
    }
  }
  var arrayValue: [JSONValue]? { if case .array(let value) = self { return value }; return nil }
  var objectValue: [String: JSONValue]? { if case .object(let value) = self { return value }; return nil }
  /// Accepts `["a","b"]` or a single comma-separated string.
  var stringsValue: [String]? {
    if let array = arrayValue { return array.compactMap(\.stringValue).filter { !$0.isEmpty } }
    if let string = stringValue { return string.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } }
    return nil
  }

  func prettyString() -> String {
    guard let data = try? StackControlCoding.encoder(pretty: true).encode(self) else { return "null" }
    return String(decoding: data, as: UTF8.self)
  }
}
