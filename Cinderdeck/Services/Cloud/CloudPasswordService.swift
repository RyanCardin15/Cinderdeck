//
//  CloudPasswordService.swift
//  Cinderdeck
//
//  Manages optional password protection for cloud credentials.
//  Stores a SHA-256 hash in the macOS Keychain — no plaintext passwords are ever persisted.
//

import CryptoKit
import Foundation
import os.log

enum CloudPasswordVerificationResult {
  case verified
  case incorrectPassword
  case unavailable(String)
}

/// Manages the optional protection password for cloud credentials.
/// The password is hashed with SHA-256 before storage; verification compares hashes.
@MainActor
final class CloudPasswordService {
  static let shared = CloudPasswordService()
  private let logger = Logger(subsystem: "Cinderdeck", category: "CloudPasswordService")
  private let defaults = UserDefaults.standard

  private init() {}

  // MARK: - Public API

  /// Cached non-sensitive state used to avoid passive keychain reads.
  var hasPasswordConfigured: Bool {
    defaults.bool(forKey: PreferencesKeys.cloudPasswordEnabled)
  }

  /// Hash and store a new protection password in the Keychain.
  func savePassword(_ password: String) throws {
    let hash = sha256(password)
    do {
      try CloudKeychainStore.upsert(item: .passwordHash, value: hash)
      setPasswordConfigured(true)
      DiagnosticLogger.shared.log(.info, .cloud, "Cloud credential password saved")
    } catch {
      DiagnosticLogger.shared.logError(.cloud, error, "Cloud credential password save failed")
      throw error
    }
  }

  /// Explicit check used when the user taps Edit.
  /// Reads keychain only when necessary to preserve existing password-protected installs.
  func shouldRequirePasswordForEdit() -> Bool {
    if hasPasswordConfigured {
      return true
    }

    switch loadHash(context: "shouldRequirePasswordForEdit") {
    case .success:
      setPasswordConfigured(true)
      DiagnosticLogger.shared.log(.debug, .cloud, "Cloud credential password required for edit")
      return true
    case .itemNotFound:
      return false
    case .authRequired(let status):
      logger.notice("Keychain auth required (\(status, privacy: .public)) [shouldRequirePasswordForEdit]")
      DiagnosticLogger.shared.log(
        .warning,
        .cloud,
        "Cloud credential password check requires keychain authentication",
        context: ["status": "\(status)"]
      )
      return true
    case .interactionNotAllowed:
      logger.notice("Keychain interaction not allowed [shouldRequirePasswordForEdit]")
      DiagnosticLogger.shared.log(.warning, .cloud, "Cloud credential password check interaction not allowed")
      return true
    case .error(let status):
      logger.error("Keychain read failed (\(status, privacy: .public)) [shouldRequirePasswordForEdit]")
      DiagnosticLogger.shared.log(
        .error,
        .cloud,
        "Cloud credential password check failed",
        context: ["status": "\(status)"]
      )
      return true
    }
  }

  /// Verify a password against the stored hash.
  func verifyPassword(_ password: String) -> CloudPasswordVerificationResult {
    switch loadHash(context: "verifyPassword") {
    case .success(let storedHash):
      setPasswordConfigured(true)
      let didMatch = sha256(password) == storedHash
      DiagnosticLogger.shared.log(
        didMatch ? .info : .warning,
        .cloud,
        "Cloud credential password verification completed",
        context: ["verified": didMatch ? "true" : "false"]
      )
      return didMatch ? .verified : .incorrectPassword
    case .itemNotFound:
      setPasswordConfigured(false)
      DiagnosticLogger.shared.log(.warning, .cloud, "Cloud credential password verification skipped; hash missing")
      return .unavailable(L10n.CloudPassword.notConfigured)
    case .authRequired:
      DiagnosticLogger.shared.log(.warning, .cloud, "Cloud credential password verification requires keychain authentication")
      return .unavailable(L10n.CloudPassword.keychainAccessDenied)
    case .interactionNotAllowed:
      DiagnosticLogger.shared.log(.warning, .cloud, "Cloud credential password verification keychain interaction unavailable")
      return .unavailable(L10n.CloudPassword.keychainInteractionUnavailable)
    case .error:
      DiagnosticLogger.shared.log(.error, .cloud, "Cloud credential password verification failed to read saved hash")
      return .unavailable(L10n.CloudPassword.couldntReadSavedPassword)
    }
  }

  /// Remove the stored password hash from the Keychain.
  func removePassword() {
    let issues = CloudKeychainStore.delete(item: .passwordHash)
    setPasswordConfigured(false)
    DiagnosticLogger.shared.log(
      issues.isEmpty ? .info : .warning,
      .cloud,
      "Cloud credential password removed",
      context: ["deleteIssueCount": "\(issues.count)"]
    )
  }

  // MARK: - Hashing

  private func sha256(_ input: String) -> String {
    let data = Data(input.utf8)
    let digest = SHA256.hash(data: data)
    return digest.map { String(format: "%02x", $0) }.joined()
  }

  // MARK: - Helpers

  private func loadHash(context: String) -> CloudKeychainReadOutcome {
    CloudKeychainStore.read(item: .passwordHash, context: context)
  }

  private func setPasswordConfigured(_ enabled: Bool) {
    defaults.set(enabled, forKey: PreferencesKeys.cloudPasswordEnabled)
  }
}
