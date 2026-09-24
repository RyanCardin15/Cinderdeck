import XCTest
@testable import Cinderdeck

final class UpdateStatusMachineTests: XCTestCase {
  private let offer = UpdateOffer(
    version: "1.0.2",
    build: "202",
    releaseNotesURL: URL(string: "https://github.com/RyanCardin15/Cinderdeck/releases/tag/v1.0.2"),
    isInformationOnly: false,
    isCritical: false
  )

  private func run(_ events: UpdateEvent...) -> UpdateStatusMachine {
    var machine = UpdateStatusMachine(updatesAvailable: true)
    events.forEach { machine.apply($0) }
    return machine
  }

  func testBuildsThatCannotUpdateIgnoreEvents() {
    var machine = UpdateStatusMachine(updatesAvailable: false)
    machine.apply(.checkStarted)
    machine.apply(.found(offer, alreadyDownloaded: false))
    XCTAssertEqual(machine.status, .unavailable)
  }

  func testCheckReportsAvailableUpdateOrUpToDate() {
    XCTAssertEqual(run(.checkStarted).status, .checking)
    XCTAssertEqual(run(.checkStarted, .found(offer, alreadyDownloaded: false), .sessionEnded).status, .available(offer))
    XCTAssertEqual(run(.checkStarted, .notFound, .sessionEnded).status, .upToDate)
  }

  func testCancelledCheckRestoresPreviousResult() {
    XCTAssertEqual(run(.checkStarted, .notFound, .checkStarted, .sessionEnded).status, .upToDate)
    XCTAssertEqual(run(.checkStarted, .sessionEnded).status, .idle)
  }

  func testDownloadProgressIsAFractionOnceTheSizeIsKnown() {
    var machine = run(.found(offer, alreadyDownloaded: false), .downloadStarted)
    XCTAssertEqual(machine.status, .downloading(offer, progress: nil))
    machine.apply(.downloadExpectedLength(200))
    machine.apply(.downloadReceivedData(50))
    XCTAssertEqual(machine.status, .downloading(offer, progress: 0.25))
    // Sparkle's expected length can be wrong; progress never passes 100%.
    machine.apply(.downloadReceivedData(400))
    XCTAssertEqual(machine.status, .downloading(offer, progress: 1))
  }

  func testCancelledDownloadKeepsOfferingTheUpdate() {
    let status = run(.found(offer, alreadyDownloaded: false), .downloadStarted, .downloadReceivedData(10), .sessionEnded).status
    XCTAssertEqual(status, .available(offer))
  }

  func testDownloadedUpdateIsReadyToInstall() {
    XCTAssertEqual(run(.checkStarted, .found(offer, alreadyDownloaded: true)).status, .readyToInstall(offer))
    XCTAssertEqual(run(.found(offer, alreadyDownloaded: false), .readyToInstall(nil)).status, .readyToInstall(offer))
  }

  func testLaterChecksDoNotHideAPendingInstall() {
    var machine = run(.readyToInstall(offer))
    machine.apply(.checkStarted)
    machine.apply(.notFound)
    machine.apply(.sessionEnded)
    XCTAssertEqual(machine.status, .readyToInstall(offer))
  }

  func testInstallThatDoesNotQuitStaysReadyToInstall() {
    let status = run(.readyToInstall(offer), .installing, .sessionEnded).status
    XCTAssertEqual(status, .readyToInstall(offer))
  }

  func testFailureSurvivesTheEndOfItsSession() {
    XCTAssertEqual(run(.checkStarted, .failed("offline"), .sessionEnded).status, .failed("offline"))
    XCTAssertEqual(run(.failed("offline"), .checkStarted, .notFound).status, .upToDate)
  }

  func testSkippingAVersionClearsTheOffer() {
    let status = run(.found(offer, alreadyDownloaded: false), .skipped, .sessionEnded).status
    XCTAssertEqual(status, .idle)
  }

  func testStatusExposesOfferAndWhetherSparkleIsWorking() {
    XCTAssertEqual(UpdateStatus.available(offer).offer, offer)
    XCTAssertNil(UpdateStatus.upToDate.offer)
    XCTAssertTrue(UpdateStatus.downloading(offer, progress: 0.5).isWorking)
    XCTAssertFalse(UpdateStatus.readyToInstall(offer).isWorking)
  }

  func testReleaseURLPointsAtTheVersionTag() {
    XCTAssertEqual(
      CinderdeckUpdatePolicy.releaseURL(forVersion: "1.0.2-beta.1").absoluteString,
      "https://github.com/RyanCardin15/Cinderdeck/releases/tag/v1.0.2-beta.1"
    )
  }
}
