#!/usr/bin/env python3
"""Execute the shipping iOS screenshot URLSession lane with a URLProtocol fixture.

The Capacitor adapter and URLSession protocol factory are the only replacements.
No app, simulator, real server, credential or screenshot is used.
"""
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
source = (ROOT / "ios/App/App/Plugins/StalkerPortalPlugin.swift").read_text()
source = source[source.index("/// Screenshot transport is isolated"):source.index("/// A separate capability:")]
source = source.replace("let configuration = URLSessionConfiguration.ephemeral", "let configuration = URLSessionConfiguration.ephemeral\n        configuration.protocolClasses = [FixtureProtocol.self]")

STUB = r'''
import Foundation
class CAPPluginCall {
    let values: [String: Any]
    var result: [String: Any]?
    var error: String?
    var settlements = 0
    init(_ values: [String: Any]) { self.values = values }
    func getString(_ key: String) -> String? { values[key] as? String }
    func getDouble(_ key: String) -> Double? { values[key] as? Double }
    func getObject(_ key: String) -> [String: Any]? { values[key] as? [String: Any] }
    func reject(_ message: String, _ code: String? = nil) { error = code ?? message; settlements += 1 }
    func resolve(_ value: [String: Any]) { result = value; settlements += 1 }
}
class FixtureProtocol: URLProtocol {
    static var requests: [URLRequest] = []
    static var status = 200
    static var chunks = [Data("{\"ok\":true}".utf8)]
    static var hold = false
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.requests.append(request)
        if Self.hold { return }
        let response = HTTPURLResponse(url: request.url!, statusCode: Self.status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type":"application/json", "Set-Cookie":"private=value"])!
        client!.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        for chunk in Self.chunks { client?.urlProtocol(self, didLoad: chunk) }
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
func pump(_ condition: () -> Bool) {
    let deadline = Date().addingTimeInterval(3)
    while !condition() && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
    assert(condition(), "Unsettled screenshot transport")
}
func values(_ url: String = "https://controller.example/api/responses") -> [String: Any] {
    ["url":url, "method":"POST", "body":"{}", "timeoutMs":1000.0,
     "headers":["Authorization":"Bearer fixture-token", "Content-Type":"application/json"]]
}
func run(_ input: [String: Any] = values()) -> CAPPluginCall {
    let call = CAPPluginCall(input)
    var finishes = 0
    let owner = NativeScreenshotRequest.make(call, finished: { finishes += 1 })
    owner?.start()
    pump { call.settlements > 0 }
    assert(call.settlements == 1)
    assert(finishes == (owner == nil ? 0 : 1))
    return call
}
'''
TESTS = r'''
let ok = run()
assert(ok.result?["status"] as? Int == 200)
assert(ok.result?["body"] as? String == "{\"ok\":true}")
assert(ok.result?["headers"] as? String == "Content-Type: application/json\r\n")
let sent = FixtureProtocol.requests.last!
assert(sent.httpMethod == "POST")
assert(sent.value(forHTTPHeaderField:"Authorization") == "Bearer fixture-token")
assert(sent.value(forHTTPHeaderField:"Cookie") == nil && sent.httpShouldHandleCookies == false)
assert(run().result != nil)
assert(FixtureProtocol.requests.last!.value(forHTTPHeaderField:"Cookie") == nil)
for url in ["http://localhost:1234/api/responses", "http://127.0.0.1:1234/api/responses", "http://[::1]:1234/api/responses"] {
    assert(run(values(url)).result != nil)
}
for url in ["http://192.168.1.1/api/responses", "http://127.1/api/responses", "http://localhost.example/api/responses",
            "https://user:secret@controller.example/api/responses", "https://controller.example/api/responses#fragment",
            "https://controller.example:0/api/responses", "https://controller.example:65536/api/responses",
            "https://controller.example/api/\nresponses", "https://controller.example\\@evil.example/api/responses"] {
    let before = FixtureProtocol.requests.count
    assert(run(values(url)).error != nil, url)
    assert(FixtureProtocol.requests.count == before)
}
for header in ["Cookie", "Proxy-Authorization", "Host", "X-Private"] {
    var input = values(); input["headers"] = [header:"must-not-send"]
    let before = FixtureProtocol.requests.count
    assert(run(input).error != nil && FixtureProtocol.requests.count == before)
}
var invalid = values(); invalid["headers"] = ["Authorization":"Bearer x\r\nCookie: secret"]
assert(run(invalid).error != nil)
invalid = values(); invalid["body"] = String(repeating:"я",count:1048577)
assert(run(invalid).error != nil)
invalid = values(); invalid["timeoutMs"] = Double.infinity
assert(run(invalid).error != nil)
invalid = values(); invalid["method"] = "DELETE"
assert(run(invalid).error != nil)
print("PASS Swift screenshot transport: HTTPS/exact-loopback policy, isolated headers/cookies, upload bounds")

FixtureProtocol.status = 403
assert(run().result?["status"] as? Int == 403)
FixtureProtocol.status = 307
assert(run().error != nil)
FixtureProtocol.status = 200
FixtureProtocol.chunks = [Data(repeating:65,count:1048576), Data(repeating:66,count:1048577)]
assert(run().error == "response_too_large")
FixtureProtocol.chunks = [Data([255])]
assert(run().error != nil)
print("PASS Swift screenshot transport: HTTP errors, redirect statuses, streamed 2MiB limit and invalid UTF-8")

let redirectCall = CAPPluginCall(values())
private let redirectOwner = NativeScreenshotRequest.make(redirectCall, finished:{})!
var redirectDenied = false
redirectOwner.urlSession(URLSession.shared, task:URLSession.shared.dataTask(with:URL(string:"https://controller.example")!),
    willPerformHTTPRedirection:HTTPURLResponse(url:URL(string:"https://controller.example")!,statusCode:307,httpVersion:nil,headerFields:[:])!,
    newRequest:URLRequest(url:URL(string:"https://other.example")!),completionHandler:{ redirectDenied = $0 == nil })
assert(redirectDenied && redirectCall.error == "redirect_rejected")
redirectOwner.cancel(); assert(redirectCall.settlements == 1)

FixtureProtocol.hold = true
let cancelled = CAPPluginCall(values())
var finished = 0
private let cancelledOwner = NativeScreenshotRequest.make(cancelled, finished: { finished += 1 })!
let before = FixtureProtocol.requests.count
cancelledOwner.start()
pump { FixtureProtocol.requests.count > before }
cancelledOwner.cancel(); cancelledOwner.cancel()
assert(cancelled.error == "cancelled" && cancelled.settlements == 1 && finished == 1)
RunLoop.current.run(until:Date().addingTimeInterval(0.05))
assert(cancelled.settlements == 1 && finished == 1)
print("PASS Swift screenshot transport: redirect callback denies destination and active cancellation settles once")
'''

with tempfile.TemporaryDirectory(prefix="ott-screenshot-transport-swift-") as temporary:
    work = Path(temporary)
    (work / "main.swift").write_text(STUB + source + TESTS)
    subprocess.run(["swiftc", "-swift-version", "5", "-module-cache-path", str(work / "modules"),
                    str(work / "main.swift"), "-o", str(work / "test")], check=True)
    subprocess.run([str(work / "test")], check=True, timeout=30)
