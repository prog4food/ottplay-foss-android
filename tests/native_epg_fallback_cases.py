"""Offline/load contracts qualified on shipping adapters at d24f07be.

The harness injects only platform HTTP completion timing, a deterministic clock
real temporary disk paths and one VM allocation failure. These methods call the
private shipping loaders; no fallback implementation is substituted or copied.
"""
import json


def fallback_methods():
    q = lambda value: json.dumps(value, ensure_ascii=False)
    swift = [r'''
    func runFallbackTests() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir); FixtureClock.now = 1000000; URLSession.shared.reset() }
        cacheURL = dir.appendingPathComponent("fallback.xml")
        metaURL = dir.appendingPathComponent("fallback.meta")
        let a = "https://fallback.invalid/a.xml", b = "https://fallback.invalid/b.xml"
        let original = NSError(domain: "fixture-network", code: 731, userInfo: [NSLocalizedDescriptionKey: "original network failure"])
        func xml(_ name: String) -> String { "<tv><channel id=\"a\"><display-name>\(name)</display-name></channel></tv>" }
        func reset() {
            parsedCache.removeAll(); pendingSources.removeAll(); URLSession.shared.reset(); FixtureClock.now = 1000000; FixtureJavaScript.remaining = nil
            try? FileManager.default.removeItem(at: cacheURL); try? FileManager.default.removeItem(at: metaURL)
        }
        func disk(_ text: String, _ stamp: Int = 0, _ source: String? = nil) throws {
            try Data(text.utf8).write(to: cacheURL)
            try "\(stamp)\n\(source ?? a)".write(to: metaURL, atomically: true, encoding: .utf8)
        }
''']
    kotlin = [r'''
    fun runFallbackTests() {
        val dir = java.nio.file.Files.createTempDirectory("epg-fallback").toFile()
        context = com.getcapacitor.Context(dir, dir)
        try {
            val a = "https://fallback.invalid/a.xml"; val b = "https://fallback.invalid/b.xml"
            val original = IOException("original network failure")
            fun xml(name: String) = "<tv><channel id=\"a\"><display-name>$name</display-name></channel></tv>"
            fun reset() {
                parsedCache.clear(); pendingSources.clear(); okhttp3.Fixture.reset(); com.getcapacitor.FixtureClock.now = 1000000000L
                cacheFile.deleteRecursively(); metaFile.deleteRecursively()
            }
            fun disk(text: String, stamp: Int = 0, source: String = a) {
                cacheFile.writeText(text); metaFile.writeText("$stamp\n$source")
            }
''']
    # Distinct payloads expose the chosen source; no fixture can accidentally
    # pass by returning equivalent memory/disk/network data.
    cases = [
        dict(name="fresh memory wins", memory="Memory", mf=True, disk="Disk", df=True, network="Network", want="Memory", requests=0, stamp=999999),
        dict(name="fresh disk replaces stale memory", memory="Memory", disk="Disk", df=True, network="Network", want="Disk", requests=0),
        dict(name="force skips fresh memory and disk", memory="Memory", mf=True, disk="Disk", df=True, network="Network", force=True, want="Network"),
        dict(name="network replaces stale memory and disk", memory="Memory", disk="Disk", network="Network", want="Network"),
        dict(name="force skips fresh disk", disk="Disk", df=True, network="Network", force=True, want="Network"),
        dict(name="force offline uses fresh disk", disk="Disk", df=True, force=True, want="Disk"),
        dict(name="restart offline uses truly stale disk", disk="Disk", want="Disk"),
        dict(name="offline memory precedes stale disk", memory="Memory", disk="Disk", want="Memory"),
        dict(name="offline memory survives disk source mismatch", memory="Memory", disk="Disk", other=True, want="Memory"),
        dict(name="disk source mismatch preserves network error", disk="Disk", other=True, want=None),
        dict(name="empty stale memory still precedes disk", memory="", disk="Disk", want=""),
        dict(name="empty fresh memory is a cache hit", memory="", mf=True, disk="Disk", network="Network", want="", requests=0, stamp=999999),
        dict(name="empty fresh disk refetches", raw="<tv/>", df=True, network="Network", want="Network"),
        dict(name="corrupt fresh disk refetches", raw="<tv><channel", df=True, network="Network", want="Network"),
        dict(name="empty stale disk preserves network error", raw="<tv/>", want=None),
        dict(name="corrupt stale disk preserves network error", raw="<tv><channel", want=None),
        dict(name="invalid disk encoding preserves network error", raw="broken gzip", want=None),
        dict(name="invalid network encoding falls back to disk", disk="Disk", wire="broken gzip", want="Disk"),
        dict(name="empty network guide falls back to disk", disk="Disk", wire="<tv/>", want="Disk"),
        dict(name="malformed network guide falls back to disk", disk="Disk", wire="<tv><channel", want="Disk"),
        dict(name="empty network response falls back to disk", disk="Disk", wire="", want="Disk"),
        dict(name="missing disk preserves network error", want=None),
        dict(name="force offline renews fresh memory", memory="Memory", mf=True, disk="Disk", force=True, want="Memory"),
    ]
    for case in cases:
        swift += ['do { reset()']
        kotlin += ['run { reset()']
        if 'memory' in case:
            data = '"<tv/>"' if case['memory'] == '' else f'xml({q(case["memory"])})'
            stamp = 999999 if case.get('mf') else 0
            swift += [f'parsedCache[a] = ({stamp}, try parseXmltv({data}))']
            kotlin += [f'parsedCache[a] = Pair({stamp}L, parseXmltv({data}))']
        if 'disk' in case or 'raw' in case:
            data = f'xml({q(case["disk"])})' if 'disk' in case else q(case['raw'])
            stamp = 999999 if case.get('df') else 0
            source = 'b' if case.get('other') else 'a'
            swift += [f'try disk({data}, {stamp}, {source})']
            kotlin += [f'disk({data}, {stamp}, {source})']
        if 'network' in case or 'wire' in case:
            data = f'xml({q(case["network"])})' if 'network' in case else q(case['wire'])
            swift += [f'URLSession.shared.data = Data({data}.utf8)']
            kotlin += [f'okhttp3.Fixture.data = {data}.toByteArray()']
        else:
            swift += ['URLSession.shared.errors[a] = original']
            kotlin += ['okhttp3.Fixture.errors[a] = original']
        force = str(case.get('force', False)).lower()
        label = q(case['name'])
        swift += ['var calls = 0; var result: Result<Parsed, Error>?', f'loadSource(a, force: {force}) {{ calls += 1; result = $0 }}',
            f'assert(calls == 1 && URLSession.shared.requests == {case.get("requests", 1)} && pendingSources[a] == nil, {label})']
        kotlin += ['var calls = 0; var result: Result<Parsed>? = null', f'loadSource(a, {force}) {{ calls++; result = it }}',
            f'check(calls == 1 && okhttp3.Fixture.requests == {case.get("requests", 1)} && pendingSources[a] == null) {{ {label} }}']
        want = case['want']
        if want is None:
            swift += [f'if case .failure(let error) = result! {{ assert((error as NSError) === original, {label}) }} else {{ assertionFailure({label}) }}', 'assert(parsedCache[a] == nil)']
            kotlin += [f'check(result!!.exceptionOrNull() === original) {{ {label} }}', 'check(parsedCache[a] == null)']
        else:
            condition_swift = 'parsed.channels.isEmpty' if want == '' else f'parsed.channels["a"] == {q(want)}'
            condition_kotlin = 'parsed.channels.isEmpty()' if want == '' else f'parsed.channels["a"] == {q(want)}'
            swift += [f'let parsed = try result!.get(); assert({condition_swift}, {label})', f'assert(parsedCache[a]?.fetched == {case.get("stamp", 1000000)}, {label})']
            kotlin += [f'val parsed = result!!.getOrThrow(); check({condition_kotlin}) {{ {label} }}', f'check(parsedCache[a]?.first == {case.get("stamp", 1000000)}L) {{ {label} }}']
        swift += ['}']; kotlin += ['}']

    # A directory at the real payload path deterministically fails the actual
    # writeCache syscall. Swift falls back; archived Android keeps valid network.
    for memory in (False, True):
        swift += ['do { reset()', 'try FileManager.default.createDirectory(at: cacheURL, withIntermediateDirectories: true)',
            'try Data("keep directory nonempty".utf8).write(to: cacheURL.appendingPathComponent("child"))', 'URLSession.shared.data = Data(xml("Network").utf8)']
        kotlin += ['run { reset()', 'check(cacheFile.mkdir()); File(cacheFile, "child").writeText("keep directory nonempty")', 'okhttp3.Fixture.data = xml("Network").toByteArray()']
        if memory:
            swift += ['parsedCache[a] = (0, try parseXmltv(xml("Memory")))']
            kotlin += ['parsedCache[a] = Pair(0L, parseXmltv(xml("Memory")))']
        swift += ['var calls = 0; loadSource(a, force: true) { result in calls += 1']
        kotlin += ['var calls = 0; loadSource(a, true) { result -> calls++', 'check(result.getOrThrow().channels["a"] == "Network")', '}', 'check(calls == 1 && parsedCache[a]?.first == 1000000L)', '}']
        if memory:
            swift += ['assert((try! result.get()).channels["a"] == "Memory")', '}', 'assert(calls == 1 && parsedCache[a]?.fetched == 1000000)']
        else:
            swift += ['if case .failure(let error) = result { assert((error as NSError).domain == NSCocoaErrorDomain) } else { assertionFailure("Swift write failure must reject without fallback") }', '}', 'assert(calls == 1 && parsedCache[a] == nil)']
        swift += ['}']

    # Keep every callback observable while the actual pendingSources registry
    # coalesces requests. Nothing writes pendingSources on behalf of the loader.
    for outcome in ('network', 'memory', 'disk', 'failure'):
        swift += ['do { reset(); URLSession.shared.deferred = true']
        kotlin += ['run { reset(); okhttp3.Fixture.deferred = true']
        if outcome == 'network':
            swift += ['URLSession.shared.data = Data(xml("Network").utf8)']
            kotlin += ['okhttp3.Fixture.data = xml("Network").toByteArray()']
        else:
            swift += ['URLSession.shared.errors[a] = original']
            kotlin += ['okhttp3.Fixture.errors[a] = original']
        if outcome == 'memory':
            swift += ['parsedCache[a] = (0, try parseXmltv(xml("Memory")))']
            kotlin += ['parsedCache[a] = Pair(0L, parseXmltv(xml("Memory")))']
        if outcome == 'disk':
            swift += ['try disk(xml("Disk"))']
            kotlin += ['disk(xml("Disk"))']
        swift += ['let ordinary = CAPPluginCall(a), forced = CAPPluginCall(a), joined = CAPPluginCall(a)',
            'getChannels(ordinary); prefetch(forced); getChannels(joined)',
            'assert(URLSession.shared.requests == 1 && URLSession.shared.queue.count == 1 && pendingSources[a]?.count == 3)',
            'assert(ordinary.resolveCount + ordinary.rejectCount + forced.resolveCount + forced.rejectCount + joined.resolveCount + joined.rejectCount == 0)',
            'FixtureClock.now = 1000027; URLSession.shared.releaseOne()',
            'assert(pendingSources[a] == nil && URLSession.shared.queue.isEmpty)',
            'for call in [ordinary, forced, joined] { assert(call.resolveCount + call.rejectCount == 1) }']
        kotlin += ['val ordinary = PluginCall(a); val forced = PluginCall(a); val joined = PluginCall(a)',
            'getChannels(ordinary); prefetch(forced); getChannels(joined)',
            'check(okhttp3.Fixture.requests == 1 && okhttp3.Fixture.queue.size == 1 && pendingSources[a]?.size == 3)',
            'check(listOf(ordinary, forced, joined).sumOf { it.resolveCount + it.rejectCount } == 0)',
            'com.getcapacitor.FixtureClock.now = 1000027000L; okhttp3.Fixture.releaseOne()',
            'check(pendingSources[a] == null && okhttp3.Fixture.queue.isEmpty())',
            'listOf(ordinary, forced, joined).forEach { check(it.resolveCount + it.rejectCount == 1) }']
        if outcome == 'failure':
            swift += ['for call in [ordinary, forced, joined] { assert(call.rejectCount == 1 && call.rejection == original.localizedDescription) }', 'assert(parsedCache[a] == nil)']
            kotlin += ['listOf(ordinary, forced, joined).forEach { check(it.rejectCount == 1 && it.rejection == original.message) }', 'check(parsedCache[a] == null)']
        else:
            want = outcome.capitalize()
            swift += [f'for call in [ordinary, joined] {{ assert((call.result["channels"] as! [[String: Any]])[0]["name"] as! String == {q(want)}) }}',
                'assert(forced.resolveCount == 1 && parsedCache[a]?.fetched == 1000027)',
                'let cached = CAPPluginCall(a); getChannels(cached); assert(cached.resolveCount == 1 && URLSession.shared.requests == 1)']
            kotlin += [f'listOf(ordinary, joined).forEach {{ check((((it.result.values["channels"] as JSArray).values[0]) as JSObject).values["name"] == {q(want)}) }}',
                'check(forced.resolveCount == 1 && parsedCache[a]?.first == 1000027L)',
                'val cached = PluginCall(a); getChannels(cached); check(cached.resolveCount == 1 && okhttp3.Fixture.requests == 1)']
        swift += ['}']; kotlin += ['}']

    swift += [r'''
        do { reset(); URLSession.shared.deferred = true
            parsedCache[a] = (999999, try parseXmltv(xml("Memory")))
            URLSession.shared.data = Data(xml("Network").utf8)
            let forced = CAPPluginCall(a), ordinary = CAPPluginCall(a), joined = CAPPluginCall(a)
            prefetch(forced); getChannels(ordinary); prefetch(joined)
            assert(ordinary.resolveCount == 1 && forced.resolveCount == 0 && joined.resolveCount == 0)
            assert((ordinary.result["channels"] as! [[String: Any]])[0]["name"] as! String == "Memory")
            assert(URLSession.shared.requests == 1 && pendingSources[a]?.count == 2)
            URLSession.shared.releaseOne()
            assert(forced.resolveCount == 1 && joined.resolveCount == 1 && ordinary.resolveCount == 1)
            assert(parsedCache[a]?.data.channels["a"] == "Network")
        }
''']
    kotlin += [r'''
        run { reset(); okhttp3.Fixture.deferred = true
            parsedCache[a] = Pair(999999L, parseXmltv(xml("Memory")))
            okhttp3.Fixture.data = xml("Network").toByteArray()
            val forced = PluginCall(a); val ordinary = PluginCall(a); val joined = PluginCall(a)
            prefetch(forced); getChannels(ordinary); prefetch(joined)
            check(ordinary.resolveCount == 1 && forced.resolveCount == 0 && joined.resolveCount == 0)
            check((((ordinary.result.values["channels"] as JSArray).values[0]) as JSObject).values["name"] == "Memory")
            check(okhttp3.Fixture.requests == 1 && pendingSources[a]?.size == 2)
            okhttp3.Fixture.releaseOne()
            check(forced.resolveCount == 1 && joined.resolveCount == 1 && ordinary.resolveCount == 1)
            check(parsedCache[a]?.second?.channels?.get("a") == "Network")
        }
''']
    batches = [
        ('empty batch', [], {}, {}, {}, ''),
        ('first failed second healthy', ['a', 'b'], {'b': 'Second'}, {'a': 'first'}, {}, 'Second'),
        ('first healthy second failed', ['a', 'b'], {'a': 'First'}, {'b': 'second'}, {}, 'First'),
        ('all failed preserve first error', ['a', 'b'], {}, {'a': 'first', 'b': 'second'}, {}, None),
        ('empty first second healthy', ['a', 'b'], {'a': '', 'b': 'Second'}, {}, {}, 'Second'),
        ('same ID belongs to first source', ['a', 'b'], {'a': 'First', 'b': 'Second'}, {}, {}, 'First'),
        ('offline first precedes healthy second', ['a', 'b'], {'b': 'Second'}, {'a': 'first'}, {'a': 'Memory'}, 'Memory'),
        ('empty cached source and failing source', ['a', 'b'], {}, {'b': 'first'}, {'a': ''}, None),
    ]
    for name, sources, network, errors, memory, want in batches:
        swift += ['do { reset()']
        kotlin += ['run { reset()']
        if 'second' in errors.values():
            swift += ['let second = NSError(domain: "fixture-network", code: 732)']
            kotlin += ['val second = IOException("second network failure")']
        for source, payload in network.items():
            data = '"<tv/>"' if payload == '' else f'xml({q(payload)})'
            swift += [f'URLSession.shared.sources[{source}] = Data({data}.utf8)']
            kotlin += [f'okhttp3.Fixture.sources[{source}] = {data}.toByteArray()']
        for source, error in errors.items():
            value = 'original' if error == 'first' else 'second'
            swift += [f'URLSession.shared.errors[{source}] = {value}']
            kotlin += [f'okhttp3.Fixture.errors[{source}] = {value}']
        for source, payload in memory.items():
            data = '"<tv/>"' if payload == '' else f'xml({q(payload)})'
            # Empty cached source stays fresh, so the batch sees a successful
            # empty Parsed before another source fails.
            stamp = 999999 if payload == '' else 0
            swift += [f'parsedCache[{source}] = ({stamp}, try parseXmltv({data}))']
            kotlin += [f'parsedCache[{source}] = Pair({stamp}L, parseXmltv({data}))']
        args = ', '.join(sources)
        swift += ['var calls = 0', f'loadSources([{args}]) {{ result in calls += 1']
        kotlin += ['var calls = 0', f'loadSources(listOf({args})) {{ result -> calls++']
        if want is None:
            swift += [f'if case .failure(let error) = result {{ assert((error as NSError) === original, {q(name)}) }} else {{ assertionFailure({q(name)}) }}']
            kotlin += [f'check(result.exceptionOrNull() === original) {{ {q(name)} }}']
        else:
            cond_s = '(try! result.get()).channels.isEmpty' if want == '' else f'(try! result.get()).channels["a"] == {q(want)}'
            cond_k = 'result.getOrThrow().channels.isEmpty()' if want == '' else f'result.getOrThrow().channels["a"] == {q(want)}'
            swift += [f'assert({cond_s}, {q(name)})']
            kotlin += [f'check({cond_k}) {{ {q(name)} }}']
        expected_urls = [source for source in sources if memory.get(source) != '']
        swift += ['}', f'assert(calls == 1 && URLSession.shared.requestUrls == [{", ".join(expected_urls)}] && pendingSources.isEmpty)', '}']
        kotlin += ['}', f'check(calls == 1 && okhttp3.Fixture.requestUrls == listOf<String>({", ".join(expected_urls)}) && pendingSources.isEmpty())', '}']
    count = len(cases) + 2 + 4 + 1 + len(batches)
    swift += [r'''
        // The first network parse and write succeed. Exhaust only the second
        // parser VM allocation; the shipping error branch must NOT fall back.
        do { reset()
            parsedCache[a] = (0, try parseXmltv(xml("Memory")))
            URLSession.shared.data = Data(xml("Network").utf8)
            FixtureJavaScript.remaining = 1
            var calls = 0
            loadSource(a, force: true) { result in
                calls += 1
                if case .failure(let error) = result {
                    assert((error as NSError).domain == "SharedGuide")
                    assert(error.localizedDescription == "Cannot create shared guide context")
                } else { assertionFailure("second parse error must not use offline memory") }
            }
            FixtureJavaScript.remaining = nil
            assert(calls == 1 && URLSession.shared.requests == 1 && pendingSources[a] == nil)
            assert(parsedCache[a]?.data.channels["a"] == "Memory" && parsedCache[a]?.fetched == 0)
            assert((try! readCache(for: URL(string: a)!)) == xml("Network"))
        }
''', f'print("PASS Swift {count + 1} native offline fallback/coalescing contracts")', '}']
    kotlin += [f'println("PASS Kotlin {count} native offline fallback/coalescing contracts")',
        '} finally { dir.deleteRecursively(); com.getcapacitor.FixtureClock.now = 1000000000L; okhttp3.Fixture.reset() }', '}']
    return '\n'.join(swift), '\n'.join(kotlin)
