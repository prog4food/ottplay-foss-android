#!/usr/bin/env python3
"""Run native cache regressions with Swift and Kotlin/JVM (no mobile SDK/build).

The actual plugin sources are compiled with small Capacitor/network stubs. Only
platform imports/annotations, clock, HTTP delivery and VM allocation are adapted;
cache decisions, parser branches and callback code are unchanged.
Requires swift, kotlinc and java on PATH. Run: python3 tests/test_native_epg_cache.py
Use --check-sources-only for the source ownership guard without native compilers.
"""

import argparse
import base64
import gzip
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
from native_epg_policy_cases import methods
from native_epg_fallback_cases import fallback_methods
from native_epg_resource_cases import resource_methods, RESOURCE_STUBS
from native_epg_index_cases import index_methods, instrument_index
from native_android_epg_resource_cases import KOTLIN_ADAPTERS, KOTLIN_RESOURCE_TESTS
from native_epg_standby_cases import SWIFT_STANDBY_TESTS, KOTLIN_STANDBY_TESTS

ROOT = pathlib.Path(__file__).resolve().parents[1]
XML = '<tv><channel id="a"><display-name>Feed A</display-name></channel></tv>'
GZIP = base64.b64encode(gzip.compress(XML.encode())).decode()


def run(*args, cwd):
    subprocess.run(args, cwd=cwd, check=True)


def check_shipping_sources():
    receipt = json.loads((ROOT / "vendor/ottplay-core.manifest.json").read_text())
    for name in ("ottplay-core.js", "ottplay-core.jar", "ottplay-core.LICENSE.txt"):
        assert hashlib.sha256((ROOT / "vendor" / name).read_bytes()).hexdigest() == receipt["artifacts"][name]["sha256"], name
    # The iOS target and JVM fixtures must use one source per adapter.
    obsolete = (
        "ios/App/CapApp-SPM/Sources/CapApp-SPM/MobileXmltvEpg.swift",
        "android/app/src/main/java/play/ott/foss/plugin/MobileXmltvEpgPlugin.kt",
    )
    for duplicate in obsolete:
        if (ROOT / duplicate).exists():
            raise AssertionError(f"Duplicate native source reintroduced: {duplicate}")
    for path, required in (
        ("mobile-xmltv-epg/src/ios/MobileXmltvEpg.swift", (
            "nativeGuideLoadStart", "nativeGuideLoadNext", "NativeGuideSourceBatch", "XmltvRecords", "nativeXmltvOrder")),
        ("mobile-xmltv-epg/src/android/play/ott/foss/plugin/MobileXmltvEpgPlugin.kt", (
            "NativeSourceLoad.start", "NativeSourceLoad.next", "NativeSourceBatch(", "XmltvRecords(", "NativeRecordRules.order")),
    ):
        source = (ROOT / path).read_text()
        for api in required:
            assert api in source, f"Native load policy must use {api}: {path}"
        assert "firstError" not in source, f"Native batch failure policy reintroduced: {path}"
        assert "currentProgTitle" not in source and "currentProgChannel" not in source, f"Native XMLTV record reducer reintroduced: {path}"
    project = (ROOT / "ios/App/App.xcodeproj/project.pbxproj").read_text()
    if '../../../mobile-xmltv-epg/src/ios/MobileXmltvEpg.swift' not in project:
        raise AssertionError("iOS must compile the canonical XMLTV adapter")
    if project.count('E6D5F404FEDC1B000F3C39F /* MobileXmltvEpg.swift in Sources */') != 2:
        raise AssertionError("Canonical XMLTV adapter must appear once in the iOS Sources phase")
    print("PASS native XMLTV adapters have one source and iOS compiles it directly", flush=True)


