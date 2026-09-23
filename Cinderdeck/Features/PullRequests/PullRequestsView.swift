import AppKit
import SwiftUI

struct PullRequestsView: View {
  @ObservedObject var model: PullRequestsViewModel
  @ObservedObject private var theme = ThemeManager.shared
  @State private var viewEditor: PRViewEditorContext?
  @State private var showsFilters = true
  @State private var showsSidebar = true

  var body: some View {
    HStack(spacing: 0) {
      if showsSidebar { sidebar.frame(width: 228); Divider() }
      VStack(spacing: 0) {
        header
        if model.login == nil { connectionState }
        else {
          tabs
          if showsFilters { filters }
          if let error = model.error { banner(error, symbol: "exclamationmark.triangle", tint: .orange) { model.error = nil } }
          if let notice = model.notice { banner(notice, symbol: "checkmark.circle", tint: .green) { model.notice = nil } }
          HSplitView {
            requestList.frame(minWidth: 360)
            if let request = model.selectedRequest {
              PullRequestInspector(model: model, request: request)
                .frame(minWidth: 380, idealWidth: 430, maxWidth: 580)
            }
          }
        }
      }
    }
    .background(Color(nsColor: .windowBackgroundColor))
    .preferredColorScheme(theme.systemAppearance)
    .task { if model.login == nil { await model.connect() } }
    .onReceive(NotificationCenter.default.publisher(for: .githubAccountChanged)) { notification in
      guard notification.userInfo?["force"] as? Bool == true ||
        (notification.userInfo?["login"] as? String) != (model.login ?? "") else { return }
      Task {
        while model.connecting || model.submitting || !model.starring.isEmpty {
          do { try await Task.sleep(nanoseconds: 100_000_000) } catch { return }
        }
        await model.connect(hostname: notification.userInfo?["hostname"] as? String)
      }
    }
    .onChange(of: model.filters) { _ in model.scheduleSearch() }
    .sheet(item: $viewEditor) { context in PRSavedViewEditor(model: model, context: context) }
    .frame(minWidth: 1000, minHeight: 600)
  }

