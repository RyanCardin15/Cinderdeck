//
//  CloudCredentialTransferModels.swift
//  Cinderdeck
//
//  Versioned models for encrypted cloud credential transfer archives.
//

import Foundation

struct CloudCredentialTransferPayload: Codable, Equatable {
  let configuration: CloudConfiguration
  let accessKey: String
  let secretKey: String
  var googleClientId: String? = nil
  var googleClientSecret: String? = nil
  var googleRefreshToken: String? = nil

  var providerDisplayName: String {
    configuration.providerType.displayName
  }
}

struct CloudCredentialTransferEnvelope: Codable {
  let schemaVersion: Int
  let algorithm: String
  let kdf: String
  let salt: String
  let iterations: Int
  let nonce: String
  let ciphertext: String
  let tag: String
}
