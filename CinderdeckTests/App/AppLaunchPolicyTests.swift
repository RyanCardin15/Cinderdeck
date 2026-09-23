//
//  AppLaunchPolicyTests.swift
//  CinderdeckTests
//
//  Unit tests for deciding whether the host app should start interactive UI.
//

import AppKit
import XCTest
@testable import Cinderdeck

@MainActor
final class AppLaunchPolicyTests: XCTestCase {
  func testShouldStartInteractiveApplication_underXCTestSkipsBeforeScreenAccess() {
    var didRequestScreenCount = false
    let policy = AppLaunchPolicy(
      environment: ["XCTestConfigurationFilePath": "/tmp/CinderdeckTests.xctestconfiguration"],
      screenCountProvider: {
        didRequestScreenCount = true
        return 1
      }
    )

    XCTAssertFalse(policy.shouldStartInteractiveApplication)
    XCTAssertFalse(didRequestScreenCount)
  }

  func testShouldStartInteractiveApplication_headlessDisplaySessionReturnsFalse() {
    let policy = AppLaunchPolicy(
      environment: [:],
      screenCountProvider: { 0 }
    )

    XCTAssertTrue(policy.isHeadlessDisplaySession)
    XCTAssertFalse(policy.shouldStartInteractiveApplication)
  }

  func testShouldStartInteractiveApplication_interactiveDisplaySessionReturnsTrue() {
    let policy = AppLaunchPolicy(
      environment: [:],
      screenCountProvider: { 1 }
    )

    XCTAssertFalse(policy.isRunningUnderXCTest)
    XCTAssertFalse(policy.isHeadlessDisplaySession)
    XCTAssertTrue(policy.shouldStartInteractiveApplication)
  }

  func testShouldStartInteractiveApplication_canOptInInteractiveXCTestHost() {
    let policy = AppLaunchPolicy(
      environment: [
        "XCTestConfigurationFilePath": "/tmp/CinderdeckTests.xctestconfiguration",
        "CINDERDECK_ALLOW_INTERACTIVE_XCTEST_HOST": "1",
      ],
      screenCountProvider: { 1 }
    )

    XCTAssertTrue(policy.shouldStartInteractiveApplication)
  }

  func testAppDelegate_skippedLaunchKeepsOpenFilesQueued() {
    let delegate = AppDelegate(
      launchPolicyProvider: {
        AppLaunchPolicy(environment: [:], screenCountProvider: { 0 })
      }
    )
    let fileURL = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString)
      .appendingPathExtension("png")

    delegate.applicationDidFinishLaunching(
      Notification(name: NSApplication.didFinishLaunchingNotification)
    )
    delegate.application(NSApplication.shared, open: [fileURL])

    XCTAssertFalse(delegate.didFinishLaunchingForTesting)
    XCTAssertFalse(delegate.hasCoordinatorForTesting)
    XCTAssertEqual(delegate.pendingOpenFileURLCountForTesting, 1)
  }
}
