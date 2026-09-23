import AppKit
import SwiftUI

struct GitHubSettingsView: View {
  @ObservedObject var model = GitHubAccountViewModel.shared

  @State private var hostname = ""
  @State private var showsServerSettings = false

  var body: some View {
    Form {
      Section {
        HStack(alignment: .top, spacing: 14) {
          Image(systemName: "arrow.triangle.pull")
            .font(.system(size: 25, weight: .medium)).foregroundStyle(Color.accentColor)
            .frame(width: 48, height: 48).background(Color.accentColor.opacity(0.1), in: RoundedRectangle(cornerRadius: 12))
          VStack(alignment: .leading, spacing: 5) {
            Text(model.account.login.map { "Connected as \($0)" } ?? "Connect your GitHub account")
              .font(.system(size: 15, weight: .semibold))
            Text("Repositories, stars, and pull request reviews, together in Cinderdeck.")
              .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Label(model.account.hostname, systemImage: model.account.login == nil ? "network" : "checkmark.circle.fill")
              .font(.caption).foregroundStyle(model.account.login == nil ? Color.secondary : .green)
          }
          Spacer(minLength: 0)
          if model.checking { ProgressView().controlSize(.small) }
        }.padding(.vertical, 6)
      }

      if model.signingIn {
        Section("Finish signing in") {
          if let code = model.progress.code {
            Text("Copy this one-time code, then enter it on GitHub to authorize your connection.")
              .font(.callout).foregroundStyle(.secondary)
            HStack {
              Text(code).font(.system(size: 25, weight: .semibold, design: .monospaced)).tracking(3).textSelection(.enabled)
                .accessibilityLabel("GitHub one-time code: \(code)")
              Spacer()
            }.padding(.vertical, 8)
          } else {
            HStack(spacing: 10) {
              ProgressView().controlSize(.small)
              Text(model.progress.url == nil ? "Requesting sign-in from GitHub…" : "Continue in your browser to authorize GitHub.")
            }
          }
          HStack {
            if let url = model.progress.url {
              Button(model.progress.code == nil ? "Continue in browser" : "Copy code and open GitHub") {
                if let code = model.progress.code {
                  NSPasteboard.general.clearContents()
                  NSPasteboard.general.setString(code, forType: .string)
                }
                NSWorkspace.shared.open(url)
              }.buttonStyle(.borderedProminent).accessibilityIdentifier("github.continueSignIn")
            }
            Spacer()
            Button("Cancel sign-in") { model.cancel() }.accessibilityIdentifier("github.cancelSignIn")
          }
          Text("This page updates automatically after you finish on GitHub.")
            .font(.caption).foregroundStyle(.secondary)
        }
      } else if !model.account.cliInstalled {
        Section("Set up GitHub") {
          Text("Cinderdeck uses GitHub CLI to securely manage your connection. Install it once, then sign in here using your browser.")
            .font(.callout).foregroundStyle(.secondary)
          HStack {
            Button("Get GitHub CLI") { PROpenURL.open("https://cli.github.com") }.buttonStyle(.borderedProminent)
            Button("Check again") { Task { await model.refresh() } }.disabled(model.checking)
          }
        }
      } else {
        Section("Account") {
          if model.account.managedByEnvironment {
            Label("Managed by your environment", systemImage: "terminal").font(.headline)
            Text("An environment token controls the account used by GitHub CLI. Update that connection in your shell configuration to change accounts.")
              .font(.callout).foregroundStyle(.secondary)
          } else {
            HStack {
              VStack(alignment: .leading, spacing: 5) {
                Text(model.account.login == nil ? "Sign in with your browser" : "GitHub account").font(.headline)
                Text(model.account.login == nil ? "Authorize on GitHub. No password or token to paste into Cinderdeck." : "You can connect a different GitHub account at any time.")
                  .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
              }
              Spacer(minLength: 12)
              Button(model.account.login == nil ? "Sign in with GitHub" : "Use another account") { model.signIn() }
                .buttonStyle(.borderedProminent).disabled(model.checking).accessibilityIdentifier("github.signIn")
            }
          }
          HStack {
            Button("Check connection") { Task { await model.refresh() } }.disabled(model.checking)
              .accessibilityIdentifier("github.checkConnection")
            Spacer()
            if model.account.login != nil {
              Button("Open pull requests") { PullRequestsWindowController.shared.show() }.buttonStyle(.bordered)
                .accessibilityIdentifier("github.openPullRequests")
            }
          }
        }
      }

      if let message = model.error ?? model.account.message {
        Section { Label(message, systemImage: "exclamationmark.triangle").font(.callout).foregroundStyle(.orange).textSelection(.enabled) }
      }
      if let notice = model.notice {
        Section { Text(notice).font(.callout).textSelection(.enabled) }
      }

      Section("Organizations") {
        Text("Your organizations appear automatically in the pull request workspace. Choose an organization from the dropdown to browse its repositories.")
          .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      }

      Section("Advanced") {
        DisclosureGroup("Use a different GitHub server", isExpanded: $showsServerSettings) {
          VStack(alignment: .leading, spacing: 10) {
            Text("Only change this if your account uses a separate GitHub server. Organizations on your current server are discovered automatically.")
              .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack {
              TextField("github.com or github.company.com", text: $hostname)
                .textFieldStyle(.roundedBorder).accessibilityLabel("GitHub hostname")
                .accessibilityIdentifier("github.hostname")
              Button("Use server") { Task { await model.useHost(hostname); hostname = model.account.hostname } }
                .disabled(model.checking || model.signingIn || hostname == model.account.hostname)
            }
          }.padding(.top, 8)
        }.accessibilityIdentifier("github.serverSettings")
      }.disabled(model.signingIn)

      Section("About this connection") {
        Text("Cinderdeck uses the active GitHub CLI account on this Mac. Signing in here also updates that account for other tools that use GitHub CLI.")
          .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        Text("GitHub CLI handles authentication and credential storage. Cinderdeck never receives your password and does not keep a separate copy of your token. Your Git protocol and SSH keys are left as configured.")
          .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      }
    }
    .formStyle(.grouped)
    .task {
      hostname = model.account.hostname
      showsServerSettings = hostname != "github.com"
      await model.refresh()
    }
  }
}
