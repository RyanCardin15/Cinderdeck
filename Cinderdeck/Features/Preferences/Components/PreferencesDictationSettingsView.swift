import AppKit
import AVFoundation
import SwiftUI

struct DictationSettingsView: View {
  @ObservedObject private var controller = DictationController.shared
  @State private var configuration = DictationConfiguration()
  @State private var key = ""
  @State private var keyChanged = false
  @State private var savedKey = false
  @State private var feedback = ""
  @State private var recordingShortcut = false
  @State private var shortcutMonitor: Any?
  @State private var lastModifiers: NSEvent.ModifierFlags = []
  @State private var accessibilityGranted = AXIsProcessTrusted()

  var body: some View {
    Form {
      Section {
        Label("Dictation", systemImage: "mic.fill").font(.title2.bold())
        Text("Speak into your chat or hold a shortcut to write in another app. Review the text before sending it.")
          .foregroundStyle(.secondary)
      }
      Section("Speech recognition") {
        Picker("Provider", selection: $configuration.provider) {
          Text("Transcription service").tag(DictationConfiguration.Provider.service)
          Text("macOS (no API key)").tag(DictationConfiguration.Provider.macOS)
        }
      }
      if configuration.provider == .macOS {
        Section("macOS dictation") {
          Picker("Language", selection: $configuration.nativeLanguage) {
            Text("System language").tag("")
            ForEach(Array(Set(NativeDictationTranscriber.supportedLanguages + (configuration.nativeLanguage.isEmpty ? [] : [configuration.nativeLanguage]))).sorted(), id: \.self) { identifier in
              Text(Locale.current.localizedString(forIdentifier: identifier) ?? identifier).tag(identifier)
            }
          }
          Toggle("Require on-device recognition", isOn: $configuration.onDeviceOnly)
          Text("Uses Apple’s speech recognizer with no API key. On-device recognition keeps speech on this Mac and requires a supported language. If you turn this off, Apple’s servers may process audio when on-device recognition is unavailable.")
            .font(.caption).foregroundStyle(.secondary)
          Text("Recordings stop after 55 seconds. Microphone and Speech Recognition permissions are requested the first time you dictate. The chat microphone and hold-to-talk shortcut work with either provider.")
            .font(.caption).foregroundStyle(.secondary)
          Button("Open Speech Recognition permissions") {
            NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition")!)
          }
        }
      } else {
        Section("Transcription service") {
          Menu("Use a service preset") {
            Button("OpenAI") { preset(.openAI, url: "https://api.openai.com/v1/audio/transcriptions", model: "gpt-transcribe", auth: .bearer) }
            Button("ElevenLabs") { preset(.elevenLabs, url: "https://api.elevenlabs.io/v1/speech-to-text", model: "scribe_v2", auth: .header) }
            Button("Local OpenAI-compatible server") { preset(.openAI, url: "http://localhost:8080/v1/audio/transcriptions", model: "whisper-1", auth: .none) }
          }
          Picker("API format", selection: $configuration.format) {
            Text("OpenAI compatible").tag(DictationConfiguration.Format.openAI)
            Text("ElevenLabs").tag(DictationConfiguration.Format.elevenLabs)
          }
          TextField("Full transcription URL", text: $configuration.endpoint)
          TextField("Model slug", text: $configuration.model)
          TextField("Language (optional, e.g. en)", text: $configuration.language)
          Picker("Authentication", selection: $configuration.authentication) {
            Text("Bearer token").tag(DictationConfiguration.Authentication.bearer)
            Text("Custom header").tag(DictationConfiguration.Authentication.header)
            Text("None (local server)").tag(DictationConfiguration.Authentication.none)
          }
          if configuration.authentication == .header { TextField("Header name", text: $configuration.headerName) }
          if configuration.authentication != .none {
            SecureField(savedKey ? "API key saved — enter to replace" : "API key", text: Binding(get: { key }, set: { key = $0; keyChanged = true }))
            if savedKey { Button("Remove saved API key") { key = ""; keyChanged = true; savedKey = false } }
          }
          Text("Use a model that supports audio transcription. OpenAI-compatible servers receive multipart audio at the exact URL above and return a JSON text field. Local models need a running server; Cinderdeck does not download models.")
            .font(.caption).foregroundStyle(.secondary)
          Text("Recordings are sent only to this endpoint when you stop. Temporary audio is deleted after completion or cancellation. Keys stay in macOS Keychain.")
            .font(.caption).foregroundStyle(.secondary)
        }
      }
      Section("Dictate anywhere on your Mac") {
        Toggle("Enable hold-to-talk shortcut", isOn: $configuration.globalEnabled)
        HStack {
          Text("Shortcut"); Spacer()
          Button(recordingShortcut ? "Press keys… (Esc to cancel)" : configuration.shortcutLabel) { startShortcutCapture() }
          Button("Use Control") {
            stopShortcutCapture(); configuration.shortcutModifiers = NSEvent.ModifierFlags.control.rawValue
            configuration.shortcutKeyCode = nil; configuration.shortcutLabel = "⌃ Control"
          }
        }
        HStack {
          Text("Hold delay")
          Slider(value: $configuration.holdDelay, in: 0.2...1, step: 0.05)
          Text(String(format: "%.2f s", configuration.holdDelay)).monospacedDigit()
        }
        Text("Hold until Listening appears, speak, then release to transcribe. Press Escape to cancel. Choose a shortcut unused by your other apps; the keys still reach the foreground app. Password fields are excluded.")
          .font(.caption).foregroundStyle(.secondary)
        HStack {
          Label(accessibilityGranted ? "Accessibility enabled" : "Accessibility required for other apps", systemImage: accessibilityGranted ? "checkmark.circle" : "lock")
          Spacer()
          Button("Allow Accessibility") {
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true]
            accessibilityGranted = AXIsProcessTrustedWithOptions(options as CFDictionary)
          }
          Button("Refresh") { accessibilityGranted = AXIsProcessTrusted(); DictationShortcutMonitor.shared.restart() }
        }
      }
      Section {
        HStack {
          Button("Save settings") { save() }.buttonStyle(.borderedProminent).disabled(controller.isBusy || recordingShortcut)
          Button(controller.phase == "recording" ? "Stop test" : "Test dictation") {
            if controller.phase == "recording" { controller.finish() }
            else if save() { controller.begin(test: true) }
          }.disabled((controller.isBusy && controller.phase != "recording") || recordingShortcut)
        }
        if !feedback.isEmpty { Text(feedback).font(.callout).textSelection(.enabled) }
        Text(configuration.provider == .macOS ? "The test uses macOS speech recognition and shows the transcript without inserting it." : "Microphone permission is requested when you start dictating. The test sends your recorded speech to the saved endpoint.")
          .font(.caption).foregroundStyle(.secondary)
      }
    }.formStyle(.grouped)
      .onAppear {
        configuration = controller.configuration
        if configuration.provider == .service { savedKey = controller.hasKey() }
      }
      .onChange(of: configuration.provider) { provider in
        if provider == .service && !keyChanged { savedKey = controller.hasKey() }
      }
      .onDisappear { stopShortcutCapture() }
  }

  private func preset(_ format: DictationConfiguration.Format, url: String, model: String, auth: DictationConfiguration.Authentication) {
    configuration.format = format; configuration.endpoint = url; configuration.model = model
    configuration.authentication = auth; configuration.headerName = format == .elevenLabs ? "xi-api-key" : "api-key"
    key = ""; keyChanged = true; savedKey = false
    feedback = "Preset selected. Enter its API key if needed, then save."
  }
  @discardableResult private func save() -> Bool {
    do {
      try controller.save(configuration, key: keyChanged ? key : nil)
      if configuration.provider == .service { savedKey = controller.hasKey(); key = ""; keyChanged = false }
      feedback = "Settings saved."
      return true
    } catch { feedback = error.localizedDescription; return false }
  }
  private func stopShortcutCapture() {
    if let shortcutMonitor { NSEvent.removeMonitor(shortcutMonitor) }
    shortcutMonitor = nil; recordingShortcut = false; lastModifiers = []
    DictationShortcutMonitor.shared.suspended = false
  }
  private func startShortcutCapture() {
    stopShortcutCapture(); recordingShortcut = true
    DictationShortcutMonitor.shared.suspended = true
    shortcutMonitor = NSEvent.addLocalMonitorForEvents(matching: [.flagsChanged, .keyDown]) { event in
      if event.type == .keyDown && event.keyCode == 53 { stopShortcutCapture(); return nil }
      let flags = event.modifierFlags.intersection(DictationShortcutMonitor.modifiers)
      if event.type == .flagsChanged && !flags.isEmpty { lastModifiers = flags; return nil }
      let captured = event.type == .keyDown ? flags : lastModifiers
      guard !captured.isEmpty else { return nil }
      if event.type == .keyDown, let shortcut = ShortcutConfig(from: event),
        let conflict = GlobalShortcutKind.allCases.first(where: {
          KeyboardShortcutManager.shared.isShortcutEnabled(for: $0) && KeyboardShortcutManager.shared.shortcut(for: $0) == shortcut
        }) {
        feedback = "That shortcut is already used by \(conflict.displayName). Choose another."
        stopShortcutCapture(); return nil
      }
      configuration.shortcutModifiers = captured.rawValue
      configuration.shortcutKeyCode = event.type == .keyDown ? event.keyCode : nil
      configuration.shortcutLabel = [(NSEvent.ModifierFlags.control, "⌃"), (.option, "⌥"), (.shift, "⇧"), (.command, "⌘"), (.function, "Fn")]
        .filter { captured.contains($0.0) }.map { $0.1 }.joined() + (event.type == .keyDown ? " " + (event.charactersIgnoringModifiers?.uppercased() ?? "Key \(event.keyCode)") : " Hold")
      stopShortcutCapture()
      return nil
    }
  }
}
