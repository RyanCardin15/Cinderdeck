//
//  CinderdeckConfigurationPathsTests.swift
//  CinderdeckTests
//
//  Tests for user-managed TOML configuration paths.
//

import Darwin
import XCTest
@testable import Cinderdeck

@MainActor
final class CinderdeckConfigurationPathsTests: XCTestCase {
  func testSuggestedConfigURLUsesProvidedHomeDirectory() {
    let home = URL(fileURLWithPath: "/Users/example", isDirectory: true)

    let url = CinderdeckConfigurationPaths.suggestedConfigURL(homeDirectory: home)

    XCTAssertEqual(url.path, "/Users/example/.config/cinderdeck/config.toml")
  }

  func testSuggestedConfigDirectoryURLUsesProvidedHomeDirectory() {
    let home = URL(fileURLWithPath: "/Users/example", isDirectory: true)

    let url = CinderdeckConfigurationPaths.suggestedConfigDirectoryURL(homeDirectory: home)

    XCTAssertEqual(url.path, "/Users/example/.config/cinderdeck")
  }

  func testCollapsingHomePathConvertsAbsolutePathToTilde() {
    let home = URL(fileURLWithPath: "/Users/example", isDirectory: true)

    XCTAssertEqual(
      CinderdeckConfigurationPaths.collapsingHomePath("/Users/example/Desktop", homeDirectory: home),
      "~/Desktop"
    )
    XCTAssertEqual(
      CinderdeckConfigurationPaths.collapsingHomePath("/Users/example", homeDirectory: home),
      "~"
    )
    XCTAssertEqual(
      CinderdeckConfigurationPaths.collapsingHomePath("/tmp/cinderdeck", homeDirectory: home),
      "/tmp/cinderdeck"
    )
  }

  func testExpandedUserPathUsesProvidedHomeDirectory() {
    let home = URL(fileURLWithPath: "/Users/example", isDirectory: true)

    XCTAssertEqual(
      CinderdeckConfigurationPaths.expandedUserPath("~/Desktop", homeDirectory: home),
      "/Users/example/Desktop"
    )
    XCTAssertEqual(
      CinderdeckConfigurationPaths.expandedUserPath("/tmp/cinderdeck", homeDirectory: home),
      "/tmp/cinderdeck"
    )
  }

  func testSuggestedConfigURLUsesAccountHomeDirectory() throws {
    guard
      let passwd = getpwuid(getuid()),
      let home = passwd.pointee.pw_dir
    else {
      throw XCTSkip("No POSIX home directory is available for the current user.")
    }

    let expectedHome = URL(fileURLWithPath: String(cString: home), isDirectory: true)
    let expectedURL = CinderdeckConfigurationPaths.suggestedConfigURL(homeDirectory: expectedHome)

    XCTAssertEqual(CinderdeckConfigurationService.shared.suggestedConfigURL.path, expectedURL.path)
  }
}
