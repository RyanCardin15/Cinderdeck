//
//  FakePreferencesProvider.swift
//  CinderdeckTests
//
//  In-memory PreferencesProviding fake for unit tests.
//

import Foundation
@testable import Cinderdeck

@MainActor
final class FakePreferencesProvider: PreferencesProviding {
  private var actions: [AfterCaptureAction: [CaptureType: Bool]] = [:]

  func setAction(_ action: AfterCaptureAction, for type: CaptureType, enabled: Bool) {
    if actions[action] == nil {
      actions[action] = [:]
    }
    actions[action]?[type] = enabled
  }

  func isActionEnabled(_ action: AfterCaptureAction, for type: CaptureType) -> Bool {
    actions[action]?[type] ?? defaultValue(for: action, type: type)
  }

  private func defaultValue(for action: AfterCaptureAction, type: CaptureType) -> Bool {
    switch action {
    case .showQuickAccess, .save, .copyFile:
      return true
    case .openAnnotate:
      return false
    }
  }
}
