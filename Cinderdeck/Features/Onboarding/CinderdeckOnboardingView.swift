//
//  CinderdeckOnboardingView.swift
//  Cinderdeck
//
//  Ruru-inspired interactive walkthrough view for Cinderdeck, compatible with macOS 13.0+.
//

import SwiftUI

struct CinderdeckOnboardingView: View {
  var onDismiss: () -> Void

  @StateObject private var state = CinderdeckOnboardingState()
  @State private var isShowingCompletion = false
  @EnvironmentObject private var onboardingLocalization: OnboardingLocalizationController

  var body: some View {
    ZStack(alignment: .topLeading) {
      CinderdeckGlassWindowBackdrop()

      if isShowingCompletion {
        VStack(spacing: 0) {
          header
            .frame(height: CinderdeckOnboardingMetrics.headerHeight)
            .padding(.top, CinderdeckOnboardingMetrics.gutter)
            .padding(.horizontal, CinderdeckOnboardingMetrics.gutter)

          CinderdeckOnboardingCompletionCard(onFinish: finish, onBack: retreat)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
            .padding(.bottom, CinderdeckOnboardingMetrics.gutter)
            .padding(.horizontal, CinderdeckOnboardingMetrics.gutter)
        }
        .transition(
          .asymmetric(
            insertion: .opacity.combined(with: .scale(scale: 0.97)),
            removal: .opacity.combined(with: .scale(scale: 0.97))
          )
        )
      } else if state.currentStep.usesWideLayout {
        // Full-width layout for permissions step
        VStack(spacing: 0) {
          header
            .frame(height: CinderdeckOnboardingMetrics.headerHeight)
            .padding(.top, CinderdeckOnboardingMetrics.gutter)
            .padding(.horizontal, CinderdeckOnboardingMetrics.gutter)

          CinderdeckOnboardingPermissionsView(state: state)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .padding(.top, 24)
            .padding(.bottom, 16)
            .padding(.horizontal, CinderdeckOnboardingMetrics.gutter)

          footer
            .frame(height: CinderdeckOnboardingMetrics.footerHeight)
            .padding(.bottom, CinderdeckOnboardingMetrics.gutter)
            .padding(.horizontal, CinderdeckOnboardingMetrics.gutter)
        }
        .transition(
          .asymmetric(
            insertion: .opacity.combined(with: .offset(x: 16)),
            removal: .opacity.combined(with: .offset(x: -16))
          )
        )
      } else {
        // Two-column layout: Left instruction rail + Right full-bleed mock stage
        VStack(spacing: 0) {
          header
            .frame(height: CinderdeckOnboardingMetrics.headerHeight)
            .padding(.top, CinderdeckOnboardingMetrics.gutter)
            .padding(.horizontal, CinderdeckOnboardingMetrics.gutter)

          HStack(alignment: .top, spacing: 0) {
            // Left Column
            VStack(alignment: .leading, spacing: 0) {
              CinderdeckOnboardingInstructionPanel(state: state)
                .padding(.top, 20)

              Spacer(minLength: 16)

              CinderdeckOnboardingEscapeHint(text: escapeHintText)
                .frame(height: CinderdeckOnboardingMetrics.footerHeight, alignment: .leading)
                .padding(.bottom, CinderdeckOnboardingMetrics.gutter)
            }
            .frame(width: CinderdeckOnboardingMetrics.railWidth, alignment: .leading)
            .padding(.leading, CinderdeckOnboardingMetrics.gutter)
            .padding(.trailing, CinderdeckOnboardingMetrics.columnGap)

            // Right Column: Mockup Stage with Floating Action Bar
            ZStack(alignment: .bottomTrailing) {
              CinderdeckOnboardingMockHost(state: state)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(.top, 14)

              floatingActionBarWithHint
                .padding(.trailing, CinderdeckOnboardingMetrics.gutter)
                .padding(.bottom, CinderdeckOnboardingMetrics.gutter)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
          }
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .transition(
          .asymmetric(
            insertion: .opacity.combined(with: .offset(x: 16)),
            removal: .opacity.combined(with: .offset(x: -16))
          )
        )
      }
    }
    .frame(
      minWidth: CinderdeckOnboardingMetrics.minSize.width,
      maxWidth: CinderdeckOnboardingMetrics.maxSize.width,
      minHeight: CinderdeckOnboardingMetrics.minSize.height,
      maxHeight: CinderdeckOnboardingMetrics.maxSize.height
    )
    .environment(\.colorScheme, .dark)
    .background(keyboardShortcuts)
    .animation(CinderdeckMotionPreferences.shared.spec(.morph).animation, value: state.currentStep)
  }

  // MARK: - Header

  private var header: some View {
    HStack(spacing: 0) {
      brand

      Spacer(minLength: CinderdeckSpace.xxl)

      HStack(spacing: CinderdeckSpace.md) {
        CinderdeckOnboardingLanguagePicker()
        CinderdeckOnboardingCloseButton(action: finish)
      }
    }
    .overlay(CinderdeckOnboardingStepRail(state: state))
  }

  private var brand: some View {
    HStack(spacing: CinderdeckSpace.xl) {
      Image(nsImage: NSApp.applicationIconImage)
        .resizable()
        .aspectRatio(contentMode: .fit)
        .frame(width: 32, height: 32)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))

      Text("Cinderdeck")
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(CinderdeckGlassInk.primary)
    }
  }

