import Foundation

@MainActor
enum StackConfiguration {
  static func write(_ writer: inout SimpleTOMLWriter, defaults: UserDefaults? = nil) {
    writer.section("stacks")
    writer.value("enabled", defaults?.object(forKey: PreferencesKeys.stacksEnabled) as? Bool ?? true)
    writer.value("directory", defaults?.string(forKey: PreferencesKeys.stacksDirectory) ?? "~/.config/cinderdeck/stacks")
    writer.value("lanes_directory", defaults?.string(forKey: PreferencesKeys.stacksLanesDirectory) ?? "~/.cinderdeck/lanes")
    writer.value("quit_behavior", defaults?.string(forKey: PreferencesKeys.stacksQuitBehavior) ?? "ask")
    writer.value("notify_on_crash", defaults?.object(forKey: PreferencesKeys.stacksNotifyOnCrash) as? Bool ?? true)
    writer.value("auto_fetch_minutes", defaults?.integer(forKey: PreferencesKeys.stacksAutoFetchMinutes) ?? 0)
  }
  static func collect(_ reader: inout CinderdeckConfigurationReader, defaults: UserDefaults, mutations: inout [() -> Void]) {
    if let value = reader.bool("stacks", "enabled") { mutations.append { defaults.set(value, forKey: PreferencesKeys.stacksEnabled) } }
    if let value = reader.bool("stacks", "notify_on_crash") { mutations.append { defaults.set(value, forKey: PreferencesKeys.stacksNotifyOnCrash) } }
    if let value = reader.string("stacks", "directory") {
      if value.isEmpty || !(value.hasPrefix("/") || value.hasPrefix("~/")) {
        reader.error("stacks.directory must be an absolute path or start with ~/")
      } else { mutations.append { defaults.set(value, forKey: PreferencesKeys.stacksDirectory) } }
    }
    if let value = reader.string("stacks", "lanes_directory") {
      if value.isEmpty || !(value.hasPrefix("/") || value.hasPrefix("~/")) {
        reader.error("stacks.lanes_directory must be an absolute path or start with ~/")
      } else { mutations.append { defaults.set(value, forKey: PreferencesKeys.stacksLanesDirectory) } }
    }
    if let value = reader.string("stacks", "quit_behavior") {
      if !["ask", "stop", "leave"].contains(value) { reader.error("stacks.quit_behavior must be ask, stop or leave") }
      else { mutations.append { defaults.set(value, forKey: PreferencesKeys.stacksQuitBehavior) } }
    }
    if let value = reader.int("stacks", "auto_fetch_minutes") {
      if !(0...10080).contains(value) { reader.error("stacks.auto_fetch_minutes must be from 0 to 10080") }
      else { mutations.append { defaults.set(value, forKey: PreferencesKeys.stacksAutoFetchMinutes) } }
    }
  }
}
