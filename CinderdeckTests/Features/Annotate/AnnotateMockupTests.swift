//
//  AnnotateMockupTests.swift
//  CinderdeckTests
//
//  Characterization tests for the mockup preset/reset actions on AnnotateState
//  (the path the Annotate Window drives). These state mutations are ALWAYS-RUN.
//

import AppKit
import Foundation
import XCTest
@testable import Cinderdeck

@MainActor
final class AnnotateMockupTests: XCTestCase {
  // Keep AnnotateState alive for the test process; XCTest scope cleanup can
  // crash while deinitializing this MainActor app-level ObservableObject.
  private static var retainedAnnotateStates: [AnnotateState] = []

  private func makeAnnotateState() -> AnnotateState {
    let state = AnnotateState(defaults: UserDefaultsFactory.make())
    Self.retainedAnnotateStates.append(state)
    return state
  }

  // MARK: - applyMockupPreset (ALWAYS-RUN state mutation)

  func testApplyMockupPresetSetsMockupStateFields() {
    let state = makeAnnotateState()
    state.hasUnsavedChanges = false

    state.applyMockupPreset(.isometricLeft)

    XCTAssertEqual(state.mockupRotationX, MockupPreset.isometricLeft.rotationX)
    XCTAssertEqual(state.mockupRotationY, MockupPreset.isometricLeft.rotationY)
    XCTAssertEqual(state.mockupRotationZ, MockupPreset.isometricLeft.rotationZ)
    XCTAssertEqual(state.mockupPerspective, MockupPreset.isometricLeft.perspective)
    XCTAssertEqual(state.mockupPadding, MockupPreset.isometricLeft.padding)
    XCTAssertEqual(state.selectedMockupPresetId, MockupPreset.isometricLeft.id)
    XCTAssertTrue(state.hasUnsavedChanges)
  }

  func testApplyMockupPresetOverwritesPreviousSelection() {
    let state = makeAnnotateState()

    state.applyMockupPreset(.flat)
    XCTAssertEqual(state.selectedMockupPresetId, MockupPreset.flat.id)

    state.applyMockupPreset(.dramatic)

    XCTAssertEqual(state.selectedMockupPresetId, MockupPreset.dramatic.id)
    XCTAssertEqual(state.mockupRotationY, MockupPreset.dramatic.rotationY)
    XCTAssertEqual(state.mockupPadding, MockupPreset.dramatic.padding)
  }

  // MARK: - resetMockup (ALWAYS-RUN state mutation)

  func testResetMockupClearsMockupStateToDefaults() {
    let state = makeAnnotateState()
    state.applyMockupPreset(.heroShot)

    state.resetMockup()

    XCTAssertEqual(state.mockupRotationX, 0)
    XCTAssertEqual(state.mockupRotationY, 0)
    XCTAssertEqual(state.mockupRotationZ, 0)
    XCTAssertEqual(state.mockupPerspective, 0.5)
    XCTAssertEqual(state.mockupShadowIntensity, 0.3)
    XCTAssertEqual(state.mockupCornerRadius, 12)
    XCTAssertEqual(state.mockupPadding, 40)
    XCTAssertNil(state.selectedMockupPresetId)
  }
}
