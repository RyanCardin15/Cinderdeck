import SwiftUI

// MARK: - Console

struct StackConsoleView: View {
  @ObservedObject var viewModel: StackConsoleViewModel
  @FocusState private var filterFocused: Bool
  private let background = Color(red: 0.07, green: 0.075, blue: 0.09)

  var body: some View {
    VStack(spacing: 0) {
      identity
      toolbar
      Rectangle().fill(Color.white.opacity(0.07)).frame(height: 1)
      if viewModel.showsActivity { activity } else {
        StackLogView(lines: viewModel.filteredLogs, allServices: viewModel.logService == nil,
          serviceOrder: viewModel.selectedServices.map(\.id),
          autoScroll: viewModel.autoScroll, focusRequest: viewModel.logFocusRequest,
          onFocus: {})
      }
    }
    .background(background)
    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.white.opacity(0.08)))
    .stackHelpOverlay()
    .environment(\.colorScheme, .dark)
  }

  private var identity: some View {
    HStack(spacing: 8) {
      StackChip(systemImage: "square.stack.3d.up", text: viewModel.stackName, tint: .accentColor)
      StackChip(systemImage: viewModel.showsActivity ? "clock.arrow.circlepath" : "terminal",
        text: viewModel.showsActivity ? "Activity" : viewModel.logService ?? "All services",
        tint: viewModel.logService.map { StackPalette.service($0, in: viewModel.selectedServices.map(\.id)) } ?? .secondary)
      if !viewModel.showsActivity, let service = viewModel.logService {
        let runtime = viewModel.runtime(service)
        StackStateBadge(label: runtime.phase.label)
        if runtime.process != nil { StackOwnerBadge(owner: runtime.owner) }
      }
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 12).padding(.top, 10).padding(.bottom, 4)
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("stacks.terminalIdentity")
  }

  private var toolbar: some View {
    HStack(spacing: 6) {
      ViewThatFits(in: .horizontal) {
        HStack(spacing: 4) {
          tab("All", color: nil, selected: viewModel.logService == nil && !viewModel.showsActivity) {
            viewModel.showsActivity = false; viewModel.selectService(nil)
          }
          ForEach(viewModel.selectedServices) { service in
            tab(service.id, color: StackPalette.service(service.id, in: viewModel.selectedServices.map(\.id)), selected: viewModel.logService == service.id && !viewModel.showsActivity) {
              viewModel.showsActivity = false; viewModel.selectService(service.id)
            }
          }
          tab("Activity", color: nil, icon: "clock.arrow.circlepath", selected: viewModel.showsActivity) { viewModel.showsActivity = true }
        }
        .fixedSize()
        Menu {
          Button("All services") { viewModel.showsActivity = false; viewModel.selectService(nil) }
          ForEach(viewModel.selectedServices) { service in
            Button(service.id) { viewModel.showsActivity = false; viewModel.selectService(service.id) }
          }
          Divider()
          Button("Activity") { viewModel.showsActivity = true }
        } label: {
          Text(viewModel.showsActivity ? "Activity" : viewModel.logService ?? "All services")
            .font(.system(size: 10.5, weight: .semibold)).lineLimit(1)
        }
        .menuStyle(.borderlessButton)
        .help("Choose which service logs to show")
      }
      Spacer(minLength: 4)
      if !viewModel.showsActivity {
        HStack(spacing: 5) {
          Image(systemName: "line.3.horizontal.decrease").font(.system(size: 9, weight: .bold)).foregroundColor(.secondary)
          TextField("Filter", text: $viewModel.logFilter).textFieldStyle(.plain)
            .font(.system(size: 11, design: .monospaced)).focused($filterFocused).frame(width: 120)
            .accessibilityLabel("Filter logs")
          if !viewModel.logFilter.isEmpty {
            Button { viewModel.logFilter = "" } label: { Image(systemName: "xmark.circle.fill").font(.system(size: 10)) }
              .buttonStyle(.plain).foregroundColor(.secondary)
              .stackHelp("Clear log filter").accessibilityLabel("Clear log filter")
          }
        }
        .padding(.horizontal, 8).padding(.vertical, 4)
        .background(Color.white.opacity(filterFocused ? 0.12 : 0.07), in: Capsule())
        StackIconButton(systemName: viewModel.autoScroll ? "arrow.down.to.line.compact" : "pause", help: viewModel.autoScroll ? "Auto-scroll on" : "Auto-scroll paused",
          tint: viewModel.autoScroll ? .accentColor : .secondary, size: 22) { viewModel.autoScroll.toggle() }
        StackIconButton(systemName: "doc.on.doc", help: "Copy visible logs", size: 22) { viewModel.copyLogs() }
        StackIconButton(systemName: "trash", help: "Clear the console (log files are kept)", size: 22) { viewModel.clearLogs() }
        StackIconButton(systemName: "arrow.up.forward.square", help: "Open log file", size: 22) {
          viewModel.openLogFile()
        }
      }
    }
    .padding(.horizontal, 8).padding(.vertical, 6)
  }

  private func tab(_ title: String, color: Color?, icon: String? = nil, selected: Bool, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      HStack(spacing: 5) {
        if let color { Circle().fill(color).frame(width: 6, height: 6) }
        if let icon { Image(systemName: icon).font(.system(size: 9, weight: .bold)) }
        Text(title).font(.system(size: 10.5, weight: .semibold)).lineLimit(1)
      }
      .foregroundColor(selected ? .white : .white.opacity(0.75))
      .padding(.horizontal, 9).padding(.vertical, 4)
      .background((color ?? .white).opacity(selected ? 0.26 : 0.08), in: Capsule())
      .overlay(Capsule().strokeBorder((color ?? .white).opacity(selected ? 0.65 : 0.15), lineWidth: 1))
      .contentShape(Capsule())
    }.buttonStyle(.plain)
      .accessibilityLabel(title)
      .accessibilityAddTraits(selected ? .isSelected : [])
  }

  private var activity: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 0) {
        if viewModel.activity.isEmpty {
          Text("No activity yet").font(.system(size: 11)).foregroundColor(.secondary).padding(12)
        }
        ForEach(viewModel.activity) { event in
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: icon(event.kind)).font(.system(size: 10, weight: .semibold)).foregroundColor(color(event.kind)).frame(width: 14)
            VStack(alignment: .leading, spacing: 2) {
              HStack(spacing: 5) {
                if let service = event.serviceName {
                  Text(service).font(.system(size: 11, weight: .semibold)).foregroundColor(StackPalette.service(service, in: viewModel.selectedServices.map(\.id)))
                }
                Text(title(event.kind)).font(.system(size: 11)).foregroundColor(.white.opacity(0.85))
                if let actor = event.actor {
                  StackChip(systemImage: actor == "You" ? "person.fill" : "sparkles", text: actor, tint: actor == "You" ? .secondary : StackPalette.agent)
                }
              }
              if let detail = event.detail { Text(detail).font(.system(size: 10, design: .monospaced)).foregroundColor(.secondary).lineLimit(2) }
            }
            Spacer(minLength: 6)
            Text(event.occurredAt, style: .relative).font(.system(size: 10)).foregroundColor(.secondary)
          }
          .padding(.horizontal, 12).padding(.vertical, 6)
        }
      }.padding(.vertical, 4)
    }
  }

  private func title(_ kind: String) -> String {
    switch kind {
    case "branchSwitched": return "switched branches"
    case "repoChangeFailed": return "repo change failed"
    default: return kind
    }
  }
  private func icon(_ kind: String) -> String {
    switch kind {
    case "started": return "play.fill"
    case "ready": return "checkmark.circle.fill"
    case "stopped": return "stop.fill"
    case "crashed", "repoChangeFailed": return "xmark.octagon.fill"
    case "branchSwitched": return "arrow.triangle.branch"
    case "pulled": return "arrow.down.to.line"
    default: return "circle.fill"
    }
  }
  private func color(_ kind: String) -> Color {
    switch kind {
    case "ready", "started": return StackPalette.color(phase: .ready)
    case "crashed", "repoChangeFailed": return StackPalette.color(phase: .crashed)
    case "branchSwitched", "pulled": return StackPalette.branch
    default: return .secondary
    }
  }
}
