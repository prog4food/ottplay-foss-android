import AuthenticationServices
import Capacitor
import Foundation
import Network
import Security
import UIKit

// The player's selected language, not the system locale, owns these app dialogs.
struct AccessMediaLabels {
    private static let defaults = [
        "title": "Source access",
        "empty": "Sign-in opens when you load a protected playlist.",
        "signIn": "Sign in: %1",
        "signOut": "Sign out of all sources",
        "close": "Close",
        "ok": "OK",
        "invalid": "Invalid protected source configuration",
        "login": "Sign in to the protected source again",
        "cancelled": "Source sign-in was cancelled",
        "unavailable": "Protected source is unavailable",
        "busy": "Another source sign-in is already open",
    ]
    private let values: [String: String]
    init(_ values: [String: String] = [:]) {
        self.values = values.filter { Self.defaults[$0.key] != nil &&
            !$0.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.value.utf16.count <= 512 }
    }
    subscript(_ key: String) -> String { values[key] ?? Self.defaults[key] ?? "" }
    func error(_ error: Error) -> String {
        switch error as? AccessMediaFailure ?? .unavailable {
        case .invalid: return self["invalid"]
        case .login: return self["login"]
        case .cancelled: return self["cancelled"]
        case .unavailable: return self["unavailable"]
        case .busy: return self["busy"]
        }
    }
}

private struct SavedAccessMedia: Codable {
    let config: AccessMediaConfig
    var session: AccessMediaSession?
}

private struct AccessMediaDiscovery {
    let config: AccessMediaConfig?
    let retryAfter: TimeInterval
}

private struct AccessMediaAuthentication {
    let id: UUID
    let loginID: UUID
    let session: ASWebAuthenticationSession
    let continuation: CheckedContinuation<URL, Error>
}

@MainActor
private final class AccessMediaLogin {
    let id = UUID()
    var task: Task<Void, Never>?
    var waiters: [UUID: (continuation: CheckedContinuation<AccessMediaSession, Error>, cancellation: AccessMediaWaiterCancellation)] = [:]
    var hasLiveWaiter: Bool { waiters.values.contains { !$0.cancellation.isCancelled } }
}

// Cancellation handlers run on any executor. Publish cancellation before
// scheduling MainActor cleanup so a simultaneously completed exchange cannot
// save credentials on behalf of a consumer that has already stopped.
private final class AccessMediaWaiterCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    var isCancelled: Bool {
        lock.lock(); defer { lock.unlock() }
        return cancelled
    }
    func cancel() {
        lock.lock(); cancelled = true; lock.unlock()
    }
}

// A callback caller may stop while shared discovery is still finishing. Settle
// its callback once at cancellation/deadline, and let Task cancellation retire
// its own login waiter or transport without disturbing other consumers.
private final class AccessMediaRequest: @unchecked Sendable {
    private let lock = NSLock()
    private var completion: ((Data?, URLResponse?, Error?) -> Void)?
    private var task: Task<Void, Never>?
    private var deadline: Task<Void, Never>?
    private var timedOut = false

    init(_ completion: @escaping (Data?, URLResponse?, Error?) -> Void) { self.completion = completion }

    func start(_ task: Task<Void, Never>, timeout: TimeInterval) {
        let timeout = timeout.isFinite ? min(max(timeout, 0.001), 86400) : 15
        lock.lock()
        guard completion != nil else { lock.unlock(); task.cancel(); return }
        self.task = task
        deadline = Task {
            do { try await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000)) }
            catch { return }
            self.timeout()
        }
        lock.unlock()
    }

    private func timeout() {
        lock.lock()
        guard completion != nil else { lock.unlock(); return }
        timedOut = true
        let task = self.task
        lock.unlock()
        task?.cancel()
    }

    func finish(_ data: Data? = nil, _ response: URLResponse? = nil, _ error: Error? = nil) {
        lock.lock()
        let completion = self.completion
        let deadline = self.deadline
        let error = timedOut ? URLError(.timedOut) : error
        self.completion = nil; self.task = nil; self.deadline = nil
        lock.unlock()
        deadline?.cancel()
        completion?(data, response, error)
    }
}

