import XCTest
@testable import Cinderdeck

@MainActor
final class CinderdeckNativeSettingsTests: XCTestCase {
  private func change(_ expected: JSONValue, _ value: JSONValue) -> JSONValue {
    .object(["expected": expected, "value": value])
  }

  func testRequestsHaveBoundedIdentityAndNoRemoteOrCommandAuthority() throws {
    let valid = #"{"requestID":"12345678-1234-1234-1234-123456789012","action":"read","category":"capture"}"#
    XCTAssertEqual(try NativeSettingsRequest.decode(Data(valid.utf8)).category, "capture")
    for invalid in [valid.replacingOccurrences(of: "capture", with: "unknown"), valid.replacingOccurrences(of: "read", with: "exec"), valid.replacingOccurrences(of: "12345678-1234-1234-1234-123456789012", with: "not-an-id"), String(valid.dropLast()) + #", "workspaceID":"other"}"#, String(valid.dropLast()) + #", "command":"rm"}"#, String(valid.dropLast()) + #", "payload":{"value":""# + String(repeating: "x", count: 17000) + #""}}"#] {
      XCTAssertThrowsError(try NativeSettingsRequest.decode(Data(invalid.utf8)))
    }
  }

  func testPartialPatchKeepsUnrelatedSettingsAndRejectsStaleOrWrongTypes() throws {
    let current = try CinderdeckNativeSettings.configurationFields("""
      schema_version = 1
      [capture.screenshot]
      show_cursor = false
      format = "png"
      [recording]
      fps = 30
      """)
    let patch = try CinderdeckNativeSettings.patchTOML(category: "capture", changes: .object(["capture.screenshot.show_cursor": change(.bool(false), .bool(true))]), current: current)
    let parsed = try SimpleTOMLParser.parse(patch)
    XCTAssertEqual(parsed.value(at: "capture", "screenshot", "show_cursor"), .bool(true))
    XCTAssertNil(parsed.value(at: "recording", "fps"))
    for changes in [
      ["capture.screenshot.show_cursor": change(.bool(true), .bool(false))],
      ["capture.screenshot.show_cursor": change(.bool(false), .string("true"))],
      ["capture.screenshot.unknown": change(.bool(false), .bool(true))],
      ["recording.fps": change(.number(30), .number(60))],
    ] { XCTAssertThrowsError(try CinderdeckNativeSettings.patchTOML(category: "capture", changes: .object(changes), current: current)) }
  }

  func testShortcutPatchIncludesCompanionValuesAndEscapesStrings() throws {
    let current: [String: JSONValue] = ["shortcuts.global.area.key": .string("4"), "shortcuts.global.area.modifiers": .array([.string("command"), .string("shift")]), "shortcuts.global.area.enabled": .bool(true)]
    XCTAssertThrowsError(try CinderdeckNativeSettings.patchTOML(category: "shortcuts", changes: .object(["shortcuts.global.area.key": change(.string("4"), .string("5"))]), current: current))
    let source = try CinderdeckNativeSettings.patchTOML(category: "shortcuts", changes: .object(current.mapValues { change($0, $0) }), current: current)
    XCTAssertEqual(try SimpleTOMLParser.parse(source).value(at: "shortcuts", "global", "area", "modifiers")?.stringArrayValue, ["command", "shift"])
    let escaped = "name\"\n[general]\nplay_sounds = false"
    let text = try CinderdeckNativeSettings.patchTOML(category: "capture", changes: .object(["capture.naming.screenshot_template": change(.string("old"), .string(escaped))]), current: ["capture.naming.screenshot_template": .string("old")])
    let parsed = try SimpleTOMLParser.parse(text)
    XCTAssertEqual(parsed.value(at: "capture", "naming", "screenshot_template")?.stringValue, escaped)
    XCTAssertNil(parsed.value(at: "general", "play_sounds"))
  }

  func testListsCannotSmuggleNonStringValues() {
    XCTAssertThrowsError(try CinderdeckNativeSettings.patchTOML(category: "menuBar", changes: .object(["menu_bar.hidden_items": change(.array([]), .array([.number(1)]))]), current: ["menu_bar.hidden_items": .array([])]))
  }

  func testLegacyCategoriesAlwaysRouteIntoTheUnifiedShell() {
    for tab in PreferencesTab.allCases { XCTAssertTrue(UnifiedSettingsNavigation.sections.contains("settings:" + tab.rawValue)) }
    XCTAssertTrue(UnifiedSettingsNavigation.sections.contains("settings:workspace"))
    XCTAssertTrue(UnifiedSettingsNavigation.sections.contains("settings:workspace-delete"))
    XCTAssertEqual(UnifiedSettingsNavigation.section(for: nil), "settings:general")
    XCTAssertEqual(CinderdeckNativeSettings.category(for: "general.appearance"), "appearance")
    XCTAssertEqual(CinderdeckNativeSettings.category(for: "capture.naming.recording_template"), "recording")
    XCTAssertEqual(CinderdeckNativeSettings.category(for: "capture.after.recording.copy_file"), "recording")
  }

  func testMigratedCaptureControlsValidateAndPersistInIsolatedDefaults() {
    let defaults = UserDefaultsFactory.make()
    let result = CinderdeckConfigurationImporter.importTOML("""
      schema_version = 1
      [capture.screenshot]
      include_window_shadow = false
      live_passthrough = false
      auto_detect_window = true
      auto_detect_element = true
      [capture.ocr]
      link_detection = false
      [recording]
      hover_bar_visible = false
      show_time_on_menu_bar = false
      """, defaults: defaults)
    XCTAssertFalse(result.hasErrors)
    XCTAssertEqual(defaults.object(forKey: PreferencesKeys.captureIncludeWindowShadow) as? Bool, false)
    XCTAssertEqual(defaults.object(forKey: PreferencesKeys.screenshotLivePassthrough) as? Bool, false)
    XCTAssertEqual(defaults.object(forKey: PreferencesKeys.screenshotAutoDetectElementUnderCursor) as? Bool, true)
    XCTAssertEqual(defaults.object(forKey: PreferencesKeys.ocrLinkDetectionEnabled) as? Bool, false)
    XCTAssertEqual(defaults.object(forKey: PreferencesKeys.recordingHoverBarVisible) as? Bool, false)
    XCTAssertEqual(defaults.object(forKey: PreferencesKeys.recordingShowTimeOnMenuBar) as? Bool, false)
  }
}
