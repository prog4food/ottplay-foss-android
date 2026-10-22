"""Bounded local XMLTV regressions against the shipping Swift adapter."""
import base64
import gzip


def resource_methods():
    def encoded(size):
        prefix = '<tv><channel id="a"><display-name>Safe</display-name></channel><!--'
        suffix = '--></tv>'
        xml = prefix + 'x' * (size - len(prefix) - len(suffix)) + suffix
        return base64.b64encode(gzip.compress(xml.encode(), mtime=0)).decode()

    return r'''
    func runResourceTests() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir); URLSession.shared.reset() }
        xmlTemporaryDirectory = dir
        cacheURL = dir.appendingPathComponent("cache.gz")
        metaURL = dir.appendingPathComponent("cache.meta")
        let source = URL(string: "https://resource.invalid/guide.gz")!
        let small = Data("<tv><channel id=\"a\"><display-name>Safe</display-name></channel></tv>".utf8)
        let exact = Data(base64Encoded: "EXACT_GZIP")!
        let over = Data(base64Encoded: "OVER_GZIP")!
        func assertClean() {
            assert(!(try! FileManager.default.contentsOfDirectory(atPath: dir.path)).contains { $0.hasPrefix("ottplay-xmltv-") })
        }
        func expectSize(_ operation: () throws -> Void) {
            do { try operation(); assertionFailure("oversized XMLTV must throw") }
            catch { assert((error as NSError).domain == "MobileXmltvEpg" && (error as NSError).code == -5) }
            assertClean()
        }
        inputByteLimit = 2048; expandedByteLimit = 1024
        try autoreleasepool {
            let document = try prepareXmltv(exact)
            assert((try! FileManager.default.attributesOfItem(atPath: document.url.path)[.size] as! NSNumber).intValue == 1024)
            assert((try! FileManager.default.attributesOfItem(atPath: document.url.path)[.posixPermissions] as! NSNumber).intValue == 0o600)
            assert(try parseXmltv(document).channels["a"] == "Safe")
            // The same owned file supports the shared policy's second parse.
            assert(try parseXmltv(document).channels["a"] == "Safe")
        }
        assertClean()
        expectSize { _ = try prepareXmltv(over) }
        let plain = Data(("<tv><!--" + String(repeating: "x", count: 1007) + "--></tv>").utf8)
        assert(plain.count == 1023)
        try autoreleasepool { _ = try prepareXmltv(plain + Data(" ".utf8)) }
        expectSize { _ = try prepareXmltv(plain + Data("  ".utf8)) }
        inputByteLimit = exact.count
        try autoreleasepool { _ = try prepareXmltv(exact) }
        expectSize { _ = try prepareXmltv(exact + Data([0])) }
        inputByteLimit = small.count
        try autoreleasepool { _ = try prepareXmltv(small) }
        expectSize { _ = try prepareXmltv(small + Data(" ".utf8)) }
        inputByteLimit = 2048
        for damaged in [Data(exact.dropLast(1)), Data([0x1f, 0x8b, 0]), Data("not XML".utf8), Data([0x3c, 0xc3])] {
            do { _ = try prepareXmltv(damaged); assertionFailure("invalid XMLTV must fail") }
            catch { assert((error as NSError).code == -2) }
            assertClean()
        }
        inputByteLimit = 256 * 1024; expandedByteLimit = 256 * 1024
        for scalar in ["é", "€", "😀"] {
            for split in 1..<scalar.utf8.count {
                let prefix = "<tv><!--"
                let text = prefix + String(repeating: "x", count: 65536 - prefix.utf8.count - split) + scalar + "--><channel id=\"a\"/></tv>"
                try autoreleasepool {
                    let document = try prepareXmltv(Data(text.utf8))
                    assert(try parseXmltv(document).channels["a"] == "a")
                }
                assertClean()
            }
        }
        // Declared external entities must never read even a local file.
        let secret = dir.appendingPathComponent("entity.txt")
        try "do not load".write(to: secret, atomically: true, encoding: .utf8)
        let external = "<!DOCTYPE tv [<!ENTITY ext SYSTEM '\(secret.absoluteString)'>]><tv><channel id='a'><display-name>&ext;</display-name></channel></tv>"
        try autoreleasepool {
            let parsed = try parseXmltv(prepareXmltv(Data(external.utf8)))
            assert(parsed.channels["a"] != "do not load")
        }
        assertClean()

        inputByteLimit = 2048; expandedByteLimit = 1024
        URLSession.shared.reset(); URLSession.shared.data = over; URLSession.shared.deferred = true
        let first = CAPPluginCall(source.absoluteString), joined = CAPPluginCall(source.absoluteString), forced = CAPPluginCall(source.absoluteString)
        getChannels(first); getEpg(joined); prefetch(forced)
        assert(URLSession.shared.requests == 1 && pendingSources[source.absoluteString]?.count == 3)
        URLSession.shared.releaseOne()
        for call in [first, joined, forced] {
            assert(call.rejectCount == 1 && call.resolveCount == 0)
            assert(call.rejection == "XMLTV expanded document exceeds size limit")
        }
        assert(pendingSources.isEmpty && parsedCache.isEmpty)
        assert(!FileManager.default.fileExists(atPath: cacheURL.path)); assertClean()

        // A rejected replacement must preserve the healthy same-source cache.
        try writeCache(small, for: source)
        try "0\n\(source.absoluteString)".write(to: metaURL, atomically: true, encoding: .utf8)
        URLSession.shared.reset(); URLSession.shared.data = over
        let fallback = CAPPluginCall(source.absoluteString); getChannels(fallback)
        assert(fallback.resolveCount == 1 && fallback.rejectCount == 0)
        assert((fallback.result["channels"] as! [[String: Any]])[0]["name"] as! String == "Safe")
        assert(try Data(contentsOf: cacheURL) == small); assertClean()

        // Oversized disk payload/metadata are refused before whole-file reads;
        // a healthy replacement still follows the existing source policy.
        for metadata in [false, true] {
            parsedCache.removeAll(); URLSession.shared.reset(); URLSession.shared.data = small
            try writeCache(small, for: source)
            if metadata { try Data(repeating: 32, count: metadataByteLimit + 1).write(to: metaURL) }
            else { try Data(repeating: 32, count: inputByteLimit + 1).write(to: cacheURL) }
            let recovered = CAPPluginCall(source.absoluteString); getChannels(recovered)
            assert(recovered.resolveCount == 1 && recovered.rejectCount == 0 && URLSession.shared.requests == 1)
            assert(try Data(contentsOf: cacheURL) == small); assertClean()
        }
        // Exercise real cache-write failure after creating and parsing the file.
        parsedCache.removeAll(); URLSession.shared.reset(); URLSession.shared.data = small
        try FileManager.default.removeItem(at: cacheURL)
        try FileManager.default.createDirectory(at: cacheURL, withIntermediateDirectories: false)
        try Data([1]).write(to: cacheURL.appendingPathComponent("keep nonempty"))
        let writeFailed = CAPPluginCall(source.absoluteString); prefetch(writeFailed)
        assert(writeFailed.rejectCount == 1 && writeFailed.resolveCount == 0 && pendingSources.isEmpty)
        assert(parsedCache.isEmpty); assertClean()
        try FileManager.default.removeItem(at: cacheURL)

        // Preserve the policy's second parse and original VM error; the expanded
        // document must be removed even though network parsing and writing passed.
        URLSession.shared.reset(); URLSession.shared.data = small
        FixtureJavaScript.remaining = 1
        let parseFailed = CAPPluginCall(source.absoluteString); prefetch(parseFailed)
        FixtureJavaScript.remaining = nil
        assert(parseFailed.rejectCount == 1 && parseFailed.resolveCount == 0)
        assert(parseFailed.rejection == "Cannot create shared guide context")
        assert(parsedCache.isEmpty && pendingSources.isEmpty); assertClean()
        print("PASS Swift XMLTV input/expanded limits, UTF-8 boundaries, external entities, callbacks/fallback and temporary-file cleanup")
    }
'''.replace("EXACT_GZIP", encoded(1024)).replace("OVER_GZIP", encoded(1025)).replace("assert(try ", "assert(try! ")


