// Legacy Snapzy Keychain identifiers intentionally retained for credential compatibility.
import Foundation
import Security

nonisolated protocol StackSecretsStoring: Sendable {
  func read(_ name: String) throws -> String
}

nonisolated struct StackSecretsStore: StackSecretsStoring {
  static let service = "Snapzy Stacks"

  private func query(_ name: String?, protected: Bool) -> [String: Any] {
    var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: Self.service]
    if let name { query[kSecAttrAccount as String] = name }
    if protected { query[kSecUseDataProtectionKeychain as String] = true }
    return query
  }
  func read(_ name: String) throws -> String {
    for protected in [true, false] {
      var query = query(name, protected: protected)
      query[kSecReturnData as String] = true
      query[kSecMatchLimit as String] = kSecMatchLimitOne
      var result: CFTypeRef?
      let status = SecItemCopyMatching(query as CFDictionary, &result)
      if status == errSecSuccess, let data = result as? Data, let value = String(data: data, encoding: .utf8) { return value }
      if ![errSecItemNotFound, errSecMissingEntitlement].contains(status) { throw failure(status) }
    }
    throw StackError.message("Missing Keychain secret ‘\(name)’. Add it in Manage secrets.")
  }
  func save(_ value: String, named name: String) throws {
    guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !value.isEmpty else {
      throw StackError.message("Enter a name and a value")
    }
    for protected in [true, false] {
      let query = query(name, protected: protected)
      let attributes = [kSecValueData as String: Data(value.utf8)]
      var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
      if status == errSecItemNotFound {
        var add = query.merging(attributes) { _, new in new }
        if protected { add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlocked }
        status = SecItemAdd(add as CFDictionary, nil)
      }
      if status == errSecMissingEntitlement { continue }
      guard status == errSecSuccess else { throw failure(status) }
      if protected { SecItemDelete(self.query(name, protected: false) as CFDictionary) }
      return
    }
    throw failure(errSecMissingEntitlement)
  }
  func names() throws -> [String] {
    var names = Set<String>()
    for protected in [true, false] {
      var query = query(nil, protected: protected)
      query[kSecReturnAttributes as String] = true
      query[kSecMatchLimit as String] = kSecMatchLimitAll
      var result: CFTypeRef?
      let status = SecItemCopyMatching(query as CFDictionary, &result)
      if [errSecItemNotFound, errSecMissingEntitlement].contains(status) { continue }
      guard status == errSecSuccess else { throw failure(status) }
      for item in result as? [[String: Any]] ?? [] {
        if let name = item[kSecAttrAccount as String] as? String { names.insert(name) }
      }
    }
    return names.sorted()
  }
  func delete(_ name: String) throws {
    for protected in [true, false] {
      let status = SecItemDelete(query(name, protected: protected) as CFDictionary)
      if ![errSecSuccess, errSecItemNotFound, errSecMissingEntitlement].contains(status) { throw failure(status) }
    }
  }
  private func failure(_ status: OSStatus) -> StackError { .message("Keychain operation failed (\(status))") }
}
