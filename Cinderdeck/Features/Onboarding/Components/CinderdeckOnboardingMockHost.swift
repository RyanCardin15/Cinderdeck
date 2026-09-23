//
//  CinderdeckOnboardingMockHost.swift
//  Cinderdeck
//
//  Right-column host viewport with continuous corner curve and deep drop shadows.
//

import SwiftUI

struct CinderdeckOnboardingMockHost: View {
  @ObservedObject var state: CinderdeckOnboardingState

  private var viewportShape: CinderdeckUnevenRoundedRectangle {
    CinderdeckUnevenRoundedRectangle(
      cornerRadii: CinderdeckCornerRadii(
        topLeading: 18,
        bottomLeading: 0,
        bottomTrailing: CinderdeckOnboardingMetrics.windowRadius,
        topTrailing: 0
      )
    )
  }

  var body: some View {
    ZStack {
      switch state.currentStep {
      case .meetCinderdeck:
        CinderdeckMockAreaCaptureView(state: state)
      case .quickAccess:
        CinderdeckMockQuickAccessView(state: state)
      case .shortcuts:
        CinderdeckMockShortcutsView(state: state)
      case .permissions:
        Color.clear
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .clipShape(viewportShape)
    .overlay(
      viewportShape.strokeBorder(
        LinearGradient(
          colors: [
            Color.white.opacity(0.24),
            Color.white.opacity(0.09),
            Color.white.opacity(0.02),
          ],
          startPoint: .topLeading,
          endPoint: .bottomTrailing
        ),
        lineWidth: 0.75
      )
    )
    .shadow(color: Color.black.opacity(0.38), radius: 28, x: -6, y: 8)
    .shadow(color: Color.black.opacity(0.16), radius: 6, x: -2, y: 2)
  }
}
