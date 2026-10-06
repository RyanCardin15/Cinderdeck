import XCTest
@testable import Cinderdeck

final class NativeDictationTests: XCTestCase {
  func testLegacyConfigurationKeepsServiceSettings() throws {
    var original = DictationConfiguration()
    original.endpoint = "https://company.example.test/transcribe"
    original.model = "private-model"; original.language = "en"
    original.globalEnabled = true
    var json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(original)) as? [String: Any])
    json.removeValue(forKey: "savedProvider")
    json.removeValue(forKey: "savedOnDeviceOnly")
    json.removeValue(forKey: "savedNativeLanguage")
    let restored = try JSONDecoder().decode(DictationConfiguration.self, from: JSONSerialization.data(withJSONObject: json))
    XCTAssertEqual(restored.provider, .service)
    XCTAssertEqual(restored.endpoint, original.endpoint)
    XCTAssertEqual(restored.model, original.model)
    XCTAssertEqual(restored.language, "en")
    XCTAssertTrue(restored.globalEnabled)
    XCTAssertTrue(restored.onDeviceOnly)
    XCTAssertEqual(restored.nativeLanguage, "")
  }

  func testNativeProviderPersistsAndDoesNotRequireAnEndpoint() throws {
    var config = DictationConfiguration()
    config.provider = .macOS; config.endpoint = ""; config.model = ""
    config.nativeLanguage = "en_US"; config.language = "fr"
    config.onDeviceOnly = false
    XCTAssertNoThrow(try config.validate())
    let restored = try JSONDecoder().decode(DictationConfiguration.self, from: JSONEncoder().encode(config))
    XCTAssertEqual(restored, config)
    XCTAssertEqual(restored.provider, .macOS)
    XCTAssertEqual(restored.nativeLanguage, "en_US")
    XCTAssertEqual(restored.language, "fr")
    XCTAssertFalse(restored.onDeviceOnly)
    XCTAssertEqual(restored.recordingLimit, 55)
    config.provider = .service
    XCTAssertThrowsError(try config.validate())
    XCTAssertEqual(config.recordingLimit, 300)
  }

  @MainActor func testFinalResultCompletesOnceAndStopsRecognition() async throws {
    let operation = NativeDictationOperation()
    var stopped = 0
    let result = try await operation.run { receive in
      receive("partial", false, false)
      receive("  Final text.  ", true, false)
      receive(nil, false, true)
      receive("Late result", true, false)
      return { stopped += 1 }
    }
    XCTAssertEqual(result, "Final text.")
    XCTAssertEqual(stopped, 1)
  }

  @MainActor func testEmptyFinalAndRecognitionFailureAreErrors() async {
    for failed in [false, true] {
      do {
        _ = try await NativeDictationOperation().run { receive in
          receive("  ", !failed, failed)
          return {}
        }
        XCTFail("Expected a recognition error")
      } catch { XCTAssertTrue(error is DictationError) }
    }
  }

  @MainActor func testTimeoutStopsRecognition() async {
    var stopped = false
    do {
      _ = try await NativeDictationOperation().run(timeout: .milliseconds(1)) { _ in
        { stopped = true }
      }
      XCTFail("Expected timeout")
    } catch { XCTAssertTrue(error.localizedDescription.contains("timed out")) }
    XCTAssertTrue(stopped)
  }

  @MainActor func testCancellationStopsRecognitionAndIgnoresLateResult() async {
    let started = expectation(description: "Recognition started")
    var callback: (@MainActor @Sendable (String?, Bool, Bool) -> Void)?
    var stopped = 0
    let task = Task { @MainActor in
      try await NativeDictationOperation().run { receive in
        callback = receive; started.fulfill()
        return { stopped += 1 }
      }
    }
    await fulfillment(of: [started], timeout: 2)
    task.cancel()
    do { _ = try await task.value; XCTFail("Expected cancellation") }
    catch { XCTAssertTrue(error is CancellationError) }
    callback?("Late text", true, false)
    XCTAssertEqual(stopped, 1)
  }
}
