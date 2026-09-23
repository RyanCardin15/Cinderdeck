import Foundation

enum HistorySection: String, CaseIterable {
  case captures, clipboard, stacks
  var searchPrompt: String {
    switch self {
    case .captures: return "Search captures"
    case .clipboard: return "Search clipboard text"
    case .stacks: return "Search stacks"
    }
  }
  static func stored(defaults: UserDefaults = .standard) -> HistorySection {
    if let raw = defaults.string(forKey: PreferencesKeys.historySelectedSection), let section = Self(rawValue: raw) { return section }
    let section: Self = defaults.bool(forKey: PreferencesKeys.historyClipboardTextSelected) ? .clipboard : .captures
    defaults.set(section.rawValue, forKey: PreferencesKeys.historySelectedSection)
    return section
  }
}

enum StackKeyboardCommand: String {
  case toggle, restart, restartService, stop, branch, logs
}

extension Notification.Name {
  static let historyMoveSelection = Notification.Name("historyMoveSelection")
  static let stacksCommand = Notification.Name("stacksCommand")
}
