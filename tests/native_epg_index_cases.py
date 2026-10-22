"""Swift generation-owned index regressions using the actual adapter and core.

The only extra hooks count allocations/transactions and inject one index failure;
source policy, parser, merging, NativeGuide, ordering and slicing remain shipped code.
"""

INDEX_STUBS = r'''
enum FixtureIndex {
    private static let lock = NSLock()
    private static var counts = [String: Int]()
    static var failNext = false
    static func add(_ key: String, _ amount: Int = 1) {
        lock.lock(); defer { lock.unlock() }
        counts[key, default: 0] += amount
    }
    static func reset() { lock.lock(); counts = [:]; failNext = false; lock.unlock() }
    static func value(_ key: String) -> Int { lock.lock(); defer { lock.unlock() }; return counts[key, default: 0] }
    static func build(_ rows: Int) throws {
        add("indexes"); add("aliasRows", rows)
        if failNext { failNext = false; throw NSError(domain: "fixture-index", code: 1) }
    }
    static func enter() {
        lock.lock(); defer { lock.unlock() }
        counts["active", default: 0] += 1
        counts["peak"] = max(counts["peak", default: 0], counts["active"]!)
    }
    static func leave() { add("active", -1) }
}
'''


def instrument_index(swift):
    replacements = (
        ('return JSContext()', 'FixtureIndex.add("contexts")\n        return JSContext()'),
        ('let measure: @convention(block) (String) -> Int = { $0.count }',
         'try FixtureIndex.build(rows.count)\n        let measure: @convention(block) (String) -> Int = { $0.count }'),
        ('queryLock.lock()\n            defer { queryLock.unlock() }',
         'queryLock.lock()\n            FixtureIndex.enter()\n            defer { FixtureIndex.leave(); queryLock.unlock() }'),
    )
    for before, after in replacements:
        assert swift.count(before) == 1, before
        swift = swift.replace(before, after)
    return swift + INDEX_STUBS


