//
//  RecordingToolbarWorkspaceLogsButton.swift
//  Cinderdeck
//
//  Chooses which workspaces' logs are saved with the recording. Shown only
//  when workspaces exist, so people who only record videos never see it.
//

import SwiftUI

struct ToolbarWorkspaceLogsButton: View {
  @ObservedObject var recorder: ReproRecorder
  @ObservedObject var supervisor: StackSupervisor
  @ObservedObject var runner: WorkspaceRunner
  @State private var isHovered = false

  init(recorder: ReproRecorder = .shared, supervisor: StackSupervisor = .shared, runner: WorkspaceRunner = .shared) {
    self.recorder = recorder
    self.supervisor = supervisor
    self.runner = runner
  }

  private var choices: [WorkspaceLogChoice] { WorkspaceLogChoice.all(supervisor: supervisor, runner: runner) }
  private var outlook: WorkspaceLogOutlook { WorkspaceLogOutlook(scope: recorder.scope, choices: choices) }

  var body: some View {
    if !supervisor.files.isEmpty {
      HStack(spacing: ToolbarConstants.itemSpacing) {
        RecordingToolbarDivider()
        menu
      }
    }
  }

  private var menu: some View {
    Menu {
      Section("Save workspace logs with this recording") {
        Button { recorder.setScope(.running) } label: {
          item("All running workspaces", selected: recorder.scope == .running)
        }
      }
      Section("Only these workspaces") {
        ForEach(choices) { choice in
          Button { recorder.setScope(recorder.scope.toggling(choice.id)) } label: {
            item("\(choice.name)  ·  \(choice.status)", selected: isSelected(choice.id))
          }
        }
      }
      Section {
        Button { recorder.setScope(.off) } label: {
          item("Don't save logs (plain video)", selected: recorder.scope.isOff)
        }
      }
      Section {
        Text(outlook.message)
        Button("Show Recordings with Logs…") { WorkspaceWindowController.shared.show(section: .recordings) }
      }
    } label: {
      ToolbarIconButtonLabel(systemName: outlook.icon, isHovered: isHovered)
        .opacity(outlook.state == .capturing ? 1 : 0.55)
        .overlay(alignment: .topTrailing) {
          if outlook.state == .capturing && outlook.workspaceCount > 1 {
            Text("\(outlook.workspaceCount)")
              .font(.system(size: 8, weight: .bold)).foregroundColor(.white)
              .frame(minWidth: 12, minHeight: 12)
              .background(Circle().fill(Color.accentColor))
              .offset(x: -3, y: 3)
          }
        }
    }
    .menuStyle(.borderlessButton)
    .menuIndicator(.hidden)
    .buttonStyle(.plain)
    .frame(width: ToolbarConstants.iconButtonSize, height: ToolbarConstants.iconButtonSize)
    .onHover { isHovered = $0 }
    .help("Workspace logs: " + outlook.message)
    .accessibilityLabel("Workspace logs")
    .accessibilityValue(outlook.message)
  }

  private func isSelected(_ id: String) -> Bool {
    if case .only(let ids) = recorder.scope { return ids.contains(id) }
    return false
  }

  @ViewBuilder
  private func item(_ title: String, selected: Bool) -> some View {
    if selected { Label(title, systemImage: "checkmark") } else { Text(title) }
  }
}
