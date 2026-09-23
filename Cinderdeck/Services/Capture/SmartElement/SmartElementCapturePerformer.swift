//
//  SmartElementCapturePerformer.swift
//  Cinderdeck
//
//  Routes committed smart-element rects into the normal screenshot pipeline.
//

import CoreGraphics
import Foundation

@MainActor
final class SmartElementCapturePerformer: SmartElementCapturePerforming {
  private let viewModelProvider: @MainActor () -> ScreenCaptureViewModel?

  init(viewModelProvider: (@MainActor () -> ScreenCaptureViewModel?)? = nil) {
    self.viewModelProvider = viewModelProvider ?? {
      AppStatusBarController.shared.screenCaptureViewModel
    }
  }

  func captureRect(_ rect: CGRect) async {
    guard let viewModel = viewModelProvider() else {
      DiagnosticLogger.shared.log(
        .warning,
        .capture,
        "Smart element capture skipped: screen capture view model unavailable"
      )
      return
    }
    await viewModel.captureSmartElement(rect: rect)
  }
}
