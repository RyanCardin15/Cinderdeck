//
//  AnnotateBackgroundRedactionTests.swift
//  CinderdeckTests
//
//  Characterization tests for region-based redaction and background cutout.
//  ALWAYS-RUN: applySensitiveRedactionRegions gap cases (empty no-op,
//  sub-minimum filtering, out-of-bounds clamping), toggleBackgroundCutout sync
//  guard path. CI-SKIP: applyBackgroundCutout (async Vision ML),
//  autoRedactSensitiveData (async OCR scan).
//
//  NOTE: basic multi-region redaction (2 regions -> 2 blur annotations, undo,
//  quick-properties defaults) is already covered in AnnotateCoreTests
//  (testApplySensitiveRedactions*). This file only fills the remaining gaps.
//

import AppKit
import CoreGraphics
import XCTest
@testable import Cinderdeck

@MainActor
final class AnnotateBackgroundRedactionTests: XCTestCase {
  private static var retainedAnnotateStates: [AnnotateState] = []

  private func makeAnnotateState() -> AnnotateState {
    let state = AnnotateState()
    Self.retainedAnnotateStates.append(state)
    return state
  }

  private func makeImage(width: Int, height: Int) throws -> NSImage {
    let cgImage = try XCTUnwrap(TestImageFactory.solidColor(width: width, height: height))
    return NSImage(cgImage: cgImage, size: NSSize(width: width, height: height))
  }

  // MARK: - applySensitiveRedactionRegions (gap cases) -> Int

  func testApplySensitiveRedactionRegionsWithEmptyArrayIsNoOp() throws {
    let state = makeAnnotateState()
    state.loadImage(try makeImage(width: 200, height: 100))

    let inserted = state.applySensitiveRedactionRegions([])

    XCTAssertEqual(inserted, 0)
    XCTAssertTrue(state.annotations.isEmpty)
    XCTAssertFalse(state.canUndo)
  }

  func testApplySensitiveRedactionRegionsDropsSubMinimumSizedRegions() throws {
    let state = makeAnnotateState()
    state.loadImage(try makeImage(width: 200, height: 100))

    // Width/height must be >= 2 after clamping; a 1x1 region is filtered out.
    let inserted = state.applySensitiveRedactionRegions([
      AnnotateSensitiveRedactionRegion(
        kind: .email,
        bounds: CGRect(x: 10, y: 10, width: 1, height: 1),
        confidence: 0.9
      )
    ])

    XCTAssertEqual(inserted, 0)
    XCTAssertTrue(state.annotations.isEmpty)
  }

  func testApplySensitiveRedactionRegionsClampsBoundsToSourceImage() throws {
    let state = makeAnnotateState()
    state.loadImage(try makeImage(width: 200, height: 100))

    // Region extends beyond the right/bottom edges; expect it clamped to the
    // source image bounds (still a single valid annotation).
    let inserted = state.applySensitiveRedactionRegions([
      AnnotateSensitiveRedactionRegion(
        kind: .creditCard,
        bounds: CGRect(x: 150, y: 60, width: 500, height: 500),
        confidence: 0.95
      )
    ])

    XCTAssertEqual(inserted, 1)
    let annotation = try XCTUnwrap(state.annotations.first)
    XCTAssertLessThanOrEqual(annotation.bounds.maxX, state.sourceImageBounds.maxX + 0.0001)
    XCTAssertLessThanOrEqual(annotation.bounds.maxY, state.sourceImageBounds.maxY + 0.0001)
    XCTAssertGreaterThanOrEqual(annotation.bounds.width, 2)
    XCTAssertGreaterThanOrEqual(annotation.bounds.height, 2)
  }

  func testApplySensitiveRedactionRegionsFullyOutsideImageIsNoOp() throws {
    let state = makeAnnotateState()
    state.loadImage(try makeImage(width: 200, height: 100))

    // Entirely outside the source image -> intersection empty -> filtered.
    let inserted = state.applySensitiveRedactionRegions([
      AnnotateSensitiveRedactionRegion(
        kind: .email,
        bounds: CGRect(x: 500, y: 500, width: 40, height: 20),
        confidence: 0.9
      )
    ])

    XCTAssertEqual(inserted, 0)
    XCTAssertTrue(state.annotations.isEmpty)
  }

  func testApplySensitiveRedactionRegionsSelectsInsertedAnnotationsAndSelectionTool() throws {
    let state = makeAnnotateState()
    state.loadImage(try makeImage(width: 300, height: 200))

    let inserted = state.applySensitiveRedactionRegions([
      AnnotateSensitiveRedactionRegion(
        kind: .email,
        bounds: CGRect(x: 10, y: 10, width: 60, height: 20),
        confidence: 0.9
      ),
      AnnotateSensitiveRedactionRegion(
        kind: .accessToken,
        bounds: CGRect(x: 120, y: 80, width: 80, height: 24),
        confidence: 0.9
      ),
      AnnotateSensitiveRedactionRegion(
        kind: .creditCard,
        bounds: CGRect(x: 40, y: 140, width: 150, height: 22),
        confidence: 0.98
      )
    ])

    XCTAssertEqual(inserted, 3)
    XCTAssertEqual(state.annotations.count, 3)
    XCTAssertEqual(state.selectedAnnotationIds.count, 3)
    XCTAssertEqual(state.selectedTool, .selection)
    for annotation in state.annotations {
      guard case .blur = annotation.type else {
        return XCTFail("Expected blur annotation for each redaction region")
      }
    }
  }

  // MARK: - toggleBackgroundCutout (sync guard path) ALWAYS-RUN

  // Characterization: toggleBackgroundCutout is NOT a plain boolean flip. When a
  // cutout is applied it resets synchronously; otherwise it calls
  // applyBackgroundCutout(), which bails synchronously (no async ML) when there
  // is no source image. Starting from the default state (isCutoutApplied == false)
  // with no image, toggling must leave the flags untouched and set an error.
  func testToggleBackgroundCutoutWithoutSourceImageDoesNotProcess() {
    let state = makeAnnotateState()
    XCTAssertFalse(state.isCutoutApplied)

    state.toggleBackgroundCutout()

    XCTAssertFalse(state.isCutoutApplied)
    XCTAssertFalse(state.isCutoutProcessing)
  }

  // MARK: - CI-SKIP: async Vision ML / OCR

  // applyBackgroundCutout spins up a Vision foreground-segmentation Task; result
  // timing and ML output are nondeterministic. Local-only: assert it kicks off
  // the processing flag on a supported OS without asserting the async result.
  func testApplyBackgroundCutoutStartsProcessingOnSupportedOS() throws {
    try skipIfRunningInCI("applyBackgroundCutout runs async Vision ML")
    let state = makeAnnotateState()
    state.loadImage(try makeImage(width: 64, height: 64))
    guard state.canUseBackgroundCutout else {
      throw XCTSkip("Background cutout unsupported on this OS")
    }

    state.applyBackgroundCutout()

    // Synchronous prelude sets the processing flag before the Task completes.
    XCTAssertTrue(state.isCutoutProcessing)
  }

  // autoRedactSensitiveData runs an async OCR scan whose PII detection depends on
  // the Vision model; CI-SKIP. Local-only smoke: kicks off scanning, no crash.
  func testAutoRedactSensitiveDataStartsScan() throws {
    try skipIfRunningInCI("autoRedactSensitiveData runs async OCR scan")
    let state = makeAnnotateState()
    state.loadImage(try makeImage(width: 120, height: 80))

    state.autoRedactSensitiveData()

    XCTAssertTrue(state.isSensitiveRedactionScanning)
  }
}
