#!/usr/bin/env swift
//
//  sparkle-key-tool.swift
//  Cinderdeck
//
//  Checks Sparkle EdDSA material without Sparkle's tools, so the release workflow can prove
//  that SPARKLE_PRIVATE_KEY matches the SUPublicEDKey installed copies trust.
//
//  Usage:
//    printf '%s' "$SPARKLE_PRIVATE_KEY" | swift scripts/sparkle-key-tool.swift public-key
//    swift scripts/sparkle-key-tool.swift verify <archive> <edSignature> <SUPublicEDKey>
//

import CryptoKit
import Foundation

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data("sparkle-key-tool: \(message)\n".utf8))
  exit(1)
}

/// Sparkle's private key is the base64 32-byte Ed25519 seed, or (older keys) a 64-byte
/// expanded private key followed by the 32-byte public key.
func publicKey(fromPrivateKey encoded: String) -> Data {
  guard let secret = Data(base64Encoded: encoded.trimmingCharacters(in: .whitespacesAndNewlines)) else {
    fail("private key is not valid base64")
  }
  switch secret.count {
  case 32:
    guard let key = try? Curve25519.Signing.PrivateKey(rawRepresentation: secret) else {
      fail("private key seed is invalid")
    }
    return key.publicKey.rawRepresentation
  case 96:
    return secret.suffix(32)
  default:
    fail("private key must decode to 32 or 96 bytes, not \(secret.count)")
  }
}

let arguments = Array(CommandLine.arguments.dropFirst())

switch arguments.first {
case "public-key":
  let input = FileHandle.standardInput.readDataToEndOfFile()
  guard let encoded = String(data: input, encoding: .utf8) else {
    fail("private key is not UTF-8 text")
  }
  print(publicKey(fromPrivateKey: encoded).base64EncodedString())

case "verify":
  guard arguments.count == 4 else {
    fail("usage: verify <archive> <edSignature> <SUPublicEDKey>")
  }
  guard let archive = FileManager.default.contents(atPath: arguments[1]) else {
    fail("cannot read \(arguments[1])")
  }
  guard let signature = Data(base64Encoded: arguments[2]), signature.count == 64 else {
    fail("signature must be 64 bytes of base64")
  }
  guard let keyData = Data(base64Encoded: arguments[3]),
        let key = try? Curve25519.Signing.PublicKey(rawRepresentation: keyData) else {
    fail("public key must be 32 bytes of base64")
  }
  guard key.isValidSignature(signature, for: archive) else {
    fail("the archive's signature does not match SUPublicEDKey; installed copies would reject this update")
  }
  print("Archive signature matches SUPublicEDKey.")

default:
  fail("usage: public-key | verify <archive> <edSignature> <SUPublicEDKey>")
}
