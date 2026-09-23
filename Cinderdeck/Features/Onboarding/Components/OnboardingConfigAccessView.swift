//
//  OnboardingConfigAccessView.swift
//  Cinderdeck
//
//  Onboarding setup for the user-managed TOML config folder.
//

import SwiftUI

struct ConfigAccessView: View {
  var onBack: (() -> Void)? = nil
  let onComplete: () -> Void
  let onSkip: () -> Void

  @EnvironmentObject private var onboardingLocalization: OnboardingLocalizationController
  @State private var isGranted = !CinderdeckConfigurationService.shared.needsUserSelectedConfigAccess
  @State private var statusMessage: String?
  @State private var errorMessage: String?

  private let service = CinderdeckConfigurationService.shared

  var body: some View {
    OnboardingStepContainer(onBack: onBack) {
      Image(systemName: isGranted ? "checkmark.seal" : "gearshape.2")
        .font(.system(size: 44, weight: .light))
        .foregroundColor(isGranted ? .green.opacity(0.85) : VSDesignSystem.Colors.secondary)

      Text(configAccessTitle)
        .vsHeading()
        .padding(.top, 18)

      Text(configAccessSubtitle)
        .vsBody()
        .multilineTextAlignment(.center)
        .frame(maxWidth: 360)
        .padding(.top, 4)

      PermissionRow(
        icon: "folder.fill",
        title: configFolderTitle,
        description: configFolderCardDescription,
        status: isGranted ? .granted : .needsAction(buttonTitle: grantAccessTitle),
        isRequired: true,
        onGrant: grantAccess
      )
      .frame(maxWidth: 430)
      .padding(.top, 22)

      ConfigAccessDetailsView(
        directoryPath: service.suggestedConfigDirectoryURL.path,
        description: configFolderDescription,
        privacyNote: configAccessPrivacyNote
      )
      .padding(.top, 10)

      VStack(spacing: 8) {
        if let statusMessage {
          Label(statusMessage, systemImage: "checkmark.circle.fill")
            .font(.caption)
            .foregroundStyle(.green)
        }

        if let errorMessage {
          Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
            .font(.caption)
            .foregroundStyle(.orange)
            .multilineTextAlignment(.center)
            .frame(maxWidth: 380)
        }
      }
      .padding(.top, statusMessage == nil && errorMessage == nil ? 0 : 10)

      HStack(spacing: 12) {
        Button(configAccessLaterTitle) {
          onSkip()
        }
        .buttonStyle(.plain)
        .foregroundStyle(VSDesignSystem.Colors.tertiary)

        Button(isGranted ? commonContinueTitle : grantAccessTitle) {
          if isGranted {
            onComplete()
          } else {
            grantAccess()
          }
        }
        .buttonStyle(VSDesignSystem.PrimaryButtonStyle())
        .keyboardShortcut(.return, modifiers: [])
      }
      .padding(.top, 24)
    }
    .onAppear {
      isGranted = !service.needsUserSelectedConfigAccess
    }
  }

  private func grantAccess() {
    errorMessage = nil

    do {
      guard let result = try CinderdeckConfigurationAccessGranting.grantSuggestedConfigAccess(
        service: service,
        message: L10n.PreferencesAdvanced.configDirectoryPanelOnboardingMessage(
          service.suggestedConfigDirectoryURL.path
        )
      ) else {
        return
      }

      isGranted = !service.needsUserSelectedConfigAccess
      statusMessage = setupSuccessMessage

      if result.autoImportResult.status == .failed {
        errorMessage = autoImportFailureMessage(for: result.autoImportResult)
        return
      }
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func autoImportFailureMessage(for result: CinderdeckConfigurationAutoImportResult) -> String {
    if let errorMessage = result.errorMessage {
      return errorMessage
    }

    if let firstIssue = result.importResult?.issues.first(where: { $0.severity == .error }) {
      return firstIssue.message
    }

    return L10n.PreferencesAdvanced.openConfigUnavailable
  }

  private var configAccessTitle: String {
    onboardingLocalization.string(
      "onboarding.config-access.title",
      defaultValue: "Set Up config.toml",
      comment: "Onboarding config access step title"
    )
  }

  private var configAccessSubtitle: String {
    onboardingLocalization.string(
      "onboarding.config-access.subtitle",
      defaultValue: "Cinderdeck uses a TOML file for portable settings, backups, and dotfile workflows.",
      comment: "Onboarding config access step subtitle"
    )
  }

  private var configFolderTitle: String {
    onboardingLocalization.string(
      "onboarding.config-access.folder-title",
      defaultValue: "Config Folder",
      comment: "Onboarding config access permission row title"
    )
  }

  private var configFolderCardDescription: String {
    onboardingLocalization.string(
      "onboarding.config-access.folder-card-description",
      defaultValue: "Required for config.toml",
      comment: "Short permission row description for config folder access"
    )
  }

  private var configFolderDescription: String {
    onboardingLocalization.string(
      "onboarding.config-access.folder-description",
      defaultValue: "Grant access once. Cinderdeck will create config.toml if needed and apply valid direct edits on launch.",
      comment: "Onboarding config access description."
    )
  }

  private var configAccessPrivacyNote: String {
    onboardingLocalization.string(
      "onboarding.config-access.privacy-note",
      defaultValue: "This only grants Cinderdeck access to its config folder. It does not import secrets or scan your files.",
      comment: "Privacy note on onboarding config access step"
    )
  }

  private var setupSuccessMessage: String {
    onboardingLocalization.string(
      "onboarding.config-access.ready",
      defaultValue: "config.toml is ready.",
      comment: "Success message after config folder access is granted"
    )
  }

  private var configAccessLaterTitle: String {
    onboardingLocalization.string(
      "onboarding.config-access.later",
      defaultValue: "Later",
      comment: "Secondary action to skip config access setup for now"
    )
  }

  private var grantAccessTitle: String {
    onboardingLocalization.string(
      "onboarding.permissions.grant-access",
      defaultValue: "Grant Access",
      comment: "Button title to grant permission or folder access"
    )
  }

  private var commonContinueTitle: String {
    onboardingLocalization.string(
      "common.continue",
      defaultValue: "Continue",
      comment: "Continue button title"
    )
  }
}

private struct ConfigAccessDetailsView: View {
  let directoryPath: String
  let description: String
  let privacyNote: String

  var body: some View {
    VStack(spacing: 8) {
      Text("\(description) \(privacyNote)")
        .font(.caption)
        .foregroundStyle(VSDesignSystem.Colors.tertiary)
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)

      Text(directoryPath)
        .font(.caption.monospaced())
        .foregroundStyle(VSDesignSystem.Colors.quaternary)
        .lineLimit(1)
        .truncationMode(.middle)
        .multilineTextAlignment(.center)
    }
    .frame(maxWidth: 420, alignment: .center)
  }
}

#Preview {
  ConfigAccessView(onComplete: {}, onSkip: {})
    .environmentObject(OnboardingLocalizationController())
    .frame(width: 620, height: 560)
    .background(OnboardingSurfaceBackground())
}
