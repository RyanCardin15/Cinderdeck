//
//  CinderdeckUpdateUserDriver.swift
//  Cinderdeck
//
//  Sparkle user driver: Sparkle's standard windows by default; Preferences shows progress inline
//  for checks and installs the user starts there.
//

import AppKit
import Sparkle

/// What an update session started from Preferences is for.
enum PreferencesUpdateIntent {
  /// Find out whether an update exists; Preferences then offers to install it.
  case check
  /// Download, install, and relaunch. The user already chose to install, so no further prompts.
  case install
}

/// Forwards update sessions to Sparkle's standard user driver, except sessions started from
/// Preferences, which report their progress to Preferences instead of opening Sparkle's windows.
/// Every session also reports its progress so Preferences and the menu bar stay current.
final class CinderdeckUpdateUserDriver: NSObject, SPUUserDriver {
  private let standard: any SPUUserDriver
  private let report: (UpdateEvent) -> Void
  private let showPreferences: () -> Void

  /// Set for the session Preferences started, until Sparkle dismisses it.
  private(set) var preferencesIntent: PreferencesUpdateIntent?
  private var cancellation: (() -> Void)?
  private var retryTermination: (() -> Void)?

  init(
    standard: any SPUUserDriver,
    report: @escaping (UpdateEvent) -> Void,
    showPreferences: @escaping () -> Void
  ) {
    self.standard = standard
    self.report = report
    self.showPreferences = showPreferences
    super.init()
  }

  /// Marks the session the caller is about to start as a Preferences session.
  func beginPreferencesSession(_ intent: PreferencesUpdateIntent) {
    preferencesIntent = intent
  }

  /// Clears a Preferences session that Sparkle did not start, so a later scheduled
  /// session is not mistaken for one the user asked to install.
  func abandonPreferencesSession() {
    preferencesIntent = nil
    cancellation = nil
    retryTermination = nil
  }

  var canCancel: Bool {
    preferencesIntent != nil && cancellation != nil
  }

  func cancel() {
    cancellation?()
  }

  /// Sends Cinderdeck's quit request again after quitting was cancelled mid-install.
  func retryTerminatingApplication() -> Bool {
    guard let retryTermination else { return false }
    retryTermination()
    return true
  }

  // MARK: - SPUUserDriver

  func show(_ request: SPUUpdatePermissionRequest, reply: @escaping (SUUpdatePermissionResponse) -> Void) {
    // Info.plist sets SUEnableAutomaticChecks, so Sparkle should never ask.
    standard.show(request, reply: reply)
  }

  func showUserInitiatedUpdateCheck(cancellation: @escaping () -> Void) {
    // Store the handler before reporting so Preferences can offer Cancel as soon as it updates.
    if preferencesIntent != nil {
      self.cancellation = cancellation
    } else {
      standard.showUserInitiatedUpdateCheck(cancellation: cancellation)
    }
    report(.checkStarted)
  }

  func showUpdateFound(
    with appcastItem: SUAppcastItem,
    state: SPUUserUpdateState,
    reply: @escaping (SPUUserUpdateChoice) -> Void
  ) {
    report(.found(UpdateOffer(appcastItem), alreadyDownloaded: state.stage != .notDownloaded))
    guard let intent = preferencesIntent else {
      standard.showUpdateFound(with: appcastItem, state: state, reply: reply)
      return
    }

    cancellation = nil
    // Dismissing keeps a downloaded update for the next session; it does not skip the version.
    if intent == .install && !appcastItem.isInformationOnlyUpdate {
      reply(.install)
    } else {
      reply(.dismiss)
    }
  }

  func showUpdateReleaseNotes(with downloadData: SPUDownloadData) {
    guard preferencesIntent == nil else { return }
    standard.showUpdateReleaseNotes(with: downloadData)
  }

  func showUpdateReleaseNotesFailedToDownloadWithError(_ error: Error) {
    guard preferencesIntent == nil else { return }
    standard.showUpdateReleaseNotesFailedToDownloadWithError(error)
  }

