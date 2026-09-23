//
//  SmartElementCaptureController.swift
//  Cinderdeck
//
//  Standalone live overlay controller for Smart Element Capture.
//

import AppKit
import Carbon.HIToolbox
import Combine

@MainActor
final class SmartElementCaptureController: NSObject {
  static let shared = SmartElementCaptureController()

  private let snapshotProvider: SmartElementQueryProviding
  private let ownerResolver: SmartElementWindowOwnerResolving
  private let capturePerformer: SmartElementCapturePerforming
  private let windowFactory: (NSScreen) -> SmartElementOverlayWindowProviding

  private var windows: [CGDirectDisplayID: SmartElementOverlayWindowProviding] = [:]
  private var cancellables = Set<AnyCancellable>()
  private var screenChangeObserver: NSObjectProtocol?
  private var localKeyMonitor: Any?
  private var globalKeyMonitor: Any?
  private var previouslyActiveApplication: NSRunningApplication?
  private var isActive = false
  private var isCommitting = false

  init(
    snapshotProvider: SmartElementQueryProviding? = nil,
    ownerResolver: SmartElementWindowOwnerResolving? = nil,
    capturePerformer: SmartElementCapturePerforming? = nil,
    windowFactory: ((NSScreen) -> SmartElementOverlayWindowProviding)? = nil
  ) {
    self.snapshotProvider = snapshotProvider ?? SmartElementQueryService.shared
    self.ownerResolver = ownerResolver ?? SmartElementWindowOwnerResolver()
    self.capturePerformer = capturePerformer ?? SmartElementCapturePerformer()
    self.windowFactory = windowFactory ?? { SmartElementOverlayWindow(screen: $0) }
    super.init()
  }

  func startCapture() {
    guard !isActive else { return }
    guard snapshotProvider.ensureAccessibilityPermission() else { return }

    isActive = true
    isCommitting = false
    previouslyActiveApplication = NSWorkspace.shared.frontmostApplication
    buildWindowPool()
    subscribeToAXHighlights()
    observeScreenChanges()
    installEscapeMonitors()
    showWindows()

    DiagnosticLogger.shared.log(
      .info,
      .capture,
      "Smart element capture started",
      context: ["screenCount": "\(windows.count)"]
    )
  }

  func cancel() {
    guard isActive else { return }
    snapshotProvider.cancelPendingQueries()
    dismiss()
    restorePreviousApplication()
    DiagnosticLogger.shared.log(.info, .capture, "Smart element capture cancelled")
  }

  private func buildWindowPool() {
    for screen in NSScreen.screens {
      guard let displayID = screen.displayID else { continue }
      let window = windowFactory(screen)
      window.eventDelegate = self
      window.setFrame(screen.frame, display: true)
      window.updateBounds(screen.frame)
      windows[displayID] = window
    }
  }

  private func showWindows() {
    let cursor = NSEvent.mouseLocation
    let keyboardDisplayID = NSScreen.screens.first(where: { $0.frame.contains(cursor) })?.displayID
      ?? NSScreen.main?.displayID

    for (displayID, window) in windows {
      window.updateHighlight(nil)
      window.orderFrontRegardless()
      if displayID == keyboardDisplayID {
        window.makeKey()
        _ = window.makeFirstResponder(nil)
      }
    }
  }

  private func subscribeToAXHighlights() {
    snapshotProvider.elementDetectedPublisher
      .receive(on: DispatchQueue.main)
      .sink { [weak self] rect in
        MainActor.assumeIsolated {
          self?.routeHighlight(rect)
        }
      }
      .store(in: &cancellables)
  }

  private func routeHighlight(_ rect: CGRect?) {
    for window in windows.values {
      window.updateHighlight(rect)
    }
  }

  private func observeScreenChanges() {
    screenChangeObserver = NotificationCenter.default.addObserver(
      forName: NSApplication.didChangeScreenParametersNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated {
        self?.refreshWindowPool()
      }
    }
  }

  private func refreshWindowPool() {
    guard isActive else { return }
    let currentDisplayIDs = Set(NSScreen.screens.compactMap(\.displayID))
    for displayID in Set(windows.keys).subtracting(currentDisplayIDs) {
      windows[displayID]?.close()
      windows.removeValue(forKey: displayID)
    }

    for screen in NSScreen.screens {
      guard let displayID = screen.displayID else { continue }
      let window = windows[displayID] ?? windowFactory(screen)
      window.eventDelegate = self
      window.setFrame(screen.frame, display: true)
      window.updateBounds(screen.frame)
      window.orderFrontRegardless()
      windows[displayID] = window
    }
  }

  private func installEscapeMonitors() {
    localKeyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
      guard event.keyCode == UInt16(kVK_Escape) else { return event }
      Task { @MainActor in self?.cancel() }
      return nil
    }
    globalKeyMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
      guard event.keyCode == UInt16(kVK_Escape) else { return }
      Task { @MainActor in self?.cancel() }
    }
  }

  private func commit(_ rect: CGRect) {
    guard isActive, !isCommitting else { return }
    isCommitting = true
    dismiss()
    Task { @MainActor in
      await capturePerformer.captureRect(rect)
      restorePreviousApplication()
    }
  }

  private func dismiss() {
    for window in windows.values {
      window.updateHighlight(nil)
      window.orderOut(nil)
      window.close()
      window.eventDelegate = nil
    }
    windows.removeAll()
    cancellables.removeAll()
    removeEscapeMonitors()
    if let screenChangeObserver {
      NotificationCenter.default.removeObserver(screenChangeObserver)
      self.screenChangeObserver = nil
    }
    isActive = false
  }

  private func removeEscapeMonitors() {
    if let localKeyMonitor {
      NSEvent.removeMonitor(localKeyMonitor)
      self.localKeyMonitor = nil
    }
    if let globalKeyMonitor {
      NSEvent.removeMonitor(globalKeyMonitor)
      self.globalKeyMonitor = nil
    }
  }

  private func restorePreviousApplication() {
    previouslyActiveApplication?.activate(options: [])
    previouslyActiveApplication = nil
  }
}

extension SmartElementCaptureController: SmartElementOverlayWindowDelegate {
  func smartElementOverlayWindow(_ window: SmartElementOverlayWindowProviding, mouseMovedAt point: CGPoint) {
    snapshotProvider.updateMouseLocation(pid: ownerResolver.resolveOwner(at: point)?.pid)
  }

  func smartElementOverlayWindow(_ window: SmartElementOverlayWindowProviding, mouseDownAt point: CGPoint) {
    guard let rect = window.currentHighlightRect, rect.contains(point) else {
      cancel()
      return
    }
    commit(rect)
  }

  func smartElementOverlayWindowDidCancel(_ window: SmartElementOverlayWindowProviding) {
    cancel()
  }
}
