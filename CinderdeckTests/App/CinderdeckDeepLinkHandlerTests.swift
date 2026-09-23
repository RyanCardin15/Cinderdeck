//
//  CinderdeckDeepLinkHandlerTests.swift
//  CinderdeckTests
//
//  Unit tests for cinderdeck:// automation URL parsing.
//

import XCTest
@testable import Cinderdeck

final class CinderdeckDeepLinkHandlerTests: XCTestCase {

  func testCanonicalRoutesParseExpectedActions() throws {
    let cases: [(String, CinderdeckDeepLinkAction)] = [
      ("cinderdeck://capture/fullscreen", .captureFullscreen),
      ("cinderdeck://capture/area", .captureArea),
      ("cinderdeck://capture/repeat-area", .captureRepeatArea),
      ("cinderdeck://capture/application", .captureApplication),
      ("cinderdeck://capture/area-annotate", .captureAreaAnnotate),
      ("cinderdeck://capture/scrolling", .captureScrolling),
      ("cinderdeck://capture/ocr", .captureOCR),
      ("cinderdeck://capture/smart-element", .captureSmartElement),
      ("cinderdeck://capture/object-cutout", .captureObjectCutout),
      ("cinderdeck://record/screen", .recordScreen),
      ("cinderdeck://record/application", .recordApplication),
      ("cinderdeck://open/annotate", .openAnnotate),
      ("cinderdeck://open/combine", .openCombine([])),
      ("cinderdeck://open/video-editor", .openVideoEditor),
      ("cinderdeck://open/cloud-uploads", .openCloudUploads),
      ("cinderdeck://open/history", .openHistory),
      ("cinderdeck://show/shortcuts", .showShortcuts),
      ("cinderdeck://settings", .openSettings(nil)),
    ]

    for (urlString, expectedAction) in cases {
      let url = try XCTUnwrap(URL(string: urlString))
      XCTAssertEqual(CinderdeckDeepLinkAction(url: url), expectedAction, urlString)
    }
  }

  func testRepeatAreaAliasesParseExpectedAction() throws {
    let aliases = [
      "cinderdeck://repeat-area",
      "cinderdeck://capture-repeat-area",
      "cinderdeck://screenshot/repeat-area",
    ]

    for urlString in aliases {
      let url = try XCTUnwrap(URL(string: urlString))
      XCTAssertEqual(CinderdeckDeepLinkAction(url: url), .captureRepeatArea, urlString)
    }
  }

  func testCombineAliasesParseExpectedAction() throws {
    let aliases = [
      "cinderdeck://combine",
      "cinderdeck://combine-images",
      "cinderdeck://open-combine",
    ]

    for urlString in aliases {
      let url = try XCTUnwrap(URL(string: urlString))
      XCTAssertEqual(CinderdeckDeepLinkAction(url: url), .openCombine([]), urlString)
    }
  }

  func testCombineRouteParsesRepeatedFileParameters() throws {
    var components = try XCTUnwrap(URLComponents(string: "cinderdeck://open/combine"))
    components.queryItems = [
      URLQueryItem(name: "file", value: "/tmp/first image.png"),
      URLQueryItem(name: "file", value: "file:///tmp/second.jpg"),
      URLQueryItem(name: "ignored", value: "/tmp/not-used.png"),
    ]

    let url = try XCTUnwrap(components.url)
    XCTAssertEqual(
      CinderdeckDeepLinkAction(url: url),
      .openCombine([
        URL(fileURLWithPath: "/tmp/first image.png"),
        URL(fileURLWithPath: "/tmp/second.jpg"),
      ])
    )
  }

  func testApplicationCaptureAliasesParseExpectedAction() throws {
    let aliases = [
      "cinderdeck://capture/window",
      "cinderdeck://application-capture",
      "cinderdeck://window-capture",
      "cinderdeck://screenshot/window",
    ]

    for urlString in aliases {
      let url = try XCTUnwrap(URL(string: urlString))
      XCTAssertEqual(CinderdeckDeepLinkAction(url: url), .captureApplication, urlString)
    }
  }

  func testApplicationRecordingAliasesParseExpectedAction() throws {
    let aliases = [
      "cinderdeck://record/window",
      "cinderdeck://application-recording",
      "cinderdeck://window-recording",
      "cinderdeck://recording/window",
    ]

    for urlString in aliases {
      let url = try XCTUnwrap(URL(string: urlString))
      XCTAssertEqual(CinderdeckDeepLinkAction(url: url), .recordApplication, urlString)
    }
  }

  func testSettingsTabRoutesParseExpectedTabs() throws {
    let cases: [(String, PreferencesTab)] = [
      ("general", .general),
      ("menubar", .menuBar),
      ("menu-bar", .menuBar),
      ("capture", .capture),
      ("annotate", .annotate),
      ("quick-access", .quickAccess),
      ("history", .history),
      ("shortcuts", .shortcuts),
      ("permissions", .permissions),
      ("cloud", .cloud),
      ("github", .github),
      ("git", .github),
      ("advanced", .advanced),
      ("about", .about),
    ]

    for (tabName, expectedTab) in cases {
      let queryURL = try XCTUnwrap(URL(string: "cinderdeck://settings?tab=\(tabName)"))
      XCTAssertEqual(CinderdeckDeepLinkAction(url: queryURL), .openSettings(expectedTab), tabName)

      let pathURL = try XCTUnwrap(URL(string: "cinderdeck://settings/\(tabName)"))
      XCTAssertEqual(CinderdeckDeepLinkAction(url: pathURL), .openSettings(expectedTab), tabName)
    }
  }

  func testUnsupportedRoutesReturnNil() throws {
    let urls = [
      "https://capture/area",
      "cinderdeck://",
      "cinderdeck://capture/unknown",
      "cinderdeck://record/stop",
      "cinderdeck://open/unknown",
    ]

    for urlString in urls {
      let url = try XCTUnwrap(URL(string: urlString))
      XCTAssertNil(CinderdeckDeepLinkAction(url: url), urlString)
    }
  }

  func testDeepLinkHandlerChecksUrlSchemeEnabled() throws {
    let defaults = UserDefaults.standard
    let originalValue = defaults.object(forKey: PreferencesKeys.urlSchemeEnabled)
    defer {
      if let originalValue {
        defaults.set(originalValue, forKey: PreferencesKeys.urlSchemeEnabled)
      } else {
        defaults.removeObject(forKey: PreferencesKeys.urlSchemeEnabled)
      }
    }

    defaults.set(false, forKey: PreferencesKeys.urlSchemeEnabled)
    let viewModel = ScreenCaptureViewModel()
    let handler = CinderdeckDeepLinkHandler(screenCaptureViewModel: viewModel)
    let url = try XCTUnwrap(URL(string: "cinderdeck://capture/fullscreen"))
    handler.handle(url)
  }
}
