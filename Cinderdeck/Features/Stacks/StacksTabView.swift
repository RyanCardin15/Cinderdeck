import SwiftUI

struct StacksTabView: View {
  @ObservedObject var viewModel: StacksViewModel
  @ObservedObject var manager: HistoryFloatingManager
  @ObservedObject private var control = StackControlService.shared
  @Environment(\.colorScheme) private var colorScheme
  private var expanded: Bool { manager.presentationMode == .expanded }

  var body: some View {
    VStack(spacing: 12) {
      if let error = viewModel.error {
        HStack(spacing: 8) {
          Image(systemName: "exclamationmark.triangle.fill").foregroundColor(.orange)
          Text(error).textSelection(.enabled).lineLimit(3)
          Spacer(minLength: 4)
          StackIconButton(systemName: "xmark", help: "Dismiss", size: 20) { viewModel.error = nil }
        }
        .font(.system(size: 11, weight: .medium))
        .padding(.horizontal, 10).padding(.vertical, 7)
        .stackSurface(cornerRadius: 10, tint: .orange)
      }
      workspaceToolbar
      if viewModel.files.isEmpty { emptyState }
      else if viewModel.filteredFiles.isEmpty { noSearchResults }
      else if expanded { expandedContent }
      else { compactContent }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .stackHelpOverlay()
    .onChange(of: manager.searchText) { query in viewModel.stackFilter = query }
    .onChange(of: viewModel.hasAuxiliaryUI) { presented in
      if !presented, manager.panelIsVisible { manager.focusPanel() }
      manager.isPresentingAuxiliaryUI = presented
    }
    .onReceive(NotificationCenter.default.publisher(for: .historyMoveSelection)) { notification in
      guard notification.userInfo?["section"] as? String == HistorySection.stacks.rawValue,
        let delta = notification.userInfo?["delta"] as? Int else { return }
      viewModel.moveSelection(delta)
    }
    .onReceive(NotificationCenter.default.publisher(for: .stacksCommand)) { notification in
      guard let value = notification.userInfo?["command"] as? String, let command = StackKeyboardCommand(rawValue: value) else { return }
      viewModel.command(command, manager: manager)
    }
    .sheet(item: $viewModel.editor) { context in
      if context.file == nil {
        WorkspaceCreateView { id in
          viewModel.editor = nil
          Task { await viewModel.supervisor.reloadDefinitions(); viewModel.select(id) }
        }
      } else {
        StackDefinitionEditor(file: context.file) {
          viewModel.editor = nil
          Task { await viewModel.supervisor.reloadDefinitions() }
        }
      }
    }
    .sheet(isPresented: $viewModel.stackBranchPicker) {
      StackBranchPickerSheet(viewModel: viewModel)
    }
    .sheet(isPresented: $viewModel.agentsSheet) {
      StackAgentsSheet()
    }
  }

  private var workspaceToolbar: some View {
    HStack(spacing: 12) {
      Text("Services, tasks, and workflows")
        .font(.system(size: 11, weight: .medium))
        .foregroundColor(.secondary)
        .lineLimit(1)
      Spacer(minLength: 8)
      Button {
        manager.hide()
        WorkspaceWindowController.shared.show(workspace: viewModel.selectedStackID)
      } label: {
        Label("Open Workspaces", systemImage: "arrow.up.forward.app")
      }
      .buttonStyle(StackPillButtonStyle(compact: true))
      .fixedSize()
      .accessibilityIdentifier("history.openWorkspaces")
    }
    .frame(minHeight: 28)
  }

  private var noSearchResults: some View {
    VStack(spacing: 10) {
      Image(systemName: "magnifyingglass").font(.system(size: 24)).foregroundColor(.secondary)
      Text("No matching workspaces").font(.headline)
      Text("Try another name or clear your search.").font(.callout).foregroundColor(.secondary)
      Button("Clear search") { manager.searchText = ""; viewModel.stackFilter = "" }
        .buttonStyle(StackPillButtonStyle(compact: true))
    }.frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  // MARK: Empty

  private var emptyState: some View {
    VStack(spacing: 12) {
      ZStack {
        Circle().fill(Color.accentColor.opacity(0.12)).frame(width: 58, height: 58)
        Image(systemName: "square.stack.3d.up.fill").font(.system(size: 24, weight: .semibold)).foregroundColor(.accentColor)
      }
      Text("Your projects, running together").font(.system(size: 15, weight: .semibold))
      Text("Create a workspace for your services, one-time tasks, and ordered workflows.\nYour coding agents can run them too.")
        .font(.system(size: 12)).foregroundColor(.secondary).multilineTextAlignment(.center).frame(maxWidth: 440)
      HStack(spacing: 8) {
        Button { viewModel.create() } label: { Label("Create workspace", systemImage: "plus") }
          .buttonStyle(StackPillButtonStyle(kind: .primary(.accentColor)))
          .accessibilityIdentifier("stacks.create")
        Button { viewModel.agentsSheet = true } label: { Label("Connect agents", systemImage: "sparkles") }
          .buttonStyle(StackPillButtonStyle())
      }
    }.frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  // MARK: Compact

  private var compactContent: some View {
    GeometryReader { geometry in
      HStack(alignment: .top, spacing: 12) {
        ScrollViewReader { proxy in
          ScrollView(.horizontal, showsIndicators: false) {
            LazyHStack(alignment: .top, spacing: 12) {
              ForEach(viewModel.filteredFiles) { file in
                StackCompactCardView(file: file, viewModel: viewModel, manager: manager)
                  .frame(height: max(0, geometry.size.height - 8))
                  .id(file.id)
              }
            }.padding(4)
          }
          .onChange(of: viewModel.selectedStackID) { id in
            if let id { withAnimation { proxy.scrollTo(id, anchor: .center) } }
          }
        }
        VStack(spacing: 8) {
          StackIconButton(systemName: "plus", help: "Create workspace", size: 28) { viewModel.create() }
          StackIconButton(systemName: "sparkles", help: "Agent access", tint: StackPalette.agent, size: 28) { viewModel.agentsSheet = true }
        }.padding(.top, 4)
      }
    }
  }

  // MARK: Expanded

  private var expandedContent: some View {
    HStack(alignment: .top, spacing: 16) {
      VStack(alignment: .leading, spacing: 10) {
        HStack {
          Text("WORKSPACES").font(.system(size: 10, weight: .bold)).foregroundColor(.secondary).tracking(0.6)
          Spacer()
          StackIconButton(systemName: "plus", help: "Create workspace", size: 22) { viewModel.create() }
        }
        ScrollView(showsIndicators: false) {
          LazyVStack(spacing: 6) {
            ForEach(viewModel.filteredFiles) { file in sidebarRow(file) }
          }.padding(2)
        }
        agentStatus
        Button { NSWorkspace.shared.open(StackDefinitionLoader.directory()) } label: {
          Label("Workspace files", systemImage: "folder")
        }.buttonStyle(StackPillButtonStyle(compact: true))
      }.frame(width: 196).frame(maxHeight: .infinity, alignment: .top)
      Divider()
      if let file = viewModel.selectedFile {
        StackExpandedView(file: file, viewModel: viewModel, manager: manager)
      } else {
        Text("Select a workspace").foregroundColor(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
  }

  private func sidebarRow(_ file: StackDefinitionFile) -> some View {
    let state = viewModel.states[file.id] ?? .init()
    let selected = viewModel.selectedStackID == file.id
    let services = file.definition?.services ?? []
    return Button { viewModel.select(file.id) } label: {
      VStack(alignment: .leading, spacing: 6) {
        HStack(spacing: 7) {
          StackStatusDot(label: file.definition == nil ? "Degraded" : state.label)
          Text(file.name).font(.system(size: 12, weight: .semibold)).lineLimit(1)
          Spacer(minLength: 0)
          if viewModel.claim(file.id) != nil {
            Image(systemName: "lock.fill").font(.system(size: 9, weight: .bold)).foregroundColor(StackPalette.agent)
          }
        }
        HStack(spacing: 3) {
          ForEach(services.prefix(8)) { service in
            Capsule().fill(StackPalette.color(phase: viewModel.runtime(file.id, service.id).phase).opacity(
              viewModel.runtime(file.id, service.id).phase == .stopped ? 0.25 : 0.9))
              .frame(width: 12, height: 4)
          }
          Spacer(minLength: 4)
          Text(file.definition == nil ? "Needs attention" : state.label).font(.system(size: 10)).foregroundColor(.secondary)
        }
      }
      .padding(.horizontal, 10).padding(.vertical, 9)
      .contentShape(Rectangle())
      .background(
        RoundedRectangle(cornerRadius: 11, style: .continuous)
          .fill(selected ? Color.accentColor.opacity(colorScheme == .dark ? 0.2 : 0.13) : Color.clear)
      )
    }.buttonStyle(.plain)
  }

  private var agentStatus: some View {
    Button { viewModel.agentsSheet = true } label: {
      HStack(spacing: 7) {
        Circle().fill(control.isServing ? StackPalette.color(phase: .ready) : StackPalette.color(phase: .crashed)).frame(width: 6, height: 6)
        VStack(alignment: .leading, spacing: 1) {
          Text("Agent access").font(.system(size: 11, weight: .semibold))
          Text(control.isServing ? "\(control.claims.values.filter { !$0.isExpired }.count) active claims · MCP & CLI" : "Control socket unavailable")
            .font(.system(size: 9.5)).foregroundColor(.secondary).lineLimit(1)
        }
        Spacer(minLength: 0)
        Image(systemName: "sparkles").font(.system(size: 10, weight: .semibold)).foregroundColor(StackPalette.agent)
      }
      .padding(.horizontal, 10).padding(.vertical, 8)
      .stackSurface(cornerRadius: 11)
    }.buttonStyle(.plain)
  }
}

struct StackStatusDot: View {
  var phase: StackServicePhase?
  var label: String = "Stopped"
  var size: CGFloat = 8
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  private var text: String { phase?.label ?? label }
  private var color: Color { phase.map { StackPalette.color(phase: $0) } ?? StackPalette.color(label: label) }
  private var pulsing: Bool {
    guard !reduceMotion else { return false }
    if let phase { return phase == .starting || phase == .waiting || phase == .stopping }
    return label == "Starting" || label == "Stopping"
  }
  private var stopped: Bool { phase.map { $0 == .stopped } ?? (label == "Stopped") }
  var body: some View {
    TimelineView(.animation(minimumInterval: 0.5, paused: !pulsing)) { context in
      ZStack {
        if !stopped {
          Circle().fill(color.opacity(0.25)).frame(width: size + 5, height: size + 5)
        }
        if phase == .unhealthy || label == "Degraded" {
          Image(systemName: "exclamationmark.triangle.fill").font(.system(size: size)).foregroundColor(color)
        } else if stopped {
          Circle().strokeBorder(Color.secondary.opacity(0.7), lineWidth: 1.3).frame(width: size, height: size)
        } else {
          Circle().fill(color).frame(width: size, height: size)
        }
      }
      .opacity(pulsing ? (Int(context.date.timeIntervalSince1970 * 2) % 2 == 0 ? 0.45 : 1) : 1)
    }.frame(width: size + 6, height: size + 6).accessibilityLabel(text)
  }
}