  private var sidebar: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 10) {
        Image(systemName: "arrow.triangle.pull").font(.system(size: 22, weight: .semibold)).foregroundStyle(Color.accentColor)
        VStack(alignment: .leading, spacing: 2) {
          Text("Cinderdeck").font(.system(size: 15, weight: .semibold))
          Text("GITHUB WORKSPACE").font(.system(size: 9, weight: .semibold)).tracking(1.1).foregroundStyle(.secondary)
        }
      }.padding(20)
      Button { model.selectRepository(nil) } label: {
        HStack(spacing: 10) {
          Image(systemName: "tray.full").frame(width: 18)
          Text("My work").fontWeight(.medium)
          Spacer()
          if (model.filters.repository == nil && model.filters.organization == nil) { Circle().fill(Color.accentColor).frame(width: 5, height: 5) }
        }.padding(10).background((model.filters.repository == nil && model.filters.organization == nil) ? Color.accentColor.opacity(0.12) : .clear, in: RoundedRectangle(cornerRadius: 7))
      }.buttonStyle(.plain).padding(.horizontal, 10).help("Pull requests you are involved in, across GitHub")
      Picker("Organization", selection: Binding(get: { model.filters.organization ?? "" }, set: { model.selectOrganization($0.isEmpty ? nil : $0) })) {
        Text("All organizations").tag("")
        ForEach(model.availableOrganizations, id: \.self) { Text($0).tag($0) }
      }.labelsHidden().controlSize(.small).padding(.horizontal, 14).padding(.top, 14)
        .accessibilityLabel("Organization").accessibilityIdentifier("prs.organization")
        .disabled(model.login == nil)
      if model.loadingOrganizations {
        HStack(spacing: 6) { ProgressView().controlSize(.mini); Text("Loading organizations…").font(.caption) }
          .foregroundStyle(.secondary).padding(.horizontal, 16).padding(.top, 6)
      }
      if let message = model.organizationError {
        Text("Couldn’t load all organizations. \(message)").font(.caption).foregroundStyle(.orange).padding(.horizontal, 14)
      }
      HStack {
        Text("REPOSITORIES").font(.system(size: 10, weight: .semibold)).tracking(0.8).foregroundStyle(.secondary)
        Spacer()
        if model.connecting || (model.loadingRepositories || model.loadingSelectedOrganization) {
          ProgressView().progressViewStyle(.circular).controlSize(.small)
            .accessibilityLabel("Loading repositories")
        }
        Button { model.starredOnly.toggle() } label: {
          Image(systemName: model.starredOnly ? "star.fill" : "star").foregroundStyle(model.starredOnly ? .yellow : .secondary)
        }.buttonStyle(.plain).help(model.starredOnly ? "Show all repositories" : "Show only starred repositories")
          .accessibilityLabel("Show only starred repositories").accessibilityValue(model.starredOnly ? "On" : "Off")
      }.padding(.horizontal, 20).padding(.top, 26).padding(.bottom, 12)
      HStack(spacing: 6) {
        Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
        TextField("Find a repository", text: $model.repositorySearch).textFieldStyle(.plain)
          .accessibilityIdentifier("prs.repositorySearch")
      }.font(.system(size: 11)).padding(8).background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 6))
        .padding(.horizontal, 14).padding(.bottom, 10)
      if let message = model.repositoryError {
        VStack(alignment: .leading, spacing: 6) {
          Text("Some repositories could not be loaded. \(message)").font(.caption).foregroundStyle(.orange)
          Button("Retry") {
            if model.filters.organization != nil { model.reloadOrganization() }
            else { Task { await model.connect() } }
          }.controlSize(.small)
        }.padding(.horizontal, 14).padding(.bottom, 8)
      }
      ScrollView {
        LazyVStack(spacing: 3) {
          ForEach(model.visibleRepositories) { repository in repositoryRow(repository) }
          if model.visibleRepositories.isEmpty && !model.connecting && !(model.loadingRepositories || model.loadingSelectedOrganization) {
            Text(model.starredOnly ? "Star repositories to keep them here." : "No repositories found.")
              .font(.system(size: 12)).foregroundStyle(.secondary).padding(20)
          }
        }.padding(.horizontal, 10)
      }
      Divider().padding(.horizontal, 14)
      HStack(spacing: 9) {
        ZStack {
          Circle().fill(Color.accentColor.opacity(0.12)).frame(width: 28, height: 28)
          Text(String((model.login ?? "?").prefix(1)).uppercased()).font(.system(size: 12, weight: .semibold)).foregroundStyle(Color.accentColor)
        }
        VStack(alignment: .leading, spacing: 2) {
          Text(model.login ?? "Not connected").font(.system(size: 11, weight: .semibold)).lineLimit(1)
          Text(model.hostname).font(.system(size: 10)).foregroundStyle(.secondary)
        }
        Spacer(minLength: 2)
        Button { PreferencesWindowController.shared.show(tab: .github) } label: { Image(systemName: "gearshape") }
          .buttonStyle(.plain).help("GitHub preferences").accessibilityLabel("GitHub preferences")
        Button { Task { await model.connect() } } label: { Image(systemName: "arrow.triangle.2.circlepath") }
          .buttonStyle(.plain).disabled(model.connecting || model.submitting || !model.starring.isEmpty)
          .help("Reload repositories and reconnect to the active GitHub CLI account").accessibilityLabel("Reconnect GitHub")
      }.padding(16)
    }.background(Color(nsColor: .controlBackgroundColor).opacity(0.5))
  }

  private func repositoryRow(_ repository: GitHubRepository) -> some View {
    HStack(spacing: 3) {
      Button { model.selectRepository(repository.nameWithOwner) } label: {
        HStack(spacing: 8) {
          Image(systemName: repository.isPrivate ? "lock" : "book.closed").font(.system(size: 12)).foregroundStyle(.secondary).frame(width: 18)
          VStack(alignment: .leading, spacing: 3) {
            Text(repository.name).font(.system(size: 12, weight: .medium)).lineLimit(1).truncationMode(.middle)
            Text(repository.owner + (repository.isArchived ? " · Archived" : "")).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
          }
          Spacer(minLength: 0)
        }.padding(.vertical, 8).padding(.leading, 8).contentShape(Rectangle())
      }.buttonStyle(.plain).help(repository.nameWithOwner).accessibilityLabel(repository.nameWithOwner)
      Button { Task { await model.toggleStar(repository) } } label: {
        Group {
          if model.starring.contains(repository.id) {
            ProgressView().progressViewStyle(.circular).controlSize(.small)
          } else {
            Image(systemName: repository.viewerHasStarred ? "star.fill" : "star")
              .font(.system(size: 11)).foregroundStyle(repository.viewerHasStarred ? Color.yellow : Color.secondary.opacity(0.6))
          }
        }.frame(width: 27, height: 30).contentShape(Rectangle())
      }.buttonStyle(.plain).disabled(model.starring.contains(repository.id) || model.connecting)
        .help(repository.viewerHasStarred ? "Unstar on GitHub" : "Star on GitHub")
        .accessibilityLabel("\(repository.viewerHasStarred ? "Unstar" : "Star") \(repository.nameWithOwner) on GitHub")
    }.background(model.filters.repository == repository.nameWithOwner ? Color.accentColor.opacity(0.12) : .clear, in: RoundedRectangle(cornerRadius: 7))
      .contextMenu { Button("Open repository on GitHub") { PROpenURL.open(repository.url) } }
  }

  private var header: some View {
    HStack(spacing: 12) {
      Button { showsSidebar.toggle() } label: { Image(systemName: "sidebar.left") }
        .buttonStyle(.plain).help("Toggle repositories").accessibilityLabel("Toggle repository sidebar")
      VStack(alignment: .leading, spacing: 4) {
        Text("Pull requests").font(.system(size: 21, weight: .semibold))
        Text(model.filters.repository ?? model.filters.organization.map { "\($0) · all accessible repositories" } ?? "My work · pull requests you're involved in")
          .font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
      }
      Spacer()
      if let message = loadingMessage {
        ProgressView().progressViewStyle(.circular).controlSize(.small)
          .help(message).accessibilityLabel(message).accessibilityIdentifier("prs.loading")
      }
      Button { showsFilters.toggle() } label: { Label("Filters", systemImage: "line.3.horizontal.decrease") }
        .buttonStyle(.bordered).controlSize(.small).disabled(model.login == nil)
      Button { model.scheduleSearch(immediate: true, force: true) } label: { Image(systemName: "arrow.clockwise") }
        .buttonStyle(.bordered).controlSize(.small).help("Refresh pull requests (⌘R)").accessibilityLabel("Refresh pull requests")
        .keyboardShortcut("r", modifiers: .command).disabled(model.login == nil || model.loading)
    }.padding(.horizontal, 22).padding(.vertical, 18)
  }

  private var loadingMessage: String? {
    if model.connecting { return "Connecting to GitHub…" }
    if (model.loadingRepositories || model.loadingSelectedOrganization) { return "Loading repositories…" }
    if model.loading { return "Loading pull requests…" }
    if model.loadingDetail { return "Loading pull request details…" }
    if model.loadingFiles { return "Loading changed files…" }
    if model.submitting { return "Submitting review…" }
    if !model.starring.isEmpty { return "Updating repository star…" }
    return nil
  }

  private var tabs: some View {
    HStack(spacing: 4) {
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 18) {
          ForEach(model.views) { view in
            Button { model.selectView(view) } label: {
              VStack(spacing: 12) {
                HStack(spacing: 4) {
                  Text(view.name).font(.system(size: 12, weight: model.selectedViewID == view.id ? .semibold : .regular))
                  if model.selectedViewID == view.id && model.viewIsModified { Circle().fill(Color.accentColor).frame(width: 4, height: 4) }
                }.foregroundStyle(model.selectedViewID == view.id ? Color.primary : Color.secondary)
                Rectangle().fill(model.selectedViewID == view.id ? Color.accentColor : .clear).frame(height: 2)
              }.contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityLabel("\(view.name) view")
              .accessibilityAddTraits(model.selectedViewID == view.id ? .isSelected : [])
              .contextMenu {
                if !view.isBuiltIn {
                  Button("Edit saved view…") { model.selectView(view); viewEditor = .init(view: view) }
                  Button("Move left") { model.moveView(view, by: -1) }
                  Button("Move right") { model.moveView(view, by: 1) }
                  Divider()
                  Button("Delete view", role: .destructive) { model.deleteView(view) }
                }
              }
          }
        }.padding(.top, 6)
      }
      Button { viewEditor = .init(view: nil) } label: { Image(systemName: "plus").frame(width: 26, height: 26) }
        .buttonStyle(.plain).help("Save these filters as a new view").accessibilityLabel("New saved view")
    }.padding(.horizontal, 22).overlay(alignment: .bottom) { Divider() }
  }

  private var filters: some View {
    VStack(spacing: 9) {
      HStack(spacing: 8) {
        Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
        TextField(model.filters.advanced ? "GitHub query, e.g. is:open author:@me label:bug" : "Search pull requests…", text: $model.filters.text)
          .textFieldStyle(.plain).accessibilityIdentifier("prs.search")
        if !model.filters.text.isEmpty {
          Button { model.filters.text = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
            .buttonStyle(.plain).accessibilityLabel("Clear search")
        }
        Toggle(isOn: $model.filters.advanced) { Text("Query") }.toggleStyle(.button).controlSize(.small)
          .help("Use GitHub search qualifiers. The selected repository or My work scope still applies.")
      }.padding(9).background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 7))
      HStack(spacing: 10) {
        if !model.filters.advanced {
          Picker("State", selection: $model.filters.state) { ForEach(PRStateFilter.allCases) { Text($0.rawValue).tag($0) } }.frame(width: 170)
          TextField("Label", text: $model.filters.label).textFieldStyle(.roundedBorder).frame(width: 110).accessibilityLabel("Filter by label")
        }
        Picker("Role", selection: $model.filters.role) { ForEach(PRRoleFilter.allCases) { Text($0.rawValue).tag($0) } }.frame(width: 185)
        Spacer(minLength: 4)
        Picker("Sort", selection: $model.filters.sort) { ForEach(PRSort.allCases) { Text($0.rawValue).tag($0) } }.labelsHidden().frame(width: 150).accessibilityLabel("Sort pull requests")
        if model.viewIsModified, let view = model.selectedView, !view.isBuiltIn {
          Button("Save changes") { _ = model.saveView(name: view.name, replacing: view.id) }.buttonStyle(.borderless)
        }
      }.font(.system(size: 11)).controlSize(.small)
    }.padding(.horizontal, 22).padding(.vertical, 14)
    .overlay(alignment: .bottom) { Divider() }
  }

  private var requestList: some View {
    VStack(spacing: 0) {
      HStack {
        Text(model.loading && model.requests.isEmpty ? "Finding pull requests…" : "\(model.totalCount) pull request\(model.totalCount == 1 ? "" : "s")")
        Spacer()
        if model.loading && !model.requests.isEmpty { Text("Refreshing…") }
        else if let updated = model.lastUpdated { Text("Updated \(updated.formatted(date: .omitted, time: .shortened))") }
      }.font(.system(size: 10, weight: .medium)).foregroundStyle(.secondary).padding(.horizontal, 22).padding(.vertical, 12)
      if model.requests.isEmpty {
        VStack(spacing: 12) {
          if model.loading {
            ProgressView().progressViewStyle(.circular).controlSize(.large)
              .padding(.bottom, 4)
              .accessibilityLabel("Loading pull requests")
              .accessibilityIdentifier("prs.loadingRequests")
          } else {
            Image(systemName: model.error == nil ? "tray" : "wifi.exclamationmark")
              .font(.system(size: 32, weight: .light)).foregroundStyle(.secondary)
          }
          Text(model.loading ? "Loading pull requests…" : model.error == nil ? "You're all caught up" : "Couldn't load pull requests")
            .font(.system(size: 17, weight: .semibold))
          Text(model.loading ? (model.filters.repository ?? model.filters.organization ?? "Fetching your latest work from GitHub.") : model.error == nil ? "No pull requests match this view. Try another tab or adjust your filters." : "Your filters are saved. Retry when you're ready.")
            .font(.system(size: 12)).foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 320)
          if !model.loading {
            Button(model.error == nil ? "Clear filters" : "Retry") {
              if model.error == nil { model.filters = PRFilters(repository: model.filters.repository, organization: model.filters.organization, state: .all) }
              else { model.scheduleSearch(immediate: true, force: true) }
            }.buttonStyle(.bordered)
          }
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
      } else {
        List(selection: Binding(get: { model.selectedID }, set: { model.select($0) })) {
          ForEach(model.requests) { request in
            PullRequestRow(request: request, selected: model.selectedID == request.id).tag(request.id)
              .listRowSeparator(.hidden)
              .contextMenu {
                Button("Open on GitHub") { PROpenURL.open(request.url) }
                Button("Copy link") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(request.url, forType: .string) }
              }
          }
        }.listStyle(.inset).accessibilityLabel("Pull requests")
        if model.canLoadMore {
          Button { Task { await model.loadMore() } } label: {
            HStack(spacing: 8) {
              if model.loading {
                ProgressView().progressViewStyle(.circular).controlSize(.small)
                  .accessibilityLabel("Loading more pull requests")
              }
              Text(model.loading ? "Loading more…" : "Load more · \(model.requests.count) of \(model.totalCount)")
            }
          }.disabled(model.loading).buttonStyle(.borderless).padding(12)
        } else if model.searchLimitReached {
          Text("Showing GitHub's first 1,000 results. Narrow your filters to see more.").font(.caption).foregroundStyle(.secondary).padding(12)
        }
      }
    }.background(Color(nsColor: .textBackgroundColor).opacity(0.35))
  }

  private var connectionState: some View {
    VStack(spacing: 16) {
      Image(systemName: "arrow.triangle.pull").font(.system(size: 40, weight: .light)).foregroundStyle(Color.accentColor)
      Text(model.connecting ? "Connecting to GitHub" : "Your GitHub, in one place").font(.system(size: 23, weight: .semibold))
      Text("Browse repositories, keep your favorites close, and give every review a clear place to land.")
        .font(.system(size: 13)).foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 390)
      if model.connecting {
        ProgressView().progressViewStyle(.circular).controlSize(.large)
          .accessibilityLabel("Connecting to GitHub")
      }
      else {
        if let error = model.error { Text(error).font(.callout).foregroundStyle(.orange).textSelection(.enabled).frame(maxWidth: 460) }
        Text("Connect your account in Preferences → GitHub.").font(.callout)
        Button("Open GitHub preferences") { PreferencesWindowController.shared.show(tab: .github) }
          .buttonStyle(.borderedProminent)

      }
    }.padding(30).frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private func banner(_ text: String, symbol: String, tint: Color, dismiss: @escaping () -> Void) -> some View {
    HStack(alignment: .top, spacing: 8) {
      Image(systemName: symbol).foregroundStyle(tint)
      Text(text).font(.system(size: 11)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 0)
      Button(action: dismiss) { Image(systemName: "xmark") }.buttonStyle(.plain).accessibilityLabel("Dismiss message")
    }.padding(12).background(tint.opacity(0.08))
  }
}

