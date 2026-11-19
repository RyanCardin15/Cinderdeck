//
//  QuickAccessStackView.swift
//  Cinderdeck
//
//  Vertical stacked container view for quick access cards
//

import SwiftUI

/// Displays a vertical stack of quick access cards, bottom-aligned in fixed-size panel
struct QuickAccessStackView: View {
  @ObservedObject var manager: QuickAccessManager
  @Environment(\.accessibilityReduceMotion) var reduceMotion

  var body: some View {
    let visibleItems = manager.items.filter { !(manager.hideCardWhenWindowOpen && $0.isWindowOpen) }
    
    Group {
      if manager.showingCompactPreview {
        if let item = visibleItems.first {
          CompactCapturePreview(item: item, manager: manager)
            .id(item.id)
        }
      } else {
        VStack(spacing: QuickAccessLayout.cardSpacing) {
          Spacer(minLength: 0)
          ForEach(visibleItems) { item in
            QuickAccessCardView(item: item, manager: manager)
              .id(item.id)
              .transition(cardTransition(for: item))
          }
        }
        .frame(width: QuickAccessLayout.scaledCardWidth(manager.overlayScale))
      }
    }
    .padding(QuickAccessLayout.containerPadding)
    .animation(.spring(response: 0.3, dampingFraction: 0.8), value: visibleItems.count)
  }

  private func cardTransition(for item: QuickAccessItem) -> AnyTransition {
    if reduceMotion {
      return .opacity
    }
    
    switch manager.animationStyle {
    case .scale:
      return .asymmetric(
        insertion: .scale(scale: 0.9, anchor: .bottom).combined(with: .opacity),
        removal: .scale(scale: 0.8, anchor: .bottom).combined(with: .opacity)
      )
    case .slide:
      let edge: Edge = manager.position.isLeftSide ? .leading : .trailing
      return .asymmetric(
        insertion: .move(edge: edge).combined(with: .opacity),
        removal: .move(edge: edge).combined(with: .opacity)
      )
    }
  }
}

private struct CompactCapturePreview: View {
  let item: QuickAccessItem
  let manager: QuickAccessManager
  @State private var hovering = false
  @State private var dragging = false

  var body: some View {
    HStack(spacing: 5) {
      thumbnail
      Button {
        manager.promptAboutCapture(id: item.id)
      } label: {
        Text(item.processingState == .idle ? "Ask agent" : "Preparing…")
          .font(.system(size: 12, weight: .semibold))
          .lineLimit(1)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, 4)
          .frame(height: 32)
          .contentShape(.rect)
          .background(hovering ? Color.primary.opacity(0.05) : .clear, in: .rect(cornerRadius: 7))
      }
      .buttonStyle(.plain)
      .disabled(item.processingState != .idle)
      .accessibilityLabel(item.isVideo ? "Ask agent about recording" : "Ask agent about screenshot")

      Button {
        manager.expandCaptureCards()
      } label: {
        Image(systemName: "ellipsis")
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(.secondary)
          .frame(width: 26, height: 32)
          .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Show capture actions")
      .help("Show capture actions")
    }
    .padding(.horizontal, 9)
    .frame(width: QuickAccessLayout.compactWidth, height: QuickAccessLayout.compactHeight)
    .background(.regularMaterial, in: .rect(cornerRadius: 12))
    .overlay { RoundedRectangle(cornerRadius: 12).strokeBorder(.primary.opacity(0.12)) }
    .shadow(color: .black.opacity(0.18), radius: 7, y: 2)
    .onHover { inside in
      hovering = inside
      if manager.pauseCountdownOnHover {
        if inside { manager.pauseCountdown(for: item.id) }
        else { manager.resumeCountdown(for: item.id) }
      }
    }
    .onDisappear {
      if hovering { manager.resumeCountdown(for: item.id) }
    }
  }

  private var thumbnail: some View {
    Image(nsImage: item.thumbnail)
      .resizable()
      .aspectRatio(contentMode: .fill)
      .frame(width: 32, height: 28)
      .clipShape(.rect(cornerRadius: 5))
      .overlay(alignment: .bottomTrailing) {
        if item.isVideo {
          Image(systemName: "play.fill")
            .font(.system(size: 6, weight: .bold))
            .padding(3)
            .foregroundStyle(.white)
            .background(.black.opacity(0.7), in: .rect(cornerRadius: 3))
        }
      }
      .opacity(dragging ? 0.6 : 1)
      .overlay {
        if manager.dragDropEnabled, item.processingState == .idle {
          QuickAccessDraggableView(
            fileURL: item.url,
            thumbnail: item.thumbnail,
            dismissDirection: 1,
            dragDropEnabled: true,
            twoFingerSwipeToDismissEnabled: false,
            swipeMode: .natural,
            onDragStarted: {
              dragging = true
              manager.pauseCountdownForActivity(item.id)
            },
            onDragEnded: { success in
              dragging = false
              if success {
                manager.dismissCard(id: item.id)
              } else {
                manager.resumeCountdownForActivity(item.id)
                if manager.pauseCountdownOnHover && hovering {
                  manager.pauseCountdown(for: item.id)
                }
              }
            },
            onSwipeChanged: { _ in },
            onSwipeEnded: { _, _ in },
            swipeSensitivity: 1,
            dragOnly: true,
            reservedScrollAxis: nil
          )
        }
      }
      .accessibilityLabel(item.isVideo ? "Recording thumbnail" : "Screenshot thumbnail")
      .help(manager.dragDropEnabled ? "Drag the capture to another app" : "")
  }

}
