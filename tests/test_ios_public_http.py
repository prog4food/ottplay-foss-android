#!/usr/bin/env python3
"""Exercise bounded public iOS HTTP on the real shared Foundation session.

URLProtocol supplies all responses; no device, provider or real network is used.
"""
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SWIFT = r'''
import Foundation

final class PublicFixture: URLProtocol {
    static let lock = NSLock()
    static var seen: [URLRequest] = []
    static var pending: [String: PublicFixture] = [:]
    static var stopped = Set<String>()
    static func requests() -> [URLRequest] { lock.lock(); defer { lock.unlock() }; return seen }
    static func waiting(_ path: String) -> Bool { lock.lock(); defer { lock.unlock() }; return pending[path] != nil }
    static func wasStopped(_ path: String) -> Bool { lock.lock(); defer { lock.unlock() }; return stopped.contains(path) }
    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host?.hasSuffix(".fixture.invalid") == true
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock(); Self.seen.append(request); Self.lock.unlock()
        let path = request.url!.path
        if path.hasPrefix("/pending") {
            Self.lock.lock(); Self.pending[path] = self; Self.lock.unlock()
            return
        }
        if path == "/redirect" {
            let next = URL(string: "http://other.fixture.invalid/small")!
            let response = HTTPURLResponse(url: request.url!, statusCode: 302, httpVersion: "HTTP/1.1",
                headerFields: ["Location": next.absoluteString])!
            client?.urlProtocol(self, wasRedirectedTo: URLRequest(url: next), redirectResponse: response)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocolDidFinishLoading(self)
            return
        }
        var headers = ["Content-Type": "application/octet-stream"]
        var chunks = [Data([1, 2, 3, 4])]
        switch path {
        case "/known-large":
            headers["Content-Length"] = "9" // Reject headers even though delivered body is small.
        case "/chunked-large":
            chunks = [Data(repeating: 1, count: 5), Data(repeating: 2, count: 4)]
        case "/decoded-large":
            // Emulate delivered/decompressed bytes exceeding the encoded length.
            headers["Content-Length"] = "1"
            chunks = [Data(repeating: 3, count: 9)]
        case "/exact":
            headers["Content-Length"] = "8"
            chunks = [Data(repeating: 1, count: 4), Data(repeating: 2, count: 4)]
        case "/empty":
            headers["Content-Length"] = "0"
            chunks = []
        default:
            headers["Content-Length"] = "4"
        }
        respond(headers: headers, chunks: chunks)
    }
    private func respond(headers: [String: String], chunks: [Data]) {
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        for chunk in chunks { client?.urlProtocol(self, didLoad: chunk) }
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {
        Self.lock.lock()
        Self.stopped.insert(request.url!.path)
        Self.pending[request.url!.path] = nil
        Self.lock.unlock()
    }
    static func finish(_ path: String) {
        lock.lock(); let fixture = pending.removeValue(forKey: path); lock.unlock()
        guard let fixture else { fatalError("Missing pending fixture") }
        fixture.respond(headers: ["Content-Length": "4"], chunks: [Data([1, 2, 3, 4])])
    }
}

func request(_ path: String, scheme: String = "https") -> URLRequest {
    URLRequest(url: URL(string: "\(scheme)://public.fixture.invalid\(path)")!)
}
func until(_ predicate: () -> Bool) async throws {
    let deadline = Date().addingTimeInterval(3)
    while !predicate() && Date() < deadline { try await Task.sleep(nanoseconds: 1_000_000) }
    assert(predicate(), "Missing asynchronous fixture event")
}
func oversized(_ path: String) async throws {
    do {
        _ = try await AccessMediaPublicHTTP.fetch(request(path), limit: 8)
        fatalError("Oversized public body accepted: \(path)")
    } catch let error as URLError {
        assert(error.code == .dataLengthExceedsMaximum, "Wrong limit error: \(error)")
    }
}

URLProtocol.registerClass(PublicFixture.self)
var finished = false
Task { @MainActor in
    do {
        for scheme in ["http", "https"] {
            var input = request("/small", scheme: scheme)
            input.setValue("public_fixture=1", forHTTPHeaderField: "Cookie")
            input.setValue("Bearer TEST_ONLY", forHTTPHeaderField: "Authorization")
            let (data, response) = try await AccessMediaPublicHTTP.fetch(input, limit: 8)
            assert(data == Data([1, 2, 3, 4]) && response.url == input.url)
            let received = PublicFixture.requests().last!
            assert(received.value(forHTTPHeaderField: "Cookie") == "public_fixture=1")
            assert(received.value(forHTTPHeaderField: "Authorization") == "Bearer TEST_ONLY")
        }
        let (redirected, final) = try await AccessMediaPublicHTTP.fetch(request("/redirect"), limit: 8)
        assert(redirected == Data([1, 2, 3, 4]))
        assert(final.url?.absoluteString == "http://other.fixture.invalid/small",
            "Public cross-origin redirects and HTTP must retain the shared session defaults")
        let (exact, _) = try await AccessMediaPublicHTTP.fetch(request("/exact"), limit: 8)
        assert(exact.count == 8)
        let (empty, _) = try await AccessMediaPublicHTTP.fetch(request("/empty"), limit: 0)
        assert(empty.isEmpty)

        // Limits and cancellation own one task, never the shared session or peers.
        let neighbor = Task { try await AccessMediaPublicHTTP.fetch(request("/pending-neighbor"), limit: 8) }
        try await until { PublicFixture.waiting("/pending-neighbor") }
        for path in ["/known-large", "/chunked-large", "/decoded-large"] { try await oversized(path) }
        assert(PublicFixture.waiting("/pending-neighbor") && !PublicFixture.wasStopped("/pending-neighbor"))

        let cancelled = Task { try await AccessMediaPublicHTTP.fetch(request("/pending-cancel"), limit: 8) }
        try await until { PublicFixture.waiting("/pending-cancel") }
        cancelled.cancel()
        do { _ = try await cancelled.value; fatalError("Cancelled request succeeded") }
        catch is CancellationError {}
        try await until { PublicFixture.wasStopped("/pending-cancel") }
        assert(PublicFixture.waiting("/pending-neighbor") && !PublicFixture.wasStopped("/pending-neighbor"))
        PublicFixture.finish("/pending-neighbor")
        let (neighborData, _) = try await neighbor.value
        assert(neighborData == Data([1, 2, 3, 4]))

        let count = PublicFixture.requests().count
        let early = Task { try await AccessMediaPublicHTTP.fetch(request("/never-started"), limit: 8) }
        early.cancel()
        do { _ = try await early.value; fatalError("Early cancellation succeeded") }
        catch is CancellationError {}
        assert(PublicFixture.requests().count == count)

        let late = Task { try await AccessMediaPublicHTTP.fetch(request("/small"), limit: 8) }
        let (lateData, _) = try await late.value
        late.cancel()
        let (sameData, _) = try await late.value
        assert(lateData == sameData && sameData.count == 4)
        // Let completion-after-cancel callbacks drain: duplicate continuation
        // resumption would trap, while a subsequent shared request must succeed.
        try await Task.sleep(nanoseconds: 20_000_000)
        let (after, _) = try await AccessMediaPublicHTTP.fetch(request("/small"), limit: 8)
        assert(after.count == 4)
        print("PASS: bounded shared public HTTP, exact/header/chunked/decoded bounds, redirects, credentials, early/in-flight/late cancellation, isolated concurrent transfer")
        finished = true
    } catch { fatalError("Public HTTP fixture failed: \(error)") }
}
let deadline = Date().addingTimeInterval(12)
while !finished && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.005)) }
assert(finished, "Timed out")
'''

with tempfile.TemporaryDirectory(prefix="ottplay-public-http-test-") as directory:
    path = Path(directory)
    (path / "main.swift").write_text(SWIFT)
    subprocess.run(["swiftc", str(ROOT / "ios/App/App/Plugins/AccessMediaPolicy.swift"),
                    str(path / "main.swift"), "-o", str(path / "test")], check=True)
    subprocess.run([str(path / "test")], check=True, timeout=20)
