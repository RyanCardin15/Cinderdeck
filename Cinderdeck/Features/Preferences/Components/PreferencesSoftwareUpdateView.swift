//
//  PreferencesSoftwareUpdateView.swift
//  Cinderdeck
//
//  Live update status with Check for Updates, Download & Install, and Restart to Update actions.
//

import SwiftUI

struct PreferencesSoftwareUpdateView: View {
  @ObservedObject private var updates = UpdaterManager.shared

  var body: some View {
    HStack(alignment: .center, spacing: 12) {
      Image(systemName: iconName)
        .font(.title2)
        .foregroundStyle(iconColor)
        .frame(width: 28)

      VStack(alignment: .leading, spacing: 3) {
        Text(headline)
          .fontWeight(.medium)
          .fixedSize(horizontal: false, vertical: true)

        if let detail {
          Text(detail)
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }

        progress

        if let releaseNotesURL {
          Link(L10n.PreferencesAbout.updateReleaseNotes, destination: releaseNotesURL)
            .font(.caption)
        }
      }

      Spacer(minLength: 12)

      actions
        .controlSize(.regular)
    }
    .padding(.vertical, 4)
    .animation(.easeInOut(duration: 0.15), value: updates.status)
  }

  // MARK: - Content

  private var headline: String {
    switch updates.status {
    case .unavailable:
      return L10n.PreferencesAbout.updateStatusUnavailable
    case .idle:
      return updates.automaticallyChecksForUpdates
        ? L10n.PreferencesAbout.updateStatusAutomatic
        : L10n.PreferencesAbout.updateStatusManual
    case .checking:
      return L10n.PreferencesAbout.updateStatusChecking
    case .upToDate:
      return L10n.PreferencesAbout.updateStatusUpToDate
    case let .available(offer):
      return L10n.PreferencesAbout.updateStatusAvailable(offer.version)
    case .downloading:
      return L10n.PreferencesAbout.updateStatusDownloading
    case .extracting:
      return L10n.PreferencesAbout.updateStatusExtracting
    case let .readyToInstall(offer):
      return offer.map { L10n.PreferencesAbout.updateStatusReady($0.version) }
        ?? L10n.PreferencesAbout.updateStatusReadyGeneric
    case .installing:
      return L10n.PreferencesAbout.updateStatusInstalling
    case .failed:
      return L10n.PreferencesAbout.updateStatusFailed
    }
  }

  private var detail: String? {
    switch updates.status {
    case .unavailable:
      return L10n.PreferencesAbout.updateStatusUnavailableDetail
    case let .available(offer):
      return offer.isInformationOnly
        ? L10n.PreferencesAbout.updateStatusInformationOnlyDetail
        : L10n.PreferencesAbout.updateStatusCurrentVersion(currentVersion)
    case .readyToInstall:
      return L10n.PreferencesAbout.updateStatusReadyDetail
    case .installing:
      return L10n.PreferencesAbout.updateStatusInstallingDetail
    case let .failed(message):
      return message
    case .idle, .checking, .upToDate, .downloading, .extracting:
      return nil
    }
  }

  private var releaseNotesURL: URL? {
    switch updates.status {
    case .available, .readyToInstall:
      return updates.status.offer?.releaseNotesURL
    default:
      return nil
    }
  }

  private var isChecking: Bool {
    if case .checking = updates.status { return true }
    return false
  }

  private var currentVersion: String {
    Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
  }

  private var iconName: String {
    switch updates.status {
    case .unavailable:
      return "exclamationmark.arrow.triangle.2.circlepath"
    case .idle, .checking:
      return "arrow.triangle.2.circlepath"
    case .upToDate:
      return "checkmark.circle.fill"
    case .available:
      return "arrow.down.circle.fill"
    case .downloading, .extracting:
      return "arrow.down.circle"
    case .readyToInstall:
      return "arrow.clockwise.circle.fill"
    case .installing:
      return "arrow.clockwise.circle"
    case .failed:
      return "exclamationmark.triangle.fill"
    }
  }

  private var iconColor: Color {
    switch updates.status {
    case .upToDate:
      return .green
    case .available, .downloading, .extracting, .readyToInstall, .installing:
      return .accentColor
    case .failed:
      return .orange
    case .unavailable, .idle, .checking:
      return .secondary
    }
  }

  @ViewBuilder
  private var progress: some View {
    switch updates.status {
    case let .downloading(_, fraction), let .extracting(_, fraction):
      if let fraction {
        ProgressView(value: fraction)
          .progressViewStyle(.linear)
          .frame(maxWidth: 240)
      } else {
        ProgressView()
          .progressViewStyle(.linear)
          .frame(maxWidth: 240)
      }
    default:
      EmptyView()
    }
  }

  // MARK: - Actions

  @ViewBuilder
  private var actions: some View {
    switch updates.status {
    case .unavailable:
      Button(L10n.PreferencesAbout.updateOpenReleases) {
        updates.checkForUpdatesInPreferences()
      }
      .buttonStyle(.bordered)

    case .idle, .upToDate:
      Button(L10n.PreferencesAbout.checkForUpdates) {
        updates.checkForUpdatesInPreferences()
      }
      .buttonStyle(.bordered)
      .disabled(!updates.canCheckForUpdates)

    case .failed:
      Button(L10n.PreferencesAbout.updateTryAgain) {
        updates.checkForUpdatesInPreferences()
      }
      .buttonStyle(.bordered)
      .disabled(!updates.canCheckForUpdates)

    case .checking, .downloading:
      HStack(spacing: 8) {
        if isChecking {
          ProgressView()
            .controlSize(.small)
        }
        if updates.canCancelUpdate {
          Button(L10n.Common.cancel) {
            updates.cancelUpdate()
          }
          .buttonStyle(.bordered)
        }
      }

    case .extracting:
      EmptyView()

    case let .available(offer):
      if offer.isInformationOnly {
        Button(L10n.PreferencesAbout.updateViewRelease) {
          updates.installUpdate()
        }
        .buttonStyle(.bordered)
      } else {
        Button(L10n.PreferencesAbout.updateDownloadAndInstall) {
          updates.installUpdate()
        }
        .buttonStyle(.borderedProminent)
        .disabled(!updates.canCheckForUpdates)
      }

    case .readyToInstall:
      Button(L10n.PreferencesAbout.updateRestartToUpdate) {
        updates.installUpdate()
      }
      .buttonStyle(.borderedProminent)

    case .installing:
      HStack(spacing: 8) {
        ProgressView()
          .controlSize(.small)
        Button(L10n.PreferencesAbout.updateQuitAndInstall) {
          updates.installUpdate()
        }
        .buttonStyle(.bordered)
      }
    }
  }
}

#Preview {
  PreferencesSoftwareUpdateView()
    .padding()
    .frame(width: 520)
}
