//
//  PreferencesAboutSettingsView.swift
//  Cinderdeck
//
//  Redesigned About tab following clean, card-based Hand Mirror aesthetic.
//

import AppKit
import SwiftUI

struct AboutSettingsView: View {
  @AppStorage(PreferencesKeys.updateChannel) private var updateChannel: String = UpdateChannel.stable.rawValue
  @ObservedObject private var updates = UpdaterManager.shared

  private var appVersion: String {
    let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
    let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1"
    return "Cinderdeck \(version) (\(build))"
  }

  var body: some View {
    GeometryReader { proxy in
      ScrollView {
        VStack(spacing: 20) {
          // Hero Icon & Title
          heroSection

          authorCard

          versionAndUpdatesCard

          Spacer(minLength: 24)
        }
        .frame(maxWidth: .infinity, minHeight: proxy.size.height)
        .padding(.horizontal, 28)
        .padding(.top, 28)
        .padding(.bottom, 28)
      }
    }
  }

  // MARK: - Hero Section

  private var heroSection: some View {
    VStack(spacing: 10) {
      Image(nsImage: NSApp.applicationIconImage)
        .resizable()
        .aspectRatio(contentMode: .fit)
        .frame(width: 96, height: 96)
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .shadow(color: Color.black.opacity(0.18), radius: 14, x: 0, y: 6)
        .shadow(color: Color.black.opacity(0.06), radius: 3, x: 0, y: 1)

      VStack(spacing: 3) {
        Text(verbatim: "Cinderdeck")
          .font(.system(size: 24, weight: .bold, design: .rounded))
          .foregroundStyle(Color.primary)

        Text("Your development control deck for macOS")
          .font(.subheadline)
          .foregroundStyle(Color.secondary)
          .multilineTextAlignment(.center)
          .lineLimit(2)
          .frame(maxWidth: 420)
      }
    }
    .padding(.bottom, 4)
  }

  // MARK: - Author

  private var authorCard: some View {
    VStack(spacing: 0) {
      // Made by
      HStack(alignment: .center) {
        Text(L10n.PreferencesAbout.madeBy)
          .font(.system(size: 13, weight: .regular))
          .foregroundStyle(Color.primary)

        Spacer()

        Link(destination: URL(string: "https://github.com/RyanCardin15")!) {
          Text("Ryan Cardin")
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(Color.primary)
        }
        .buttonStyle(.plain)
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 12)
    }
    .cardContainer(maxWidth: 480)
  }

  // MARK: - Version & Updates

  private var versionAndUpdatesCard: some View {
    VStack(spacing: 0) {
      // App version + last update check
      HStack(alignment: .center) {
        VStack(alignment: .leading, spacing: 3) {
          Text(L10n.PreferencesAbout.appVersion)
            .font(.system(size: 13, weight: .regular))
            .foregroundStyle(Color.primary)

          HStack(spacing: 6) {
            Text(appVersion)
              .font(.system(size: 11, weight: .regular))
              .foregroundStyle(Color.secondary)

            if let lastCheck = updates.lastUpdateCheckDate {
              Text("•")
                .font(.system(size: 10))
                .foregroundStyle(Color.secondary.opacity(0.5))

              HStack(spacing: 3) {
                Text(L10n.PreferencesAbout.checkedLabel)
                Text(lastCheck, style: .relative)
              }
              .font(.system(size: 11, weight: .regular))
              .foregroundStyle(Color.secondary)
              .help("\(L10n.PreferencesAbout.checkedLabel): \(lastCheck.formatted(date: .abbreviated, time: .shortened))")
            }
          }
        }

        Spacer()
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 12)

      divider

      // Update status: Check for Updates, Download & Install, Restart to Update
      PreferencesSoftwareUpdateView()
        .padding(.horizontal, 16)
        .padding(.vertical, 8)

      divider

      // Update Channel
      HStack(alignment: .center) {
        Text(L10n.PreferencesAbout.updateChannelTitle)
          .font(.system(size: 13, weight: .regular))
          .foregroundStyle(Color.primary)

        Spacer()

        Picker("", selection: $updateChannel) {
          Text(L10n.PreferencesAbout.updateChannelStable).tag(UpdateChannel.stable.rawValue)
          Text(L10n.PreferencesAbout.updateChannelBeta).tag(UpdateChannel.beta.rawValue)
        }
        .disabled(updates.status == .unavailable)
        .pickerStyle(.menu)
        .labelsHidden()
        .fixedSize()
        .controlSize(.regular)
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 12)

      if updateChannel == UpdateChannel.beta.rawValue {
        HStack(alignment: .top, spacing: 6) {
          Image(systemName: "exclamationmark.triangle.fill")
            .font(.caption)
            .foregroundColor(.orange)
          Text(L10n.PreferencesAbout.updateChannelBetaWarning)
            .font(.caption)
            .foregroundColor(.orange)
            .multilineTextAlignment(.leading)
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 10)
      }
    }
    .cardContainer(maxWidth: 480)
    .onChange(of: updateChannel) { _ in
      CinderdeckConfigurationSyncCoordinator.shared.scheduleSync(reason: .explicitChange)
      updates.checkForUpdatesInPreferences()
    }
  }

  // MARK: - Helpers

  private var divider: some View {
    Rectangle()
      .fill(Color.primary.opacity(0.08))
      .frame(height: 0.5)
      .padding(.horizontal, 12)
  }
}

private extension View {
  func cardContainer(maxWidth: CGFloat) -> some View {
    background {
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .fill(Color.primary.opacity(0.04))
    }
    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    .frame(maxWidth: maxWidth)
  }
}

#Preview {
  AboutSettingsView()
    .frame(width: 700, height: 600)
}
