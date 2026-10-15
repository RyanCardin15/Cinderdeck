import AppKit
import XCTest
@testable import Cinderdeck

final class RecentAppContextTests: XCTestCase {
  func testRequestsAcceptOnlyListedTargetTokens() throws {
    let id = "12345678-1234-1234-1234-123456789012"
    XCTAssertEqual(try RecentAppContextRequest.decode(Data("{\"requestID\":\"\(id)\",\"action\":\"list\"}".utf8)).action, "list")
    XCTAssertEqual(try RecentAppContextRequest.decode(Data("{\"requestID\":\"\(id)\",\"action\":\"capture\",\"targetID\":\"\(id)\"}".utf8)).targetID, id)
    for request in [
      "{\"requestID\":\"\(id)\",\"action\":\"capture\",\"targetID\":\"/tmp/window\"}",
      "{\"requestID\":\"\(id)\",\"action\":\"list\",\"app\":\"other\"}",
      "{\"requestID\":\"\(id)\",\"action\":\"list\",\"targetID\":\"\(id)\"}",
      "{\"requestID\":\"bad\",\"action\":\"list\"}",
    ] { XCTAssertThrowsError(try RecentAppContextRequest.decode(Data(request.utf8))) }
  }

  func testSuggestionsExcludeTheHostAndCredentialInterfaces() {
    XCTAssertTrue(RecentAppContext.eligible(bundleID: "com.google.Chrome", regular: true))
    for id in ["com.ryancardin.cinderdeck.debug", "com.ryancardin.cinderdeck.runtime", "com.apple.Passwords", "com.apple.SecurityAgent"] {
      XCTAssertFalse(RecentAppContext.eligible(bundleID: id, regular: true))
    }
    XCTAssertFalse(RecentAppContext.eligible(bundleID: "test.background", regular: false))
  }

  func testTabMetadataAcceptsOnlyBoundedWebURLs() {
    XCTAssertNotNil(RecentAppContext.webURL("https://example.com/fixture"))
    for url in ["file:///tmp/private", "javascript:alert(1)", "chrome://settings", "https://user:password@example.com", "https://example.com/" + String(repeating: "x", count: 5000)] {
      XCTAssertNil(RecentAppContext.webURL(url))
    }
  }

  func testUnicodeMetadataFitsTheRendererContract() {
    let title = RecentAppContext.bounded(String(repeating: "🐟", count: 1000), limit: 255)
    XCTAssertLessThanOrEqual(title.utf16.count, 255)
    XCTAssertEqual(RecentAppContext.bounded("Fixture", limit: 1000), "Fixture")
  }

  @MainActor func testAppIconsUseFixedPixelsAndFitTheWireBudget() throws {
    let image = NSImage(size: NSSize(width: 256, height: 256))
    image.lockFocus()
    NSColor.systemOrange.setFill()
    NSBezierPath(ovalIn: NSRect(x: 0, y: 0, width: 256, height: 256)).fill()
    image.unlockFocus()
    let uri = try XCTUnwrap(RecentAppContext.iconData(image))
    let encoded = String(uri.dropFirst("data:image/png;base64,".count))
    let png = try XCTUnwrap(Data(base64Encoded: encoded))
    let decoded = try XCTUnwrap(NSBitmapImageRep(data: png))
    XCTAssertEqual(decoded.pixelsWide, 64)
    XCTAssertEqual(decoded.pixelsHigh, 64)
    XCTAssertLessThan(uri.utf8.count, 100_000)
  }
}
