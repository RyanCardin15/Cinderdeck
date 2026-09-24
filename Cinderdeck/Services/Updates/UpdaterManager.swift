//
//  UpdaterManager.swift
//  Cinderdeck
//
//  Shared Sparkle updater: starts once, publishes update status for Preferences and the menu bar,
//  and logs the update lifecycle via DiagnosticLogger
//

import AppKit
import Combine
import Sparkle

nonisolated enum CinderdeckUpdatePolicy {
  static let releasesURL = URL(string: "https://github.com/RyanCardin15/Cinderdeck/releases")!
  static let feedURL = "https://raw.githubusercontent.com/RyanCardin15/Cinderdeck/main/appcast.xml"
  /// Served by scripts/test-update-local.sh. Editing Info.plist breaks the app's signature,
  /// so only a build re-signed on the developer's Mac can point here.
  static let localTestFeedURL = "http://localhost:8089/appcast.xml"
  /// Debug builds use a separate bundle identifier and must never replace themselves with a release.
  static let releaseBundleIdentifier = "com.ryancardin.cinderdeck"

  static func releaseURL(forVersion version: String) -> URL {
    URL(string: "https://github.com/RyanCardin15/Cinderdeck/releases/tag/v\(version)") ?? releasesURL
  }

  static func isConfigured(_ info: [String: Any]) -> Bool {
    guard info["CinderdeckSignedUpdatesEnabled"] as? Bool == true,
          info["CFBundleIdentifier"] as? String == releaseBundleIdentifier,
          let feed = info["SUFeedURL"] as? String, feed == feedURL || feed == localTestFeedURL,
          let key = info["SUPublicEDKey"] as? String,
          Data(base64Encoded: key)?.count == 32 else { return false }
    // The upstream signing key must never authorize an update to this fork.
    return key != "zcoJ90nh+SEFg6ZEkb9fwQCEK51vSIRwyn6tOsQisL0="
  }
}

/// Sparkle update channel. Stable is the default; beta opts into pre-release builds.
enum UpdateChannel: String, CaseIterable {
  case stable
  case beta
}

final class UpdaterManager: NSObject, ObservableObject, SPUUpdaterDelegate, SPUStandardUserDriverDelegate {
  static let shared = UpdaterManager()
  static var automaticUpdatesAvailable: Bool {
    CinderdeckUpdatePolicy.isConfigured(Bundle.main.infoDictionary ?? [:])
  }

  /// Current channel from UserDefaults; missing or invalid value resolves to stable.
  static var channel: UpdateChannel {
    UpdateChannel(rawValue: UserDefaults.standard.string(forKey: PreferencesKeys.updateChannel) ?? "") ?? .stable
  }

  @Published private(set) var status: UpdateStatus
  @Published private(set) var canCheckForUpdates = false
  @Published private(set) var lastUpdateCheckDate: Date?

  /// Sparkle's updater. Callers get a plain `SPUUpdater`; the storage is only unset during `init`.
  var updater: SPUUpdater {
    sparkleUpdater
  }

  private var sparkleUpdater: SPUUpdater!
  private var userDriver: CinderdeckUpdateUserDriver!
  private var statusMachine: UpdateStatusMachine
  /// Installs a silently downloaded update and relaunches; Sparkle hands it over in `willInstallUpdateOnQuit`.
  private var immediateInstall: (() -> Void)?

  private override init() {
    let available = Self.automaticUpdatesAvailable
    statusMachine = UpdateStatusMachine(updatesAvailable: available)
    status = statusMachine.status
    super.init()

    let standardDriver = SPUStandardUserDriver(hostBundle: .main, delegate: self)
    let userDriver = CinderdeckUpdateUserDriver(
      standard: standardDriver,
      report: { [weak self] event in
        self?.apply(event)
      },
      showPreferences: {
        AppStatusBarController.shared.openPreferencesWindow(tab: .about)
      }
    )
    let updater = SPUUpdater(hostBundle: .main, applicationBundle: .main, userDriver: userDriver, delegate: self)
    self.userDriver = userDriver
    sparkleUpdater = updater
    updater.publisher(for: \.canCheckForUpdates)
      .assign(to: &$canCheckForUpdates)
    lastUpdateCheckDate = updater.lastUpdateCheckDate

    guard available else {
      DiagnosticLogger.shared.log(.info, .update, "Updater initialized; this build cannot update itself")
      return
    }
    do {
      try updater.start()
      DiagnosticLogger.shared.log(.info, .update, "Updater started")
    } catch {
      DiagnosticLogger.shared.log(.error, .update, "Updater failed to start: \(error.localizedDescription)")
      statusMachine = UpdateStatusMachine(updatesAvailable: false)
      status = statusMachine.status
    }
  }

