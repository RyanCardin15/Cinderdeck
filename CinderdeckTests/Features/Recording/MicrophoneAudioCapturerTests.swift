//
//  MicrophoneAudioCapturerTests.swift
//  CinderdeckTests
//
//  Tests for MicrophoneAudioCapturer initialization and lifecycle.
//

import AVFoundation
import XCTest
@testable import Cinderdeck

@MainActor
final class MicrophoneAudioCapturerTests: XCTestCase {

  private var mockDelegate: MockMicrophoneAudioCapturerDelegate!

  override func setUp() {
    super.setUp()
    mockDelegate = MockMicrophoneAudioCapturerDelegate()
  }

  override func tearDown() {
    mockDelegate = nil
    super.tearDown()
  }

  func testMicrophoneAudioCapturerInitialization() {
    let capturer = MicrophoneAudioCapturer()
    XCTAssertNotNil(capturer)
    XCTAssertFalse(capturer.running)
  }

  func testMicrophoneAudioCapturerStartStop() {
    let factory = MockMicrophoneCaptureSessionFactory()
    let capturer = MicrophoneAudioCapturer(captureSessionFactory: factory)

    capturer.start()
    XCTAssertTrue(capturer.running)
    XCTAssertEqual(factory.session.startCallCount, 1)
    XCTAssertEqual(factory.configureInputCallCount, 1)
    XCTAssertEqual(factory.configureOutputCallCount, 1)

    capturer.stop()
    XCTAssertFalse(capturer.running)
    XCTAssertEqual(factory.session.stopCallCount, 1)
  }

  func testMicrophoneAudioCapturerPassesPreferredDeviceID() {
    let factory = MockMicrophoneCaptureSessionFactory()
    let capturer = MicrophoneAudioCapturer(
      preferredDeviceID: "external-mic-id",
      captureSessionFactory: factory
    )

    capturer.start()

    XCTAssertTrue(capturer.running)
    XCTAssertEqual(factory.preferredDeviceIDs, ["external-mic-id"])
    XCTAssertEqual(factory.configureInputCallCount, 1)
  }

  func testMicrophoneAudioCapturerDoesNotStartWhenPermissionUnavailable() {
    let factory = MockMicrophoneCaptureSessionFactory(authorizationStatus: .notDetermined)
    let capturer = MicrophoneAudioCapturer(captureSessionFactory: factory)

    capturer.start()

    XCTAssertFalse(capturer.running)
    XCTAssertEqual(factory.session.startCallCount, 0)
    XCTAssertEqual(factory.configureInputCallCount, 0)
    XCTAssertEqual(factory.configureOutputCallCount, 0)
  }

  func testMicrophoneAudioCapturerStartStopRealMicrophoneIntegration() throws {
    try XCTSkipUnless(
      ProcessInfo.processInfo.environment["CINDERDECK_RUN_MICROPHONE_INTEGRATION"] == "1",
      "Real microphone integration is opt-in. Set CINDERDECK_RUN_MICROPHONE_INTEGRATION=1 to run."
    )
    try XCTSkipUnless(
      AVCaptureDevice.authorizationStatus(for: .audio) == .authorized,
      "Microphone permission must be granted before running real integration."
    )
    try XCTSkipUnless(
      AVCaptureDevice.default(for: .audio) != nil,
      "Default audio device is required for real microphone integration."
    )

    let capturer = MicrophoneAudioCapturer()

    capturer.start()
    let expectation = self.expectation(description: "Real microphone start")
    DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) {
      expectation.fulfill()
    }
    wait(for: [expectation], timeout: 1.0)

    capturer.stop()
    let stopExpectation = self.expectation(description: "Real microphone stop")
    DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) {
      stopExpectation.fulfill()
    }
    wait(for: [stopExpectation], timeout: 1.0)

    XCTAssertFalse(capturer.running)
  }

  func testMicrophoneAudioCapturerDelegate() {
    let capturer = MicrophoneAudioCapturer()
    capturer.delegate = mockDelegate

    XCTAssertTrue(capturer.delegate === mockDelegate)
  }

  func testMicrophonePermissionStatusCanBeChecked() {
    // Verify we can query the authorization status without crashing
    let status = AVCaptureDevice.authorizationStatus(for: .audio)
    XCTAssertTrue([
      .notDetermined,
      .restricted,
      .denied,
      .authorized
    ].contains(status))
  }
}

// MARK: - Mock Delegate

private nonisolated final class MockMicrophoneAudioCapturerDelegate: MicrophoneAudioCapturerDelegate, @unchecked Sendable {
  var receivedSamples: [CMSampleBuffer] = []

  func microphoneCapturer(_ capturer: MicrophoneAudioCapturer, didOutput sampleBuffer: CMSampleBuffer) {
    receivedSamples.append(sampleBuffer)
  }
}

private nonisolated final class MockMicrophoneCaptureSession: MicrophoneCaptureSession, @unchecked Sendable {
  private(set) var inputAddCallCount = 0
  private(set) var outputAddCallCount = 0
  private(set) var startCallCount = 0
  private(set) var stopCallCount = 0

  func canAddInput(_ input: AVCaptureInput) -> Bool {
    true
  }

  func addInput(_ input: AVCaptureInput) {
    inputAddCallCount += 1
  }

  func canAddOutput(_ output: AVCaptureOutput) -> Bool {
    true
  }

  func addOutput(_ output: AVCaptureOutput) {
    outputAddCallCount += 1
  }

  func startRunning() {
    startCallCount += 1
  }

  func stopRunning() {
    stopCallCount += 1
  }
}

private nonisolated final class MockMicrophoneCaptureSessionFactory: MicrophoneCaptureSessionFactory, @unchecked Sendable {
  let authorizationStatusValue: AVAuthorizationStatus
  let session = MockMicrophoneCaptureSession()
  private(set) var configureInputCallCount = 0
  private(set) var configureOutputCallCount = 0
  private(set) var preferredDeviceIDs: [String?] = []

  init(authorizationStatus: AVAuthorizationStatus = .authorized) {
    authorizationStatusValue = authorizationStatus
  }

  func authorizationStatus() -> AVAuthorizationStatus {
    authorizationStatusValue
  }

  func makeSession() -> MicrophoneCaptureSession {
    session
  }

  func configureInput(on session: MicrophoneCaptureSession, preferredDeviceID: String?) throws -> String {
    configureInputCallCount += 1
    preferredDeviceIDs.append(preferredDeviceID)
    return "Mock Microphone"
  }

  func configureOutput(
    on session: MicrophoneCaptureSession,
    delegate: AVCaptureAudioDataOutputSampleBufferDelegate,
    queue: DispatchQueue
  ) throws {
    configureOutputCallCount += 1
  }
}
