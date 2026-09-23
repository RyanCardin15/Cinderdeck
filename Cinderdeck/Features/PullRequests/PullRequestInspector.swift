import SwiftUI

struct PullRequestInspector: View {
  @ObservedObject var model: PullRequestsViewModel
  let request: PullRequest
  @State private var tab = "Overview"
  @State private var reviewContext: PRReviewContext?

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        Text("\(request.repository.nameWithOwner) #\(request.number)").font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
        Spacer()
        Button { PROpenURL.open(request.url) } label: { Image(systemName: "arrow.up.right.square") }
          .help("Open pull request on GitHub").accessibilityLabel("Open pull request on GitHub")
        Button { model.select(nil) } label: { Image(systemName: "xmark") }.help("Close details").accessibilityLabel("Close pull request details")
      }.buttonStyle(.plain).padding(18)
      Divider()
      if model.loadingDetail {
        ProgressView("Loading details…").frame(maxWidth: .infinity, maxHeight: .infinity)
      } else {
        if let error = model.detailError {
          VStack(alignment: .leading, spacing: 8) {
            Text(error).font(.callout).foregroundStyle(.orange).textSelection(.enabled)
            Button("Retry details") { model.select(request.id) }
          }.padding(18)
        }
        if let detail = model.detail {
          VStack(alignment: .leading, spacing: 12) {
            Text(request.title).font(.system(size: 19, weight: .semibold)).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            HStack(spacing: 8) {
              Text(detail.state == "OPEN" && detail.isDraft ? "Draft" : detail.state.capitalized)
                .font(.system(size: 10, weight: .semibold)).padding(.horizontal, 8).padding(.vertical, 4)
                .background(PRStyle.stateColor(request).opacity(0.12), in: Capsule()).foregroundStyle(PRStyle.stateColor(request))
              Text(request.author?.login ?? "Deleted user").font(.system(size: 11)).foregroundStyle(.secondary)
              Spacer()
            }
            Text("\(detail.headRefName) → \(detail.baseRefName)").font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary).lineLimit(2).textSelection(.enabled)
          }.padding(18)
          Picker("Details", selection: $tab) {
            Text("Overview").tag("Overview")
            Text("Files (\(request.changedFiles))").tag("Files")
            Text("Activity").tag("Activity")
          }.pickerStyle(.segmented).labelsHidden().padding(.horizontal, 18).padding(.bottom, 14)
          Divider()
          ScrollView {
            VStack(alignment: .leading, spacing: 20) {
              if tab == "Overview" { overview(detail) }
              else if tab == "Files" { changedFiles }
              else { activity(detail) }
            }.padding(18).frame(maxWidth: .infinity, alignment: .leading)
          }
          Divider()
          HStack {
            VStack(alignment: .leading, spacing: 3) {
              Text("\(request.changedFiles) changed files").font(.system(size: 10)).foregroundStyle(.secondary)
              (Text("+\(request.additions)").foregroundColor(.green) + Text(" −\(request.deletions)").foregroundColor(.red))
                .font(.system(size: 11, design: .monospaced))
            }
            Spacer()
            Button("Review…") { reviewContext = .init(request: request, detail: detail) }
              .buttonStyle(.borderedProminent).disabled(detail.state != "OPEN" || model.submitting)
              .help(detail.state == "OPEN" ? "Approve, request changes, or leave a comment" : "Reviews are available for open pull requests")
          }.padding(18)
        } else { Spacer() }
      }
    }
    .background(Color(nsColor: .controlBackgroundColor))
    .onChange(of: request.id) { _ in tab = "Overview" }
    .task(id: "\(request.id)-\(tab)-\(model.detail?.headRefOid ?? "")") {
      if tab == "Files", model.files.isEmpty { await model.loadFiles() }
    }
    .sheet(item: $reviewContext) { context in PRReviewComposer(model: model, context: context) }
  }

  private func overview(_ detail: PullRequestDetail) -> some View {
    VStack(alignment: .leading, spacing: 20) {
      VStack(alignment: .leading, spacing: 12) {
        statusRow("Checks", value: request.checks, symbol: PRStyle.checkSymbol(request.checks), color: PRStyle.checkColor(request.checks))
        statusRow("Review", value: detail.reviewDecision.map { $0.replacingOccurrences(of: "_", with: " ").capitalized } ?? "No review decision", symbol: "person.crop.circle.badge.checkmark", color: detail.reviewDecision == "APPROVED" ? .green : .secondary)
        statusRow("Merge status", value: detail.state != "OPEN" ? detail.state.capitalized : detail.mergeable == "CONFLICTING" ? "Has conflicts" : detail.mergeable == "MERGEABLE" ? "No conflicts" : "Checking…", symbol: "arrow.triangle.merge", color: detail.mergeable == "CONFLICTING" ? .orange : .secondary)
      }.padding(12).background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 9))
      if !request.labels.nodes.isEmpty {
        Text(request.labels.nodes.map(\.name).joined(separator: "  ·  ")).font(.system(size: 11, weight: .medium)).foregroundStyle(Color.accentColor)
      }
      Text("DESCRIPTION").font(.system(size: 10, weight: .semibold)).tracking(0.7).foregroundStyle(.secondary)
      PRMarkdown(text: detail.body.isEmpty ? "No description provided." : detail.body)
      Button("View checks and full conversation on GitHub") { PROpenURL.open(request.url) }.buttonStyle(.link).font(.callout)
    }
  }

  private func statusRow(_ label: String, value: String, symbol: String, color: Color) -> some View {
    HStack(alignment: .firstTextBaseline) {
      Text(label).font(.system(size: 11)).foregroundStyle(.secondary)
      Spacer()
      Label(value, systemImage: symbol).font(.system(size: 11, weight: .medium)).foregroundStyle(color)
    }
  }

  private var changedFiles: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("\(model.files.count) of \(request.changedFiles) files · diff previews")
        .font(.system(size: 10)).foregroundStyle(.secondary)
      ForEach(model.files) { file in PRFileDisclosure(file: file) }
      if model.loadingFiles { ProgressView("Loading files…").controlSize(.small).padding() }
      if model.filesHaveMore {
        Button("Load more files") { Task { await model.loadFiles() } }.disabled(model.loadingFiles)
      } else if !model.loadingFiles && model.files.count < request.changedFiles {
        Text("Some changes aren't available in this preview. Open GitHub for the complete diff.").font(.caption).foregroundStyle(.secondary)
      }
      Button("Open complete diff on GitHub") { PROpenURL.open(request.url + "/files") }.buttonStyle(.link)
    }
  }

  private func activity(_ detail: PullRequestDetail) -> some View {
    VStack(alignment: .leading, spacing: 18) {
      if detail.activity.isEmpty { Text("No comments or reviews yet.").font(.callout).foregroundStyle(.secondary) }
      if (detail.reviews.totalCount ?? 0) > 50 || (detail.comments.totalCount ?? 0) > 50 {
        Text("Showing the latest 50 reviews and 50 conversation comments. Inline comments are available on GitHub.").font(.caption).foregroundStyle(.secondary)
      } else {
        Text("Reviews and conversation comments. Open GitHub for inline discussions.").font(.caption).foregroundStyle(.secondary)
      }
      ForEach(detail.activity) { activity in
        VStack(alignment: .leading, spacing: 9) {
          HStack {
            Text(activity.author?.login ?? "Deleted user").font(.system(size: 12, weight: .semibold))
            Spacer()
            Text(activity.createdAt, style: .date).font(.system(size: 10)).foregroundStyle(.secondary)
          }
          if let state = activity.state { Text(state.replacingOccurrences(of: "_", with: " ").capitalized).font(.system(size: 10, weight: .medium)).foregroundStyle(state == "APPROVED" ? .green : .secondary) }
          if !activity.body.isEmpty { PRMarkdown(text: activity.body) }
        }.padding(12).background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 8))
      }
    }
  }
}

