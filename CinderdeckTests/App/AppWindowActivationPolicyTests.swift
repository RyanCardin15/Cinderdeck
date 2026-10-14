import AppKit
import XCTest
@testable import Cinderdeck

@MainActor
final class AppWindowActivationPolicyTests: XCTestCase {
  private final class Window: NSWindow {
    var fixtureVisible = true
    var fixtureKey = false
    var fixtureMinimized = false
    var fixtureSheet: NSWindow?
    override var isVisible: Bool { fixtureVisible }
    override var isKeyWindow: Bool { fixtureKey }
    override var isMiniaturized: Bool { fixtureMinimized }
    override var canBecomeKey: Bool { true }
    override var attachedSheet: NSWindow? { fixtureSheet }
  }

  private func window() -> Window {
    Window(contentRect: .zero, styleMask: [.titled], backing: .buffered, defer: true)
  }

  func testCoveredNativeWindowDoesNotSuppressMainWindowActivation() {
    let covered = window()
    XCTAssertTrue(AppWindowActivationPolicy.shouldActivateRuntime(
      keyWindow: nil, modalWindow: nil, windows: [covered]))
    XCTAssertTrue(AppWindowActivationPolicy.shouldActivateRuntime(
      keyWindow: covered, modalWindow: nil, windows: [covered]))
  }

  func testNativeEditorRetainsActualKeyboardFocus() {
    let editor = window(); editor.fixtureKey = true
    XCTAssertFalse(AppWindowActivationPolicy.shouldActivateRuntime(
      keyWindow: editor, modalWindow: nil, windows: [editor]))
  }

  func testHiddenOrMinimizedNativeWindowDoesNotSuppressActivation() {
    let editor = window(); editor.fixtureKey = true; editor.fixtureVisible = false
    XCTAssertTrue(AppWindowActivationPolicy.shouldActivateRuntime(
      keyWindow: editor, modalWindow: nil, windows: [editor]))
    editor.fixtureVisible = true; editor.fixtureMinimized = true
    XCTAssertTrue(AppWindowActivationPolicy.shouldActivateRuntime(
      keyWindow: editor, modalWindow: nil, windows: [editor]))
  }

  func testModalDialogKeepsFocusOnDockReopenAndAppActivation() {
    let dialog = window()
    XCTAssertTrue(AppWindowActivationPolicy.blockingWindow(
      modalWindow: dialog, windows: []) === dialog)
    XCTAssertFalse(AppWindowActivationPolicy.shouldActivateRuntime(
      keyWindow: nil, modalWindow: dialog, windows: []))
  }

  func testAttachedSheetProtectsItsParentFromFocusTransfer() {
    let parent = window(); parent.fixtureSheet = window()
    XCTAssertTrue(AppWindowActivationPolicy.blockingWindow(
      modalWindow: nil, windows: [parent]) === parent)
    XCTAssertFalse(AppWindowActivationPolicy.shouldActivateRuntime(
      keyWindow: nil, modalWindow: nil, windows: [parent]))
    parent.fixtureVisible = false
    XCTAssertTrue(AppWindowActivationPolicy.shouldActivateRuntime(
      keyWindow: nil, modalWindow: nil, windows: [parent]))
  }
}
