/** Browser-owned XMLTV cache. This factory is also exercised without a browser. */
function createHostedEpgWorker(env: any): void {
    var core = env.OttPlayCore;
    var database: any = null;
    var active: any = null;
    var loading = false;
    var request: any = null;
    var downloadTimer: any = null;
    var generation = "";
    var configuration: any = null;
    var timer: any = null;
    var leaseTimer: any = null;
    var databaseName = "";
    var owner = "";
    var releasing = false;
    var released: any[] = [];
    var published = "";
    var publishedStale = false;
    var signature = "";
    var retainedBytes = 0;
    var retainedRecords = 0;
    var closed = false;
    var phase = "starting";
    var source = -1;
    var downloaded = 0;
    var total = 0;
    var httpStatus = 0;
    var lastProgress = 0;
    var WIRE_LIMIT = 96 * 1024 * 1024;
    var XML_LIMIT = 512 * 1024 * 1024;
    var CACHE_BYTES = 192 * 1024 * 1024;
    var CHANNEL_BYTES = 8 * 1024 * 1024;
    var CHANNEL_RECORDS = 20000;
    var parseChannel: any = null;
    var parseNext: (() => void) | null = null;
    // Nested zero-delay timers are clamped by browsers. A message yields to
    // other worker tasks without adding that delay to every parser slice.
    if (typeof env.MessageChannel === "function") {
        try {
            parseChannel = new env.MessageChannel();
            parseChannel.port1.onmessage = continueParse;
        } catch (_) {
            parseChannel = null;
        }
    }
    function continueParse(): void {
        var next = parseNext;
        parseNext = null;
        if (!closed && next) next();
    }
    function yieldParse(next: () => void): void {
        if (closed) return;
        parseNext = next;
        if (parseChannel) parseChannel.port2.postMessage(null);
        else env.setTimeout(continueParse, 0);
    }
    function xmlByteLength(value: string): number {
        // The input limit is UTF-8 XML bytes, not the cumulative UTF-16 storage
        // of transient parser chunks. Only bounded chunks are held in memory.
        var size = 0;
        for (var i = 0; i < value.length; i++) {
            var code = value.charCodeAt(i);
            if (code < 128) size++;
            else if (code < 2048) size += 2;
            else if (
                code >= 0xd800 &&
                code <= 0xdbff &&
                value.charCodeAt(i + 1) >= 0xdc00 &&
                value.charCodeAt(i + 1) <= 0xdfff
            ) {
                size += 4;
                i++;
            } else size += 3;
        }
        return size;
    }
    function send(value: any): void {
        if (!closed) env.postMessage(value);
    }
    function progress(next: string, loaded = 0, size = 0): void {
        phase = next;
        send({
            loaded: loaded,
            phase: phase,
            records: retainedRecords,
            source: source,
            total: size,
            type: "progress",
        });
    }
    function clearDownload(abort: boolean): void {
        env.clearTimeout(downloadTimer);
        downloadTimer = null;
        var xhr = request;
        request = null;
        if (!xhr) return;
        xhr.onload = xhr.onerror = xhr.ontimeout = xhr.onprogress = null;
        if (abort) xhr.abort();
    }
    function fail(code: string): void {
        if (closed) return;
        loading = false;
        release();
        clearDownload(true);
        send({
            cached: !!active,
            code: code,
            httpStatus: httpStatus,
            phase: phase,
            source: source,
            type: "error",
        });
    }
    function release(callback?: (success: boolean) => void): void {
        if (callback) released.push(callback);
        env.clearInterval(leaseTimer);
        leaseTimer = null;
        if (releasing) return;
        function complete(success: boolean): void {
            releasing = false;
            var callbacks = released;
            released = [];
            callbacks.forEach(function (done) {
                done(success);
            });
        }
        if (!database || !owner) {
            complete(true);
            return;
        }
        var token = owner;
        owner = "";
        releasing = true;
        try {
            var tx = transaction(["meta"], true),
                store = tx.objectStore("meta"),
                read = store.get("lease");
            read.onsuccess = function () {
                if (read.result && read.result.owner === token)
                    store.delete("lease");
            };
            tx.oncomplete = function () {
                complete(true);
            };
            tx.onabort = function () {
                complete(false);
            };
        } catch (_) {
            complete(false);
        }
    }
    function close(): void {
        closed = true;
        parseNext = null;
        if (parseChannel) {
            parseChannel.port1.onmessage = null;
            parseChannel.port1.close();
            parseChannel.port2.close();
            parseChannel = null;
        }
        loading = false;
        env.clearTimeout(timer);
        clearDownload(true);
        release(function (success) {
            if (database) database.close();
            database = null;
            // This acknowledgement follows the committed lease deletion.
            if (success) env.postMessage({ type: "closed" });
        });
    }
    function lease(callback: () => void): void {
        var tx = transaction(["meta"], true),
            store = tx.objectStore("meta"),
            read = store.get("lease");
        var granted = false;
        read.onsuccess = function () {
            if (closed) return;
            if (!read.result || read.result.until < Date.now()) {
                owner =
                    String(Date.now()) +
                    "-" +
                    Math.random().toString(36).slice(2);
                store.put({
                    key: "lease",
                    owner: owner,
                    until: Date.now() + 30000,
                });
                granted = true;
            }
        };
        tx.onabort = function () {
            fail("EPG_STORAGE_FAILED");
        };
        tx.oncomplete = function () {
            if (closed) return;
            if (!granted) {
                progress("waiting");
                loading = false;
                timer = env.setTimeout(function () {
                    load(configuration);
                }, 1000);
                return;
            }
            leaseTimer = env.setInterval(function () {
                if (!owner || closed) return;
                var renew = transaction(["meta"], true),
                    values = renew.objectStore("meta"),
                    current = values.get("lease");
                current.onsuccess = function () {
                    if (
                        current.result &&
                        current.result.owner === owner &&
                        current.result.until > Date.now()
                    )
                        values.put({
                            key: "lease",
                            owner: owner,
                            until: Date.now() + 30000,
                        });
                };
            }, 10000);
            callback();
        };
    }
    function identity(value: string): string {
        var first = 2166136261,
            second = 5381;
        for (var i = 0; i < value.length; i++) {
            first = Math.imul(first ^ value.charCodeAt(i), 16777619);
            second = (Math.imul(second, 33) ^ value.charCodeAt(i)) >>> 0;
        }
        return (
            (first >>> 0).toString(16) +
            "-" +
            second.toString(16) +
            "-" +
            value.length
        );
    }
    function transaction(stores: string[], write: boolean): any {
        return database.transaction(stores, write ? "readwrite" : "readonly");
    }
    function open(callback: () => void): void {
        if (!env.indexedDB) {
            fail("EPG_STORAGE_UNAVAILABLE");
            return;
        }
        var opening = env.indexedDB.open(databaseName, 1);
        opening.onupgradeneeded = function () {
            var db = opening.result;
            db.createObjectStore("meta", { keyPath: "key" });
            var rows = db.createObjectStore("rows", { keyPath: "key" });
            rows.createIndex("channel", "channel");
            rows.createIndex("generation", "generation");
        };
        opening.onerror = function () {
            fail("EPG_STORAGE_UNAVAILABLE");
        };
        opening.onblocked = function () {
            fail("EPG_STORAGE_BLOCKED");
        };
        opening.onsuccess = function () {
            if (closed) {
                opening.result.close();
                return;
            }
            database = opening.result;
            database.onversionchange = function () {
                fail("EPG_STORAGE_CHANGED");
                close();
            };
            callback();
        };
    }
    function cleanup(callback: (snapshot: any) => void): void {
        // The lease and retained pointer must be read under the same write lock
        // as deletion. Neither an earlier load snapshot nor an expired owner
        // may choose which generation is still live.
        var tx = transaction(["meta", "rows"], true);
        var meta = tx.objectStore("meta");
        var lock = meta.get("lease");
        var read = meta.get("active");
        var snapshot: any = null;
        var lostLease = false;
        lock.onsuccess = function () {
            if (
                !lock.result ||
                lock.result.owner !== owner ||
                lock.result.until <= Date.now()
            ) {
                lostLease = true;
                tx.abort();
            }
        };
        read.onsuccess = function () {
            snapshot = read.result || null;
            if (snapshot && snapshot.signature !== signature) {
                tx.abort();
                return;
            }
            var keep = snapshot ? snapshot.generation : "";
            var rows = tx.objectStore("rows");
            // Generation keys suffice; do not clone every programme description
            // from the retained snapshot merely to decide which rows to keep.
            var cursor = rows.index("generation").openKeyCursor();
            cursor.onsuccess = function () {
                var item = cursor.result;
                if (!item) return;
                if (item.key !== keep) rows.delete(item.primaryKey);
                item.continue();
            };
        };
        tx.oncomplete = function () {
            callback(snapshot);
        };
        tx.onabort = function () {
            fail(lostLease ? "EPG_LEASE_LOST" : "EPG_STORAGE_FAILED");
            schedule();
        };
    }
    function ready(stale: boolean): void {
        if (
            closed ||
            (stale && publishedStale && published === active.generation)
        )
            return;
        published = active.generation;
        publishedStale = stale;
        send({
            cacheName: databaseName,
            fetched: active.fetched,
            generation: active.generation,
            mappings: active.mappings,
            records: active.records,
            stale: stale,
            type: "ready",
        });
    }
    function validUrl(value: string): boolean {
        return /^https?:\/\/[^\s]+$/i.test(value);
    }
    function load(input: any): void {
        if (loading || closed) return;
        if (
            !input ||
            !Array.isArray(input.channels) ||
            input.channels.length > 16384 ||
            !Array.isArray(input.sources) ||
            !input.sources.length ||
            input.sources.length > 10 ||
            !input.sources.every(validUrl) ||
            !input.channels.every(function (row: any) {
                return (
                    row &&
                    typeof row.id === "string" &&
                    row.id.length <= 512 &&
                    typeof row.name === "string" &&
                    row.name.length <= 512 &&
                    isFinite(row.archiveHours) &&
                    row.archiveHours >= 0 &&
                    row.archiveHours <= 366 * 24 &&
                    Array.isArray(row.sources) &&
                    row.sources.length <= 10 &&
                    row.sources.every(validUrl)
                );
            })
        ) {
            fail("EPG_CONFIGURATION");
            return;
        }
        configuration = input;
        loading = true;
        progress("cache");
        signature = JSON.stringify([input.sources, input.channels]);
        // The numeric-brand policy changes admitted windows as well as mappings.
        databaseName = "ottplay-hosted-epg-v2-" + identity(signature);
        if (database && database.name !== databaseName) {
            release();
            database.close();
            database = null;
            active = null;
        }
        function begin(): void {
            if (closed) return;
            var tx = transaction(["meta"], false);
            var read = tx.objectStore("meta").get("active");
            read.onsuccess = function () {
                if (closed) return;
                var previous = read.result;
                if (previous && previous.signature !== signature) {
                    fail("EPG_CACHE_IDENTITY");
                    return;
                }
                active =
                    previous && previous.signature === signature
                        ? previous
                        : null;
                if (active)
                    ready(
                        !!input.force ||
                            Date.now() - active.fetched >= input.refreshMs
                    );
                if (
                    active &&
                    !input.force &&
                    Date.now() - active.fetched < input.refreshMs
                ) {
                    loading = false;
                    schedule(active.fetched);
                    return;
                }
                // Orphan writes from interrupted refreshes never replace the last good generation.
                lease(function () {
                    cleanup(function (snapshot: any) {
                        if (closed) return;
                        // Another tab may have completed between the first read
                        // and this lease acquisition. Reuse its accepted result.
                        if (
                            snapshot &&
                            !input.force &&
                            Date.now() - snapshot.fetched < input.refreshMs
                        ) {
                            active = snapshot;
                            loading = false;
                            ready(false);
                            release();
                            schedule(snapshot.fetched);
                            return;
                        }
                        refresh(signature);
                    });
                });
            };
            read.onerror = function () {
                fail("EPG_STORAGE_FAILED");
            };
        }
        if (database) begin();
        else open(begin);
    }
    function schedule(fetched?: number): void {
        if (closed) return;
        env.clearTimeout(timer);
        var delay = configuration.refreshMs;
        // Reusing a snapshot must not restart its full freshness interval.
        if (fetched !== undefined)
            delay = Math.max(1, Math.min(delay, fetched + delay - Date.now()));
        timer = env.setTimeout(function () {
            load(configuration);
        }, delay);
    }
    function refresh(signature: string): void {
        generation =
            String(Date.now()) + "-" + Math.random().toString(36).slice(2);
        retainedBytes = 0;
        retainedRecords = 0;
        configuration.force = false;
        var mappings: any = Object.create(null);
        var count = 0;
        var sourceIndex = 0;
        function next(): void {
            if (closed) return;
            if (sourceIndex < configuration.sources.length) {
                var index = sourceIndex++;
                fetchSource(
                    configuration.sources[index],
                    index,
                    mappings,
                    function (added: number) {
                        count += added;
                        next();
                    }
                );
                return;
            }
            if (!count || !Object.keys(mappings).length) {
                fail("EPG_EMPTY");
                schedule();
                return;
            }
            var replacement = {
                fetched: Date.now(),
                generation: generation,
                key: "active",
                mappings: mappings,
                records: retainedRecords,
                signature: signature,
            };
            var tx = transaction(["meta"], true);
            var store = tx.objectStore("meta"),
                lock = store.get("lease");
            lock.onsuccess = function () {
                if (
                    !lock.result ||
                    lock.result.owner !== owner ||
                    lock.result.until <= Date.now()
                ) {
                    tx.abort();
                    return;
                }
                store.put(replacement);
            };
            tx.onabort = function () {
                fail("EPG_STORAGE_FAILED");
                schedule();
            };
            tx.oncomplete = function () {
                if (closed) return;
                active = replacement;
                loading = false;
                ready(false);
                // Collect the previous snapshot only after the pointer transaction committed.
                cleanup(function () {
                    release();
                    schedule();
                });
            };
        }
        next();
    }
    function fetchSource(
        url: string,
        sourceIndex: number,
        mappings: any,
        complete: (count: number) => void
    ): void {
        var xhr = new env.XMLHttpRequest();
        request = xhr;
        source = sourceIndex;
        downloaded = total = httpStatus = 0;
        progress("download");
        if (
            env.location &&
            env.location.protocol === "https:" &&
            /^http:\/\//i.test(url)
        ) {
            fail("EPG_INSECURE_SOURCE");
            schedule();
            return;
        }
        // Source sends a many-month max-age. Freeze this bucket for this entire download.
        var address = url.split("#")[0];
        var separator = address.indexOf("?") < 0 ? "?" : "&";
        // Do not alter signed/private provider query strings. Only this known
        // public publisher needs a bucket to override its unusually long max-age.
        var refreshUrl = /^https:\/\/cdn\.epg\.one\//i.test(address)
            ? address +
              separator +
              "_ott_epg=" +
              Math.floor(Date.now() / configuration.refreshMs)
            : address;
        xhr.open("GET", refreshUrl, true);
        xhr.responseType = "arraybuffer";
        // A full public feed can take longer than three minutes on a TV.
        // Bound total time separately from a stall with no new response bytes.
        xhr.timeout = 600000;
        function watchProgress(): void {
            env.clearTimeout(downloadTimer);
            downloadTimer = env.setTimeout(function () {
                if (closed || request !== xhr) return;
                fail("EPG_TIMEOUT");
                schedule();
            }, 60000);
        }
        xhr.onprogress = function (event: any) {
            if (closed || request !== xhr) return;
            if (event.loaded > WIRE_LIMIT) {
                fail("EPG_WIRE_LIMIT");
                schedule();
                return;
            }
            if (event.loaded > downloaded) {
                downloaded = event.loaded;
                watchProgress();
            }
            total = event.total || 0;
            progress("download", downloaded, total);
        };
        xhr.onerror = function () {
            if (closed || request !== xhr) return;
            fail("EPG_NETWORK");
            schedule();
        };
        xhr.ontimeout = function () {
            if (closed || request !== xhr) return;
            fail("EPG_TIMEOUT");
            schedule();
        };
        xhr.onload = function () {
            if (closed || request !== xhr) return;
            clearDownload(false);
            httpStatus = xhr.status;
            if (xhr.status < 200 || xhr.status >= 300 || !xhr.response) {
                fail(xhr.status ? "EPG_HTTP" : "EPG_NETWORK");
                schedule();
                return;
            }
            var buffer = xhr.response;
            downloaded = total = buffer.byteLength;
            progress("download", downloaded, total);
            if (!buffer.byteLength || buffer.byteLength > WIRE_LIMIT) {
                fail("EPG_WIRE_LIMIT");
                schedule();
                return;
            }
            parse(buffer, url, sourceIndex, mappings, complete);
        };
        watchProgress();
        xhr.send(null);
    }
    function parse(
        buffer: ArrayBuffer,
        url: string,
        sourceIndex: number,
        mappings: any,
        complete: (count: number) => void
    ): void {
        var bytes = new Uint8Array(buffer);
        var compressed = bytes[0] === 31 && bytes[1] === 139;
        progress("parse", 0, bytes.length);
        var offset = 0,
            decoded = 0,
            retained = 0,
            sequence = 0,
            depth = 0;
        var ended = false,
            sawRoot = false,
            failed = false,
            indexed = false;
        var metadata: any = Object.create(null),
            metadataCount = 0,
            aliases: string[][] = [],
            admitted: any = Object.create(null);
        var pending: any = Object.create(null),
            pendingBytes = 0;
        var channelSizes: any = Object.create(null);
        var carry: number[] = [];
        var now = Math.floor(Date.now() / 1000);
        var parser = env.sax.parser(true, {
            normalize: false,
            strictEntities: true,
            trim: false,
        });
        var records = new core.WebXmltvRecords(
            "node-streaming",
            function (id: string, start: number, stop: number) {
                var window = admitted[id];
                return (
                    !!window &&
                    isFinite(start) &&
                    isFinite(stop) &&
                    stop > start &&
                    stop > window.from &&
                    start < window.until
                );
            },
            function (icon: string) {
                if (!/^https?:\/\//i.test(icon)) return "";
                return icon.replace(
                    /^http:\/\/(?:epg\.one|epg\.it999\.ru)\//i,
                    "https://cdn.epg.one/"
                );
            }
        );
        function error(code: string): void {
            if (failed) return;
            failed = true;
            pending = Object.create(null);
            bytes = new Uint8Array(0);
            fail(code);
            schedule();
        }
        function indexChannels(): void {
            if (indexed) return;
            indexed = true;
            var index = new core.NativeGuide(
                aliases,
                "web",
                function (value: string) {
                    return value.length;
                },
                function (value: number) {
                    return value;
                }
            );
            configuration.channels.forEach(function (channel: any) {
                var priority = channel.sources.indexOf(url);
                if (priority < 0) return;
                var xmlId = index.resolve(channel.tvgId || "", [
                    channel.tvgName || "",
                    channel.name || "",
                ]);
                if (typeof xmlId !== "string") return;
                var shift =
                    core.nativeGuideShift(channel.name || "", "web") * 3600;
                var hours = Number(channel.archiveHours);
                var from = now - (hours > 0 ? hours : 48) * 3600 - shift;
                var until = now + 48 * 3600 - shift;
                var window = admitted[xmlId];
                if (!window) admitted[xmlId] = { from: from, until: until };
                else {
                    window.from = Math.min(window.from, from);
                    window.until = Math.max(window.until, until);
                }
                var old = mappings[channel.id];
                if (!old || priority < old.priority)
                    mappings[channel.id] = {
                        archiveHours: hours > 0 ? hours : 48,
                        channel: generation + "|" + sourceIndex + "|" + xmlId,
                        logo: (metadata[xmlId] && metadata[xmlId].icon) || "",
                        priority: priority,
                        shift: shift,
                    };
            });
            progress("parse", 0, bytes.length);
        }
        parser.ondoctype = function (value: string) {
            // Permit the feed's inert external declaration; never resolve a DTD or entities.
            if (
                !/^\s*tv(?:\s+SYSTEM\s+(?:"[^"<>]*"|'[^'<>]*'))?\s*$/.test(
                    value
                )
            )
                throw new Error("EPG_XML");
        };
        parser.onerror = function () {
            throw new Error("EPG_XML");
        };
        parser.onopentag = function (tag: any) {
            depth++;
            if (depth > 16 || (depth === 1 && (sawRoot || tag.name !== "tv")))
                throw new Error("EPG_XML");
            if (depth === 1) sawRoot = true;
            if (tag.name === "programme" && depth === 2) indexChannels();
            records.start(tag.name, tag.attributes);
        };
        parser.ontext = parser.oncdata = function (text: string) {
            if (text.length > 65536) throw new Error("EPG_FIELD_LIMIT");
            records.text(text);
        };
        parser.onclosetag = function (name: string) {
            var result = records.end(name);
            depth--;
            if (!result) return;
            var row = result.value;
            if (result.kind === "channel") {
                if (indexed) throw new Error("EPG_XML_ORDER");
                if (!metadata[row.id]) {
                    metadata[row.id] = row;
                    metadataCount++;
                }
                if (aliases.length > 65536 || metadataCount > 16384)
                    throw new Error("EPG_CHANNEL_LIMIT");
                (row.names.length ? row.names : [""]).forEach(function (
                    name: string
                ) {
                    aliases.push([row.id, name]);
                });
            } else {
                var channel = generation + "|" + sourceIndex + "|" + row.id;
                var item = {
                    descr: row.desc,
                    icon: "",
                    name: row.title,
                    time: row.begin,
                    time_to: row.end,
                };
                if (!pending[channel]) pending[channel] = [];
                pending[channel].push(item);
                var size = 80 + 2 * (item.name.length + item.descr.length);
                var usage =
                    channelSizes[channel] ||
                    (channelSizes[channel] = { bytes: 0, rows: 0 });
                usage.bytes += size;
                usage.rows++;
                retainedBytes += size;
                retainedRecords++;
                if (usage.bytes > CHANNEL_BYTES || usage.rows > CHANNEL_RECORDS)
                    throw new Error("EPG_CHANNEL_LIMIT");
                if (retainedBytes > CACHE_BYTES || retainedRecords > 300000)
                    throw new Error("EPG_CACHE_LIMIT");
                pendingBytes += size;
                if (pendingBytes > 4 * 1024 * 1024)
                    throw new Error("EPG_BATCH_LIMIT");
                retained++;
            }
        };
        function text(value: string): void {
            decoded += xmlByteLength(value);
            if (decoded > XML_LIMIT) throw new Error("EPG_XML_LIMIT");
            parser.write(value);
        }
        var inflate = compressed
            ? new env.pako.Inflate({ chunkSize: 16384, to: "string" })
            : null;
        if (inflate) inflate.onData = text;
        function plain(chunk: Uint8Array, last: boolean): string {
            var value = carry.concat(Array.prototype.slice.call(chunk));
            var end = value.length,
                start = end - 1;
            while (start >= 0 && (value[start] & 192) === 128) start--;
            if (start >= 0) {
                var lead = value[start],
                    length =
                        lead < 128 ? 1 : lead < 224 ? 2 : lead < 240 ? 3 : 4;
                if (end - start < length) end = start;
            }
            carry = value.slice(end);
            if (last && carry.length) throw new Error("EPG_UTF8");
            var binary = "";
            for (var i = 0; i < end; i++)
                binary += String.fromCharCode(value[i]);
            return decodeURIComponent(escape(binary));
        }
        function flush(next: () => void): void {
            var keys = Object.keys(pending);
            // Yield short parser slices without a transaction for every slice.
            // The final partial batch still commits before publishing readiness.
            if (!keys.length || (!ended && pendingBytes < 256 * 1024)) {
                next();
                return;
            }
            var tx = transaction(["rows", "meta"], true);
            var store = tx.objectStore("rows"),
                lock = tx.objectStore("meta").get("lease");
            var batch = pending;
            lock.onsuccess = function () {
                if (
                    !lock.result ||
                    lock.result.owner !== owner ||
                    lock.result.until <= Date.now()
                ) {
                    tx.abort();
                    return;
                }
                keys.forEach(function (channel: string) {
                    store.put({
                        channel: channel,
                        generation: generation,
                        // At most 300000 retained rows: six digits keep new
                        // blocks in source order, including equal-time entries.
                        key:
                            generation +
                            ":" +
                            sourceIndex +
                            ":" +
                            ("000000" + sequence++).slice(-6),
                        rows: batch[channel],
                    });
                });
            };
            pending = Object.create(null);
            pendingBytes = 0;
            tx.oncomplete = next;
            tx.onabort = function () {
                error("EPG_STORAGE_FAILED");
            };
        }
        function step(): void {
            if (failed || closed) return;
            var started = Date.now();
            try {
                do {
                    // Even a near-maximum gzip expansion stays below the pending batch budget.
                    var end = Math.min(offset + 1024, bytes.length);
                    var chunk = bytes.subarray(offset, end);
                    offset = end;
                    if (inflate) {
                        if (!inflate.push(chunk, offset === bytes.length))
                            throw new Error("EPG_GZIP");
                    } else text(plain(chunk, offset === bytes.length));
                } while (
                    offset < bytes.length &&
                    pendingBytes < 256 * 1024 &&
                    // Shorter message-driven slices keep guide/close messages
                    // responsive; legacy timer scheduling retains its budget.
                    Date.now() - started < (parseChannel ? 4 : 12)
                );
                if (offset === bytes.length) {
                    if (inflate && (!inflate.ended || inflate.err))
                        throw new Error("EPG_GZIP");
                    parser.close();
                    if (!sawRoot || depth !== 0) throw new Error("EPG_XML");
                    // Channel declarations retain source priority even in an
                    // otherwise valid feed without any programme elements.
                    indexChannels();
                    ended = true;
                }
            } catch (exception) {
                error(
                    exception instanceof Error &&
                        /^EPG_/.test(exception.message)
                        ? exception.message
                        : "EPG_XML"
                );
                return;
            }
            flush(function () {
                if (failed || closed) return;
                if (ended || Date.now() - lastProgress >= 250) {
                    lastProgress = Date.now();
                    progress("parse", offset, bytes.length);
                }
                if (ended) {
                    bytes = new Uint8Array(0);
                    complete(retained);
                } else yieldParse(step);
            });
        }
        step();
    }
    function guide(id: string, query: number): void {
        if (!database) {
            send({ query: query, rows: null, type: "guide" });
            return;
        }
        // The pointer and programmes share a read transaction: another tab cannot
        // collect this generation between resolving the pointer and reading rows.
        var tx = transaction(["rows", "meta"], false);
        var read = tx.objectStore("meta").get("active");
        var rows: any[] = [];
        var rowBytes = 0;
        var found = false;
        read.onsuccess = function () {
            var snapshot = read.result;
            var mapping =
                snapshot &&
                snapshot.signature === signature &&
                snapshot.mappings[id];
            if (!mapping) return;
            found = true;
            var cursor = tx
                .objectStore("rows")
                .index("channel")
                .openCursor(env.IDBKeyRange.only(mapping.channel));
            cursor.onsuccess = function () {
                var item = cursor.result;
                if (!item) return;
                for (var index = 0; index < item.value.rows.length; index++) {
                    var entry = item.value.rows[index];
                    var now = Math.floor(Date.now() / 1000);
                    if (
                        entry.time_to + mapping.shift <=
                            now - mapping.archiveHours * 3600 ||
                        entry.time + mapping.shift >= now + 48 * 3600
                    )
                        continue;
                    rowBytes +=
                        80 + 2 * (entry.name.length + entry.descr.length);
                    if (
                        rowBytes > CHANNEL_BYTES ||
                        rows.length >= CHANNEL_RECORDS
                    ) {
                        tx.abort();
                        return;
                    }
                    rows.push({
                        descr: entry.descr,
                        icon: entry.icon,
                        name: entry.name,
                        time: entry.time + mapping.shift,
                        time_to: entry.time_to + mapping.shift,
                    });
                }
                item.continue();
            };
        };
        tx.oncomplete = function () {
            rows.sort(function (left: any, right: any) {
                return left.time - right.time || left.time_to - right.time_to;
            });
            send({ query: query, rows: found ? rows : null, type: "guide" });
        };
        tx.onabort = function () {
            send({ query: query, rows: null, type: "guide" });
        };
    }
    env.onmessage = function (event: any) {
        var message = event.data || {};
        if (closed && message.type !== "close") return;
        if (message.type === "load") load(message);
        else if (message.type === "guide")
            guide(String(message.id), message.query);
        else if (message.type === "close") close();
    };
}
