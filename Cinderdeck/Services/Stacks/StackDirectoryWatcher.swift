import CoreServices
import Foundation

/// FSEvents watches a hierarchy without opening every branch/ref/reflog file.
/// Keeping a vnode descriptor per ref can exhaust a GUI app's descriptor limit
/// and prevent unrelated GitHub requests (or AppKit itself) from opening files.
nonisolated final class StackDirectoryWatcher: @unchecked Sendable {
  private let lock = NSLock()
  private var stream: FSEventStreamRef?
  private let queue = DispatchQueue(label: "Cinderdeck.StackDirectoryWatcher", qos: .utility)

  private final class Callback: @unchecked Sendable {
    let onPathsChange: @Sendable ([String]) -> Void
    init(_ onPathsChange: @escaping @Sendable ([String]) -> Void) { self.onPathsChange = onPathsChange }
  }

  convenience init(directories: [URL], delay: TimeInterval = 0.6, onChange: @escaping @Sendable () -> Void) throws {
    try self.init(directories: directories, delay: delay, onPathsChange: { _ in onChange() })
  }

  init(directories: [URL], delay: TimeInterval = 0.6, onPathsChange: @escaping @Sendable ([String]) -> Void) throws {
    let callback = Callback(onPathsChange)
    var context = FSEventStreamContext(version: 0,
      info: Unmanaged.passUnretained(callback).toOpaque(),
      retain: { info in
        guard let info else { return nil }
        _ = Unmanaged<Callback>.fromOpaque(info).retain()
        return info
      },
      release: { info in
        if let info { Unmanaged<Callback>.fromOpaque(info).release() }
      }, copyDescription: nil)
    let paths = Array(Set(directories.map { $0.standardizedFileURL.resolvingSymlinksInPath().path })).sorted()
    guard !paths.isEmpty, let stream = FSEventStreamCreate(kCFAllocatorDefault, { _, info, count, eventPaths, flags, _ in
      guard let info else { return }
      let callback = Unmanaged<Callback>.fromOpaque(info).takeUnretainedValue()
      let lost = FSEventStreamEventFlags(kFSEventStreamEventFlagMustScanSubDirs | kFSEventStreamEventFlagUserDropped | kFSEventStreamEventFlagKernelDropped)
      if (0..<count).contains(where: { flags[$0] & lost != 0 }) {
        callback.onPathsChange([])
      } else {
        callback.onPathsChange((unsafeBitCast(eventPaths, to: NSArray.self) as? [String]) ?? [])
      }
    }, &context, paths as CFArray, FSEventStreamEventId(kFSEventStreamEventIdSinceNow), delay,
      FSEventStreamCreateFlags(kFSEventStreamCreateFlagWatchRoot | kFSEventStreamCreateFlagUseCFTypes | kFSEventStreamCreateFlagFileEvents)) else {
      throw StackError.message("Could not monitor Git repository changes")
    }
    FSEventStreamSetDispatchQueue(stream, queue)
    guard FSEventStreamStart(stream) else {
      FSEventStreamInvalidate(stream)
      FSEventStreamRelease(stream)
      throw StackError.message("Could not start monitoring Git repository changes")
    }
    self.stream = stream
  }

  func stop() {
    lock.lock(); defer { lock.unlock() }
    guard let stream else { return }
    self.stream = nil
    FSEventStreamStop(stream)
    FSEventStreamInvalidate(stream)
    FSEventStreamRelease(stream)
  }

  deinit { stop() }
}