def index_methods():
    return r'''
    func runIndexTests() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir); URLSession.shared.reset(); FixtureJavaScript.remaining = nil }
        cacheURL = dir.appendingPathComponent("index.xml"); metaURL = dir.appendingPathComponent("index.meta")
        FixtureClock.now = 1000000
        let a = "https://index.invalid/a.xml", b = "https://index.invalid/b.xml"
        let format = DateFormatter(); format.dateFormat = "yyyyMMddHHmmss Z"; format.timeZone = TimeZone(secondsFromGMT: 0)
        func xml(_ label: String) -> String {
            let records = [(200, 600, "Future"), (-200, 200, "Current"), (-500, -200, "Archive")]
            let rows = records.map { start, stop, title in
                "<programme channel=\"a\" start=\"\(format.string(from: Date(timeIntervalSince1970: Double(1000000 + start))))\" stop=\"\(format.string(from: Date(timeIntervalSince1970: Double(1000000 + stop))))\"><title>\(label) \(title)</title><desc>Details \(title)</desc></programme>"
            }.joined()
            return "<tv><channel id=\"a\"><display-name>\(label)</display-name><display-name>Alias</display-name></channel><channel id=\"b\"><display-name>Other</display-name></channel>\(rows)</tv>"
        }
        func expected(_ label: String, _ shift: Int = 0) -> [String: Any] {
            let rows: [[String: Any]] = [(-500, -200, "Archive"), (-200, 200, "Current"), (200, 600, "Future")].map { start, stop, title in
                ["time": 1000000 + start + shift, "time_to": 1000000 + stop + shift, "name": "\(label) \(title)", "descr": "Details \(title)", "icon": ""]
            }
            return ["epg_data": rows]
        }
        func check(_ call: CAPPluginCall, _ label: String, _ shift: Int = 0) {
            assert(call.resolveCount == 1 && call.rejectCount == 0, call.rejection)
            assert(NSDictionary(dictionary: call.result).isEqual(to: expected(label, shift)), "full ordered programme oracle: \(call.result)")
        }
        func request(_ sources: [String], _ shift: Int = 0) -> CAPPluginCall {
            let call = CAPPluginCall(""); call.values = ["xmltv_urls": sources, "hash": "a", "ch": "Alias", "archive_hours": 168, "time_shift_hours": shift]
            return call
        }
        func reset() {
            parsedCache.removeAll(); assembled = nil; pendingSources.removeAll(); URLSession.shared.reset()
            try? FileManager.default.removeItem(at: cacheURL); try? FileManager.default.removeItem(at: metaURL)
            FixtureJavaScript.remaining = nil; FixtureIndex.reset()
        }
        func seed(_ source: String, _ label: String) throws { parsedCache[source] = (FixtureClock.now, try parseXmltv(xml(label))) }
        func metadata(_ sources: [String]) {
            let call = request(sources); getChannels(call); assert(call.resolveCount == 1 && call.rejectCount == 0)
        }

        reset(); try seed(a, "First"); metadata([a]); FixtureIndex.reset()
        for _ in 0..<3 { let call = request([a]); getEpg(call); check(call, "First") }
        assert(FixtureIndex.value("contexts") == 1 && FixtureIndex.value("indexes") == 1 && FixtureIndex.value("aliasRows") == 3)
        assert(URLSession.shared.requests == 0)
        print("COUNT Swift warm index: {\"warmReads\":3,\"vmAllocations\":1,\"nativeGuideConstructions\":1,\"aliasRowsBridged\":3,\"httpRequests\":0}")

        // All first readers compete for the same lazy JSC transaction, not just construction.
        reset(); try seed(a, "Concurrent"); metadata([a]); FixtureIndex.reset()
        DispatchQueue.concurrentPerform(iterations: 12) { _ in
            for _ in 0..<3 { let call = request([a]); getEpg(call); check(call, "Concurrent") }
        }
        assert(FixtureIndex.value("contexts") == 1 && FixtureIndex.value("indexes") == 1 && FixtureIndex.value("peak") == 1 && FixtureIndex.value("active") == 0)
        assert(URLSession.shared.requests == 0)

        // Pending callbacks drain oldest first: the first result must publish for its cohort.
        reset(); URLSession.shared.deferred = true; URLSession.shared.sources[a] = Data(xml("Joined").utf8)
        let joined = (0..<3).map { _ in request([a]) }
        joined.forEach { getEpg($0) }
        assert(pendingSources[a]?.count == 3 && URLSession.shared.requests == 1)
        URLSession.shared.releaseOne(); joined.forEach { check($0, "Joined") }
        assert(FixtureIndex.value("indexes") == 1 && FixtureIndex.value("aliasRows") == 3)

        // Equal clock stamps are not generation identity, and source permutations retain ownership.
        reset(); try seed(a, "Before"); let before = request([a]); getEpg(before); check(before, "Before")
        let retained = assembled!.data
        let stamp = parsedCache[a]!.fetched
        try seed(a, "After"); assert(parsedCache[a]!.fetched == stamp)
        let after = request([a]); getEpg(after); check(after, "After")
        assert(assembled!.data !== retained && FixtureIndex.value("indexes") == 2)
        assert(NSDictionary(dictionary: try! buildSlice(retained, channelId: "", ch: nil, hash: "a", timeShiftHours: 0, archiveHours: 168)).isEqual(to: expected("Before")))
        try seed(b, "Second")
        let ab = request([a, b]); getEpg(ab); check(ab, "After")
        let ba = request([b, a]); getEpg(ba); check(ba, "Second")
        let shifted = request([b, a], -2); getEpg(shifted); check(shifted, "Second", -7200)
        assert(FixtureIndex.value("indexes") == 4)

        // A real delayed batch owns its delivered A even if another batch replaces A meanwhile.
        reset(); try seed(a, "Old"); URLSession.shared.deferred = true
        URLSession.shared.sources[b] = Data(xml("B").utf8)
        let older = request([a, b]); getEpg(older)
        assert(older.resolveCount == 0 && pendingSources[b]?.count == 1)
        try seed(a, "New")
        let newer = request([a]); getEpg(newer); check(newer, "New")
        let current = assembled!.data
        URLSession.shared.releaseOne(); check(older, "Old")
        assert(assembled!.data === current && assembled!.sources == [a])
        let again = request([a]); getEpg(again); check(again, "New")
        assert(FixtureIndex.value("indexes") == 2)

        // A newer cache HIT also advances publication order while an older batch waits.
        reset(); try seed(a, "Hit"); let initial = request([a]); getEpg(initial); check(initial, "Hit")
        let resident = assembled!.data
        URLSession.shared.deferred = true; URLSession.shared.sources[b] = Data(xml("B").utf8)
        let delayed = request([a, b]); getEpg(delayed)
        let hit = request([a]); getEpg(hit); check(hit, "Hit")
        URLSession.shared.releaseOne(); check(delayed, "Hit")
        assert(assembled!.data === resident && assembled!.sources == [a])
        assert(FixtureIndex.value("indexes") == 2)

        // Forced refresh leaves an ordinary fresh reader and its retained owner usable.
        reset(); try seed(a, "Fresh"); let original = request([a]); getEpg(original)
        let oldReader = assembled!.data
        URLSession.shared.deferred = true; URLSession.shared.sources[a] = Data(xml("Refreshed").utf8)
        let refresh = request([a]); prefetch(refresh)
        let during = request([a]); getEpg(during); check(during, "Fresh")
        assert(refresh.resolveCount == 0)
        URLSession.shared.releaseOne(); assert(refresh.resolveCount == 1)
        let updated = request([a]); getEpg(updated); check(updated, "Refreshed")
        assert(NSDictionary(dictionary: try! buildSlice(oldReader, channelId: "", ch: nil, hash: "a", timeShiftHours: 0, archiveHours: 168)).isEqual(to: expected("Fresh")))
        assert(FixtureIndex.value("indexes") == 2)

        // Neither allocation nor index failure poisons the resident generation.
        for failIndex in [false, true] {
            reset(); try seed(a, "Retry"); metadata([a]); FixtureIndex.reset()
            if failIndex { FixtureIndex.failNext = true } else { FixtureJavaScript.remaining = 0 }
            let failure = request([a]); getEpg(failure)
            assert(failure.rejectCount == 1 && failure.resolveCount == 0)
            FixtureJavaScript.remaining = nil
            let retry = request([a]); getEpg(retry); check(retry, "Retry")
            let warm = request([a]); getEpg(warm); check(warm, "Retry")
            assert(FixtureIndex.value("indexes") == (failIndex ? 2 : 1))
            assert(FixtureIndex.value("contexts") == (failIndex ? 2 : 1))
        }

        // Replacing the bounded resident releases the old owner after its last reader.
        reset(); try seed(a, "Released"); let releasing = request([a]); getEpg(releasing); check(releasing, "Released")
        weak var released: Parsed? = assembled!.data
        try seed(a, "Replacement"); metadata([a])
        assert(released == nil); released = nil
        print("PASS Swift generation-owned index: warm/concurrent/join reuse, ordered full rows, snapshot identity, source order, retained readers, obsolete completion, retry and release")
    }
'''
