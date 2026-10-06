import AppKit
import XCTest
@testable import Cinderdeck

@MainActor
final class DictationShortcutTests: XCTestCase {
  func testControlHoldReleasesAndCancelsWhenUsedAsAnotherShortcut() {
    let config = DictationConfiguration()
    XCTAssertEqual(DictationShortcutMonitor.decision(type: .flagsChanged, keyCode: 59, flags: .control, repeating: false, configuration: config), .press)
    XCTAssertEqual(DictationShortcutMonitor.decision(type: .flagsChanged, keyCode: 59, flags: [], repeating: false, configuration: config), .release)
    XCTAssertEqual(DictationShortcutMonitor.decision(type: .keyDown, keyCode: 8, flags: .control, repeating: false, configuration: config), .cancel)
    XCTAssertEqual(DictationShortcutMonitor.decision(type: .flagsChanged, keyCode: 55, flags: [.control, .command], repeating: false, configuration: config), .cancel)
  }
  func testConfiguredChordIgnoresRepeatsAndStopsWhenEitherPartIsReleased() {
    var config = DictationConfiguration(); config.shortcutKeyCode = 49
    XCTAssertEqual(DictationShortcutMonitor.decision(type: .keyDown, keyCode: 49, flags: .control, repeating: false, configuration: config), .press)
    XCTAssertEqual(DictationShortcutMonitor.decision(type: .keyDown, keyCode: 49, flags: .control, repeating: true, configuration: config), .ignore)
    XCTAssertEqual(DictationShortcutMonitor.decision(type: .keyUp, keyCode: 49, flags: .control, repeating: false, configuration: config), .release)
    XCTAssertEqual(DictationShortcutMonitor.decision(type: .flagsChanged, keyCode: 59, flags: [], repeating: false, configuration: config), .release)
    XCTAssertEqual(DictationShortcutMonitor.decision(type: .keyDown, keyCode: 8, flags: .control, repeating: false, configuration: config), .cancel)
  }
}