SWIFT_STUBS = r"""
import Foundation
public class CAPPlugin: NSObject {}
public protocol CAPBridgedPlugin {}
public struct CAPPluginMethod { init(name: String, returnType: String) {} }
let CAPPluginReturnPromise = "promise"
enum FixtureClock { static var now: TimeInterval = 1000000 }
// Model a platform VM allocation failure without modifying parser/load branches.
enum FixtureJavaScript {
    static var remaining: Int?
    static func context() -> JSContext? {
        if let count = remaining {
            if count == 0 { return nil }
            remaining = count - 1
        }
        return JSContext()
    }
}
class CAPPluginCall {
    let source: String
    var values: [String: Any] = [:]
    var result: [String: Any] = [:]
    var resolved = false
    var rejected = false
    var resolveCount = 0
    var rejectCount = 0
    var rejection = ""
    init(_ source: String) { self.source = source }
    func getString(_ key: String) -> String? { key == "xmltv_url" ? source : values[key] as? String }
    func getArray<T>(_ key: String, _ ofType: T.Type) -> [T]? { values[key] as? [T] }
    func getInt(_ key: String) -> Int? { values[key] as? Int }
    func resolve(_ result: [String: Any] = [:]) { resolveCount += 1; resolved = true; self.result = result }
    func reject(_ message: String) { rejectCount += 1; rejected = true; rejection = message }
}
class URLSession {
    static let shared = URLSession()
    var data: Data?
    var requests = 0
    var sources: [String: Data] = [:]
    var errors: [String: Error] = [:]
    var deferred = false
    var queue: [() -> Void] = []
    var requestUrls: [String] = []
    func releaseOne() { precondition(!queue.isEmpty); queue.removeFirst()() }
    func reset() { data = nil; requests = 0; sources = [:]; errors = [:]; deferred = false; queue = []; requestUrls = [] }
    class Task {
        let action: () -> Void
        init(_ action: @escaping () -> Void) { self.action = action }
        func resume() { action() }
    }
    func dataTask(with url: URL, completionHandler: @escaping (Data?, URLResponse?, Error?) -> Void) -> Task {
        requests += 1
        requestUrls.append(url.absoluteString)
        return Task {
            let action = {
                let body = self.sources[url.absoluteString] ?? self.data
                let error = self.errors[url.absoluteString] ?? (body == nil ? NSError(domain: "offline", code: 1) : nil)
                completionHandler(body, nil, error)
            }
            if self.deferred { self.queue.append(action) } else { action() }
        }
    }
}
"""

