#!/usr/bin/env python3
"""Exercise the complete Swift proxy with Foundation HTTP fixtures, without a device."""

import ast
import os
import subprocess
import tempfile
from pathlib import Path
from native_standby_work_cases import swift_work_source

ROOT = Path(__file__).resolve().parents[1]


def main():
    # Reuse only the bridge double declaration, not the queue test's side effects.
    tree = ast.parse((ROOT / "tests/test_ios_command_queue.py").read_text())
    capacitor = next(
        ast.literal_eval(node.value)
        for node in tree.body
        if isinstance(node, ast.Assign)
        and any(isinstance(target, ast.Name) and target.id == "CAP" for target in node.targets)
    )
    capacitor = capacitor.replace(
        "public var error: String?", "public var error: String?; public var finished = false"
    ).replace("ready.signal()", "finished = true; ready.signal()")
    capacitor = capacitor.replace(
        "public init(_ values:",
        "public var options: [String: Any] { values }\n    public init(_ values:",
    )
    capacitor = capacitor.replace("func reject(_ message: String)", "func reject(_ message: String, _ code: String? = nil)")
    swift = r"""
import Foundation
import Capacitor

class Fixture: URLProtocol {
    static var seen = 0
    static var cancelled = 0
    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host == "fixture.invalid"
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.seen += 1
        let path = request.url!.path
        if path == "/pending" { return }
        if path == "/transport" {
            client?.urlProtocol(self, didFailWithError: NSError(
                domain: NSURLErrorDomain, code: -1001,
                userInfo: [NSLocalizedDescriptionKey: "https://fixture.invalid/?token=DUMMY_SECRET"]
            ))
            return
        }
        if path == "/non-http" {
            let response = URLResponse(url: request.url!, mimeType: "text/plain", expectedContentLength: 2, textEncodingName: "utf-8")
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        } else {
            let status = Int(path.dropFirst()) ?? 200
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        }
        let bytes = path == "/invalid-utf8" ? Data([0xff, 0xfe]) : Data("#EXTM3U\n".utf8)
        client?.urlProtocol(self, didLoad: bytes)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { Self.cancelled += 1 }
}
URLCache.shared = URLCache(memoryCapacity: 0, diskCapacity: 0, diskPath: nil)
URLProtocol.registerClass(Fixture.self)
NativeWork.shared.setStandby(false)
let plugin = M3UProxyPlugin()
func request(_ url: String) -> CAPPluginCall {
    let call = CAPPluginCall(["url": url])
    plugin.proxyFetch(call)
    let deadline = Date().addingTimeInterval(5)
    while !call.finished && Date() < deadline {
        RunLoop.main.run(until: Date().addingTimeInterval(0.01))
    }
    precondition(call.finished, "Unsettled plugin request")
    return call
}
for status in [200, 206] {
    let call = request("@https://fixture.invalid/\(status)?token=DUMMY_SECRET")
    precondition(call.error == nil && call.result["body"] as? String == "#EXTM3U\n")
}
for status in [403, 404, 500] {
    let call = request("https://fixture.invalid/\(status)?password=DUMMY_SECRET")
    precondition(call.error == "Upstream \(status)" && call.result.isEmpty)
}
for path in ["transport", "non-http", "invalid-utf8"] {
    let call = request("https://fixture.invalid/\(path)?token=DUMMY_SECRET")
    precondition(call.error != nil && call.result.isEmpty)
    precondition(!call.error!.contains("DUMMY_SECRET"))
}
for url in ["file:///tmp/secret", "data:text/plain,secret", "relative.m3u", ""] {
    let call = request(url)
    precondition(call.error != nil && call.result.isEmpty)
}
let pending = CAPPluginCall(["url": "https://fixture.invalid/pending"])
let before = Fixture.seen
plugin.proxyFetch(pending)
var deadline = Date().addingTimeInterval(3)
while Fixture.seen == before && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.01)) }
precondition(Fixture.seen == before + 1)
NativeWork.shared.setStandby(true)
// A quick wake must not revive the already retired native request.
NativeWork.shared.setStandby(false)
deadline = Date().addingTimeInterval(3)
while !pending.finished && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.01)) }
precondition(pending.finished && pending.error != nil && pending.result.isEmpty)
precondition(Fixture.cancelled > 0 && NativeWork.shared.snapshot["pending"] as! Int == 0)
NativeWork.shared.setStandby(true)
let stoppedCount = Fixture.seen
let rejected = request("https://fixture.invalid/200")
precondition(rejected.error != nil && Fixture.seen == stoppedCount)
NativeWork.shared.setStandby(false)
precondition(request("https://fixture.invalid/200").error == nil)
print("PASS iOS native provider HTTP cancels actual transport, rejects standby admission and resumes cleanly")
print("PASS iOS proxy: HTTP 200/206 success, 403/404/500 failure, transport/non-HTTP/encoding errors and rejected schemes")
"""
    with tempfile.TemporaryDirectory(prefix="ott-ios-proxy-") as directory:
        temp = Path(directory)
        (temp / "Capacitor.swift").write_text(capacitor)
        (temp / "main.swift").write_text(swift_work_source() + swift)
        env = {**os.environ, "CLANG_MODULE_CACHE_PATH": str(temp / "modules")}
        subprocess.run(
            [
                "swiftc",
                "-swift-version",
                "5",
                "-emit-library",
                "-emit-module",
                "-module-name",
                "Capacitor",
                str(temp / "Capacitor.swift"),
                "-o",
                str(temp / "libCapacitor.dylib"),
            ],
            cwd=temp,
            env=env,
            check=True,
        )
        subprocess.run(
            [
                "swiftc",
                "-swift-version",
                "5",
                "-I",
                str(temp),
                "-L",
                str(temp),
                "-lCapacitor",
                "-Xlinker",
                "-rpath",
                "-Xlinker",
                str(temp),
                str(ROOT / "ios/App/App/M3UProxy.swift"),
                str(temp / "main.swift"),
                "-o",
                str(temp / "probe"),
            ],
            cwd=temp,
            env=env,
            check=True,
        )
        result = subprocess.run([str(temp / "probe")], capture_output=True, text=True, check=True, timeout=30)
        assert "DUMMY_SECRET" not in result.stdout + result.stderr, "Provider credentials leaked into logs"
        print(result.stdout.strip())


if __name__ == "__main__":
    main()