private struct PRFileDisclosure: View {
  let file: PullRequestFile
  @State private var expanded = false
  private func highlight(_ patch: String) -> AttributedString {
    var result = AttributedString()
    for line in patch.split(separator: "\n", omittingEmptySubsequences: false) {
      var part = AttributedString(String(line) + "\n")
      if line.hasPrefix("+") { part.foregroundColor = .green }
      else if line.hasPrefix("-") { part.foregroundColor = .red }
      else if line.hasPrefix("@@") { part.foregroundColor = .secondary }
      result.append(part)
    }
    return result
  }
  var body: some View {
    DisclosureGroup(isExpanded: $expanded) {
      if let patch = file.patch {
        ScrollView(.horizontal) {
          Text(highlight(patch)).font(.system(size: 10, design: .monospaced)).textSelection(.enabled).fixedSize(horizontal: true, vertical: true)
            .padding(10).frame(maxWidth: .infinity, alignment: .leading)
        }.background(Color.primary.opacity(0.025))
      } else {
        Text("No text preview. This file may be binary, too large, or unchanged after a rename.")
          .font(.caption).foregroundStyle(.secondary).padding(10)
      }
    } label: {
      VStack(alignment: .leading, spacing: 5) {
        Text(file.filename).font(.system(size: 11, weight: .medium, design: .monospaced)).lineLimit(2).truncationMode(.middle)
        HStack(spacing: 8) {
          Text(file.status.capitalized).foregroundStyle(.secondary)
          Text("+\(file.additions)").foregroundStyle(.green)
          Text("−\(file.deletions)").foregroundStyle(.red)
        }.font(.system(size: 10))
      }
    }.padding(10).background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 7))
  }
}

