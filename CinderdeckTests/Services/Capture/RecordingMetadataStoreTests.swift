//
//  RecordingMetadataStoreTests.swift
//  CinderdeckTests
//
//  Tests for recording Smart Camera metadata persistence and migration.
//

import AVFoundation
import CoreGraphics
import XCTest
@testable import Cinderdeck

@MainActor
final class RecordingMetadataStoreTests: XCTestCase {

  private struct LegacyMetadataV1: Codable {
    var version: Int
    var captureSize: CGSize
    var samplesPerSecond: Int
    var mouseSamples: [RecordedMouseSample]
  }

  private struct LegacyMetadataV3: Codable {
    var version: Int
    var coordinateSpace: RecordingCoordinateSpace
    var captureSize: CGSize
    var samplesPerSecond: Int
    var mouseSamples: [RecordedMouseSample]
    var audioSourceURL: URL?
  }

  private var tempDirectory: URL!
  private var videoURLs: [URL] = []

  override func setUp() async throws {
    try await super.setUp()
    tempDirectory = FileManager.default.temporaryDirectory
      .appendingPathComponent("CinderdeckTests_RecordingMetadata_\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: tempDirectory, withIntermediateDirectories: true)
  }

  override func tearDown() async throws {
    for url in videoURLs {
      try? RecordingMetadataStore.delete(for: url)
    }
    videoURLs.removeAll()
    if let tempDirectory {
      try? FileManager.default.removeItem(at: tempDirectory)
    }
    try await super.tearDown()
  }

  func testRecordingMetadata_currentVersionRoundTripsThroughCodable() throws {
    let metadata = makeCurrentMetadata()
    let data = try JSONEncoder().encode(metadata)
    let decoded = try JSONDecoder().decode(RecordingMetadata.self, from: data)

    XCTAssertEqual(decoded, metadata)
    XCTAssertEqual(decoded.version, RecordingMetadata.currentVersion)
    XCTAssertEqual(decoded.coordinateSpace, .topLeftNormalized)
  }

  func testRecordingMetadata_v1WithoutCoordinateSpaceDecodesAsBottomLeft() throws {
    let legacy = LegacyMetadataV1(
      version: 1,
      captureSize: CGSize(width: 320, height: 200),
      samplesPerSecond: 60,
      mouseSamples: [
        RecordedMouseSample(time: 0.1, normalizedX: 0.2, normalizedY: 0.25, isInsideCapture: true)
      ]
    )
    let data = try JSONEncoder().encode(legacy)
    let decoded = try JSONDecoder().decode(RecordingMetadata.self, from: data)

    XCTAssertEqual(decoded.version, 1)
    XCTAssertEqual(decoded.coordinateSpace, .bottomLeftNormalized)
    XCTAssertEqual(decoded.mouseSamples.first?.normalizedY, 0.25)
  }

  func testRecordingMetadata_v3WithoutAudioTrackRolesDecodesEmptyRoles() throws {
    let sourceURL = tempDirectory.appendingPathComponent("legacy-audio-source.mov")
    let legacy = LegacyMetadataV3(
      version: 3,
      coordinateSpace: .topLeftNormalized,
      captureSize: CGSize(width: 640, height: 360),
      samplesPerSecond: 60,
      mouseSamples: [],
      audioSourceURL: sourceURL
    )
    let data = try JSONEncoder().encode(legacy)
    let decoded = try JSONDecoder().decode(RecordingMetadata.self, from: data)

    XCTAssertEqual(decoded.version, 3)
    XCTAssertEqual(decoded.audioSourceURL, sourceURL)
    XCTAssertTrue(decoded.audioSourceTrackRoles.isEmpty)
    XCTAssertTrue(decoded.audioSourceTracks.isEmpty)
  }

  func testRecordingAudioSourceTrackRolesFollowWriterOrder() {
    XCTAssertEqual(
      RecordingAudioSourceTrackRole.roles(capturesSystemAudio: true, capturesMicrophone: true),
      [.systemAudio, .microphone]
    )
    XCTAssertEqual(
      RecordingAudioSourceTrackRole.roles(capturesSystemAudio: true, capturesMicrophone: false),
      [.systemAudio]
    )
    XCTAssertEqual(
      RecordingAudioSourceTrackRole.roles(capturesSystemAudio: false, capturesMicrophone: true),
      [.microphone]
    )
  }

  func testRecordingMetadataStore_saveLoadRoundTripsCurrentMetadata() throws {
    let videoURL = try makeVideoFile(named: "roundtrip.mov")
    let metadata = makeCurrentMetadata()

    try RecordingMetadataStore.save(metadata, for: videoURL)
    let loaded = try XCTUnwrap(RecordingMetadataStore.load(for: videoURL))

    XCTAssertEqual(loaded, metadata)
  }

  func testRecordingMetadataStore_loadsLegacySidecarAndMigratesToTopLeft() throws {
    let videoURL = try makeVideoFile(named: "legacy.mov")
    let sidecarURL = legacySidecarURL(for: videoURL)
    let legacy = LegacyMetadataV1(
      version: 1,
      captureSize: CGSize(width: 640, height: 360),
      samplesPerSecond: 30,
      mouseSamples: [
        RecordedMouseSample(time: 0.0, normalizedX: 0.3, normalizedY: 0.25, isInsideCapture: true),
        RecordedMouseSample(time: 0.5, normalizedX: 0.6, normalizedY: 1.2, isInsideCapture: false),
      ]
    )
    try JSONEncoder().encode(legacy).write(to: sidecarURL, options: .atomic)

    let loaded = try XCTUnwrap(RecordingMetadataStore.load(for: videoURL))

    XCTAssertEqual(loaded.version, RecordingMetadata.currentVersion)
    XCTAssertEqual(loaded.coordinateSpace, .topLeftNormalized)
    XCTAssertEqual(loaded.captureSize, legacy.captureSize)
    XCTAssertEqual(loaded.samplesPerSecond, legacy.samplesPerSecond)
    XCTAssertEqual(loaded.mouseSamples[0].normalizedY, 0.75, accuracy: 0.0001)
    XCTAssertEqual(loaded.mouseSamples[1].normalizedY, 0.0, accuracy: 0.0001)
    XCTAssertFalse(FileManager.default.fileExists(atPath: sidecarURL.path))

    let loadedAfterMigration = try XCTUnwrap(RecordingMetadataStore.load(for: videoURL))
    XCTAssertEqual(loadedAfterMigration, loaded)
  }

  func testRecordingMetadataStore_moveAssociationPreservesMetadataForRenamedVideo() throws {
    let oldURL = try makeVideoFile(named: "before.mov")
    let newURL = try makeVideoFile(named: "after.mov")
    let metadata = makeCurrentMetadata()

    try RecordingMetadataStore.save(metadata, for: oldURL)
    try RecordingMetadataStore.moveAssociation(from: oldURL, to: newURL)

    XCTAssertNil(RecordingMetadataStore.load(for: oldURL))
    XCTAssertEqual(RecordingMetadataStore.load(for: newURL), metadata)
  }

  func testRecordingMetadataStore_deleteRemovesMetadata() throws {
    let videoURL = try makeVideoFile(named: "delete.mov")
    let metadata = makeCurrentMetadata()

    try RecordingMetadataStore.save(metadata, for: videoURL)
    XCTAssertNotNil(RecordingMetadataStore.load(for: videoURL))

    try RecordingMetadataStore.delete(for: videoURL)
    XCTAssertNil(RecordingMetadataStore.load(for: videoURL))
  }

  func testRecordingMetadataStore_storeAudioSourceAndDeleteRemovesSidecar() throws {
    let videoURL = try makeVideoFile(named: "audio-source.mov")
    let sourceURL = tempDirectory.appendingPathComponent("multitrack-source.mov")
    try Data("multitrack".utf8).write(to: sourceURL)

    let storedSourceURL = try RecordingMetadataStore.storeAudioSource(from: sourceURL)
    var metadata = makeCurrentMetadata()
    metadata.audioSourceURL = storedSourceURL
    metadata.audioSourceTrackRoles = [.systemAudio, .microphone]
    metadata.audioSourceTracks = [
      RecordingAudioSourceTrack(trackID: 2, role: .systemAudio),
      RecordingAudioSourceTrack(trackID: 3, role: .microphone),
    ]

    try RecordingMetadataStore.save(metadata, for: videoURL)
    let loaded = try XCTUnwrap(RecordingMetadataStore.load(for: videoURL))
    XCTAssertEqual(loaded.audioSourceURL, storedSourceURL)
    XCTAssertEqual(loaded.audioSourceTrackRoles, [.systemAudio, .microphone])
    XCTAssertEqual(loaded.audioSourceTracks, metadata.audioSourceTracks)
    XCTAssertTrue(FileManager.default.fileExists(atPath: storedSourceURL.path))

    try RecordingMetadataStore.delete(for: videoURL)
    XCTAssertNil(RecordingMetadataStore.load(for: videoURL))
    XCTAssertFalse(FileManager.default.fileExists(atPath: storedSourceURL.path))
  }

  func testVideoEditorStateResolvesStoredAudioSourceAssetWhenAvailable() throws {
    let videoURL = try makeVideoFile(named: "editor-compatible-output.mov")
    let sourceURL = tempDirectory.appendingPathComponent("editor-multitrack-source.mov")
    try Data("multitrack".utf8).write(to: sourceURL)
    let storedSourceURL = try RecordingMetadataStore.storeAudioSource(from: sourceURL)

    var metadata = makeCurrentMetadata()
    metadata.audioSourceURL = storedSourceURL
    metadata.audioSourceTrackRoles = [.systemAudio, .microphone]
    try RecordingMetadataStore.save(metadata, for: videoURL)

    let loaded = try XCTUnwrap(RecordingMetadataStore.load(for: videoURL))
    XCTAssertEqual(VideoEditorState.editorAssetURL(for: videoURL, metadata: loaded), storedSourceURL)
    XCTAssertEqual(
      VideoEditorState.audioTrackRoles(forAudioTrackCount: 2, metadata: loaded),
      [.systemAudio, .microphone]
    )
    XCTAssertEqual(
      VideoEditorState.audioTrackRoles(forAudioTrackCount: 1, metadata: loaded),
      [.mixed]
    )
  }

  func testVideoEditorStateAudioTrackRolesPreferTrackIDMetadata() throws {
    let composition = AVMutableComposition()
    let microphoneTrack = try XCTUnwrap(composition.addMutableTrack(
      withMediaType: .audio,
      preferredTrackID: 42
    ))
    let systemTrack = try XCTUnwrap(composition.addMutableTrack(
      withMediaType: .audio,
      preferredTrackID: 7
    ))

    let metadata = RecordingMetadata(
      captureSize: CGSize(width: 640, height: 360),
      samplesPerSecond: 60,
      mouseSamples: [],
      audioSourceURL: tempDirectory.appendingPathComponent("source.mov"),
      audioSourceTrackRoles: [.systemAudio, .microphone],
      audioSourceTracks: [
        RecordingAudioSourceTrack(trackID: Int(systemTrack.trackID), role: .systemAudio),
        RecordingAudioSourceTrack(trackID: Int(microphoneTrack.trackID), role: .microphone),
      ]
    )

    XCTAssertEqual(
      VideoEditorState.audioTrackRoles(for: [microphoneTrack, systemTrack], metadata: metadata),
      [.microphone, .systemAudio]
    )
  }

  private func makeCurrentMetadata() -> RecordingMetadata {
    RecordingMetadata(
      coordinateSpace: .topLeftNormalized,
      captureSize: CGSize(width: 1_280, height: 720),
      samplesPerSecond: 60,
      mouseSamples: [
        RecordedMouseSample(time: 0.0, normalizedX: 0.1, normalizedY: 0.2, isInsideCapture: true),
        RecordedMouseSample(time: 0.5, normalizedX: 0.7, normalizedY: 0.8, isInsideCapture: true),
      ]
    )
  }

  private func makeVideoFile(named name: String) throws -> URL {
    let url = tempDirectory.appendingPathComponent(name)
    try Data("video".utf8).write(to: url)
    videoURLs.append(url)
    return url
  }

  private func legacySidecarURL(for videoURL: URL) -> URL {
    videoURL
      .deletingPathExtension()
      .appendingPathExtension("cinderdeck-recording.json")
  }
}
