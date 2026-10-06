import Foundation
import Speech

/// Apple's recognizer is used directly; no API key or custom endpoint is involved.
@MainActor
final class NativeDictationTranscriber {
  static var supportedLanguages: [String] {
    SFSpeechRecognizer.supportedLocales().map(\.identifier).sorted()
  }

  static func authorize() async throws {
    let status = await withCheckedContinuation { continuation in
      SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
    }
    guard status == .authorized else {
      throw DictationError.message("Allow Cinderdeck in System Settings → Privacy & Security → Speech Recognition, then try again.")
    }
  }

  static func checkAvailability(configuration: DictationConfiguration) throws {
    _ = try recognizer(configuration: configuration)
  }

  private static func recognizer(configuration: DictationConfiguration) throws -> SFSpeechRecognizer {
    let locale = configuration.nativeLanguage.isEmpty ? Locale.current : Locale(identifier: configuration.nativeLanguage)
    guard let recognizer = SFSpeechRecognizer(locale: locale), recognizer.isAvailable else {
      throw DictationError.message("macOS speech recognition is unavailable for this language. Choose another language in Settings → Dictation and try again.")
    }
    guard !configuration.onDeviceOnly || recognizer.supportsOnDeviceRecognition else {
      throw DictationError.message("On-device speech recognition is unavailable for this language. Choose another language or turn off Require on-device recognition in Settings → Dictation to allow Apple’s servers.")
    }
    return recognizer
  }

  func transcribe(configuration: DictationConfiguration, file: URL) async throws -> String {
    try Task.checkCancellation()
    let recognizer = try Self.recognizer(configuration: configuration)
    let request = SFSpeechURLRecognitionRequest(url: file)
    request.taskHint = .dictation
    request.shouldReportPartialResults = false
    request.requiresOnDeviceRecognition = configuration.onDeviceOnly || recognizer.supportsOnDeviceRecognition
    let operation = NativeDictationOperation()
    return try await operation.run { receive in
      let task = recognizer.recognitionTask(with: request) { result, error in
        let text = result?.bestTranscription.formattedString
        let final = result?.isFinal ?? false
        let failed = error != nil
        Task { @MainActor in receive(text, final, failed) }
      }
      // Keep the recognizer alive until completion/cancellation.
      return { _ = recognizer; task.cancel() }
    }
  }
}

/// Exactly-once completion shared by recognition, timeout and cancellation.
@MainActor
final class NativeDictationOperation {
  private var continuation: CheckedContinuation<String, Error>?
  private var cancelRecognition: (() -> Void)?
  private var timeoutTask: Task<Void, Never>?

  func run(
    timeout: Duration = .seconds(90),
    start: (@escaping @MainActor @Sendable (String?, Bool, Bool) -> Void) -> (() -> Void)
  ) async throws -> String {
    try Task.checkCancellation()
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        self.continuation = continuation
        let cancel = start { [weak self] text, final, failed in
          if final {
            let text = (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            self?.complete(text.isEmpty
              ? .failure(DictationError.message("No speech was recognized. Try again and speak clearly into your microphone."))
              : .success(text))
          } else if failed {
            self?.complete(.failure(DictationError.message("macOS could not transcribe this recording. Check the selected language and speech recognition availability, then try again.")))
          }
        }
        guard self.continuation != nil else { cancel(); return }
        cancelRecognition = cancel
        timeoutTask = Task { [weak self] in
          try? await Task.sleep(for: timeout)
          guard !Task.isCancelled else { return }
          self?.complete(.failure(DictationError.message("macOS speech recognition timed out. Try a shorter recording.")))
        }
      }
    } onCancel: {
      Task { @MainActor in self.complete(.failure(CancellationError())) }
    }
  }

  private func complete(_ result: Result<String, Error>) {
    guard let continuation else { return }
    self.continuation = nil
    timeoutTask?.cancel(); timeoutTask = nil
    let cancel = cancelRecognition; cancelRecognition = nil
    cancel?()
    continuation.resume(with: result)
  }
}