  func showUpdateNotFoundWithError(_ error: Error, acknowledgement: @escaping () -> Void) {
    report(.notFound)
    guard preferencesIntent == nil else {
      cancellation = nil
      acknowledgement()
      return
    }
    standard.showUpdateNotFoundWithError(error, acknowledgement: acknowledgement)
  }

  func showUpdaterError(_ error: Error, acknowledgement: @escaping () -> Void) {
    report(.failed(error.localizedDescription))
    guard preferencesIntent == nil else {
      cancellation = nil
      acknowledgement()
      return
    }
    standard.showUpdaterError(error, acknowledgement: acknowledgement)
  }

  func showDownloadInitiated(cancellation: @escaping () -> Void) {
    if preferencesIntent != nil {
      self.cancellation = cancellation
    } else {
      standard.showDownloadInitiated(cancellation: cancellation)
    }
    report(.downloadStarted)
  }

  func showDownloadDidReceiveExpectedContentLength(_ expectedContentLength: UInt64) {
    report(.downloadExpectedLength(expectedContentLength))
    guard preferencesIntent == nil else { return }
    standard.showDownloadDidReceiveExpectedContentLength(expectedContentLength)
  }

  func showDownloadDidReceiveData(ofLength length: UInt64) {
    report(.downloadReceivedData(length))
    guard preferencesIntent == nil else { return }
    standard.showDownloadDidReceiveData(ofLength: length)
  }

  func showDownloadDidStartExtractingUpdate() {
    // Sparkle no longer accepts cancellation once extraction starts.
    cancellation = nil
    report(.extracting(progress: nil))
    guard preferencesIntent == nil else { return }
    standard.showDownloadDidStartExtractingUpdate()
  }

  func showExtractionReceivedProgress(_ progress: Double) {
    report(.extracting(progress: progress))
    guard preferencesIntent == nil else { return }
    standard.showExtractionReceivedProgress(progress)
  }

  func showReady(toInstallAndRelaunch reply: @escaping (SPUUserUpdateChoice) -> Void) {
    guard preferencesIntent != nil else {
      report(.readyToInstall(nil))
      standard.showReady(toInstallAndRelaunch: reply)
      return
    }
    report(.installing)
    reply(.install)
  }

  func showInstallingUpdate(
    withApplicationTerminated applicationTerminated: Bool,
    retryTerminatingApplication: @escaping () -> Void
  ) {
    if preferencesIntent != nil {
      // Quitting can be cancelled (for example, to keep workspaces running); keep a way to retry.
      retryTermination = applicationTerminated ? nil : retryTerminatingApplication
    } else {
      standard.showInstallingUpdate(
        withApplicationTerminated: applicationTerminated,
        retryTerminatingApplication: retryTerminatingApplication
      )
    }
    report(.installing)
  }

  func showUpdateInstalledAndRelaunched(_ relaunched: Bool, acknowledgement: @escaping () -> Void) {
    guard preferencesIntent == nil else {
      acknowledgement()
      return
    }
    standard.showUpdateInstalledAndRelaunched(relaunched, acknowledgement: acknowledgement)
  }

  func showUpdateInFocus() {
    if preferencesIntent != nil {
      showPreferences()
    } else {
      standard.showUpdateInFocus?()
    }
  }

  func dismissUpdateInstallation() {
    abandonPreferencesSession()
    // Always forwarded: the standard driver tears down whatever it showed, which may be nothing.
    standard.dismissUpdateInstallation()
    report(.sessionEnded)
  }
}

extension UpdateOffer {
  init(_ item: SUAppcastItem) {
    self.init(
      version: item.displayVersionString,
      build: item.versionString,
      releaseNotesURL: item.fullReleaseNotesURL
        ?? item.releaseNotesURL
        ?? item.infoURL
        ?? CinderdeckUpdatePolicy.releaseURL(forVersion: item.displayVersionString),
      isInformationOnly: item.isInformationOnlyUpdate,
      isCritical: item.isCriticalUpdate
    )
  }
}