SWIFT_TESTS = r"""
    func runCacheTests() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        cacheURL = dir.appendingPathComponent("epg2.xml.gz")
        metaURL = dir.appendingPathComponent("epg2.meta")
        let a = URL(string: "https://a.invalid/feed.gz")!
        let b = URL(string: "https://b.invalid/feed.gz")!
        let data = Data(base64Encoded: "GZIP_FIXTURE")!
        let xml = String(data: gunzip(data)!, encoding: .utf8)!
        try writeCache(data, for: a)
        assert(try readCache(for: a) == xml)
        assert(try readCache(for: b) == nil)
        assert(try readCache(for: b, allowStale: true) == nil)
        let fresh = CAPPluginCall(a.absoluteString)
        getEpg(fresh)
        assert(fresh.resolved && !fresh.rejected && URLSession.shared.requests == 0)
        let other = CAPPluginCall(b.absoluteString)
        getEpg(other)
        assert(other.rejected && !other.resolved)
        try "0\n\(a.absoluteString)".write(to: metaURL, atomically: true, encoding: .utf8)
        assert(try readCache(for: a) == nil)
        assert(try readCache(for: a, allowStale: true) == xml)
        let stale = CAPPluginCall(a.absoluteString)
        getEpg(stale)
        assert(stale.resolved && !stale.rejected)
        URLSession.shared.data = Data("invalid gzip".utf8)
        let invalid = CAPPluginCall(b.absoluteString)
        getEpg(invalid)
        assert(invalid.rejected && !invalid.resolved)
        assert(try readCache(for: a, allowStale: true) == xml)
        prefetch(CAPPluginCall(b.absoluteString))
        assert(try readCache(for: a, allowStale: true) == xml)
        URLSession.shared.data = data
        prefetch(CAPPluginCall(b.absoluteString))
        assert(try readCache(for: b) == xml)
        assert(try readCache(for: a, allowStale: true) == nil)
        try "\(Date().timeIntervalSince1970)".write(to: metaURL, atomically: true, encoding: .utf8)
        assert(try readCache(for: b) == nil)
        assert(try readCache(for: b, allowStale: true) == nil)
        URLSession.shared.data = nil
        parsedCache.removeAll() // simulate restart after incompatible disk metadata
        let legacy = CAPPluginCall(b.absoluteString)
        getEpg(legacy)
        assert(legacy.rejected && !legacy.resolved)

        // A fresh same-source disk entry with invalid XML must refetch immediately.
        for damaged in [xml.replacingOccurrences(of: "</tv>", with: ""), "<html>upstream error</html>"] {
            parsedCache.removeAll()
            try writeCache(Data(damaged.utf8), for: a)
            URLSession.shared.data = data
            let before = URLSession.shared.requests
            let recovered = CAPPluginCall(a.absoluteString)
            getChannels(recovered)
            assert(recovered.resolved && !recovered.rejected)
            assert(URLSession.shared.requests == before + 1)
            assert((recovered.result["channels"] as! [[String: Any]])[0]["id"] as! String == "a")
            assert(try readCache(for: a) == xml)
        }
        parsedCache.removeAll()
        try writeCache(Data("<tv>".utf8), for: a)
        URLSession.shared.data = nil
        let unrecoverable = CAPPluginCall(a.absoluteString)
        getChannels(unrecoverable)
        assert(unrecoverable.rejected && !unrecoverable.resolved && parsedCache[a.absoluteString] == nil)
        print("PASS Swift corrupted disk XML: refetch healthy network; offline rejects without poisoning memory")

        // Native source selection, XML metadata, regional shifts and shared index/EPG cache.
        let now = Int(Date().timeIntervalSince1970)
        let format = DateFormatter(); format.dateFormat = "yyyyMMddHHmmss Z"; format.timeZone = TimeZone(secondsFromGMT: 0)
        let start = format.string(from: Date(timeIntervalSince1970: Double(now)))
        let stop = format.string(from: Date(timeIntervalSince1970: Double(now + 3600)))
        let fixture = "<tv><channel id=\"wanted\"><display-name>Original &amp; A</display-name><display-name>Alias</display-name><icon src=\"https://icons.test/a.png\"/></channel><channel id=\"wrong\"><display-name>Private</display-name></channel><programme channel=\"wanted\" start=\"\(start)\" stop=\"\(stop)\"><title><![CDATA[Morning & News]]></title><desc>Details</desc></programme></tv>"
        let parsed = try parseXmltv(fixture)
        assert(parsed.names["wanted"] == ["Original & A", "Alias"])
        assert(parsed.icons["wanted"] == "https://icons.test/a.png")
        let guide = try SharedGuide()
        let guideRows = parsed.channels.keys.sorted().flatMap { id in (parsed.names[id] ?? [parsed.channels[id]!]).map { [id, $0] } }
        let guideIndex = try guide.index(guideRows)
        assert(try! guide.resolve(guideIndex, id: "wanted", names: ["", "Private +4"]) == "wanted")
        assert(try! guide.resolve(guideIndex, id: "", names: ["Alias", "Renamed"]) == "wanted")
        let plus = try buildSlice(parsed, channelId: "42", ch: "Private +4", hash: "wanted", timeShiftHours: 0, archiveHours: 168)
        let plusRows = plus["epg_data"] as! [[String: Any]]
        assert(plusRows[0]["time"] as! Int == now + 14400)
        assert(plusRows[0]["name"] as! String == "Morning & News")
        let explicit = try buildSlice(parsed, channelId: "42", ch: "Private +4", hash: "wanted", timeShiftHours: -2, archiveHours: 168)
        assert((explicit["epg_data"] as! [[String: Any]])[0]["time"] as! Int == now - 7200)
        let sourceA = "http://custom.test/a.xml"
        let sourceB = "https://custom.test/b.xml"
        URLSession.shared.sources[sourceA] = Data(fixture.utf8)
        URLSession.shared.sources[sourceB] = Data(fixture.replacingOccurrences(of: "Morning & News", with: "Second feed").utf8)
        let indexCall = CAPPluginCall("")
        indexCall.values["xmltv_urls"] = [sourceA, sourceB]
        getChannels(indexCall)
        assert(indexCall.resolved && !indexCall.rejected)
        assert((indexCall.result["channels"] as! [[String: Any]]).contains { ($0["id"] as? String) == "wanted" && ($0["icon"] as? String) == "https://icons.test/a.png" })
        let requestsBefore = URLSession.shared.requests
        let epgCall = CAPPluginCall("")
        epgCall.values = ["xmltv_urls": [sourceA, sourceB], "hash": "wanted", "ch": "Private +4"]
        getEpg(epgCall)
        assert(epgCall.resolved && URLSession.shared.requests == requestsBefore)
        assert((epgCall.result["epg_data"] as! [[String: Any]])[0]["name"] as! String == "Morning & News")
        let secondCall = CAPPluginCall(sourceB); secondCall.values["hash"] = "wanted"
        getEpg(secondCall)
        assert((secondCall.result["epg_data"] as! [[String: Any]])[0]["name"] as! String == "Second feed")
        // Once the single disk slot belongs to B, stale source-A memory must still win offline.
        parsedCache[sourceA] = (0, parsedCache[sourceA]!.data)
        parsedCache[sourceB] = (0, parsedCache[sourceB]!.data)
        try "0\n\(sourceB)".write(to: metaURL, atomically: true, encoding: .utf8)
        URLSession.shared.sources.removeAll(); URLSession.shared.data = nil
        let offline = CAPPluginCall(""); offline.values = ["xmltv_urls": [sourceA, sourceB], "hash": "wanted"]
        getEpg(offline)
        assert(offline.resolved && !offline.rejected)
        assert((offline.result["epg_data"] as! [[String: Any]])[0]["name"] as! String == "Morning & News")
        print("PASS Swift native parity: plain XML, entities/CDATA/aliases/icons, raw ID, regional/explicit shifts, ordered sources, shared index cache")

        print("PASS Swift: source identity, TTL, same-source offline fallback, corrupt response, prefetch, legacy metadata reset")
    }
"""

