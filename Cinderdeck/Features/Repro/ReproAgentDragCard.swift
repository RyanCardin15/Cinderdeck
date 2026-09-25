import AppKit
import SwiftUI

/// Drag a recording straight into an agent: Claude Code or Codex in a terminal gets the
/// file paths (and sees the frames as images), a chat app gets the files attached. The
/// video goes too; hold Option to leave it out for chats that reject large or video files.
/// The README gives its path either way.
struct ReproAgentDragCard: View {
  let session: ReproSession
  @State private var handoff: ReproExport.Handoff?
  @State private var failure: String?
  @State private var copied = false

  var body: some View {
    HStack(spacing: 12) {
      HStack(spacing: 12) {
        ZStack {
          RoundedRectangle(cornerRadius: 8).fill(Color.accentColor.opacity(0.12)).frame(width: 40, height: 40)
          if handoff == nil && failure == nil && !session.status.isActive {
            ProgressView().controlSize(.small)
          } else {
            Image(systemName: failure == nil ? "hand.draw" : "exclamationmark.triangle")
              .font(.system(size: 17, weight: .medium)).foregroundColor(failure == nil ? .accentColor : .orange)
          }
        }
        VStack(alignment: .leading, spacing: 2) {
          Text("Drag to an agent").fontWeight(.semibold)
          Text(caption).font(.caption).foregroundColor(.secondary).lineLimit(2)
        }
        Spacer(minLength: 0)
      }
      .contentShape(Rectangle())
      .overlay {
        if let handoff { ReproFileDragSource(files: handoff.files, video: handoff.video) }
      }
      .help(handoff == nil ? "" : "Drop into a terminal agent or a chat. Hold ⌥ while dragging to leave out the video.")
      .accessibilityElement(children: .combine)
      .accessibilityLabel("Drag to an agent")
      .accessibilityHint(caption)

      Button {
        guard let handoff else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.writeObjects(handoff.allFiles as [NSURL])
        copied = true
        Task { try? await Task.sleep(nanoseconds: 2_000_000_000); copied = false }
      } label: { Label(copied ? "Copied" : "Copy Files", systemImage: copied ? "checkmark" : "doc.on.doc") }
        .disabled(handoff == nil)
        .help("Copy the same files, video included, to paste into an agent with ⌘V")
      Button { if let handoff { NSWorkspace.shared.activateFileViewerSelecting([handoff.folder]) } } label: { Image(systemName: "folder") }
        .disabled(handoff == nil)
        .help("Show the handoff folder in Finder")
    }
    .padding(10)
    .background(
      RoundedRectangle(cornerRadius: 10)
        .strokeBorder(Color.accentColor.opacity(0.45), style: StrokeStyle(lineWidth: 1.2, dash: [5, 4]))
        .background(Color.accentColor.opacity(0.04), in: RoundedRectangle(cornerRadius: 10))
    )
    .task(id: prepareKey) { await prepare() }
  }

  /// Rebuilds when the recording settles, is renamed, or gains markers.
  private var prepareKey: String {
    "\(session.id)|\(session.status.rawValue)|\(session.title)|\(session.lineCount)|\(session.markers.count)"
  }

  private var caption: String {
    if session.status.isActive { return "Available once the recording is saved." }
    if let failure { return "Could not prepare the files: \(failure)" }
    guard let handoff else { return "Preparing the README, log, and frames…" }
    let frames = handoff.files.filter { $0.pathExtension == "jpg" }.count
    let diffs = handoff.files.filter { $0.pathExtension == "diff" }.count
    var parts = handoff.video == nil ? [] : ["Video"]
    parts += ["README", "log"]
    if frames > 0 { parts.append("\(frames) frame\(frames == 1 ? "" : "s")") }
    if diffs > 0 { parts.append("\(diffs) diff\(diffs == 1 ? "" : "s")") }
    return ReproFormat.list(parts) + (handoff.video == nil ? "" : ". Hold ⌥ to leave out the video.")
  }

  private func prepare() async {
    guard !session.status.isActive else { handoff = nil; return }
    failure = nil
    do { handoff = try await ReproExport.handoff(session) }
    catch { handoff = nil; failure = error.localizedDescription }
  }
}

/// A transparent AppKit drag source: SwiftUI's `onDrag` carries only one item.
private struct ReproFileDragSource: NSViewRepresentable {
  let files: [URL]
  let video: URL?

  func makeNSView(context: Context) -> DragView { DragView() }

  func updateNSView(_ view: DragView, context: Context) {
    view.files = files
    view.video = video
  }

  final class DragView: NSView, NSDraggingSource {
    var files: [URL] = []
    var video: URL?
    private var mouseDownEvent: NSEvent?

    override func resetCursorRects() { addCursorRect(bounds, cursor: .openHand) }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) { mouseDownEvent = event }

    override func mouseDragged(with event: NSEvent) {
      guard let start = mouseDownEvent else { return }
      mouseDownEvent = nil
      var urls = files
      if let video, !start.modifierFlags.contains(.option), !event.modifierFlags.contains(.option) { urls.insert(video, at: 0) }
      guard !urls.isEmpty else { return }
      let origin = convert(start.locationInWindow, from: nil)
      let items = urls.enumerated().map { index, url -> NSDraggingItem in
        let item = NSDraggingItem(pasteboardWriter: url as NSURL)
        let offset = CGFloat(min(index, 5)) * 4
        item.setDraggingFrame(NSRect(x: origin.x - 24 + offset, y: origin.y - 24 - offset, width: 48, height: 48), contents: Self.preview(url))
        return item
      }
      let session = beginDraggingSession(with: items, event: start, source: self)
      session.animatesToStartingPositionsOnCancelOrFail = true
      session.draggingFormation = .pile
    }

    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
      .copy
    }

    private static func preview(_ url: URL) -> NSImage {
      if url.pathExtension == "jpg", let image = NSImage(contentsOf: url) { return image }
      return NSWorkspace.shared.icon(forFile: url.path)
    }
  }
}
