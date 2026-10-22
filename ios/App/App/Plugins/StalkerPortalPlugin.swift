/// Mode B native HTTP for Stalker `/stalker_portal/api/`, `host_ott/swop/a.php`,
/// and Mag path-shaped `/load.php`|`/c/portal` URLs (allowlist + header forward only).
import Capacitor
import Foundation
import os.log

@objc(StalkerPortalPlugin)
public class StalkerPortalPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "StalkerPortalPlugin"
    public let jsName = "StalkerPortal"
    @MainActor private var requests: [String: (id: UUID, cancel: () -> Void)] = [:]
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "portalRequest", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "httpRequest", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelHttpRequest", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "swopRequest", returnType: CAPPluginReturnPromise),
    ]

    private static let DEFAULT_TIMEOUT: TimeInterval = 15

    private static func validRequestID(_ value: String?) -> Bool {
        guard let value, !value.isEmpty, value.utf8.count <= 128 else { return false }
        return value.utf8.allSatisfy {
            (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95
        }
    }

    @objc func cancelHttpRequest(_ call: CAPPluginCall) {
        guard let requestID = call.getString("requestId"), Self.validRequestID(requestID) else {
            call.reject("Invalid HTTP request identifier"); return
        }
        DispatchQueue.main.async {
            let pending = self.requests.removeValue(forKey: requestID)
            pending?.cancel()
            call.resolve(["cancelled": pending != nil])
        }
    }

    @objc func swopRequest(_ call: CAPPluginCall) {
        NativeSwopRequest.start(call)
    }

    private func isAllowedUrl(_ url: String) -> Bool {
        return url.contains("/stalker_portal/api/")
            || url.contains("/stalker_portal/stream/")
            || url.contains("/swop/a.php")
            || url.contains("/load.php")
            || url.contains("/portal.php")
            || url.contains("/c/portal")
    }

    private func isForbiddenHeader(_ name: String) -> Bool {
        let n = name.lowercased()
        return n == "host" || n == "content-length" || n == "connection"
            || n == "transfer-encoding" || n == "upgrade"
    }

    @objc func portalRequest(_ call: CAPPluginCall) {
        guard let rawURL = call.getString("url"), !rawURL.isEmpty else {
            call.reject("missing url")
            return
        }
        guard isAllowedUrl(rawURL) else {
            call.reject("url is not an allowed stalker/swop/load.php/c/portal path")
            return
        }
        performRequest(call, rawURL: rawURL)
    }

    @objc func httpRequest(_ call: CAPPluginCall) {
        guard let rawURL = call.getString("url"), !rawURL.isEmpty else {
            call.reject("missing url")
            return
        }
        if call.getBool("screenshotControl") == true {
            performScreenshotRequest(call)
        } else {
            performRequest(call, rawURL: rawURL)
        }
    }

    private func performScreenshotRequest(_ call: CAPPluginCall) {
        let requestID = call.getString("requestId")
        guard call.options["requestId"] == nil || Self.validRequestID(requestID) else {
            call.reject("Invalid HTTP request identifier"); return
        }
        // Keep the plugin alive until ownership is registered; completion stays weak.
        DispatchQueue.main.async { [self] in
            guard self.requests.count < 8 else {
                call.reject("Too many native HTTP requests", "busy"); return
            }
            if let requestID, self.requests[requestID] != nil {
                call.reject("HTTP request is already pending", "busy"); return
            }
            let ownership = UUID()
            // Anonymous calls still occupy a bounded native slot.
            let key = requestID ?? "screenshot_" + ownership.uuidString
            guard let owner = NativeScreenshotRequest.make(call, finished: { [weak self] in
                if self?.requests[key]?.id == ownership { self?.requests[key] = nil }
            }) else { return }
            self.requests[key] = (ownership, { owner.cancel() })
            owner.start()
        }
    }

    private func performRequest(_ call: CAPPluginCall, rawURL: String) {
        let requestID = call.getString("requestId")
        guard call.options["requestId"] == nil || Self.validRequestID(requestID) else {
            call.reject("Invalid HTTP request identifier"); return
        }
        guard let url = URL(string: rawURL),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https", url.host != nil else {
            call.reject("invalid url")
            return
        }

        let method = (call.getString("method") ?? "GET").uppercased()
        let bodyString = call.getString("body") ?? ""
        let contentType = call.getString("contentType") ?? "application/json"
        let headers = call.getObject("headers")

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = max(0.001, (call.getDouble("timeoutMs") ?? (StalkerPortalPlugin.DEFAULT_TIMEOUT * 1000)) / 1000)

        var contentTypeFromHeaders = false
        if let headers = headers {
            for (key, value) in headers {
                if isForbiddenHeader(key) { continue }
                guard let str = value as? String else { continue }
                if key.lowercased() == "content-type" {
                    contentTypeFromHeaders = true
                }
                request.setValue(str, forHTTPHeaderField: key)
            }
        }
        if !bodyString.isEmpty {
            if !contentTypeFromHeaders {
                request.setValue(contentType, forHTTPHeaderField: "Content-Type")
            }
            request.httpBody = bodyString.data(using: .utf8)
        }

        let completion: (Data?, URLResponse?, Error?) -> Void = { data, response, error in
            if let error = error {
                let code = (error as NSError).code == NSURLErrorTimedOut ? "timeout" : nil
                call.reject("portalRequest failed: \(error.localizedDescription)", code)
                return
            }
            guard let data = data, let response = response else {
                let nsError = NSError(domain: "StalkerPortal", code: -1, userInfo: [NSLocalizedDescriptionKey: "empty response"])
                call.reject("portalRequest failed: \(nsError.localizedDescription)")
                return
            }
            let http = response as? HTTPURLResponse
            let status = http?.statusCode ?? 0
            let contentType = response.mimeType ?? "application/octet-stream"
            guard let body = String(data: data, encoding: .utf8) else {
                // A decode failure must not become a successful empty catalogue.
                call.reject("portalRequest failed: response is not valid UTF-8", "invalid_response")
                return
            }
            var setCookie: [String] = []
            var responseHeaders = ""
            if let fields = http?.allHeaderFields {
                for (k, v) in fields {
                    responseHeaders += "\(k): \(v)\r\n"
                    if String(describing: k).lowercased() == "set-cookie",
                       let s = v as? String {
                        setCookie.append(s)
                    }
                }
                // URLSession may coalesce; also check value(forHTTPHeaderField:)
                if setCookie.isEmpty,
                   let single = http?.value(forHTTPHeaderField: "Set-Cookie"),
                   !single.isEmpty {
                    setCookie.append(single)
                }
            }
            Logger(subsystem: "play.ott.foss", category: "StalkerPortal").debug("[StalkerPortal] OK \(rawURL) (status=\(status))")
            call.resolve([
                "status": NSNumber(value: status),
                "statusText": HTTPURLResponse.localizedString(forStatusCode: status),
                "headers": responseHeaders,
                "body": body,
                "contentType": contentType,
                "setCookie": setCookie,
            ])
        }
        DispatchQueue.main.async {
            if let requestID, self.requests[requestID] != nil {
                call.reject("HTTP request is already pending"); return
            }
            let control = call.getBool("remoteControl") == true || call.getBool("secureControl") == true
            let ticket = control ? nil : NativeWork.shared.begin()
            if !control && ticket == nil { call.reject("Player is in standby", "standby"); return }
            let ownership = UUID()
            let finish: (Data?, URLResponse?, Error?) -> Void = { data, response, error in
                DispatchQueue.main.async {
                    if let requestID, self.requests[requestID]?.id == ownership { self.requests[requestID] = nil }
                    defer { ticket?.finish() }
                    if let ticket { do { try ticket.check() } catch { call.reject("Provider request cancelled", "cancelled"); return } }
                    completion(data, response, error)
                }
            }
            #if os(iOS)
            let task = AccessMedia.fetch(request, completion: finish)
            #else
            let task = URLSession.shared.dataTask(with: request, completionHandler: finish)
            task.resume()
            #endif
            ticket?.cancelWith { task.cancel() }
            if let requestID { self.requests[requestID] = (ownership, { task.cancel() }) }
        }
    }
}

