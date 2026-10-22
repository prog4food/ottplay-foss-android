#!/usr/bin/env python3
"""Exercise the production iOS auth state machine with deterministic OS fixtures.

Only platform APIs and HTTP are replaced; the session, discovery, Keychain,
ASWebAuthenticationSession and Capacitor request orchestration runs unchanged.
No real browser, Keychain or network is used.
"""
import subprocess
import tempfile
from pathlib import Path
from native_standby_work_cases import swift_work_source

ROOT = Path(__file__).resolve().parents[1]
SWIFT = r'''
import Foundation
import CoreFoundation

public protocol CAPBridgedPlugin {}
public struct CAPPluginMethod {
    init(name: String, returnType: String) {}
}
public let CAPPluginReturnPromise = "promise"
class Bridge { var viewController: UIViewController? }
public class CAPPlugin: NSObject {
    var bridge: Bridge?
    public func load() {}
}
public class CAPPluginCall: NSObject {
    let options: [String: Any]
    var result: [String: Any]?
    var error: String?
    var errorCode: String?
    var settlements = 0
    init(_ options: [String: Any]) { self.options = options }
    func getString(_ key: String) -> String? { options[key] as? String }
    func getDouble(_ key: String) -> Double? { options[key] as? Double }
    func getBool(_ key: String) -> Bool? { options[key] as? Bool }
    func getObject(_ key: String) -> [String: Any]? { options[key] as? [String: Any] }
    func resolve(_ result: [String: Any] = [:]) { self.result = result; settlements += 1 }
    func reject(_ error: String, _ code: String? = nil) { self.error = error; errorCode = code; settlements += 1 }
}
final class AccessMediaHTTP {
    static var requests = 0, exchangeRequests = 0, probes = 0
    static var probeHandler: (@MainActor (URLRequest) async throws -> HTTPURLResponse)?
    static var handler: (@MainActor (URLRequest, Int) async throws -> (Data, HTTPURLResponse))?
    static func fetch(_ request: URLRequest, limit: Int = 64 * 1024 * 1024,
                      headersOnly: Bool = false) async throws -> (Data, HTTPURLResponse) {
        if headersOnly {
            probes += 1
            assert(request.httpMethod == "GET", "The access probe must use the same method as playback")
            if let probeHandler { return (Data(), try await probeHandler(request)) }
            return (Data(), HTTPURLResponse(url: request.url!, statusCode: 403,
                httpVersion: "HTTP/1.1", headerFields: [:])!)
        }
        requests += 1
        if request.url?.path == "/_ottplay/public/exchange" { exchangeRequests += 1 }
        if let handler { return try await handler(request, limit) }
        if request.url?.host == "source.fixture.invalid" {
            return (Data(), HTTPURLResponse(url: request.url!, statusCode: 403,
                httpVersion: "HTTP/1.1", headerFields: [:])!)
        }
        throw AccessMediaFailure.unavailable
    }
}
final class AccessMediaPublicHTTP {
    static var handler: (@MainActor (URLRequest) async throws -> (Data, URLResponse))?
    static func fetch(_ request: URLRequest, limit: Int = 64 * 1024 * 1024) async throws -> (Data, URLResponse) {
        assert(limit == 64 * 1024 * 1024)
        guard let handler = Self.handler else { throw AccessMediaFailure.unavailable }
        return try await handler(request)
    }
}
struct Logger {
    init(subsystem: String, category: String) {}
    func debug(_ message: String) {}
}
func os_log(_ format: String, _ arguments: CVarArg...) {}
enum NativeSwopRequest { static func start(_ call: CAPPluginCall) {} }

let kSecClass = "class", kSecClassGenericPassword = "generic"
let kSecAttrService = "service", kSecAttrAccount = "account"
let kSecReturnData = "return", kSecMatchLimit = "limit", kSecMatchLimitOne = "one"
let kSecValueData = "data", kSecAttrAccessible = "accessible"
let kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly = "deviceOnlyAfterFirstUnlock"
let errSecSuccess: Int32 = 0, errSecItemNotFound: Int32 = -25300
enum Keychain {
    static var data: Data?
    static var writes = 0
}
func SecItemCopyMatching(_ query: CFDictionary, _ result: UnsafeMutablePointer<CFTypeRef?>) -> Int32 {
    guard let data = Keychain.data else { return errSecItemNotFound }
    result.pointee = data as CFTypeRef
    return errSecSuccess
}
func SecItemUpdate(_ query: CFDictionary, _ attributes: CFDictionary) -> Int32 {
    guard Keychain.data != nil else { return errSecItemNotFound }
    return store(attributes)
}
func SecItemAdd(_ query: CFDictionary, _ result: UnsafeMutablePointer<CFTypeRef?>?) -> Int32 { store(query) }
func store(_ attributes: CFDictionary) -> Int32 {
    let values = attributes as! [String: Any]
    assert(values[kSecAttrAccessible] as? String == kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly)
    Keychain.data = values[kSecValueData] as? Data
    Keychain.writes += 1
    return errSecSuccess
}

class UIWindow {}
class UIView { var window: UIWindow? = UIWindow() }
class UIViewController: NSObject {
    let view = UIView()
    var presented: UIViewController?
    func present(_ controller: UIViewController, animated: Bool) { presented = controller }
}
class UIAlertController: UIViewController {
    enum Style { case alert }
    var actions: [UIAlertAction] = []
    let title: String?
    let message: String?
    init(title: String?, message: String?, preferredStyle: Style) { self.title = title; self.message = message }
    func addAction(_ action: UIAlertAction) { actions.append(action) }
}
class UIAlertAction {
    enum Style: Equatable { case `default`, destructive, cancel }
    let style: Style
    let title: String
    let handler: ((UIAlertAction) -> Void)?
    init(title: String, style: Style, handler: ((UIAlertAction) -> Void)? = nil) { self.title = title; self.style = style; self.handler = handler }
    func invoke() { handler?(self) }
}
class UIApplication {
    static let shared = UIApplication()
    enum State { case active, background }
    var applicationState = State.active
}
typealias ASPresentationAnchor = UIWindow
protocol ASWebAuthenticationPresentationContextProviding: AnyObject {
    @MainActor func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor
}
struct ASWebAuthenticationSessionError: Error {
    enum Code { case canceledLogin }
    let code: Code
}
class ASWebAuthenticationSession {
    static var opened: [ASWebAuthenticationSession] = []
    static var startSucceeds = true
    let url: URL
    let callback: (URL?, Error?) -> Void
    weak var presentationContextProvider: ASWebAuthenticationPresentationContextProviding?
    var prefersEphemeralWebBrowserSession = true
    var cancelled = false
    init(url: URL, callbackURLScheme: String?, completionHandler: @escaping (URL?, Error?) -> Void) {
        assert(callbackURLScheme == "ottplay-access")
        self.url = url; callback = completionHandler
    }
    func start() -> Bool {
        assert(!prefersEphemeralWebBrowserSession)
        Self.opened.append(self)
        return Self.startSucceeds
    }
    // Deliberately never invokes completion: the app must settle its own waiters.
    func cancel() { cancelled = true }
    func succeed() {
        let state = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!
            .first(where: { $0.name == "state" })!.value!
        callback(URL(string: "ottplay-access://callback?state=\(state)&code=\(String(repeating: "a", count: 43))")!, nil)
    }
}
final class AccessMediaProxy {
    init() throws {}
    func stop() {}
    func url(for url: URL, config: AccessMediaConfig) async throws -> URL { url }
}

@MainActor final class Fixture {
    let source = URL(string: "https://source.fixture.invalid/list.m3u8")!
    let config = AccessMediaConfig(version: 1, source_origin: "https://source.fixture.invalid",
        media_origin: "https://media.fixture.invalid", authorize_path: "/_ottplay/authorize",
        exchange_path: "/_ottplay/public/exchange", callback: "ottplay-access://callback")
    var time = Date()
    var discoveries = 0, exchanges = 0
    var discoveryStatus = 200
    var probeStatus = 200, probes = 0
    var probeHeaders: [String: String] = [:]
    var holdProbe = false
    var probeGate: CheckedContinuation<Void, Never>?
    var holdDiscovery = false, holdExchange = false
    var discoveryGate: CheckedContinuation<Void, Never>?
    var exchangeGate: CheckedContinuation<Void, Never>?
    var beforeExchangeReturns: (() -> Void)?
    let presenter = UIViewController()
    func makeAccess() -> AccessMedia {
        let access = AccessMedia(now: { self.time }, fetch: { request, limit in
            try await self.fetch(request, limit: limit)
        }, probe: { request in
            self.probes += 1
            assert(request.url?.host == "source.fixture.invalid" && request.httpMethod == "GET")
            assert(request.value(forHTTPHeaderField: "Cookie") == nil && !request.httpShouldHandleCookies)
            if self.holdProbe { await withCheckedContinuation { self.probeGate = $0 } }
            return HTTPURLResponse(url: request.url!, statusCode: self.probeStatus,
                httpVersion: "HTTP/1.1", headerFields: self.probeHeaders)!
        })
        access.presenter = presenter
        return access
    }
    func fetch(_ request: URLRequest, limit: Int) async throws -> (Data, HTTPURLResponse) {
        let url = request.url!
        if url.path == "/_ottplay/public/config" {
            discoveries += 1
            assert(request.timeoutInterval == 5 && limit == 4096)
            if holdDiscovery { await withCheckedContinuation { discoveryGate = $0 } }
            return (try JSONEncoder().encode(config), HTTPURLResponse(url: url, statusCode: discoveryStatus,
                httpVersion: "HTTP/1.1", headerFields: [:])!)
        }
        assert(url.host == "media.fixture.invalid" && url.path == "/_ottplay/public/exchange")
        assert(request.httpMethod == "POST" && limit == 20000)
        let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: String]
        assert(body["verifier"]!.count == 43 && body["code"]!.count == 43)
        exchanges += 1
        let exchange = exchanges
        if holdExchange { await withCheckedContinuation { exchangeGate = $0 } }
        let data = try JSONEncoder().encode(AccessMediaSession(token: "fixture.session\(exchange).signature",
            expires_at: Date().timeIntervalSince1970 + 3600, media_origin: config.media_origin))
        beforeExchangeReturns?()
        return (data, HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [:])!)
    }
}

@MainActor func until(_ condition: () -> Bool) async {
    let deadline = Date().addingTimeInterval(3)
    while !condition() && Date() < deadline { try! await Task.sleep(nanoseconds: 1_000_000) }
    assert(condition(), "Fixture did not reach the expected state")
}
@MainActor func reset() {
    Keychain.data = nil; Keychain.writes = 0
    ASWebAuthenticationSession.opened = []; ASWebAuthenticationSession.startSucceeds = true
}
@MainActor func failure<T>(_ task: Task<T, Error>, _ expected: AccessMediaFailure? = nil) async {
    do { _ = try await task.value; fatalError("Expected failure") }
    catch { if let expected { assert(error as? AccessMediaFailure == expected, "Unexpected failure: \(error)") } }
}
@MainActor func fetchResult(_ request: URLRequest) async -> (Data?, HTTPURLResponse?, Error?) {
    await withCheckedContinuation { continuation in
        AccessMedia.fetch(request) { data, response, error in
            continuation.resume(returning: (data, response as? HTTPURLResponse, error))
        }
    }
}
var finished = false
Task { @MainActor in
    do {
        reset()
        let fixture = Fixture(), access = fixture.makeAccess()
        assert(AccessMediaPolicy.origin(URL(string: "HTTPS://SOURCE.fixture.invalid/list.m3u8")!) == fixture.config.source_origin)
        assert(fixture.config.map(URL(string: "HTTPS://SOURCE.fixture.invalid/list.m3u8")!)?.host == "media.fixture.invalid")
        let discoveryTasks = (0..<20).map { _ in Task { try await access.configuration(for: fixture.source, discover: true) } }
        for task in discoveryTasks { let result = try await task.value; assert(result == fixture.config) }
        assert(fixture.discoveries == 1, "Concurrent discovery must issue one HTTP request")
        var request = URLRequest(url: fixture.source)
        request.setValue("foreign=secret", forHTTPHeaderField: "Cookie")
        request.setValue("forged", forHTTPHeaderField: "CF-Access-Jwt-Assertion")
        request.setValue("evil.invalid", forHTTPHeaderField: "Host")
        request.setValue("bytes=1-2", forHTTPHeaderField: "Range")
        let tasks = (0..<20).map { _ in Task { try await access.authorized(request, config: fixture.config) } }
        await until { ASWebAuthenticationSession.opened.count == 1 }
        ASWebAuthenticationSession.opened[0].succeed()
        for task in tasks {
            let result = try await task.value
            assert(result.url?.host == "media.fixture.invalid")
            assert(result.value(forHTTPHeaderField: "Cookie") == "CF_Authorization=fixture.session1.signature")
            assert(result.value(forHTTPHeaderField: "CF-Access-Jwt-Assertion") == nil)
            assert(result.value(forHTTPHeaderField: "Host") == nil)
            assert(result.value(forHTTPHeaderField: "Range") == "bytes=1-2" && !result.httpShouldHandleCookies)
        }
        assert(fixture.exchanges == 1 && Keychain.writes == 1)
        let restored = fixture.makeAccess()
        let restoredConfig = try await restored.configuration(for: fixture.source, discover: true)
        assert(restoredConfig == fixture.config)
        _ = try await restored.authorized(request, config: fixture.config)
        assert(fixture.discoveries == 1 && fixture.exchanges == 1 && ASWebAuthenticationSession.opened.count == 1,
            "Cold launch with a valid saved session must avoid discovery/login/exchange")

        var signedAlias = request
        signedAlias.url = URL(string: fixture.config.media_origin + "/list.m3u8?signature=a%2Fb%2B%3D&&=preserved")!
        signedAlias.httpMethod = "HEAD"
        let direct = try await restored.routed(signedAlias, config: fixture.config)
        assert(direct.url?.absoluteString == fixture.config.source_origin + "/list.m3u8?signature=a%2Fb%2B%3D&&=preserved" &&
            direct.httpMethod == "HEAD" && direct.value(forHTTPHeaderField: "Range") == "bytes=1-2")
        assert(direct.value(forHTTPHeaderField: "Cookie") == nil &&
            direct.value(forHTTPHeaderField: "CF-Access-Jwt-Assertion") == nil &&
            direct.value(forHTTPHeaderField: "Host") == nil && !direct.httpShouldHandleCookies,
            "A saved mobile session must never leak credentials into the direct trusted-source request")
        assert(fixture.exchanges == 1 && ASWebAuthenticationSession.opened.count == 1)
        assert(URLProtocol.property(forKey: "play.ott.source-route-epoch", in: direct) is Int,
            "The routing epoch survives NSMutableURLRequest-to-URLRequest bridging")
        let fallback = try await restored.routed(signedAlias, config: fixture.config, replacing: direct)
        assert(fallback.url?.host == "media.fixture.invalid" &&
            fallback.value(forHTTPHeaderField: "Cookie") == "CF_Authorization=fixture.session1.signature")
        let cachedFallback = try await restored.routed(request, config: fixture.config)
        assert(cachedFallback.url?.host == "media.fixture.invalid", "A denied source is briefly remembered")
        fixture.time.addTimeInterval(29)
        let beforeExpiry = try await restored.routed(request, config: fixture.config)
        assert(beforeExpiry.url?.host == "media.fixture.invalid")
        fixture.time.addTimeInterval(2)
        let afterExpiry = try await restored.routed(request, config: fixture.config)
        assert(afterExpiry.url?.host == "source.fixture.invalid", "Direct access is retried after the 30-second denial TTL")
        _ = try await restored.routed(request, config: fixture.config, replacing: afterExpiry)
        restored.networkChanged()
        let afterNetwork = try await restored.routed(request, config: fixture.config)
        assert(afterNetwork.url?.host == "source.fixture.invalid", "A network change retries the trusted source immediately")
        let staleDenial = try await restored.routed(request, config: fixture.config, replacing: afterExpiry)
        assert(staleDenial.url?.host == "source.fixture.invalid",
            "A denial from the previous network cannot poison the current trusted-source decision")
        assert(fixture.exchanges == 1 && ASWebAuthenticationSession.opened.count == 1,
            "Route changes preserve and reuse the saved mobile session")

        let renewals = (0..<20).map { _ in Task {
            try await access.authorized(request, config: fixture.config,
                replacing: "CF_Authorization=fixture.session1.signature")
        } }
        await until { ASWebAuthenticationSession.opened.count == 2 }
        ASWebAuthenticationSession.opened[1].succeed()
        for task in renewals {
            let result = try await task.value
            assert(result.value(forHTTPHeaderField: "Cookie") == "CF_Authorization=fixture.session2.signature")
        }
        assert(fixture.exchanges == 2, "Concurrent rejected requests must refresh only once")
        let invalid = Task { try await access.authorized(URLRequest(url: URL(string: "https://other.invalid/a")!), config: fixture.config) }
        await failure(invalid, .invalid)

        reset()
        let soleFixture = Fixture(), soleAccess = soleFixture.makeAccess()
        var soleSettled = false
        let sole = Task {
            defer { soleSettled = true }
            return try await soleAccess.authorized(URLRequest(url: soleFixture.source), config: soleFixture.config)
        }
        await until { ASWebAuthenticationSession.opened.count == 1 }
        let cancelledBrowser = ASWebAuthenticationSession.opened[0]
        sole.cancel()
        await until { soleSettled }
        await failure(sole, .cancelled)
        assert(cancelledBrowser.cancelled && soleFixture.exchanges == 0)
        let afterSole = Task { try await soleAccess.authorized(URLRequest(url: soleFixture.source), config: soleFixture.config) }
        await until { ASWebAuthenticationSession.opened.count == 2 }
        cancelledBrowser.succeed()
        for _ in 0..<20 { await Task.yield() }
        assert(soleFixture.exchanges == 0, "A cancelled operation's callback must never exchange its code")
        ASWebAuthenticationSession.opened[1].succeed()
        _ = try await afterSole.value
        assert(soleFixture.exchanges == 1)

        reset()
        let sharedFixture = Fixture(), sharedAccess = sharedFixture.makeAccess()
        var retiredSettled = false, survivorStarted = false
        let retired = Task {
            defer { retiredSettled = true }
            return try await sharedAccess.authorized(URLRequest(url: sharedFixture.source), config: sharedFixture.config)
        }
        await until { ASWebAuthenticationSession.opened.count == 1 }
        let survivor = Task {
            survivorStarted = true
            return try await sharedAccess.authorized(URLRequest(url: sharedFixture.source), config: sharedFixture.config)
        }
        await until { survivorStarted }
        retired.cancel()
        await until { retiredSettled }
        await failure(retired, .cancelled)
        assert(!ASWebAuthenticationSession.opened[0].cancelled && ASWebAuthenticationSession.opened.count == 1,
            "Cancelling one waiter must preserve another waiter's shared browser")
        ASWebAuthenticationSession.opened[0].succeed()
        _ = try await survivor.value
        assert(sharedFixture.exchanges == 1)

        reset()
        let retiredExchangeFixture = Fixture(), retiredExchangeAccess = retiredExchangeFixture.makeAccess()
        retiredExchangeFixture.holdExchange = true
        var exchangeSettled = false
        let retiredExchange = Task {
            defer { exchangeSettled = true }
            return try await retiredExchangeAccess.authorized(URLRequest(url: retiredExchangeFixture.source), config: retiredExchangeFixture.config)
        }
        await until { ASWebAuthenticationSession.opened.count == 1 }
        ASWebAuthenticationSession.opened[0].succeed()
        await until { retiredExchangeFixture.exchangeGate != nil }
        retiredExchange.cancel()
        await until { exchangeSettled }
        await failure(retiredExchange, .cancelled)
        assert(Keychain.writes == 0, "The last cancelled waiter settles without waiting for the network")
        let newExchange = Task { try await retiredExchangeAccess.authorized(URLRequest(url: retiredExchangeFixture.source), config: retiredExchangeFixture.config) }
        await until { ASWebAuthenticationSession.opened.count == 2 }
        retiredExchangeFixture.exchangeGate!.resume()
        for _ in 0..<20 { await Task.yield() }
        assert(Keychain.writes == 0, "A late cancelled exchange cannot save credentials or retire a newer login")
        retiredExchangeFixture.holdExchange = false
        ASWebAuthenticationSession.opened[1].succeed()
        _ = try await newExchange.value
        assert(Keychain.writes == 1 && retiredExchangeFixture.exchanges == 2)

        reset()
        let simultaneousFixture = Fixture(), simultaneousAccess = simultaneousFixture.makeAccess()
        var simultaneous: Task<URLRequest, Error>!
        simultaneousFixture.beforeExchangeReturns = { simultaneous.cancel() }
        simultaneous = Task { try await simultaneousAccess.authorized(URLRequest(url: simultaneousFixture.source), config: simultaneousFixture.config) }
        await until { ASWebAuthenticationSession.opened.count == 1 }
        ASWebAuthenticationSession.opened[0].succeed()
        await failure(simultaneous, .cancelled)
        assert(Keychain.writes == 0,
            "Cancellation immediately before exchange returns must prevent credential persistence before actor cleanup runs")

        reset()
        let survivingFixture = Fixture(), survivingAccess = survivingFixture.makeAccess()
        var cancelledAtExchange: Task<URLRequest, Error>!
        survivingFixture.beforeExchangeReturns = { cancelledAtExchange.cancel() }
        cancelledAtExchange = Task { try await survivingAccess.authorized(URLRequest(url: survivingFixture.source), config: survivingFixture.config) }
        await until { ASWebAuthenticationSession.opened.count == 1 }
        let liveAtExchange = Task { try await survivingAccess.authorized(URLRequest(url: survivingFixture.source), config: survivingFixture.config) }
        for _ in 0..<20 { await Task.yield() }
        ASWebAuthenticationSession.opened[0].succeed()
        await failure(cancelledAtExchange, .cancelled)
        _ = try await liveAtExchange.value
        assert(Keychain.writes == 1 && survivingFixture.exchanges == 1,
            "An exchange with a remaining live consumer still completes and persists once")

        reset()
        let cancelFixture = Fixture(), cancelAccess = cancelFixture.makeAccess()
        let old = Task { try await cancelAccess.authorized(URLRequest(url: cancelFixture.source), config: cancelFixture.config) }
        await until { ASWebAuthenticationSession.opened.count == 1 }
        let oldBrowser = ASWebAuthenticationSession.opened[0]
        try cancelAccess.signOut()
        assert(oldBrowser.cancelled)
        let fresh = Task { try await cancelAccess.authorized(URLRequest(url: cancelFixture.source), config: cancelFixture.config) }
        await until { ASWebAuthenticationSession.opened.count == 2 }
        await failure(old, .cancelled)
        oldBrowser.succeed() // A delayed browser callback must not exchange or clear the new login.
        for _ in 0..<20 { await Task.yield() }
        assert(cancelFixture.exchanges == 0)
        let duplicate = Task { try await cancelAccess.authorized(URLRequest(url: cancelFixture.source), config: cancelFixture.config) }
        ASWebAuthenticationSession.opened[1].succeed()
        _ = try await fresh.value; _ = try await duplicate.value
        assert(cancelFixture.exchanges == 1 && ASWebAuthenticationSession.opened.count == 2)

        reset()
        let exchangeFixture = Fixture(), exchangeAccess = exchangeFixture.makeAccess()
        exchangeFixture.holdExchange = true
        let stale = Task { try await exchangeAccess.authorized(URLRequest(url: exchangeFixture.source), config: exchangeFixture.config) }
        await until { ASWebAuthenticationSession.opened.count == 1 }
        ASWebAuthenticationSession.opened[0].succeed()
        await until { exchangeFixture.exchangeGate != nil }
        try exchangeAccess.signOut()
        exchangeFixture.exchangeGate!.resume()
        await failure(stale, .cancelled)
        assert(!String(data: Keychain.data!, encoding: .utf8)!.contains("fixture.session"),
            "An exchange finishing after logout must not restore credentials")

        reset()
        let startFixture = Fixture(), startAccess = startFixture.makeAccess()
        ASWebAuthenticationSession.startSucceeds = false
        let failedStart = Task { try await startAccess.authorized(URLRequest(url: startFixture.source), config: startFixture.config) }
        await failure(failedStart, .login)
        ASWebAuthenticationSession.opened[0].succeed() // Must not resume the continuation twice.
        ASWebAuthenticationSession.startSucceeds = true
        let afterFailure = Task { try await startAccess.authorized(URLRequest(url: startFixture.source), config: startFixture.config) }
        await until { ASWebAuthenticationSession.opened.count == 2 }
        ASWebAuthenticationSession.opened[1].succeed()
        _ = try await afterFailure.value
        assert(startFixture.exchanges == 1)

        reset()
        let retryFixture = Fixture(), retryAccess = retryFixture.makeAccess()
        retryFixture.discoveryStatus = 503
        _ = try await retryAccess.configuration(for: retryFixture.source, discover: true)
        _ = try await retryAccess.configuration(for: retryFixture.source, discover: true)
        assert(retryFixture.discoveries == 1)
        retryFixture.time.addTimeInterval(11); retryFixture.discoveryStatus = 200
        let recovered = try await retryAccess.configuration(for: retryFixture.source, discover: true)
        assert(recovered == retryFixture.config)
        assert(retryFixture.discoveries == 2, "Transient outages must recover after ten seconds, not five minutes")
        reset()
        let absentFixture = Fixture(), absentAccess = absentFixture.makeAccess()
        absentFixture.discoveryStatus = 404
        _ = try await absentAccess.configuration(for: absentFixture.source, discover: true)
        absentFixture.time.addTimeInterval(11)
        _ = try await absentAccess.configuration(for: absentFixture.source, discover: true)
        assert(absentFixture.discoveries == 1, "Unsupported sources retain the five-minute negative cache")

        reset()
        let trustFixture = Fixture()
        let untrusted = AccessMediaConfig(version: 1, source_origin: trustFixture.config.source_origin,
            media_origin: "https://attacker.fixture.invalid", authorize_path: "/_ottplay/authorize",
            exchange_path: "/_ottplay/public/exchange", callback: "ottplay-access://callback")
        var discoveryHosts: [String] = []
        let trusted = AccessMedia(fetch: { request, _ in
            discoveryHosts.append(request.url!.host!)
            let config = request.url!.host == "attacker.fixture.invalid" ? untrusted : trustFixture.config
            return (try JSONEncoder().encode(config), HTTPURLResponse(url: request.url!, statusCode: 200,
                httpVersion: "HTTP/1.1", headerFields: [:])!)
        })
        let poisoned = Task { try await trusted.configuration(for: URL(string: untrusted.media_origin + "/a")!, discover: true) }
        await failure(poisoned, .invalid)
        let absentClaim = try await trusted.configuration(for: trustFixture.source, discover: false)
        assert(absentClaim == nil, "An untrusted alias must not insert its claimed source")
        let canonical = try await trusted.configuration(for: trustFixture.source, discover: true)
        assert(canonical == trustFixture.config)
        let beforeAlias = discoveryHosts.count
        let knownAlias = try await trusted.configuration(for: URL(string: trustFixture.config.media_origin + "/a")!, discover: true)
        assert(knownAlias == trustFixture.config && discoveryHosts.count == beforeAlias,
            "A previously validated alias must avoid all discovery requests")

        reset()
        let aliasFixture = Fixture(), aliasAccess = aliasFixture.makeAccess()
        let firstAlias = try await aliasAccess.configuration(for: URL(string: aliasFixture.config.media_origin + "/a")!, discover: true)
        assert(firstAlias == aliasFixture.config && aliasFixture.discoveries == 2,
            "An unknown alias requires one confirmation from its authoritative source")

        reset()
        let discoveryFixture = Fixture(), discoveryAccess = discoveryFixture.makeAccess()
        discoveryFixture.holdDiscovery = true
        let preparing = Task { try await discoveryAccess.preparedURL(discoveryFixture.source) }
        await until { discoveryFixture.discoveryGate != nil }
        try discoveryAccess.signOut()
        discoveryFixture.discoveryGate!.resume()
        await failure(preparing, .cancelled)
        assert(ASWebAuthenticationSession.opened.isEmpty,
            "A discovery finishing after logout must not reopen the browser")

        reset()
        let probeFixture = Fixture(), probeAccess = probeFixture.makeAccess()
        let preparedDirect = try await probeAccess.preparedURL(probeFixture.source)
        assert(preparedDirect == probeFixture.source && probeFixture.probes == 1 &&
            probeFixture.exchanges == 0 && ASWebAuthenticationSession.opened.isEmpty,
            "A GET headers-only success prepares playback without browser or exchange")
        _ = try await probeAccess.preparedURL(URL(string: probeFixture.config.source_origin + "/other.m3u8")!)
        assert(probeFixture.probes == 1, "Recent direct success skips redundant preparation probes")
        probeFixture.time.addTimeInterval(21)
        _ = try await probeAccess.preparedURL(probeFixture.source)
        assert(probeFixture.probes == 2, "The direct-success preparation hint expires after 20 seconds")
        probeAccess.networkChanged()
        probeFixture.probeStatus = 403
        let deniedPreparation = Task { try await probeAccess.preparedURL(probeFixture.source) }
        await until { ASWebAuthenticationSession.opened.count == 1 }
        assert(probeFixture.probes == 3, "A network change probes again before preparing a native player")
        deniedPreparation.cancel()
        await failure(deniedPreparation, .cancelled)
        assert(ASWebAuthenticationSession.opened.last!.cancelled && probeFixture.exchanges == 0,
            "Stopping preparation cancels its pending browser before native playback starts")

        for logout in [false, true] {
            reset()
            let pendingProbeFixture = Fixture(), pendingProbeAccess = pendingProbeFixture.makeAccess()
            pendingProbeFixture.holdProbe = true; pendingProbeFixture.probeStatus = 403
            let pendingProbe = Task { try await pendingProbeAccess.preparedURL(pendingProbeFixture.source) }
            await until { pendingProbeFixture.probeGate != nil }
            if logout { try pendingProbeAccess.signOut() } else { pendingProbe.cancel() }
            pendingProbeFixture.probeGate!.resume()
            do { _ = try await pendingProbe.value; fatalError("Stopped probe completed") }
            catch {
                assert(error is CancellationError || error as? AccessMediaFailure == .cancelled,
                    "Stopped preparation must preserve cancellation, not become an origin error")
            }
            assert(ASWebAuthenticationSession.opened.isEmpty && pendingProbeFixture.exchanges == 0,
                "A cancelled or logged-out GET probe cannot open authentication after its late denial")
        }
        reset()
        let invalidProbeFixture = Fixture(), invalidProbeAccess = invalidProbeFixture.makeAccess()
        invalidProbeFixture.probeHeaders = ["Content-Type": "text/html"]
        await failure(Task { try await invalidProbeAccess.preparedURL(invalidProbeFixture.source) }, .unavailable)
        assert(ASWebAuthenticationSession.opened.isEmpty, "Generic HTML at preparation cannot become native media or open login")

        reset()
        let expiredFixture = Fixture()
        let expiredConfig = try JSONSerialization.jsonObject(with: JSONEncoder().encode(expiredFixture.config))
        let expiredSession: [String: Any] = ["token": "fixture.expired.signature", "expires_at": Date().timeIntervalSince1970 - 1,
            "media_origin": expiredFixture.config.media_origin]
        Keychain.data = try JSONSerialization.data(withJSONObject: [expiredFixture.config.source_origin:
            ["config": expiredConfig, "session": expiredSession]])
        let expiredAccess = expiredFixture.makeAccess()
        let expiredDirect = try await expiredAccess.routed(URLRequest(url: expiredFixture.source), config: expiredFixture.config)
        let expiredFallback = Task {
            try await expiredAccess.routed(URLRequest(url: expiredFixture.source), config: expiredFixture.config, replacing: expiredDirect)
        }
        await until { ASWebAuthenticationSession.opened.count == 1 }
        expiredFallback.cancel()
        await failure(expiredFallback, .cancelled)
        let retryExpired = try await expiredAccess.routed(URLRequest(url: expiredFixture.source), config: expiredFixture.config)
        assert(retryExpired.url?.host == "source.fixture.invalid" && ASWebAuthenticationSession.opened.count == 1,
            "An expired saved token retries the source instead of opening login during a cached denial")

        reset()
        let bridgeFixture = Fixture()
        let configObject = try JSONSerialization.jsonObject(with: JSONEncoder().encode(bridgeFixture.config))
        Keychain.data = try JSONSerialization.data(withJSONObject: [bridgeFixture.config.source_origin: ["config": configObject]])
        AccessMedia.shared.presenter = bridgeFixture.presenter
        let plugin = AccessMediaPlugin()
        let first = CAPPluginCall(["url": bridgeFixture.source.absoluteString, "requestId": "first"])
        let second = CAPPluginCall(["url": bridgeFixture.source.absoluteString, "requestId": "second"])
        plugin.prepare(first); plugin.prepare(second)
        await until { ASWebAuthenticationSession.opened.count == 1 }
        let duplicateID = CAPPluginCall(["url": bridgeFixture.source.absoluteString, "requestId": "first"])
        plugin.prepare(duplicateID)
        await until { duplicateID.error != nil }
        assert(duplicateID.error == "Source request is already pending" && first.error == nil,
            "A duplicate ID must reject only the duplicate and preserve the original request")
        let cancelFirst = CAPPluginCall(["requestId": "first"])
        plugin.cancelPrepare(cancelFirst)
        await until { first.error != nil }
        assert(cancelFirst.result?["cancelled"] as? Bool == true && second.error == nil)
        assert(!ASWebAuthenticationSession.opened[0].cancelled)
        let unknown = CAPPluginCall(["requestId": "unknown"])
        plugin.cancelPrepare(unknown)
        await until { unknown.result != nil }
        assert(unknown.result?["cancelled"] as? Bool == false)
        let cancelSecond = CAPPluginCall(["requestId": "second"])
        plugin.cancelPrepare(cancelSecond)
        await until { second.error != nil }
        assert(ASWebAuthenticationSession.opened[0].cancelled)

        let immediate = CAPPluginCall(["url": bridgeFixture.source.absoluteString, "requestId": "immediate"])
        let cancelImmediate = CAPPluginCall(["requestId": "immediate"])
        plugin.prepare(immediate); plugin.cancelPrepare(cancelImmediate)
        await until { immediate.error != nil }
        assert(cancelImmediate.result?["cancelled"] as? Bool == true,
            "Cancellation queued before work starts must still see the registered request")

        let baseline = ASWebAuthenticationSession.opened.count
        let reuseOld = CAPPluginCall(["url": bridgeFixture.source.absoluteString, "requestId": "reuse"])
        plugin.prepare(reuseOld)
        await until { ASWebAuthenticationSession.opened.count == baseline + 1 }
        let reuseBrowser = ASWebAuthenticationSession.opened.last!
        let cancelReuse = CAPPluginCall(["requestId": "reuse"])
        let reuseNew = CAPPluginCall(["url": bridgeFixture.source.absoluteString, "requestId": "reuse"])
        plugin.cancelPrepare(cancelReuse); plugin.prepare(reuseNew)
        await until { reuseOld.error != nil }
        // The new waiter may retain a still-live shared login, or start a fresh
        // one after the old waiter was retired; both orderings are valid.
        if reuseBrowser.cancelled { reuseBrowser.succeed() }
        for _ in 0..<20 { await Task.yield() }
        let cancelNew = CAPPluginCall(["requestId": "reuse"])
        plugin.cancelPrepare(cancelNew)
        await until { reuseNew.error != nil }
        assert(cancelNew.result?["cancelled"] as? Bool == true,
            "An old task's completion must not erase a reused request ID")
        assert(AccessMediaHTTP.exchangeRequests == 0, "Cancelled bridge work must never reach the exchange network")

        let badID = CAPPluginCall(["url": bridgeFixture.source.absoluteString, "requestId": "../bad"])
        plugin.prepare(badID)
        assert(badID.error == "Invalid source request")
        let newlineID = CAPPluginCall(["url": bridgeFixture.source.absoluteString, "requestId": "bad\n"])
        plugin.prepare(newlineID)
        assert(newlineID.error == "Invalid source request")
        let nonStringID = CAPPluginCall(["url": bridgeFixture.source.absoluteString, "requestId": 42])
        plugin.prepare(nonStringID)
        assert(nonStringID.error == "Invalid source request")
        let legacyCount = ASWebAuthenticationSession.opened.count
        let legacy = CAPPluginCall(["url": bridgeFixture.source.absoluteString])
        plugin.prepare(legacy)
        await until { ASWebAuthenticationSession.opened.count == legacyCount + 1 }
        try AccessMedia.shared.signOut()
        await until { legacy.error != nil }

        let proxyPlugin = M3UProxyPlugin()
        let beforeProxyLogin = ASWebAuthenticationSession.opened.count
        let proxyFirst = CAPPluginCall(["url": "@" + bridgeFixture.source.absoluteString, "requestId": "proxy-first"])
        let proxySecond = CAPPluginCall(["url": bridgeFixture.source.absoluteString, "requestId": "proxy-second"])
        proxyPlugin.proxyFetch(proxyFirst); proxyPlugin.proxyFetch(proxySecond)
        await until { ASWebAuthenticationSession.opened.count == beforeProxyLogin + 1 }
        let proxyBrowser = ASWebAuthenticationSession.opened.last!
        let duplicateProxy = CAPPluginCall(["url": bridgeFixture.source.absoluteString, "requestId": "proxy-first"])
        proxyPlugin.proxyFetch(duplicateProxy)
        await until { duplicateProxy.error != nil }
        assert(duplicateProxy.error == "Proxy request is already pending" && proxyFirst.error == nil)
        let cancelProxyFirst = CAPPluginCall(["requestId": "proxy-first"])
        proxyPlugin.cancelProxyFetch(cancelProxyFirst)
        await until { proxyFirst.settlements == 1 }
        assert(cancelProxyFirst.result?["cancelled"] as? Bool == true && !proxyBrowser.cancelled && proxySecond.error == nil,
            "Cancelling one fallback leaves another source consumer's shared sign-in active")
        proxyPlugin.cancelProxyFetch(CAPPluginCall(["requestId": "proxy-second"]))
        await until { proxySecond.settlements == 1 && proxyBrowser.cancelled }
        proxyBrowser.succeed()
        for _ in 0..<20 { await Task.yield() }
        assert(proxyFirst.settlements == 1 && proxySecond.settlements == 1 && AccessMediaHTTP.exchangeRequests == 0)

        let immediateProxy = CAPPluginCall(["url": bridgeFixture.source.absoluteString, "requestId": "proxy-immediate"])
        let cancelImmediateProxy = CAPPluginCall(["requestId": "proxy-immediate"])
        proxyPlugin.proxyFetch(immediateProxy); proxyPlugin.cancelProxyFetch(cancelImmediateProxy)
        await until { immediateProxy.settlements == 1 }
        assert(cancelImmediateProxy.result?["cancelled"] as? Bool == true)
        let oldProxy = CAPPluginCall(["url": bridgeFixture.source.absoluteString, "requestId": "proxy-reuse"])
        let newProxy = CAPPluginCall(["url": bridgeFixture.source.absoluteString, "requestId": "proxy-reuse"])
        proxyPlugin.proxyFetch(oldProxy)
        await until { ASWebAuthenticationSession.opened.last?.cancelled == false }
        proxyPlugin.cancelProxyFetch(CAPPluginCall(["requestId": "proxy-reuse"]))
        proxyPlugin.proxyFetch(newProxy)
        await until { oldProxy.settlements == 1 }
        let cancelNewProxy = CAPPluginCall(["requestId": "proxy-reuse"])
        proxyPlugin.cancelProxyFetch(cancelNewProxy)
        await until { newProxy.settlements == 1 }
        assert(cancelNewProxy.result?["cancelled"] as? Bool == true && newProxy.error != nil,
            "An old fallback completion cannot erase a reused request ID")
        for invalid in ["", "bad\n", "../bad", 42] as [Any] {
            let call = CAPPluginCall(["url": bridgeFixture.source.absoluteString, "requestId": invalid])
            proxyPlugin.proxyFetch(call)
            assert(call.error == "Invalid proxy request identifier" && call.settlements == 1)
        }
        let legacyProxy = CAPPluginCall(["url": bridgeFixture.source.absoluteString])
        proxyPlugin.proxyFetch(legacyProxy)
        await until { ASWebAuthenticationSession.opened.last?.cancelled == false }
        try AccessMedia.shared.signOut()
        await until { legacyProxy.settlements == 1 }

        for (ua, referer, status) in [("webos", "https://ref.fixture.invalid/start?q=a+b", 200), ("Custom fixture UA", "", 403), ("", "", 200)] {
            AccessMediaPublicHTTP.handler = { request in
                assert(request.url!.absoluteString == "https://plain-proxy.fixture.invalid/list")
                assert(request.timeoutInterval == 15 && request.httpMethod == "GET")
                let actualUA = request.value(forHTTPHeaderField: "User-Agent") ?? ""
                assert(ua == "webos" ? actualUA.contains("Web0S") : actualUA == (ua.isEmpty ? "OTT-play-FOSS/1.0" : ua))
                assert(request.value(forHTTPHeaderField: "Referer") == (referer.isEmpty ? "https://plain-proxy.fixture.invalid" : referer))
                return (Data("#EXTM3U\n".utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: [:])!)
            }
            let call = CAPPluginCall(["url": "@https://plain-proxy.fixture.invalid/list", "requestId": "proxy-complete", "userAgent": ua, "referer": referer])
            proxyPlugin.proxyFetch(call)
            await until { call.settlements == 1 }
            assert(status == 200 ? call.result?["body"] as? String == "#EXTM3U\n" : call.error == "Upstream 403")
            let cancelComplete = CAPPluginCall(["requestId": "proxy-complete"])
            proxyPlugin.cancelProxyFetch(cancelComplete)
            await until { cancelComplete.result != nil }
            assert(cancelComplete.result?["cancelled"] as? Bool == false)
        }
        AccessMediaPublicHTTP.handler = nil

        let httpPlugin = StalkerPortalPlugin()
        let timedLogin = CAPPluginCall(["url": bridgeFixture.source.absoluteString, "timeoutMs": 30.0, "requestId": "short-network"])
        let beforeTimedLogin = ASWebAuthenticationSession.opened.count
        httpPlugin.httpRequest(timedLogin)
        await until { ASWebAuthenticationSession.opened.count == beforeTimedLogin + 1 }
        try await Task.sleep(nanoseconds: 80_000_000)
        assert(timedLogin.error == nil && !ASWebAuthenticationSession.opened.last!.cancelled,
            "A short network timeout must not dismiss a still-owned browser/email sign-in")
        httpPlugin.cancelHttpRequest(CAPPluginCall(["requestId": "short-network"]))
        await until { timedLogin.error != nil }
        assert(timedLogin.errorCode == nil && timedLogin.settlements == 1)
        await until { ASWebAuthenticationSession.opened.last!.cancelled }

        var abandonedRequest = URLRequest(url: bridgeFixture.source)
        abandonedRequest.timeoutInterval = 0.03
        var abandonedCount = 0
        var abandonedError: Error?
        let abandoned = AccessMedia.fetch(abandonedRequest, authenticationAllowance: 0) { _, _, error in
            Task { @MainActor in abandonedCount += 1; abandonedError = error }
        }
        await until { abandonedCount == 1 }
        await abandoned.value
        assert((abandonedError as? URLError)?.code == .timedOut && ASWebAuthenticationSession.opened.last!.cancelled,
            "The separate overall deadline must still retire an abandoned caller's login exactly once")

        let httpFirst = CAPPluginCall(["url": bridgeFixture.source.absoluteString, "requestId": "http-first"])
        let httpSecond = CAPPluginCall(["url": bridgeFixture.config.source_origin + "/load.php", "requestId": "http-second"])
        let beforeHttp = ASWebAuthenticationSession.opened.count
        httpPlugin.httpRequest(httpFirst); httpPlugin.portalRequest(httpSecond)
        await until { ASWebAuthenticationSession.opened.count == beforeHttp + 1 }
        let httpDuplicate = CAPPluginCall(["url": bridgeFixture.source.absoluteString, "requestId": "http-first"])
        httpPlugin.httpRequest(httpDuplicate)
        await until { httpDuplicate.error != nil }
        assert(httpDuplicate.error == "HTTP request is already pending" && httpFirst.error == nil)
        let cancelHttpFirst = CAPPluginCall(["requestId": "http-first"])
        httpPlugin.cancelHttpRequest(cancelHttpFirst)
        await until { httpFirst.error != nil }
        assert(cancelHttpFirst.result?["cancelled"] as? Bool == true && httpSecond.error == nil)
        assert(!ASWebAuthenticationSession.opened.last!.cancelled)
        let cancelHttpSecond = CAPPluginCall(["requestId": "http-second"])
        httpPlugin.cancelHttpRequest(cancelHttpSecond)
        await until { httpSecond.error != nil && ASWebAuthenticationSession.opened.last!.cancelled }
        assert(httpFirst.settlements == 1 && httpSecond.settlements == 1)

        let httpImmediate = CAPPluginCall(["url": bridgeFixture.source.absoluteString, "requestId": "http-immediate"])
        let cancelHttpImmediate = CAPPluginCall(["requestId": "http-immediate"])
        httpPlugin.httpRequest(httpImmediate); httpPlugin.cancelHttpRequest(cancelHttpImmediate)
        await until { httpImmediate.error != nil }
        assert(cancelHttpImmediate.result?["cancelled"] as? Bool == true && httpImmediate.settlements == 1)
        let httpOld = CAPPluginCall(["url": bridgeFixture.source.absoluteString, "requestId": "http-reuse"])
        httpPlugin.httpRequest(httpOld)
        let cancelHttpOld = CAPPluginCall(["requestId": "http-reuse"])
        let httpNew = CAPPluginCall(["url": bridgeFixture.source.absoluteString, "requestId": "http-reuse"])
        httpPlugin.cancelHttpRequest(cancelHttpOld); httpPlugin.httpRequest(httpNew)
        await until { httpOld.error != nil }
        for _ in 0..<20 { await Task.yield() }
        let cancelHttpNew = CAPPluginCall(["requestId": "http-reuse"])
        httpPlugin.cancelHttpRequest(cancelHttpNew)
        await until { httpNew.error != nil }
        assert(cancelHttpNew.result?["cancelled"] as? Bool == true && httpNew.settlements == 1)
        let badHttpID = CAPPluginCall(["url": bridgeFixture.source.absoluteString, "requestId": "bad\n"])
        httpPlugin.httpRequest(badHttpID)
        assert(badHttpID.error == "Invalid HTTP request identifier")

        for portal in [false, true] {
            let url = "https://text.fixture.invalid/" + (portal ? "load.php" : "list.m3u") + "?token=PRIVATE_FIXTURE"
            let requestID = portal ? "invalid-portal-text" : "invalid-http-text"
            AccessMediaPublicHTTP.handler = { request in
                return (Data([0xC3, 0x28]), HTTPURLResponse(url: request.url!, statusCode: 200,
                    httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/plain; charset=utf-8"])!)
            }
            let malformed = CAPPluginCall(["url": url, "requestId": requestID])
            if portal { httpPlugin.portalRequest(malformed) } else { httpPlugin.httpRequest(malformed) }
            await until { malformed.settlements == 1 }
            assert(malformed.result == nil && malformed.error == "portalRequest failed: response is not valid UTF-8",
                "Malformed upstream bytes must fail instead of becoming a successful empty playlist")
            assert(malformed.errorCode == "invalid_response")

            let text = "#EXTM3U\n#EXTINF:-1,Канал 🎵\nhttps://media.fixture.invalid/live\n"
            AccessMediaPublicHTTP.handler = { request in
                return (Data(text.utf8), HTTPURLResponse(url: request.url!, statusCode: 200,
                    httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/plain; charset=utf-8"])!)
            }
            let retry = CAPPluginCall(["url": url, "requestId": requestID])
            if portal { httpPlugin.portalRequest(retry) } else { httpPlugin.httpRequest(retry) }
            await until { retry.settlements == 1 }
            assert(retry.error == nil && retry.result?["body"] as? String == text,
                "Failed decoding must release the request ID and preserve the exact Unicode retry")
            let completed = CAPPluginCall(["requestId": requestID])
            httpPlugin.cancelHttpRequest(completed)
            await until { completed.result != nil }
            assert(completed.result?["cancelled"] as? Bool == false)
        }
        AccessMediaPublicHTTP.handler = { request in
            return (Data(), HTTPURLResponse(url: request.url!, statusCode: 204,
                httpVersion: "HTTP/1.1", headerFields: [:])!)
        }
        let emptyResponse = CAPPluginCall(["url": "https://text.fixture.invalid/empty", "requestId": "empty-response"])
        httpPlugin.httpRequest(emptyResponse)
        await until { emptyResponse.settlements == 1 }
        assert(emptyResponse.error == nil && emptyResponse.result?["body"] as? String == "" &&
            emptyResponse.result?["status"] as? Int == 204, "A legitimate empty response must remain valid")

        var downloadGate: CheckedContinuation<Void, Never>?
        var downloadCancelled = false
        AccessMediaHTTP.handler = { request, limit in
            if request.url!.path == bridgeFixture.config.exchange_path {
                return try await bridgeFixture.fetch(request, limit: limit)
            }
            try await withTaskCancellationHandler(operation: {
                await withCheckedContinuation { downloadGate = $0 }
                try Task.checkCancellation()
            }, onCancel: {
                Task { @MainActor in
                    downloadCancelled = true
                    let gate = downloadGate; downloadGate = nil; gate?.resume()
                }
            })
            return (Data("fixture".utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [:])!)
        }
        let downloadLoginCount = ASWebAuthenticationSession.opened.count
        let prepareDownload = Task { try await AccessMedia.shared.authorized(URLRequest(url: bridgeFixture.source), config: bridgeFixture.config) }
        await until { ASWebAuthenticationSession.opened.count == downloadLoginCount + 1 }
        ASWebAuthenticationSession.opened.last!.succeed()
        _ = try await prepareDownload.value
        var callbackCount = 0
        var downloadError: Error?
        let download = AccessMedia.fetch(URLRequest(url: bridgeFixture.source), discoverOnFailure: false) { _, _, error in
            Task { @MainActor in callbackCount += 1; downloadError = error }
        }
        await until { downloadGate != nil }
        let playerLabels = AccessMediaLabels([
            "title": "Доступ к источникам", "signIn": "Войти: %1", "signOut": "Выйти из всех источников",
            "close": "Закрыть", "login": "Войдите в защищённый источник снова",
            "unavailable": "Защищённый источник недоступен", "unknown": "ignored",
        ])
        AccessMedia.shared.manage(labels: playerLabels)
        let settings = bridgeFixture.presenter.presented as! UIAlertController
        assert(settings.title == "Доступ к источникам", "Player language overrides the system locale")
        assert(settings.actions.contains { $0.title.hasPrefix("Войти: ") })
        assert(settings.actions.last!.title == "Закрыть")
        assert(playerLabels.error(AccessMediaFailure.login) == "Войдите в защищённый источник снова")
        assert(playerLabels.error(URLError(.cannotConnectToHost)) == "Защищённый источник недоступен",
            "Untrusted transport errors must not enter the localized native dialog")
        assert(playerLabels["unknown"] == "")
        assert(AccessMediaLabels(["title": String(repeating: "x", count: 513)])["title"] == "Source access")
        assert(AccessMediaLabels(["close": "Fermer"])["close"] == "Fermer", "Labels support every player locale")
        settings.actions.first(where: { $0.style == .destructive })!.invoke()
        await until { downloadCancelled && callbackCount == 1 }
        await download.value
        assert(callbackCount == 1 && downloadError as? AccessMediaFailure == .cancelled,
            "Settings sign-out must cancel an active protected EPG/HTTP transfer and settle it once")

        var publicGate: CheckedContinuation<Void, Never>?
        var publicCancelled = false
        AccessMediaPublicHTTP.handler = { request in
            await withTaskCancellationHandler(operation: {
                await withCheckedContinuation { publicGate = $0 }
            }, onCancel: { Task { @MainActor in publicCancelled = true } })
            return (Data("public".utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [:])!)
        }
        var publicCount = 0
        let publicRequest = AccessMedia.fetch(URLRequest(url: URL(string: "https://public.fixture.invalid/epg.xml")!)) { data, _, error in
            assert(data == Data("public".utf8) && error == nil)
            Task { @MainActor in publicCount += 1 }
        }
        await until { publicGate != nil }
        try AccessMedia.shared.signOut()
        for _ in 0..<20 { await Task.yield() }
        assert(!publicCancelled && publicCount == 0, "Source logout must not cancel unrelated public HTTP")
        publicGate!.resume()
        await publicRequest.value
        await until { publicCount == 1 }

        let timedDownloadLoginCount = ASWebAuthenticationSession.opened.count
        let prepareTimedDownload = Task { try await AccessMedia.shared.authorized(URLRequest(url: bridgeFixture.source), config: bridgeFixture.config) }
        await until { ASWebAuthenticationSession.opened.count == timedDownloadLoginCount + 1 }
        ASWebAuthenticationSession.opened.last!.succeed()
        _ = try await prepareTimedDownload.value
        downloadCancelled = false
        var timedRequest = URLRequest(url: bridgeFixture.source)
        timedRequest.timeoutInterval = 0.03
        var timedCount = 0
        var timedError: Error?
        let timedDownload = AccessMedia.fetch(timedRequest, authenticationAllowance: 0) { _, _, error in
            Task { @MainActor in timedCount += 1; timedError = error }
        }
        await until { timedCount == 1 && downloadCancelled }
        await timedDownload.value
        assert(timedCount == 1 && (timedError as? URLError)?.code == .timedOut,
            "A full request timeout cancels the protected transfer and preserves the timeout category exactly once")

        let callbackAfterCompletion = CAPPluginCall(["requestId": "http-first"])
        httpPlugin.cancelHttpRequest(callbackAfterCompletion)
        await until { callbackAfterCompletion.result != nil }
        assert(callbackAfterCompletion.result?["cancelled"] as? Bool == false)
        // Exercise the complete callback bridge with a known protected mapping.
        // No probe request is needed: the actual source response selects the route.
        try AccessMedia.shared.signOut()
        AccessMedia.shared.networkChanged()
        var networkRequests: [URLRequest] = []
        let beforeTrusted = ASWebAuthenticationSession.opened.count
        AccessMediaHTTP.handler = { request, _ in
            networkRequests.append(request)
            assert(request.url?.host == "source.fixture.invalid")
            assert(request.value(forHTTPHeaderField: "Cookie") == nil &&
                request.value(forHTTPHeaderField: "CF-Access-Jwt-Assertion") == nil &&
                request.value(forHTTPHeaderField: "Host") == nil && !request.httpShouldHandleCookies)
            return (Data("#EXTM3U\ntrusted\n".utf8), HTTPURLResponse(url: request.url!, statusCode: 200,
                httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/vnd.apple.mpegurl",
                    "Set-Cookie": "CF_Authorization=DO_NOT_EXPOSE", "Cf-Access-Jwt-Assertion": "DO_NOT_EXPOSE"])!)
        }
        var trustedRequest = URLRequest(url: bridgeFixture.source)
        trustedRequest.setValue("foreign=secret", forHTTPHeaderField: "Cookie")
        trustedRequest.setValue("forged", forHTTPHeaderField: "CF-Access-Jwt-Assertion")
        trustedRequest.setValue("evil.invalid", forHTTPHeaderField: "Host")
        let trustedResponse = await fetchResult(trustedRequest)
        assert(trustedResponse.0 == Data("#EXTM3U\ntrusted\n".utf8) && trustedResponse.1?.statusCode == 200 && trustedResponse.2 == nil)
        assert(trustedResponse.1?.value(forHTTPHeaderField: "Set-Cookie") == nil &&
            trustedResponse.1?.value(forHTTPHeaderField: "Cf-Access-Jwt-Assertion") == nil)
        assert(networkRequests.count == 1 && ASWebAuthenticationSession.opened.count == beforeTrusted,
            "Cached configuration on a trusted network loads without a probe, exchange, or browser")

        for status in [404, 500, 503] {
            networkRequests = []
            AccessMedia.shared.networkChanged()
            AccessMediaHTTP.handler = { request, _ in
                networkRequests.append(request)
                return (Data("unavailable".utf8), HTTPURLResponse(url: request.url!, statusCode: status,
                    httpVersion: "HTTP/1.1", headerFields: [:])!)
            }
            let result = await fetchResult(URLRequest(url: bridgeFixture.source))
            assert(result.1?.statusCode == status && result.2 == nil && networkRequests.count == 1)
            assert(ASWebAuthenticationSession.opened.count == beforeTrusted,
                "Missing media or an origin outage must not ask the user to sign in")
        }
        AccessMediaHTTP.handler = { request, _ in
            (Data("<!doctype html><title>Origin error</title>".utf8), HTTPURLResponse(url: request.url!, statusCode: 200,
                httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/html"])!)
        }
        let html = await fetchResult(URLRequest(url: bridgeFixture.source))
        assert(html.0 == nil && html.2 as? AccessMediaFailure == .unavailable &&
            ASWebAuthenticationSession.opened.count == beforeTrusted,
            "Generic HTML success must not become an empty playlist or a spurious sign-in")
        AccessMediaHTTP.handler = { _, _ in throw URLError(.timedOut) }
        let offline = await fetchResult(URLRequest(url: bridgeFixture.source))
        assert((offline.2 as? URLError)?.code == .timedOut &&
            ASWebAuthenticationSession.opened.count == beforeTrusted,
            "A transport timeout retains its error and never opens authentication")

        for (status, headers) in [(401, [:]), (403, [:]),
            (302, ["Location": "https://login.cloudflareaccess.com/cdn-cgi/access/login"]),
            (200, ["Content-Type": "text/html", "cf-mitigated": "challenge"])] {
            try AccessMedia.shared.signOut()
            AccessMedia.shared.networkChanged()
            networkRequests = []
            let beforeFallback = ASWebAuthenticationSession.opened.count
            AccessMediaHTTP.handler = { request, limit in
                if request.url?.path == bridgeFixture.config.exchange_path {
                    return try await bridgeFixture.fetch(request, limit: limit)
                }
                networkRequests.append(request)
                if request.url?.host == "source.fixture.invalid" {
                    assert(request.value(forHTTPHeaderField: "Cookie") == nil)
                    return (Data("denied".utf8), HTTPURLResponse(url: request.url!, statusCode: status,
                        httpVersion: "HTTP/1.1", headerFields: headers)!)
                }
                assert(request.url?.host == "media.fixture.invalid" && request.value(forHTTPHeaderField: "Cookie") != nil)
                return (Data("#EXTM3U\nauthenticated\n".utf8), HTTPURLResponse(url: request.url!, statusCode: 200,
                    httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/vnd.apple.mpegurl"])!)
            }
            let fallbackResult = Task { await fetchResult(URLRequest(url: bridgeFixture.source)) }
            await until { ASWebAuthenticationSession.opened.count == beforeFallback + 1 }
            assert(networkRequests.count == 1 && networkRequests[0].url?.host == "source.fixture.invalid")
            ASWebAuthenticationSession.opened.last!.succeed()
            let result = await fallbackResult.value
            assert(result.0 == Data("#EXTM3U\nauthenticated\n".utf8) && result.2 == nil && networkRequests.count == 2)
            assert(ASWebAuthenticationSession.opened.count == beforeFallback + 1,
                "A denied source falls back through exactly one authenticated login")
        }

        // A saved token must not force the mobile route after returning home.
        AccessMedia.shared.networkChanged()
        networkRequests = []
        let beforeHome = ASWebAuthenticationSession.opened.count
        AccessMediaHTTP.handler = { request, _ in
            networkRequests.append(request)
            assert(request.url?.host == "source.fixture.invalid" && request.value(forHTTPHeaderField: "Cookie") == nil)
            return (Data("home".utf8), HTTPURLResponse(url: request.url!, statusCode: 200,
                httpVersion: "HTTP/1.1", headerFields: [:])!)
        }
        let home = await fetchResult(URLRequest(url: URL(string: bridgeFixture.config.media_origin + "/list.m3u8")!))
        assert(home.0 == Data("home".utf8) && home.2 == nil && networkRequests.count == 1 &&
            ASWebAuthenticationSession.opened.count == beforeHome)

        // Direct denial, rejected saved token, and rejected replacement are bounded.
        networkRequests = []
        AccessMediaHTTP.handler = { request, limit in
            if request.url?.path == bridgeFixture.config.exchange_path {
                return try await bridgeFixture.fetch(request, limit: limit)
            }
            networkRequests.append(request)
            return (Data(), HTTPURLResponse(url: request.url!, statusCode: 403,
                httpVersion: "HTTP/1.1", headerFields: [:])!)
        }
        let rejected = Task { await fetchResult(URLRequest(url: bridgeFixture.source)) }
        await until { ASWebAuthenticationSession.opened.count == beforeHome + 1 }
        ASWebAuthenticationSession.opened.last!.succeed()
        let rejectedResult = await rejected.value
        assert(rejectedResult.2 as? AccessMediaFailure == .login && networkRequests.count == 3 &&
            networkRequests.map { $0.url!.host! } == ["source.fixture.invalid", "media.fixture.invalid", "media.fixture.invalid"],
            "A failed authenticated fallback renews only once and cannot loop")

        // Cancellation/logout win even when direct HTTP returns a late denial.
        for logout in [false, true] {
            try AccessMedia.shared.signOut()
            AccessMedia.shared.networkChanged()
            let beforePending = ASWebAuthenticationSession.opened.count
            var directGate: CheckedContinuation<Void, Never>?
            var directCancelled = false
            AccessMediaHTTP.handler = { request, _ in
                assert(request.url?.host == "source.fixture.invalid")
                await withTaskCancellationHandler(operation: {
                    await withCheckedContinuation { directGate = $0 }
                }, onCancel: { Task { @MainActor in directCancelled = true } })
                return (Data(), HTTPURLResponse(url: request.url!, statusCode: 403,
                    httpVersion: "HTTP/1.1", headerFields: [:])!)
            }
            var pendingCount = 0
            var pendingError: Error?
            let pending = AccessMedia.fetch(URLRequest(url: bridgeFixture.source)) { _, _, error in
                Task { @MainActor in pendingCount += 1; pendingError = error }
            }
            await until { directGate != nil }
            if logout { try AccessMedia.shared.signOut() } else { pending.cancel() }
            await until { directCancelled }
            directGate!.resume()
            await pending.value
            await until { pendingCount == 1 }
            assert(pendingError as? AccessMediaFailure == .cancelled &&
                ASWebAuthenticationSession.opened.count == beforePending,
                "A late direct rejection after cancellation or logout cannot reopen authentication")
        }
        // The first public denial may cross a Wi-Fi/cellular transition before
        // discovery completes. It must not poison the newly trusted network.
        for stage in ["public", "discovery"] {
            let transitionConfig = AccessMediaConfig(version: 1,
                source_origin: "https://transition-\(stage).fixture.invalid",
                media_origin: "https://authenticated-\(stage).fixture.invalid", authorize_path: "/_ottplay/authorize",
                exchange_path: "/_ottplay/public/exchange", callback: "ottplay-access://callback")
            let transitionURL = URL(string: transitionConfig.source_origin + "/list.m3u8")!
            var transitionGate: CheckedContinuation<Void, Never>?
            var transitionRequests: [URLRequest] = []
            let beforeTransition = ASWebAuthenticationSession.opened.count
            AccessMediaPublicHTTP.handler = { request in
                assert(request.url == transitionURL)
                if stage == "public" { await withCheckedContinuation { transitionGate = $0 } }
                return (Data(), HTTPURLResponse(url: request.url!, statusCode: 403,
                    httpVersion: "HTTP/1.1", headerFields: [:])!)
            }
            AccessMediaHTTP.handler = { request, _ in
                transitionRequests.append(request)
                if request.url!.path == "/_ottplay/public/config" {
                    if stage == "discovery" { await withCheckedContinuation { transitionGate = $0 } }
                    return (try JSONEncoder().encode(transitionConfig), HTTPURLResponse(url: request.url!, statusCode: 200,
                        httpVersion: "HTTP/1.1", headerFields: [:])!)
                }
                assert(request.url == transitionURL && request.value(forHTTPHeaderField: "Cookie") == nil)
                return (Data("trusted-after-transition".utf8), HTTPURLResponse(url: request.url!, statusCode: 200,
                    httpVersion: "HTTP/1.1", headerFields: [:])!)
            }
            var transitionFinished = false
            let transition = Task {
                let result = await fetchResult(URLRequest(url: transitionURL))
                transitionFinished = true
                return result
            }
            await until { transitionGate != nil }
            AccessMedia.shared.networkChanged()
            transitionGate!.resume()
            await until { transitionFinished || ASWebAuthenticationSession.opened.count > beforeTransition }
            assert(ASWebAuthenticationSession.opened.count == beforeTransition,
                "A stale initial public denial cannot open login on a newly trusted network")
            let result = await transition.value
            assert(result.0 == Data("trusted-after-transition".utf8) && result.2 == nil && transitionRequests.count == 2,
                "After a network transition, discovery is followed by exactly one current source request")
        }
        AccessMediaPublicHTTP.handler = nil
        AccessMediaHTTP.handler = nil
        reset()
        let generationFixture = Fixture(), generationAccess = generationFixture.makeAccess()
        try generationAccess.signOut()
        let staleHttp = Task {
            try await generationAccess.authorized(URLRequest(url: generationFixture.source), config: generationFixture.config, generation: 0)
        }
        await failure(staleHttp, .cancelled)
        let staleRoute = Task {
            try await generationAccess.routed(URLRequest(url: generationFixture.source), config: generationFixture.config,
                replacing: URLRequest(url: generationFixture.source), generation: 0)
        }
        await failure(staleRoute, .cancelled)
        assert(ASWebAuthenticationSession.opened.isEmpty,
            "A request queued before logout cannot start login after logout while crossing the actor")
        print("PASS: trusted-network routing/probes, preparation ownership, stale-network discovery, bounded authenticated fallback, native auth/bridge cancellation, protected HTTP logout/deadlines, public HTTP isolation, request ID ownership, generation guards and uppercase HTTPS")
        finished = true
    } catch { fatalError("Auth fixture failed: \(error)") }
}
let deadline = Date().addingTimeInterval(25)
while !finished && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.005)) }
assert(finished, "Timed out")
'''

