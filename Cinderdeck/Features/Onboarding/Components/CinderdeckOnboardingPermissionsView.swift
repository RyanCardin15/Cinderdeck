//
//  CinderdeckOnboardingPermissionsView.swift
//  Cinderdeck
//
//  Step 4 full-width permissions grid with promises, assurances, live TCC checks, and privacy band.
//

import ApplicationServices
import AVFoundation
import SwiftUI

struct CinderdeckOnboardingPermissionsView: View {
  @ObservedObject var state: CinderdeckOnboardingState

  @ObservedObject private var screenCaptureManager = ScreenCaptureManager.shared
  @ObservedObject private var identityManager = AppIdentityManager.shared
  private let fileAccessManager = SandboxFileAccessManager.shared

  @State private var microphoneGranted = false
  @State private var accessibilityGranted = false
  @State private var exportFolderGranted = false
  @State private var probeTimer: Timer? = nil

  var body: some View {
    VStack(alignment: .leading, spacing: 24) {
      headline

      LazyVGrid(
        columns: Array(
          repeating: GridItem(.flexible(), spacing: CinderdeckSpace.xxl, alignment: .top),
          count: 3
        ),
        spacing: CinderdeckSpace.xxl
      ) {
        // 1. Screen Recording
        PermissionCard(
          title: L10n.Onboarding.screenRecording,
          isRequired: true,
          promise: L10n.Onboarding.permissionsScreenRecordingPromise,
          assurances: [
            L10n.Onboarding.permissionsScreenRecordingAssurance1,
            L10n.Onboarding.permissionsScreenRecordingAssurance2,
            L10n.Onboarding.permissionsScreenRecordingAssurance3,
          ],
          isGranted: screenCaptureManager.hasPermission,
          actionTitle: L10n.Onboarding.permissionsScreenRecordingAction,
          onAction: {
            Task {
              _ = await screenCaptureManager.requestPermission()
              await refreshPermissions()
            }
          }
        )

        // 2. Save Location
        PermissionCard(
          title: L10n.Onboarding.saveFolder,
          isRequired: true,
          promise: L10n.Onboarding.permissionsSaveFolderPromise,
          assurances: [
            L10n.Onboarding.permissionsSaveFolderAssurance1,
            L10n.Onboarding.permissionsSaveFolderAssurance2,
            L10n.Onboarding.permissionsSaveFolderAssurance3,
          ],
          isGranted: exportFolderGranted,
          actionTitle: L10n.Onboarding.permissionsSaveFolderAction,
          onAction: {
            requestExportFolder()
          }
        )

        // 3. Accessibility & Global Shortcuts
        PermissionCard(
          title: L10n.Onboarding.accessibility,
          isRequired: false,
          promise: L10n.Onboarding.permissionsAccessibilityPromise,
          assurances: [
            L10n.Onboarding.permissionsAccessibilityAssurance1,
            L10n.Onboarding.permissionsAccessibilityAssurance2,
            L10n.Onboarding.permissionsAccessibilityAssurance3,
          ],
          isGranted: accessibilityGranted,
          actionTitle: L10n.Onboarding.permissionsAccessibilityAction,
          onAction: {
            requestAccessibility()
          }
        )
      }

      privacyBand

      Spacer(minLength: 0)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .onAppear {
      startProbeTimer()
      Task { await refreshPermissions() }
    }
    .onDisappear {
      stopProbeTimer()
    }
    .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
      Task { await refreshPermissions() }
    }
    .onChange(of: screenCaptureManager.hasPermission) { hasPermission in
      if hasPermission {
        stopProbeTimer()
      }
    }
  }

  // MARK: - Headline

  private var headline: some View {
    VStack(alignment: .leading, spacing: CinderdeckSpace.xl) {
      Text(state.currentStep.title)
        .font(.system(size: CinderdeckOnboardingType.display - 4, weight: .bold))
        .tracking(-0.5)
        .foregroundStyle(CinderdeckGlassInk.primary)

      VStack(alignment: .leading, spacing: CinderdeckSpace.md) {
        Text(state.currentStep.subtitle)
          .font(.system(size: CinderdeckOnboardingType.lede))
          .foregroundStyle(CinderdeckGlassInk.body)

        Text(L10n.Onboarding.permissionsAdjustAnytime)
          .font(.system(size: CinderdeckOnboardingType.lede))
          .foregroundStyle(CinderdeckGlassInk.muted)
      }
      .fixedSize(horizontal: false, vertical: true)
    }
  }

