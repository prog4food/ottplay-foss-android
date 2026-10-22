import Foundation
import CryptoKit
import Security

enum AccessMediaFailure: String, Error, LocalizedError {
    case invalid = "Invalid protected source configuration"
    case login = "Sign in to the protected source again"
    case cancelled = "Source sign-in was cancelled"
    case unavailable = "Protected source is unavailable"
    case busy = "Another source sign-in is already open"
    var errorDescription: String? { rawValue }
}

struct AccessMediaConfig: Codable, Equatable {
    let version: Int
    let source_origin: String
    let media_origin: String
    let authorize_path: String
    let exchange_path: String
    let callback: String

    func validated(for source: URL) throws -> AccessMediaConfig {
        guard version == 1, [source_origin, media_origin].contains(AccessMediaPolicy.origin(source) ?? ""),
              let original = URL(string: source_origin), AccessMediaPolicy.origin(original) == source_origin,
              original.path.isEmpty, original.query == nil, original.fragment == nil,
              let media = URL(string: media_origin), AccessMediaPolicy.origin(media) == media_origin,
              media.scheme == "https", media.user == nil, media.password == nil,
              media.port == nil || media.port == 443, media.path.isEmpty,
              media.query == nil, media.fragment == nil,
              authorize_path == "/_ottplay/authorize",
              exchange_path == "/_ottplay/public/exchange",
              callback == "ottplay-access://callback" else { throw AccessMediaFailure.invalid }
        return self
    }

    func map(_ url: URL, toSource: Bool = false) -> URL? {
        guard let origin = AccessMediaPolicy.origin(url),
              origin == source_origin || origin == media_origin,
              let media = URLComponents(string: toSource ? source_origin : media_origin),
              var target = URLComponents(url: url, resolvingAgainstBaseURL: false),
              target.user == nil, target.password == nil else { return nil }
        target.scheme = media.scheme; target.host = media.host; target.port = media.port
        target.fragment = nil
        return target.url
    }
}

struct AccessMediaSession: Codable {
    let token: String
    let expires_at: TimeInterval
    let media_origin: String
    func valid(for config: AccessMediaConfig, now: TimeInterval = Date().timeIntervalSince1970) -> Bool {
        media_origin == config.media_origin && expires_at > now + 30 && expires_at <= now + 86400 &&
            token.utf8.count <= 16384 && token.range(of: "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$", options: .regularExpression) != nil
    }
}

enum AccessMediaPolicy {
    static func requiresAccess(_ response: HTTPURLResponse) -> Bool {
        [301, 302, 303, 307, 308, 401, 403].contains(response.statusCode) ||
            response.value(forHTTPHeaderField: "cf-mitigated")?.lowercased() == "challenge"
    }

    static func isHTML(_ response: HTTPURLResponse) -> Bool {
        ["text/html", "application/xhtml+xml"].contains(response.mimeType?.lowercased() ?? "")
    }

    static func withoutCredentials(_ request: URLRequest) -> URLRequest {
        var result = request
        for name in result.allHTTPHeaderFields?.keys.map({ $0 }) ?? [] {
            let key = name.lowercased()
            if ["cookie", "cookie2", "authorization", "proxy-authorization", "host"].contains(key) || key.hasPrefix("cf-") {
                result.setValue(nil, forHTTPHeaderField: name)
            }
        }
        result.httpShouldHandleCookies = false
        return result
    }