  // MARK: - Settings

  var automaticallyChecksForUpdates: Bool {
    get { status != .unavailable && updater.automaticallyChecksForUpdates }
    set {
      objectWillChange.send()
      updater.automaticallyChecksForUpdates = newValue
    }
  }

  var automaticallyDownloadsUpdates: Bool {
    get { status != .unavailable && updater.automaticallyDownloadsUpdates }
    set {
      objectWillChange.send()
      updater.automaticallyDownloadsUpdates = newValue
    }
  }

  var canCancelUpdate: Bool {
    userDriver.canCancel
  }

  // MARK: - Actions

  /// Menu bar check: Sparkle's standard update window, or GitHub releases when this build cannot update itself.
  func checkForUpdates() {
    guard status != .unavailable else {
      NSWorkspace.shared.open(CinderdeckUpdatePolicy.releasesURL)
      return
    }
    DiagnosticLogger.shared.log(.info, .update, "Manual check for updates triggered")
    updater.checkForUpdates()
  }

  /// Preferences check: the result appears in `status` instead of Sparkle's windows.
  func checkForUpdatesInPreferences() {
    guard status != .unavailable else {
      NSWorkspace.shared.open(CinderdeckUpdatePolicy.releasesURL)
      return
    }
    DiagnosticLogger.shared.log(.info, .update, "Preferences check for updates triggered")
    startPreferencesSession(.check)
  }

  /// Downloads (if needed), installs, and relaunches the offered update without further prompts.
  func installUpdate() {
    guard status != .unavailable else {
      NSWorkspace.shared.open(CinderdeckUpdatePolicy.releasesURL)
      return
    }
    if let offer = status.offer, offer.isInformationOnly {
      NSWorkspace.shared.open(offer.releaseNotesURL ?? CinderdeckUpdatePolicy.releasesURL)
      return
    }
    if let immediateInstall {
      DiagnosticLogger.shared.log(.info, .update, "Installing downloaded update and relaunching")
      apply(.installing)
      // Sparkle allows calling this again if quitting was cancelled.
      immediateInstall()
      return
    }
    if userDriver.retryTerminatingApplication() {
      DiagnosticLogger.shared.log(.info, .update, "Retrying quit to install update")
      return
    }
    DiagnosticLogger.shared.log(.info, .update, "Preferences install triggered")
    startPreferencesSession(.install)
  }

  func cancelUpdate() {
    DiagnosticLogger.shared.log(.info, .update, "Update cancelled from Preferences")
    userDriver.cancel()
  }

  private func startPreferencesSession(_ intent: PreferencesUpdateIntent) {
    guard !updater.sessionInProgress else {
      // Brings the session already on screen (a Sparkle window or Preferences) forward.
      updater.checkForUpdates()
      return
    }
    guard updater.canCheckForUpdates else { return }
    userDriver.beginPreferencesSession(intent)
    updater.checkForUpdates()
    // Sparkle starts sessions synchronously; if it declined, the next scheduled
    // session must not inherit this intent.
    if !updater.sessionInProgress {
      userDriver.abandonPreferencesSession()
    }
  }

  private func apply(_ event: UpdateEvent) {
    statusMachine.apply(event)
    if status != statusMachine.status {
      status = statusMachine.status
    }
    let checkDate = sparkleUpdater?.lastUpdateCheckDate
    if lastUpdateCheckDate != checkDate {
      lastUpdateCheckDate = checkDate
    }
  }

  /// Outcomes that are part of normal use rather than failures worth showing.
  private static func isExpectedOutcome(_ error: any Error) -> Bool {
    let error = error as NSError
    guard error.domain == SUSparkleErrorDomain else { return false }
    // SUNoUpdateError, SUInstallationCanceledError, SUInstallationAuthorizeLaterError
    return [1001, 4007, 4008].contains(error.code)
  }

  // MARK: - SPUUpdaterDelegate

  func allowedChannels(for updater: SPUUpdater) -> Set<String> {
    let channel = Self.channel
    DiagnosticLogger.shared.log(.info, .update, "Allowed channels: \(channel == .beta ? "[beta]" : "[] (stable)")")
    return channel == .beta ? ["beta"] : []
  }

