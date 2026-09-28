import AVFoundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import Cinderdeck

final class BrowserReproTests: XCTestCase {
  func testOptionsLaunchAndAttachAreExplicitAndValidated() throws {
    XCTAssertNil(try BrowserReproOptions.parse(.object(["title": .string("Screen")])) )
    let options = try XCTUnwrap(BrowserReproOptions.parse(.object(["headless": .string("http://localhost:3000"), "browser_width": .number(1440)])))
    XCTAssertEqual(options.width, 1440)
    XCTAssertEqual(options.height, 720)
    XCTAssertNil(options.endpoint)
    XCTAssertEqual(try BrowserReproOptions.parse(.object(["cdp": .string("http://127.0.0.1:9222"), "page_id": .string("PAGE")]))?.pageID, "PAGE")
    for params: [String: JSONValue] in [
      ["headless": .bool(true)], ["headless": .string("file:///etc/passwd")],
      ["headless": .string("https://user:secret@example.com")], ["cdp": .string("ws://localhost:9222")],
      ["headless": .string("about:blank"), "cdp": .string("http://localhost:9222")],
      ["headless": .string("about:blank"), "display": .string("main")],
      ["headless": .string("about:blank"), "window_id": .number(10)],
      ["headless": .string("about:blank"), "system_audio": .bool(true)],
      ["headless": .string("about:blank"), "browser_width": .number(100)],
      ["headless": .string("about:blank"), "browser_height": .number(720.5)],
      ["headless": .string("about:blank"), "page_id": .string("PAGE")],
      ["cdp": .string("http://localhost:9222"), "browser_width": .number(1280)],
      ["browser_executable": .string("/path/chrome")],
    ] { XCTAssertThrowsError(try BrowserReproOptions.parse(.object(params)), "\(params)") }
  }

  func testTargetSelectionNeverSilentlyChoosesAmongTabs() throws {
    func page(_ id: String) -> JSONValue { .object(["id": .string(id), "type": .string("page"),
      "url": .string("https://example.com/?secret=hidden"), "webSocketDebuggerUrl": .string("ws://localhost/\(id)")]) }
    let worker: JSONValue = .object(["type": .string("service_worker")])
    XCTAssertEqual(try BrowserReproOptions.choosePage([worker, page("one")], id: nil)["id"]?.stringValue, "one")
    XCTAssertEqual(try BrowserReproOptions.choosePage([page("one"), page("two")], id: "two")["id"]?.stringValue, "two")
    XCTAssertThrowsError(try BrowserReproOptions.choosePage([], id: nil))
    XCTAssertThrowsError(try BrowserReproOptions.choosePage([page("one")], id: "missing"))
    do { _ = try BrowserReproOptions.choosePage([page("one"), page("two")], id: nil); XCTFail("Expected a choice") }
    catch { XCTAssertFalse(error.localizedDescription.contains("hidden")) }
    XCTAssertEqual(BrowserReproOptions.logURL("https://user:password@example.com/path?token=secret#private"), "https://example.com/path")
  }

  func testCLIAndMCPExposeTheSameBrowserWorkflow() throws {
    let start = try ReproCLI.request(ReproCLI.parse(["start", "--headless", "about:blank", "--width", "1440", "--no-logs"]))
    XCTAssertEqual(start.method, "repro.start")
    XCTAssertEqual(start.params["headless"], .string("about:blank"))
    XCTAssertEqual(start.params["browser_width"], .number(1440))
    XCTAssertEqual(start.params["logs"], .bool(false))
    let run = try ReproCLI.request(ReproCLI.parse(["run", "shop", "e2e", "--headless", "about:blank"]))
    XCTAssertEqual(run.params["headless"], .string("about:blank"))
    let attached = try ReproCLI.request(ReproCLI.parse(["start", "--cdp", "http://localhost:9222", "--page-id", "PAGE"]))
    XCTAssertEqual(attached.params["page_id"], .string("PAGE"))
    let control = try ReproCLI.request(ReproCLI.parse(["browser", "--evaluate", "document.title", "--no-screenshot"]))
    XCTAssertEqual(control.params["expression"], .string("document.title"))
    XCTAssertEqual(control.params["screenshot"], .bool(false))
    XCTAssertEqual(try CinderdeckMCPServer.request(for: "repro_browser", control.params).0, control.method)
    for command in ["pause", "resume"] {
      XCTAssertEqual(try CinderdeckMCPServer.request(for: command + "_repro_recording", [:]).0,
        try ReproCLI.request(ReproCLI.parse([command])).method)
    }
    let schema = try XCTUnwrap(CinderdeckMCPServer.toolDescriptions.first { $0["name"]?.stringValue == "start_repro_recording" })
    for key in ["headless", "cdp", "page_id", "browser_executable", "browser_width", "browser_height"] {
      XCTAssertNotNil(schema["inputSchema"]?["properties"]?[key], key)
    }
    for arguments in [["start", "--headless", "about:blank", "--window-id", "3"],
      ["browser", "--url", "https://example.com", "--evaluate", "1"],
      ["run", "shop", "e2e", "--headless", "about:blank", "--audio"]] {
      XCTAssertThrowsError(try ReproCLI.request(ReproCLI.parse(arguments)))
    }
  }

