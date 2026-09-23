//
//  ShortcutOverlayManager.swift
//  Cinderdeck
//
//  Manages lifecycle for keyboard shortcut list overlay panel.
//

import AppKit
import SwiftUI

@MainActor
final class ShortcutOverlayManager {
  static let shared = ShortcutOverlayManager()

  private var panel: ShortcutOverlayPanel?
  private var localEscapeMonitor: Any?
  private var globalEscapeMonitor: Any?

  private init() {}

  var isVisible: Bool {
    panel?.isVisible == true
  }

  func toggle() {
    if isVisible {
      hide()
    } else {
      show()
    }
  }

  func show() {
    guard !RecordingCoordinator.shared.isActive else { return }

    let screen = ScreenUtility.activeScreen()
    let sections = ShortcutOverlayContentBuilder.buildSections()
    let overlayView = ShortcutOverlayView(
      sections: sections,
      onClose: { [weak self] in
        self?.hide()
      },
      onOpenSettings: { [weak self] in
        self?.openShortcutsSettings()
      }
    )

    let panel = self.panel ?? ShortcutOverlayPanel(screen: screen)
    panel.setFrame(screen.frame, display: true)
    let hostingView = NSHostingView(rootView: overlayView)
    hostingView.frame = NSRect(origin: .zero, size: screen.frame.size)
    panel.contentView = hostingView
    panel.orderFrontRegardless()
    self.panel = panel

    setupEscapeMonitors()
  }

  func hide() {
    removeEscapeMonitors()
    panel?.orderOut(nil)
    panel?.close()
    panel = nil
  }

  private func openShortcutsSettings() {
    hide()
    AppStatusBarController.shared.openPreferencesWindow(tab: .shortcuts)
  }

  private func setupEscapeMonitors() {
    removeEscapeMonitors()

    localEscapeMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
      guard event.keyCode == 53 else { return event }  // Escape
      self?.hide()
      return nil
    }

    globalEscapeMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
      guard event.keyCode == 53 else { return }  // Escape
      DispatchQueue.main.async {
        self?.hide()
      }
    }
  }

  private func removeEscapeMonitors() {
    if let localEscapeMonitor {
      NSEvent.removeMonitor(localEscapeMonitor)
      self.localEscapeMonitor = nil
    }
    if let globalEscapeMonitor {
      NSEvent.removeMonitor(globalEscapeMonitor)
      self.globalEscapeMonitor = nil
    }
  }
}

private final class ShortcutOverlayPanel: NSPanel {
  init(screen: NSScreen) {
    super.init(
      contentRect: screen.frame,
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    configurePanel()
  }

  private func configurePanel() {
    level = .screenSaver
    isFloatingPanel = true
    hidesOnDeactivate = false
    isOpaque = false
    backgroundColor = .clear
    hasShadow = false
    collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    ignoresMouseEvents = false
    acceptsMouseMovedEvents = true
    animationBehavior = .none
    isReleasedWhenClosed = false
  }

  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}
