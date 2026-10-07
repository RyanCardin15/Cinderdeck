//
//  AnnotateSidebarSections.swift
//  Cinderdeck
//
//  Section components for the annotation sidebar
//

import AppKit
import SwiftUI
import UniformTypeIdentifiers

// MARK: - Wallpaper Section

struct SidebarWallpaperSection: View {
  let state: AnnotateState
  @StateObject private var wallpaperManager = SystemWallpaperManager.shared

  var body: some View {
    VStack(alignment: .leading, spacing: Spacing.sm) {
      SidebarSectionHeader(title: L10n.Common.wallpapers)

      LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: GridConfig.gap), count: GridConfig.backgroundColumns), spacing: GridConfig.gap) {
        // Bundled default wallpapers
        ForEach(wallpaperManager.defaultWallpapers) { item in
          DefaultWallpaperButton(
            item: item,
            isSelected: isDefaultWallpaperSelected(item)
          ) {
            selectDefaultWallpaper(item)
          }
        }

        // Custom wallpapers from disk
        ForEach(wallpaperManager.customWallpapers) { item in
          CustomWallpaperButton(
            url: item.fullImageURL,
            isSelected: isUrlSelected(item.fullImageURL),
            action: {
              selectCustomWallpaper(item)
            },
            onRemove: {
              removeCustomWallpaper(item)
            })
        }

        // Add button
        AddWallpaperButton {
          addWallpaper()
        }
      }

      // Loading indicator
      if wallpaperManager.isLoading {
        HStack {
          ProgressView()
            .scaleEffect(0.6)
          Text(L10n.AnnotateUI.loadingWallpapers)
            .font(Typography.labelSmall)
            .foregroundColor(SidebarColors.labelSecondary)
        }
      }
    }
    .task {
      await wallpaperManager.loadDefaultWallpapers()
    }
  }

  private func isUrlSelected(_ url: URL) -> Bool {
    if case .wallpaper(let selectedUrl) = state.backgroundStyle {
      return selectedUrl == url
    }
    return false
  }

  private func isDefaultWallpaperSelected(_ item: SystemWallpaperManager.WallpaperItem) -> Bool {
    if case .wallpaper(let url) = state.backgroundStyle {
      return url == item.fullImageURL
    }
    return false
  }

  private func selectDefaultWallpaper(_ item: SystemWallpaperManager.WallpaperItem) {
    if state.padding <= 0 {
      state.padding = 24
    }
    state.backgroundStyle = .wallpaper(item.fullImageURL)
  }

  private func addWallpaper() {
    let panel = NSOpenPanel()
    panel.allowedContentTypes = [.image]
    panel.allowsMultipleSelection = false

    if panel.runModal() == .OK, let url = panel.url {
      if let item = wallpaperManager.addCustomWallpaper(url) {
        selectCustomWallpaper(item)
      }
    }
  }

  private func selectCustomWallpaper(_ item: SystemWallpaperManager.WallpaperItem) {
    if state.padding <= 0 {
      state.padding = 24
    }
    state.backgroundStyle = .wallpaper(item.fullImageURL)
  }

  private func removeCustomWallpaper(_ item: SystemWallpaperManager.WallpaperItem) {
    let url = item.fullImageURL
    wallpaperManager.removeCustomWallpaper(item)

    if case .wallpaper(let selectedUrl) = state.backgroundStyle, selectedUrl == url {
      state.resetCanvasEffectsToNone()
    }
  }
}

// MARK: - Blurred Section

struct SidebarBlurredSection: View {
  @ObservedObject var state: AnnotateState

  var body: some View {
    VStack(alignment: .leading, spacing: Spacing.sm) {
      SidebarSectionHeader(title: L10n.AnnotateUI.blurredBackground)

      LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: GridConfig.gap), count: GridConfig.backgroundColumns), spacing: GridConfig.gap) {
        ForEach(BlurredBackgroundEffect.allCases) { effect in
          BlurredBackgroundEffectButton(
            effect: effect,
            backgroundStyle: state.backgroundStyle,
            previewImage: previewImage,
            isSelected: isSelected(effect)
          ) {
            select(effect)
          }
          .disabled(!state.backgroundStyle.supportsBlurredBackgroundEffect)
        }
      }
    }
  }

  private func isSelected(_ effect: BlurredBackgroundEffect) -> Bool {
    state.isBlurredBackgroundEffectActive && state.blurredBackgroundEffect == effect
  }

  private func select(_ effect: BlurredBackgroundEffect) {
    guard state.backgroundStyle.supportsBlurredBackgroundEffect else { return }
    if isSelected(effect) {
      if case .blurred(let url) = state.backgroundStyle {
        state.backgroundStyle = .wallpaper(url)
      }
      state.isBlurredBackgroundEnabled = false
      return
    }
    if state.padding <= 0 {
      state.padding = 24
    }
    if case .blurred(let url) = state.backgroundStyle {
      state.backgroundStyle = .wallpaper(url)
    }
    state.blurredBackgroundEffect = effect
    state.isBlurredBackgroundEnabled = true
  }

  private var previewImage: NSImage? {
    guard let url = state.backgroundStyle.blurredEffectImageURL else { return nil }
    return state.cachedBackgroundImage(for: url)
  }
}
