import AppKit
import AVFoundation
import Combine
import SwiftUI

@MainActor
final class DictationController: NSObject, ObservableObject, AVAudioRecorderDelegate {
  static let shared = DictationController()
  @Published private(set) var configuration: DictationConfiguration
  @Published private(set) var phase = "idle"
  @Published private(set) var message = ""
  @Published private(set) var transcript = ""
  var isBusy: Bool { ["preparing", "recording", "transcribing"].contains(phase) }
  private var recorder: AVAudioRecorder?
  private var file: URL?
  private var task: Task<Void, Never>?
  private var timeout: Task<Void, Never>?
  private var token: UUID?
  private var requestID: String?
  private var target: DictationInsertionTarget?
  private var testing = false
  private var sessionConfiguration: DictationConfiguration?
  private var panel: NSPanel?
  private let defaults: UserDefaults
  private let keychain = DictationKeychain()

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    configuration = defaults.data(forKey: "dictation.configuration").flatMap { try? JSONDecoder().decode(DictationConfiguration.self, from: $0) } ?? .init()
    super.init()
  }
  nonisolated deinit {}

  func save(_ configuration: DictationConfiguration, key: String?) throws {
    try configuration.validate()
    let data = try JSONEncoder().encode(configuration)
    if configuration.provider == .service, let key { try keychain.save(key) }
    defaults.set(data, forKey: "dictation.configuration")
    self.configuration = configuration
    DictationShortcutMonitor.shared.restart()
  }
  func hasKey() -> Bool { (try? keychain.read().isEmpty == false) ?? false }

  func begin(requestID: String? = nil, test: Bool = false) {
    guard !isBusy else {
      if let requestID { CinderdeckRuntimeController.shared.sendDictation(requestID: requestID, state: "error", error: "Another dictation is in progress.") }
      return
    }
    let token = UUID()
    self.token = token; self.requestID = requestID; testing = test
    target = requestID == nil && !test ? DictationInsertionTarget.capture() : nil
    transcript = ""
    update("preparing", "Preparing microphone…")
    showPanel()
    let configuration = configuration
    sessionConfiguration = configuration
    task = Task {
      do {
        try configuration.validate()
        if configuration.provider == .macOS {
          try await NativeDictationTranscriber.authorize()
          guard self.token == token, !Task.isCancelled else { return }
          try NativeDictationTranscriber.checkAvailability(configuration: configuration)
        } else {
          let key = configuration.authentication == .none ? "" : try keychain.read()
          guard configuration.authentication == .none || !key.isEmpty else { throw DictationError.message("Add your API key in Settings → Dictation first.") }
        }
        let granted = await AVCaptureDevice.requestAccess(for: .audio)
        guard self.token == token, !Task.isCancelled else { return }
        guard granted else { throw DictationError.message("Allow Cinderdeck microphone access in System Settings → Privacy & Security → Microphone.") }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("cinderdeck-dictation-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let file = directory.appendingPathComponent("audio.wav")
        self.file = file
        let recorder = try AVAudioRecorder(url: file, settings: [AVFormatIDKey: kAudioFormatLinearPCM,
          AVSampleRateKey: 16_000, AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16,
          AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false])
        recorder.delegate = self
        guard recorder.prepareToRecord(), recorder.record() else { throw DictationError.message("The microphone could not start. Check your audio input device.") }
        self.recorder = recorder
        update("recording", "Listening… Release your shortcut or press Stop.")
        timeout = Task { [weak self] in
          try? await Task.sleep(for: .seconds(configuration.recordingLimit))
          guard !Task.isCancelled, self?.token == token else { return }
          self?.finish()
        }
      } catch {
        guard self.token == token else { return }
        fail(error)
      }
    }
  }

  func finish() {
    if phase == "preparing" { cancel(); return }
    guard phase == "recording", let file, let token else { return }
    let duration = recorder?.currentTime ?? 0
    recorder?.stop(); recorder = nil; timeout?.cancel(); timeout = nil
    guard duration >= 0.25 else { cancel(); return }
    update("transcribing", "Transcribing…")
    let configuration = sessionConfiguration ?? configuration
    task = Task {
      do {
        let text: String
        if configuration.provider == .macOS {
          text = try await NativeDictationTranscriber().transcribe(configuration: configuration, file: file)
        } else {
          let key = configuration.authentication == .none ? "" : try keychain.read()
          text = try await DictationTranscriber.transcribe(configuration: configuration, key: key, file: file)
        }
        guard self.token == token, !Task.isCancelled else { return }
        transcript = text
        cleanupAudio()
        if let requestID {
          if CinderdeckRuntimeController.shared.sendDictation(requestID: requestID, state: "completed", text: text) {
            self.requestID = nil
            update("completed", "Added to your chat draft.")
            panel?.orderOut(nil)
          } else {
            CinderdeckRuntimeController.shared.sendDictation(requestID: requestID, state: "error", error: "Could not deliver the transcript. Copy it from the native Dictation window.")
            self.requestID = nil; update("completed", "Chat disconnected. Copy your transcript below.")
          }
        } else if !testing, let target, target.insert(text) {
          update("completed", "Dictation inserted. Copy below if your app did not accept it.")
        } else {
          update("completed", testing ? "Transcription succeeded. Copy your test below." : "Your text field changed or is unavailable. Copy your transcript below.")
        }
        self.token = nil; self.target = nil
      } catch {
        guard self.token == token, !Task.isCancelled else { return }
        fail(error)
      }
    }
  }

  func cancel() {
    task?.cancel(); task = nil; timeout?.cancel(); timeout = nil
    recorder?.stop(); recorder = nil; cleanupAudio()
    update("idle", "Dictation cancelled.")
    token = nil; requestID = nil; target = nil; transcript = ""
    panel?.orderOut(nil)
  }
  func cancelChat() { if requestID != nil { cancel() } }
  func handle(_ request: DictationCommand) {
    switch request.action {
    case "start": begin(requestID: request.requestID)
    case "stop": if requestID == request.requestID { finish() }
    case "cancel": if requestID == request.requestID { cancel() }
    default: break
    }
  }
  nonisolated func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
    let failedURL = recorder.url
    Task { @MainActor [weak self] in
      guard let self, self.file == failedURL, self.phase == "recording" else { return }
      self.fail(DictationError.message("Microphone recording failed. Check your input device and try again."))
    }
  }
  private func fail(_ error: Error) {
    recorder?.stop(); recorder = nil; cleanupAudio(); timeout?.cancel(); timeout = nil
    let description = (error as? DictationError)?.localizedDescription ?? "Dictation failed. Check your microphone, network and transcription service, then try again."
    update("error", description)
    token = nil; requestID = nil; target = nil
  }
  private func cleanupAudio() {
    if let file { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
    file = nil
  }
  private func update(_ phase: String, _ message: String) {
    self.phase = phase; self.message = message
    if let requestID { CinderdeckRuntimeController.shared.sendDictation(requestID: requestID, state: phase, error: phase == "error" ? message : nil) }
  }
  private func showPanel() {
    if panel == nil {
      let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 390, height: 180), styleMask: [.titled, .nonactivatingPanel], backing: .buffered, defer: false)
      panel.title = "Dictation"; panel.level = .floating; panel.hidesOnDeactivate = false
      panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
      panel.contentView = NSHostingView(rootView: DictationStatusView(controller: self))
      self.panel = panel
    }
    if let screen = NSScreen.main { panel?.setFrameOrigin(NSPoint(x: screen.visibleFrame.midX - 195, y: screen.visibleFrame.minY + 35)) }
    panel?.orderFrontRegardless()
  }
}

private struct DictationStatusView: View {
  @ObservedObject var controller: DictationController
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Label(controller.message, systemImage: controller.phase == "recording" ? "mic.fill" : "waveform")
        .font(.callout).fixedSize(horizontal: false, vertical: true)
      if !controller.transcript.isEmpty {
        ScrollView { Text(controller.transcript).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.frame(maxHeight: 75)
      }
      HStack {
        if controller.phase == "recording" { Button("Stop") { controller.finish() } }
        if !controller.transcript.isEmpty {
          Button("Copy transcript") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(controller.transcript, forType: .string) }
        }
        Spacer()
        Button(controller.isBusy ? "Cancel" : "Dismiss") { controller.cancel() }
      }
    }.padding(16).frame(width: 390)
  }
}