/// Screenshot transport is isolated from provider credentials and AccessMedia.
/// All state and delegate callbacks run on the main queue, including cancellation.
private final class NativeScreenshotRequest: NSObject, URLSessionDataDelegate {
    private static let limit = 2 * 1024 * 1024
    private let call: CAPPluginCall
    private let finishedCallback: () -> Void
    private var bytes = Data()
    private var status = 0
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var settled = false

    private init(_ call: CAPPluginCall, finished: @escaping () -> Void) {
        self.call = call
        self.finishedCallback = finished
    }

    static func make(_ call: CAPPluginCall, finished: @escaping () -> Void) -> NativeScreenshotRequest? {
        guard let raw = call.getString("url"), raw.utf8.count <= 8192,
              !raw.contains("\\"), !raw.unicodeScalars.contains(where: { $0.value <= 32 || $0.value == 127 }),
              let parts = URLComponents(string: raw), let url = parts.url,
              let host = parts.host?.lowercased(), !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.fragment == nil,
              parts.port == nil || (1...65535).contains(parts.port!),
              parts.scheme == "https" || (parts.scheme == "http" && ["localhost", "127.0.0.1", "[::1]", "::1"].contains(host))
        else { call.reject("Screenshot transport requires HTTPS or an exact loopback address", "invalid_request"); return nil }
        let method = call.getString("method") ?? "GET"
        let body = call.getString("body") ?? ""
        let bodyData = Data(body.utf8)
        let timeout = call.getDouble("timeoutMs") ?? 15000
        guard ["GET", "POST"].contains(method), bodyData.count <= limit,
              method != "GET" || bodyData.isEmpty,
              timeout.isFinite, timeout > 0, timeout <= 60000 else {
            call.reject("Invalid screenshot transport request", "invalid_request"); return nil
        }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout / 1000)
        request.httpMethod = method
        request.httpShouldHandleCookies = false
        if !bodyData.isEmpty { request.httpBody = bodyData }
        if let headers = call.getObject("headers") {
            var seen = Set<String>()
            for (name, value) in headers {
                let key = name.lowercased()
                guard ["authorization", "accept", "content-type"].contains(key), seen.insert(key).inserted,
                      let text = value as? String, text.utf8.count <= 1024,
                      !text.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else {
                    call.reject("Invalid screenshot transport headers", "invalid_request"); return nil
                }
                request.setValue(text, forHTTPHeaderField: name)
            }
        }
        if request.value(forHTTPHeaderField: "Content-Type") == nil {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = timeout / 1000
        configuration.timeoutIntervalForResource = timeout / 1000
        let owner = NativeScreenshotRequest(call, finished: finished)
        let session = URLSession(configuration: configuration, delegate: owner, delegateQueue: .main)
        owner.session = session
        owner.task = session.dataTask(with: request)
        return owner
    }