# Exercise the actual app ownership gate, omitting only its Capacitor plugin.
SWIFT_STUBS += (ROOT / "ios/App/App/Plugins/NativeBackground.swift").read_text(encoding="utf-8").split("@objc(NativeBackground)")[0].replace("import Capacitor", "")

KOTLIN_CAPACITOR = r"""
package com.getcapacitor
import java.io.File
object FixtureClock { var now = 1000000000L }
class Context(var cacheDir: File, var filesDir: File)
open class Plugin { var context = Context(File("."), File(".")) }
class PluginCall(val source: String) {
    val values = mutableMapOf<String, Any>()
    var result = JSObject()
    var resolved = false
    var rejected = false
    var resolveCount = 0
    var rejectCount = 0
    var rejection = ""
    fun getString(key: String): String? = if (key == "xmltv_url") source else values[key] as? String
    fun getArray(key: String): JSArray? = values[key] as? JSArray
    fun getInt(key: String): Int? = values[key] as? Int
    fun resolve(value: JSObject = JSObject()) { resolveCount++; resolved = true; result = value }
    fun reject(message: String) { rejectCount++; rejected = true; rejection = message }
}
annotation class PluginMethod
class JSObject { val values = mutableMapOf<String, Any>(); fun put(key: String, value: Any) { values[key] = value } }
class JSArray { val values = mutableListOf<Any>(); fun put(value: Any) { values.add(value) }; fun length() = values.size; fun optString(index: Int) = values[index] as? String ?: "" }
"""

