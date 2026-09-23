//
//  AnnotateColorPaletteStoreTests.swift
//  CinderdeckTests
//
//  Tests for persistent custom Annotate colors and quick favorites.
//

import AppKit
@testable import Cinderdeck
import SwiftUI
import UniformTypeIdentifiers
import XCTest

@MainActor
final class AnnotateColorPaletteStoreTests: XCTestCase {
  private static var retainedStores: [AnnotateColorPaletteStore] = []
  private static var retainedDefaults: [UserDefaults] = []

  private func makeStore() -> AnnotateColorPaletteStore {
    let defaults = UserDefaultsFactory.make()
    let store = AnnotateColorPaletteStore(defaults: defaults)
    Self.retainedDefaults.append(defaults)
    Self.retainedStores.append(store)
    return store
  }

  func testAddColorPersistsForNextStore() {
    let defaults = UserDefaultsFactory.make()
    let color = color(red: 0.12, green: 0.34, blue: 0.56, alpha: 0.78)

    let store = AnnotateColorPaletteStore(defaults: defaults)
    store.addColor(color)

    let reloadedStore = AnnotateColorPaletteStore(defaults: defaults)
    Self.retainedDefaults.append(defaults)
    Self.retainedStores.append(contentsOf: [store, reloadedStore])

    XCTAssertEqual(reloadedStore.customColorValues.count, 1)
    XCTAssertTrue(matches(reloadedStore.customColorValues[0], color))
  }

  func testCustomColorsPreserveAddOrder() {
    let store = makeStore()
    let firstColor = color(red: 0.95, green: 0.12, blue: 0.18, alpha: 1)
    let secondColor = color(red: 0.1, green: 0.45, blue: 0.9, alpha: 0.6)
    let thirdColor = color(red: 0.42, green: 0.8, blue: 0.25, alpha: 1)

    store.addColor(firstColor)
    store.addColor(secondColor)
    store.addColor(thirdColor)

    XCTAssertEqual(store.customColorValues.count, 3)
    XCTAssertTrue(matches(store.customColorValues[0], firstColor))
    XCTAssertTrue(matches(store.customColorValues[1], secondColor))
    XCTAssertTrue(matches(store.customColorValues[2], thirdColor))
  }

  func testAddingExistingCustomColorKeepsOriginalPosition() {
    let store = makeStore()
    let firstColor = color(red: 0.95, green: 0.12, blue: 0.18, alpha: 1)
    let secondColor = color(red: 0.1, green: 0.45, blue: 0.9, alpha: 0.6)

    store.addColor(firstColor)
    store.addColor(secondColor)
    store.addColor(firstColor)

    XCTAssertEqual(store.customColorValues.count, 2)
    XCTAssertTrue(matches(store.customColorValues[0], firstColor))
    XCTAssertTrue(matches(store.customColorValues[1], secondColor))
  }

  func testCustomColorsAreCappedToMaximumCount() {
    let store = makeStore()
    let totalColors = AnnotateColorPaletteStore.maximumCustomColorCount + 5

    for index in 0 ..< totalColors {
      store.addColor(indexedColor(index, total: totalColors))
    }

    XCTAssertEqual(store.customColorValues.count, AnnotateColorPaletteStore.maximumCustomColorCount)
    let firstKeptIndex = totalColors - AnnotateColorPaletteStore.maximumCustomColorCount
    XCTAssertTrue(matches(store.customColorValues.first, indexedColor(firstKeptIndex, total: totalColors)))
    XCTAssertTrue(matches(store.customColorValues.last, indexedColor(totalColors - 1, total: totalColors)))
  }

  func testClearColorIsNotStoredAsCustomColor() {
    let store = makeStore()

    store.addColor(.clear)

    XCTAssertTrue(store.customColorValues.isEmpty)
  }

