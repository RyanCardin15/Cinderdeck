import SwiftUI

/// A workspace as offered in "which logs go with this recording" choices.
struct WorkspaceLogChoice: Identifiable, Equatable {
  let id: String
  let name: String
  let runningServices: Int
  let hasActiveRun: Bool

  var isActive: Bool { runningServices > 0 || hasActiveRun }
  var status: String {
    if runningServices > 0 { return "\(runningServices) running" }
    return hasActiveRun ? "task running" : "not running"
  }

  static func all(supervisor: StackSupervisor, runner: WorkspaceRunner) -> [WorkspaceLogChoice] {
    supervisor.files.map { file in
      WorkspaceLogChoice(id: file.id, name: file.name,
        runningServices: supervisor.states[file.id]?.services.values.filter { $0.phase.isActive || $0.process != nil }.count ?? 0,
        hasActiveRun: runner.activeRun(file.id) != nil)
    }.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
  }
}

/// What the current choice will do to the next recording, in one sentence.
struct WorkspaceLogOutlook: Equatable {
  enum State { case capturing, waiting, off }
  let state: State
  let message: String
  let workspaceCount: Int

  var icon: String {
    switch state {
    case .capturing: return "text.badge.checkmark"
    case .waiting: return "text.alignleft"
    case .off: return "text.badge.xmark"
    }
  }

  init(scope: ReproLogScope, choices: [WorkspaceLogChoice]) {
    switch scope {
    case .off:
      state = .off; workspaceCount = 0
      message = "Workspace logs are off. The video is saved on its own."
    case .running:
      let active = choices.filter(\.isActive)
      workspaceCount = active.count
      if active.isEmpty {
        state = .waiting
        message = "No workspace is running, so this is a plain video. Logs are captured from any workspace that starts while you record."
      } else {
        state = .capturing
        message = "Logs from \(ReproFormat.list(active.map(\.name))) are saved with the video."
      }
    case .only(let ids):
      let selected = choices.filter { ids.contains($0.id) }
      let active = selected.filter(\.isActive)
      workspaceCount = selected.count
      if selected.isEmpty {
        state = .off
        message = "No workspaces are selected. The video is saved on its own."
      } else if active.isEmpty {
        state = .waiting
        message = "\(ReproFormat.list(selected.map(\.name))) \(selected.count == 1 ? "isn't" : "aren't") running. Logs are captured if \(selected.count == 1 ? "it starts" : "they start") while you record."
      } else {
        state = .capturing
        message = "Logs from \(ReproFormat.list(active.map(\.name))) are saved with the video."
      }
    }
  }
}

/// The shared "which workspace logs" controls for Preferences and Workspaces.
struct WorkspaceLogSettingsRows: View {
  @ObservedObject var recorder: ReproRecorder
  @ObservedObject var supervisor: StackSupervisor
  @ObservedObject var runner: WorkspaceRunner
  @AppStorage(PreferencesKeys.reproLogNextToVideo) private var nextToVideo = true

  init(recorder: ReproRecorder = .shared, supervisor: StackSupervisor = .shared, runner: WorkspaceRunner = .shared) {
    self.recorder = recorder
    self.supervisor = supervisor
    self.runner = runner
  }

  private var choices: [WorkspaceLogChoice] { WorkspaceLogChoice.all(supervisor: supervisor, runner: runner) }

  private var mode: Binding<String> {
    Binding(get: { recorder.scope.isOff ? "off" : recorder.scope.mode }, set: { value in
      switch value {
      case "off": recorder.setScope(.off)
      case "selected":
        let running = Set(choices.filter(\.isActive).map(\.id))
        recorder.setScope(.only(running.isEmpty ? Set(choices.prefix(1).map(\.id)) : running))
      default: recorder.setScope(.running)
      }
    })
  }

  var body: some View {
    Picker("Attach workspace logs to recordings", selection: mode) {
      Text("From all running workspaces").tag("running")
      Text("From selected workspaces").tag("selected")
      Text("Off — plain videos").tag("off")
    }
    if case .only(let ids) = recorder.scope {
      ForEach(choices) { choice in
        Toggle(isOn: Binding(get: { ids.contains(choice.id) }, set: { _ in recorder.setScope(recorder.scope.toggling(choice.id)) })) {
          HStack {
            Text(choice.name)
            Text(choice.status).font(.caption).foregroundColor(.secondary)
          }
        }
        .padding(.leading, 16)
      }
    }
    Toggle("Save the log file next to the video", isOn: $nextToVideo)
      .disabled(recorder.scope.isOff)
    Text(WorkspaceLogOutlook(scope: recorder.scope, choices: choices).message
      + " Each log line is stamped with its position in the video. You can also change this from the recording toolbar.")
      .font(.caption).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
  }
}

/// A one-line menu that shows and changes which workspaces toolbar recordings capture.
struct WorkspaceLogScopeMenu: View {
  @ObservedObject var recorder: ReproRecorder
  @ObservedObject var supervisor: StackSupervisor
  @ObservedObject var runner: WorkspaceRunner

  init(recorder: ReproRecorder = .shared, supervisor: StackSupervisor = .shared, runner: WorkspaceRunner = .shared) {
    self.recorder = recorder
    self.supervisor = supervisor
    self.runner = runner
  }

  private var choices: [WorkspaceLogChoice] { WorkspaceLogChoice.all(supervisor: supervisor, runner: runner) }

  var body: some View {
    let outlook = WorkspaceLogOutlook(scope: recorder.scope, choices: choices)
    Menu {
      Button { recorder.setScope(.running) } label: { item("All running workspaces", recorder.scope == .running) }
      Section("Only these workspaces") {
        ForEach(choices) { choice in
          Button { recorder.setScope(recorder.scope.toggling(choice.id)) } label: {
            item("\(choice.name)  ·  \(choice.status)", { if case .only(let ids) = recorder.scope { return ids.contains(choice.id) }; return false }())
          }
        }
      }
      Divider()
      Button { recorder.setScope(.off) } label: { item("Don't save logs (plain videos)", recorder.scope.isOff) }
    } label: {
      Label(title, systemImage: outlook.icon)
    }
    .fixedSize()
    .help(outlook.message)
  }

  private var title: String {
    switch recorder.scope {
    case .running: return "Screen recordings save logs from all running workspaces"
    case .off: return "Screen recordings don't save workspace logs"
    case .only:
      if recorder.scope.isOff { return "Screen recordings don't save workspace logs" }
      return "Screen recordings save logs from " + recorder.scope.summary(names: Dictionary(uniqueKeysWithValues: choices.map { ($0.id, $0.name) }))
    }
  }

  @ViewBuilder
  private func item(_ title: String, _ selected: Bool) -> some View {
    if selected { Label(title, systemImage: "checkmark") } else { Text(title) }
  }
}
