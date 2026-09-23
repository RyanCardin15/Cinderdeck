//
//  VideoEditorSpeedTimeMapTests.swift
//  CinderdeckTests
//
//  Unit tests for SpeedSegment clamping + SpeedTimeMap original↔scaled time math.
//

import CoreMedia
import XCTest
@testable import Cinderdeck

final class VideoEditorSpeedTimeMapTests: XCTestCase {

  private let eps = 0.0005

  // MARK: - SpeedSegment

  func testSpeedSegment_clampsRateToSupportedRange() {
    XCTAssertEqual(SpeedSegment(startTime: 0, rate: 100).rate, SpeedSegment.maxRate, accuracy: eps)
    XCTAssertEqual(SpeedSegment(startTime: 0, rate: 0.01).rate, SpeedSegment.minRate, accuracy: eps)
    XCTAssertEqual(SpeedSegment(startTime: 0, rate: 2).rate, 2.0, accuracy: eps)
  }

  func testSpeedSegment_clampsStartAndMinDuration() {
    let seg = SpeedSegment(startTime: -5, duration: 0.01, rate: 2)
    XCTAssertEqual(seg.startTime, 0, accuracy: eps)
    XCTAssertEqual(seg.duration, SpeedSegment.minDuration, accuracy: eps)
  }

  func testSpeedSegment_overlapDetection() {
    let a = SpeedSegment(startTime: 0, duration: 4, rate: 2)
    let b = SpeedSegment(startTime: 3, duration: 4, rate: 2)
    let c = SpeedSegment(startTime: 4, duration: 2, rate: 2)
    XCTAssertTrue(a.overlaps(with: b))
    XCTAssertFalse(a.overlaps(with: c)) // touching edges do not overlap
  }

  func testSpeedSegment_formattedRate() {
    XCTAssertEqual(SpeedSegment(startTime: 0, rate: 2).formattedRate, "2x")
    XCTAssertEqual(SpeedSegment(startTime: 0, rate: 0.5).formattedRate, "0.5x")
  }

  // MARK: - SpeedTimeMap identity

  func testIdentityMap_whenNoSegments() {
    let map = SpeedTimeMap(speedSegments: [], trimStart: 0, trimEnd: 10)
    XCTAssertTrue(map.isIdentity)
    XCTAssertEqual(map.scaledDuration, 10, accuracy: eps)
    XCTAssertEqual(map.originalDuration, 10, accuracy: eps)
    for t in stride(from: 0.0, through: 10.0, by: 1.0) {
      XCTAssertEqual(map.toScaled(t), t, accuracy: eps)
      XCTAssertEqual(map.toOriginal(t), t, accuracy: eps)
    }
  }

  func testIdentityMap_whenOnly1xSegment() {
    let seg = SpeedSegment(startTime: 2, duration: 3, rate: 1.0)
    let map = SpeedTimeMap(speedSegments: [seg], trimStart: 0, trimEnd: 10)
    XCTAssertTrue(map.isIdentity)
    XCTAssertEqual(map.scaledDuration, 10, accuracy: eps)
  }

  func testIdentityMap_ignoresDisabledSegment() {
    let seg = SpeedSegment(startTime: 2, duration: 3, rate: 4, isEnabled: false)
    let map = SpeedTimeMap(speedSegments: [seg], trimStart: 0, trimEnd: 10)
    XCTAssertTrue(map.isIdentity)
    XCTAssertEqual(map.scaledDuration, 10, accuracy: eps)
  }

  // MARK: - Single segment

  func testSingle2xSegment_halvesSpanAndShortensTotal() {
    // [0,10] trim; 2x over [2,6] (4s → 2s). Total = 8s.
    let seg = SpeedSegment(startTime: 2, duration: 4, rate: 2)
    let map = SpeedTimeMap(speedSegments: [seg], trimStart: 0, trimEnd: 10)
    XCTAssertEqual(map.scaledDuration, 8, accuracy: eps)

    XCTAssertEqual(map.toScaled(0), 0, accuracy: eps)    // before region
    XCTAssertEqual(map.toScaled(2), 2, accuracy: eps)    // region start unchanged
    XCTAssertEqual(map.toScaled(4), 3, accuracy: eps)    // midpoint of region: 2 + 2/2
    XCTAssertEqual(map.toScaled(6), 4, accuracy: eps)    // region end: 2 + 4/2
    XCTAssertEqual(map.toScaled(10), 8, accuracy: eps)   // after region: 4 + 4
  }

  func testSingle05xSegment_doublesSpanAndLengthensTotal() {
    // [0,10] trim; 0.5x over [2,6] (4s → 8s). Total = 14s.
    let seg = SpeedSegment(startTime: 2, duration: 4, rate: 0.5)
    let map = SpeedTimeMap(speedSegments: [seg], trimStart: 0, trimEnd: 10)
    XCTAssertEqual(map.scaledDuration, 14, accuracy: eps)
    XCTAssertEqual(map.toScaled(2), 2, accuracy: eps)
    XCTAssertEqual(map.toScaled(6), 10, accuracy: eps)   // 2 + 4/0.5
    XCTAssertEqual(map.toScaled(10), 14, accuracy: eps)
  }

  // MARK: - Multi-segment non-uniform