  func testRemoveColorUpdatesPersistence() {
    let defaults = UserDefaultsFactory.make()
    let colorToRemove = color(red: 0.2, green: 0.7, blue: 0.4, alpha: 0.9)
    let remainingColor = color(red: 0.7, green: 0.2, blue: 0.4, alpha: 1)

    let store = AnnotateColorPaletteStore(defaults: defaults)
    store.addColor(colorToRemove)
    store.addColor(remainingColor)
    store.removeColor(colorToRemove)

    let reloadedStore = AnnotateColorPaletteStore(defaults: defaults)
    Self.retainedDefaults.append(defaults)
    Self.retainedStores.append(contentsOf: [store, reloadedStore])

    XCTAssertEqual(reloadedStore.customColorValues.count, 1)
    XCTAssertTrue(matches(reloadedStore.customColorValues[0], remainingColor))
  }

  func testFavoriteColorsAreStoredPerRole() {
    let defaults = UserDefaultsFactory.make()
    let strokeFavorite = color(red: 0.95, green: 0.2, blue: 0.3, alpha: 1)
    let fillFavorite = color(red: 0.1, green: 0.6, blue: 0.9, alpha: 1)

    let store = AnnotateColorPaletteStore(defaults: defaults)
    store.addFavorite(strokeFavorite, for: .annotationStroke)
    store.addFavorite(fillFavorite, for: .annotationFill)

    let reloadedStore = AnnotateColorPaletteStore(defaults: defaults)
    Self.retainedDefaults.append(defaults)
    Self.retainedStores.append(contentsOf: [store, reloadedStore])

    XCTAssertEqual(reloadedStore.favoriteColorValues[.annotationStroke]?.count, 1)
    XCTAssertEqual(reloadedStore.favoriteColorValues[.annotationFill]?.count, 1)
    XCTAssertTrue(matches(reloadedStore.favoriteColorValues[.annotationStroke]?[0], strokeFavorite))
    XCTAssertTrue(matches(reloadedStore.favoriteColorValues[.annotationFill]?[0], fillFavorite))
    XCTAssertNil(reloadedStore.favoriteColorValues[.textBackground])
  }

  func testFavoriteColorsPreserveAddOrderWithinRole() {
    let store = makeStore()
    let firstFavorite = color(red: 0.95, green: 0.2, blue: 0.3, alpha: 1)
    let secondFavorite = color(red: 0.1, green: 0.6, blue: 0.9, alpha: 1)
    let thirdFavorite = color(red: 0.35, green: 0.8, blue: 0.2, alpha: 1)

    store.addFavorite(firstFavorite, for: .annotationStroke)
    store.addFavorite(secondFavorite, for: .annotationStroke)
    store.addFavorite(thirdFavorite, for: .annotationStroke)

    let values = store.favoriteColorValues[.annotationStroke]
    XCTAssertEqual(values?.count, 3)
    XCTAssertTrue(matches(values?[0], firstFavorite))
    XCTAssertTrue(matches(values?[1], secondFavorite))
    XCTAssertTrue(matches(values?[2], thirdFavorite))
  }

  func testAddingExistingFavoriteKeepsOriginalPosition() {
    let store = makeStore()
    let firstFavorite = color(red: 0.95, green: 0.2, blue: 0.3, alpha: 1)
    let secondFavorite = color(red: 0.1, green: 0.6, blue: 0.9, alpha: 1)

    store.addFavorite(firstFavorite, for: .annotationStroke)
    store.addFavorite(secondFavorite, for: .annotationStroke)
    store.addFavorite(firstFavorite, for: .annotationStroke)

    let values = store.favoriteColorValues[.annotationStroke]
    XCTAssertEqual(values?.count, 2)
    XCTAssertTrue(matches(values?[0], firstFavorite))
    XCTAssertTrue(matches(values?[1], secondFavorite))
  }

