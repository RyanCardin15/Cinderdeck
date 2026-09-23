//
//  SmartElementQueryServiceTests.swift
//  CinderdeckTests
//
//  Unit tests for the public service surface: permission gate, dedup,
//  cancel, and the Combine debounce. Tests use FakeAXSnapshotProvider so
//  they never hit the real Accessibility API.
//

import AppKit
import Combine
import XCTest
@testable import Cinderdeck

final class SmartElementQueryServiceTests: XCTestCase {

  private var cancellables = Set<AnyCancellable>()

  override func tearDown() {
    cancellables.removeAll()
    super.tearDown()
  }

  // MARK: - Permission gate

  func testQueryElement_permissionDenied_emitsNil_logsOnce() {
    let service = SmartElementQueryService(
      snapshotProvider: FakeAXSnapshotProvider(snapshotForCall: [nil]),
      permissionChecker: { false }
    )
    var received: [CGRect?] = []
    service.elementDetectedPublisher.sink { received.append($0) }.store(in: &cancellables)

    service.queryElement(at: .zero, pid: nil)
    service.queryElement(at: CGPoint(x: 10, y: 10), pid: nil)
    service.queryElement(at: CGPoint(x: 20, y: 20), pid: nil)

    XCTAssertEqual(received.count, 1, "Subsequent nil emissions are deduped.")
    XCTAssertNil(received.first ?? .zero)
    XCTAssertEqual(service.permissionDeniedLogCount, 1, "Warning must be logged exactly once.")
  }

  // MARK: - Dedup

  func testQueryElement_dedupesIdenticalRect() throws {
    guard NSScreen.screens.first != nil else {
      throw XCTSkip("Needs at least one NSScreen.")
    }
    let button = AXElementSnapshot(
      role: "AXButton",
      position: CGPoint(x: 50, y: 50),
      size: CGSize(width: 40, height: 20)
    )
    let service = SmartElementQueryService(
      snapshotProvider: FakeAXSnapshotProvider(snapshotForCall: [button, button]),
      permissionChecker: { true }
    )
    var received: [CGRect?] = []
    service.elementDetectedPublisher.sink { received.append($0) }.store(in: &cancellables)

    service.queryElement(at: .zero, pid: 1)
    service.queryElement(at: .zero, pid: 1)

    XCTAssertEqual(received.count, 1, "Identical rect must emit only once.")
  }

  // MARK: - Cancel

  func testCancelPendingQueries_emitsNil_andResetsDedup() throws {
    guard NSScreen.screens.first != nil else {
      throw XCTSkip("Needs at least one NSScreen.")
    }
    let button = AXElementSnapshot(
      role: "AXButton",
      position: CGPoint(x: 50, y: 50),
      size: CGSize(width: 40, height: 20)
    )
    let service = SmartElementQueryService(
      snapshotProvider: FakeAXSnapshotProvider(snapshotForCall: [button, button]),
      permissionChecker: { true }
    )
    var received: [CGRect?] = []
    service.elementDetectedPublisher.sink { received.append($0) }.store(in: &cancellables)

    service.queryElement(at: .zero, pid: 1)
    service.cancelPendingQueries()
    service.queryElement(at: .zero, pid: 1)

    XCTAssertEqual(received.count, 3, "Expected: rect, nil (cancel), rect again (dedup reset).")
    XCTAssertNotNil(received[0])
    XCTAssertNil(received[1])
    XCTAssertNotNil(received[2])
  }

  // MARK: - Debounce

  func testDebounce_collapsesRapidUpdatesIntoOneQuery() throws {
    guard NSScreen.screens.first != nil else {
      throw XCTSkip("Needs at least one NSScreen.")
    }
    let provider = CountingAXSnapshotProvider(
      snapshot: AXElementSnapshot(
        role: "AXButton",
        position: CGPoint(x: 10, y: 10),
        size: CGSize(width: 30, height: 30)
      )
    )
    let service = SmartElementQueryService(
      snapshotProvider: provider,
      permissionChecker: { true },
      debounceMilliseconds: 25
    )

    let expectation = expectation(description: "Debounced emission")
    var received: [CGRect?] = []
    service.elementDetectedPublisher
      .sink { rect in
        received.append(rect)
        expectation.fulfill()
      }
      .store(in: &cancellables)

    for offset in 0..<5 {
      service.pushInputForTesting(
        point: CGPoint(x: 100 + Double(offset), y: 100),
        pid: 1
      )
    }

    wait(for: [expectation], timeout: 0.5)
    XCTAssertEqual(received.count, 1, "Debounce must collapse rapid inputs to one.")
    XCTAssertEqual(provider.callCount, 1, "Underlying AX query fires once after debounce window.")
  }
}
