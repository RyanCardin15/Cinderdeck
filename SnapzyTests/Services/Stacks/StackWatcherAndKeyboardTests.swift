import AppKit
import Foundation
import XCTest
@testable import Snapzy

private actor StackWatcherCounter {
  var count = 0
  func increment() { count += 1 }
  func value() -> Int { count }
}

final class StackDefinitionWatcherTests: XCTestCase {
  func testInPlaceAndAtomicSavesReload() async throws {
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let file = root.appendingPathComponent("any-project.toml")
    try "[services.app]\ncmd = \"one\"".write(to: file, atomically: true, encoding: .utf8)
    let counter = StackWatcherCounter()
    let watcher = StackDefinitionWatcher(directory: root) { Task { await counter.increment() } }
    try await Task.sleep(nanoseconds: 150_000_000)
    try "[services.app]\ncmd = \"two\"".write(to: file, atomically: false, encoding: .utf8)
    try await Task.sleep(nanoseconds: 800_000_000)
    let first = await counter.value()
    XCTAssertGreaterThan(first, 0)
    try "[services.app]\ncmd = \"three\"".write(to: file, atomically: true, encoding: .utf8)
    try await Task.sleep(nanoseconds: 800_000_000)
    let second = await counter.value()
    XCTAssertGreaterThan(second, first)
    let loaded = try StackDefinitionLoader.loadDirectory(root)
    XCTAssertEqual(loaded.first?.definition?.service("app")?.command, "three")
    watcher.stop()
  }
}

@MainActor
final class StackKeyboardTests: XCTestCase {
  private var original: HistorySection!
  override func setUp() { original = HistoryFloatingManager.shared.selectedSection; HistoryFloatingManager.shared.selectedSection = .stacks }
  override func tearDown() { HistoryFloatingManager.shared.selectedSection = original; HistoryFloatingManager.shared.isPresentingAuxiliaryUI = false }
  func testDeleteDoesNotEmitCaptureDeletion() {
    let expectation = expectation(forNotification: .historyDeleteSelection, object: nil)
    expectation.isInverted = true
    panel().keyDown(with: event(51))
    wait(for: [expectation], timeout: 0.05)
  }
  func testReturnAndRestartRouteToStacks() {
    let panel = panel()
    let toggle = expectation(forNotification: .stacksCommand, object: panel) { $0.userInfo?["command"] as? String == "toggle" }
    panel.keyDown(with: event(36))
    wait(for: [toggle], timeout: 0.1)
    let restart = expectation(forNotification: .stacksCommand, object: panel) { $0.userInfo?["command"] as? String == "restartService" }
    XCTAssertTrue(panel.performKeyEquivalent(with: event(15, flags: [.command, .shift])))
    wait(for: [restart], timeout: 0.1)
  }
  func testArrowNotificationIncludesSection() {
    let panel = panel()
    let moved = expectation(forNotification: .historyMoveSelection, object: panel) {
      $0.userInfo?["section"] as? String == "stacks" && $0.userInfo?["delta"] as? Int == 1
    }
    panel.keyDown(with: event(124))
    wait(for: [moved], timeout: 0.1)
  }
  func testAuxiliaryUIBlocksStackCommands() {
    HistoryFloatingManager.shared.isPresentingAuxiliaryUI = true
    let restarted = expectation(forNotification: .stacksCommand, object: nil)
    restarted.isInverted = true
    _ = panel().performKeyEquivalent(with: event(15, flags: .command))
    wait(for: [restarted], timeout: 0.05)
  }
  func testReadOnlyLogsAllowPinShortcutButEditableFieldsDoNot() {
    let manager = HistoryFloatingManager.shared
    let wasPinned = manager.isPinned
    defer { if manager.isPinned != wasPinned { manager.togglePin() } }
    let panel = panel()
    let text = NSTextView(frame: NSRect(x: 0, y: 0, width: 100, height: 100))
    panel.contentView?.addSubview(text)
    text.isEditable = false
    XCTAssertTrue(panel.makeFirstResponder(text))
    XCTAssertTrue(panel.performKeyEquivalent(with: event(35, flags: .command)))
    XCTAssertEqual(manager.isPinned, !wasPinned)
    text.isEditable = true
    _ = panel.performKeyEquivalent(with: event(35, flags: .command))
    XCTAssertEqual(manager.isPinned, !wasPinned)
  }
  private func panel() -> HistoryFloatingPanel { HistoryFloatingPanel(contentRect: NSRect(x: 0, y: 0, width: 920, height: 316)) }
  private func event(_ code: UInt16, flags: NSEvent.ModifierFlags = []) -> NSEvent {
    NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: 0, windowNumber: 0, context: nil, characters: "", charactersIgnoringModifiers: "", isARepeat: false, keyCode: code)!
  }
}
