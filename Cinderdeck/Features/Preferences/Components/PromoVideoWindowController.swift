import AppKit
import AVKit
import SwiftUI

/// The same locally bundled film used in the README, playable without a network connection.
@MainActor
final class PromoVideoWindowController: NSWindowController, NSWindowDelegate {
  static let shared = PromoVideoWindowController()
  private var player: AVPlayer?

  static var videoURL: URL? { Bundle.main.url(forResource: "cinderdeck-promo", withExtension: "mp4") }

  private init() { super.init(window: nil) }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func showDemo() {
    if window == nil {
      guard let url = Self.videoURL else {
        let alert = NSAlert()
        alert.messageText = "The demo couldn’t be opened"
        alert.informativeText = "The video is missing from this build of Cinderdeck."
        alert.runModal()
        return
      }
      let player = AVPlayer(url: url)
      self.player = player
      let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 960, height: 580),
        styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
      window.title = "Cinderdeck — Watch demo"
      window.minSize = NSSize(width: 640, height: 410)
      window.isReleasedWhenClosed = false
      window.delegate = self
      window.contentView = NSHostingView(rootView: PromoVideoView(player: player))
      window.center()
      self.window = window
    }
    showWindow(nil)
    window?.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    player?.play()
  }

  func windowWillClose(_ notification: Notification) {
    player?.pause()
    player?.seek(to: .zero)
  }
}

private struct PromoVideoView: View {
  let player: AVPlayer
  var body: some View {
    VStack(spacing: 0) {
      VideoPlayer(player: player)
        .accessibilityLabel("Cinderdeck demo: History, Workspaces, Workflows, and Git")
      HStack {
        Text("History · Workspaces · Workflows · Git")
          .font(.callout.weight(.medium))
        Spacer()
        Button("Replay") { player.seek(to: .zero); player.play() }
          .accessibilityIdentifier("promo.replay")
      }.padding(16)
    }
  }
}