  func testMultiSegment_nonUniformWithGap() {
    // trim [0,12]; 4x over [0,4] (→1s), 1x gap [4,8] (→4s), 0.5x over [8,12] (→8s).
    // total = 1 + 4 + 8 = 13s.
    let segs = [
      SpeedSegment(startTime: 0, duration: 4, rate: 4),
      SpeedSegment(startTime: 8, duration: 4, rate: 0.5),
    ]
    let map = SpeedTimeMap(speedSegments: segs, trimStart: 0, trimEnd: 12)
    XCTAssertEqual(map.scaledDuration, 13, accuracy: eps)
    XCTAssertEqual(map.toScaled(4), 1, accuracy: eps)    // end of 4x region
    XCTAssertEqual(map.toScaled(8), 5, accuracy: eps)    // end of 1x gap: 1 + 4
    XCTAssertEqual(map.toScaled(12), 13, accuracy: eps)  // end: 5 + 8
  }

  func testSpansTileWholeTimelineContiguously() {
    let segs = [
      SpeedSegment(startTime: 1, duration: 2, rate: 2),
      SpeedSegment(startTime: 6, duration: 2, rate: 0.5),
    ]
    let map = SpeedTimeMap(speedSegments: segs, trimStart: 0, trimEnd: 10)
    // Contiguous: each span starts where the previous ends; covers [0,10].
    XCTAssertEqual(map.spans.first?.origStart ?? -1, 0, accuracy: eps)
    var cursor = 0.0
    for span in map.spans {
      XCTAssertEqual(span.origStart, cursor, accuracy: eps)
      cursor = span.origEnd
    }
    XCTAssertEqual(cursor, 10, accuracy: eps)
  }

  // MARK: - Inverse round-trips

  func testInverseOfForward_isIdentity() {
    let segs = [
      SpeedSegment(startTime: 1, duration: 3, rate: 4),
      SpeedSegment(startTime: 7, duration: 2, rate: 0.25),
    ]
    let map = SpeedTimeMap(speedSegments: segs, trimStart: 0, trimEnd: 10)
    for t in stride(from: 0.0, through: 10.0, by: 0.37) {
      let round = map.toOriginal(map.toScaled(t))
      XCTAssertEqual(round, t, accuracy: 0.01)
    }
  }

  func testForwardOfInverse_isIdentity() {
    let segs = [SpeedSegment(startTime: 2, duration: 4, rate: 8)]
    let map = SpeedTimeMap(speedSegments: segs, trimStart: 0, trimEnd: 10)
    for s in stride(from: 0.0, through: map.scaledDuration, by: 0.21) {
      let round = map.toScaled(map.toOriginal(s))
      XCTAssertEqual(round, s, accuracy: 0.01)
    }
  }

  // MARK: - rate(atOriginal:)

  func testRateAtOriginal() {
    let segs = [
      SpeedSegment(startTime: 2, duration: 2, rate: 4),
      SpeedSegment(startTime: 6, duration: 2, rate: 0.5),
    ]
    let map = SpeedTimeMap(speedSegments: segs, trimStart: 0, trimEnd: 10)
    XCTAssertEqual(map.rate(atOriginal: 0), 1.0, accuracy: eps)
    XCTAssertEqual(map.rate(atOriginal: 3), 4.0, accuracy: eps)
    XCTAssertEqual(map.rate(atOriginal: 6.5), 0.5, accuracy: eps)
    XCTAssertEqual(map.rate(atOriginal: 9), 1.0, accuracy: eps)
  }

  // MARK: - Trim window clipping & offset

  func testTrimRelative_offsetAndClipping() {
    // trim [5,15] → originalDuration 10; segment absolute [7,11] → trim-relative [2,6].
    let seg = SpeedSegment(startTime: 7, duration: 4, rate: 2)
    let map = SpeedTimeMap(speedSegments: seg.isEnabled ? [seg] : [], trimStart: 5, trimEnd: 15)
    XCTAssertEqual(map.originalDuration, 10, accuracy: eps)
    XCTAssertEqual(map.scaledDuration, 8, accuracy: eps) // same as the [2,6] 2x case
    XCTAssertEqual(map.toScaled(2), 2, accuracy: eps)
    XCTAssertEqual(map.toScaled(6), 4, accuracy: eps)
  }

  func testSegmentExtendingPastTrim_isClippedToWindow() {
    // trim [0,8]; segment [6,16] (rate 2) clipped to [6,8] → 2s region scaled to 1s. Total 7s.
    let seg = SpeedSegment(startTime: 6, duration: 10, rate: 2)
    let map = SpeedTimeMap(speedSegments: [seg], trimStart: 0, trimEnd: 8)
    XCTAssertEqual(map.scaledDuration, 7, accuracy: eps) // [0,6]=6s + [6,8]2x=1s
  }

  func testScaledCMDuration_matchesScaledSeconds() {
    let seg = SpeedSegment(startTime: 0, duration: 4, rate: 2)
    let map = SpeedTimeMap(speedSegments: [seg], trimStart: 0, trimEnd: 8)
    XCTAssertEqual(CMTimeGetSeconds(map.scaledCMDuration()), map.scaledDuration, accuracy: 0.01)
  }
}
