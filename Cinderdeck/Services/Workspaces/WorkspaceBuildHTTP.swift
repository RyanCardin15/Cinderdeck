import Foundation

/// Only a configured relative path on an already-owned service's loopback port.
nonisolated final class WorkspaceBuildHTTP: NSObject, URLSessionDataDelegate, @unchecked Sendable {
  private let maximum: Int
  private let lock = NSLock()
  private var continuation: CheckedContinuation<Data, Error>?
  private var body = Data()
  private var accepted = false
  private var session: URLSession?
  init(maximum: Int) { self.maximum = maximum }
  static func validPath(_ path: String) -> Bool {
    path.hasPrefix("/") && !path.hasPrefix("//") && path.utf8.count <= 512 && !path.contains("..") && path.utf8.allSatisfy {
      (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || [45,46,47,95,126].contains($0)
    }
  }
  static func fetch(port: Int, path: String, maximum: Int) async throws -> Data {
    guard (1...65535).contains(port), validPath(path), (1...WorkspaceBuildArtifactFiles.maximumBytes).contains(maximum),
      let url = URL(string: "http://127.0.0.1:\(port)\(path)") else { throw StackControlError.invalid("Only declared service loopback paths can be observed") }
    let reader = WorkspaceBuildHTTP(maximum: maximum)
    return try await withCheckedThrowingContinuation { continuation in
      reader.continuation = continuation
      let configuration = URLSessionConfiguration.ephemeral
      configuration.connectionProxyDictionary = [:]
      configuration.urlCache = nil; configuration.httpShouldSetCookies = false
      configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
      configuration.timeoutIntervalForRequest = 3; configuration.timeoutIntervalForResource = 5
      let queue = OperationQueue(); queue.maxConcurrentOperationCount = 1
      let session = URLSession(configuration: configuration, delegate: reader, delegateQueue: queue)
      reader.session = session
      var request = URLRequest(url: url); request.timeoutInterval = 3
      request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
      request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
      session.dataTask(with: request).resume()
    }
  }
  private func finish(_ result: Result<Data, Error>) {
    lock.lock(); let pending = continuation; continuation = nil; let session = session; self.session = nil; lock.unlock()
    session?.invalidateAndCancel(); pending?.resume(with: result)
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void) {
    guard let response = response as? HTTPURLResponse, response.statusCode == 200, response.expectedContentLength <= Int64(maximum),
      response.value(forHTTPHeaderField: "Content-Encoding").map({ $0 == "identity" }) ?? true else {
      completionHandler(.cancel); finish(.failure(StackControlError(code: "stamp_unavailable", message: "Declared build endpoint refused, redirected, compressed, or exceeded its budget"))); return
    }
    accepted = true; completionHandler(.allow)
  }
  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    guard body.count + data.count <= maximum else { finish(.failure(StackControlError(code: "stamp_too_large", message: "Declared endpoint exceeded its bounded read"))); return }
    body.append(data)
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    if let error { finish(.failure(error)) }
    else if accepted { finish(.success(body)) }
    else { finish(.failure(StackControlError(code: "stamp_unavailable", message: "Declared endpoint did not return a bounded success"))) }
  }
}
