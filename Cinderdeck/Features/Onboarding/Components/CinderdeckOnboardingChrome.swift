//
//  CinderdeckOnboardingChrome.swift
//  Cinderdeck
//
//  Header brand mark, language selector, close button, and footer escape affordance.
//

import AppKit
import SwiftUI

// MARK: - Overline

struct CinderdeckOnboardingOverline: View {
  var text: String
  var tint: Color = CinderdeckGlassInk.muted

  init(_ text: String, tint: Color = CinderdeckGlassInk.muted) {
    self.text = text
    self.tint = tint
  }

  var body: some View {
    Text(text.uppercased())
      .font(.system(size: CinderdeckOnboardingType.sectionLabel, weight: .semibold))
      .tracking(1.3)
      .foregroundStyle(tint)
  }
}

// MARK: - Close Button

struct CinderdeckOnboardingCloseButton: View {
  var action: () -> Void

  @State private var isHovered = false

  var body: some View {
    Button(action: action) {
      Image(systemName: "xmark")
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(isHovered ? CinderdeckGlassInk.primary : CinderdeckGlassInk.muted)
        .frame(width: 28, height: 28)
        .background(
          Circle()
            .fill(Color.white.opacity(isHovered ? 0.16 : 0.08))
            .overlay(Circle().strokeBorder(Color.white.opacity(0.10), lineWidth: 0.5))
        )
    }
    .buttonStyle(.plain)
    .onHover { hovering in
      withAnimation(CinderdeckMotionPreferences.shared.spec(.hover).animation) {
        isHovered = hovering
      }
    }
    .accessibilityLabel(L10n.Onboarding.chromeCloseAccessibility)
  }
}

// MARK: - Language Picker Pill

struct CinderdeckOnboardingLanguagePicker: View {
  @EnvironmentObject private var onboardingLocalization: OnboardingLocalizationController

  var body: some View {
    Menu {
      Button {
        onboardingLocalization.selectLanguage("")
      } label: {
        HStack {
          Text(L10n.Onboarding.chromeLanguageAutoSystem)
          if onboardingLocalization.selectedLanguageIdentifier.isEmpty {
            Image(systemName: "checkmark")
          }
        }
      }

      Divider()

      ForEach(onboardingLocalization.availableOptions) { option in
        Button {
          onboardingLocalization.selectLanguage(option.identifier)
        } label: {
          HStack {
            Text(option.displayName)
            if onboardingLocalization.selectedLanguageIdentifier == option.identifier {
              Image(systemName: "checkmark")
            }
          }
        }
      }
    } label: {
      HStack(spacing: CinderdeckSpace.sm) {
        Image(systemName: "globe")
          .font(.system(size: 11, weight: .medium))
          .foregroundStyle(CinderdeckGlassInk.muted)

        Text(currentLanguageLabel)
          .font(.system(size: CinderdeckOnboardingType.caption, weight: .medium))
          .foregroundStyle(CinderdeckGlassInk.body)

        Image(systemName: "chevron.down")
          .font(.system(size: 8, weight: .semibold))
          .foregroundStyle(CinderdeckGlassInk.muted)
      }
      .padding(.horizontal, CinderdeckSpace.lg)
      .frame(height: 28)
      .background(
        Capsule()
          .fill(Color.white.opacity(0.08))
          .overlay(Capsule().strokeBorder(Color.white.opacity(0.12), lineWidth: 0.5))
      )
    }
    .menuStyle(.borderlessButton)
    .fixedSize()
  }

  private var currentLanguageLabel: String {
    if onboardingLocalization.selectedLanguageIdentifier.isEmpty {
      return onboardingLocalization.systemResolvedOption?.displayName ?? L10n.Onboarding.chromeLanguageAuto
    }
    return onboardingLocalization.availableOptions.first(where: { $0.identifier == onboardingLocalization.selectedLanguageIdentifier })?.displayName ?? L10n.Onboarding.chromeLanguageLabel
  }
}

// MARK: - Escape Hint

struct CinderdeckOnboardingEscapeHint: View {
  var text: String

  var body: some View {
    HStack(spacing: CinderdeckSpace.md) {
      CinderdeckKeycapChip(label: "esc")
      Text(text)
        .font(.system(size: CinderdeckOnboardingType.caption))
        .foregroundStyle(CinderdeckGlassInk.muted)
    }
  }
}
