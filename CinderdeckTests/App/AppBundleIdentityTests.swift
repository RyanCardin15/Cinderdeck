import XCTest
@testable import Cinderdeck

@MainActor
final class AppBundleIdentityTests: XCTestCase {
  func testDevelopmentBuildAcceptsNormalIdentityUsedByInstalledApp() async {
    XCTAssertTrue(AppBundleIdentity.matches("com.ryancardin.cinderdeck", debugBuild: true))
  }

  func testDevelopmentBuildAcceptsSeparateDebugIdentity() async {
    XCTAssertTrue(AppBundleIdentity.matches("com.ryancardin.cinderdeck.debug", debugBuild: true))
  }

  func testReleaseBuildRequiresReleaseIdentity() async {
    XCTAssertTrue(AppBundleIdentity.matches("com.ryancardin.cinderdeck", debugBuild: false))
    XCTAssertFalse(AppBundleIdentity.matches("com.ryancardin.cinderdeck.debug", debugBuild: false))
  }

  func testNeitherBuildAcceptsMissingOrUnrelatedIdentity() async {
    for debugBuild in [true, false] {
      for identifier in [nil, "", "com.example.cinderdeck", "com.ryancardin.cinderdeck.debug.other"] as [String?] {
        XCTAssertFalse(AppBundleIdentity.matches(identifier, debugBuild: debugBuild))
      }
    }
  }

  func testCurrentBuildUsesItsConfiguredDefault() async {
    XCTAssertTrue(AppBundleIdentity.matches(AppBundleIdentity.expected))
  }
}
