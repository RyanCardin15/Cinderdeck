import AppKit
import XCTest
@testable import Cinderdeck

@MainActor
final class WorkspaceReproSelectionTests: XCTestCase {
  private let ids = (0..<5).map { _ in UUID() }

  func testShiftSelectsVisibleRangeFromLastPlainClick() {
    var selection = WorkspaceReproSelection()
    selection.selectOnly(ids[1])
    selection.select(ids[4], orderedIDs: ids, modifiers: [.shift])

    XCTAssertEqual(selection.ids, Set(ids[1...4]))
    XCTAssertEqual(selection.focusedID, ids[4])

    selection.select(ids[2], orderedIDs: ids, modifiers: [.shift])
    XCTAssertEqual(selection.ids, Set(ids[1...2]), "A new range replaces the previous range")
  }

  func testCommandAndControlToggleIndividualsAndCommandShiftAddsRange() {
    var selection = WorkspaceReproSelection()
    selection.selectOnly(ids[0])
    selection.select(ids[2], orderedIDs: ids, modifiers: [.command])
    XCTAssertEqual(selection.ids, [ids[0], ids[2]])

    selection.select(ids[4], orderedIDs: ids, modifiers: [.command, .shift])
    XCTAssertEqual(selection.ids, [ids[0], ids[2], ids[3], ids[4]])

    selection.select(ids[2], orderedIDs: ids, modifiers: [.control])
    XCTAssertEqual(selection.ids, [ids[0], ids[3], ids[4]])
    XCTAssertEqual(selection.focusedID, ids[0])
  }

  func testReconcileDropsHiddenOrDeletedItemsAndMovesFocus() {
    var selection = WorkspaceReproSelection()
    selection.selectOnly(ids[1])
    selection.select(ids[3], orderedIDs: ids, modifiers: [.command])

    selection.reconcile(visibleIDs: [ids[0], ids[1], ids[2]])
    XCTAssertEqual(selection.ids, [ids[1]])
    XCTAssertEqual(selection.focusedID, ids[1])

    selection.reconcile(visibleIDs: [ids[0], ids[2]])
    XCTAssertEqual(selection.ids, [ids[0]])
    XCTAssertEqual(selection.focusedID, ids[0])

    selection.reconcile(visibleIDs: [])
    XCTAssertTrue(selection.ids.isEmpty)
    XCTAssertNil(selection.focusedID)
  }
}
