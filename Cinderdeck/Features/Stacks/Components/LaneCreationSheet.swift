import AppKit
import SwiftUI

/// One review surface for manual, CLI, MCP, and managed-session lane creation.
struct LaneCreationOptions: Sendable {
  var request: StackLaneRequest
  var setup: Bool
  var start: Bool
  var progress: StackLaneProgressHandler? = nil
  /// Save this lane's checkout and start choices as the workspace defaults after creation.
  var rememberDefaults = false
}

/// Foreground branch reads must not wait behind GitService's full status scans
/// or network fetches. Read only local metadata, with four commands in flight.
actor LaneBranchReader {
  static let shared = LaneBranchReader()
  private var active = 0
  private var waiters: [CheckedContinuation<Void, Never>] = []
  private func acquire() async {
    if active < StackLaneStore.repositoryConcurrency { active += 1; return }
    await withCheckedContinuation { waiters.append($0) }
  }
  private func release() {
    if waiters.isEmpty { active -= 1 } else { waiters.removeFirst().resume() }
  }
  func branches(at path: URL) async throws -> [GitBranch] {
    await acquire(); defer { release() }
    try Task.checkCancellation()
    // The picker only displays names. Commit-date sorting and subjects read a
    // commit object for every branch, which is costly in large repositories.
    let output = try await StackLaneStore.git(["for-each-ref", "--sort=refname", "--format=%(refname)", "refs/heads", "refs/remotes"], at: path)
    return output.split(separator: "\n").compactMap { line in
      let ref = String(line), remote = ref.hasPrefix("refs/remotes/")
      guard !remote || !ref.hasSuffix("/HEAD") else { return nil }
      let short = String(ref.dropFirst(remote ? "refs/remotes/".count : "refs/heads/".count))
      let name = remote ? short.split(separator: "/", maxSplits: 1).dropFirst().joined(separator: "/") : short
      return GitBranch(name: name, reference: ref, isRemote: remote, upstream: nil, subject: "")
    }
  }
  /// Network fetch for the branch picker; never runs while listing.
  func fetch(at path: URL) async throws {
    try Task.checkCancellation()
    _ = try await StackLaneStore.git(["fetch", "--all", "--prune", "--quiet"], at: path, timeout: 120)
  }
  func currentBranch(at path: URL) async throws -> String {
    await acquire(); defer { release() }
    try Task.checkCancellation()
    let branch = try await StackLaneStore.gitResult(["symbolic-ref", "--quiet", "--short", "HEAD"], at: path)
    if branch.status == 0 { return branch.text.trimmingCharacters(in: .whitespacesAndNewlines) }
    let commit = try await StackLaneStore.git(["rev-parse", "--short", "HEAD"], at: path)
    return "Detached (\(commit))"
  }
}

@MainActor
final class LaneCreationWindowController: NSWindowController, NSWindowDelegate {
  static let shared = LaneCreationWindowController()
  private var continuation: CheckedContinuation<JSONValue, Error>?
  private var working = false

  private init() {
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 780, height: 700),
      styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
    window.title = "New lane — Cinderdeck"
    window.isReleasedWhenClosed = false
    super.init(window: window)
    window.delegate = self
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  @discardableResult
  func focusIfPresented() -> Bool {
    guard continuation != nil else { return false }
    window?.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    return true
  }

  func present(source: StackDefinition, options: LaneCreationOptions,
    create: @escaping @MainActor (LaneCreationOptions) async throws -> JSONValue) async throws -> JSONValue {
    guard continuation == nil else {
      window?.makeKeyAndOrderFront(nil)
      throw StackControlError(code: "busy", message: "Finish or cancel the open lane creation sheet before creating another lane.")
    }
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { pending in
        continuation = pending
        window?.contentView = NSHostingView(rootView: LaneCreationSheet(source: source, options: options,
          onCancel: { [weak self] in self?.cancel() },
          create: { [weak self] choices in
            guard let self, self.continuation != nil else { throw CancellationError() }
            self.working = true
            defer { self.working = false }
            let result = try await create(choices)
            let completed = self.continuation
            self.continuation = nil
            self.close()
            completed?.resume(returning: result)
          }))
        window?.center()
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
      }
    } onCancel: {
      Task { @MainActor [weak self] in self?.cancel() }
    }
  }

  private func cancel() {
    guard !working else { return }
    let pending = continuation
    continuation = nil
    close()
    pending?.resume(throwing: StackControlError(code: "cancelled", message: "Lane creation was cancelled. No lane was created."))
  }
  func windowShouldClose(_ sender: NSWindow) -> Bool { !working }
  func windowWillClose(_ notification: Notification) {
    let pending = continuation
    continuation = nil
    pending?.resume(throwing: StackControlError(code: "cancelled", message: "Lane creation was cancelled. No lane was created."))
    CinderdeckRuntimeController.shared.activateOwnedWindow()
  }
}