  func testVideoKeepsIdleFramesAndCanBeReadByNormalReproTools() async throws {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: folder) }
    let url = folder.appendingPathComponent("recording.mp4")
    let writer = BrowserVideoWriter(url: url)
    let first = try await writer.append(jpeg: jpeg(red: 1, blue: 0), at: 0)
    let duplicate = try await writer.append(jpeg: jpeg(red: 0, blue: 1), at: 0)
    XCTAssertTrue(first); XCTAssertFalse(duplicate)
    let second = try await writer.append(jpeg: jpeg(red: 0, blue: 1), at: 1)
    XCTAssertTrue(second)
    let saved = try await writer.finish(at: 3)
    XCTAssertEqual(saved, url)
    let duration = try await AVURLAsset(url: saved).load(.duration).seconds
    XCTAssertEqual(duration, 3, accuracy: 0.1)
    let frames = try await ReproFrames.extract(video: saved, at: [0.5, 2.5], maxDimension: 320, into: folder)
    XCTAssertEqual(frames.count, 2)
    XCTAssertNotEqual(frames[0].data, frames[1].data, "An idle interval must retain the corresponding preceding image")
    XCTAssertGreaterThan(frames[0].data.count, 100)
    await writer.cancel()
    XCTAssertTrue(FileManager.default.fileExists(atPath: saved.path), "Late startup cleanup must not delete a saved recording")
  }

  func testCancelRemovesVideoAndInvalidFramesFail() async throws {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".mp4")
    let writer = BrowserVideoWriter(url: url)
    do { try await writer.append(jpeg: Data("invalid".utf8), at: 0); XCTFail("Invalid JPEG accepted") } catch {}
    try await writer.append(jpeg: jpeg(red: 1, blue: 0), at: 0)
    await writer.cancel()
    XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
  }

  func testRapidFinalChangeIsKeptInsteadOfDroppingTheLastStaticImage() async throws {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: folder) }
    let writer = BrowserVideoWriter(url: folder.appendingPathComponent("recording.mp4"))
    try await writer.append(jpeg: jpeg(red: 1, blue: 0), at: 0)
    let finalChange = try await writer.append(jpeg: jpeg(red: 0, blue: 1), at: 0.01)
    XCTAssertTrue(finalChange)
    try await writer.appendFinal(jpeg: jpeg(red: 0, blue: 1), at: 1)
    let saved = try await writer.finish(at: 1)
    let frames = try await ReproFrames.extract(video: saved, at: [10], maxDimension: 320, into: folder)
    let source = try XCTUnwrap(CGImageSourceCreateWithData(frames[0].data as CFData, nil))
    let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
    var pixel = [UInt8](repeating: 0, count: 4)
    pixel.withUnsafeMutableBytes { bytes in
      let context = CGContext(data: bytes.baseAddress, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
      context.draw(image, in: CGRect(x: 0, y: 0, width: 1, height: 1))
    }
    XCTAssertGreaterThan(pixel[2], 200, "The final idle image must be blue")
    XCTAssertLessThan(pixel[0], 40, "The original red image must not persist")
  }

  private func jpeg(red: CGFloat, blue: CGFloat) throws -> Data {
    let context = try XCTUnwrap(CGContext(data: nil, width: 320, height: 240, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
    context.setFillColor(CGColor(red: red, green: 0, blue: blue, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: 320, height: 240))
    let data = NSMutableData()
    let destination = try XCTUnwrap(CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil))
    CGImageDestinationAddImage(destination, try XCTUnwrap(context.makeImage()), nil)
    XCTAssertTrue(CGImageDestinationFinalize(destination))
    return data as Data
  }
}
