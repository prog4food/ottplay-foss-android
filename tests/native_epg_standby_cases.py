"""Cancellation races through the actual mobile EPG loaders and ownership gate."""

SWIFT_STANDBY_TESTS = r'''
    func runStandbyTests() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        cacheURL = dir.appendingPathComponent("epg.gz"); metaURL = dir.appendingPathComponent("epg.meta")
        parsedCache.removeAll(); assembled = nil
        let previous = Self.cancellableRequestHandler
        defer {
            Self.cancellableRequestHandler = previous
            NativeWork.shared.setStandby(false)
            try? FileManager.default.removeItem(at: dir)
        }
        NativeWork.shared.setStandby(false)
        var delivered: ((Data?, URLResponse?, Error?) -> Void)?
        var requests = 0, cancelled = 0, failures = 0
        Self.cancellableRequestHandler = { _, callback in
            requests += 1; delivered = callback
            return { cancelled += 1 }
        }
        let source = "https://fixture.invalid/standby.xml"
        loadSources([source, source + "?second"]) { result in
            if case .failure = result { failures += 1 } else { assertionFailure("retired batch completed") }
        }
        loadSource(source) { result in
            if case .failure = result { failures += 1 } else { assertionFailure("retired join completed") }
        }
        assert(requests == 1 && NativeWork.shared.snapshot["pending"] as! Int == 3)
        NativeWork.shared.setStandby(true)
        assert(cancelled == 1 && NativeWork.shared.snapshot["quiescent"] as! Bool == false)
        NativeWork.shared.setStandby(false)
        let xml = Data("<tv><channel id='a'><display-name>A</display-name></channel></tv>".utf8)
        delivered?(xml, nil, nil)
        assert(failures == 2 && requests == 1 && parsedCache.isEmpty && assembled == nil)
        assert(NativeWork.shared.snapshot["pending"] as! Int == 0)
        assert(!FileManager.default.fileExists(atPath: metaURL.path))
        Self.cancellableRequestHandler = { _, callback in
            requests += 1; callback(xml, nil, nil); return {}
        }
        var recovered = false
        loadSource(source) { if case .success = $0 { recovered = true } }
        assert(recovered && requests == 2 && !parsedCache.isEmpty)
        NativeWork.shared.setStandby(true)
        loadSource(source) { if case .failure = $0 { failures += 1 } }
        assert(failures == 3 && requests == 2)
        NativeWork.shared.setStandby(false)

        let ticket = NativeWork.shared.begin()!
        var checks = 0
        let parser = try XmltvParser(core: (), check: {
            checks += 1
            if checks == 4 { NativeWork.shared.setStandby(true) }
            try ticket.check()
        })
        do { try parser.parse(InputStream(data: xml)); assertionFailure("cancelled parser completed") }
        catch { assert(checks >= 4) }
        assert(NativeWork.shared.snapshot["pending"] as! Int == 1)
        ticket.finish()
        assert(NativeWork.shared.snapshot["quiescent"] as! Bool)
        NativeWork.shared.setStandby(false)
        var finishCleanup: (() -> Void)?
        let unsubscribe = NativeWork.shared.onStandbyAsync { done in
            assert(NativeWork.shared.snapshot["pending"] as! Int == 1)
            finishCleanup = done
        }
        NativeWork.shared.setStandby(true)
        assert(NativeWork.shared.snapshot["quiescent"] as! Bool == false)
        NativeWork.shared.setStandby(false)
        assert(NativeWork.shared.snapshot["pending"] as! Int == 1)
        finishCleanup?(); finishCleanup?()
        assert(NativeWork.shared.snapshot["pending"] as! Int == 0)
        unsubscribe()
        print("PASS Swift EPG standby: cancelled HTTP, retired response after wake, joined/batch failure, no late cache, parser cancellation, recovery")
    }
'''

KOTLIN_STANDBY_TESTS = r'''
    fun runStandbyTests() {
        val dir = java.nio.file.Files.createTempDirectory("epg-standby-").toFile()
        context = com.getcapacitor.Context(dir, dir)
        NativeWork.setStandby(false)
        try {
            okhttp3.Fixture.reset()
            parsedCache.clear()
            val source = "https://fixture.invalid/standby.xml"
            val xml = "<tv><channel id='a'><display-name>A</display-name></channel></tv>".toByteArray()
            okhttp3.Fixture.data = xml
            okhttp3.Fixture.deferred = true
            var failures = 0
            loadSources(listOf(source, "$source?second")) { check(it.isFailure); failures++ }
            loadSource(source) { check(it.isFailure); failures++ }
            check(okhttp3.Fixture.requests == 1 && NativeWork.pendingCount == 3)
            NativeWork.setStandby(true)
            check(okhttp3.Fixture.cancelled == 1 && NativeWork.pendingCount == 3)
            NativeWork.setStandby(false)
            okhttp3.Fixture.releaseOne()
            check(failures == 2 && okhttp3.Fixture.requests == 1 && parsedCache.isEmpty())
            check(NativeWork.pendingCount == 0 && !metaFile.exists())
            okhttp3.Fixture.deferred = false
            var recovered = false
            loadSource(source) { recovered = it.isSuccess }
            check(recovered && okhttp3.Fixture.requests == 2 && parsedCache.isNotEmpty())
            NativeWork.setStandby(true)
            loadSource(source) { check(it.isFailure); failures++ }
            check(failures == 3 && okhttp3.Fixture.requests == 2)
            NativeWork.setStandby(false)
            val ticket = NativeWork.begin()!!
            var checks = 0
            val reader = XmlReader(null, retainedByteLimit, false) {
                if (++checks == 4) NativeWork.setStandby(true)
                ticket.check()
            }
            check(runCatching { reader.parse(org.xml.sax.InputSource(xml.inputStream())) }.isFailure)
            check(checks >= 4 && NativeWork.pendingCount == 1)
            ticket.finish()
            check(NativeWork.pendingCount == 0)
            NativeWork.setStandby(false)
            var finishCleanup: (() -> Unit)? = null
            val unsubscribe = NativeWork.onStandbyAsync { done ->
                check(NativeWork.snapshot().pending == 1)
                finishCleanup = done
            }
            NativeWork.setStandby(true)
            check(!NativeWork.snapshot().quiescent)
            NativeWork.setStandby(false)
            check(NativeWork.snapshot().pending == 1)
            finishCleanup!!(); finishCleanup!!()
            check(NativeWork.snapshot().pending == 0)
            unsubscribe()
            println("PASS Kotlin EPG standby: cancelled HTTP, retired response after wake, joined/batch failure, no late cache, parser cancellation, recovery")
        } finally { NativeWork.setStandby(false); okhttp3.Fixture.reset(); dir.deleteRecursively() }
    }
'''
