//
//  CinderdeckConfigurationCardActionShortcutsTests.swift
//  CinderdeckTests
//
//  TOML round-trip coverage for Quick Access card action shortcuts. The exported
//  key token must be one the importer accepts — ⌘⌫ (delete) exports as "⌫", which
//  the parser previously rejected.
//

import Carbon.HIToolbox
import XCTest
@testable import Cinderdeck

@MainActor
final class CinderdeckConfigurationCardActionShortcutsTests: XCTestCase {

  func testExport_writesEveryCardActionUnderItsConfigKey() throws {
    let source = CinderdeckConfigurationExporter.exportTOML(defaults: UserDefaultsFactory.make())
    let document = try SimpleTOMLParser.parse(source)

    XCTAssertNotNil(
      document.value(at: "shortcuts", "quick_access", "card_actions", "enabled")?.boolValue
    )

    for action in QuickAccessActionKind.defaultOrder {
      XCTAssertNotNil(
        document.value(at: "shortcuts", "quick_access", "card_actions", action.configKey, "key"),
        "\(action.configKey) missing from export"
      )
    }
  }

  func testExport_defaultDeleteBindingRoundTripsThroughTheImporter() throws {
    let store = QuickAccessActionShortcutStore.shared
    let original = store.shortcut(for: .delete)
    defer { store.setShortcut(original, for: .delete) }

    let deleteShortcut = ShortcutConfig(keyCode: UInt32(kVK_Delete), modifiers: UInt32(cmdKey))
    store.setShortcut(deleteShortcut, for: .delete)

    let source = CinderdeckConfigurationExporter.exportTOML(defaults: UserDefaultsFactory.make())
    let document = try SimpleTOMLParser.parse(source)
    let path = ["shortcuts", "quick_access", "card_actions", "delete"]

    let key = try XCTUnwrap(document.value(at: path + ["key"])?.stringValue)
    let modifiers = try XCTUnwrap(document.value(at: path + ["modifiers"])?.stringArrayValue)

    XCTAssertEqual(
      CinderdeckConfigurationShortcutCodec.shortcut(key: key, modifiers: modifiers, requireModifier: true),
      deleteShortcut
    )
  }

  func testExport_everyDefaultBindingSurvivesTheImportParser() throws {
    let source = CinderdeckConfigurationExporter.exportTOML(defaults: UserDefaultsFactory.make())
    let document = try SimpleTOMLParser.parse(source)

    for action in QuickAccessActionKind.defaultOrder {
      let path = ["shortcuts", "quick_access", "card_actions", action.configKey]
      let key = try XCTUnwrap(document.value(at: path + ["key"])?.stringValue)
      let modifiers = try XCTUnwrap(document.value(at: path + ["modifiers"])?.stringArrayValue)
      guard !key.isEmpty else { continue }

      XCTAssertNotNil(
        CinderdeckConfigurationShortcutCodec.shortcut(
          key: key,
          modifiers: modifiers,
          requireModifier: true
        ),
        "\(action.configKey) exported key \"\(key)\" is not importable"
      )
    }
  }
}
