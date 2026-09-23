//
//  BackgroundCursorControlTests.swift
//  CinderdeckTests
//
//  Unit tests for BackgroundCursorControl.enableOnce: the CGS
//  SetsCursorInBackground grant is attempted at most once per instance and the
//  result is cached (a failed first attempt is not retried). The real dlsym seam
//  (liveSetEnabled) is intentionally untested — it touches the live WindowServer,
//  mirroring how CaptureEventTapDependencies.live stays untested.
//

@testable import Cinderdeck
import XCTest

final class BackgroundCursorControlTests: XCTestCase {
  /// Records how many times the injected grant closure was invoked and returns a
  /// fixed result. A class so the bound-method closure mutates shared state.
  private final class GrantRecorder {
    var count = 0
    let result: Bool

    init(result: Bool) { self.result = result }

    func setEnabled() -> Bool {
      count += 1
      return result
    }
  }

  func testEnableOnce_invokesInjectedClosureExactlyOnce_acrossRepeatedCalls() {
    let recorder = GrantRecorder(result: true)
    let control = BackgroundCursorControl(setEnabled: recorder.setEnabled)

    _ = control.enableOnce()
    _ = control.enableOnce()
    _ = control.enableOnce()

    XCTAssertEqual(recorder.count, 1, "the CGS grant must be attempted at most once per instance")
  }

  func testEnableOnce_returnsInjectedResult_true_andCaches() {
    let recorder = GrantRecorder(result: true)
    let control = BackgroundCursorControl(setEnabled: recorder.setEnabled)

    XCTAssertTrue(control.enableOnce())
    // Cached on subsequent calls without re-invoking the closure.
    XCTAssertTrue(control.enableOnce())
    XCTAssertEqual(recorder.count, 1)
  }

  func testEnableOnce_falseFirstResult_isReportedAndNotRetried() {
    let recorder = GrantRecorder(result: false)
    let control = BackgroundCursorControl(setEnabled: recorder.setEnabled)

    XCTAssertFalse(control.enableOnce(), "a failed first attempt is reported as false")
    XCTAssertFalse(
      control.enableOnce(),
      "and is not retried — the caller keeps the foreground-only baseline for the run"
    )
    XCTAssertEqual(recorder.count, 1, "no retry after a false first result")
  }
}