  // MARK: - Actions & Footer

  private var escapeHintText: String {
    state.canGoBack ? L10n.Onboarding.goBackHint : L10n.Onboarding.closeHint
  }

  private var actionBar: some View {
    let isLastStep = !state.canGoForward
    let skipTitle: String? = isLastStep ? nil : L10n.Onboarding.actionSkip
    let skipAction: (() -> Void)? = isLastStep ? nil : { skip() }
    let canAdvance = state.isCurrentStepComplete || isLastStep

    return CinderdeckOnboardingActionBar(
      skipTitle: skipTitle,
      continueTitle: isLastStep ? L10n.Onboarding.actionFinish : L10n.Onboarding.actionContinue,
      continueKey: "\u{21A9}",
      isContinueEnabled: canAdvance,
      onSkip: skipAction,
      onContinue: advance
    )
  }

  private var floatingActionBarWithHint: some View {
    VStack(alignment: .trailing, spacing: 6) {
      if state.canGoForward && state.isCurrentStepComplete {
        CinderdeckCurvedHintArrow(
          text: L10n.Onboarding.continueHint,
          orientation: .curveDownToTarget,
          arrowAlignment: .trailing,
          color: .white
        )
        .padding(.trailing, 8)
        .transition(
          .asymmetric(
            insertion: .scale(scale: 0.90, anchor: .bottomTrailing).combined(with: .opacity),
            removal: .scale(scale: 0.95, anchor: .bottomTrailing).combined(with: .opacity)
          )
        )
      }

      actionBar
    }
    .animation(CinderdeckMotionPreferences.shared.spec(.settle).animation, value: state.isCurrentStepComplete)
  }

  private var footer: some View {
    HStack(spacing: CinderdeckSpace.xxl) {
      CinderdeckOnboardingEscapeHint(text: escapeHintText)
      Spacer(minLength: CinderdeckSpace.xxl)
      actionBar
    }
  }

  // MARK: - Keyboard Shortcuts

  private var keyboardShortcuts: some View {
    ZStack {
      Button("", action: advance)
        .keyboardShortcut(.defaultAction)

      Button("", action: retreat)
        .keyboardShortcut(.cancelAction)
    }
    .opacity(0)
    .frame(width: 0, height: 0)
    .accessibilityHidden(true)
  }

  // MARK: - Navigation

  private func advance() {
    guard state.canGoForward else {
      withAnimation(CinderdeckMotionPreferences.shared.spec(.settle).animation) {
        isShowingCompletion = true
      }
      return
    }
    state.markCurrentStepVisited()
    state.nextStep()
  }

  private func skip() {
    guard state.canGoForward else {
      withAnimation(CinderdeckMotionPreferences.shared.spec(.settle).animation) {
        isShowingCompletion = true
      }
      return
    }
    state.nextStep()
  }

  private func retreat() {
    if isShowingCompletion {
      withAnimation(CinderdeckMotionPreferences.shared.spec(.settle).animation) {
        isShowingCompletion = false
      }
    } else if state.canGoBack {
      state.previousStep()
    } else {
      finish()
    }
  }

  private func finish() {
    UserDefaults.standard.set(true, forKey: PreferencesKeys.onboardingCompleted)
    UserDefaults.standard.set(true, forKey: PreferencesKeys.splashSkipped)
    UserDefaults.standard.set(true, forKey: PreferencesKeys.sponsorPromptSeen)
    UserDefaults.standard.removeObject(forKey: PreferencesKeys.onboardingActiveStep)

    let isUnderXCTest = ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
    let requiresRelaunch = !isUnderXCTest && (ScreenCaptureManager.shared.requiresRelaunchToActivate || onboardingLocalization.requiresRelaunchOnCompletion)
    onboardingLocalization.commitLanguageSelection()

    if requiresRelaunch {
      UserDefaults.standard.set(true, forKey: PreferencesKeys.splashSkipOnceAfterOnboardingRelaunch)
      Task {
        try? await Task.sleep(for: .milliseconds(150))
        try? await onboardingLocalization.relaunchApplication()
      }
    }

    onDismiss()
  }
}
