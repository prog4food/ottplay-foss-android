#!/usr/bin/env python3
"""Compile the shipping Swift SWOP capability with a Capacitor call stub.
Only the Capacitor adapter and URLSession's protocol factory are substituted;
URL/header validation, streaming bounds, response/error settlement are production.
Requires macOS Swift/Foundation. No device, app build, or external network.
"""
from pathlib import Path
import subprocess
import tempfile
ROOT = Path(__file__).resolve().parents[1]
source = (ROOT / 'ios/App/App/Plugins/StalkerPortalPlugin.swift').read_text()
source = source[source.index('/// A separate capability:'):]
source = source.replace('let config = URLSessionConfiguration.ephemeral', 'let config = URLSessionConfiguration.ephemeral\n        config.protocolClasses = [FixtureProtocol.self]')
stub = r'''
import Foundation
class CAPPluginCall {
    let values: [String: String]
    var result: [String: Any]?
    var error: String?
    init(_ values: [String: String]) { self.values = values }
    func getString(_ key: String) -> String? { values[key] }
    func reject(_ message: String, _ code: String? = nil) { error = code ?? message }
    func resolve(_ value: [String: Any]) { result = value }
}
class FixtureProtocol: URLProtocol {
    static var requests: [URLRequest] = []
    static var status = 200
    static var chunks = [Data("{\"status\":\"ready\",\"value\":\"Привет\"}".utf8)]
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.requests.append(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: Self.status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type":"application/json", "Set-Cookie":"secret=value"])!
        client!.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        for chunk in Self.chunks { client?.urlProtocol(self, didLoad: chunk) }
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
func run(_ url: String = "https://relay.example:443/swop/session", body: String = "{}", id: String = "device-123") -> CAPPluginCall {
    let call = CAPPluginCall(["url":url, "body":body, "clientId":id])
    NativeSwopRequest.start(call)
    let deadline = Date().addingTimeInterval(2)
    while call.result == nil && call.error == nil && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
    assert(call.result != nil || call.error != nil, "unsettled native call")
    return call
}
'''
tests = r'''
let ok = run()
assert(ok.result?["status"] as? Int == 200)
assert((ok.result?["body"] as? String)?.contains("Привет") == true)
let request = FixtureProtocol.requests[0]
assert(request.httpMethod == "POST")
assert(request.value(forHTTPHeaderField: "Origin") == "https://relay.example")
assert(request.value(forHTTPHeaderField: "X-Swop-Client-Id") == "device-123")
assert(request.value(forHTTPHeaderField: "Authorization") == nil)
assert(request.value(forHTTPHeaderField: "Cookie") == nil)
assert(request.httpShouldHandleCookies == false)
assert((ok.result?["headers"] as? String)?.contains("Cookie") == false)
for bad in ["http://127.0.0.1/swop/session", "https://user:pass@relay.example/swop/session", "https://relay.example/swop/session?q=x", "https://relay.example/swop/session#x", "https://relay.example/x/../swop/session", "https://relay.example/swop/%73ession", "https://relay.example:0/swop/session", "https://relay.example:65536/swop/session", "https://relay.example/swop/a.php"] {
    let before = FixtureProtocol.requests.count
    assert(run(bad).error != nil, bad)
    assert(FixtureProtocol.requests.count == before)
}
assert(run(body:"[]").error != nil)
assert(run(body:"{\"draft\":\"" + String(repeating:"я",count:32768) + "\"}").error != nil)
assert(run(id:"bad\r\nheader").error != nil)
for value in [String(repeating:"界", count:8000), String(repeating:"\u{0001}", count:8000)] {
    let json = try! JSONSerialization.data(withJSONObject: ["status":"ready", "value":value])
    assert(json.count > 16384 && json.count <= 65536)
    FixtureProtocol.chunks = [json]
    let actual = run().result?["body"] as! String
    let decoded = try! JSONSerialization.jsonObject(with: Data(actual.utf8)) as! [String:String]
    assert(decoded["value"] == value)
}
FixtureProtocol.status = 403
assert(run().result?["status"] as? Int == 403)
FixtureProtocol.status = 307
assert(run().error != nil)
FixtureProtocol.status = 200
FixtureProtocol.chunks = [Data(repeating: 65, count: 32768), Data(repeating: 66, count: 32769)]
assert(run().error != nil)
FixtureProtocol.chunks = [Data([255])]
assert(run().error != nil)
print("PASS Swift native SWOP: success, fixed headers, URL/UTF8/request bounds, HTTP error, redirect and streaming response rejection")
'''
with tempfile.TemporaryDirectory(prefix='ott-native-swop-swift-') as directory:
    tmp = Path(directory)
    (tmp/'main.swift').write_text(stub + source + tests)
    subprocess.run(['swiftc','-swift-version','5','-module-cache-path',str(tmp/'modules'),str(tmp/'main.swift'),'-o',str(tmp/'test')],check=True)
    subprocess.run([str(tmp/'test')],check=True)
