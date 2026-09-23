//
//  HistoryFloatingPinTests.swift
//  CinderdeckTests
//
//  Unit tests for History Floating Panel pin functionality (Issue #552).
//

import AppKit
import Carbon.HIToolbox
import XCTest
@testable import Cinderdeck

@MainActor
final class HistoryFloatingPinTests: XCTestCase {

  override func setUp() async throws {
    try await super.setUp()
    HistoryFloatingManager.shared.hide()
  }

  override func tearDown() async throws {
    HistoryFloatingManager.shared.hide()
    try await super.tearDown()
  }

  // MARK: - Manager Pin State

  func testInitialPinState_isFalse() {
    XCTAssertFalse(HistoryFloatingManager.shared.isPinned)
  }

  func testTogglePin_togglesState() {
    let manager = HistoryFloatingManager.shared
    XCTAssertFalse(manager.isPinned)

    manager.togglePin()
    XCTAssertTrue(manager.isPinned)

    manager.togglePin()
    XCTAssertFalse(manager.isPinned)
  }

  func testHide_resetsPinnedState() {
    let manager = HistoryFloatingManager.shared
    manager.togglePin()
    XCTAssertTrue(manager.isPinned)

    manager.hide()
    XCTAssertFalse(manager.isPinned)
  }

  // MARK: - Panel Window Level

  func testPanelWindowLevel_elevatesWhenPinned() {
    let panel = HistoryFloatingPanel(contentRect: NSRect(x: 0, y: 0, width: 200, height: 200))
    XCTAssertEqual(panel.level, .floating)

    panel.updateWindowLevel(isPinned: true)
    let expectedPinnedLevel = NSWindow.Level(rawValue: NSWindow.Level.floating.rawValue + 2)
    XCTAssertEqual(panel.level, expectedPinnedLevel)

    // Higher than AnnotateWindow.activeEditorLevel (.floating + 1)
    let annotateActiveLevel = NSWindow.Level(rawValue: NSWindow.Level.floating.rawValue + 1)
    XCTAssertGreaterThan(panel.level.rawValue, annotateActiveLevel.rawValue)

    panel.updateWindowLevel(isPinned: false)
    XCTAssertEqual(panel.level, .floating)
  }

  // MARK: - Shortcut Handling (⌘P)

  func testCmdPTogglesPin() {
    let manager = HistoryFloatingManager.shared
    let panel = HistoryFloatingPanel(contentRect: NSRect(x: 0, y: 0, width: 200, height: 200))

    XCTAssertFalse(manager.isPinned)

    let event = NSEvent.keyEvent(
      with: .keyDown,
      location: .zero,
      modifierFlags: .command,
      timestamp: 0,
      windowNumber: 0,
      context: nil,
      characters: "p",
      charactersIgnoringModifiers: "p",
      isARepeat: false,
      keyCode: 35
    )

    guard let event else {
      XCTFail("Failed to create Cmd+P event")
      return
    }

    let handled = panel.performKeyEquivalent(with: event)
    XCTAssertTrue(handled)
    XCTAssertTrue(manager.isPinned)

    let handledSecond = panel.performKeyEquivalent(with: event)
    XCTAssertTrue(handledSecond)
    XCTAssertFalse(manager.isPinned)
  }

  func testCmdP_ignoredWhenTextInputActive() {
    let manager = HistoryFloatingManager.shared
    let panel = HistoryFloatingPanel(contentRect: NSRect(x: 0, y: 0, width: 200, height: 200))

    let textView = NSTextView(frame: NSRect(x: 0, y: 0, width: 50, height: 50))
    panel.contentView?.addSubview(textView)
    let madeFirstResponder = panel.makeFirstResponder(textView)
    XCTAssertTrue(madeFirstResponder)

    XCTAssertFalse(manager.isPinned)

    let event = NSEvent.keyEvent(
      with: .keyDown,
      location: .zero,
      modifierFlags: .command,
      timestamp: 0,
      windowNumber: 0,
      context: nil,
      characters: "p",
      charactersIgnoringModifiers: "p",
      isARepeat: false,
      keyCode: 35
    )

    guard let event else {
      XCTFail("Failed to create Cmd+P event")
      return
    }

    let handled = panel.performKeyEquivalent(with: event)
    XCTAssertFalse(handled)
    XCTAssertFalse(manager.isPinned)
  }

  // MARK: - Localization

  func testPinLocalizationKeys_existAndAreNonEmpty() {
    let pinTitle = L10n.PreferencesHistory.pinPanel
    let unpinTitle = L10n.PreferencesHistory.unpinPanel

    XCTAssertFalse(pinTitle.isEmpty)
    XCTAssertFalse(unpinTitle.isEmpty)
    XCTAssertTrue(pinTitle.contains("⌘P"))
    XCTAssertTrue(unpinTitle.contains("⌘P"))
  }
}