    static func origin(_ url: URL) -> String? {
        guard url.scheme?.lowercased() == "https", let host = url.host?.lowercased(), !host.isEmpty,
              url.user == nil, url.password == nil else { return nil }
        let authority = host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
        return "https://\(authority)" + (url.port.map { $0 == 443 ? "" : ":\($0)" } ?? "")
    }
    static func base64(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    static func decode(_ string: String) -> Data? {
        let value = string.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        return Data(base64Encoded: value + String(repeating: "=", count: (4 - value.count % 4) % 4))
    }
    static func random() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw AccessMediaFailure.unavailable
        }
        return base64(Data(bytes))
    }
    static func challenge(_ verifier: String) -> String { base64(Data(SHA256.hash(data: Data(verifier.utf8)))) }
    static func callbackCode(_ url: URL, state: String) throws -> String {
        guard url.scheme == "ottplay-access", url.host == "callback", url.path.isEmpty,
              url.user == nil, url.password == nil, url.port == nil, url.fragment == nil,
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              items.filter({ $0.name == "state" }).count == 1,
              items.first(where: { $0.name == "state" })?.value == state,
              items.filter({ $0.name == "code" }).count == 1,
              let code = items.first(where: { $0.name == "code" })?.value,
              code.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else {
            throw AccessMediaFailure.invalid
        }
        return code
    }

    static func rewriteManifest(_ text: String, base: URL, maxBytes: Int = 8 * 1024 * 1024,
                                rewrite: (URL) -> URL?) throws -> String {
        func replace(_ value: String) -> String {
            guard let url = URL(string: value, relativeTo: base)?.absoluteURL else { return value }
            // The rewritten manifest lives on HTTP loopback. External network-
            // path references must retain the upstream scheme, without gaining
            // access to the credentialed proxy.
            return (rewrite(url) ?? url).absoluteString
        }
        let expression = try! NSRegularExpression(pattern: "(?:^|[, :])(?:URI|SERVER-URI)=\"([^\"]*)\"")
        guard maxBytes >= 0 else { throw AccessMediaFailure.unavailable }
        var result = "", count = 0
        func append<T: StringProtocol>(_ value: T) throws {
            let size = value.utf8.count
            guard size <= maxBytes - count else { throw AccessMediaFailure.unavailable }
            result.append(contentsOf: value)
            count += size
        }
        func appendLine(_ line: String) throws {
            if line.hasPrefix("#") {
                var cursor = line.startIndex
                var failure: Error?
                expression.enumerateMatches(in: line, range: NSRange(line.startIndex..., in: line)) { match, _, stop in
                    guard let match, let range = Range(match.range(at: 1), in: line) else { return }
                    do {
                        try append(line[cursor..<range.lowerBound])
                        try append(replace(String(line[range])))
                        cursor = range.upperBound
                    } catch {
                        failure = error
                        stop.pointee = true
                    }
                }
                if let failure { throw failure }
                try append(line[cursor...])
            } else {
                let value = line.trimmingCharacters(in: .whitespacesAndNewlines)
                try append(value.isEmpty ? line : replace(value))
            }
        }
        // Short relative URIs can expand many times into capability URLs. Bound
        // the rewritten representation independently of the 2 MiB input limit,
        // while allowing long VOD playlists to grow beyond that input budget.
        // Scan bytes to preserve the existing CRLF/final-newline handling,
        // without keeping an array of every original and rewritten line alive.
        let bytes = text.utf8
        var start = bytes.startIndex
        while start < bytes.endIndex {
            let end = bytes[start...].firstIndex(of: 10) ?? bytes.endIndex
            let hasNewline = end != bytes.endIndex
            try appendLine(String(decoding: bytes[start..<end], as: UTF8.self))
            if hasNewline { try append("\n") }
            if !hasNewline { break }
            start = bytes.index(after: end)
        }
        return result
    }
}

// Used only for protected requests and discovery. Never follows redirects out of
// the trusted HTTPS origin, or accepts cookies from the app's JavaScript runtime.
final class AccessMediaHTTP: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    // Cancellation runs on the caller's executor; all response/buffer callbacks
    // run on URLSession's serial delegate queue. Only lifecycle state is shared.
    private let lock = NSLock()
    private var session: URLSession?
    private var task: URLSessionTask?
    private var cancelled = false
    private var buffer = Data()
    private var response: HTTPURLResponse?
    private let request: URLRequest
    private let limit: Int
    private let headersOnly: Bool
    private var stoppedAtHeaders = false
    private let sessionConfiguration: () -> URLSessionConfiguration
    private var completion: ((Data?, URLResponse?, Error?) -> Void)?
    private var failure: Error?

    private init(_ request: URLRequest, limit: Int, headersOnly: Bool, sessionConfiguration: @escaping () -> URLSessionConfiguration) {
        self.request = request; self.limit = limit; self.headersOnly = headersOnly; self.sessionConfiguration = sessionConfiguration
    }
    private func start(completion: @escaping (Data?, URLResponse?, Error?) -> Void) {
        let config = sessionConfiguration()
        config.httpCookieStorage = nil; config.httpShouldSetCookies = false; config.urlCache = nil
        config.urlCredentialStorage = nil
        lock.lock()
        guard !cancelled else { lock.unlock(); completion(nil, nil, CancellationError()); return }
        self.completion = completion
        let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        self.session = session
        let task = session.dataTask(with: request)
        self.task = task
        lock.unlock()
        task.resume()
    }
    private func cancel() {
        lock.lock(); cancelled = true
        let task = self.task
        lock.unlock()
        task?.cancel()
    }
    static func fetch(_ request: URLRequest, limit: Int = 64 * 1024 * 1024,
                      headersOnly: Bool = false,
                      sessionConfiguration: @escaping () -> URLSessionConfiguration = { .ephemeral }) async throws -> (Data, HTTPURLResponse) {
        guard let url = request.url, AccessMediaPolicy.origin(url) != nil else { throw AccessMediaFailure.invalid }
        let operation = AccessMediaHTTP(request, limit: limit, headersOnly: headersOnly, sessionConfiguration: sessionConfiguration)
        return try await withTaskCancellationHandler(operation: {
            try Task.checkCancellation()
            let result: (Data, HTTPURLResponse) = try await withCheckedThrowingContinuation { continuation in
                operation.start { data, response, error in
                    if let error { continuation.resume(throwing: error) }
                    else if let data, let response = response as? HTTPURLResponse { continuation.resume(returning: (data, response)) }
                    else { continuation.resume(throwing: AccessMediaFailure.unavailable) }
                }
            }
            try Task.checkCancellation()
            return result
        }, onCancel: {
            operation.cancel()
        })
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        guard let from = self.request.url, let origin = AccessMediaPolicy.origin(from), let to = request.url,
              origin == AccessMediaPolicy.origin(to) else { completionHandler(nil); return }
        var next = request
        next.setValue(self.request.value(forHTTPHeaderField: "Cookie"), forHTTPHeaderField: "Cookie")
        completionHandler(next)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        completionHandler(challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust
            ? .performDefaultHandling : .cancelAuthenticationChallenge, nil)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        self.response = response as? HTTPURLResponse
        // Probe the real GET policy without downloading a manifest twice or
        // buffering an unbounded live stream. Caller cancellation still wins.
        if headersOnly { stoppedAtHeaders = true; completionHandler(.cancel) }
        else if response.expectedContentLength > Int64(limit) { failure = AccessMediaFailure.unavailable; completionHandler(.cancel) }
        else { completionHandler(.allow) }
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard !headersOnly else { return }
        guard buffer.count + data.count <= limit else { failure = AccessMediaFailure.unavailable; dataTask.cancel(); return }
        buffer.append(data)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock()
        let completion = self.completion
        let cancelled = self.cancelled
        self.completion = nil; self.session = nil; self.task = nil
        lock.unlock()
        session.invalidateAndCancel()
        completion?(buffer, response, cancelled ? CancellationError() : failure ?? (stoppedAtHeaders ? nil : error))
    }
}