RESOURCE_STUBS = r'''
private final class XmltvHTTPFixture: URLProtocol {
    static var stopped = 0
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let path = request.url!.path
        var headers = ["Content-Type": "application/xml"]
        if path == "/declared" { headers["Content-Length"] = "33" }
        if path == "/exact" { headers["Content-Length"] = "32" }
        client!.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!, cacheStoragePolicy: .notAllowed)
        for _ in 0..<(path == "/exact" ? 2 : 3) { client!.urlProtocol(self, didLoad: Data(repeating: 32, count: 16)) }
        client!.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { Self.stopped += 1 }
}
private func runDownloadResourceTests() throws {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [XmltvHTTPFixture.self]
    for path in ["/declared", "/chunked", "/exact"] {
        let done = DispatchSemaphore(value: 0)
        var callbacks = 0
        XmltvDownload.start(URLRequest(url: URL(string: "https://resource.invalid" + path)!), limit: 32, configuration: config) { data, _, error in
            callbacks += 1
            if path == "/exact" { assert(error == nil && data?.count == 32) }
            else { assert(data == nil && (error as NSError?)?.code == -5) }
            done.signal()
        }
        assert(done.wait(timeout: .now() + 5) == .success && callbacks == 1)
    }
    assert(XmltvHTTPFixture.stopped > 0)
    print("PASS Swift standalone XMLTV URLSession delegate rejects declared/chunked over-limit bodies and accepts the exact limit")
}
'''
