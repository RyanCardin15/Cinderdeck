//
//  CloudUsageInfo.swift
//  Cinderdeck
//
//  Value type for cloud bucket usage statistics
//

import Foundation

/// Snapshot of cloud bucket usage data
struct CloudUsageInfo: Codable, Equatable {
  let providerType: CloudProviderType
  let totalStorageBytes: Int64
  let objectCount: Int
  /// Active lifecycle rule expiration days for cinderdeck/ prefix, nil if none
  let lifecycleRuleDays: Int?
  let fetchedAt: Date

  /// Human-readable storage size
  var formattedStorage: String {
    ByteCountFormatter.string(fromByteCount: totalStorageBytes, countStyle: .file)
  }
}
