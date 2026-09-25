//
//  RecordingToolbarWorkspacePicker.swift
//  Cinderdeck
//
//  Chooses which workspaces' logs are saved with the recording: none, all
//  running, or any set of workspaces. Defaults to None, so a recording is a
//  plain video until a workspace is picked.
//

import SwiftUI

struct ToolbarWorkspacePicker: View {
  @ObservedObject var recorder: ReproRecorder
  @ObservedObject var supervisor: StackSupervisor
  @ObservedObject var runner: WorkspaceRunner
  @State private var isHovered = false
  @State private var showPopover = false

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
    Button { showPopover.toggle() } label: { label }
      .buttonStyle(.plain)
      .fixedSize()
      .onHover { isHovered = $0 }
      .help("Workspace logs: " + outlook.message)
      .popover(isPresented: $showPopover, arrowEdge: .bottom) {
        ToolbarWorkspacePopoverContent(recorder: recorder, choices: choices, outlook: outlook) { showPopover = false }
      }
      .accessibilityLabel("Workspace")
      .accessibilityValue(Self.title(scope: recorder.scope, choices: choices))
      .accessibilityHint("Choose which workspaces' logs are saved with the recording. You can pick several.")
  }

  private var label: some View {
    let current = Self.title(scope: recorder.scope, choices: choices)
    return HStack(spacing: 4) {
      Image(systemName: outlook.icon)
        .font(.system(size: 12, weight: .regular))
        .foregroundColor(recorder.scope.isOff ? .secondary : .accentColor)
      // Reserve the widest option so picking a workspace doesn't resize the toolbar.
      ZStack(alignment: .leading) {
        ForEach(["None", "All running", "\(max(choices.count, 2)) workspaces"] + choices.map(\.name), id: \.self) { Text($0).hidden() }
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
        .fill(Color.primary.opacity(isHovered || showPopover ? 0.1 : 0))
    )
    .contentShape(RoundedRectangle(cornerRadius: ToolbarConstants.buttonCornerRadius))
    .animation(ToolbarConstants.hoverAnimation, value: isHovered)
  }
}

/// Stays open while you tick workspaces, so several can be chosen in one go.
private struct ToolbarWorkspacePopoverContent: View {
  @ObservedObject var recorder: ReproRecorder
  let choices: [WorkspaceLogChoice]
  let outlook: WorkspaceLogOutlook
  let dismiss: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      row("None (plain video)", icon: "video", selected: recorder.scope.isOff) { recorder.setScope(.off) }
      if choices.isEmpty {
        Divider().padding(.vertical, 4)
        Text("No workspaces yet").font(.system(size: 12)).foregroundColor(.secondary).padding(.horizontal, 8)
        row("Set Up Workspaces…", icon: "square.stack.3d.up", selected: false) { dismiss(); WorkspaceWindowController.shared.show() }
      } else {
        row("All running workspaces", icon: "square.stack.3d.up", selected: recorder.scope == .running) { recorder.setScope(.running) }
        Divider().padding(.vertical, 4)
        HStack {
          Text("Save logs from").font(.system(size: 11, weight: .semibold)).foregroundColor(.secondary)
          Spacer()
          if choices.count > 1 {
            Button(selectedIDs.count == choices.count ? "None" : "All") {
              recorder.setScope(selectedIDs.count == choices.count ? .off : .only(Set(choices.map(\.id))))
            }
            .buttonStyle(.plain).font(.system(size: 11)).foregroundColor(.accentColor)
          }
        }
        .padding(.horizontal, 8).padding(.bottom, 2)
        ScrollView {
          VStack(alignment: .leading, spacing: 2) {
            ForEach(choices) { choice in
              ToolbarWorkspaceCheckRow(choice: choice, checked: selectedIDs.contains(choice.id)) {
                recorder.setScope(recorder.scope.toggling(choice.id))
              }
            }
          }
        }
        .frame(maxHeight: 260)
        .fixedSize(horizontal: false, vertical: true)
        Divider().padding(.vertical, 4)
        Text(outlook.message).font(.system(size: 11)).foregroundColor(.secondary)
          .fixedSize(horizontal: false, vertical: true).padding(.horizontal, 8)
        row("Show Recordings with Logs…", icon: "film.stack", selected: false) {
          dismiss(); WorkspaceWindowController.shared.show(section: .recordings)
        }
      }
    }
    .padding(8)
    .frame(width: 280)
  }

  private var selectedIDs: Set<String> {
    if case .only(let ids) = recorder.scope { return ids }
    return []
  }

  private func row(_ title: String, icon: String, selected: Bool, action: @escaping () -> Void) -> some View {
    ToolbarWorkspaceRowButton(action: action) {
      Image(systemName: icon).font(.system(size: 12)).foregroundColor(selected ? .accentColor : .secondary).frame(width: 16)
      Text(title).font(.system(size: 12, weight: selected ? .semibold : .regular)).foregroundColor(.primary)
      Spacer()
      if selected { Image(systemName: "checkmark").font(.system(size: 10, weight: .bold)).foregroundColor(.accentColor) }
    }
  }
}

private struct ToolbarWorkspaceCheckRow: View {
  let choice: WorkspaceLogChoice
  let checked: Bool
  let action: () -> Void

  var body: some View {
    ToolbarWorkspaceRowButton(action: action) {
      Image(systemName: checked ? "checkmark.square.fill" : "square")
        .font(.system(size: 13)).foregroundColor(checked ? .accentColor : .secondary).frame(width: 16)
      Text(choice.name).font(.system(size: 12)).foregroundColor(.primary).lineLimit(1).truncationMode(.tail)
      Spacer(minLength: 6)
      Circle().fill(choice.isActive ? Color.green : Color.secondary.opacity(0.4)).frame(width: 6, height: 6)
      Text(choice.status).font(.system(size: 11)).foregroundColor(.secondary).lineLimit(1)
    }
    .accessibilityLabel(choice.name)
    .accessibilityValue(checked ? "Selected, \(choice.status)" : choice.status)
    .accessibilityAddTraits(checked ? .isSelected : [])
  }
}

private struct ToolbarWorkspaceRowButton<Content: View>: View {
  let action: () -> Void
  @ViewBuilder let content: () -> Content
  @State private var isHovered = false

  var body: some View {
    Button(action: action) {
      HStack(spacing: 8) { content() }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color.primary.opacity(isHovered ? 0.08 : 0)))
        .contentShape(RoundedRectangle(cornerRadius: 6))
    }
    .buttonStyle(.plain)
    .onHover { isHovered = $0 }
  }
}