KOTLIN_HTTP = r"""
package okhttp3
import java.io.IOException
import java.util.concurrent.TimeUnit
object Fixture {
    var data: ByteArray? = null
    var requests = 0
    val sources = mutableMapOf<String, ByteArray>()
    val errors = mutableMapOf<String, IOException>()
    val requestUrls = mutableListOf<String>()
    var deferred = false
    var stream: (() -> java.io.InputStream)? = null
    var length = -1L
    var closed = 0
    var cancelled = 0
    val queue = mutableListOf<() -> Unit>()
    fun releaseOne() { check(queue.isNotEmpty()); queue.removeAt(0)() }
    fun reset() { data = null; requests = 0; sources.clear(); errors.clear(); requestUrls.clear(); deferred = false; queue.clear(); stream = null; length = -1; closed = 0; cancelled = 0 }
}
interface Call { fun enqueue(callback: Callback); fun cancel() }
interface Callback {
    fun onFailure(call: Call, e: IOException)
    fun onResponse(call: Call, response: Response)
}
class Body(private val data: ByteArray?) {
    private var opened: java.io.InputStream? = null
    fun bytes(): ByteArray = data!!
    fun contentLength(): Long = if (Fixture.stream != null) Fixture.length else data!!.size.toLong()
    fun byteStream(): java.io.InputStream = (Fixture.stream?.invoke() ?: data!!.inputStream()).also { opened = it }
    fun close() { opened?.close() }
}
class Response(val body: Body?) { val isSuccessful = true; val code = 200; fun close() { body?.close(); Fixture.closed++ } }
class Request(val url: String) {
    class Builder { var value = ""; fun url(url: String) = apply { value = url }; fun build() = Request(value) }
}
class OkHttpClient {
    class Builder {
        fun connectTimeout(value: Long, unit: TimeUnit) = this
        fun readTimeout(value: Long, unit: TimeUnit) = this
        fun build() = OkHttpClient()
    }
    fun newCall(request: Request): Call = object: Call {
        private var cancelled = false
        override fun cancel() { cancelled = true; Fixture.cancelled++ }
        override fun enqueue(callback: Callback) {
            Fixture.requests++
            Fixture.requestUrls.add(request.url)
            val action = {
                val data = Fixture.sources[request.url] ?: Fixture.data
                val error = if (cancelled) IOException("cancelled") else Fixture.errors[request.url]
                if (error != null || (data == null && Fixture.stream == null)) callback.onFailure(this, error ?: IOException("offline"))
                else callback.onResponse(this, Response(Body(data)))
            }
            if (Fixture.deferred) Fixture.queue.add(action) else action()
        }
    }
}
"""

