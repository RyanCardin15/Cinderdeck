//
//  DiagnosticCoreTests.swift
//  CinderdeckTests
//
//  Unit tests for diagnostic log value formatting and parsing.
//

import XCTest
@testable import Cinderdeck

final class DiagnosticCoreTests: XCTestCase {

  func testDiagnosticLogEntryToLogLine_usesShortFileNameAndSortedContext() {
    let entry = DiagnosticLogEntry(
      level: .info,
      category: .capture,
      message: "Capture complete",
      context: ["z": "last", "a": "first"],
      file: "Cinderdeck/Services/Capture/ScreenCaptureManager.swift",
      function: "captureFullscreen()",
      line: 42,
      timestamp: Date(timeIntervalSince1970: 0)
    )

    let line = entry.toLogLine()

    XCTAssertTrue(line.contains("[INF][CAPTURE][ScreenCaptureManager.swift:42:captureFullscreen()] Capture complete"))
    XCTAssertTrue(line.contains(" {a=first, z=last}"))
    XCTAssertTrue(line.hasSuffix("\n"))
  }

  func testDiagnosticLogEntryParseTimestamp_supportsMillisecondsAndLegacySeconds() throws {
    let reference = try XCTUnwrap(Calendar.current.date(from: DateComponents(
      year: 2026,
      month: 5,
      day: 1,
      hour: 1,
      minute: 2,
      second: 3
    )))

    let modern = try XCTUnwrap(DiagnosticLogEntry.parseTimestamp(
      from: "[12:34:56.789][INF][SYSTEM] Started",
      referenceDate: reference
    ))
    let legacy = try XCTUnwrap(DiagnosticLogEntry.parseTimestamp(
      from: "[08:09:10][INF][SYSTEM] Started",
      referenceDate: reference
    ))

    let modernComponents = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: modern)
    XCTAssertEqual(modernComponents.year, 2026)
    XCTAssertEqual(modernComponents.month, 5)
    XCTAssertEqual(modernComponents.day, 1)
    XCTAssertEqual(modernComponents.hour, 12)
    XCTAssertEqual(modernComponents.minute, 34)
    XCTAssertEqual(modernComponents.second, 56)

    let legacyComponents = Calendar.current.dateComponents([.hour, .minute, .second], from: legacy)
    XCTAssertEqual(legacyComponents.hour, 8)
    XCTAssertEqual(legacyComponents.minute, 9)
    XCTAssertEqual(legacyComponents.second, 10)
  }

  func testDiagnosticLogEntryParseTimestamp_rejectsMalformedLines() {
    XCTAssertNil(DiagnosticLogEntry.parseTimestamp(from: "", referenceDate: Date()))
    XCTAssertNil(DiagnosticLogEntry.parseTimestamp(from: "12:34:56][INF]", referenceDate: Date()))
    XCTAssertNil(DiagnosticLogEntry.parseTimestamp(from: "[not-time][INF]", referenceDate: Date()))
  }
}