  // MARK: - Privacy Band

  private var privacyBand: some View {
    VStack(alignment: .leading, spacing: CinderdeckSpace.xl) {
      CinderdeckOnboardingOverline(L10n.Onboarding.permissionsPrivacyOverline)

      HStack(alignment: .top, spacing: CinderdeckSpace.xxl + CinderdeckSpace.xs) {
        PrivacyPromise(
          symbol: "hand.tap",
          title: L10n.Onboarding.permissionsPrivacyTriggerTitle,
          detail: L10n.Onboarding.permissionsPrivacyTriggerDetail
        )

        PrivacyPromise(
          symbol: "lock.shield",
          title: L10n.Onboarding.permissionsPrivacyLocalTitle,
          detail: L10n.Onboarding.permissionsPrivacyLocalDetail
        )

        PrivacyPromise(
          symbol: "arrow.uturn.backward",
          title: L10n.Onboarding.permissionsPrivacySettingsTitle,
          detail: L10n.Onboarding.permissionsPrivacySettingsDetail
        )
      }
    }
    .padding(CinderdeckSpace.xxl)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: CinderdeckRadius.card + 2, style: .continuous)
        .fill(Color.white.opacity(0.035))
        .overlay(
          RoundedRectangle(cornerRadius: CinderdeckRadius.card + 2, style: .continuous)
            .strokeBorder(Color.white.opacity(0.08), lineWidth: 0.5)
        )
    )
  }

  // MARK: - Actions

  private func refreshPermissions() async {
    fileAccessManager.ensureExportLocationInitialized()
    AppIdentityManager.shared.refresh()
    await screenCaptureManager.checkPermission()
    accessibilityGranted = AXIsProcessTrusted()
    exportFolderGranted = fileAccessManager.hasPersistedExportPermission
    microphoneGranted = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized

    state.setChallenge(.grantScreenRecording, completed: screenCaptureManager.hasPermission)
    state.setChallenge(.grantSaveFolder, completed: exportFolderGranted)
    state.setChallenge(.grantAccessibility, completed: accessibilityGranted)
  }

  private func requestExportFolder() {
    _ = fileAccessManager.chooseExportDirectory(
      message: "Choose a folder for Cinderdeck captures (default: Desktop/Cinderdeck)",
      prompt: "Grant Access",
      directoryURL: fileAccessManager.defaultExportDirectory
    )
    Task { await refreshPermissions() }
  }

  private func requestAccessibility() {
    if AXIsProcessTrusted() {
      accessibilityGranted = true
      return
    }
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    _ = AXIsProcessTrustedWithOptions(options)
    Task { await refreshPermissions() }
  }

  // MARK: - Probe Timer

  private func startProbeTimer() {
    stopProbeTimer()
    guard !screenCaptureManager.hasPermission else { return }
    probeTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak screenCaptureManager] timer in
      guard let screenCaptureManager else {
        timer.invalidate()
        return
      }
      if screenCaptureManager.hasPermission {
        timer.invalidate()
        return
      }
      Task { @MainActor in
        await refreshPermissions()
      }
    }
  }

  private func stopProbeTimer() {
    probeTimer?.invalidate()
    probeTimer = nil
  }
}

// MARK: - Permission Card

