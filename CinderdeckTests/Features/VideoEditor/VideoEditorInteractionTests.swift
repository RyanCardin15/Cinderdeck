import AVFoundation
import Combine
import XCTest
@testable import Cinderdeck

@MainActor
final class VideoEditorInteractionTests: XCTestCase {
  private var sourceURL: URL!

  override func setUp() async throws {
    sourceURL = FileManager.default.temporaryDirectory.appendingPathComponent("EditorInteraction-\(UUID()).mov")
    try Data(repeating: 0, count: 8192).write(to: sourceURL)
  }

  override func tearDown() async throws {
    try? RecordingMetadataStore.delete(for: sourceURL)
    try? FileManager.default.removeItem(at: sourceURL)
  }

  func testSpeedEditsImmediatelyInvalidateMapAndDirtyStateIncludingUndo() throws {
    let state = makeState()
    let id = try XCTUnwrap(state.addSpeed(range: 2...6, rate: 2))
    XCTAssertTrue(state.hasUnsavedChanges)
    XCTAssertEqual(state.speedTimeMap.scaledDuration, 28, accuracy: 0.001)
    state.markAsSaved()
    state.updateSpeed(id: id, rate: 4)
    XCTAssertTrue(state.hasUnsavedChanges)
    XCTAssertEqual(state.speedTimeMap.scaledDuration, 27, accuracy: 0.001)
    XCTAssertEqual(state.currentPreviewRate(at: CMTime(seconds: 3, preferredTimescale: 600)), 4)
    state.undo()
    XCTAssertFalse(state.hasUnsavedChanges)
    XCTAssertEqual(state.speedTimeMap.scaledDuration, 28, accuracy: 0.001)
    state.redo()
    XCTAssertEqual(state.speedTimeMap.scaledDuration, 27, accuracy: 0.001)
  }

  func testSpeedDragPreviewsRespectNeighboursWithoutPublishingOrFillingUndoHistory() throws {
    let state = makeState()
    let id = try XCTUnwrap(state.addSpeed(range: 2...6, rate: 2))
    _ = state.addSpeed(range: 12...16, rate: 4)
    state.markAsSaved()
    var publications = 0
    let observation = state.objectWillChange.sink { publications += 1 }
    for step in 0..<120 {
      _ = state.previewSpeedRange(id: id, startTime: 2 + Double(step) / 30, duration: 4)
    }
    let preview = try XCTUnwrap(state.previewSpeedRange(id: id, startTime: 9, duration: 5))
    XCTAssertEqual(preview.endTime, 12)
    XCTAssertNil(state.previewSpeedRange(id: id, startTime: 11, duration: 5))
    XCTAssertEqual(publications, 0)
    XCTAssertFalse(state.canUndo)
    state.updateSpeed(id: id, startTime: preview.startTime, duration: preview.duration)
    state.undo()
    XCTAssertEqual(state.speedSegments.first?.startTime, 2)
    XCTAssertFalse(state.canUndo)
    withExtendedLifetime(observation) {}
  }

  func testZoomEditIsUndoableAndNoOpDoesNotPublish() {
    let state = makeState()
    let segment = ZoomSegment(startTime: 2, zoomType: .manual)
    state.zoomSegments = [segment]
    state.markAsSaved()
    var publications = 0
    let observation = state.objectWillChange.sink { publications += 1 }
    state.updateZoom(id: segment.id, zoomLevel: segment.zoomLevel)
    XCTAssertEqual(publications, 0)
    state.updateZoom(id: segment.id, zoomLevel: 3)
    XCTAssertTrue(state.canUndo)
    state.undo()
    XCTAssertEqual(state.zoomSegments, [segment])
    XCTAssertFalse(state.hasUnsavedChanges)
    state.redo()
    XCTAssertEqual(state.zoomSegments.first?.zoomLevel, 3)
    withExtendedLifetime(observation) {}
  }

  func testAutoFocusLatestEditWinsAndRemovalDoesNotRestoreStalePaths() async throws {
    let metadata = makeMetadata(sampleCount: 3600)
    try RecordingMetadataStore.save(metadata, for: sourceURL)
    let state = makeState()
    let segment = ZoomSegment(startTime: 2, zoomType: .auto)
    state.zoomSegments = [segment]
    state.updateZoom(id: segment.id, zoomLevel: 3)
    state.updateZoom(id: segment.id, followSpeed: 0.9)
    await state.waitForAutoFocusPaths()
    let latest = try XCTUnwrap(state.zoomSegments.first)
    XCTAssertEqual(state.autoFocusPath(for: latest), VideoEditorAutoFocusEngine.buildPath(from: metadata, segment: latest))

    let revision = state.autoFocusPathsRevision
    state.zoomSegments[0].startTime = 5
    state.zoomSegments[0].duration = 4
    await state.waitForAutoFocusPaths()
    XCTAssertEqual(state.autoFocusPathsRevision, revision, "Timing edits must reuse the full-recording path")

    state.updateZoom(id: segment.id, zoomLevel: 4)
    state.removeZoom(id: segment.id)
    await state.waitForAutoFocusPaths()
    await Task.yield()
    XCTAssertTrue(state.autoFocusPaths.isEmpty)
  }

  func testMatchingAutoFocusSegmentsShareTheSamePath() async throws {
    try RecordingMetadataStore.save(makeMetadata(sampleCount: 600), for: sourceURL)
    let state = makeState()
    let first = ZoomSegment(startTime: 0, zoomType: .auto)
    let second = ZoomSegment(startTime: 5, zoomType: .auto)
    state.zoomSegments = [first]
    await state.waitForAutoFocusPaths()
    let firstPath = state.autoFocusPath(for: first)
    state.zoomSegments.append(second)
    await state.waitForAutoFocusPaths()
    XCTAssertFalse(firstPath.isEmpty)
    XCTAssertEqual(state.autoFocusPath(for: second), firstPath)
  }

