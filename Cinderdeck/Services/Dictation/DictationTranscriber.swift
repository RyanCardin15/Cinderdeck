import Foundation

/// Never forward credentials/audio through a redirect, including to a different company gateway.
nonisolated final class DictationRedirectPolicy: NSObject, URLSessionTaskDelegate, Sendable {
  func urlSession(_ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}

nonisolated enum DictationTranscriber {
  static let maximumAudioBytes = 24 * 1024 * 1024
  static func request(configuration: DictationConfiguration, key: String, audio: Data, boundary: String = UUID().uuidString) throws -> URLRequest {
    var request = URLRequest(url: try configuration.validatedURL())
    guard !audio.isEmpty, audio.count <= maximumAudioBytes else {
      throw DictationError.message("The recording is empty or exceeds the 24 MB dictation limit.")
    }
    guard !key.contains(where: { $0.isNewline || $0 == "\0" }) else { throw DictationError.message("The API key contains an invalid character.") }
    request.httpMethod = "POST"
    request.timeoutInterval = 90
    if configuration.authentication != .none {
      guard !key.isEmpty else { throw DictationError.message("Add your transcription API key in Settings → Dictation.") }
      request.setValue(configuration.authentication == .bearer ? "Bearer \(key)" : key,
        forHTTPHeaderField: configuration.authentication == .bearer ? "Authorization" : configuration.headerName)
    }
    request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    var body = Data()
    func field(_ name: String, _ value: String) {
      body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".utf8))
    }
    field(configuration.format == .openAI ? "model" : "model_id", configuration.model)
    if !configuration.language.isEmpty {
      let name = configuration.format == .elevenLabs ? "language_code" : configuration.model.hasPrefix("gpt-transcribe") ? "languages[]" : "language"
      field(name, configuration.language)
    }
    body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"dictation.wav\"\r\nContent-Type: audio/wav\r\n\r\n".utf8))
    body.append(audio)
    body.append(Data("\r\n--\(boundary)--\r\n".utf8))
    request.httpBody = body
    return request
  }

  static func decode(_ data: Data, status: Int) throws -> String {
    guard (200..<300).contains(status) else {
      let hint = switch status {
      case 401, 403: "Check your API key and access to the model."
      case 404: "Check the full transcription URL and model slug."
      case 413: "Try a shorter recording."
      case 429: "The service is rate limited. Try again later."
      case 300..<400: "Redirects are blocked. Enter the final transcription URL."
      default: "Check the transcription service and try again."
      }
      // Provider response bodies can echo credentials or private audio. Never display them.
      throw DictationError.message("Transcription failed (HTTP \(status)). \(hint)")
    }
    struct Response: Decodable { let text: String }
    guard let result = try? JSONDecoder().decode(Response.self, from: data) else {
      throw DictationError.message("The service must return JSON containing a text field. Check the API format.")
    }
    let text = result.text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { throw DictationError.message("No speech was recognized. Try again closer to the microphone.") }
    guard text.utf8.count <= 8_000 else { throw DictationError.message("The transcript is too long. Record a shorter dictation.") }
    return text
  }

  static func transcribe(configuration: DictationConfiguration, key: String, file: URL) async throws -> String {
    let request = try request(configuration: configuration, key: key, audio: Data(contentsOf: file))
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForResource = 100
    config.httpCookieStorage = nil
    config.urlCredentialStorage = nil
    let session = URLSession(configuration: config, delegate: DictationRedirectPolicy(), delegateQueue: nil)
    defer { session.invalidateAndCancel() }
    let (bytes, response) = try await session.bytes(for: request)
    var data = Data()
    for try await byte in bytes {
      guard data.count < 1_048_576 else { throw DictationError.message("The transcription response exceeds the size limit.") }
      data.append(byte)
    }
    return try decode(data, status: (response as? HTTPURLResponse)?.statusCode ?? 0)
  }
}