KOTLIN_TESTS = r'''
    fun runCacheTests() {
        val dir = java.nio.file.Files.createTempDirectory("epg-cache-test").toFile()
        context = com.getcapacitor.Context(dir, dir)
        try {
            val a = "https://a.invalid/feed.gz"
            val b = "https://b.invalid/feed.gz"
            val data = java.util.Base64.getDecoder().decode("GZIP_FIXTURE")
            val xml = String(gunzip(data)!!, Charsets.UTF_8)
            writeCache(data, a)
            check(readCache(a) == xml)
            check(readCache(b) == null)
            check(readCache(b, allowStale = true) == null)
            val fresh = PluginCall(a)
            getEpg(fresh)
            check(fresh.resolved && !fresh.rejected && okhttp3.Fixture.requests == 0)
            val other = PluginCall(b)
            getEpg(other)
            check(other.rejected && !other.resolved)
            metaFile.writeText("0\n$a")
            check(readCache(a) == null)
            check(readCache(a, allowStale = true) == xml)
            val stale = PluginCall(a)
            getEpg(stale)
            check(stale.resolved && !stale.rejected)
            okhttp3.Fixture.data = "invalid gzip".toByteArray()
            val invalid = PluginCall(b)
            getEpg(invalid)
            check(invalid.rejected && !invalid.resolved)
            check(readCache(a, allowStale = true) == xml)
            prefetch(PluginCall(b))
            check(readCache(a, allowStale = true) == xml)
            okhttp3.Fixture.data = data
            prefetch(PluginCall(b))
            check(readCache(b) == xml)
            check(readCache(a, allowStale = true) == null)
            metaFile.writeText((System.currentTimeMillis() / 1000).toString())
            check(readCache(b) == null)
            check(readCache(b, allowStale = true) == null)
            okhttp3.Fixture.data = null
            parsedCache.clear() // simulate restart after incompatible disk metadata
            val legacy = PluginCall(b)
            getEpg(legacy)
            check(legacy.rejected && !legacy.resolved)

            for (damaged in listOf(xml.replace("</tv>", ""), "<html>upstream error</html>")) {
                parsedCache.clear()
                writeCache(damaged.toByteArray(), a)
                okhttp3.Fixture.data = data
                val before = okhttp3.Fixture.requests
                val recovered = PluginCall(a)
                getChannels(recovered)
                check(recovered.resolved && !recovered.rejected)
                check(okhttp3.Fixture.requests == before + 1)
                check(((recovered.result.values["channels"] as JSArray).values[0] as JSObject).values["id"] == "a")
                check(readCache(a) == xml)
            }
            parsedCache.clear()
            writeCache("<tv>".toByteArray(), a)
            okhttp3.Fixture.data = null
            val unrecoverable = PluginCall(a)
            getChannels(unrecoverable)
            check(unrecoverable.rejected && !unrecoverable.resolved && parsedCache[a] == null)
            println("PASS Kotlin corrupted disk XML: refetch healthy network; offline rejects without poisoning memory")

            val now = (System.currentTimeMillis() / 1000).toInt()
            val format = java.text.SimpleDateFormat("yyyyMMddHHmmss Z").apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }
            val start = format.format(java.util.Date(now.toLong() * 1000))
            val stop = format.format(java.util.Date((now.toLong() + 3600) * 1000))
            val fixture = """<tv><channel id="wanted"><display-name>Original &amp; A</display-name><display-name>Alias</display-name><icon src="https://icons.test/a.png"/></channel><channel id="wrong"><display-name>Private</display-name></channel><programme channel="wanted" start="$start" stop="$stop"><title><![CDATA[Morning & News]]></title><desc>Details</desc></programme></tv>"""
            val parsed = parseXmltv(fixture)
            check(parsed.names["wanted"] == listOf("Original & A", "Alias"))
            check(parsed.icons["wanted"] == "https://icons.test/a.png")
            check(resolveXmltvId(parsed.channels, "Private +4", "wanted", names = parsed.names) == "wanted")
            check(resolveXmltvId(parsed.channels, "Renamed", "", "Alias", parsed.names) == "wanted")
            fun rows(value: JSObject) = (value.values["epg_data"] as JSArray).values.map { it as JSObject }
            val plus = rows(buildSlice(parsed, "42", "Private +4", "wanted", 0, 168))
            check(plus[0].values["time"] == now + 14400)
            check(plus[0].values["name"] == "Morning & News")
            val explicit = rows(buildSlice(parsed, "42", "Private +4", "wanted", -2, 168))
            check(explicit[0].values["time"] == now - 7200)
            val sourceA = "http://custom.test/a.xml"
            val sourceB = "https://custom.test/b.xml"
            okhttp3.Fixture.sources[sourceA] = fixture.toByteArray()
            okhttp3.Fixture.sources[sourceB] = fixture.replace("Morning & News", "Second feed").toByteArray()
            val sources = JSArray().apply { put(sourceA); put(sourceB) }
            val indexCall = PluginCall("").apply { values["xmltv_urls"] = sources }
            getChannels(indexCall)
            check(indexCall.resolved && !indexCall.rejected)
            check((indexCall.result.values["channels"] as JSArray).values.any { (it as JSObject).values["id"] == "wanted" && it.values["icon"] == "https://icons.test/a.png" })
            val requestsBefore = okhttp3.Fixture.requests
            val epgCall = PluginCall("").apply { values["xmltv_urls"] = sources; values["hash"] = "wanted"; values["ch"] = "Private +4" }
            getEpg(epgCall)
            check(epgCall.resolved && okhttp3.Fixture.requests == requestsBefore + 1) // single disk slot currently belongs to B
            check(rows(epgCall.result)[0].values["name"] == "Morning & News")
            val secondCall = PluginCall(sourceB).apply { values["hash"] = "wanted" }
            getEpg(secondCall)
            check(rows(secondCall.result)[0].values["name"] == "Second feed")
            parsedCache[sourceA] = Pair(0, parsedCache[sourceA]!!.second)
            parsedCache[sourceB] = Pair(0, parsedCache[sourceB]!!.second)
            metaFile.writeText("0\n$sourceB")
            okhttp3.Fixture.sources.clear(); okhttp3.Fixture.data = null
            val offline = PluginCall("").apply { values["xmltv_urls"] = sources; values["hash"] = "wanted" }
            getEpg(offline)
            check(offline.resolved && !offline.rejected)
            check(rows(offline.result)[0].values["name"] == "Morning & News")
            println("PASS Kotlin native parity: plain XML, entities/CDATA/aliases/icons, raw ID, regional/explicit shifts, ordered sources, shared index cache")

            println("PASS Kotlin: source identity, TTL, same-source offline fallback, corrupt response, prefetch, legacy metadata reset")
        } finally { dir.deleteRecursively() }
    }
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check-sources-only", "--check-mirrors-only", dest="check_sources_only", action="store_true")
    parser.add_argument("--platform", choices=["android", "ios", "all"], default="all")
    options = parser.parse_args()
    check_shipping_sources()
    if options.check_sources_only:
        return
    required = (["kotlinc", "java"] if options.platform in ["android", "all"] else []) + (
        ["swift"] if options.platform in ["ios", "all"] else []
    )
    for compiler in required:
        if not shutil.which(compiler):
            raise SystemExit(f"Required native test tool is missing: {compiler}")
    with tempfile.TemporaryDirectory(prefix="native-epg-cache-") as directory:
        tmp = pathlib.Path(directory)
        if options.platform in ["ios", "all"]:
            swift = (ROOT / "mobile-xmltv-epg/src/ios/MobileXmltvEpg.swift").read_text()
            swift = swift.replace("JSContext()", "FixtureJavaScript.context()")
            swift = swift.replace("import Capacitor", SWIFT_STUBS)
            # Point bundle lookups at the actual vendored artifacts; execute the real bridge.
            resource = json.dumps(str(ROOT / "vendor/ottplay-core.js"))
            swift = swift.replace('Bundle.main.url(forResource: "ottplay-core", withExtension: "js")', f'Optional(URL(fileURLWithPath: {resource}))')
            receipt = json.dumps(str(ROOT / "vendor/ottplay-core.manifest.json"))
            swift = swift.replace('Bundle.main.url(forResource: "ottplay-core.manifest", withExtension: "json")', f'Optional(URL(fileURLWithPath: {receipt}))')
            swift = swift.replace("@objc(MobileXmltvEpg)", "").replace("@objc ", "")
            # Swift's assert autoclosure cannot throw; evaluate the real read first.
            tests = SWIFT_TESTS.replace("GZIP_FIXTURE", GZIP) + methods(GZIP)[0] + fallback_methods()[0] + index_methods()
            # Existing policy fixtures compare small text values. Adapt those
            # test inputs/assertions to the new owned-document API; the shipping
            # fetch/cache/decompress/parse/load methods remain unchanged.
            tests = tests.replace("parseXmltv(", "parseFixture(").replace("gunzip(", "expandedFixture(")
            tests = tests.replace("readCache(", "readCacheText(")
            tests = tests.replace("assert(try readCacheText", "assert(try! readCacheText")
            tests += r'''
    private func parseFixture(_ xml: String) throws -> Parsed {
        try parseXmltv(prepareXmltv(Data(xml.utf8)))
    }
    private func expandedFixture(_ data: Data) -> Data? {
        do { let document = try prepareXmltv(data); return try Data(contentsOf: document.url) }
        catch { return nil }
    }
    private func readCacheText(for url: URL, allowStale: Bool = false) throws -> String? {
        guard let document = try readCache(for: url, allowStale: allowStale) else { return nil }
        return try String(contentsOf: document.url, encoding: .utf8)
    }