struct PullRequestRow: View {
  let request: PullRequest
  var selected = false
  private var secondary: Color { selected ? .white.opacity(0.85) : .secondary }
  private func status(_ color: Color) -> Color { selected ? .white : color }
  var body: some View {
    HStack(alignment: .top, spacing: 11) {
      Image(systemName: request.state == "MERGED" ? "arrow.triangle.merge" : request.state == "CLOSED" ? "xmark.circle" : "arrow.triangle.pull")
        .font(.system(size: 15, weight: .medium)).foregroundStyle(status(PRStyle.stateColor(request))).frame(width: 19).padding(.top, 3)
      VStack(alignment: .leading, spacing: 7) {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
          Text(request.title).font(.system(size: 13, weight: .medium)).lineLimit(2)
          Text("#\(request.number)").font(.system(size: 11, design: .monospaced)).foregroundStyle(secondary)
        }
        Text("\(request.repository.nameWithOwner) · \(request.author?.login ?? "Deleted user")")
          .font(.system(size: 10.5)).foregroundStyle(secondary).lineLimit(1).truncationMode(.middle)
        HStack(spacing: 10) {
          Text(request.stateLabel).foregroundStyle(status(PRStyle.stateColor(request)))
          Label(request.checks, systemImage: PRStyle.checkSymbol(request.checks)).foregroundStyle(status(PRStyle.checkColor(request.checks)))
          Text("+\(request.additions)").foregroundColor(status(.green)) + Text(" −\(request.deletions)").foregroundColor(status(.red))
          Spacer(minLength: 0)
          Text(request.updatedLabel).foregroundStyle(secondary)
        }.font(.system(size: 10)).lineLimit(1)
      }
      Spacer(minLength: 0)
    }.padding(.vertical, 10).contentShape(Rectangle())
      .accessibilityElement(children: .combine)
  }
}

