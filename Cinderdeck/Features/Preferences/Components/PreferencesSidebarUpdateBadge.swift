//
//  PreferencesSidebarUpdateBadge.swift
//  Cinderdeck
//
//  Sidebar bottom badge showing app icon, name, update channel, and quick update action.
//

import AppKit
import SwiftUI

struct PreferencesSidebarUpdateBadge: View {
  @AppStorage(PreferencesKeys.updateChannel)
  private var updateChannel: String = UpdateChannel.stable.rawValue
  @ObservedObject private var updates = UpdaterManager.shared

  @State private var isHovering = false

  /// An update is available or downloaded and waiting to install.
  private var hasPendingUpdate: Bool {
    switch updates.status {
    case .available, .readyToInstall:
      return true
    default:
      return false
    }
  }

  private var helpText: String {
    switch updates.status {
    case let .available(offer):
      return L10n.PreferencesAbout.updateStatusAvailable(offer.version)
    case .readyToInstall:
      return L10n.PreferencesAbout.updateStatusReadyGeneric
    default:
      return L10n.Menu.checkForUpdates
    }
  }

  private var isBeta: Bool {
    updateChannel == UpdateChannel.beta.rawValue
  }

  private var appVersion: String {
    let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
    return "v\(version)"
  }

  var body: some View {
    VStack(spacing: 0) {
      Divider()
        .opacity(0.4)

      Button {
        showUpdates()
      } label: {
        HStack(spacing: 10) {
          Image(nsImage: NSApp.applicationIconImage)
            .resizable()
            .scaledToFit()
            .frame(width: 28, height: 28)
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            .overlay(
              RoundedRectangle(cornerRadius: 6, style: .continuous)
                .stroke(Color.primary.opacity(0.08), lineWidth: 0.5)
            )

          VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
              Text(verbatim: "Cinderdeck")
                .font(.system(size: 12.5, weight: .semibold))
                .foregroundStyle(.primary)

              Spacer(minLength: 4)

              channelBadge
            }

            HStack(spacing: 4) {
              Text(appVersion)
                .font(.system(size: 10.5))
                .foregroundStyle(.secondary)
                .lineLimit(1)

              if hasPendingUpdate {
                Image(systemName: "arrow.down.circle.fill")
                  .font(.system(size: 10))
                  .foregroundStyle(Color.accentColor)
                  .accessibilityHidden(true)
              }
            }
          }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background {
          RoundedRectangle(cornerRadius: 8, style: .continuous)
            .fill(isHovering ? Color.primary.opacity(0.06) : Color.primary.opacity(0.035))
        }
        .overlay {
          RoundedRectangle(cornerRadius: 8, style: .continuous)
            .strokeBorder(isHovering ? Color.primary.opacity(0.1) : Color.primary.opacity(0.06), lineWidth: 1)
        }
        .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
      }
      .buttonStyle(.plain)
      .onHover { hovering in
        isHovering = hovering
      }
      .help(helpText)
      .contextMenu {
        Button(L10n.Menu.checkForUpdates) {
          showUpdates()
        }

        Divider()

        Button {
          setChannel(.stable)
        } label: {
          HStack {
            Text(L10n.PreferencesAbout.updateChannelStable)
            if !isBeta {
              Image(systemName: "checkmark")
            }
          }
        }

        Button {
          setChannel(.beta)
        } label: {
          HStack {
            Text(L10n.PreferencesAbout.updateChannelBeta)
            if isBeta {
              Image(systemName: "checkmark")
            }
          }
        }

        Divider()

        Button(L10n.Preferences.aboutTab) {
          PreferencesNavigationState.shared.select(.about)
        }
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
    }
  }

  private var channelBadge: some View {
    Text(isBeta ? "BETA" : "STABLE")
      .font(.system(size: 9.5, weight: .bold))
      .padding(.horizontal, 5)
      .padding(.vertical, 1.5)
      .foregroundStyle(isBeta ? Color.orange : Color.secondary)
      .background(
        Capsule()
          .fill(isBeta ? Color.orange.opacity(0.18) : Color.secondary.opacity(0.12))
      )
  }

  /// Opens About, where update progress and actions live, and checks unless an update is already known.
  private func showUpdates() {
    PreferencesNavigationState.shared.select(.about)
    guard !hasPendingUpdate, !updates.status.isWorking else { return }
    updates.checkForUpdatesInPreferences()
  }

  private func setChannel(_ channel: UpdateChannel) {
    guard updateChannel != channel.rawValue else { return }
    updateChannel = channel.rawValue
    CinderdeckConfigurationSyncCoordinator.shared.scheduleSync(reason: .explicitChange)
    updates.checkForUpdatesInPreferences()
  }
}

#Preview {
  PreferencesSidebarUpdateBadge()
    .frame(width: 220)
}
