import SwiftUI

struct StacksTabView: View {
  @ObservedObject var viewModel: StacksViewModel
  @ObservedObject var manager: HistoryFloatingManager
  private var expanded: Bool { manager.presentationMode == .expanded }

  var body: some View {
    VStack(spacing: 8) {
      if let error = viewModel.error {
        HStack {
          Label(error, systemImage: "exclamationmark.triangle").textSelection(.enabled)
          Spacer()
          Button { viewModel.error = nil } label: { Image(systemName: "xmark") }.buttonStyle(.plain)
        }
        .font(.caption).foregroundColor(.orange).padding(8)
        .background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
      }
      if viewModel.files.isEmpty { emptyState }
      else if expanded { expandedContent }
      else { compactContent }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .onChange(of: manager.searchText) { query in
      if viewModel.logFocused { viewModel.logFilter = query } else { viewModel.stackFilter = query }
    }
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
      StackDefinitionEditor(file: context.file) {
        viewModel.editor = nil
        Task { await viewModel.supervisor.reloadDefinitions() }
      }
    }
    .sheet(isPresented: $viewModel.stackBranchPicker) {
      StackBranchPickerSheet(viewModel: viewModel)
    }
  }

  private var emptyState: some View {
    VStack(spacing: 10) {
      Image(systemName: "square.stack.3d.up").font(.system(size: 30)).foregroundColor(.secondary)
      Text("Your projects, running together").font(.headline)
      Text("Group any local projects into a stack. Give each service a folder and a start command.")
        .font(.callout).foregroundColor(.secondary).multilineTextAlignment(.center)
      Button("Create stack") { viewModel.create() }.buttonStyle(.borderedProminent)
        .accessibilityIdentifier("stacks.create")
    }.frame(maxWidth: .infinity, maxHeight: .infinity)
  }
  private var compactContent: some View {
    HStack(alignment: .top, spacing: 8) {
      ScrollViewReader { proxy in
        ScrollView(.horizontal) {
          LazyHStack(alignment: .top, spacing: 12) {
            ForEach(viewModel.filteredFiles) { file in
              StackCompactCardView(file: file, viewModel: viewModel, manager: manager)
                .id(file.id)
            }
          }.padding(3)
        }
        .onChange(of: viewModel.selectedStackID) { id in if let id { withAnimation { proxy.scrollTo(id, anchor: .center) } } }
      }
      Button { viewModel.create() } label: { Image(systemName: "plus").frame(width: 26, height: 26) }
        .buttonStyle(.bordered).help("Create stack").accessibilityLabel("Create stack")
    }
  }
  private var expandedContent: some View {
    HStack(spacing: 16) {
      VStack(alignment: .leading, spacing: 12) {
        HStack {
          Text("STACKS").font(.caption.weight(.semibold)).foregroundColor(.secondary)
          Spacer()
          Button { viewModel.create() } label: { Image(systemName: "plus") }.buttonStyle(.plain).help("Create stack").accessibilityLabel("Create stack")
        }
        ScrollView {
          LazyVStack(spacing: 4) {
            ForEach(viewModel.filteredFiles) { file in
              Button { viewModel.select(file.id) } label: {
                HStack(spacing: 8) {
                  StackStatusDot(label: viewModel.states[file.id]?.label ?? "Stopped")
                  VStack(alignment: .leading, spacing: 3) {
                    Text(file.name).font(.system(size: 12, weight: .semibold)).lineLimit(1)
                    Text(file.definition == nil ? "Needs attention" : viewModel.states[file.id]?.label ?? "Stopped")
                      .font(.caption2).foregroundColor(.secondary)
                  }
                  Spacer(minLength: 0)
                }.padding(10).contentShape(Rectangle())
                  .background(viewModel.selectedStackID == file.id ? Color.accentColor.opacity(0.13) : .clear, in: RoundedRectangle(cornerRadius: 9))
              }.buttonStyle(.plain)
            }
          }
        }
        Spacer(minLength: 0)
        Button("Open stacks folder") { NSWorkspace.shared.open(StackDefinitionLoader.directory()) }
          .font(.caption).buttonStyle(.plain).foregroundColor(.secondary)
      }.frame(width: 205)
      Divider()
      if let file = viewModel.selectedFile {
        StackExpandedView(file: file, viewModel: viewModel, manager: manager)
      } else { Text("Select a stack").foregroundColor(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity) }
    }
  }
}

struct StackStatusDot: View {
  var phase: StackServicePhase?
  var label: String = "Stopped"
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  private var text: String { phase?.label ?? label }
  private var color: Color {
    switch phase?.rawValue ?? label.lowercased() {
    case "ready", "running": return .green
    case "starting", "waiting", "stopping": return .yellow
    case "crashed": return .red
    case "unhealthy", "degraded": return .orange
    default: return .secondary
    }
  }
  var body: some View {
    TimelineView(.animation(minimumInterval: 0.5, paused: reduceMotion || !(phase == .starting || phase == .waiting))) { context in
      Image(systemName: phase == .unhealthy || label == "Degraded" ? "exclamationmark.triangle.fill" : text == "Stopped" ? "circle" : "circle.fill")
        .font(.system(size: 8)).foregroundColor(color)
        .opacity(!reduceMotion && (phase == .starting || phase == .waiting) ? (Int(context.date.timeIntervalSince1970 * 2) % 2 == 0 ? 0.45 : 1) : 1)
    }.frame(width: 12, height: 12).accessibilityLabel(text)
  }
}
