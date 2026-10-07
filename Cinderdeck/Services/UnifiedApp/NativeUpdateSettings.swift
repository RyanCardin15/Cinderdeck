import Foundation

@MainActor
enum NativeUpdateSettings {
  static func status() -> [String: JSONValue] {
    let manager = UpdaterManager.shared
    var result: [String: JSONValue] = ["working": .bool(manager.status.isWorking),
      "canCheck": .bool(manager.canCheckForUpdates), "canInstall": .bool(false)]
    let phase: String, message: String
    switch manager.status {
    case .unavailable: phase = "unavailable"; message = "This build uses manual updates."
    case .idle: phase = "idle"; message = "Ready to check for updates."
    case .checking: phase = "checking"; message = "Checking for updates…"
    case .upToDate: phase = "upToDate"; message = "Cinderdeck is up to date."
    case .available(let offer): phase = "available"; message = "Version \(offer.version) is available."; result["canInstall"] = .bool(true)
    case .downloading(_, let progress): phase = "downloading"; message = "Downloading update…"; if let progress { result["progress"] = .string(String(progress)) }
    case .extracting(_, let progress): phase = "extracting"; message = "Preparing update…"; if let progress { result["progress"] = .string(String(progress)) }
    case .readyToInstall: phase = "ready"; message = "The update is ready. Restart Cinderdeck to install it."; result["canInstall"] = .bool(true)
    case .installing: phase = "installing"; message = "Installing update…"
    case .failed(let detail): phase = "failed"; message = detail
    }
    result["phase"] = .string(phase); result["message"] = .string(message)
    if let date = manager.lastUpdateCheckDate { result["lastCheck"] = .string(date.formatted()) }
    if let offer = manager.status.offer {
      result["informationOnly"] = .bool(offer.isInformationOnly)
      if let url = offer.releaseNotesURL { result["releaseNotes"] = .string(url.absoluteString) }
    }
    return result
  }
}
