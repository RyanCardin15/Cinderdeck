import Foundation

/// Watches files as well as their parent: in-place writes don't change the parent
/// directory, and atomic editor saves replace the watched inode.
nonisolated final class StackFileWatcher: @unchecked Sendable {
  private let queue = DispatchQueue(label: "Cinderdeck.StackFileWatcher", qos: .utility)
  private var sources: [DispatchSourceFileSystemObject] = []
  private var pending: DispatchWorkItem?
  private var stopped = false
  private let paths: @Sendable () -> [URL]
  private let delay: TimeInterval
  private let onChange: @Sendable () -> Void

  init(delay: TimeInterval = 0.5, paths: @escaping @Sendable () -> [URL], onChange: @escaping @Sendable () -> Void) {
    self.paths = paths; self.delay = delay; self.onChange = onChange
    queue.async { [weak self] in self?.rebuild() }
  }

  private func rebuild() {
    guard !stopped else { return }
    sources.forEach { $0.cancel() }; sources.removeAll()
    for url in Set(paths()) {
      let fd = open(url.path, O_EVTONLY | O_CLOEXEC)
      guard fd >= 0 else { continue }
      let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd,
        eventMask: [.write, .extend, .attrib, .rename, .delete], queue: queue)
      source.setEventHandler { [weak self] in self?.schedule() }
      source.setCancelHandler { close(fd) }
      source.resume()
      sources.append(source)
    }
  }
  private func schedule() {
    guard !stopped, pending == nil else { return }
    let work = DispatchWorkItem { [weak self] in
      guard let self, !self.stopped else { return }
      self.pending = nil; self.rebuild(); self.onChange()
    }
    pending = work
    queue.asyncAfter(deadline: .now() + delay, execute: work)
  }
  func stop() {
    queue.async { [self] in
      stopped = true; pending?.cancel(); pending = nil
      sources.forEach { $0.cancel() }; sources.removeAll()
    }
  }
  deinit { pending?.cancel(); sources.forEach { $0.cancel() } }
}

nonisolated final class StackDefinitionWatcher {
  private let watcher: StackFileWatcher
  init(directory: URL, onChange: @escaping @Sendable () -> Void) {
    watcher = StackFileWatcher(paths: {
      [directory, directory.deletingLastPathComponent()] + ((try? FileManager.default.contentsOfDirectory(at: directory,
        includingPropertiesForKeys: nil)) ?? []).filter { $0.pathExtension == "toml" }
    }, onChange: onChange)
  }
  func stop() { watcher.stop() }
}
