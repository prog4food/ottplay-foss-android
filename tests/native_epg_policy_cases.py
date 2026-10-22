"""Golden policy cases qualified against native adapters at ab69d2f.

Only the clock and platform I/O are stubbed by test_native_epg_cache.py.
These cases execute private shipping adapter methods, including the real core bridge.
"""
import json

DEFAULT = "https://cdn.epg.one/epg2.xml.gz"
A = "https://a.invalid/feed.gz"
B = "https://b.invalid/feed.gz"


def methods(gzip_fixture):
    quote = lambda value: json.dumps(value, ensure_ascii=False)
    sources = [
        ([], "", [DEFAULT], [DEFAULT]),
        ([A + "é", A + "é"], "", [A + "é"], [A + "é", A + "é"]),
        ([], "  " + A + "\n", [A], [A]),
        (["", " \n"], A, [DEFAULT], [A]),
        ([" " + B + " ", A, B, ""], A, [B, A], [B, A]),
        ([A, A], B, [A], [A]),
        (["\u00a0" + A + "\u00a0"], B, [A], [A]),
        (["\u0085"], A, [DEFAULT], ["\u0085"]),
        ([], "\u0085", [DEFAULT], ["\u0085"]),
    ]
    swift = ['func runPolicyTests() throws {',
        'let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)',
        'try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)',
        'defer { try? FileManager.default.removeItem(at: dir) }',
        'cacheURL = dir.appendingPathComponent("epg.gz"); metaURL = dir.appendingPathComponent("epg.meta")',
        f'let data = Data(base64Encoded: {quote(gzip_fixture)})!',
        f'let url = URL(string: {quote(A)})!',
        'let parsed = try parseXmltv(String(data: gunzip(data)!, encoding: .utf8)!)']
    kotlin = ['fun runPolicyTests() {',
        'val dir = java.nio.file.Files.createTempDirectory("epg-policy").toFile()',
        'context = com.getcapacitor.Context(dir, dir)',
        'try {', f'val data = java.util.Base64.getDecoder().decode({quote(gzip_fixture)})',
        'val parsed = parseXmltv(String(gunzip(data)!!, Charsets.UTF_8))']
    for i, (urls, single, ios, android) in enumerate(sources):
        swift += [f'do {{ let call = CAPPluginCall({quote(single)}); call.values["xmltv_urls"] = {quote(urls)} as [String]',
            f'let actual = try sourceUrls(call); assert(actual == {quote(ios)}, "source {i}") }}']
        kotlin += [f'run {{ val call = PluginCall({quote(single)}); val urls = JSArray()',
            *[f'urls.put({quote(url)})' for url in urls], 'call.values["xmltv_urls"] = urls',
            f'check(sourceUrls(call) == listOf({", ".join(map(quote, android))})) {{ "source {i}" }} }}']
    # Exact TTL is intentionally different for the two disk formats.
    stamps = [("1000000", True, True), ("992801", True, True), ("992800", False, True),
        ("992799", False, False), ("1000001", True, True), ("0", False, False),
        ("NaN", False, False), ("Infinity", True, False), ("-Infinity", False, False),
        ("bad", False, False), ("", False, False),
        ("-9223372036854775808", False, True), ("9223372036854775807", True, True)]
    for i, (stamp, ios, android) in enumerate(stamps):
        for stale in (False, True):
            meta = quote(stamp + "\n" + A)
            swift_ok = ios if not stale else stamp not in ("bad", "")
            android_ok = android if not stale else stamp not in ("bad", "", "NaN", "Infinity", "-Infinity")
            swift += [f'try data.write(to: cacheURL); try {meta}.write(to: metaURL, atomically: true, encoding: .utf8)',
                f'assert(((try! readCache(for: url, allowStale: {str(stale).lower()})) != nil) == {str(swift_ok).lower()}, "disk {i}/{stale}")']
            kotlin += [f'cacheFile.writeBytes(data); metaFile.writeText({meta})',
                f'check((readCache({quote(A)}, {str(stale).lower()}) != null) == {str(android_ok).lower()}) {{ "disk {i}/{stale}" }}']
    for meta in ("1000000", "1000000\n" + B, "1000000\n" + A + "\n"):
        swift += [f'try {quote(meta)}.write(to: metaURL, atomically: true, encoding: .utf8)',
            'assert((try! readCache(for: url, allowStale: true)) == nil)']
        kotlin += [f'metaFile.writeText({quote(meta)})', f'check(readCache({quote(A)}, true) == null)']
    for stamp in (None, 992801, 992800, 992799, 1000001):
        for force in (False, True):
            for pending in (False, True):
                expected = 'cache' if not force and stamp is not None and stamp > 992800 else 'join' if pending else 'load'
                swift += ['do { parsedCache.removeAll(); pendingSources.removeAll()',
                    'try? FileManager.default.removeItem(at: metaURL); URLSession.shared.data = nil; URLSession.shared.sources = [:]',
                    'let before = URLSession.shared.requests; var completed = false']
                kotlin += ['run { parsedCache.clear(); pendingSources.clear(); metaFile.delete()',
                    'okhttp3.Fixture.data = null; okhttp3.Fixture.sources.clear()',
                    'val before = okhttp3.Fixture.requests; var completed = false']
                if stamp is not None:
                    swift += [f'parsedCache[url.absoluteString] = ({stamp}, parsed)']
                    kotlin += [f'parsedCache[{quote(A)}] = Pair({stamp}L, parsed)']
                if pending:
                    swift += ['pendingSources[url.absoluteString] = []']
                    kotlin += [f'pendingSources[{quote(A)}] = mutableListOf()']
                swift += [f'loadSource(url.absoluteString, force: {str(force).lower()}) {{ _ in completed = true }}',
                    'let action = URLSession.shared.requests > before ? "load" : completed ? "cache" : "join"',
                    f'assert(action == "{expected}", "memory {stamp}/{force}/{pending}") }}']
                kotlin += [f'loadSource({quote(A)}, {str(force).lower()}) {{ completed = true }}',
                    'val action = if (okhttp3.Fixture.requests > before) "load" else if (completed) "cache" else "join"',
                    f'check(action == "{expected}") {{ "memory {stamp}/{force}/{pending}" }} }}']
    first = '<tv><channel id="é"><display-name>First</display-name></channel></tv>'
    second = '<tv><channel id="é"><display-name>Second</display-name></channel></tv>'
    swift += [f'parsedCache[{quote(A)}] = (1000000, try parseXmltv({quote(first)}))',
        f'parsedCache[{quote(B)}] = (1000000, try parseXmltv({quote(second)}))',
        f'loadSources([{quote(A)}, {quote(B)}]) {{ result in',
        'let merged = try! result.get(); assert(merged.channels.count == 1 && merged.channels["é"] == "First") }']
    kotlin += [f'parsedCache[{quote(A)}] = Pair(1000000L, parseXmltv({quote(first)}))',
        f'parsedCache[{quote(B)}] = Pair(1000000L, parseXmltv({quote(second)}))',
        f'loadSources(listOf({quote(A)}, {quote(B)})) {{ result ->',
        'val merged = result.getOrThrow(); check(merged.channels.size == 2 && merged.channels["é"] == "First" && merged.channels["é"] == "Second") }']
    swift += ['print("PASS Swift 59 native source/cache policy cases"); }']
    kotlin += ['println("PASS Kotlin 59 native source/cache policy cases")', '} finally { dir.deleteRecursively() }', '}']
    return '\n'.join(swift), '\n'.join(kotlin)
