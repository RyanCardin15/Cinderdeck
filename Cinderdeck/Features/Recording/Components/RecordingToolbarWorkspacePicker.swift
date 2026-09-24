//
//  RecordingToolbarWorkspacePicker.swift
//  Cinderdeck
//
//  Chooses which workspace's logs are saved with the recording. Defaults to
//  None, so a recording is a plain video until a workspace is picked.
//

import SwiftUI

struct ToolbarWorkspacePicker: View {
  @ObservedObject var recorder: ReproRecorder
  @ObservedObject var supervisor: StackSupervisor
  @ObservedObject var runner: WorkspaceRunner
  @State private var isHovered = false

  /// Keeps long workspace names from stretching the toolbar.
  private static let maxTitleWidth: CGFloat = 150

  init(recorder: ReproRecorder = .shared, supervisor: StackSupervisor = .shared, runner: WorkspaceRunner = .shared) {
    self.recorder = recorder
    self.supervisor = supervisor
    self.runner = runner
  }

  private var choices: [WorkspaceLogChoice] { WorkspaceLogChoice.all(supervisor: supervisor, runner: runner) }
  private var outlook: WorkspaceLogOutlook { WorkspaceLogOutlook(scope: recorder.scope, choices: choices) }

  /// "None", "All running", a workspace name, or "2 workspaces".
  static func title(scope: ReproLogScope, choices: [WorkspaceLogChoice]) -> String {
    switch scope {
    case .off: return "None"
    case .running: return "All running"
    case .only(let ids):
      if ids.count > 1 { return "\(ids.count) workspaces" }
      guard let id = ids.first else { return "None" }
      return choices.first { $0.id == id }?.name ?? id
    }
  }

  var body: some View {
    HStack(spacing: ToolbarConstants.itemSpacing) {
      RecordingToolbarDivider()
      menu
    }
  }

  private var menu: some View {
    Menu {
      Button { recorder.setScope(.off) } label: {
        item("None (plain video)", selected: recorder.scope.isOff)
      }
      if choices.isEmpty {
        Section {
          Text("No workspaces yet")
          Button("Set Up Workspaces…") { WorkspaceWindowController.shared.show() }
        }
      } else {
        Section("Save logs from") {
          ForEach(choices) { choice in
            Button { recorder.setScope(.only([choice.id])) } label: {
              item("\(choice.name)  ·  \(choice.status)", selected: isSelected(choice.id))
            }
          }
          Button { recorder.setScope(.running) } label: {
            item("All running workspaces", selected: recorder.scope == .running)
          }
        }
        Section {
          Text(outlook.message)
          Button("Show Recordings with Logs…") { WorkspaceWindowController.shared.show(section: .recordings) }
        }
      }
    } label: {
      label
    }
    .menuStyle(.borderlessButton)
    .menuIndicator(.hidden)
    .buttonStyle(.plain)
    .fixedSize()
    .onHover { isHovered = $0 }
    .help("Workspace logs: " + outlook.message)
    .accessibilityLabel("Workspace")
    .accessibilityValue(Self.title(scope: recorder.scope, choices: choices))
    .accessibilityHint("Choose which workspace's logs are saved with the recording")
  }

  private var label: some View {
    let current = Self.title(scope: recorder.scope, choices: choices)
    return HStack(spacing: 4) {
      Image(systemName: outlook.icon)
        .font(.system(size: 12, weight: .regular))
        .foregroundColor(recorder.scope.isOff ? .secondary : .accentColor)
      // Reserve the widest option so picking a workspace doesn't resize the toolbar.
      ZStack(alignment: .leading) {
        ForEach(["None", "All running"] + choices.map(\.name), id: \.self) { Text($0).hidden() }
        Text(current)
      }
      .font(.system(size: 13, weight: .regular))
      .lineLimit(1)
      .truncationMode(.tail)
      .frame(maxWidth: Self.maxTitleWidth, alignment: .leading)
      Image(systemName: "chevron.down")
        .font(.system(size: 8, weight: .semibold))
    }
    .foregroundColor(.primary)
    .padding(.horizontal, 8)
    .padding(.vertical, 6)
    .background(
      RoundedRectangle(cornerRadius: ToolbarConstants.buttonCornerRadius)
        .fill(Color.primary.opacity(isHovered ? 0.1 : 0))
    )
    .contentShape(RoundedRectangle(cornerRadius: ToolbarConstants.buttonCornerRadius))
    .animation(ToolbarConstants.hoverAnimation, value: isHovered)
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
