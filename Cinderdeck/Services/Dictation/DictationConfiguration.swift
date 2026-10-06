import Foundation
import Security

nonisolated struct DictationConfiguration: Codable, Equatable, Sendable {
  enum Provider: String, Codable, CaseIterable { case service, macOS }
  // Optional storage keeps configurations saved before native dictation compatible.
  private var savedProvider: Provider?
  var provider: Provider {
    get { savedProvider ?? .service }
    set { savedProvider = newValue }
  }
  private var savedOnDeviceOnly: Bool?
  var onDeviceOnly: Bool {
    get { savedOnDeviceOnly ?? true }
    set { savedOnDeviceOnly = newValue }
  }
  private var savedNativeLanguage: String?
  var nativeLanguage: String {
    get { savedNativeLanguage ?? "" }
    set { savedNativeLanguage = newValue }
  }
  var recordingLimit: TimeInterval { provider == .macOS ? 55 : 300 }
  enum Format: String, Codable, CaseIterable { case openAI, elevenLabs }
  enum Authentication: String, Codable, CaseIterable { case bearer, header, none }
  var endpoint = "https://api.openai.com/v1/audio/transcriptions"
  var model = "gpt-transcribe"
  var format = Format.openAI
  var authentication = Authentication.bearer
  var headerName = "api-key"
  var language = ""
  var globalEnabled = false
  var shortcutModifiers: UInt = 1 << 18 // Control
  var shortcutKeyCode: UInt16?
  var shortcutLabel = "⌃ Control"
  var holdDelay = 0.35

  func validate() throws {
    if provider == .service { _ = try validatedURL() }
    else if nativeLanguage.utf8.count > 64 || nativeLanguage.contains(where: { $0.isNewline }) {
      throw DictationError.message("Choose a supported macOS dictation language.")
    }
  }

  func validatedURL() throws -> URL {
    guard let url = URL(string: endpoint.trimmingCharacters(in: .whitespacesAndNewlines)),
      let host = url.host, !host.isEmpty, url.user == nil, url.password == nil, url.fragment == nil,
      url.scheme == "https" || (url.scheme == "http" && ["localhost", "127.0.0.1", "[::1]", "::1"].contains(host)) else {
      throw DictationError.message("Enter a full HTTPS transcription URL, or an HTTP localhost URL for a local server.")
    }
    guard !model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, model.utf8.count <= 256,
      !model.contains(where: { $0.isNewline }), language.utf8.count <= 32 else {
      throw DictationError.message("Enter a model slug and, optionally, a short language code such as en.")
    }
    if authentication == .header {
      guard headerName.range(of: "^[A-Za-z0-9-]+$", options: .regularExpression) != nil,
        !["host", "content-type", "content-length", "connection"].contains(headerName.lowercased()) else {
        throw DictationError.message("Enter an authentication header such as api-key or xi-api-key.")
      }
    }
    return url
  }
}

nonisolated enum DictationError: LocalizedError {
  case message(String)
  var errorDescription: String? { if case .message(let message) = self { return message }; return nil }
}

/// Secrets never enter UserDefaults, the renderer, configuration exports or diagnostics.
struct DictationKeychain {
  private var query: [String: Any] {
    [kSecClass as String: kSecClassGenericPassword,
     kSecAttrService as String: (Bundle.main.bundleIdentifier ?? "com.ryancardin.cinderdeck") + ".dictation",
     kSecAttrAccount as String: "transcription"]
  }
  func read() throws -> String {
    var request = query
    request[kSecReturnData as String] = true
    request[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(request as CFDictionary, &result)
    if status == errSecItemNotFound { return "" }
    guard status == errSecSuccess, let data = result as? Data, let key = String(data: data, encoding: .utf8) else {
      throw DictationError.message("Could not read the dictation API key from Keychain (\(status)).")
    }
    return key
  }
  func save(_ key: String) throws {
    if key.isEmpty {
      let status = SecItemDelete(query as CFDictionary)
      guard status == errSecSuccess || status == errSecItemNotFound else {
        throw DictationError.message("Could not remove the dictation API key (\(status)).")
      }
      return
    }
    let attributes: [String: Any] = [kSecValueData as String: Data(key.utf8),
      kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
    var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if status == errSecItemNotFound {
      status = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
    }
    guard status == errSecSuccess else { throw DictationError.message("Could not save the dictation API key (\(status)).") }
  }
}