private struct PermissionCard: View {
  var title: String
  var isRequired: Bool
  var promise: String
  var assurances: [String]
  var isGranted: Bool
  var actionTitle: String
  var onAction: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: CinderdeckSpace.xl) {
      HStack(spacing: CinderdeckSpace.md) {
        CinderdeckOnboardingOverline(title)
        badge
        Spacer(minLength: 0)
      }

      Text(promise)
        .font(.system(size: CinderdeckOnboardingType.lede - 1.5, weight: .semibold))
        .foregroundStyle(CinderdeckGlassInk.primary)
        .fixedSize(horizontal: false, vertical: true)

      VStack(alignment: .leading, spacing: CinderdeckSpace.lg) {
        ForEach(assurances, id: \.self) { item in
          HStack(alignment: .top, spacing: CinderdeckSpace.md) {
            Image(systemName: "checkmark.circle")
              .font(.system(size: 11))
              .foregroundStyle(CinderdeckGlassInk.faint)

            Text(item)
              .font(.system(size: CinderdeckOnboardingType.caption))
              .foregroundStyle(CinderdeckGlassInk.body)
              .lineSpacing(3)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
      }

      Spacer(minLength: CinderdeckSpace.lg)

      // Status button row
      if isGranted {
        HStack(spacing: CinderdeckSpace.md) {
          Image(systemName: "checkmark.circle.fill")
            .font(.system(size: 14))
            .foregroundStyle(Color.green)

          Text(L10n.Onboarding.permissionsStatusGranted)
            .font(.system(size: CinderdeckOnboardingType.body, weight: .medium))
            .foregroundStyle(CinderdeckGlassInk.body)
        }
      } else {
        Button(action: onAction) {
          Text(actionTitle)
            .font(.system(size: CinderdeckOnboardingType.body, weight: .semibold))
            .foregroundStyle(CinderdeckGlassInk.primary)
            .padding(.horizontal, CinderdeckSpace.xl)
            .frame(height: 32)
            .background(
              RoundedRectangle(cornerRadius: CinderdeckRadius.control, style: .continuous)
                .fill(Color.white.opacity(0.14))
                .overlay(
                  RoundedRectangle(cornerRadius: CinderdeckRadius.control, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.16), lineWidth: 0.5)
                )
            )
        }
        .buttonStyle(.plain)
      }
    }
    .padding(CinderdeckSpace.xxl)
    .frame(maxWidth: .infinity, minHeight: 250, alignment: .topLeading)
    .background(
      RoundedRectangle(cornerRadius: CinderdeckRadius.card + 2, style: .continuous)
        .fill(Color.white.opacity(0.05))
        .overlay(
          RoundedRectangle(cornerRadius: CinderdeckRadius.card + 2, style: .continuous)
            .strokeBorder(Color.white.opacity(0.10), lineWidth: 0.5)
        )
    )
    .animation(CinderdeckMotionPreferences.shared.spec(.settle).animation, value: isGranted)
  }

  private var badge: some View {
    Text(isRequired ? L10n.Onboarding.permissionsBadgeRequired : L10n.Onboarding.permissionsBadgeOptional)
      .font(.system(size: 9, weight: .bold))
      .tracking(0.8)
      .foregroundStyle(CinderdeckGlassInk.body)
      .padding(.horizontal, CinderdeckSpace.md)
      .padding(.vertical, 3)
      .background(
        Capsule().fill(Color.white.opacity(isRequired ? 0.12 : 0.07))
      )
  }
}

private struct PrivacyPromise: View {
  var symbol: String
  var title: String
  var detail: String

  var body: some View {
    HStack(alignment: .top, spacing: CinderdeckSpace.xl) {
      Image(systemName: symbol)
        .font(.system(size: 13))
        .foregroundStyle(CinderdeckGlassInk.body)
        .frame(width: 26, height: 26)
        .background(
          RoundedRectangle(cornerRadius: 7, style: .continuous)
            .fill(Color.white.opacity(0.10))
        )

      VStack(alignment: .leading, spacing: CinderdeckSpace.sm) {
        Text(title)
          .font(.system(size: CinderdeckOnboardingType.body, weight: .semibold))
          .foregroundStyle(CinderdeckGlassInk.primary)

        Text(detail)
          .font(.system(size: CinderdeckOnboardingType.caption))
          .foregroundStyle(CinderdeckGlassInk.muted)
          .lineSpacing(3)
          .fixedSize(horizontal: false, vertical: true)
      }

      Spacer(minLength: 0)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}