  func testFavoriteColorsIgnoreNewColorsWhenMaximumCountIsReached() {
    let store = makeStore()
    let totalColors = AnnotateColorPaletteStore.maximumFavoriteColorCount + 1

    XCTAssertEqual(AnnotateColorPaletteStore.maximumFavoriteColorCount, 4)

    for index in 0 ..< totalColors {
      store.addFavorite(indexedColor(index, total: totalColors), for: .annotationStroke)
    }

    let values = store.favoriteColorValues[.annotationStroke]
    XCTAssertEqual(values?.count, AnnotateColorPaletteStore.maximumFavoriteColorCount)
    XCTAssertTrue(matches(values?.first, indexedColor(0, total: totalColors)))
    XCTAssertTrue(matches(values?.last, indexedColor(totalColors - 2, total: totalColors)))
  }

  func testToggleFavoriteRemovesExistingRoleFavorite() {
    let store = makeStore()
    let favorite = color(red: 0.35, green: 0.45, blue: 0.55, alpha: 1)

    store.toggleFavorite(favorite, for: .annotationStroke)
    XCTAssertTrue(store.isFavorite(favorite, for: .annotationStroke))

    store.toggleFavorite(favorite, for: .annotationStroke)
    XCTAssertFalse(store.isFavorite(favorite, for: .annotationStroke))
    XCTAssertNil(store.favoriteColorValues[.annotationStroke])
  }

  func testRemovingCustomColorPrunesMatchingFavorites() {
    let store = makeStore()
    let customColor = color(red: 0.13, green: 0.24, blue: 0.75, alpha: 1)

    store.addColor(customColor)
    store.addFavorite(customColor, for: .annotationStroke)
    store.addFavorite(customColor, for: .annotationFill)
    store.removeColor(customColor)

    XCTAssertTrue(store.customColorValues.isEmpty)
    XCTAssertNil(store.favoriteColorValues[.annotationStroke])
    XCTAssertNil(store.favoriteColorValues[.annotationFill])
  }

