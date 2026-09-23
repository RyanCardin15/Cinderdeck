//
//  CinderdeckConfigurationResult.swift
//  Cinderdeck
//
//  Import/export result models for TOML configuration.
//

import Foundation

enum CinderdeckConfigurationIssueSeverity: Sendable {
  case warning
  case error
}

struct CinderdeckConfigurationIssue: Identifiable, Sendable {
  let id = UUID()
  let severity: CinderdeckConfigurationIssueSeverity
  let message: String
}

struct CinderdeckConfigurationImportResult: Sendable {
  let appliedChangeCount: Int
  let issues: [CinderdeckConfigurationIssue]

  var hasErrors: Bool {
    issues.contains { $0.severity == .error }
  }
}

enum CinderdeckConfigurationSyncDecision: Equatable, Sendable {
  case alreadyCurrent
  case syncAutomatically
  case askBeforeReplacing
}

enum CinderdeckConfigurationSyncStatus: Equatable, Sendable {
  case alreadyCurrent
  case synced
  case needsConfirmation
  case permissionRequired
}

struct CinderdeckConfigurationSyncResult: Sendable {
  let status: CinderdeckConfigurationSyncStatus
  let fileURL: URL
  let observedFileSignature: String?
  let exportedSettingsSignature: String?

  nonisolated init(
    status: CinderdeckConfigurationSyncStatus,
    fileURL: URL,
    observedFileSignature: String? = nil,
    exportedSettingsSignature: String? = nil
  ) {
    self.status = status
    self.fileURL = fileURL
    self.observedFileSignature = observedFileSignature
    self.exportedSettingsSignature = exportedSettingsSignature
  }
}

enum CinderdeckConfigurationSyncError: LocalizedError, Sendable {
  case fileChangedSinceConfirmation

  var errorDescription: String? {
    switch self {
    case .fileChangedSinceConfirmation:
      return "config.toml changed. Review it and try again."
    }
  }
}
