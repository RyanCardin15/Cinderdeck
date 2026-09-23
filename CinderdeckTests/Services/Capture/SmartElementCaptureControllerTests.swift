//
//  SmartElementCaptureControllerTests.swift
//  CinderdeckTests
//
//  Unit tests for the standalone Smart Element overlay controller.
//

import XCTest
import Combine
@testable import Cinderdeck

@MainActor
final class SmartElementCaptureControllerTests: XCTestCase {
  func testStartCapture_axDenied_doesNotShowOverlay() {
    let provider = FakeSmartElementQueryProvider()
    provider.permissionGranted = false
    let controller = SmartElementCaptureController(
      snapshotProvider: provider,
      ownerResolver: FakeWindowOwnerResolver(),
      capturePerformer: FakeSmartElementCapturePerformer(),
      windowFactory: { _ in
        XCTFail("Window factory should not be called when AX permission is denied")
        return FakeSmartElementOverlayWindow(displayID: nil, frame: .zero)
      }
    )

    controller.startCapture()
    controller.cancel()
  }

  func testHighlightForwarded_onPublisherEmit() throws {
    let screen = try XCTUnwrap(NSScreen.screens.first)
    let (controller, provider, _, _, windowBox) = makeController()
    defer { controller.cancel() }

    controller.startCapture()
    let rect = CGRect(x: screen.frame.minX + 10, y: screen.frame.minY + 10, width: 80, height: 60)
    provider.subject.send(rect)

    RunLoop.main.run(until: Date().addingTimeInterval(0.05))
    XCTAssertTrue(windowBox.windows.contains { $0.highlightedRects.contains(rect) })
  }

  func testMouseDownInsideRect_callsCapturePerformer() async throws {
    let screen = try XCTUnwrap(NSScreen.screens.first)
    let (controller, _, _, performer, windowBox) = makeController()
    defer { controller.cancel() }

    controller.startCapture()
    let window = try XCTUnwrap(windowBox.windows.first)
    let rect = CGRect(x: screen.frame.minX + 20, y: screen.frame.minY + 20, width: 90, height: 70)
    window.updateHighlight(rect)

    controller.smartElementOverlayWindow(window, mouseDownAt: CGPoint(x: rect.midX, y: rect.midY))
    await Task.yield()
    await Task.yield()

    XCTAssertEqual(performer.capturedRects, [rect])
  }

  func testMouseDownOutsideRect_cancelsWithoutCapture() async throws {
    let screen = try XCTUnwrap(NSScreen.screens.first)
    let (controller, provider, _, performer, windowBox) = makeController()
    defer { controller.cancel() }

    controller.startCapture()
    let window = try XCTUnwrap(windowBox.windows.first)
    let rect = CGRect(x: screen.frame.minX + 20, y: screen.frame.minY + 20, width: 90, height: 70)
    window.updateHighlight(rect)

    controller.smartElementOverlayWindow(window, mouseDownAt: CGPoint(x: rect.maxX + 20, y: rect.maxY + 20))
    await Task.yield()

    XCTAssertEqual(provider.cancelCount, 1)
    XCTAssertTrue(performer.capturedRects.isEmpty)
  }

  func testEscape_cancelsWithoutCapture() async throws {
    let (controller, provider, _, performer, windowBox) = makeController()
    defer { controller.cancel() }

    controller.startCapture()
    let window = try XCTUnwrap(windowBox.windows.first)

    controller.smartElementOverlayWindowDidCancel(window)
    await Task.yield()

    XCTAssertEqual(provider.cancelCount, 1)
    XCTAssertTrue(performer.capturedRects.isEmpty)
  }

  func testPidPushedOnMouseMoved() throws {
    let owner = SmartElementWindowOwner(pid: 1234, windowID: 55, bundleIdentifier: "com.example.app")
    let resolver = FakeWindowOwnerResolver()
    resolver.owner = owner
    let (controller, provider, _, _, windowBox) = makeController(ownerResolver: resolver)
    defer { controller.cancel() }

    controller.startCapture()
    let window = try XCTUnwrap(windowBox.windows.first)
    let point = CGPoint(x: 42, y: 24)

    controller.smartElementOverlayWindow(window, mouseMovedAt: point)

    XCTAssertEqual(resolver.points, [point])
    XCTAssertEqual(provider.updatedPIDs.compactMap { $0 }, [owner.pid])
  }

  private func makeController(
    ownerResolver: FakeWindowOwnerResolver = FakeWindowOwnerResolver()
  ) -> (
    SmartElementCaptureController,
    FakeSmartElementQueryProvider,
    FakeWindowOwnerResolver,
    FakeSmartElementCapturePerformer,
    FakeSmartElementWindowBox
  ) {
    let provider = FakeSmartElementQueryProvider()
    let performer = FakeSmartElementCapturePerformer()
    let windowBox = FakeSmartElementWindowBox()
    let controller = SmartElementCaptureController(
      snapshotProvider: provider,
      ownerResolver: ownerResolver,
      capturePerformer: performer,
      windowFactory: { screen in
        let window = FakeSmartElementOverlayWindow(displayID: screen.displayID, frame: screen.frame)
        windowBox.windows.append(window)
        return window
      }
    )
    return (controller, provider, ownerResolver, performer, windowBox)
  }
}

@MainActor
private final class FakeSmartElementWindowBox {
  var windows: [FakeSmartElementOverlayWindow] = []
}