  func testDragPayloadAdvertisesOnlyPlainTextType() {
    let provider = AnnotateColorDragPayload.itemProvider(
      color: color(red: 0.25, green: 0.5, blue: 0.75, alpha: 1),
      sourceFavoriteRole: .annotationStroke
    )

    XCTAssertEqual(AnnotateColorDragPayload.supportedContentTypes, [.plainText])
    XCTAssertTrue(provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier))
    XCTAssertFalse(provider.registeredTypeIdentifiers.contains("com.ryancardin.cinderdeck.annotate-color"))
  }

  func testDragPayloadPlainTextRoundTripsColorAndSourceRole() throws {
    let originalColor = color(red: 0.25, green: 0.5, blue: 0.75, alpha: 0.8)
    let payload = try XCTUnwrap(
      AnnotateColorDragPayload(color: originalColor, sourceFavoriteRole: .annotationFill)
    )

    let decoded = try XCTUnwrap(AnnotateColorDragPayload.parsePlainText(payload.encodedPlainText))

    XCTAssertEqual(decoded.sourceFavoriteRole, .annotationFill)
    XCTAssertTrue(matches(RGBAColor(color: decoded.color), originalColor))
  }

  func testAcceptFavoriteDropAddsNonFavoritePayloadToRole() throws {
    let store = makeStore()
    let favorite = color(red: 0.8, green: 0.15, blue: 0.45, alpha: 1)
    let payload = try XCTUnwrap(AnnotateColorDragPayload(color: favorite, sourceFavoriteRole: nil))

    store.acceptFavoriteDrop(payload, for: .annotationStroke)

    XCTAssertTrue(store.isFavorite(favorite, for: .annotationStroke))
  }

  func testAcceptFavoriteDropIgnoresNewPayloadWhenMaximumCountIsReached() throws {
    let store = makeStore()
    let maximumFavorites = AnnotateColorPaletteStore.maximumFavoriteColorCount
    let totalColors = maximumFavorites + 1

    for index in 0 ..< maximumFavorites {
      store.addFavorite(indexedColor(index, total: totalColors), for: .annotationStroke)
    }

    let overflowFavorite = indexedColor(maximumFavorites, total: totalColors)
    let payload = try XCTUnwrap(AnnotateColorDragPayload(color: overflowFavorite, sourceFavoriteRole: nil))

    store.acceptFavoriteDrop(payload, for: .annotationStroke)

    let values = store.favoriteColorValues[.annotationStroke]
    XCTAssertEqual(values?.count, maximumFavorites)
    XCTAssertTrue(matches(values?.first, indexedColor(0, total: totalColors)))
    XCTAssertTrue(matches(values?.last, indexedColor(maximumFavorites - 1, total: totalColors)))
    XCTAssertFalse(store.isFavorite(overflowFavorite, for: .annotationStroke))
  }

  func testAcceptFavoriteDropMovesSameRoleFavoriteToEnd() throws {
    let store = makeStore()
    let firstFavorite = color(red: 0.18, green: 0.62, blue: 0.4, alpha: 1)
    let secondFavorite = color(red: 0.85, green: 0.26, blue: 0.18, alpha: 1)
    let thirdFavorite = color(red: 0.2, green: 0.32, blue: 0.86, alpha: 1)

    store.addFavorite(firstFavorite, for: .annotationStroke)
    store.addFavorite(secondFavorite, for: .annotationStroke)
    store.addFavorite(thirdFavorite, for: .annotationStroke)

    let payload = try XCTUnwrap(
      AnnotateColorDragPayload(color: firstFavorite, sourceFavoriteRole: .annotationStroke)
    )

    store.acceptFavoriteDrop(payload, for: .annotationStroke)

    let values = store.favoriteColorValues[.annotationStroke]
    XCTAssertEqual(values?.count, 3)
    XCTAssertTrue(matches(values?[0], secondFavorite))
    XCTAssertTrue(matches(values?[1], thirdFavorite))
    XCTAssertTrue(matches(values?[2], firstFavorite))
  }

  func testAcceptFavoriteDropOnFavoriteSwapsSameRoleFavorites() throws {
    let store = makeStore()
    let firstFavorite = color(red: 0.18, green: 0.62, blue: 0.4, alpha: 1)
    let secondFavorite = color(red: 0.85, green: 0.26, blue: 0.18, alpha: 1)
    let thirdFavorite = color(red: 0.2, green: 0.32, blue: 0.86, alpha: 1)

    store.addFavorite(firstFavorite, for: .annotationStroke)
    store.addFavorite(secondFavorite, for: .annotationStroke)
    store.addFavorite(thirdFavorite, for: .annotationStroke)

    let payload = try XCTUnwrap(
      AnnotateColorDragPayload(color: firstFavorite, sourceFavoriteRole: .annotationStroke)
    )

    store.acceptFavoriteDrop(payload, for: .annotationStroke, targetColor: thirdFavorite)

    let values = store.favoriteColorValues[.annotationStroke]
    XCTAssertEqual(values?.count, 3)
    XCTAssertTrue(matches(values?[0], thirdFavorite))
    XCTAssertTrue(matches(values?[1], secondFavorite))
    XCTAssertTrue(matches(values?[2], firstFavorite))
  }

  private func indexedColor(_ index: Int, total: Int) -> Color {
    color(
      red: Double(index + 1) / Double(total + 1),
      green: Double((index * 7) % total + 1) / Double(total + 1),
      blue: Double((index * 13) % total + 1) / Double(total + 1),
      alpha: 1
    )
  }

  private func color(red: Double, green: Double, blue: Double, alpha: Double) -> Color {
    Color(nsColor: NSColor(srgbRed: red, green: green, blue: blue, alpha: alpha))
  }

  private func matches(_ value: RGBAColor?, _ color: Color) -> Bool {
    guard let value,
          let expected = RGBAColor(color: color) else { return false }
    return abs(value.red - expected.red) < 0.001
      && abs(value.green - expected.green) < 0.001
      && abs(value.blue - expected.blue) < 0.001
      && abs(value.alpha - expected.alpha) < 0.001
  }
}
