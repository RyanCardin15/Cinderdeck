import CryptoKit
import Foundation
import XCTest
@testable import Cinderdeck

final class IntegrationPreviewMediaFilesTests: XCTestCase {
  func testLiveIntegrityDetectsReplacementWithoutChangingHistoricalIdentity() throws {
    let manager = FileManager.default
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? manager.removeItem(at: root) }
    let video = root.appendingPathComponent("saved.mp4")
    try Data("original bytes".utf8).write(to: video)
    let saved = try IntegrationPreviewMediaFiles.identity(video, root: root)
    let expected = IntegrationPreviewMediaIdentity(sourceSHA256: saved.sha256, sourceSize: saved.size,
      videoSHA256: saved.sha256, videoSize: saved.size)
    XCTAssertEqual(IntegrationPreviewMediaFiles.integrity(video, root: root, expected: expected), "matched")
    try Data("replaced bytes".utf8).write(to: video)
    XCTAssertEqual(IntegrationPreviewMediaFiles.integrity(video, root: root, expected: expected), "changed")
    XCTAssertEqual(expected.videoSHA256, saved.sha256)
    XCTAssertEqual(IntegrationPreviewMediaFiles.integrity(video, root: root, expected: nil), "unknown")
    try manager.removeItem(at: video)
    XCTAssertEqual(IntegrationPreviewMediaFiles.integrity(video, root: root, expected: expected), "unknown")
  }

  func testHashesExactOwnedBytesAndRefusesSymlinksHardlinksEmptyAndOversize() throws {
    let manager = FileManager.default
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? manager.removeItem(at: root) }
    let source = root.appendingPathComponent("source.mp4")
    let bytes = Data("native-owned encoded preview bytes".utf8)
    try bytes.write(to: source)
    let identity = try IntegrationPreviewMediaFiles.identity(source, root: root)
    XCTAssertEqual(identity.size, bytes.count)
    XCTAssertEqual(identity.sha256, SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined())
    let alias = root.appendingPathComponent("alias.mp4")
    try manager.createSymbolicLink(at: alias, withDestinationURL: source)
    XCTAssertThrowsError(try IntegrationPreviewMediaFiles.identity(alias, root: root))
    let hardlink = root.appendingPathComponent("hardlink.mp4")
    try manager.linkItem(at: source, to: hardlink)
    XCTAssertThrowsError(try IntegrationPreviewMediaFiles.identity(source, root: root))
    try manager.removeItem(at: hardlink)
    let empty = root.appendingPathComponent("empty.mp4")
    try Data().write(to: empty)
    XCTAssertThrowsError(try IntegrationPreviewMediaFiles.identity(empty, root: root))
    let large = root.appendingPathComponent("large.mp4")
    try bytes.write(to: large)
    let handle = try FileHandle(forWritingTo: large)
    try handle.truncate(atOffset: UInt64(IntegrationPreviewMediaFiles.maximumBytes) + 1)
    try handle.close()
    XCTAssertThrowsError(try IntegrationPreviewMediaFiles.identity(large, root: root))
  }

  func testRejectsAFileOutsideTheOwnedImportDirectoryAndPersistsSourceToOutputIdentity() throws {
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let directory = root.appendingPathComponent("private-imports")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let outside = root.appendingPathComponent("outside.mp4")
    try Data("outside".utf8).write(to: outside)
    XCTAssertThrowsError(try IntegrationPreviewMediaFiles.identity(outside, root: directory))
    var recording = ReproSession(title: "Imported preview", origin: .workspace, actor: .init(kind: .agent, name: "Deckhand", session: "fixture"))
    XCTAssertNil(recording.importedMedia)
    let source = String(repeating: "a", count: 64), output = String(repeating: "b", count: 64)
    recording.importedMedia = .init(sourceSHA256: source, sourceSize: 25, videoSHA256: output, videoSize: 30)
    let recovered = try JSONDecoder().decode(ReproSession.self, from: JSONEncoder().encode(recording))
    XCTAssertEqual(recovered.importedMedia, recording.importedMedia)
    XCTAssertNotEqual(recovered.importedMedia?.sourceSHA256, recovered.importedMedia?.videoSHA256)
    XCTAssertNil(recovered.buildProof)
  }

  func testLegacyImportReceiptKeepsRequiredSessionAndNoNewProofOrTrustClaim() throws {
    let receipt = IntegrationPreviewImport(operationKey: "original", actorKey: "actor", installationID: "native",
      workspaceID: "lane", generation: 2, title: "Preview", sessionID: "saved-session", tabID: "tab",
      targetURL: "http://127.0.0.1:4321", featureID: "feature", checkoutID: "checkout", clientMonotonicMs: 50,
      capturedWorkspaceIDs: ["lane"], recordingID: UUID(), token: "private-token", hostStartedAt: Date())
    let data = try JSONEncoder().encode(receipt)
    let recovered = try JSONDecoder().decode(IntegrationPreviewImport.self, from: data)
    XCTAssertEqual(recovered.sessionID, "saved-session")
    XCTAssertNil(recovered.buildReceiptID)
    XCTAssertNil(recovered.buildProof)
    XCTAssertNil(recovered.normalizedSize)
    XCTAssertEqual(recovered.value["sourceVideoSHA256"], .null)
    XCTAssertEqual(recovered.value["videoSHA256"], .null)
    XCTAssertNil(recovered.value["trustedTarget"])
    var missingSession = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    missingSession.removeValue(forKey: "sessionID")
    XCTAssertThrowsError(try JSONDecoder().decode(IntegrationPreviewImport.self, from: JSONSerialization.data(withJSONObject: missingSession)))
  }
}
