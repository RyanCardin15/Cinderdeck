import XCTest
@testable import Cinderdeck

final class DictationTranscriberTests: XCTestCase {
  func testCorporateURLPreservesDeploymentAndAPIVersion() throws {
    var config = DictationConfiguration()
    config.endpoint = "https://speech.example.test/deployments/private/audio/transcriptions?api-version=2026-01-01"
    config.model = "company-whisper"
    config.authentication = .header; config.headerName = "api-key"
    let request = try DictationTranscriber.request(configuration: config, key: "fixture-secret", audio: Data([1, 2]), boundary: "fixture")
    XCTAssertEqual(request.url?.absoluteString, config.endpoint)
    XCTAssertEqual(request.value(forHTTPHeaderField: "api-key"), "fixture-secret")
    XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
    let body = String(decoding: try XCTUnwrap(request.httpBody), as: UTF8.self)
    XCTAssertTrue(body.contains("name=\"model\"\r\n\r\ncompany-whisper"))
    XCTAssertTrue(body.contains("filename=\"dictation.wav\""))
    XCTAssertFalse(body.contains("fixture-secret"))
  }
  func testLocalServerNeedsNoKeyAndElevenLabsUsesItsOwnFields() throws {
    var config = DictationConfiguration()
    config.endpoint = "http://127.0.0.1:8080/v1/audio/transcriptions"; config.authentication = .none
    XCTAssertNil(try DictationTranscriber.request(configuration: config, key: "ignored", audio: Data([1])).value(forHTTPHeaderField: "Authorization"))
    config.format = .elevenLabs; config.model = "scribe_v2"; config.language = "en"
    let body = String(decoding: try XCTUnwrap(DictationTranscriber.request(configuration: config, key: "", audio: Data([1])).httpBody), as: UTF8.self)
    XCTAssertTrue(body.contains("name=\"model_id\"\r\n\r\nscribe_v2"))
    XCTAssertTrue(body.contains("name=\"language_code\"\r\n\r\nen"))
  }
  func testNewAndLegacyOpenAIModelsUseTheirSupportedLanguageField() throws {
    var config = DictationConfiguration(); config.language = "en"
    let current = String(decoding: try XCTUnwrap(DictationTranscriber.request(configuration: config, key: "fixture", audio: Data([1])).httpBody), as: UTF8.self)
    XCTAssertTrue(current.contains("name=\"languages[]\""))
    XCTAssertFalse(current.contains("name=\"language\""))
    config.model = "gpt-4o-transcribe"
    let legacy = String(decoding: try XCTUnwrap(DictationTranscriber.request(configuration: config, key: "fixture", audio: Data([1])).httpBody), as: UTF8.self)
    XCTAssertTrue(legacy.contains("name=\"language\""))
    XCTAssertFalse(legacy.contains("name=\"languages[]\""))
  }
  func testRefusesInsecureRemoteAndCredentialBearingURLs() {
    for url in ["http://speech.example.test/transcribe", "file:///tmp/audio", "https://user:pass@example.test/audio", "https://example.test/audio#fragment"] {
      var config = DictationConfiguration(); config.endpoint = url
      XCTAssertThrowsError(try config.validatedURL(), url)
    }
  }
  func testRejectsInvalidHeadersAndEmptyAudio() {
    var config = DictationConfiguration(); config.authentication = .header
    for header in ["Host", "Content-Type", "api-key\r\nInjected", ""] {
      config.headerName = header
      XCTAssertThrowsError(try config.validatedURL())
    }
    config = .init()
    XCTAssertThrowsError(try DictationTranscriber.request(configuration: config, key: "", audio: Data([1])))
    XCTAssertThrowsError(try DictationTranscriber.request(configuration: config, key: "fixture", audio: Data()))
    XCTAssertThrowsError(try DictationTranscriber.request(configuration: config, key: "bad\nkey", audio: Data([1])))
  }
  func testResponseValidationAndErrorsDoNotExposeServerBody() throws {
    XCTAssertEqual(try DictationTranscriber.decode(Data(#"{"text":"  Hello world.  "}"#.utf8), status: 200), "Hello world.")
    for data in [Data(#"{"text":" "}"#.utf8), Data(#"{"result":"hello"}"#.utf8), Data("<html>error</html>".utf8)] {
      XCTAssertThrowsError(try DictationTranscriber.decode(data, status: 200))
    }
    for status in [302, 401, 403, 404, 413, 429, 500] {
      do { _ = try DictationTranscriber.decode(Data("fixture-private-key".utf8), status: status); XCTFail() }
      catch { XCTAssertFalse(error.localizedDescription.contains("fixture-private-key")); XCTAssertTrue(error.localizedDescription.contains(String(status))) }
    }
  }
  func testCommandsAreStrictlyScopedToUUIDSessions() throws {
    let id = UUID().uuidString
    XCTAssertEqual(try DictationCommand.decode(Data("{\"action\":\"start\",\"requestID\":\"\(id)\"}".utf8)).requestID, id)
    for input in ["{\"action\":\"start\",\"requestID\":\"arbitrary\"}", "{\"action\":\"upload\",\"requestID\":\"\(id)\"}", "{\"action\":\"start\",\"requestID\":\"\(id)\",\"url\":\"https://example.test\"}"] {
      XCTAssertThrowsError(try DictationCommand.decode(Data(input.utf8)))
    }
  }
}