    func start() { task?.resume() }
    func cancel() { fail("cancelled") }

    private func fail(_ code: String = "transport_failed") {
        guard !settled else { return }
        settled = true
        bytes.removeAll(keepingCapacity: false)
        task?.cancel()
        task = nil
        session?.invalidateAndCancel()
        session = nil
        finishedCallback()
        call.reject("Screenshot transport failed", code)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
        fail("redirect_rejected")
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust {
            completionHandler(.performDefaultHandling, nil)
        } else { completionHandler(.cancelAuthenticationChallenge, nil) }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                    didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard !settled, let http = response as? HTTPURLResponse,
              !(300...399).contains(http.statusCode), response.expectedContentLength <= Int64(Self.limit) else {
            completionHandler(.cancel); fail(); return
        }
        status = http.statusCode
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard !settled else { return }
        guard bytes.count + data.count <= Self.limit else { fail("response_too_large"); return }
        bytes.append(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard !settled else { return }
        if let error { fail((error as NSError).code == NSURLErrorTimedOut ? "timeout" : "transport_failed"); return }
        guard status > 0, let body = String(data: bytes, encoding: .utf8) else { fail(); return }
        settled = true
        bytes.removeAll(keepingCapacity: false)
        self.task = nil
        session.finishTasksAndInvalidate()
        self.session = nil
        finishedCallback()
        call.resolve(["status": status, "statusText": HTTPURLResponse.localizedString(forStatusCode: status),
                      "body": body, "headers": "Content-Type: application/json\r\n"])
    }
}

/// A separate capability: no provider cookies, credentials, redirects or logging.
/// The Origin is a native assertion for the explicit relay, not browser proof.
private final class NativeSwopRequest: NSObject, URLSessionDataDelegate {
    private static let limit = 64 * 1024
    private let call: CAPPluginCall
    private var bytes = Data()
    private var status = 0
    private var session: URLSession?
    private var finished = false

