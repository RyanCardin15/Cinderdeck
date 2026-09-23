//
//  CinderdeckOnboardingStepRail.swift
//  Cinderdeck
//
//  Progress rail across the onboarding header, matching Ruru's step indicator design.
//

import SwiftUI

struct CinderdeckOnboardingStepRail: View {
  @ObservedObject var state: CinderdeckOnboardingState

  var body: some View {
    HStack(spacing: 0) {
      ForEach(Array(CinderdeckOnboardingStep.allCases.enumerated()), id: \.element) { index, step in
        if index > 0 {
          connector(leadingInto: step)
        }
        node(for: step)
      }
    }
    .animation(CinderdeckMotionPreferences.shared.spec(.settle).animation, value: state.currentStep)
  }

  // MARK: - Node

  private func node(for step: CinderdeckOnboardingStep) -> some View {
    let isCurrent = state.currentStep == step
    let isVisited = state.completedSteps.contains(step)
    let isReachable = isVisited || step.stepNumber <= state.currentStep.stepNumber

    return Button {
      guard isReachable else { return }
      state.transition(to: step)
    } label: {
      HStack(spacing: CinderdeckSpace.md) {
        marker(number: step.stepNumber, isCurrent: isCurrent, isVisited: isVisited)

        Text(step.shortTitle)
          .font(.system(size: CinderdeckOnboardingType.caption, weight: isCurrent ? .semibold : .medium))
          .foregroundStyle(isCurrent ? CinderdeckGlassInk.primary : CinderdeckGlassInk.muted)
          .fixedSize()
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(!isReachable)
    .help(isReachable ? "Go to \(step.shortTitle)" : "")
  }

  private func marker(number: Int, isCurrent: Bool, isVisited: Bool) -> some View {
    ZStack {
      Circle()
        .fill(Color.white.opacity(isCurrent ? 0.18 : 0.04))
        .overlay(
          Circle().strokeBorder(
            Color.white.opacity(isCurrent ? 0.85 : 0.22),
            lineWidth: isCurrent ? 1.2 : 1
          )
        )

      if isVisited && !isCurrent {
        Image(systemName: "checkmark")
          .font(.system(size: 9.5, weight: .bold))
          .foregroundStyle(CinderdeckGlassInk.body)
      } else {
        Text("\(number)")
          .font(.system(size: 11, weight: isCurrent ? .bold : .medium))
          .foregroundStyle(isCurrent ? CinderdeckGlassInk.primary : CinderdeckGlassInk.muted)
      }
    }
    .frame(width: 24, height: 24)
  }

  // MARK: - Connector

  private func connector(leadingInto step: CinderdeckOnboardingStep) -> some View {
    let isTraversed = step.stepNumber <= state.currentStep.stepNumber

    return Rectangle()
      .fill(Color.white.opacity(isTraversed ? 0.28 : 0.12))
      .frame(width: 26, height: 1)
      .padding(.horizontal, CinderdeckSpace.xl)
  }
}
