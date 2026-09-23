import Combine
import Foundation

extension Notification.Name {
  static let githubAccountChanged = Notification.Name("githubAccountChanged")
}

@MainActor
final class GitHubAccountViewModel: ObservableObject {
  static let shared = GitHubAccountViewModel()
  @Published private(set) var account = GitHubAccountSnapshot()
  @Published private(set) var checking = false
  @Published private(set) var signingIn = false
  @Published private(set) var progress = GitHubSignInProgress()
  @Published var error: String?
  @Published private(set) var notice: String?
  private var service: GitHubAccountServing
  private let defaults: UserDefaults
  private var signInTask: Task<Void, Never>?
  private var generation = UUID()

  init(service: GitHubAccountServing? = nil, defaults: UserDefaults = .standard) {
    self.service = service ?? GitHubAccountService()
    self.defaults = defaults
    account.hostname = self.service.hostname
  }

  func useHost(_ input: String) async {
    guard !checking, !signingIn else { return }
    guard let host = GitHubHost.normalized(input) else {
      error = "Enter a hostname such as github.com or github.company.com, without https:// or a path."
      return
    }
    guard service.hostname != host else { return }
    generation = UUID()
    service.hostname = host
    defaults.set(host, forKey: GitHubHost.preferenceKey)
    account = .init(hostname: host)
    error = nil; notice = nil
    NotificationCenter.default.post(name: .githubAccountChanged, object: nil, userInfo: ["hostname": host, "force": true])
    await refresh()
  }

  func refresh() async {
    guard !checking, !signingIn else { return }
    let generation = self.generation
    checking = true
    let previous = account.login
    let snapshot = await service.status()
    guard generation == self.generation else { return }
    account = snapshot
    checking = false
    if previous != snapshot.login { NotificationCenter.default.post(name: .githubAccountChanged, object: nil, userInfo: ["login": snapshot.login ?? "", "hostname": snapshot.hostname]) }
  }

  func signIn() {
    guard !signingIn, !checking else { return }
    signingIn = true
    progress = .init(); error = nil; notice = nil
    let generation = UUID(); self.generation = generation
    signInTask = Task {
      do {
        let warning = try await service.signIn { [weak self] value in
          guard self?.generation == generation else { return }
          self?.progress = value
        }
        let snapshot = await service.status()
        guard self.generation == generation, !Task.isCancelled else { return }
        account = snapshot
        signingIn = false; progress = .init()
        if let login = snapshot.login {
          notice = warning ?? "Signed in as \(login). Your pull requests are ready."
          NotificationCenter.default.post(name: .githubAccountChanged, object: nil, userInfo: ["login": login, "hostname": snapshot.hostname, "force": true])
        } else { error = "GitHub authorization finished, but the connection could not be verified. Check your connection and refresh." }
      } catch {
        guard self.generation == generation, !Task.isCancelled else { return }
        signingIn = false; progress = .init()
        self.error = error.localizedDescription
      }
    }
  }

  func cancel() {
    generation = UUID()
    signInTask?.cancel()
    service.cancelSignIn()
    signingIn = false; progress = .init(); checking = false
    notice = "Sign-in cancelled."
  }
}
