//
//  CinderdeckOnboardingInstructionPanel.swift
//  Cinderdeck
//
//  Left-column instruction panel carrying narrative, challenge checklist, and simulation prompt card.
//

import SwiftUI

struct CinderdeckOnboardingInstructionPanel: View {
  @ObservedObject var state: CinderdeckOnboardingState

  private var activeChallenge: CinderdeckOnboardingChallenge? {
    state.currentStep.challenges.first { !state.completedChallenges.contains($0) }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 28) {
      headline

      challengeChecklist

      if !state.currentStep.examplePrompt.isEmpty {
        promptCard
      }

      if !state.currentStep.tip.isEmpty {
        tip
      }

      Spacer(minLength: 0)
    }
    .frame(width: CinderdeckOnboardingMetrics.railWidth, alignment: .leading)
  }

  // MARK: - Headline

  private var headline: some View {
    VStack(alignment: .leading, spacing: CinderdeckSpace.xxl) {
      CinderdeckOnboardingOverline(L10n.Onboarding.stepIndicator(state.currentStep.stepNumber, CinderdeckOnboardingStep.allCases.count))

      Text(state.currentStep.title)
        .font(.system(size: CinderdeckOnboardingType.display, weight: .bold))
        .tracking(-0.6)
        .foregroundStyle(CinderdeckGlassInk.primary)
        .fixedSize(horizontal: false, vertical: true)

      Text(state.currentStep.subtitle)
        .font(.system(size: CinderdeckOnboardingType.lede))
        .foregroundStyle(CinderdeckGlassInk.body)
        .lineSpacing(6)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  // MARK: - Checklist

  private var challengeChecklist: some View {
    VStack(alignment: .leading, spacing: CinderdeckSpace.xxl - CinderdeckSpace.xxs) {
      ForEach(state.currentStep.challenges) { challenge in
        ChallengeRow(
          challenge: challenge,
          isDone: state.completedChallenges.contains(challenge),
          isActive: activeChallenge == challenge
        )
      }
    }
    .animation(CinderdeckMotionPreferences.shared.spec(.settle).animation, value: state.completedChallenges)
  }

  // MARK: - Prompt Card

  private var promptText: String {
    if state.currentStep == .meetCinderdeck {
      switch state.step1Stage {
      case .readyToCapture:
        return L10n.Onboarding.stepCapturePromptReady
      case .selectingArea:
        return L10n.Onboarding.stepCapturePromptSelecting
      case .quickAccessFloating:
        return L10n.Onboarding.stepCapturePromptFloating
      case .annotateWindowOpen:
        return L10n.Onboarding.stepCapturePromptOpen
      }
    } else if state.currentStep == .quickAccess {
      switch state.step2Stage {
      case .readyToRecord:
        return L10n.Onboarding.stepRecordingPromptReady
      case .prerecordArea:
        return L10n.Onboarding.stepRecordingPromptFramed
      case .recordingActive:
        return L10n.Onboarding.stepRecordingPromptActive(state.recordingSeconds)
      case .videoQuickAccess:
        return L10n.Onboarding.stepRecordingPromptFloating
      case .videoEditorOpen:
        return L10n.Onboarding.stepRecordingPromptOpen
      }
    } else if state.currentStep == .shortcuts {
      if state.hasConflict {
        return L10n.Onboarding.stepShortcutsPromptConflicts
      } else {
        return L10n.Onboarding.stepShortcutsPromptResolved
      }
    }
    return state.currentStep.examplePrompt
  }

  private var promptCard: some View {
    Button {
      switch state.currentStep {
      case .meetCinderdeck:
        switch state.step1Stage {
        case .readyToCapture:
          state.simulateAreaCapture()
        case .selectingArea:
          state.completeCaptureToQuickAccess()
        case .quickAccessFloating:
          state.openAnnotateFromQuickAccess()
        case .annotateWindowOpen:
          state.resetStep1Flow()
        }
      case .quickAccess:
        switch state.step2Stage {
        case .readyToRecord:
          state.simulateStartPrerecord()
        case .prerecordArea:
          state.simulateStartRecording()
        case .recordingActive:
          state.simulateFinishRecording()
        case .videoQuickAccess:
          state.openVideoEditorFromQuickAccess()
        case .videoEditorOpen:
          state.resetStep2Flow()
        }
      case .shortcuts:
        state.resolveShortcutConflicts()
      case .permissions:
        break
      }
    } label: {
      VStack(alignment: .leading, spacing: CinderdeckSpace.lg) {
        CinderdeckOnboardingOverline(L10n.Onboarding.demoOverline, tint: CinderdeckGlassInk.muted)

        Text(promptText)
          .font(.system(size: CinderdeckOnboardingType.lede - 0.5).italic())
          .foregroundStyle(CinderdeckGlassInk.primary.opacity(0.94))
          .multilineTextAlignment(.leading)
          .lineSpacing(4)
          .fixedSize(horizontal: false, vertical: true)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, CinderdeckSpace.xxl + CinderdeckSpace.xs)
      .padding(.vertical, CinderdeckSpace.xxl)
      .background(
        RoundedRectangle(cornerRadius: CinderdeckRadius.control, style: .continuous)
          .fill(Color.white.opacity(0.07))
          .overlay(
            RoundedRectangle(cornerRadius: CinderdeckRadius.control, style: .continuous)
              .strokeBorder(Color.white.opacity(0.12), lineWidth: 0.5)
          )
      )
      .contentShape(Rectangle())
    }
    .buttonStyle(CinderdeckPromptCardButtonStyle())
    .help(L10n.Onboarding.demoTooltip)
  }

  // MARK: - Tip

  private var tip: some View {
    HStack(alignment: .top, spacing: CinderdeckSpace.lg) {
      Image(systemName: "info.circle")
        .font(.system(size: 12))
        .foregroundStyle(CinderdeckGlassInk.faint)

      Text(state.currentStep.tip)
        .font(.system(size: CinderdeckOnboardingType.caption))
        .foregroundStyle(CinderdeckGlassInk.muted)
        .lineSpacing(3)
        .fixedSize(horizontal: false, vertical: true)
    }
  }
}

// MARK: - Challenge Row

private struct ChallengeRow: View {
  var challenge: CinderdeckOnboardingChallenge
  var isDone: Bool
  var isActive: Bool

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: CinderdeckSpace.xxl) {
      marker
        .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 5 }

      Text(challenge.label)
        .font(.system(size: CinderdeckOnboardingType.challenge, weight: isActive ? .semibold : .regular))
        .foregroundStyle(labelInk)
        .lineSpacing(3)
        .fixedSize(horizontal: false, vertical: true)

      Spacer(minLength: CinderdeckSpace.md)

      if !challenge.keys.isEmpty {
        CinderdeckKeycapRow(keys: challenge.keys, emphasis: isActive)
          .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 5 }
      }
    }
  }

  private var labelInk: Color {
    if isActive { return CinderdeckGlassInk.primary }
    if isDone { return CinderdeckGlassInk.body }
    return CinderdeckGlassInk.muted
  }

  @ViewBuilder
  private var marker: some View {
    ZStack {
      if isDone {
        Circle().fill(Color.accentColor)
        Image(systemName: "checkmark")
          .font(.system(size: 9, weight: .bold))
          .foregroundStyle(.white)
      } else {
        Circle()
          .strokeBorder(
            Color.white.opacity(isActive ? 0.75 : 0.24),
            lineWidth: isActive ? 1.5 : 1
          )
      }
    }
    .frame(width: 20, height: 20)
  }
}

private struct CinderdeckPromptCardButtonStyle: ButtonStyle {
  @State private var isHovered = false

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .overlay(
        RoundedRectangle(cornerRadius: CinderdeckRadius.control, style: .continuous)
          .fill(Color.white.opacity(configuration.isPressed ? 0.06 : (isHovered ? 0.04 : 0)))
      )
      .scaleEffect(configuration.isPressed ? 0.99 : 1.0)
      .onHover { hovering in
        withAnimation(CinderdeckMotionPreferences.shared.spec(.hover).animation) { isHovered = hovering }
      }
      .animation(.spring(response: 0.18, dampingFraction: 0.8), value: configuration.isPressed)
  }
}
