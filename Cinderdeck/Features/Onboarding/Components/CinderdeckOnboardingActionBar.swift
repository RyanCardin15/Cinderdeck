//
//  CinderdeckOnboardingActionBar.swift
//  Cinderdeck
//
//  Rounded-full capsule Liquid Glass Action Bar with tactile spring button feedback.
//

import SwiftUI

struct CinderdeckOnboardingActionBar: View {
  var skipTitle: String? = nil
  var continueTitle: String
  var continueKey: String? = nil
  var isContinueEnabled: Bool = true
  var isBusy: Bool = false
  var minWidth: CGFloat? = nil
  var onSkip: (() -> Void)? = nil
  var onContinue: () -> Void

  private let barHeight: CGFloat = 40

  var body: some View {
    HStack(spacing: 0) {
      if let skipTitle, let onSkip {
        CinderdeckOnboardingBarSegment(
          title: skipTitle,
          trailingKey: nil,
          isEnabled: true,
          isBusy: false,
          action: onSkip
        )

        // Etched vertical hairline divider
        Rectangle()
          .fill(
            LinearGradient(
              colors: [
                Color.white.opacity(0.0),
                Color.white.opacity(0.18),
                Color.white.opacity(0.0),
              ],
              startPoint: .top,
              endPoint: .bottom
            )
          )
          .frame(width: CinderdeckSurfaceGlass.specularLineWidth, height: 18)
          .padding(.horizontal, 2)
      }

      CinderdeckOnboardingBarSegment(
        title: continueTitle,
        trailingKey: continueKey,
        isEnabled: isContinueEnabled,
        isBusy: isBusy,
        action: onContinue
      )
    }
    .padding(3.5)
    .frame(height: barHeight)
    .frame(minWidth: minWidth)
    .background {
      CinderdeckGlassSurface(
        shape: Capsule(style: .continuous),
        substrate: CinderdeckSurfaceGlass.baseDarkness,
        tint: 0.04
      )
    }
    .clipShape(Capsule(style: .continuous))
    .shadow(color: Color.black.opacity(0.20), radius: 12, y: 5)
    .shadow(color: Color.black.opacity(0.10), radius: 2, y: 1)
    .animation(CinderdeckMotionPreferences.shared.spec(.settle).animation, value: isContinueEnabled)
  }
}

private struct CinderdeckOnboardingBarSegment: View {
  var title: String
  var trailingKey: String?
  var isEnabled: Bool = true
  var isBusy: Bool = false
  var action: () -> Void

  @State private var isHovered = false

  var body: some View {
    Button(action: {
      guard isEnabled, !isBusy else { return }
      action()
    }) {
      HStack(spacing: CinderdeckSpace.sm) {
        if isBusy {
          ProgressView()
            .controlSize(.small)
            .tint(CinderdeckGlassInk.primary)
        }

        Text(title)
          .font(.system(
            size: CinderdeckOnboardingType.body + 1,
            weight: (isHovered && isEnabled) ? .semibold : .medium
          ))
          .foregroundStyle(
            !isEnabled
              ? Color.white.opacity(0.30)
              : (isHovered ? CinderdeckGlassInk.primary : CinderdeckGlassInk.body)
          )

        if let trailingKey, !isBusy {
          CinderdeckKeycapChip(label: trailingKey, emphasis: isHovered && isEnabled)
            .opacity(isEnabled ? 1.0 : 0.35)
        }
      }
      .padding(.horizontal, CinderdeckSpace.xl + 1)
      .frame(maxHeight: .infinity)
      .background { segmentSurface }
      .contentShape(Capsule(style: .continuous))
    }
    .buttonStyle(CinderdeckInteractiveButtonStyle(isEnabled: isEnabled && !isBusy))
    .disabled(!isEnabled || isBusy)
    .onHover { hovering in
      guard isEnabled, !isBusy else {
        isHovered = false
        return
      }
      withAnimation(CinderdeckMotionPreferences.shared.spec(.hover).animation) {
        isHovered = hovering
      }
    }
    .animation(CinderdeckMotionPreferences.shared.spec(.settle).animation, value: isEnabled)
  }

  @ViewBuilder
  private var segmentSurface: some View {
    if isHovered && isEnabled {
      CinderdeckGlassSurface(
        shape: Capsule(style: .continuous),
        substrate: CinderdeckSurfaceGlass.controlSubstrateHover,
        tint: 0.10,
        highlight: .custom(top: 0.24, bottom: 0.08)
      )
    }
  }
}

private struct CinderdeckInteractiveButtonStyle: ButtonStyle {
  var isEnabled: Bool = true

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .scaleEffect((configuration.isPressed && isEnabled) ? 0.96 : 1.0)
      .animation(.spring(response: 0.18, dampingFraction: 0.8), value: configuration.isPressed)
  }
}
