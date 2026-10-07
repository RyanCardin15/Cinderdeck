//
//  CITestGate.swift
//  CinderdeckTests
//
//  Shared gate for interaction / nondeterministic tests. Tests that exercise
//  real UI surfaces (NSSavePanel, NSPasteboard, drag-to-app), async ML/OCR
//  pipelines, GPU rendering, or window lifecycle call `try skipIfRunningInCI()`
//  as their FIRST line so CI runs stay deterministic while the tests remain
//  runnable locally.
//
//  `xcodebuild test` does not forward the shell's `CI` environment variable to
//  the separate XCTest host process. For unattended local runs, explicitly
//  pass `-skip-testing:` identifiers or configure `CI=1` in the test host's
//  scheme environment. This gate documents intent at each call site.
//

import XCTest

extension XCTestCase {
  /// Skip the calling test when running under CI. Interaction / nondeterministic
  /// tests must call this as their first statement.
  func skipIfRunningInCI(
    _ message: String = "interaction/nondeterministic test skipped in CI",
    file: StaticString = #filePath,
    line: UInt = #line
  ) throws {
    let environment = ProcessInfo.processInfo.environment
    let isRunningInCI = environment["CI"] != nil
    try XCTSkipIf(isRunningInCI, message, file: file, line: line)
  }
}