enum PRStyle {
  static func stateColor(_ request: PullRequest) -> Color {
    request.state == "MERGED" ? .purple : request.state == "CLOSED" ? .red : request.isDraft ? .secondary : .green
  }
  static func checkColor(_ value: String) -> Color { value == "Passed" ? .green : value == "Failed" ? .red : value == "Pending" ? .orange : .secondary }
  static func checkSymbol(_ value: String) -> String { value == "Passed" ? "checkmark.circle" : value == "Failed" ? "xmark.circle" : value == "Pending" ? "clock" : "minus.circle" }
}

enum PROpenURL {
  static func open(_ value: String) {
    guard let url = URL(string: value), url.scheme == "https", (url.host == GitHubHost.current || url.host == "github.com" || url.host == "cli.github.com"), url.user == nil, url.password == nil else { return }
    NSWorkspace.shared.open(url)
  }
}

struct PRViewEditorContext: Identifiable {
  let id = UUID()
  var view: PRSavedView?
}

private struct PRSavedViewEditor: View {
  @ObservedObject var model: PullRequestsViewModel
  let context: PRViewEditorContext
  @Environment(\.dismiss) private var dismiss
  @State private var name = ""
  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      Text(context.view == nil ? "Save a new view" : "Edit saved view").font(.title2.weight(.semibold))
      Text("Keep this repository, search, filters, and sort order in a tab you can return to.").font(.callout).foregroundStyle(.secondary)
      TextField("View name", text: $name).textFieldStyle(.roundedBorder).accessibilityIdentifier("prs.viewName")
      Text(model.query).font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary).textSelection(.enabled)
        .padding(12).frame(maxWidth: .infinity, alignment: .leading).background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
      HStack {
        Text("\(name.count)/40").font(.caption).foregroundStyle(.secondary)
        Spacer()
        Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
        Button("Save view") { if model.saveView(name: name, replacing: context.view?.id) { dismiss() } }
          .buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
          .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || name.count > 40)
      }
    }.padding(26).frame(width: 440).onAppear { name = context.view?.name ?? "" }
  }
}
