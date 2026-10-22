import Capacitor
import zlib
import JavaScriptCore
import CryptoKit

@objc(MobileXmltvEpg)
public class MobileXmltvEpg: CAPPlugin, CAPBridgedPlugin {
    /// Optional host transport for authenticated sources; install before loading EPG.
    public static var requestHandler: ((URLRequest, @escaping (Data?, URLResponse?, Error?) -> Void) -> Void)?
    public static var cancellableRequestHandler: ((URLRequest, @escaping (Data?, URLResponse?, Error?) -> Void) -> (() -> Void))?
    public let identifier = "MobileXmltvEpgPlugin"
    public let jsName = "MobileXmltvEpg"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getEpg", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getChannels", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prefetch", returnType: CAPPluginReturnPromise),
    ]
    private lazy var cacheURL: URL = {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        return docs.appendingPathComponent("epg2.xml.gz")
    }()
    private lazy var metaURL: URL = {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        return docs.appendingPathComponent("epg2.meta")
    }()
    private let cacheLock = NSLock()
    private let policyLock = NSLock()
    private var policy: SharedGuide?
    private func withPolicy<T>(_ action: (SharedGuide) throws -> T) throws -> T {
        policyLock.lock()
        defer { policyLock.unlock() }
        if policy == nil { policy = try SharedGuide() }
        return try action(policy!)
    }

    // Identity belongs to the actual successful parse, including memory fallback.
    // Readers retain their immutable snapshot while a refresh publishes another.
    private final class Parsed {
        let channels: [String: String]
        let programs: [String: [(start: Int, stop: Int, title: String, desc: String)]]
        let icons: [String: String]
        let names: [String: [String]]
        private let queryLock = NSLock()
        private var guide: SharedGuide?
        private var index: JavaScriptCore.JSValue?

        init(_ channels: [String: String], _ programs: [String: [(start: Int, stop: Int, title: String, desc: String)]], _ icons: [String: String], _ names: [String: [String]]) {
            self.channels = channels; self.programs = programs; self.icons = icons; self.names = names
        }

        func query<T>(_ action: (SharedGuide, JavaScriptCore.JSValue) throws -> T) throws -> T {
            queryLock.lock()
            defer { queryLock.unlock() }
            if guide == nil {
                let next = try SharedGuide()
                let rows = channels.keys.sorted().flatMap { id in
                    (names[id] ?? [channels[id]!]).map { [id, $0.precomposedStringWithCanonicalMapping] }
                }
                let built = try next.index(rows)
                // Publish only after both allocations succeed; failures remain retryable.
                guide = next; index = built
            }
            // Guard the whole transaction, including exception state and Swift caches.
            return try action(guide!, index!)
        }
    }
    private let sourceLock = NSLock()
    private var parsedCache: [String: (fetched: TimeInterval, data: Parsed)] = [:]
    private var pendingSources: [String: [(Result<Parsed, Error>) -> Void]] = [:]
    private let assemblyLock = NSLock()
    private var assemblyRevision: UInt64 = 0
    private var assembled: (revision: UInt64, sources: [String], parts: [Parsed?], data: Parsed)?

    private func assemble(_ sources: [String], _ parts: [Parsed?], revision: UInt64, ticket: NativeWork.Ticket? = nil) throws -> Parsed {
        assemblyLock.lock()
        defer { assemblyLock.unlock() }
        try ticket?.check()
        if let cached = assembled, cached.sources == sources,
           zip(cached.parts, parts).allSatisfy({ $0.0 === $0.1 }) {
            let publish = { self.assembled = (max(revision, cached.revision), sources, parts, cached.data) }
            if let ticket { try ticket.commit(publish) } else { publish() }
            return cached.data
        }
        var channels: [String: String] = [:], icons: [String: String] = [:], names: [String: [String]] = [:]
        var programs: [String: [(start: Int, stop: Int, title: String, desc: String)]] = [:]
        for parsed in parts.compactMap({ $0 }) {
            try ticket?.check()
            let ids = try withPolicy { try $0.unowned(Array(channels.keys), incoming: Array(parsed.channels.keys)) }
            for id in ids {
                try ticket?.check()
                channels[id] = parsed.channels[id]; programs[id] = parsed.programs[id]
                icons[id] = parsed.icons[id]; names[id] = parsed.names[id]
            }
        }
        let data = Parsed(channels, programs, icons, names)
        // An older asynchronous batch may finish after a newer one was assembled.
        let publish = { if self.assembled == nil || revision > self.assembled!.revision { self.assembled = (revision, sources, parts, data) } }
        if let ticket { try ticket.commit(publish) } else { publish() }
        return data
    }
    // The host transport must apply the delivered-body limit while receiving.
    // Expanded XML is kept on disk, never as a full Swift String or Data value.
    private var inputByteLimit = 64 * 1024 * 1024
    private var expandedByteLimit = 512 * 1024 * 1024
    private var metadataByteLimit = 8 * 1024
    private var xmlTemporaryDirectory = FileManager.default.temporaryDirectory

    private func sourceUrls(_ call: CAPPluginCall) throws -> [String] {
        try withPolicy { try $0.sources(call.getArray("xmltv_urls", String.self) ?? [], single: call.getString("xmltv_url") ?? "") }
    }

    private func loadSources(_ call: CAPPluginCall, force: Bool = false, completion: @escaping (Result<Parsed, Error>) -> Void) {
        do { loadSources(try sourceUrls(call), force: force, completion: completion) }
        catch { completion(.failure(error)) }
    }

    private func loadSource(_ source: String, force: Bool = false, completion: @escaping (Result<Parsed, Error>) -> Void) {
        guard let url = URL(string: source), ["http", "https"].contains(url.scheme?.lowercased() ?? "") else {
            completion(.failure(NSError(domain: "MobileXmltvEpg", code: -3, userInfo: [NSLocalizedDescriptionKey: "invalid XMLTV URL"])))
            return
        }
        guard let ticket = NativeWork.shared.begin() else { completion(.failure(URLError(.cancelled))); return }
        let complete: (Result<Parsed, Error>) -> Void = { result in
            defer { ticket.finish() }
            let checked: Result<Parsed, Error>
            do { try ticket.check(); checked = result } catch { checked = .failure(error) }
            completion(checked)
        }
        sourceLock.lock()
        let action: String
        do { action = try withPolicy { try $0.lookup(now: Date().timeIntervalSince1970, fetched: parsedCache[source]?.fetched,
            force: force, pending: pendingSources[source] != nil) } }
        catch { sourceLock.unlock(); complete(.failure(error)); return }
        if action == "CACHE", let cached = parsedCache[source] {
            sourceLock.unlock(); complete(.success(cached.data)); return
        }
        if action == "JOIN" {
            pendingSources[source]!.append(complete); sourceLock.unlock(); return
        }
        pendingSources[source] = [complete]
        sourceLock.unlock()
        var network: (data: Data, xml: XmltvDocument)?
        var finished = false
        func finish(_ result: Result<Parsed, Error>) {
            sourceLock.lock()
            guard !finished else { sourceLock.unlock(); return }
            finished = true
            sourceLock.unlock()
            network?.xml.remove()
            network = nil
            sourceLock.lock()
            var outcome = result
            do { try ticket.commit {
                if case .success(let parsed) = result { parsedCache[source] = (Date().timeIntervalSince1970, parsed) }
            } } catch { outcome = .failure(error) }
            let callbacks = pendingSources.removeValue(forKey: source) ?? []
            sourceLock.unlock()
            callbacks.forEach { $0(outcome) }
        }
        var disk: Parsed?
        var memory: Parsed?
        var parsedNetwork: Parsed?
        var failure: Error = NSError(domain: "MobileXmltvEpg", code: -4,
            userInfo: [NSLocalizedDescriptionKey: "invalid or empty XMLTV"])
        func next(_ action: String, _ succeeded: Bool, _ channels: Int = 0) throws -> String {
            try self.withPolicy { try $0.loadNext(action, succeeded: succeeded, channels: channels) }
        }
        func perform(_ action: String) {
            do {
                try ticket.check()
                switch action {
                case "READ_FRESH_DISK", "READ_STALE_DISK":
                    let xml = try? self.readCache(for: url, allowStale: action == "READ_STALE_DISK", ticket: ticket)
                    disk = xml.flatMap { try? self.parseXmltv($0, ticket: ticket) }
                    perform(try next(action, disk != nil, disk?.channels.count ?? 0))
                case "FETCH":
                    self.fetchXmltv(url, ticket: ticket) { result in
                        do {
                            try ticket.check()
                            switch result {
                            case .success(let response):
                                network = response
                                // The first parse historically maps parser failure to the invalid-XMLTV error.
                                parsedNetwork = try? self.parseXmltv(response.xml, ticket: ticket)
                                perform(try next(action, parsedNetwork != nil, parsedNetwork?.channels.count ?? 0))
                            case .failure(let error):
                                failure = error
                                perform(try next(action, false))
                            }
                        } catch { finish(.failure(error)) }
                    }
                case "WRITE_DISK":
                    var written = false
                    do { try self.writeCache(network!.data, for: url, ticket: ticket); written = true }
                    catch { failure = error }
                    perform(try next(action, written))
                case "REPARSE_NETWORK":
                    // Keep the shared policy's second parse, but release its first
                    // result before building another complete programme graph.
                    parsedNetwork = nil
                    do { parsedNetwork = try self.parseXmltv(network!.xml, ticket: ticket) }
                    catch { parsedNetwork = nil; failure = error }
                    perform(try next(action, parsedNetwork != nil, parsedNetwork?.channels.count ?? 0))
                case "READ_MEMORY":
                    self.sourceLock.lock()
                    memory = self.parsedCache[source]?.data
                    self.sourceLock.unlock()
                    perform(try next(action, memory != nil, memory?.channels.count ?? 0))
                case "USE_FRESH_DISK", "USE_STALE_DISK": finish(.success(disk!))
                case "USE_NETWORK": finish(.success(parsedNetwork!))
                case "USE_MEMORY": finish(.success(memory!))
                case "FAIL": finish(.failure(failure))
                default: finish(.failure(NSError(domain: "SharedGuide", code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "Invalid source load action"])))
                }
            } catch { finish(.failure(error)) }
        }
        do { perform(try withPolicy { try $0.loadStart(force: force) }) }
        catch { finish(.failure(error)) }
    }

    // Source order is significant: the first feed defining an ID owns its programs.
    private func loadSources(_ sources: [String], force: Bool = false, completion: @escaping (Result<Parsed, Error>) -> Void) {
        guard let ticket = NativeWork.shared.begin() else { completion(.failure(URLError(.cancelled))); return }
        let complete: (Result<Parsed, Error>) -> Void = { result in
            defer { ticket.finish() }
            let checked: Result<Parsed, Error>
            do { try ticket.check(); checked = result } catch { checked = .failure(error) }
            completion(checked)
        }
        assemblyLock.lock()
        assemblyRevision &+= 1
        let revision = assemblyRevision
        assemblyLock.unlock()
        var parts = [Parsed?](repeating: nil, count: sources.count)
        var errors: [Int: Error] = [:]
        let batch: JavaScriptCore.JSValue
        do { batch = try withPolicy { try $0.sourceBatch(sources.count) } }
        catch { complete(.failure(error)); return }
        func next() {
            do {
                try ticket.check()
                let index = try self.withPolicy { try $0.batchNext(batch) }
                if index < 0 {
                    let failed = try self.withPolicy { try $0.batchFailure(batch) }
                    if failed >= 0 { complete(.failure(errors[failed]!)) }
                    else { complete(.success(try self.assemble(sources, parts, revision: revision, ticket: ticket))) }
                    return
                }
                loadSource(sources[index], force: force) { result in
                    do {
                        switch result {
                        case .success(let parsed):
                            parts[index] = parsed
                            try self.withPolicy { try $0.batchAdvance(batch, succeeded: true, channels: parsed.channels.count) }
                        case .failure(let error):
                            errors[index] = error
                            try self.withPolicy { try $0.batchAdvance(batch, succeeded: false, channels: 0) }
                        }
                        next()
                    } catch { complete(.failure(error)) }
                }
            } catch { complete(.failure(error)) }
        }
        next()
    }

    @objc func getEpg(_ call: CAPPluginCall) {
        loadSources(call) { result in
            switch result {
            case .success(let parsed):
                do { call.resolve(try self.buildSlice(parsed, channelId: call.getString("channel_id") ?? "",
                    ch: call.getString("ch"), hash: call.getString("hash") ?? "",
                    timeShiftHours: call.getInt("time_shift_hours") ?? 0,
                    archiveHours: call.getInt("archive_hours") ?? 0,
                    tvgName: call.getString("tvg_name"))) }
                catch { call.reject(error.localizedDescription) }
            case .failure(let error): call.reject(error.localizedDescription)
            }
        }
    }

    @objc func getChannels(_ call: CAPPluginCall) {
        loadSources(call) { result in
            switch result {
            case .success(let parsed):
                let rows: [[String: Any]] = parsed.channels.keys.sorted().map { id in
                    ["id": id, "name": parsed.channels[id] ?? id,
                     "names": parsed.names[id] ?? [parsed.channels[id] ?? id], "icon": parsed.icons[id] ?? ""]
                }
                call.resolve(["channels": rows])
            case .failure(let error): call.reject(error.localizedDescription)
            }
        }
    }

    @objc func prefetch(_ call: CAPPluginCall) {
        loadSources(call, force: true) { result in
            switch result {
            case .success: call.resolve()
            case .failure(let error): call.reject(error.localizedDescription)
            }
        }
    }

    // MARK: - Cache

    private func readCache(for url: URL, allowStale: Bool = false, ticket: NativeWork.Ticket? = nil) throws -> XmltvDocument? {
        cacheLock.lock()
        defer { cacheLock.unlock() }
        try ticket?.check()
        guard let meta = String(data: try readBounded(metaURL, limit: metadataByteLimit, ticket: ticket), encoding: .utf8) else { return nil }
        let fields = meta.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false)
        // Timestamp-only metadata predates source tracking and cannot be trusted.
        guard fields.count == 2, let fetched = Double(fields[0]),
              try withPolicy({ try $0.disk(source: url.absoluteString, storedSource: String(fields[1]),
                  now: Date().timeIntervalSince1970, fetched: fetched, stale: allowStale) }) else { return nil }
        return try prepareXmltv(readBounded(cacheURL, limit: inputByteLimit, ticket: ticket), ticket: ticket)
    }

    private func writeCache(_ data: Data, for url: URL, ticket: NativeWork.Ticket? = nil) throws {
        cacheLock.lock()
        defer { cacheLock.unlock() }
        try ticket?.check()
        guard data.count <= inputByteLimit else { throw Self.sizeFailure("delivered body") }
        let meta = "\(Date().timeIntervalSince1970)\n\(url.absoluteString)"
        guard meta.utf8.count <= metadataByteLimit else { throw Self.sizeFailure("cache metadata") }
        // Invalidate metadata first so an interrupted write cannot label another source's data.
        if FileManager.default.fileExists(atPath: metaURL.path) {
            try FileManager.default.removeItem(at: metaURL)
        }
        try data.write(to: cacheURL, options: .atomic)
        let publish = { try meta.write(to: self.metaURL, atomically: true, encoding: .utf8) }
        if let ticket { try ticket.commit(publish) } else { try publish() }
    }

    private func fetchXmltv(_ url: URL, ticket: NativeWork.Ticket? = nil, completion: @escaping (Result<(data: Data, xml: XmltvDocument), Error>) -> Void) {
        let completionHandler: (Data?, URLResponse?, Error?) -> Void = { data, response, err in
            do { try ticket?.check() } catch { completion(.failure(error)); return }
            if let response = response as? HTTPURLResponse, !(200...299).contains(response.statusCode) {
                completion(.failure(NSError(domain: "MobileXmltvEpg", code: response.statusCode))); return
            }
            if let err = err { completion(.failure(err)); return }
            guard let data = data, !data.isEmpty else {
                completion(.failure(NSError(domain: "MobileXmltvEpg", code: -1, userInfo: [NSLocalizedDescriptionKey: "empty response"])))
                return
            }
            do { completion(.success((data, try self.prepareXmltv(data, ticket: ticket)))) }
            catch { completion(.failure(error)) }
        }
        if let handler = Self.cancellableRequestHandler {
            let cancel = handler(URLRequest(url: url), completionHandler)
            ticket?.cancelWith(cancel)
        } else if let handler = Self.requestHandler { handler(URLRequest(url: url), completionHandler) }
        else {
            let cancel = XmltvDownload.start(URLRequest(url: url), limit: inputByteLimit, completion: completionHandler)
            ticket?.cancelWith(cancel)
        }
    }

    fileprivate static func sizeFailure(_ resource: String) -> NSError {
        NSError(domain: "MobileXmltvEpg", code: -5,
                userInfo: [NSLocalizedDescriptionKey: "XMLTV \(resource) exceeds size limit"])
    }

    private func readBounded(_ url: URL, limit: Int, ticket: NativeWork.Ticket? = nil) throws -> Data {
        try ticket?.check()
        let file = try FileHandle(forReadingFrom: url)
        defer { try? file.close() }
        guard try file.seekToEnd() <= UInt64(limit) else { throw Self.sizeFailure("cache input") }
        try file.seek(toOffset: 0)
        var result = Data()
        while let chunk = try file.read(upToCount: min(64 * 1024, limit - result.count + 1)), !chunk.isEmpty {
            try ticket?.check()
            guard chunk.count <= limit - result.count else { throw Self.sizeFailure("cache input") }
            result.append(chunk)
        }
        return result
    }

    // MARK: - Bounded XML document

    private final class XmltvDocument {
        let directory: URL
        var url: URL { directory.appendingPathComponent("guide.xml") }
        init(parent: URL) throws {
            directory = parent.appendingPathComponent("ottplay-xmltv-" + UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false,
                                                    attributes: [.posixPermissions: 0o700])
        }
        func remove() { try? FileManager.default.removeItem(at: directory) }
        deinit { remove() }
    }

    private func prepareXmltv(_ data: Data, ticket: NativeWork.Ticket? = nil) throws -> XmltvDocument {
        try ticket?.check()
        guard data.count <= inputByteLimit else { throw Self.sizeFailure("delivered body") }
        let invalid = NSError(domain: "MobileXmltvEpg", code: -2,
                              userInfo: [NSLocalizedDescriptionKey: "gunzip failed"])
        let document = try XmltvDocument(parent: xmlTemporaryDirectory)
        guard FileManager.default.createFile(atPath: document.url.path, contents: nil,
                                            attributes: [.posixPermissions: 0o600]) else { throw invalid }
        let output = try FileHandle(forWritingTo: document.url)
        defer { try? output.close() }
        let gzip = data.starts(with: [0x1f, 0x8b])
        var written = 0
        var utf8Tail = Data()
        var foundXMLPrefix = gzip
        func write(_ chunk: Data) throws {
            try ticket?.check()
            guard chunk.count <= expandedByteLimit - written else { throw Self.sizeFailure("expanded document") }
            // Preserve strict UTF-8 decoding without making a whole-document String.
            // A UTF-8 scalar can straddle two chunks by at most three bytes.
            utf8Tail.append(chunk)
            var decoded = false
            for tail in 0...min(3, utf8Tail.count) {
                let end = utf8Tail.count - tail
                if let text = String(data: utf8Tail.prefix(end), encoding: .utf8) {
                    if !foundXMLPrefix, let first = text.unicodeScalars.first(where: { !CharacterSet.whitespacesAndNewlines.contains($0) }) {
                        guard first == "<" else { throw invalid }
                        foundXMLPrefix = true
                    }
                    utf8Tail = Data(utf8Tail.suffix(tail))
                    decoded = true
                    break
                }
            }
            guard decoded else { throw invalid }
            try output.write(contentsOf: chunk)
            written += chunk.count
        }
        let bufferSize = 64 * 1024
        if gzip {
            let dstBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
            defer { dstBuffer.deallocate() }
            var stream = z_stream()
            guard inflateInit2_(&stream, 16 + MAX_WBITS, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size)) == Z_OK else { throw invalid }
            defer { inflateEnd(&stream) }
            try data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
                guard let inBase = raw.bindMemory(to: Bytef.self).baseAddress,
                      raw.count <= Int(uInt.max) else { throw invalid }
                stream.next_in = UnsafeMutablePointer(mutating: inBase)
                stream.avail_in = uInt(raw.count)
                var ret: Int32 = Z_OK
                repeat {
                    try ticket?.check()
                    stream.next_out = dstBuffer
                    stream.avail_out = uInt(bufferSize)
                    ret = inflate(&stream, Z_NO_FLUSH)
                    guard ret == Z_OK || ret == Z_STREAM_END else { throw invalid }
                    let produced = bufferSize - Int(stream.avail_out)
                    if produced > 0 { try autoreleasepool { try write(Data(bytes: dstBuffer, count: produced)) } }
                } while ret != Z_STREAM_END
            }
        } else {
            var offset = 0
            while offset < data.count {
                let end = min(offset + bufferSize, data.count)
                try autoreleasepool { try write(data.subdata(in: offset..<end)) }
                offset = end
            }
        }
        guard utf8Tail.isEmpty, foundXMLPrefix else { throw invalid }
        try output.close()
        return document
    }

    // MARK: - XMLTV Parse

    private func parseXmltv(_ xml: XmltvDocument, ticket: NativeWork.Ticket? = nil) throws -> Parsed {
        try autoreleasepool {
            try ticket?.check()
            guard let stream = InputStream(url: xml.url) else {
                throw NSError(domain: "MobileXmltvEpg", code: -6, userInfo: [NSLocalizedDescriptionKey: "Cannot read XMLTV document"])
            }
            defer { stream.close() }
            let parser = try XmltvParser(core: (), check: { try ticket?.check() })
            try parser.parse(stream)
            return Parsed(parser.channels, parser.programs, parser.icons, parser.names)
        }
    }

    private class XmltvParser: NSObject, XMLParserDelegate {
        private let guide: SharedGuide
        private let records: JavaScriptCore.JSValue
        private var coreError: Error?
        private var tokens: [[String]] = []
        private var tokenBytes = 0
        private let check: () throws -> Void

        init(core: Void, check: @escaping () throws -> Void = {}) throws {
            self.check = check
            let guide = try SharedGuide()
            self.guide = guide
            records = try guide.xmltvRecords()
            super.init()
        }
        var channels: [String: String] = [:]
        var icons: [String: String] = [:]
        var names: [String: [String]] = [:]
        var programs: [String: [(start: Int, stop: Int, title: String, desc: String)]] = [:]

        func parse(_ stream: InputStream) throws {
            try check()
            let parser = XMLParser(stream: stream)
            parser.shouldResolveExternalEntities = false
            parser.externalEntityResolvingPolicy = .never
            parser.delegate = self
            let succeeded = parser.parse()
            try check()
            if let error = coreError { throw error }
            // Preserve completed metadata even when Foundation rejects a later XML token.
            try flush()
            if !succeeded { channels.removeAll(); programs.removeAll() }
        }

        private func flush() throws {
            try check()
            guard !tokens.isEmpty else { return }
            // Drain bridge temporaries per batch, not after the entire guide.
            try autoreleasepool {
                let actions = try guide.xmltvAccept(records, tokens: tokens)
                tokens.removeAll(keepingCapacity: true)
                tokenBytes = 0
                for row in actions {
                    switch row.first {
                    case "channel" where row.count == 3: channels[row[1]] = row[2]
                    case "name" where row.count == 3: names[row[1], default: []].append(row[2])
                    case "icon" where row.count == 3: icons[row[1]] = row[2]
                    case "programme" where row.count == 7:
                        guard let start = Int(row[2]), let stop = Int(row[3]) else {
                            throw NSError(domain: "SharedGuide", code: 1,
                                userInfo: [NSLocalizedDescriptionKey: "Invalid shared XMLTV programme"])
                        }
                        programs[row[1], default: []].append((start, stop, row[4], row[5]))
                    default:
                        throw NSError(domain: "SharedGuide", code: 1,
                            userInfo: [NSLocalizedDescriptionKey: "Invalid shared XMLTV action"])
                    }
                }
            }
        }

        private func enqueue(_ row: [String], parser: XMLParser) {
            do { try check() } catch { coreError = error; parser.abortParsing(); return }
            guard coreError == nil else { return }
            tokens.append(row)
            tokenBytes += row.reduce(0) { $0 + $1.utf8.count }
            if tokens.count >= 256 || tokenBytes >= 64 * 1024 {
                do { try flush() }
                catch { coreError = error; parser.abortParsing() }
            }
        }

        func parser(_ parser: XMLParser, didStartElement elementName: String, namespaceURI: String?, qualifiedName qName: String?, attributes attributeDict: [String: String]) {
            var row = ["start", elementName]
            for name in ["id", "channel", "start", "stop", "src"] {
                if let value = attributeDict[name] { row.append(name); row.append(value) }
            }
            enqueue(row, parser: parser)
        }

        func parser(_ parser: XMLParser, foundCharacters string: String) {
            enqueue(["text", string], parser: parser)
        }

        func parser(_ parser: XMLParser, didEndElement elementName: String, namespaceURI: String?, qualifiedName qName: String?) {
            enqueue(["end", elementName], parser: parser)
        }
    }

    // MARK: - Channel Resolution + EPG Slice

    private func buildSlice(_ parsed: Parsed, channelId: String, ch: String?, hash: String, timeShiftHours: Int, archiveHours: Int, tvgName: String? = nil) throws -> [String: Any] {
        try parsed.query { guide, index in
            let xmltvId = try guide.resolve(index, id: hash, names: [tvgName ?? "", ch ?? ""].map { $0.precomposedStringWithCanonicalMapping }) ?? hash
            let unsorted = parsed.programs[xmltvId] ?? []
            let progs = try guide.xmltvOrder(unsorted.map { Double($0.start) }).map { unsorted[$0] }
            let shift = timeShiftHours != 0 ? timeShiftHours : try guide.shift(ch ?? tvgName ?? "")
            let selection = try guide.slice(progs.map { [Double($0.start), Double($0.stop)] },
                now: Date().timeIntervalSince1970, archive: archiveHours, shift: shift)
            let epgData: [[String: Any]] = selection.map { row in
                let prog = progs[Int(row[0])]
                return ["time": Int(row[1]), "time_to": Int(row[2]), "name": prog.title,
                        "descr": prog.desc, "icon": ""]
            }

            return ["epg_data": epgData]
        }
    }
}

