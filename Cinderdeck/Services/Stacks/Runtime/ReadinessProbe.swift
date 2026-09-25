import Foundation

nonisolated enum ReadinessProbe {
  static func check(_ readiness: StackReadiness, startedAt: Date, log: LogBuffer?) async -> Bool {
    switch readiness {
    case .alive: return Date().timeIntervalSince(startedAt) >= 2
    case .port(let port): return await PortInspector.isListening(port)
    case .http(var url):
      // Lane hostnames (<lane>.<workspace>.localhost) are loopback; not every resolver knows that.
      if url.host?.hasSuffix(".localhost") == true, var components = URLComponents(url: url, resolvingAgainstBaseURL: false) {
        components.host = "127.0.0.1"
        url = components.url ?? url
      }
      var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 2)
      request.httpMethod = "GET"
      do {
        let (_, response) = try await URLSession.shared.data(for: request)
        return (response as? HTTPURLResponse).map { $0.statusCode < 500 } ?? false
      } catch { return false }
    case .log(let pattern): return await log?.matches(pattern) ?? false
    }
  }
}
