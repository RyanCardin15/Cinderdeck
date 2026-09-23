//
//  UpdaterManager.swift
//  Cinderdeck
//
//  Shared Sparkle updater manager — singleton, starts updater once, logs lifecycle via DiagnosticLogger
//

import Sparkle
import AppKit

nonisolated enum CinderdeckUpdatePolicy {
  static let releasesURL = URL(string: "https://github.com/RyanCardin15/Cinderdeck/releases")!
  static func isConfigured(_ info: [String: Any]) -> Bool {
    guard info["CinderdeckSignedUpdatesEnabled"] as? Bool == true,
          info["SUFeedURL"] as? String == "https://raw.githubusercontent.com/RyanCardin15/Cinderdeck/main/appcast.xml",
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

final class UpdaterManager: NSObject, SPUUpdaterDelegate {
  static let shared = UpdaterManager()
  static var automaticUpdatesAvailable: Bool {
    CinderdeckUpdatePolicy.isConfigured(Bundle.main.infoDictionary ?? [:])
  }

  /// Current channel from UserDefaults; missing or invalid value resolves to stable.
  static var channel: UpdateChannel {
    UpdateChannel(rawValue: UserDefaults.standard.string(forKey: PreferencesKeys.updateChannel) ?? "") ?? .stable
  }

  private(set) var controller: SPUStandardUpdaterController!

  var updater: SPUUpdater {
    controller.updater
  }

  private override init() {
    super.init()
    controller = SPUStandardUpdaterController(
      startingUpdater: Self.automaticUpdatesAvailable,
      updaterDelegate: self,
      userDriverDelegate: nil
    )
    DiagnosticLogger.shared.log(.info, .update, "Updater initialized")
  }

  func checkForUpdates() {
    guard Self.automaticUpdatesAvailable else {
      NSWorkspace.shared.open(CinderdeckUpdatePolicy.releasesURL)
      return
    }
    DiagnosticLogger.shared.log(.info, .update, "Manual check for updates triggered")
    updater.checkForUpdates()
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
    let version = item.displayVersionString ?? "?"
    let build = item.versionString ?? "?"
    DiagnosticLogger.shared.log(.info, .update, "Update available: v\(version) (\(build))")
  }

  func updaterDidNotFindUpdate(_ updater: SPUUpdater, error: any Error) {
    DiagnosticLogger.shared.log(.warning, .update, "No update found: \(error.localizedDescription) [code=\((error as NSError).code), domain=\((error as NSError).domain)]")
  }

  func updater(_ updater: SPUUpdater, didDownloadUpdate item: SUAppcastItem) {
    let version = item.displayVersionString ?? "?"
    DiagnosticLogger.shared.log(.info, .update, "Downloaded update: v\(version)")
  }

  func updater(_ updater: SPUUpdater, willInstallUpdate item: SUAppcastItem) {
    let version = item.displayVersionString ?? "?"
    DiagnosticLogger.shared.log(.info, .update, "Installing update: v\(version)")
  }

  func updater(_ updater: SPUUpdater, didAbortWithError error: any Error) {
    let nsError = error as NSError
    DiagnosticLogger.shared.log(
      .error, .update,
      "Update aborted: \(nsError.localizedDescription) [code=\(nsError.code), domain=\(nsError.domain), info=\(nsError.userInfo)]"
    )
  }

  func updater(_ updater: SPUUpdater, didCancelInstallUpdateOnQuit item: SUAppcastItem) {
    let version = item.displayVersionString ?? "?"
    DiagnosticLogger.shared.log(.warning, .update, "User cancelled install on quit: v\(version)")
  }
}