/// Standalone plugin use has the same delivered-body bound as the host hook.
/// Checking only after a dataTask completion would allow URLSession to allocate
/// the entire response before XMLTV gets a chance to reject it.
private final class XmltvDownload: NSObject, URLSessionDataDelegate {
    private let limit: Int
    private var completion: ((Data?, URLResponse?, Error?) -> Void)?
    private var session: Foundation.URLSession?
    private var response: URLResponse?
    private var buffer = Data()
    private var failure: Error?

    private init(limit: Int, completion: @escaping (Data?, URLResponse?, Error?) -> Void) {
        self.limit = limit
        self.completion = completion
    }
    @discardableResult static func start(_ request: URLRequest, limit: Int,
                      configuration: URLSessionConfiguration = .default,
                      completion: @escaping (Data?, URLResponse?, Error?) -> Void) -> (() -> Void) {
        let owner = XmltvDownload(limit: limit, completion: completion)
        let session = Foundation.URLSession(configuration: configuration, delegate: owner, delegateQueue: nil)
        owner.session = session
        let task = session.dataTask(with: request)
        task.resume()
        return { task.cancel() }
    }
    func urlSession(_ session: Foundation.URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (Foundation.URLSession.ResponseDisposition) -> Void) {
        self.response = response
        if response.expectedContentLength > Int64(limit) {
            failure = MobileXmltvEpg.sizeFailure("delivered body")
            completionHandler(.cancel)
        } else { completionHandler(.allow) }
    }
    func urlSession(_ session: Foundation.URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard failure == nil else { return }
        guard data.count <= limit - buffer.count else {
            failure = MobileXmltvEpg.sizeFailure("delivered body")
            dataTask.cancel()
            return
        }
        buffer.append(data)
    }
    func urlSession(_ session: Foundation.URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let callback = completion
        completion = nil
        self.session = nil
        session.finishTasksAndInvalidate()
        callback?(failure == nil && error == nil ? buffer : nil, response, failure ?? error)
    }
}

