import AppKit
import Carbon.HIToolbox
import XCTest
@testable import Cinderdeck

@MainActor
final class PullRequestsShortcutTests: XCTestCase {
  private func preserveSettings(_ manager: KeyboardShortcutManager) {
    let config = manager.shortcut(for: .pullRequests)
    let enabled = manager.isShortcutEnabled(for: .pullRequests)
    let masterEnabled = manager.isEnabled
    addTeardownBlock { @MainActor in
      manager.setPullRequestsShortcut(config)
      manager.setShortcutEnabled(enabled, for: .pullRequests)
      masterEnabled ? manager.enable() : manager.disable()
    }
  }

  func testCustomBindingPersistsAndCanBeCleared() throws {
    let manager = KeyboardShortcutManager.shared
    preserveSettings(manager)
    manager.disable()
    let config = ShortcutConfig(keyCode: UInt32(kVK_F18), modifiers: UInt32(controlKey | optionKey))
    manager.setPullRequestsShortcut(config)
    XCTAssertEqual(manager.shortcut(for: .pullRequests), config)
    let data = try XCTUnwrap(UserDefaults.standard.data(forKey: "pullRequestsShortcut"))
    XCTAssertEqual(try JSONDecoder().decode(ShortcutConfig.self, from: data), config)
    manager.setPullRequestsShortcut(nil)
    XCTAssertNil(manager.shortcut(for: .pullRequests))
    XCTAssertTrue(UserDefaults.standard.stringArray(forKey: PreferencesKeys.clearedGlobalShortcuts)?.contains("pullRequests") == true)
  }

  func testConfigurationImportRecognizesPullRequestsAndDisablesBinding() {
    let manager = KeyboardShortcutManager.shared
    preserveSettings(manager)
    manager.disable()
    let result = CinderdeckConfigurationImporter.importTOML("""
    schema_version = 1
    [shortcuts.global.pull_requests]
    enabled = false
    key = "F18"
    modifiers = ["control", "option"]
    """, defaults: UserDefaultsFactory.make())
    XCTAssertFalse(result.hasErrors)
    XCTAssertFalse(manager.isShortcutEnabled(for: .pullRequests))
    XCTAssertEqual(manager.shortcut(for: .pullRequests), .init(keyCode: UInt32(kVK_F18), modifiers: UInt32(controlKey | optionKey)))
  }

  func testCarbonEventRoutesToPullRequestsAction() async throws {
    let manager = KeyboardShortcutManager.shared
    let originalDelegate = manager.delegate
    let received = expectation(description: "PR shortcut is dispatched")
    let delegate = PullRequestsShortcutDelegate {
      if case .openPullRequests = $0 { received.fulfill() }
      else { XCTFail("Wrong shortcut action") }
    }
    manager.delegate = delegate
    defer { manager.delegate = originalDelegate }
    var event: EventRef?
    XCTAssertEqual(CreateEvent(nil, OSType(kEventClassKeyboard), UInt32(kEventHotKeyPressed), 0, EventAttributes(kEventAttributeUserEvent), &event), noErr)
    let created = try XCTUnwrap(event)
    defer { ReleaseEvent(created) }
    var identifier = EventHotKeyID(signature: OSType(0x5A53_464D), id: 22)
    XCTAssertEqual(SetEventParameter(created, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), MemoryLayout<EventHotKeyID>.size, &identifier), noErr)
    XCTAssertEqual(SendEventToEventTarget(created, GetApplicationEventTarget()), noErr)
    await fulfillment(of: [received], timeout: 2)
  }

  func testDisabledAndClearedShortcutReleaseGlobalKey() throws {
    try skipIfRunningInCI("Carbon hotkey registration requires a desktop session")
    let manager = KeyboardShortcutManager.shared
    preserveSettings(manager)
    let config = ShortcutConfig(keyCode: UInt32(kVK_F18), modifiers: UInt32(controlKey | optionKey | cmdKey | shiftKey))
    func probe() -> OSStatus {
      var ref: EventHotKeyRef?
      let status = RegisterEventHotKey(config.keyCode, config.modifiers, EventHotKeyID(signature: OSType(0x5052_5453), id: 1), GetApplicationEventTarget(), 0, &ref)
      if let ref { UnregisterEventHotKey(ref) }
      return status
    }
    guard probe() == noErr else { throw XCTSkip("Probe shortcut is already in use") }
    manager.setPullRequestsShortcut(config)
    manager.setShortcutEnabled(true, for: .pullRequests)
    manager.enable()
    XCTAssertEqual(probe(), OSStatus(-9878))
    manager.setShortcutEnabled(false, for: .pullRequests)
    XCTAssertEqual(probe(), noErr)
    manager.setShortcutEnabled(true, for: .pullRequests)
    XCTAssertEqual(probe(), OSStatus(-9878))
    manager.setPullRequestsShortcut(nil)
    XCTAssertEqual(probe(), noErr)
  }
}

@MainActor
private final class PullRequestsShortcutDelegate: KeyboardShortcutDelegate {
  let action: (ShortcutAction) -> Void
  init(action: @escaping (ShortcutAction) -> Void) { self.action = action }
  func shortcutTriggered(_ action: ShortcutAction) { self.action(action) }
}