  func testRenderingFileDetailsUsesCachedAttributes() throws {
    let state = makeState()
    let size = state.fileSizeString
    let creation = state.fileCreationDate
    try FileManager.default.removeItem(at: sourceURL)
    for _ in 0..<100 {
      XCTAssertEqual(state.fileSizeString, size)
      XCTAssertEqual(state.fileCreationDate, creation)
      state.recalculateEstimatedFileSize()
    }
    XCTAssertNotEqual(size, "—")
  }

  func testLongRecordingCameraEditsPerformance() async throws {
    guard ProcessInfo.processInfo.environment["CINDERDECK_EDITOR_PERFORMANCE"] == "1" else {
      throw XCTSkip("Opt-in workload measurement; no machine-dependent timing threshold")
    }
    let metadata = makeMetadata(sampleCount: 108_000) // 30 minutes at 60 Hz
    try RecordingMetadataStore.save(metadata, for: sourceURL)
    let state = makeState()
    let segment = ZoomSegment(startTime: 2, zoomType: .auto)
    state.zoomSegments = [segment]
    await state.waitForAutoFocusPaths()
    var synchronousMS: [Double] = []
    var inputMS: [Double] = []
    for i in 0..<10 {
      var edited = segment
      edited.zoomLevel = 1.5 + Double(i) / 5
      let oldStart = CFAbsoluteTimeGetCurrent()
      let baselinePath = VideoEditorAutoFocusEngine.buildPath(from: metadata, segment: edited)
      _ = VideoEditorAutoFocusEngine.evaluatePathQuality(metadata: metadata, segment: edited, path: baselinePath)
      synchronousMS.append((CFAbsoluteTimeGetCurrent() - oldStart) * 1000)
      let start = CFAbsoluteTimeGetCurrent()
      state.updateZoom(id: segment.id, zoomLevel: edited.zoomLevel)
      inputMS.append((CFAbsoluteTimeGetCurrent() - start) * 1000)
      await state.waitForAutoFocusPaths()
      XCTAssertEqual(state.autoFocusPath(for: edited), baselinePath)
    }
    print("EDITOR_PERFORMANCE synchronous_path_ms=\(synchronousMS.sorted()) input_dispatch_ms=\(inputMS.sorted())")
  }

  func testRealVideoExportsLatestZoomAndSpeedEdits() async throws {
    guard let path = ProcessInfo.processInfo.environment["CINDERDECK_EDITOR_FIXTURE"] else {
      throw XCTSkip("Set CINDERDECK_EDITOR_FIXTURE to a disposable video for the export smoke test")
    }
    try Data(contentsOf: URL(fileURLWithPath: path)).write(to: sourceURL)
    try RecordingMetadataStore.save(makeMetadata(sampleCount: 1800), for: sourceURL)
    let state = VideoEditorState(url: sourceURL)
    await state.loadMetadata()
    XCTAssertFalse(state.hasUnsavedChanges)
    let beforeSpeed = state.estimatedFileSize
    let length = state.duration.seconds
    let speedID = try XCTUnwrap(state.addSpeed(range: 0...length, rate: 2))
    XCTAssertEqual(state.effectiveOutputDuration.seconds, length / 2, accuracy: 0.01)
    XCTAssertEqual(Double(state.estimatedFileSize), Double(beforeSpeed) / 2, accuracy: 1)
    state.play()
    XCTAssertEqual(state.player.rate, 2)
    state.toggleSpeedEnabled(id: speedID)
    XCTAssertEqual(state.player.rate, 1)
    state.toggleSpeedEnabled(id: speedID)
    state.pause()

    let id = state.addZoom(at: 3)
    state.updateZoom(id: id, zoomLevel: 3)
    state.exportSettings.dimensionPreset = .custom
    state.exportSettings.customWidth = 320
    state.exportSettings.customHeight = 180
    let output = sourceURL.deletingPathExtension().appendingPathExtension("export.mov")
    defer { try? FileManager.default.removeItem(at: output) }
    try await VideoEditorExporter.exportTrimmed(state: state, to: output, progress: { _ in })
    let outputAsset = AVURLAsset(url: output)
    let duration = try await outputAsset.load(.duration)
    XCTAssertEqual(duration.seconds, length / 2, accuracy: 0.15)
    let segment = try XCTUnwrap(state.zoomSegments.first)
    XCTAssertFalse(state.autoFocusPath(for: segment).isEmpty)
  }

  private func makeState() -> VideoEditorState {
    let state = VideoEditorState(url: sourceURL)
    state.trimEnd = CMTime(seconds: 30, preferredTimescale: 600)
    state.markAsSaved()
    return state
  }

  private func makeMetadata(sampleCount: Int) -> RecordingMetadata {
    let samples: [RecordedMouseSample] = (0..<sampleCount).map { index in
      let time = Double(index) / 60.0
      let x = CGFloat(0.5 + 0.4 * sin(time))
      let y = CGFloat(0.5 + 0.4 * cos(Double(index) / 90.0))
      return RecordedMouseSample(time: time, normalizedX: x, normalizedY: y, isInsideCapture: true)
    }
    return RecordingMetadata(captureSize: CGSize(width: 1920, height: 1080),
      samplesPerSecond: 60, mouseSamples: samples)
  }
}