// Public requests retain URLSession.shared's connection pool, cookies,
// credentials and default redirect handling. A task delegate bounds delivered
// bytes without creating or invalidating a session shared by other consumers.
final class AccessMediaPublicHTTP: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private let limit: Int
    private var task: URLSessionDataTask?
    private var completion: CheckedContinuation<(Data, URLResponse), Error>?
    private var cancelled = false
    private var buffer = Data()
    private var response: URLResponse?

    private init(limit: Int) { self.limit = limit }

    private func start(_ request: URLRequest, completion: CheckedContinuation<(Data, URLResponse), Error>) {
        lock.lock()
        guard !cancelled else { lock.unlock(); completion.resume(throwing: CancellationError()); return }
        self.completion = completion
        let task = URLSession.shared.dataTask(with: request)
        task.delegate = self
        self.task = task
        lock.unlock()
        task.resume()
    }

    private func cancel() {
        lock.lock(); cancelled = true; lock.unlock()
        finish(CancellationError(), cancelTask: true)
    }

    private func finish(_ error: Error?, cancelTask: Bool = false) {
        lock.lock()
        guard let completion else { lock.unlock(); return }
        let task = self.task
        let error = cancelled ? CancellationError() : error
        let result: Result<(Data, URLResponse), Error>
        if let error { result = .failure(error) }
        else if let response { result = .success((buffer, response)) }
        else { result = .failure(URLError(.badServerResponse)) }
        self.completion = nil; self.task = nil; self.response = nil; buffer = Data()
        lock.unlock()
        if cancelTask { task?.cancel() }
        completion.resume(with: result)
    }

    static func fetch(_ request: URLRequest, limit: Int = 64 * 1024 * 1024) async throws -> (Data, URLResponse) {
        guard limit >= 0 else { throw URLError(.dataLengthExceedsMaximum) }
        let operation = AccessMediaPublicHTTP(limit: limit)
        return try await withTaskCancellationHandler(operation: {
            try Task.checkCancellation()
            let result: (Data, URLResponse) = try await withCheckedThrowingContinuation { continuation in
                operation.start(request, completion: continuation)
            }
            try Task.checkCancellation()
            return result
        }, onCancel: { operation.cancel() })
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        lock.lock()
        guard completion != nil else { lock.unlock(); completionHandler(.cancel); return }
        guard response.expectedContentLength <= Int64(limit) else {
            lock.unlock()
            finish(URLError(.dataLengthExceedsMaximum), cancelTask: true)
            completionHandler(.cancel)
            return
        }
        self.response = response
        lock.unlock()
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock()
        guard completion != nil else { lock.unlock(); return }
        guard data.count <= limit - buffer.count else {
            lock.unlock()
            finish(URLError(.dataLengthExceedsMaximum), cancelTask: true)
            return
        }
        buffer.append(data)
        lock.unlock()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        finish(error)
    }
}
