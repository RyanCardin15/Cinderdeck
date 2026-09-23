//
//  GoogleDriveTests.swift
//  CinderdeckTests
//
//  Created by DeepMind on 2026-07-12.
//

import XCTest
import CryptoKit
@testable import Cinderdeck

final class GoogleDriveTests: XCTestCase {

  func testPKCEVerifierLength() throws {
    try skipIfRunningInCI()
    let service = GoogleDriveOAuthService.shared
    let (verifier, challenge) = service.generatePKCE()
    XCTAssertEqual(verifier.count, 64)
    XCTAssertFalse(challenge.isEmpty)
  }

  func testPKCEChallengeIsSHA256OfVerifier() throws {
    try skipIfRunningInCI()
    let service = GoogleDriveOAuthService.shared
    let (verifier, challenge) = service.generatePKCE()

    guard let data = verifier.data(using: .utf8) else {
      XCTFail("Failed to encode verifier")
      return
    }
    let digest = SHA256.hash(data: data)
    let expectedChallenge = Data(digest)
      .base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")

    XCTAssertEqual(challenge, expectedChallenge)
  }

  func testPublicURLFormat() throws {
    try skipIfRunningInCI()
    let provider = GoogleDriveCloudProvider(
      clientId: "test_client",
      clientSecret: "test_secret",
      refreshToken: "test_refresh",
      folderName: "Cinderdeck"
    )
    let url = provider.generatePublicURL(for: "fileId12345")
    XCTAssertEqual(url.absoluteString, "https://drive.google.com/file/d/fileId12345/view")
  }

  func testProviderTypeIsGoogleDrive() throws {
    try skipIfRunningInCI()
    XCTAssertEqual(CloudProviderType.googleDrive.rawValue, "google_drive")
    XCTAssertEqual(CloudProviderType.googleDrive.displayName, "Google Drive")
  }

  func testSetExpirationIsNoOp() async throws {
    try skipIfRunningInCI()
    let provider = GoogleDriveCloudProvider(
      clientId: "test_client",
      clientSecret: "test_secret",
      refreshToken: "test_refresh",
      folderName: "Cinderdeck"
    )
    // Should complete successfully without throwing
    do {
      try await provider.setExpiration(days: 7)
      try await provider.removeExpiration()
    } catch {
      XCTFail("setExpiration/removeExpiration threw unexpected error: \(error)")
    }
  }

  func testGoogleDriveConfigIsAlwaysValid() throws {
    try skipIfRunningInCI()
    let config = CloudConfiguration(
      providerType: .googleDrive,
      bucket: "",
      region: "",
      endpoint: nil,
      customDomain: nil,
      expireTime: .permanent
    )
    XCTAssertTrue(config.isValid)
  }
}