with tempfile.TemporaryDirectory(prefix="ottplay-auth-test-") as directory:
    path = Path(directory)
    sources = ROOT / "ios/App/App/Plugins"
    production = (sources / "AccessMedia.swift").read_text()
    for module in ["AuthenticationServices", "Capacitor", "Security", "UIKit"]:
        production = production.replace(f"import {module}\n", "")
    (path / "AccessMedia.swift").write_text("import CoreFoundation\n" + production)
    policy = (sources / "AccessMediaPolicy.swift").read_text().split("// Used only for protected requests", 1)[0]
    (path / "AccessMediaPolicy.swift").write_text(policy)
    portal = (sources / "StalkerPortalPlugin.swift").read_text().split("/// A separate capability:", 1)[0]
    portal = portal.replace("import Capacitor\n", "").replace("import os.log\n", "").replace("#if os(iOS)", "#if true")
    (path / "StalkerPortalPlugin.swift").write_text(portal)
    proxy = (sources.parent / "M3UProxy.swift").read_text()
    proxy = proxy.replace("import Capacitor\n", "").replace("import os.log\n", "").replace("#if os(iOS)", "#if true")
    (path / "M3UProxy.swift").write_text(proxy)
    (path / "main.swift").write_text(swift_work_source() + SWIFT)
    subprocess.run(["swiftc", str(path / "AccessMediaPolicy.swift"),
                    str(path / "AccessMedia.swift"), str(path / "StalkerPortalPlugin.swift"), str(path / "M3UProxy.swift"), str(path / "main.swift"),
                    "-o", str(path / "test")], check=True)
    subprocess.run([str(path / "test")], check=True, timeout=35)
