//
//  UserDefaultsFactory.swift
//  CinderdeckTests
//
//  Creates isolated UserDefaults instances for tests.
//

import Foundation

enum UserDefaultsFactory {
  static func make(
    file: StaticString = #filePath,
    line: UInt = #line
  ) -> UserDefaults {
    let suiteName = "CinderdeckTests.\(UUID().uuidString)"
    guard let defaults = UserDefaults(suiteName: suiteName) else {
      fatalError("Failed to create UserDefaults with suiteName \(suiteName)")
    }
    defaults.removePersistentDomain(forName: suiteName)
    return defaults
  }
}