    private init(_ call: CAPPluginCall) { self.call = call }

    static func start(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"),
              raw.range(of: #"^https://([A-Za-z0-9.-]+|\[[0-9a-fA-F:]+\])(:[0-9]{1,5})?/swop/(session|val)$"#, options: .regularExpression) != nil,
              let parts = URLComponents(string: raw), let url = parts.url,
              parts.host != nil, parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil,
              parts.port == nil || (1...65535).contains(parts.port!),
              let body = call.getString("body"), let data = body.data(using: .utf8), data.count <= limit,
              (try? JSONSerialization.jsonObject(with: data)) is [String: Any],
              let clientID = call.getString("clientId"),
              clientID.range(of: #"^[A-Za-z0-9._:-]{1,128}$"#, options: .regularExpression) != nil
        else { call.reject("Native remote text entry request failed"); return }

        var origin = parts
        origin.path = ""
        if origin.port == 443 { origin.port = nil }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
        request.httpMethod = "POST"
        request.httpBody = data
        request.httpShouldHandleCookies = false
        request.setValue(origin.string!, forHTTPHeaderField: "Origin")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(clientID, forHTTPHeaderField: "X-Swop-Client-Id")

        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCredentialStorage = nil
        config.urlCache = nil
        config.timeoutIntervalForRequest = 10
        config.timeoutIntervalForResource = 10
        let owner = NativeSwopRequest(call)
        let session = URLSession(configuration: config, delegate: owner, delegateQueue: nil)
        owner.session = session
        session.dataTask(with: request).resume()
    }

    private func fail(_ timeout: Bool = false) {
        guard !finished else { return }
        finished = true
        call.reject("Native remote text entry request failed", timeout ? "timeout" : nil)
        session?.invalidateAndCancel()
        session = nil
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
        fail()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust {
            completionHandler(.performDefaultHandling, nil)
        } else { completionHandler(.cancelAuthenticationChallenge, nil) }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                    didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse, !(300...399).contains(http.statusCode),
              response.expectedContentLength <= Int64(Self.limit) else {
            completionHandler(.cancel); fail(); return
        }
        status = http.statusCode
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard !finished else { return }
        guard bytes.count + data.count <= Self.limit else { fail(); return }
        bytes.append(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard !finished else { return }
        if let error = error { fail((error as NSError).code == NSURLErrorTimedOut); return }
        guard status > 0, let body = String(data: bytes, encoding: .utf8) else { fail(); return }
        finished = true
        call.resolve(["status": status, "statusText": HTTPURLResponse.localizedString(forStatusCode: status),
                      "body": body, "headers": "Content-Type: application/json\r\n"])
        session.finishTasksAndInvalidate()
        self.session = nil
    }
}
