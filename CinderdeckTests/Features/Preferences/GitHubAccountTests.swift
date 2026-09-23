import XCTest
@testable import Cinderdeck

@MainActor
final class GitHubAccountTests: XCTestCase {
  func testDeviceCodeParsingOnlyAcceptsGitHubAuthorizationURLs() {
    let progress = GitHubSignInProgress.parse("! First copy your one-time code: ABCD-1234\nOpen this URL to continue in your web browser: https://github.com/login/device\n")
    XCTAssertEqual(progress.code, "ABCD-1234")
    XCTAssertEqual(progress.url?.absoluteString, "https://github.com/login/device")
    for url in ["https://github.com.evil.test/login/device", "https://github.com@evil.test/login/device", "https://user@github.com/login/device", "https://github.com/settings/tokens", "http://github.com/login/device"] {
      XCTAssertNil(GitHubSignInProgress.parse("Open this URL to continue in your web browser: \(url)").url)
    }
    XCTAssertNil(GitHubSignInProgress.parse("First copy your one-time code: not-a-code").code)
    XCTAssertEqual(GitHubSignInProgress.parse("First copy your one-time code: WXYZ-7890").url?.path, "/login/device")
  }

  func testCLIAbsenceHasAnInstallStateWithoutCallingViewer() async {
    let service = GitHubAccountService(configuration: { throw GitHubAccountError.missingCLI }, viewer: { XCTFail("No CLI available"); return "" })
    let status = await service.status()
    XCTAssertFalse(status.cliInstalled)
    XCTAssertNil(status.login)
  }

  func testVerifiedAccountAndEnvironmentManagementAreReported() async {
    let service = GitHubAccountService(configuration: { .init(executable: "/unused", environment: ["GH_TOKEN": "test-placeholder"]) }, viewer: { "reviewer" })
    let status = await service.status()
    XCTAssertEqual(status.login, "reviewer")
    XCTAssertTrue(status.managedByEnvironment)
    do { _ = try await service.signIn { _ in }; XCTFail("Must not override environment authentication") }
    catch { XCTAssertTrue(error.localizedDescription.contains("environment token")) }
  }

  func testAuthenticationProcessStreamsCodeWithoutChangingGitProtocol() async throws {
    let executable = try fakeCLI("""
      case "$*" in
        'auth login --hostname github.com --web --skip-ssh-key') ;;
        *) exit 8 ;;
      esac
      printf '! First copy your one-time code: ABCD-1234\n'
      printf 'Open this URL to continue in your web browser: https://github.com/login/device\n'
      /bin/sleep 0.3
      exit 0
      """)
    let service = GitHubAccountService(configuration: { .init(executable: executable.path, environment: [:]) })
    var received: GitHubSignInProgress?
    let notice = try await service.signIn { received = $0 }
    XCTAssertEqual(received?.code, "ABCD-1234")
    XCTAssertEqual(received?.url?.host, "github.com")
    XCTAssertNil(notice)
  }

  func testAuthenticationFailureDoesNotLeakCommandOutput() async throws {
    let executable = try fakeCLI("printf 'private diagnostic content\n'\nexit 1")
    let service = GitHubAccountService(configuration: { .init(executable: executable.path, environment: [:]) })
    do { _ = try await service.signIn { _ in }; XCTFail("Must fail") }
    catch {
      XCTAssertTrue(error.localizedDescription.contains("did not finish"))
      XCTAssertFalse(error.localizedDescription.contains("private diagnostic"))
    }
  }

  func testAuthenticationHasBoundedTimeout() async throws {
    let executable = try fakeCLI("/bin/sleep 3")
    let service = GitHubAccountService(configuration: { .init(executable: executable.path, environment: [:]) }, timeout: 0.15)
    do { _ = try await service.signIn { _ in }; XCTFail("Must expire") }
    catch { XCTAssertTrue(error.localizedDescription.contains("expired")) }
  }

  func testSuccessfulSignInVerifiesAccountAndNotifiesWorkspace() async throws {
    let service = AccountMock()
    let model = GitHubAccountViewModel(service: service)
    let notification = expectation(forNotification: .githubAccountChanged, object: nil) { note in
      note.userInfo?["login"] as? String == "signed-in-user" && note.userInfo?["force"] as? Bool == true
    }
    model.signIn()
    await fulfillment(of: [notification], timeout: 2)
    XCTAssertFalse(model.signingIn)
    XCTAssertNil(model.progress.code)
    XCTAssertEqual(model.account.login, "signed-in-user")
    XCTAssertTrue(model.notice?.contains("Signed in") == true)
  }

  func testCancelledSignInCannotPublishLateSuccess() async throws {
    let service = AccountMock(); service.delay = 150_000_000
    let model = GitHubAccountViewModel(service: service)
    model.signIn()
    try await Task.sleep(nanoseconds: 10_000_000)
    XCTAssertNotNil(model.progress.code)
    model.cancel()
    try await Task.sleep(nanoseconds: 200_000_000)
    XCTAssertTrue(service.cancelled)
    XCTAssertFalse(model.signingIn)
    XCTAssertNil(model.account.login)
    XCTAssertNil(model.progress.code)
    XCTAssertEqual(model.notice, "Sign-in cancelled.")
  }

  func testSignInErrorClearsOneTimeCodeAndCanRetry() async throws {
    let service = AccountMock(); service.fail = true
    let model = GitHubAccountViewModel(service: service)
    model.signIn()
    try await Task.sleep(nanoseconds: 30_000_000)
    XCTAssertFalse(model.signingIn)
    XCTAssertNil(model.progress.code)
    XCTAssertNotNil(model.error)
    service.fail = false
    model.signIn()
    try await Task.sleep(nanoseconds: 30_000_000)
    XCTAssertNil(model.error)
    XCTAssertEqual(model.account.login, "signed-in-user")
  }

  func testPreferencesRouteAndSidebarIncludeGitHubExactlyOnce() {
    XCTAssertEqual(CinderdeckDeepLinkAction(url: URL(string: "cinderdeck://settings/github")!), .openSettings(.github))
    XCTAssertEqual(PreferencesTab.groups.flatMap { $0 }.filter { $0 == .github }.count, 1)
    XCTAssertEqual(PreferencesTab.github.title, "GitHub")
  }

  private func fakeCLI(_ script: String) throws -> URL {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("cinderdeck-gh-test-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let file = directory.appendingPathComponent("gh")
    try ("#!/bin/sh\n" + script + "\n").write(to: file, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: file.path)
    addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
    return file
  }
}

@MainActor
private final class AccountMock: GitHubAccountServing {
  var fail = false
  var delay: UInt64 = 0
  var cancelled = false
  func status() async -> GitHubAccountSnapshot { .init(login: "signed-in-user") }
  func signIn(progress: @escaping (GitHubSignInProgress) -> Void) async throws -> String? {
    progress(.init(code: "ABCD-1234", url: URL(string: "https://github.com/login/device")))
    if delay > 0 { try? await Task.sleep(nanoseconds: delay) }
    if fail { throw GitHubAccountError.message("Sign-in failed") }
    return nil
  }
  func cancelSignIn() { cancelled = true }
}
