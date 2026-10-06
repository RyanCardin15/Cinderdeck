import AppKit

/// Observes press/release without swallowing keys from the foreground application.
@MainActor
final class DictationShortcutMonitor {
  static let shared = DictationShortcutMonitor()
  static let modifiers: NSEvent.ModifierFlags = [.control, .option, .shift, .command, .function]
  private var global: Any?
  private var local: Any?
  private var pending: Task<Void, Never>?
  private var held = false
  private var ownsRecording = false
  var suspended = false { didSet { release(cancel: true) } }

  func restart() {
    stop()
    // Escape remains available during chat dictation even when the global trigger is disabled.
    let mask: NSEvent.EventTypeMask = [.flagsChanged, .keyDown, .keyUp]
    global = NSEvent.addGlobalMonitorForEvents(matching: mask) { [weak self] event in
      MainActor.assumeIsolated { self?.handle(event) }
    }
    local = NSEvent.addLocalMonitorForEvents(matching: mask) { [weak self] event in
      MainActor.assumeIsolated { self?.handle(event) }
      return event
    }
  }
  func stop() {
    if let global { NSEvent.removeMonitor(global) }; global = nil
    if let local { NSEvent.removeMonitor(local) }; local = nil
    release(cancel: true)
  }
  private func release(cancel: Bool = false) {
    held = false; pending?.cancel(); pending = nil
    if ownsRecording {
      ownsRecording = false
      if cancel { DictationController.shared.cancel() } else { DictationController.shared.finish() }
    }
  }
  private func handle(_ event: NSEvent) {
    guard !suspended else { return }
    let controller = DictationController.shared
    if event.type == .keyDown, event.keyCode == 53, controller.isBusy {
      release(cancel: true); controller.cancel(); return
    }
    let config = controller.configuration
    guard config.globalEnabled, AXIsProcessTrusted() else { return }
    switch Self.decision(type: event.type, keyCode: event.keyCode, flags: event.modifierFlags, repeating: event.type == .keyDown && event.isARepeat, configuration: config) {
    case .release: release(); return
    case .cancel: release(cancel: true); return
    case .ignore: return
    case .press: break
    }
    guard !held, !controller.isBusy else { return }
    held = true
    pending = Task { [weak self] in
      try? await Task.sleep(for: .seconds(config.holdDelay))
      guard !Task.isCancelled, let self, held, !controller.isBusy else { return }
      ownsRecording = true
      controller.begin()
    }
  }
  enum Decision { case press, release, cancel, ignore }
  static func decision(type: NSEvent.EventType, keyCode: UInt16, flags: NSEvent.ModifierFlags,
    repeating: Bool, configuration: DictationConfiguration) -> Decision {
    let flags = flags.intersection(modifiers).rawValue
    let expected = configuration.shortcutModifiers
    // Adding another modifier starts a different shortcut; releasing ends dictation.
    if flags != expected { return flags & ~expected != 0 ? .cancel : .release }
    if let code = configuration.shortcutKeyCode {
      if type == .keyUp && keyCode == code { return .release }
      if type == .keyDown && keyCode != code { return .cancel }
      return type == .keyDown && keyCode == code && !repeating ? .press : .ignore
    }
    if type == .keyDown { return .cancel }
    return type == .flagsChanged ? .press : .ignore
  }

}
