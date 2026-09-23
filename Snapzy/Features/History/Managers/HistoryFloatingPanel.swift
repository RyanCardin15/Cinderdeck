//
//  HistoryFloatingPanel.swift
//  Snapzy
//
//  NSPanel subclass for the floating history panel
//

import AppKit
import Carbon.HIToolbox
import Foundation

/// Non-activating floating panel for capture history
final class HistoryFloatingPanel: NSPanel {
  var onDidResignKey: (() -> Void)?

  init(contentRect: NSRect) {
    super.init(
      contentRect: contentRect,
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    configurePanel()
  }

  private static let defaultLevel: NSWindow.Level = .floating
  private static let pinnedLevel = NSWindow.Level(rawValue: NSWindow.Level.floating.rawValue + 2)

  private func configurePanel() {
    level = Self.defaultLevel
    isFloatingPanel = true
    hidesOnDeactivate = false
    isOpaque = false
    backgroundColor = .clear
    hasShadow = true
    collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
    acceptsMouseMovedEvents = true
    ignoresMouseEvents = false
  }

  func updateWindowLevel(isPinned: Bool) {
    level = isPinned ? Self.pinnedLevel : Self.defaultLevel
  }

  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { false }

  private var isTextInputActive: Bool {
    guard let responder = firstResponder else { return false }
    return responder is NSTextView || responder is NSTextField
  }

  private var isEditableTextActive: Bool {
    if let text = firstResponder as? NSTextView { return text.isEditable }
    return firstResponder is NSTextField
  }

  override func resignKey() {
    super.resignKey()

    DispatchQueue.main.async { [weak self] in
      self?.onDidResignKey?()
    }
  }

  override func performKeyEquivalent(with event: NSEvent) -> Bool {
    guard event.type == .keyDown else {
      return super.performKeyEquivalent(with: event)
    }

    let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)

    if HistoryFloatingManager.shared.selectedSection == .stacks,
      !HistoryFloatingManager.shared.isPresentingAuxiliaryUI {
      let command: StackKeyboardCommand?
      switch (event.keyCode, flags) {
      case (15, .command): command = .restart
      case (15, [.command, .shift]): command = .restartService
      case (47, .command): command = .stop
      case (11, .command): command = .branch
      case (37, .command): command = .logs
      default: command = nil
      }
      if let command {
        NotificationCenter.default.post(name: .stacksCommand, object: self, userInfo: ["command": command.rawValue])
        return true
      }
    }

    if event.keyCode == 8 && flags == .command {
      if isTextInputActive {
        return super.performKeyEquivalent(with: event)
      }

      NotificationCenter.default.post(name: .historyCopySelection, object: self)
      return true
    }

    if event.keyCode == 0 && flags == .command {
      if isTextInputActive {
        return super.performKeyEquivalent(with: event)
      }

      NotificationCenter.default.post(name: .historySelectAll, object: self)
      return true
    }

    if event.keyCode == 35 && flags == .command {
      if isEditableTextActive {
        return super.performKeyEquivalent(with: event)
      }

      HistoryFloatingManager.shared.togglePin()
      return true
    }

    if HistoryFloatingManager.shared.isToggleModeShortcutEnabled,
       let toggleShortcut = HistoryFloatingManager.shared.toggleModeShortcut,
       let eventShortcut = ShortcutConfig(from: event) {
      if eventShortcut.keyCode == toggleShortcut.keyCode && eventShortcut.modifiers == toggleShortcut.modifiers {
        if isEditableTextActive {
          return super.performKeyEquivalent(with: event)
        }
        HistoryFloatingManager.shared.togglePresentationMode()
        return true
      }
    }

    return super.performKeyEquivalent(with: event)
  }

  override func keyDown(with event: NSEvent) {
    let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)

    let section = HistoryFloatingManager.shared.selectedSection
    if section != .captures,
      !isTextInputActive, flags.isEmpty, (123...126).contains(event.keyCode) {
      let delta = event.keyCode == 123 || event.keyCode == 126 ? -1 : 1
      NotificationCenter.default.post(name: .historyMoveSelection, object: self, userInfo: ["delta": delta, "section": section.rawValue])
      return
    }

    if !isTextInputActive, flags.isEmpty, (event.keyCode == 51 || event.keyCode == 117) {
      if section == .stacks { return }
      NotificationCenter.default.post(name: .historyDeleteSelection, object: self)
      return
    }

    if !isTextInputActive, flags.isEmpty, (event.keyCode == 36 || event.keyCode == 76) {
      if section == .stacks {
        NotificationCenter.default.post(name: .stacksCommand, object: self, userInfo: ["command": StackKeyboardCommand.toggle.rawValue])
        return
      }
      NotificationCenter.default.post(name: .historyActivateSelection, object: self)
      return
    }

    super.keyDown(with: event)
  }
}