/// JavaScriptCore supplies execution and Swift string primitives only.
/// The bundled compiler output is the same artifact used by the browser and Rust.
private final class SharedGuide {
    private static let source: Result<String, Error> = Result {
        guard let url = Bundle.main.url(forResource: "ottplay-core", withExtension: "js") else {
            throw failure("Missing shared guide resource")
        }
        guard let manifest = Bundle.main.url(forResource: "ottplay-core.manifest", withExtension: "json"),
              let receipt = try JSONSerialization.jsonObject(with: Data(contentsOf: manifest)) as? [String: Any],
              let artifacts = receipt["artifacts"] as? [String: [String: Any]],
              let expected = artifacts["ottplay-core.js"]?["sha256"] as? String else {
            throw failure("Missing shared guide receipt")
        }
        let data = try Data(contentsOf: url)
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard digest == expected, let source = String(data: data, encoding: .utf8) else {
            throw failure("Modified shared guide resource")
        }
        return source
    }
    private let context: JSContext
    private let core: JavaScriptCore.JSValue
    private var functions: [String: JavaScriptCore.JSValue] = [:]
    private var xmltvBatch: JavaScriptCore.JSValue?

    private static func failure(_ message: String) -> Error {
        NSError(domain: "SharedGuide", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
    init() throws {
        guard let context = JSContext() else { throw Self.failure("Cannot create shared guide context") }
        context.evaluateScript(try Self.source.get())
        guard context.exception == nil, let core = context.objectForKeyedSubscript("OttPlayCore"), !core.isUndefined else {
            throw Self.failure("Cannot initialize shared guide")
        }
        self.context = context
        self.core = core
    }
    private func checked(_ action: () -> JavaScriptCore.JSValue?) throws -> JavaScriptCore.JSValue {
        context.exception = nil
        guard let value = action(), context.exception == nil, !value.isUndefined else {
            throw Self.failure("Shared guide execution failed")
        }
        return value
    }
    private func call(_ name: String, _ arguments: [Any]) throws -> JavaScriptCore.JSValue {
        if functions[name] == nil { functions[name] = core.forProperty(name) }
        return try checked { functions[name]?.call(withArguments: arguments) }
    }
    func sources(_ supplied: [String], single: String) throws -> [String] {
        let trim: @convention(block) (String) -> String = { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        let identity: @convention(block) (String) -> String = { $0.precomposedStringWithCanonicalMapping }
        guard let values = try call("nativeGuideSources", [supplied, single, trim, identity]).toArray() as? [String] else {
            throw Self.failure("Invalid shared guide sources")
        }
        return values
    }
    func unowned(_ existing: [String], incoming: [String]) throws -> [String] {
        let identity: @convention(block) (String) -> String = { $0.precomposedStringWithCanonicalMapping }
        guard let values = try call("nativeGuideUnowned", [existing, incoming, identity]).toArray() as? [String] else {
            throw Self.failure("Invalid shared guide ownership")
        }
        return values
    }
    func lookup(now: Double, fetched: Double?, force: Bool, pending: Bool) throws -> String {
        try call("nativeGuideLookup", [now, fetched as Any? ?? NSNull(), force, pending]).toString()
    }
    func disk(source: String, storedSource: String, now: Double, fetched: Double, stale: Bool) throws -> Bool {
        try call("nativeGuideDisk", [source, storedSource, now, fetched, stale]).toBool()
    }
    func loadStart(force: Bool) throws -> String { try call("nativeGuideLoadStart", [force]).toString() }
    func loadNext(_ action: String, succeeded: Bool, channels: Int) throws -> String {
        try call("nativeGuideLoadNext", [action, succeeded, channels, "swift"]).toString()
    }
    func sourceBatch(_ count: Int) throws -> JavaScriptCore.JSValue {
        try checked { core.forProperty("NativeGuideSourceBatch")?.construct(withArguments: [count]) }
    }
    func batchNext(_ batch: JavaScriptCore.JSValue) throws -> Int {
        Int(try checked { batch.invokeMethod("next", withArguments: []) }.toInt32())
    }
    func batchAdvance(_ batch: JavaScriptCore.JSValue, succeeded: Bool, channels: Int) throws {
        // Unit-returning JS methods produce undefined; check the VM exception explicitly.
        context.exception = nil
        batch.invokeMethod("advance", withArguments: [succeeded, channels])
        if context.exception != nil { throw Self.failure("Shared guide execution failed") }
    }
    func batchFailure(_ batch: JavaScriptCore.JSValue) throws -> Int {
        Int(try checked { batch.invokeMethod("failure", withArguments: []) }.toInt32())
    }
    func xmltvRecords() throws -> JavaScriptCore.JSValue {
        let trim: @convention(block) (String) -> String = { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        let identity: @convention(block) (String) -> String = { $0.precomposedStringWithCanonicalMapping }
        return try checked { core.forProperty("XmltvRecords")?.construct(withArguments: ["swift", trim, identity]) }
    }
    func xmltvAccept(_ records: JavaScriptCore.JSValue, tokens: [[String]]) throws -> [[String]] {
        if xmltvBatch == nil {
            xmltvBatch = try checked { context.evaluateScript(
                "(function (records, tokens) { return JSON.stringify(records.accept(JSON.parse(tokens))); })") }
        }
        // Transfer strings in bounded batches; Foundation array proxies are costly per token.
        let encoded = String(data: try JSONSerialization.data(withJSONObject: tokens), encoding: .utf8)!
        guard let output = try checked({ xmltvBatch?.call(withArguments: [records, encoded]) }).toString(),
              let data = output.data(using: .utf8),
              let result = try JSONSerialization.jsonObject(with: data) as? [[String]] else {
            throw Self.failure("Invalid shared XMLTV records")
        }
        return result
    }
    func xmltvOrder(_ starts: [Double]) throws -> [Int] {
        guard let result = try call("nativeXmltvOrder", [starts, "swift"]).toArray() as? [Int] else {
            throw Self.failure("Invalid shared XMLTV order")
        }
        return result
    }
    func shift(_ input: String) throws -> Int { Int(try call("nativeGuideShift", [input, "swift"]).toInt32()) }
    func index(_ rows: [[String]]) throws -> JavaScriptCore.JSValue {
        let measure: @convention(block) (String) -> Int = { $0.count }
        let precision: @convention(block) (Double) -> Double = { $0 }
        return try checked { core.forProperty("NativeGuide")?.construct(withArguments: [rows, "swift", measure, precision]) }
    }
    func resolve(_ index: JavaScriptCore.JSValue, id: String, names: [String]) throws -> String? {
        let result = try checked { index.invokeMethod("resolve", withArguments: [id, names]) }
        return result.isNull ? nil : result.toString()
    }
    func slice(_ times: [[Double]], now: Double, archive: Int, shift: Int) throws -> [[Double]] {
        guard let result = try call("nativeGuideSlice", [times, now.rounded(.towardZero), archive, shift]).toArray() as? [[Double]] else {
            throw Self.failure("Invalid shared guide slice")
        }
        return result
    }
}