@MainActor
final class AccessMedia: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let shared = AccessMedia()
    weak var presenter: UIViewController?
    private var entries: [String: SavedAccessMedia] = [:]
    private var missing: [String: Date] = [:]
    private var discovery: [String: Task<AccessMediaDiscovery, Error>] = [:]
    private var logins: [String: AccessMediaLogin] = [:]
    private var transfers: [UUID: Task<(Data, HTTPURLResponse), Error>] = [:]
    private var authentication: AccessMediaAuthentication?
    private var proxy: AccessMediaProxy?
    private var generation = 0
    private var networkEpoch = 0
    private var directDeniedUntil: [String: Date] = [:]
    private var directAllowedUntil: [String: Date] = [:]
    private let routeEpochKey = "play.ott.source-route-epoch"
    #if os(iOS)
    private let networkMonitor = NWPathMonitor()
    private var foregroundObserver: NSObjectProtocol?
    #endif
    private let keychainService = "play.ott.foss.source-access.v1"
    private let fetch: (URLRequest, Int) async throws -> (Data, HTTPURLResponse)
    private let probe: (URLRequest) async throws -> HTTPURLResponse
    private let now: () -> Date

    init(now: @escaping () -> Date = Date.init,
         fetch: @escaping (URLRequest, Int) async throws -> (Data, HTTPURLResponse) = {
        try await AccessMediaHTTP.fetch($0, limit: $1)
    }, probe: @escaping (URLRequest) async throws -> HTTPURLResponse = {
        try await AccessMediaHTTP.fetch($0, headersOnly: true).1
    }) {
        self.fetch = fetch; self.probe = probe; self.now = now
        super.init()
        #if os(iOS)
        networkMonitor.pathUpdateHandler = { [weak self] _ in
            Task { @MainActor in self?.networkChanged() }
        }
        networkMonitor.start(queue: DispatchQueue(label: "play.ott.access-network"))
        foregroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification,
            object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.networkChanged() }
            }
        #endif
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService, kSecAttrAccount as String: "sources",
            kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var result: CFTypeRef?
        if SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
           let data = result as? Data, let saved = try? JSONDecoder().decode([String: SavedAccessMedia].self, from: data) {
            for (origin, entry) in saved {
                if origin == entry.config.source_origin, let url = URL(string: origin),
                   (try? entry.config.validated(for: url)) != nil {
                    entries[origin] = entry
                }
            }
        }
    }

    deinit {
        #if os(iOS)
        networkMonitor.cancel()
        if let foregroundObserver { NotificationCenter.default.removeObserver(foregroundObserver) }
        #endif
    }

    // This is a routing hint, never an authorization grant. Every direct request
    // still passes the source server's IP policy. TTL also covers changes to the
    // public IP that do not change the interface reported by NWPathMonitor.
    func networkChanged() {
        networkEpoch += 1
        directDeniedUntil.removeAll()
        directAllowedUntil.removeAll()
    }

    private func taggedRoute(_ request: URLRequest) -> URLRequest {
        let tagged = (request as NSURLRequest).mutableCopy() as! NSMutableURLRequest
        URLProtocol.setProperty(networkEpoch, forKey: routeEpochKey, in: tagged)
        return tagged as URLRequest
    }

    private func currentRoute(_ request: URLRequest) -> Bool {
        (URLProtocol.property(forKey: routeEpochKey, in: request) as? Int) == networkEpoch
    }

    private func rememberDirect(_ request: URLRequest, config: AccessMediaConfig) {
        if currentRoute(request), request.url.flatMap(AccessMediaPolicy.origin) == config.source_origin,
           request.value(forHTTPHeaderField: "Cookie") == nil {
            directAllowedUntil[config.source_origin] = now().addingTimeInterval(20)
        }
    }

    func routed(_ request: URLRequest, config: AccessMediaConfig, replacing rejectedRequest: URLRequest? = nil,
                generation expectedGeneration: Int? = nil) async throws -> URLRequest {
        if let expectedGeneration, generation != expectedGeneration { throw AccessMediaFailure.cancelled }
        try Task.checkCancellation()
        guard let url = request.url, let source = config.map(url, toSource: true) else { throw AccessMediaFailure.invalid }
        if rejectedRequest == nil, let session = entries[config.source_origin]?.session,
           !session.valid(for: config), logins[config.source_origin] == nil {
            // Returning to a trusted network should not renew an expired login
            // just because the last source denial was less than 30 seconds ago.
            directDeniedUntil[config.source_origin] = nil
        }
        var rejectedCookie: String?
        if let rejectedRequest {
            let epoch = URLProtocol.property(forKey: routeEpochKey, in: rejectedRequest) as? Int
            if epoch == networkEpoch || epoch == nil {
                if rejectedRequest.url.flatMap(AccessMediaPolicy.origin) == config.source_origin &&
                    config.source_origin != config.media_origin {
                    directDeniedUntil[config.source_origin] = now().addingTimeInterval(30)
                    directAllowedUntil[config.source_origin] = nil
                } else { rejectedCookie = rejectedRequest.value(forHTTPHeaderField: "Cookie") }
            }
        }
        var result: URLRequest
        if config.source_origin != config.media_origin &&
            (directDeniedUntil[config.source_origin] ?? .distantPast) <= now() {
            result = AccessMediaPolicy.withoutCredentials(request)
            result.url = source
        } else {
            result = try await authorized(request, config: config, replacing: rejectedCookie,
                generation: expectedGeneration)
        }
        try Task.checkCancellation()
        return taggedRoute(result)
    }

    private func save() throws {
        let data = try JSONEncoder().encode(entries)
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService, kSecAttrAccount as String: "sources"]
        let attributes: [String: Any] = [kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            guard SecItemAdd(query.merging(attributes, uniquingKeysWith: { _, value in value }) as CFDictionary, nil) == errSecSuccess
            else { throw AccessMediaFailure.unavailable }
        } else if status != errSecSuccess { throw AccessMediaFailure.unavailable }
    }

    func configuration(for url: URL, discover: Bool) async throws -> AccessMediaConfig? {
        guard let origin = AccessMediaPolicy.origin(url) else { return nil }
        if let entry = entries[origin] { return entry.config }
        if let entry = entries.values.first(where: { $0.config.media_origin == origin }) { return entry.config }
        guard discover else { return nil }
        if let until = missing[origin], until > now() { return nil }
        if let pending = discovery[origin] { return try await pending.value.config }
        let pending = Task<AccessMediaDiscovery, Error> {
            var request = URLRequest(url: URL(string: origin + "/_ottplay/public/config")!)
            request.timeoutInterval = 5
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            guard let (data, response) = try? await self.fetch(request, 4096) else {
                return AccessMediaDiscovery(config: nil, retryAfter: 10)
            }
            guard response.statusCode == 200 else {
                return AccessMediaDiscovery(config: nil, retryAfter: [404, 410].contains(response.statusCode) ? 300 : 10)
            }
            guard let config = try? JSONDecoder().decode(AccessMediaConfig.self, from: data) else {
                return AccessMediaDiscovery(config: nil, retryAfter: 300)
            }
            _ = try config.validated(for: url)
            if config.source_origin != origin {
                // An unknown alias may name a source, but only that source may
                // authorize the mapping. Otherwise any playlist host could claim
                // a trusted source and replace its destination in our cache.
                var verification = URLRequest(url: URL(string: config.source_origin + "/_ottplay/public/config")!)
                verification.timeoutInterval = 5
                verification.setValue("application/json", forHTTPHeaderField: "Accept")
                let (proof, response) = try await self.fetch(verification, 4096)
                guard response.statusCode == 200,
                      (try? JSONDecoder().decode(AccessMediaConfig.self, from: proof)) == config else {
                    throw AccessMediaFailure.invalid
                }
            }
            return AccessMediaDiscovery(config: config, retryAfter: 0)
        }
        discovery[origin] = pending
        defer { discovery[origin] = nil }
        let result = try await pending.value
        if let config = result.config {
            if entries[config.source_origin]?.config != config {
                entries[config.source_origin] = SavedAccessMedia(config: config, session: nil)
            }
            return config
        }
        missing[origin] = now().addingTimeInterval(result.retryAfter)
        return nil
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        presenter?.view.window ?? ASPresentationAnchor()
    }

    private func finishAuthentication(_ id: UUID, result: Result<URL, Error>) {
        guard let active = authentication, active.id == id else { return }
        authentication = nil
        active.continuation.resume(with: result)
    }

    private func cancelAuthentication(loginID: UUID) {
        guard let active = authentication, active.loginID == loginID else { return }
        authentication = nil
        active.session.cancel()
        active.continuation.resume(throwing: AccessMediaFailure.cancelled)
    }

    private func finishLogin(_ source: String, id: UUID, result: Result<AccessMediaSession, Error>) {
        guard let login = logins[source], login.id == id else { return }
        logins[source] = nil
        let waiters = login.waiters.values
        login.waiters = [:]
        for waiter in waiters {
            waiter.continuation.resume(with: waiter.cancellation.isCancelled ? .failure(AccessMediaFailure.cancelled) : result)
        }
    }

    private func retireLogin(_ source: String, login: AccessMediaLogin) {
        guard logins[source]?.id == login.id else { return }
        logins[source] = nil
        login.task?.cancel()
        cancelAuthentication(loginID: login.id)
        for waiter in login.waiters.values { waiter.continuation.resume(throwing: AccessMediaFailure.cancelled) }
        login.waiters = [:]
    }

    private func cancelWaiter(_ source: String, id: UUID) {
        guard let login = logins[source], let waiter = login.waiters.removeValue(forKey: id) else { return }
        waiter.continuation.resume(throwing: AccessMediaFailure.cancelled)
        if !login.hasLiveWaiter {
            // Retire this operation before cancellation can schedule a late
            // callback. Other sources and other live consumers stay untouched.
            retireLogin(source, login: login)
        }
    }

    private func requireLogin(_ source: String, id: UUID, generation: Int) throws {
        guard self.generation == generation, let login = logins[source], login.id == id,
              login.hasLiveWaiter, !Task.isCancelled else {
            throw AccessMediaFailure.cancelled
        }
    }

    private func authenticate(_ config: AccessMediaConfig) async throws -> AccessMediaSession {
        let generation = self.generation
        try Task.checkCancellation()
        if let current = entries[config.source_origin]?.session, current.valid(for: config) { return current }
        let waiterID = UUID()
        let cancellation = AccessMediaWaiterCancellation()
        let session: AccessMediaSession = try await withTaskCancellationHandler(operation: {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                guard !Task.isCancelled else {
                    continuation.resume(throwing: AccessMediaFailure.cancelled)
                    return
                }
                if let login = self.logins[config.source_origin] {
                    if login.hasLiveWaiter {
                        login.waiters[waiterID] = (continuation, cancellation)
                        return
                    }
                    // A new consumer cannot revive a cancelled operation whose
                    // asynchronous cleanup has not reached the actor yet.
                    self.retireLogin(config.source_origin, login: login)
                }
                let login = AccessMediaLogin()
                login.waiters[waiterID] = (continuation, cancellation)
                self.logins[config.source_origin] = login
                let loginID = login.id
                login.task = Task {
                    do {
                        let result = try await self.performLogin(config, id: loginID, generation: generation)
                        self.finishLogin(config.source_origin, id: loginID, result: .success(result))
                    } catch {
                        self.finishLogin(config.source_origin, id: loginID, result: .failure(error))
                    }
                }
            }
        }, onCancel: {
            cancellation.cancel()
            Task { @MainActor in self.cancelWaiter(config.source_origin, id: waiterID) }
        })
        guard self.generation == generation else { throw AccessMediaFailure.cancelled }
        try Task.checkCancellation()
        return session
    }

    private func performLogin(_ config: AccessMediaConfig, id loginID: UUID, generation: Int) async throws -> AccessMediaSession {
        try requireLogin(config.source_origin, id: loginID, generation: generation)
        guard self.authentication == nil else { throw AccessMediaFailure.busy }
        guard UIApplication.shared.applicationState == .active, self.presenter?.view.window != nil else {
            throw AccessMediaFailure.login
        }
        let verifier = try AccessMediaPolicy.random()
        let state = try AccessMediaPolicy.random()
        var login = URLComponents(string: config.media_origin + config.authorize_path)!
        login.queryItems = [URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "code_challenge", value: AccessMediaPolicy.challenge(verifier)),
            URLQueryItem(name: "code_challenge_method", value: "S256")]
        let callback: URL = try await withCheckedThrowingContinuation { continuation in
            let id = UUID()
            let auth = ASWebAuthenticationSession(url: login.url!, callbackURLScheme: "ottplay-access") { url, error in
                Task { @MainActor in
                    let cancelled = (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin
                    self.finishAuthentication(id, result: url.map(Result.success) ??
                        .failure(cancelled ? AccessMediaFailure.cancelled : AccessMediaFailure.login))
                }
            }
            auth.presentationContextProvider = self
            auth.prefersEphemeralWebBrowserSession = false
            self.authentication = AccessMediaAuthentication(id: id, loginID: loginID, session: auth, continuation: continuation)
            if !auth.start() {
                self.finishAuthentication(id, result: .failure(AccessMediaFailure.login))
            }
        }
        try requireLogin(config.source_origin, id: loginID, generation: generation)
        let code = try AccessMediaPolicy.callbackCode(callback, state: state)
        var exchange = URLRequest(url: URL(string: config.media_origin + config.exchange_path)!)
        exchange.httpMethod = "POST"; exchange.timeoutInterval = 15
        exchange.setValue("application/json", forHTTPHeaderField: "Content-Type")
        exchange.httpBody = try JSONSerialization.data(withJSONObject: ["code": code, "verifier": verifier])
        let (data, response) = try await self.fetch(exchange, 20000)
        try requireLogin(config.source_origin, id: loginID, generation: generation)
        guard response.statusCode == 200, let result = try? JSONDecoder().decode(AccessMediaSession.self, from: data),
              result.valid(for: config) else { throw AccessMediaFailure.login }
        self.entries[config.source_origin] = SavedAccessMedia(config: config, session: result)
        do { try self.save() } catch {
            self.entries[config.source_origin]?.session = nil
            throw error
        }
        return result
    }

    func authorized(_ request: URLRequest, config: AccessMediaConfig, replacing rejectedCookie: String? = nil,
                    generation expectedGeneration: Int? = nil) async throws -> URLRequest {
        if let expectedGeneration, generation != expectedGeneration { throw AccessMediaFailure.cancelled }
        try Task.checkCancellation()
        guard let url = request.url, let target = config.map(url) else { throw AccessMediaFailure.invalid }
        if let rejectedCookie, let current = entries[config.source_origin]?.session,
           rejectedCookie == "CF_Authorization=\(current.token)" { entries[config.source_origin]?.session = nil }
        let session = try await authenticate(config)
        var result = AccessMediaPolicy.withoutCredentials(request)
        result.url = target
        result.setValue("CF_Authorization=\(session.token)", forHTTPHeaderField: "Cookie")
        return result
    }

    func preparedURL(_ url: URL) async throws -> URL {
        try Task.checkCancellation()
        let generation = self.generation
        guard let config = try await configuration(for: url, discover: true) else { return url }
        guard self.generation == generation else { throw AccessMediaFailure.cancelled }
        try Task.checkCancellation()
        var request = URLRequest(url: url)
        request.timeoutInterval = 8
        for attempt in 0...2 {
            let route = try await routed(request, config: config, generation: generation)
            if route.value(forHTTPHeaderField: "Cookie") != nil { break }
            if (directAllowedUntil[config.source_origin] ?? .distantPast) > now() { break }
            let (_, response) = try await fetchProtected(route, generation: generation, headersOnly: true)
            guard self.generation == generation else { throw AccessMediaFailure.cancelled }
            try Task.checkCancellation()
            if !currentRoute(route) {
                if attempt < 2 { continue }
                throw AccessMediaFailure.unavailable
            }
            if AccessMediaPolicy.requiresAccess(response) {
                _ = try await routed(request, config: config, replacing: route, generation: generation)
            } else {
                guard (200..<300).contains(response.statusCode), !AccessMediaPolicy.isHTML(response) else {
                    throw AccessMediaFailure.unavailable
                }
                rememberDirect(route, config: config)
            }
            break
        }
        guard self.generation == generation else { throw AccessMediaFailure.cancelled }
        try Task.checkCancellation()
        if proxy == nil { proxy = try AccessMediaProxy() }
        let local = try await proxy!.url(for: url, config: config)
        guard self.generation == generation else { throw AccessMediaFailure.cancelled }
        return local
    }

    func signOut() throws {
        generation += 1
        networkChanged()
        let pending = Array(logins.values)
        logins.removeAll()
        for login in pending {
            login.task?.cancel()
            cancelAuthentication(loginID: login.id)
            for waiter in login.waiters.values { waiter.continuation.resume(throwing: AccessMediaFailure.cancelled) }
            login.waiters = [:]
        }
        for transfer in transfers.values { transfer.cancel() }
        transfers.removeAll()
        proxy?.stop(); proxy = nil
        for origin in entries.keys { entries[origin]?.session = nil }
        try save()
    }

    private func fetchProtected(_ request: URLRequest, generation: Int, headersOnly: Bool = false) async throws -> (Data, HTTPURLResponse) {
        guard self.generation == generation else { throw AccessMediaFailure.cancelled }
        try Task.checkCancellation()
        let id = UUID()
        let pending = Task {
            if headersOnly { return (Data(), try await self.probe(request)) }
            return try await self.fetch(request, 64 * 1024 * 1024)
        }
        transfers[id] = pending
        defer { transfers[id] = nil }
        return try await withTaskCancellationHandler(operation: {
            let result = try await pending.value
            try Task.checkCancellation()
            return result
        }, onCancel: { pending.cancel() })
    }

    // No credentials or ephemeral loopback URLs are written to JS settings/backups.
    @discardableResult
    nonisolated static func fetch(_ request: URLRequest, discoverOnFailure: Bool = true,
                                 authenticationAllowance: TimeInterval = 300,
                                 completion: @escaping (Data?, URLResponse?, Error?) -> Void) -> Task<Void, Never> {
        let operation = AccessMediaRequest(completion)
        let task = Task {
            await withTaskCancellationHandler(operation: {
                do {
                    try Task.checkCancellation()
                    guard let url = request.url else { throw AccessMediaFailure.invalid }
                    let generation = await shared.generation
                    var config = try await shared.configuration(for: url, discover: false)
                    var rejectedRequest: URLRequest?
                    if config == nil {
                        let publicRequest = await shared.taggedRoute(request)
                        let (data, response) = try await AccessMediaPublicHTTP.fetch(publicRequest)
                        let http = response as? HTTPURLResponse
                        let challenge = http.map(AccessMediaPolicy.requiresAccess) == true ||
                            response.url?.host?.hasSuffix(".cloudflareaccess.com") == true
                        if discoverOnFailure && request.httpMethod == "GET" && challenge {
                            config = try await shared.configuration(for: url, discover: true)
                            if AccessMediaPolicy.origin(url) == config?.source_origin {
                                rejectedRequest = publicRequest
                            }
                        }
                        if config == nil { try Task.checkCancellation(); operation.finish(data, response); return }
                    }
                    guard let config else { throw AccessMediaFailure.invalid }
                    var authenticationFailures = 0
                    // One source denial, then one rejected Access token renewal.
                    // Every response is checked; network changes cannot create a retry loop.
                    for attempt in 0...2 {
                        guard await shared.generation == generation else { throw AccessMediaFailure.cancelled }
                        let authorized = try await shared.routed(request, config: config, replacing: rejectedRequest, generation: generation)
                        let (data, response) = try await shared.fetchProtected(authorized, generation: generation)
                        guard await shared.generation == generation else { throw AccessMediaFailure.cancelled }
                        if AccessMediaPolicy.requiresAccess(response) {
                            if authorized.value(forHTTPHeaderField: "Cookie") != nil { authenticationFailures += 1 }
                            if attempt < 2 && authenticationFailures < 2 { rejectedRequest = authorized; continue }
                            throw AccessMediaFailure.login
                        }
                        guard !(200..<300).contains(response.statusCode) || !AccessMediaPolicy.isHTML(response) else {
                            throw AccessMediaFailure.unavailable
                        }
                        if (200..<300).contains(response.statusCode) {
                            await shared.rememberDirect(authorized, config: config)
                        }
                        // Access credentials must never cross the Capacitor bridge as response headers.
                        var fields: [String: String] = [:]
                        for (name, value) in response.allHeaderFields {
                            let key = String(describing: name)
                            if key.lowercased() != "set-cookie" && !key.lowercased().hasPrefix("cf-access-") {
                                fields[key] = String(describing: value)
                            }
                        }
                        operation.finish(data, HTTPURLResponse(url: url, statusCode: response.statusCode,
                            httpVersion: "HTTP/1.1", headerFields: fields))
                        return
                    }
                } catch {
                    // Transport error descriptions can contain signed media URLs.
                    operation.finish(nil, nil, error is CancellationError ? AccessMediaFailure.cancelled :
                        (error as? URLError)?.code == .timedOut ? URLError(.timedOut) :
                        error as? AccessMediaFailure ?? AccessMediaFailure.unavailable)
                }
            }, onCancel: { operation.finish(nil, nil, AccessMediaFailure.cancelled) })
        }
        // Network timeouts stay on URLRequest. Browser/email recovery gets a
        // separate bounded allowance; an owning caller can still cancel at once.
        let allowance = authenticationAllowance.isFinite ? min(max(authenticationAllowance, 0), 300) : 300
        operation.start(task, timeout: request.timeoutInterval + allowance)
        return task
    }

    func manage(labels: AccessMediaLabels = AccessMediaLabels()) {
        guard let presenter else { return }
        let alert = UIAlertController(title: labels["title"],
            message: entries.isEmpty ? labels["empty"] : nil, preferredStyle: .alert)
        for origin in entries.keys.sorted() {
            let host = URL(string: origin)?.host ?? origin
            alert.addAction(UIAlertAction(title: labels["signIn"].replacingOccurrences(of: "%1", with: host), style: .default) { _ in
                Task { @MainActor in
                    guard let config = self.entries[origin]?.config else { return }
                    self.entries[origin]?.session = nil
                    do { _ = try await self.authenticate(config) }
                    catch { self.showError(error, labels: labels) }
                }
            })
        }
        if !entries.isEmpty {
            alert.addAction(UIAlertAction(title: labels["signOut"], style: .destructive) { _ in
                do { try self.signOut() } catch { self.showError(error, labels: labels) }
            })
        }
        alert.addAction(UIAlertAction(title: labels["close"], style: .cancel))
        presenter.present(alert, animated: true)
    }

    private func showError(_ error: Error, labels: AccessMediaLabels) {
        let alert = UIAlertController(title: labels["title"], message: labels.error(error), preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: labels["ok"], style: .default))
        presenter?.present(alert, animated: true)
    }
}