'''
            tests += resource_methods() + SWIFT_STANDBY_TESTS
            swift = swift.replace("    // MARK: - Cache", tests + "\n    // MARK: - Cache")
            swift += RESOURCE_STUBS
            swift += "\nMobileXmltvEpg.requestHandler = { request, completion in URLSession.shared.dataTask(with: request.url!, completionHandler: completion).resume() }\ntry MobileXmltvEpg().runCacheTests()\ntry MobileXmltvEpg().runPolicyTests()\ntry MobileXmltvEpg().runFallbackTests()\ntry MobileXmltvEpg().runResourceTests()\ntry MobileXmltvEpg().runIndexTests()\ntry runDownloadResourceTests()\n"
            swift = swift.replace("Date().timeIntervalSince1970", "FixtureClock.now")
            swift = swift.replace("try MobileXmltvEpg().runCacheTests()", "try MobileXmltvEpg().runStandbyTests()\ntry MobileXmltvEpg().runCacheTests()")
            swift = instrument_index(swift)
            (tmp / "CacheTest.swift").write_text(swift)
            run("swift", "-module-cache-path", str(tmp / "swift-module-cache"), "CacheTest.swift", cwd=tmp)

        if options.platform in ["android", "all"]:
            kotlin = (ROOT / "mobile-xmltv-epg/src/android/play/ott/foss/plugin/MobileXmltvEpgPlugin.kt").read_text()
            tests = KOTLIN_TESTS.replace("GZIP_FIXTURE", GZIP) + methods(GZIP)[1] + fallback_methods()[1]
            tests = tests.replace("parseXmltv(", "parseFixture(").replace("gunzip(", "expandedFixture(")
            tests = tests.replace("readCache(", "readCacheText(").replace("writeCache(", "writeCacheFixture(")
            kotlin = kotlin.replace(
                "    // MARK: - Cache", tests + KOTLIN_ADAPTERS + KOTLIN_RESOURCE_TESTS + KOTLIN_STANDBY_TESTS + "\n    // MARK: - Cache"
            )
            kotlin += "\nfun main() { MobileXmltvEpgPlugin().runStandbyTests(); MobileXmltvEpgPlugin().runCacheTests(); MobileXmltvEpgPlugin().runPolicyTests(); MobileXmltvEpgPlugin().runFallbackTests(); MobileXmltvEpgPlugin().runResourceTests() }\n"
            kotlin = kotlin.replace("System.currentTimeMillis()", "com.getcapacitor.FixtureClock.now")
            (tmp / "CacheTest.kt").write_text(kotlin)
            (tmp / "Capacitor.kt").write_text(KOTLIN_CAPACITOR)
            (tmp / "Http.kt").write_text(KOTLIN_HTTP)
            (tmp / "BuildConfig.kt").write_text(
                "package play.ott.foss\nobject BuildConfig { const val BUNDLED_EPG_DEFAULTS = true }\n"
            )
            (tmp / "Annotation.kt").write_text(
                "package com.getcapacitor.annotation\nannotation class CapacitorPlugin(val name: String)\n"
            )
            run(
                "kotlinc",
                "CacheTest.kt",
                "Capacitor.kt",
                "Http.kt",
                "Annotation.kt",
                "BuildConfig.kt",
                str(ROOT / "android/app/src/main/java/play/ott/foss/NativeWork.kt"),
                "-nowarn",
                "-classpath", str(ROOT / "vendor/ottplay-core.jar"),
                "-jvm-target", "17",
                "-include-runtime",
                "-d",
                "cache-test.jar",
                cwd=tmp,
            )
            run("java", "-Xmx64m", "-cp", "cache-test.jar" + os.pathsep + str(ROOT / "vendor/ottplay-core.jar"), "play.ott.foss.plugin.CacheTestKt", cwd=tmp)


if __name__ == "__main__":
    main()
