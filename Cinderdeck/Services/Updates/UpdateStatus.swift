//
//  UpdateStatus.swift
//  Cinderdeck
//
//  Update state shown in Preferences and the menu bar, kept free of Sparkle types so it can be tested.
//

import Foundation

/// A release offered by the update feed, reduced to what the UI shows.
nonisolated struct UpdateOffer: Equatable {
  let version: String
  let build: String
  let releaseNotesURL: URL?
  /// The feed only links to a download page; Sparkle cannot install it.
  let isInformationOnly: Bool
  let isCritical: Bool
}

/// What the updater is doing, as the user sees it.
nonisolated enum UpdateStatus: Equatable {
  /// This build cannot update itself (built without Cinderdeck's update signing key).
  case unavailable
  /// No check has finished since launch.
  case idle
  case checking
  case upToDate
  case available(UpdateOffer)
  /// `progress` is 0...1, or nil while the size is unknown.
  case downloading(UpdateOffer?, progress: Double?)
  case extracting(UpdateOffer?, progress: Double?)
  /// Downloaded. Installs when Cinderdeck quits, or immediately on request.
  case readyToInstall(UpdateOffer?)
  /// Cinderdeck has been asked to quit so the update can be installed and relaunched.
  case installing(UpdateOffer?)
  case failed(String)

  var offer: UpdateOffer? {
    switch self {
    case let .available(offer):
      return offer
    case let .downloading(offer, _), let .extracting(offer, _):
      return offer
    case let .readyToInstall(offer), let .installing(offer):
      return offer
    case .unavailable, .idle, .checking, .upToDate, .failed:
      return nil
    }
  }

  /// Sparkle is working; the user can wait or cancel but not start something else.
  var isWorking: Bool {
    switch self {
    case .checking, .downloading, .extracting, .installing:
      return true
    case .unavailable, .idle, .upToDate, .available, .readyToInstall, .failed:
      return false
    }
  }
}

/// Everything Sparkle reports that changes the visible status.
nonisolated enum UpdateEvent: Equatable {
  case checkStarted
  case found(UpdateOffer, alreadyDownloaded: Bool)
  case notFound
  case downloadStarted
  case downloadExpectedLength(UInt64)
  case downloadReceivedData(UInt64)
  case extracting(progress: Double?)
  case readyToInstall(UpdateOffer?)
  case installing
  case failed(String)
  /// The user chose "Skip This Version" in Sparkle's update window.
  case skipped
  /// Sparkle finished or abandoned the current update session.
  case sessionEnded
}

/// Folds Sparkle's session events into one `UpdateStatus`.
nonisolated struct UpdateStatusMachine: Equatable {
  private(set) var status: UpdateStatus
  /// The last status that was not transient; restored when a check ends without a result.
  private var settledStatus: UpdateStatus
  private var latestOffer: UpdateOffer?
  private var expectedLength: UInt64 = 0
  private var receivedLength: UInt64 = 0

  init(updatesAvailable: Bool) {
    status = updatesAvailable ? .idle : .unavailable
    settledStatus = status
  }

  mutating func apply(_ event: UpdateEvent) {
    guard status != .unavailable else { return }

    switch event {
    case .checkStarted:
      // A check resumes a pending install instead of replacing it.
      guard !isInstallPending else { return }
      status = .checking

    case let .found(offer, alreadyDownloaded):
      latestOffer = offer
      switch status {
      case .downloading, .extracting, .installing:
        return
      case .readyToInstall:
        settle(.readyToInstall(offer))
      default:
        settle(alreadyDownloaded ? .readyToInstall(offer) : .available(offer))
      }

    case .notFound:
      guard !isInstallPending else { return }
      latestOffer = nil
      settle(.upToDate)

    case .downloadStarted:
      expectedLength = 0
      receivedLength = 0
      status = .downloading(latestOffer, progress: nil)

    case let .downloadExpectedLength(length):
      expectedLength = length
      refreshDownloadProgress()

    case let .downloadReceivedData(length):
      receivedLength += length
      refreshDownloadProgress()

    case let .extracting(progress):
      status = .extracting(latestOffer, progress: progress)

    case let .readyToInstall(offer):
      if let offer {
        latestOffer = offer
      }
      settle(.readyToInstall(latestOffer))

    case .installing:
      status = .installing(latestOffer)

    case let .failed(message):
      settle(.failed(message))

    case .skipped:
      guard !isInstallPending else { return }
      latestOffer = nil
      settle(.idle)

    case .sessionEnded:
      switch status {
      case .checking:
        status = settledStatus
      case .downloading, .extracting:
        // Cancelled or failed download: the update is still on offer.
        settle(latestOffer.map(UpdateStatus.available) ?? .idle)
      case .installing:
        // Sparkle still installs an update it has started installing when Cinderdeck quits.
        settle(.readyToInstall(latestOffer))
      default:
        break
      }
    }
  }

  private var isInstallPending: Bool {
    switch status {
    case .readyToInstall, .installing:
      return true
    default:
      return false
    }
  }

  private mutating func settle(_ newStatus: UpdateStatus) {
    status = newStatus
    settledStatus = newStatus
  }

  private mutating func refreshDownloadProgress() {
    guard case .downloading = status else { return }
    let progress = expectedLength > 0 ? min(1, Double(receivedLength) / Double(expectedLength)) : nil
    status = .downloading(latestOffer, progress: progress)
  }
}
