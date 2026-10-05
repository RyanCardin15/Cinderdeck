import CryptoKit
import Foundation
import XCTest
@testable import Cinderdeck

final class IntegrationRecordingEvidenceTests: XCTestCase {
  func testSymlinkedExportRootProducesServeableHashedAssets() throws {
    let manager = FileManager.default
    let temporary = manager.temporaryDirectory.appendingPathComponent("evidence-path-" + UUID().uuidString, isDirectory: true)
    try manager.createDirectory(at: temporary, withIntermediateDirectories: true)
    defer { try? manager.removeItem(at: temporary) }
    let actual = temporary.appendingPathComponent("real export", isDirectory: true)
    try manager.createDirectory(at: actual.appendingPathComponent("frames"), withIntermediateDirectories: true)
    let alias = temporary.appendingPathComponent("export-alias", isDirectory: true)
    try manager.createSymbolicLink(at: alias, withDestinationURL: actual)
    let bytes = Data("real video bytes".utf8)
    try bytes.write(to: actual.appendingPathComponent("recording.mp4"))
    try Data("frame".utf8).write(to: actual.appendingPathComponent("frames/preview 01.png"))
    try Data("event".utf8).write(to: actual.appendingPathComponent("recording.log"))

    let assets = try StackControlService.evidenceAssets(in: alias)
    XCTAssertEqual(assets.map(\.name), ["recording.mp4", "frames/preview 01.png", "recording.log"])
    XCTAssertEqual(assets.map(\.kind), ["video", "frame", "logs"])
    let video = try XCTUnwrap(assets.first)
    XCTAssertEqual(video.sha256, SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined())
    let resource = try XCTUnwrap(IntegrationEvidenceResourcePath.resource(for: try XCTUnwrap(video.relativePath), in: alias))
    let chunk = try StackControlService.recordingChunk(resource, offset: 0, length: bytes.count, mimeType: video.mimeType)
    XCTAssertEqual(chunk["version"]?.stringValue, video.version)
    XCTAssertEqual(chunk["size"]?.intValue, bytes.count)
    XCTAssertEqual(Data(base64Encoded: try XCTUnwrap(chunk["data"]?.stringValue)), bytes)
  }

  func testResourcePathsRejectTraversalAndSymlinkEscape() throws {
    let manager = FileManager.default
    let temporary = manager.temporaryDirectory.appendingPathComponent("evidence-boundary-" + UUID().uuidString, isDirectory: true)
    try manager.createDirectory(at: temporary, withIntermediateDirectories: true)
    defer { try? manager.removeItem(at: temporary) }
    let root = temporary.appendingPathComponent("owned", isDirectory: true)
    try manager.createDirectory(at: root, withIntermediateDirectories: true)
    let outside = temporary.appendingPathComponent("outside.log")
    try Data("outside".utf8).write(to: outside)
    try manager.createSymbolicLink(at: root.appendingPathComponent("escape.log"), withDestinationURL: outside)
    XCTAssertNil(IntegrationEvidenceResourcePath.relativePath(of: outside, in: root))
    for relative in ["../outside.log", "escape.log", "/outside.log", "", "nested/../outside.log", "nested//file"] {
      XCTAssertNil(IntegrationEvidenceResourcePath.resource(for: relative, in: root), relative)
    }
  }
}
