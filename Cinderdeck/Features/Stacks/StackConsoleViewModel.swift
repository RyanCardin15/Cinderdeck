import AppKit
import Combine

/// Each terminal owns its selection and output independently of the Stacks panel.
@MainActor
final class StackConsoleViewModel: ObservableObject {
  let stackID: String
  @Published private(set) var file: StackDefinitionFile
  @Published private(set) var state = StackRuntimeState()
  @Published private(set) var logService: String?
  @Published private(set) var logLines: [StackLogLine] = []
  @Published private(set) var activity: [StackEventRecord] = []
  @Published var logFilter = ""
  @Published var autoScroll = true
  @Published var showsActivity = false
  @Published private(set) var logFocusRequest = 0
  private let supervisor: StackSupervisor
  private var subscriptions = Set<AnyCancellable>()
  private var logTask: Task<Void, Never>?
  private var selectionRevision = 0

  init(file: StackDefinitionFile, supervisor: StackSupervisor) {
    self.stackID = file.id
    self.file = file
    self.supervisor = supervisor
    supervisor.$files.sink { [weak self] files in
      guard let self, let file = files.first(where: { $0.id == self.stackID }) else { return }
      self.file = file
    }.store(in: &subscriptions)
    supervisor.$states.sink { [weak self] states in
      guard let self else { return }
      state = states[stackID] ?? .init()
    }.store(in: &subscriptions)
  }

  deinit { logTask?.cancel() }

  var stackName: String { file.name }
  var selectedServices: [ServiceDefinition] {
    var services = file.definition?.services ?? []
    for runtime in state.services.values {
      if let service = runtime.launchDefinition?.service, !services.contains(where: { $0.id == service.id }) {
        services.append(service)
      }
    }
    return services.sorted { $0.id < $1.id }
  }
  var filteredLogs: [StackLogLine] {
    logLines.filter { logFilter.isEmpty || AnsiParser.plainText($0.text).localizedCaseInsensitiveContains(logFilter) }
  }
  func runtime(_ service: String) -> StackServiceRuntime { state.services[service] ?? .init() }

  func selectService(_ service: String?) {
    selectionRevision += 1
    logService = service
    logLines = []
    Task { [weak self] in await self?.refreshLogs() }
  }

  func start(service: String?) {
    showsActivity = false
    selectService(service)
    guard logTask == nil else { return }
    logTask = Task { [weak self] in
      var lastActivity = Date.distantPast
      while !Task.isCancelled {
        guard self != nil else { return }
        await self?.refreshLogs()
        if Date().timeIntervalSince(lastActivity) > 2 {
          await self?.refreshActivity()
          lastActivity = Date()
        }
        do { try await Task.sleep(nanoseconds: 100_000_000) }
        catch { return }
      }
    }
  }

  func stop() {
    logTask?.cancel()
    logTask = nil
    selectionRevision += 1
  }

  func focusLogs() { logFocusRequest += 1 }

  private func refreshLogs() async {
    let revision = selectionRevision
    let lines = await supervisor.logLines(stack: stackID, service: logService)
    guard !Task.isCancelled, revision == selectionRevision else { return }
    if lines != logLines { logLines = lines }
  }

  private func refreshActivity() async {
    let events = await supervisor.events(stack: stackID)
    guard !Task.isCancelled else { return }
    if events.map(\.id) != activity.map(\.id) { activity = events }
  }

  func copyLogs() {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(filteredLogs.map { "\($0.service) | \(AnsiParser.plainText($0.text))" }.joined(separator: "\n"), forType: .string)
  }

  func clearLogs() {
    let service = logService
    Task { [weak self] in
      guard let self else { return }
      await supervisor.clearLogs(stack: stackID, service: service)
      await refreshLogs()
    }
  }

  func openLogFile() {
    let url = logService.map { supervisor.logURL(stack: stackID, service: $0) }
      ?? supervisor.logDirectory.appendingPathComponent(stackID)
    if FileManager.default.fileExists(atPath: url.path) { NSWorkspace.shared.open(url) }
    else { NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: supervisor.logDirectory.path) }
  }
}