@objc(AccessMediaPlugin)
public class AccessMediaPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AccessMediaPlugin"
    public let jsName = "AccessMedia"
    @MainActor private var preparations: [String: (id: UUID, task: Task<Void, Never>)] = [:]
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "prepare", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelPrepare", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "manage", returnType: CAPPluginReturnPromise),
    ]
    public override func load() {
        Task { @MainActor in AccessMedia.shared.presenter = self.bridge?.viewController }
    }
    @objc func prepare(_ call: CAPPluginCall) {
        guard let value = call.getString("url"), let url = URL(string: value) else { call.reject("Invalid source URL"); return }
        let requestID = call.getString("requestId")
        guard call.options["requestId"] == nil || Self.validRequestID(requestID) else {
            call.reject("Invalid source request"); return
        }
        // Preserve native bridge call order even when cancellation arrives before
        // the MainActor work task begins. IDs own requests, never global sessions.
        DispatchQueue.main.async {
            if let requestID, self.preparations[requestID] != nil {
                call.reject("Source request is already pending"); return
            }
            let ownership = UUID()
            let task = Task { @MainActor in
                defer {
                    if let requestID, self.preparations[requestID]?.id == ownership {
                        self.preparations[requestID] = nil
                    }
                }
                do {
                    let prepared = try await AccessMedia.shared.preparedURL(url)
                    try Task.checkCancellation()
                    call.resolve(["url": prepared.absoluteString])
                } catch {
                    call.reject(error is CancellationError ? AccessMediaFailure.cancelled.rawValue :
                        (error as? AccessMediaFailure)?.rawValue ?? AccessMediaFailure.unavailable.rawValue)
                }
            }
            if let requestID { self.preparations[requestID] = (ownership, task) }
        }
    }
    private static func validRequestID(_ value: String?) -> Bool {
        guard let value, !value.isEmpty, value.utf8.count <= 128 else { return false }
        return value.utf8.allSatisfy {
            (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95
        }
    }
    @objc func cancelPrepare(_ call: CAPPluginCall) {
        guard let requestID = call.getString("requestId"), Self.validRequestID(requestID) else {
            call.reject("Invalid source request"); return
        }
        DispatchQueue.main.async {
            let pending = self.preparations.removeValue(forKey: requestID)
            pending?.task.cancel()
            call.resolve(["cancelled": pending != nil])
        }
    }
    @objc func manage(_ call: CAPPluginCall) {
        let labels = AccessMediaLabels(call.getObject("labels") as? [String: String] ?? [:])
        Task { @MainActor in AccessMedia.shared.manage(labels: labels); call.resolve() }
    }
}