private struct PRMarkdown: View {
  let text: String
  var body: some View {
    Text((try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text))
      .font(.system(size: 12)).lineSpacing(5).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
      .environment(\.openURL, OpenURLAction { url in
        guard ["https", "http"].contains(url.scheme?.lowercased() ?? "") else { return .discarded }
        return .systemAction
      })
  }
}

struct PRReviewContext: Identifiable {
  var id: String { request.id }
  var request: PullRequest
  var detail: PullRequestDetail
}

private struct PRReviewComposer: View {
  @ObservedObject var model: PullRequestsViewModel
  let context: PRReviewContext
  @Environment(\.dismiss) private var dismiss
  @State private var event = PRReviewEvent.comment
  @State private var bodyText = ""
  @State private var error: String?
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("Review pull request").font(.title2.weight(.semibold))
      Text("\(context.request.repository.nameWithOwner) #\(context.request.number)\n\(context.request.title)")
        .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      Picker("Review", selection: $event) { ForEach(PRReviewEvent.allCases) { Text($0.title).tag($0) } }.pickerStyle(.segmented).labelsHidden()
      TextEditor(text: $bodyText).font(.system(size: 13)).padding(6).frame(height: 150)
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.25)))
        .accessibilityLabel("Review comment")
      Text(event == .approve ? "Your approval will be attached to the revision you reviewed. A comment is optional." : "Explain your feedback. This review will be posted to GitHub.")
        .font(.caption).foregroundStyle(.secondary)
      if let validation { Text(validation).font(.caption).foregroundStyle(.orange) }
      if let error { Text(error).font(.callout).foregroundStyle(.red).textSelection(.enabled).fixedSize(horizontal: false, vertical: true) }
      HStack {
        Text("Reviewing \(String(context.detail.headRefOid.prefix(7))) as \(model.login ?? "")").font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary)
        Spacer()
        if model.submitting { ProgressView().controlSize(.small) }
        Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction).disabled(model.submitting)
        Button("Submit \(event == .comment ? "comment" : "review")") {
          Task {
            error = await model.submit(request: context.request, reviewed: context.detail, event: event, body: bodyText)
            if error == nil { dismiss() }
          }
        }.buttonStyle(.borderedProminent).disabled(model.submitting || validation != nil)
      }
    }.padding(26).frame(width: 560).interactiveDismissDisabled(model.submitting)
      .disabled(model.submitting)
  }
  private var validation: String? { event.validation(detail: context.detail, login: model.login ?? "", body: bodyText) }
}