  func updater(_ updater: SPUUpdater, didFinishLoading appcast: SUAppcast) {
    let count = appcast.items.count
    DiagnosticLogger.shared.log(.info, .update, "Appcast loaded: \(count) item(s)")
  }

  func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) {
    DiagnosticLogger.shared.log(.info, .update, "Update available: v\(item.displayVersionString) (\(item.versionString))")
    apply(.found(UpdateOffer(item), alreadyDownloaded: false))
  }

  func updaterDidNotFindUpdate(_ updater: SPUUpdater, error: any Error) {
    DiagnosticLogger.shared.log(.info, .update, "No update found: \(error.localizedDescription)")
    apply(.notFound)
  }

  func updater(
    _ updater: SPUUpdater,
    userDidMake choice: SPUUserUpdateChoice,
    forUpdate updateItem: SUAppcastItem,
    state: SPUUserUpdateState
  ) {
    guard choice == .skip else { return }
    DiagnosticLogger.shared.log(.info, .update, "User skipped v\(updateItem.displayVersionString)")
    apply(.skipped)
  }

  func updater(_ updater: SPUUpdater, willDownloadUpdate item: SUAppcastItem, with request: NSMutableURLRequest) {
    // Also covers automatic downloads, which never reach the user driver.
    apply(.downloadStarted)
  }

  func updater(_ updater: SPUUpdater, didDownloadUpdate item: SUAppcastItem) {
    DiagnosticLogger.shared.log(.info, .update, "Downloaded update: v\(item.displayVersionString)")
    apply(.extracting(progress: nil))
  }

  func updater(_ updater: SPUUpdater, failedToDownloadUpdate item: SUAppcastItem, error: any Error) {
    DiagnosticLogger.shared.log(.warning, .update, "Download failed for v\(item.displayVersionString): \(error.localizedDescription)")
  }

  func updater(_ updater: SPUUpdater, willInstallUpdate item: SUAppcastItem) {
    DiagnosticLogger.shared.log(.info, .update, "Installing update: v\(item.displayVersionString)")
  }

  func updater(
    _ updater: SPUUpdater,
    willInstallUpdateOnQuit item: SUAppcastItem,
    immediateInstallationBlock immediateInstallHandler: @escaping () -> Void
  ) -> Bool {
    DiagnosticLogger.shared.log(.info, .update, "v\(item.displayVersionString) will install when Cinderdeck quits")
    apply(.readyToInstall(UpdateOffer(item)))
    // Sparkle presents critical updates immediately, but only while it keeps responsibility.
    guard !item.isCriticalUpdate else { return false }
    immediateInstall = immediateInstallHandler
    return true
  }

  func updaterWillRelaunchApplication(_ updater: SPUUpdater) {
    DiagnosticLogger.shared.log(.info, .update, "Relaunching after update")
  }

  func updater(_ updater: SPUUpdater, didAbortWithError error: any Error) {
    let nsError = error as NSError
    guard !Self.isExpectedOutcome(error) else { return }
    DiagnosticLogger.shared.log(
      .error, .update,
      "Update aborted: \(nsError.localizedDescription) [code=\(nsError.code), domain=\(nsError.domain), info=\(nsError.userInfo)]"
    )
  }

  func updater(_ updater: SPUUpdater, didFinishUpdateCycleFor updateCheck: SPUUpdateCheck, error: (any Error)?) {
    // Background checks fail quietly (for example, while offline); checks the user started report why.
    if let error, updateCheck != .updatesInBackground, !Self.isExpectedOutcome(error) {
      apply(.failed(error.localizedDescription))
    }
    apply(.sessionEnded)
  }

  // MARK: - SPUStandardUserDriverDelegate (gentle reminders)

  var supportsGentleScheduledUpdateReminders: Bool {
    true
  }

  func standardUserDriverShouldHandleShowingScheduledUpdate(
    _ update: SUAppcastItem,
    andInImmediateFocus immediateFocus: Bool
  ) -> Bool {
    // Near launch Sparkle's alert can come to the front. Otherwise it would open behind other apps,
    // so the menu bar and Preferences offer the update instead.
    immediateFocus || update.isCriticalUpdate
  }

  func standardUserDriverWillHandleShowingUpdate(
    _ handleShowingUpdate: Bool,
    forUpdate update: SUAppcastItem,
    state: SPUUserUpdateState
  ) {
    guard !handleShowingUpdate else { return }
    DiagnosticLogger.shared.log(.info, .update, "v\(update.displayVersionString) offered in the menu bar and Preferences")
  }
}
