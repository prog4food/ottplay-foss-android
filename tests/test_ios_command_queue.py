#!/usr/bin/env python3
"""Compile the complete shipped Swift queue against a tiny Capacitor bridge double.

Uses the real Foundation/Network runtime on macOS; no app build or simulator.
Exercises the production byte parser, queue calls, and an explicit loopback listener.
"""
from pathlib import Path
import os
import socket
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
CAP = r'''
import Foundation
open class CAPPlugin: NSObject { public override init() { super.init() }; open func load() {} }
public protocol CAPBridgedPlugin {}
public let CAPPluginReturnPromise = "promise"
public struct CAPPluginMethod { public init(name: String, returnType: String) {} }
public class CAPPluginCall: NSObject {
    public var values: [String: Any]
    public var result: [String: Any] = [:]
    public var error: String?
    private let ready = DispatchSemaphore(value: 0)
    public init(_ values: [String: Any] = [:]) { self.values = values }
    public func getBool(_ key: String) -> Bool? { values[key] as? Bool }
    public func getString(_ key: String) -> String? { values[key] as? String }
    public func getObject(_ key: String) -> [String: Any]? { values[key] as? [String: Any] }
    public func resolve(_ data: [String: Any] = [:]) { result = data; ready.signal() }
    public func reject(_ message: String) { error = message; ready.signal() }
    public func wait() { precondition(ready.wait(timeout: .now() + 7) == .success, "Unsettled plugin call") }
}
'''
MAIN = r'''
import Foundation
import Capacitor
let token = "0123456789abcdefghijklmnopqrstuvwxyz_AB"
let body = Data("{\"text\":\"Привет ✓\"}".utf8)
let header = Data("POST /api/webhook/commands HTTP/1.1\r\nAuthorization: Bearer \(token)\r\ncontent-length: \(body.count)\r\n\r\n".utf8)
let request = header + body
for length in 0..<request.count {
    guard case .incomplete = QueueHTTPRequest.parse(request.prefix(length), token: token) else { fatalError("Premature body parse at \(length)") }
}
guard case .request(let parsed) = QueueHTTPRequest.parse(request, token: token) else { fatalError("Valid body rejected") }
precondition(parsed.body == body && parsed.method == "POST")
func rejected(_ source: String, _ expected: Int) {
    guard case .rejected(let status) = QueueHTTPRequest.parse(Data(source.utf8), token: token), status == expected else { fatalError("Expected \(expected)") }
}
rejected("GET /api/webhook/commands HTTP/1.1\r\n\r\n", 401)
rejected("GET / HTTP/1.1\r\nAuthorization: Bearer wrong\r\n\r\n", 401)
let authorized = "POST /api/webhook/commands HTTP/1.1\r\nAuthorization: Bearer \(token)\r\n"
for malformed in ["Content-Length: -1", "Content-Length: X", "Content-Length: 2\r\ncontent-length: 3", "Transfer-Encoding: chunked"] {
    rejected(authorized + malformed + "\r\n\r\n", 400)
}
rejected(authorized + "Content-Length: 65537\r\n\r\n", 413)
rejected(authorized + "X-Large: " + String(repeating: "x", count: 8192) + "\r\n\r\n", 431)
let queue = MobileCommandQueue()
queue.load()
let initial = CAPPluginCall(); queue.start(initial); initial.wait()
precondition(initial.result["port"] as? Int == 0 || initial.result["port"] as? UInt16 == 0)
precondition(initial.result["httpEnabled"] as? Bool == false)
let post = CAPPluginCall(["data": ["text": "internal"]]); queue.post(post); post.wait()
let get = CAPPluginCall(); queue.get(get); get.wait()
precondition((get.result["commands"] as? [[String: Any]])?.first?["text"] as? String == "internal")
let noToken = CAPPluginCall(["httpEnabled": true]); queue.start(noToken); noToken.wait(); precondition(noToken.error != nil)
let start = CAPPluginCall(["httpEnabled": true, "token": token]); queue.start(start); start.wait(); precondition(start.error == nil)
precondition(start.result["httpEnabled"] as? Bool == true)
let port = ProcessInfo.processInfo.environment["OTTPLAY_QUEUE_PORT"]!
func http(_ authorized: Bool, code: String = token) -> Int {
    let done = DispatchSemaphore(value: 0)
    var status = 0
    var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/api/webhook/commands")!, timeoutInterval: 5)
    request.httpMethod = "POST"; request.httpBody = body
    if authorized { request.setValue("Bearer \(code)", forHTTPHeaderField: "Authorization") }
    URLSession.shared.dataTask(with: request) { _, response, _ in
        status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if let response = response as? HTTPURLResponse { precondition(response.value(forHTTPHeaderField: "Access-Control-Allow-Origin") == nil) }
        done.signal()
    }.resume()
    precondition(done.wait(timeout: .now() + 6) == .success)
    return status
}
precondition(http(false) == 401)
precondition(http(true) == 200)
let drain = CAPPluginCall(); queue.get(drain); drain.wait()
precondition((drain.result["commands"] as? [[String: Any]])?.first?["text"] as? String == "Привет ✓")
var accepted = 0
for _ in 0..<20 {
    let large = CAPPluginCall(["data": ["text": String(repeating: "x", count: 65000)]])
    queue.post(large); large.wait()
    if large.error == nil { accepted += 1 }
}
precondition(accepted > 0 && accepted <= 16)
let clear = CAPPluginCall(); queue.get(clear); clear.wait()
precondition((clear.result["commands"] as? [[String: Any]])?.count == accepted)
let stop = CAPPluginCall(); queue.stop(stop); stop.wait()
let status = CAPPluginCall(); queue.isRunning(status); status.wait()
precondition(status.result["httpEnabled"] as? Bool == false)
precondition(http(true) == 0, "Stop must close the listening port")
let rotatedToken = String(repeating: "b", count: 64)
let rotated = CAPPluginCall(["httpEnabled": true, "token": rotatedToken])
queue.start(rotated); rotated.wait(); precondition(rotated.error == nil)
precondition(http(true) == 401, "Old code must be revoked")
precondition(http(true, code: rotatedToken) == 200)
let finalStop = CAPPluginCall(); queue.stop(finalStop); finalStop.wait()
let finalDrain = CAPPluginCall(); queue.get(finalDrain); finalDrain.wait()
precondition((finalDrain.result["commands"] as? [[String: Any]])?.isEmpty == true)
print("PASS Swift native queue: full plugin compile, internal-only startup, all body splits, UTF-8 byte lengths, bounded framing/auth, actual authorized/unauthorized loopback and stop")
'''
with tempfile.TemporaryDirectory(prefix="ott-swift-queue-") as directory:
    temp = Path(directory)
    (temp / "Capacitor.swift").write_text(CAP)
    (temp / "main.swift").write_text(MAIN)
    subprocess.run(["swiftc", "-swift-version", "5", "-emit-library", "-emit-module", "-module-name", "Capacitor", str(temp / "Capacitor.swift"), "-o", str(temp / "libCapacitor.dylib")], cwd=temp, check=True)
    subprocess.run(["swiftc", "-swift-version", "5", "-I", str(temp), "-L", str(temp), "-lCapacitor", "-Xlinker", "-rpath", "-Xlinker", str(temp), str(ROOT / "ios/App/App/Plugins/MobileCommandQueue.swift"), str(temp / "main.swift"), "-o", str(temp / "queue")], check=True)
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0)); port = probe.getsockname()[1]
    subprocess.run([str(temp / "queue")], env={**os.environ, "OTTPLAY_QUEUE_PORT": str(port)}, check=True, timeout=30)
