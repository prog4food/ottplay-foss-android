/** Small JSON transport for the publisher's fixed public EPG service. */
function createHostedEpgServer(env: any): void {
    var configuration: any = null;
    var active: any = null;
    var database: any = null;
    var signature = "";
    var closed = false;
    var refreshTimer: any = null;
    var requests: any[] = [];
    var channels: any = Object.create(null);
    var jobs: any = Object.create(null);
    var queue: any[] = [];
    var running = 0;
    var matching = false;
    var matchWaiters: Array<(ok: boolean) => void> = [];
    var memory: any = Object.create(null);
    var matchFailures = 0;
    // The API maximum is not a safe CPU budget for a catalogue with many misses.
    // Keep a learned, bounded request size for subsequent matches in this worker.
    var matchBatchSize = 256;
    var MIN_MATCH_BATCH_SIZE = 32;
    var guideFailed = false;
    var cachedRows = false;
    var GUIDE_BYTES = 8 * 1024 * 1024;
    var CACHE_BYTES = 32 * 1024 * 1024;
    function send(value: any): void {
        if (!closed) env.postMessage(value);
    }
    function integer(value: any, low: number, high: number): boolean {
        return (
            typeof value === "number" &&
            Math.floor(value) === value &&
            value >= low &&
            value <= high
        );
    }
    function text(value: any, maximum: number): boolean {
        return typeof value === "string" && value.length <= maximum;
    }
    function utf8Bytes(value: string): number {
        var bytes = 0;
        for (var index = 0; index < value.length; index++) {
            var code = value.charCodeAt(index);
            if (code < 128) bytes++;
            else if (code < 2048) bytes += 2;
            else if (
                code >= 0xd800 &&
                code <= 0xdbff &&
                value.charCodeAt(index + 1) >= 0xdc00 &&
                value.charCodeAt(index + 1) <= 0xdfff
            ) {
                bytes += 4;
                index++;
            } else bytes += 3;
        }
        return bytes;
    }
    function progress(phase: string): void {
        send({ phase: phase, type: "progress" });
    }
    function failure(code: string, httpStatus?: number): void {
        send({
            cached: cachedRows,
            code: code,
            httpStatus: httpStatus || 0,
            phase: "download",
            recoverable: true,
            type: "error",
        });
    }
    function cache(key: string, value: any, done: (value: any) => void): void {
        if (!database) {
            if (value !== undefined) {
                memory[key] = value;
                var keys = Object.keys(memory).filter(function (key) {
                    return key !== "active";
                });
                keys.sort(function (left, right) {
                    return memory[right].used - memory[left].used;
                });
                var bytes = 0;
                keys.forEach(function (key, index) {
                    bytes += memory[key].bytes;
                    if (index >= 24 || bytes > CACHE_BYTES) delete memory[key];
                });
            }
            done(memory[key] || null);
            return;
        }
        var completed = false;
        function finish(result: any): void {
            if (completed) return;
            completed = true;
            if (!closed) done(result);
        }
        try {
            var tx = database.transaction(
                value !== undefined && key !== "active"
                    ? ["cache", "usage"]
                    : ["cache"],
                value === undefined ? "readonly" : "readwrite"
            );
            var store = tx.objectStore("cache");
            var result: any = value;
            var request =
                value === undefined ? store.get(key) : store.put(value, key);
            request.onsuccess = function () {
                if (value === undefined) result = request.result;
            };
            if (value !== undefined && key !== "active") {
                var usage = tx.objectStore("usage");
                usage.put({ bytes: value.bytes, used: value.used }, key);
                var saved: any[] = [];
                // Scan small usage records, never clone every full guide just
                // to evict the oldest entries on a write.
                var cursor = usage.openCursor();
                cursor.onsuccess = function () {
                    var item = cursor.result;
                    if (item) {
                        saved.push({ key: item.key, value: item.value });
                        item.continue();
                        return;
                    }
                    saved.sort(function (left, right) {
                        return right.value.used - left.value.used;
                    });
                    var bytes = 0;
                    saved.forEach(function (entry, index) {
                        bytes += integer(entry.value.bytes, 0, GUIDE_BYTES)
                            ? entry.value.bytes
                            : GUIDE_BYTES;
                        if (index >= 24 || bytes > CACHE_BYTES) {
                            store.delete(entry.key);
                            usage.delete(entry.key);
                        }
                    });
                };
            }
            tx.oncomplete = function () {
                finish(result || null);
            };
            tx.onabort = tx.onerror = function () {
                // Storage is an optimization. A failed cache write must not
                // hide a successful bounded server response.
                finish(value === undefined ? null : value);
            };
        } catch (_) {
            finish(value === undefined ? null : value);
        }
    }
    function ready(stale: boolean): void {
        if (!active) return;
        var mappings: any = Object.create(null);
        Object.keys(active.mappings).forEach(function (id) {
            var row = active.mappings[id];
            mappings[id] = {
                channel: row.channelId,
                logo: row.logo,
                shift: row.shift,
            };
        });
        send({
            cached: cachedRows,
            fetched: active.fetchedAt,
            generation: active.generation,
            mappings: mappings,
            sourceStale: active.stale,
            stale: stale,
            type: "ready",
        });
    }
    function schedule(): void {
        env.clearTimeout(refreshTimer);
        var delay = matchFailures
            ? Math.min(60000, 5000 * Math.pow(2, matchFailures - 1))
            : active
              ? active.fetchedAt + active.refreshMs - Date.now()
              : 60000;
        refreshTimer = env.setTimeout(
            function () {
                match(function () {});
            },
            Math.max(matchFailures ? 5000 : 60000, Math.min(delay, 7200000))
        );
    }
    function request(
        method: string,
        url: string,
        body: any,
        done: (error: string | null, value?: any, status?: number) => void,
        timeout?: number
    ): () => void {
        if (closed) return function () {};
        timeout = Math.max(1, Math.min(12000, timeout || 12000));
        var xhr: any;
        var complete = false;
        var timer: any;
        function finish(error: string | null, value?: any): void {
            if (complete) return;
            complete = true;
            env.clearTimeout(timer);
            if (xhr) {
                var index = requests.indexOf(xhr);
                if (index >= 0) requests.splice(index, 1);
                xhr.onload =
                    xhr.onerror =
                    xhr.ontimeout =
                    xhr.onprogress =
                        null;
                xhr.onabort = null;
            }
            if (!closed) done(error, value, xhr ? xhr.status : 0);
        }
        try {
            xhr = new env.XMLHttpRequest();
            requests.push(xhr);
            xhr.open(method, url, true);
            xhr.timeout = timeout;
            if (body !== null)
                xhr.setRequestHeader("Content-Type", "application/json");
            xhr.setRequestHeader("Accept", "application/json");
            xhr.onload = function () {
                if (xhr.status < 200 || xhr.status >= 300) {
                    finish(
                        xhr.status === 409
                            ? "EPG_GENERATION"
                            : xhr.status === 504
                              ? "EPG_TIMEOUT"
                              : "EPG_HTTP"
                    );
                    return;
                }
                if (
                    typeof xhr.responseText !== "string" ||
                    xhr.responseText.length * 2 > GUIDE_BYTES * 2
                ) {
                    finish("EPG_RESPONSE_LIMIT");
                    return;
                }
                try {
                    finish(null, JSON.parse(xhr.responseText));
                } catch (_) {
                    finish("EPG_RESPONSE");
                }
            };
            xhr.onprogress = function (event: any) {
                if (event.loaded > GUIDE_BYTES * 2) {
                    finish("EPG_RESPONSE_LIMIT");
                    xhr.abort();
                }
            };
            xhr.onerror = function () {
                finish("EPG_NETWORK");
            };
            xhr.onabort = xhr.onerror;
            xhr.ontimeout = function () {
                finish("EPG_TIMEOUT");
            };
            timer = env.setTimeout(function () {
                finish("EPG_TIMEOUT");
                xhr.abort();
            }, timeout);
            xhr.send(body === null ? null : JSON.stringify(body));
        } catch (_) {
            finish("EPG_NETWORK");
        }
        return function () {
            if (complete) return;
            finish("EPG_CANCELLED");
            if (xhr) xhr.abort();
        };
    }
    function envelope(value: any): boolean {
        return (
            !!value &&
            value.version === 1 &&
            value.source === "epg-one" &&
            text(value.generation, 256) &&
            value.generation.length > 0 &&
            integer(value.fetchedAt, 1, 9007199254740991)
        );
    }
    function mappings(value: any): boolean {
        return (
            envelope(value) &&
            integer(value.refreshMs, 60000, 7200000) &&
            typeof value.stale === "boolean" &&
            value.mappings &&
            typeof value.mappings === "object" &&
            !Array.isArray(value.mappings) &&
            Object.keys(value.mappings).every(function (id) {
                var row = value.mappings[id];
                return (
                    !!channels[id] &&
                    row &&
                    text(row.channelId, 512) &&
                    row.channelId.length > 0 &&
                    integer(row.shift, -86400, 86400) &&
                    text(row.logo, 4096)
                );
            })
        );
    }
    function match(done: (ok: boolean) => void): void {
        if (closed) return;
        matchWaiters.push(done);
        if (matching) return;
        matching = true;
        progress("cache");
        progress("download");
        // Deliberately project only four metadata strings. XMLTV, playlist,
        // media URLs and provider credentials never enter this request.
        function partition(entries: any[]): any[][] {
            var result: any[][] = [[]];
            var batchBytes = 100;
            entries.forEach(function (metadata) {
                var bytes = utf8Bytes(JSON.stringify(metadata)) + 1;
                var batch = result[result.length - 1];
                if (
                    batch.length >= matchBatchSize ||
                    batchBytes + bytes > 500 * 1024
                ) {
                    batch = [];
                    result.push(batch);
                    batchBytes = 100;
                }
                batch.push(metadata);
                batchBytes += bytes;
            });
            return result;
        }
        var batches = partition(
            configuration.channels.map(function (row: any) {
                return {
                    id: row.id,
                    name: row.name,
                    tvgId: row.tvgId || "",
                    tvgName: row.tvgName || "",
                };
            })
        );
        var batchIndex = 0;
        var restarted = false;
        var candidate: any = null;
        function splitPending(): void {
            var remaining: any[] = [];
            batches.slice(batchIndex).forEach(function (batch) {
                batch.forEach(function (metadata: any) {
                    remaining.push(metadata);
                });
            });
            // Repack across old byte-limit boundaries, so a reduction does not
            // multiply tiny tail batches and consume the public request quota.
            batches = batches.slice(0, batchIndex).concat(partition(remaining));
        }
        function complete(error?: string | null, httpStatus?: number): void {
            matching = false;
            if (error) {
                matchFailures++;
                failure(error, httpStatus);
            }
            var callbacks = matchWaiters;
            matchWaiters = [];
            callbacks.forEach(function (callback) {
                callback(!error);
            });
            schedule();
            pump();
        }
        function next(): void {
            if (closed) return;
            var batch = batches[batchIndex];
            var expected: any = Object.create(null);
            batch.forEach(function (row: any) {
                expected[row.id] = true;
            });
            progress("download");
            request(
                "POST",
                configuration.apiBase + "/match",
                { channels: batch, source: "epg-one", version: 1 },
                function (error, value, httpStatus) {
                    if (
                        error === "EPG_TIMEOUT" &&
                        httpStatus === 504 &&
                        batch.length > MIN_MATCH_BATCH_SIZE
                    ) {
                        // A server deadline can be exceeded by valid but expensive
                        // metadata. Halving is finite (at most three reductions),
                        // and never exposes a partially matched catalogue.
                        matchBatchSize = Math.min(
                            matchBatchSize,
                            Math.max(
                                MIN_MATCH_BATCH_SIZE,
                                Math.floor(batch.length / 2)
                            )
                        );
                        splitPending();
                        next();
                        return;
                    }
                    if (
                        !error &&
                        (!mappings(value) ||
                            !Object.keys(value.mappings).every(function (id) {
                                return !!expected[id];
                            }))
                    )
                        error = "EPG_RESPONSE";
                    if (
                        !error &&
                        candidate &&
                        value.generation !== candidate.generation
                    ) {
                        if (!restarted) {
                            restarted = true;
                            batchIndex = 0;
                            candidate = null;
                            splitPending();
                            next();
                            return;
                        }
                        error = "EPG_GENERATION";
                    }
                    if (error) {
                        complete(error, httpStatus);
                        return;
                    }
                    if (!candidate)
                        candidate = {
                            fetchedAt: value.fetchedAt,
                            generation: value.generation,
                            mappings: Object.create(null),
                            refreshMs: value.refreshMs,
                            signature: signature,
                            source: "epg-one",
                            stale: value.stale,
                            version: 1,
                        };
                    Object.keys(value.mappings).forEach(function (id) {
                        candidate.mappings[id] = value.mappings[id];
                    });
                    batchIndex++;
                    if (batchIndex < batches.length) {
                        next();
                        return;
                    }
                    matchFailures = 0;
                    active = candidate;
                    cache("active", candidate, function () {
                        // Commit all batches together; no partial catalogue is
                        // visible while a snapshot changes between requests.
                        ready(false);
                        complete();
                    });
                }
            );
        }
        next();
    }
    function rowSize(rows: any): number {
        if (!Array.isArray(rows) || rows.length > 20000) return -1;
        var bytes = 0;
        var previous = -Infinity;
        for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            if (
                !row ||
                !integer(row.time, -9007199254740991, 9007199254740991) ||
                !integer(row.time_to, row.time + 1, 9007199254740991) ||
                row.time < previous ||
                !text(row.name, 65536) ||
                !text(row.descr, 1048576) ||
                !text(row.icon, 4096)
            )
                return -1;
            previous = row.time;
            bytes +=
                80 + 2 * (row.name.length + row.descr.length + row.icon.length);
            if (bytes > GUIDE_BYTES) return -1;
        }
        return bytes;
    }
    function filtered(rows: any[], hours: number): any[] {
        var now = Math.floor(Date.now() / 1000);
        return rows.filter(function (row) {
            return (
                row.time_to > now - (hours || 48) * 3600 &&
                row.time < now + 48 * 3600
            );
        });
    }
    function finish(job: any, rows: any): void {
        if (job.done) return;
        job.done = true;
        delete jobs[job.key];
        env.clearTimeout(job.timer);
        if (job.running) running--;
        else {
            var queued = queue.indexOf(job);
            if (queued >= 0) queue.splice(queued, 1);
        }
        if (job.abort) job.abort();
        if (rows && rows.length) cachedRows = true;
        job.queries.forEach(function (query: any) {
            send({
                cached: cachedRows,
                query: query,
                rows: rows,
                type: "guide",
            });
        });
        pump();
    }
    function stopJob(job: any): void {
        finish(job, null);
    }
    function fetchGuide(job: any): void {
        if (job.done) return;
        if (Date.now() >= job.deadline) {
            stopJob(job);
            return;
        }
        var mapping = active && active.mappings[job.id];
        if (!mapping) {
            finish(job, null);
            return;
        }
        var generation = active.generation;
        var key = JSON.stringify([mapping.channelId, mapping.shift, job.hours]);
        cache(key, undefined, function (saved) {
            if (closed || job.done) return;
            if (active.generation !== generation) {
                if (job.retried) finish(job, null);
                else {
                    job.retried = true;
                    fetchGuide(job);
                }
                return;
            }
            // Canonical guide keys are independent of playlist metadata.
            // The fixed public source and accepted generation guard reuse.
            var savedValid = saved && rowSize(saved.rows) >= 0;
            function fallback(): any {
                var current = active && active.mappings[job.id];
                return savedValid &&
                    current &&
                    current.channelId === mapping.channelId &&
                    current.shift === mapping.shift
                    ? filtered(saved.rows, job.hours)
                    : null;
            }
            if (
                savedValid &&
                saved.generation === generation &&
                Date.now() >= saved.used &&
                Date.now() - saved.used < 7200000 &&
                (filtered(saved.rows, job.hours).length > 0 ||
                    Date.now() - saved.used < 60000)
            ) {
                finish(job, filtered(saved.rows, job.hours));
                return;
            }
            // Do not start network work when its consumer is about to expire.
            if (job.deadline - Date.now() < 1000) {
                finish(job, fallback());
                return;
            }
            var url =
                configuration.apiBase +
                "/programmes?channelId=" +
                encodeURIComponent(mapping.channelId) +
                "&shift=" +
                mapping.shift +
                "&hours=" +
                job.hours +
                "&generation=" +
                encodeURIComponent(generation);
            job.abort = request(
                "GET",
                url,
                null,
                function (error, value, httpStatus) {
                    if (job.done) return;
                    if (
                        error === "EPG_GENERATION" ||
                        (!error && active.generation !== generation)
                    ) {
                        if (!job.retried) {
                            job.retried = true;
                            if (active.generation !== generation)
                                fetchGuide(job);
                            else
                                match(function (ok) {
                                    if (job.done) return;
                                    if (ok) fetchGuide(job);
                                    else finish(job, fallback());
                                });
                            return;
                        }
                        error = "EPG_GENERATION";
                    }
                    var bytes = -1;
                    if (!error) {
                        if (
                            !envelope(value) ||
                            value.generation !== generation ||
                            (bytes = rowSize(value.rows)) < 0
                        )
                            error = "EPG_RESPONSE";
                    }
                    if (error) {
                        // Reply first: the bridge may report this error globally.
                        finish(job, fallback());
                        guideFailed = true;
                        failure(error, httpStatus);
                        return;
                    }
                    value.rows = value.rows.map(function (row: any) {
                        return {
                            descr: row.descr,
                            icon: row.icon,
                            name: row.name,
                            time: row.time,
                            time_to: row.time_to,
                        };
                    });
                    var stored = {
                        bytes: bytes,
                        generation: generation,
                        rows: value.rows,
                        used: Date.now(),
                    };
                    cache(key, stored, function () {
                        if (job.done) return;
                        if (active.generation !== generation) {
                            if (job.retried) finish(job, null);
                            else {
                                job.retried = true;
                                fetchGuide(job);
                            }
                            return;
                        }
                        finish(job, filtered(value.rows, job.hours));
                        if (guideFailed && !matching && !matchFailures) {
                            guideFailed = false;
                            ready(false);
                        }
                    });
                },
                job.deadline - Date.now()
            );
        });
    }
    function pump(): void {
        while (!closed && active && running < 4 && queue.length) {
            var job = queue.shift();
            if (job.done) continue;
            job.running = true;
            running++;
            fetchGuide(job);
        }
    }
    function guide(id: string, query: any): void {
        var row = channels[id];
        var mapping = active && active.mappings[id];
        if (!row || !mapping) {
            send({ query: query, rows: null, type: "guide" });
            return;
        }
        var key = JSON.stringify([
            id,
            mapping.channelId,
            mapping.shift,
            row.archiveHours,
        ]);
        if (jobs[key]) {
            jobs[key].queries.push(query);
            return;
        }
        if (queue.length >= 128) {
            send({ query: query, rows: null, type: "guide" });
            return;
        }
        var job = {
            deadline: Date.now() + 40000,
            done: false,
            hours: row.archiveHours,
            id: id,
            key: key,
            queries: [query],
            retried: false,
            running: false,
            timer: null as any,
        };
        job.timer = env.setTimeout(function () {
            stopJob(job);
        }, 40000);
        jobs[key] = job;
        queue.push(job);
        pump();
    }
    function load(input: any): void {
        if (configuration || closed) return;
        if (
            !input ||
            input.apiBase !== "/epg/v1" ||
            input.sourceId !== "epg-one" ||
            !Array.isArray(input.channels) ||
            input.channels.length > 16384 ||
            !input.channels.every(function (row: any) {
                if (
                    !row ||
                    !text(row.id, 512) ||
                    !row.id.length ||
                    channels[row.id] ||
                    !text(row.name, 512) ||
                    !text(row.tvgId || "", 512) ||
                    !text(row.tvgName || "", 512) ||
                    !integer(row.archiveHours, 0, 8784)
                )
                    return false;
                channels[row.id] = row;
                return true;
            })
        ) {
            failure("EPG_CONFIGURATION");
            return;
        }
        configuration = input;
        signature = JSON.stringify([
            2, // Rematch pre-numeric-brand-policy snapshots once after upgrade.
            input.sourceId,
            input.channels.map(function (row: any) {
                return [
                    row.id,
                    row.name,
                    row.tvgId,
                    row.tvgName,
                    row.archiveHours,
                ];
            }),
        ]);
        progress("cache");
        function begin(): void {
            if (closed) return;
            cache("active", undefined, function (saved) {
                if (saved && saved.signature === signature && mappings(saved)) {
                    active = saved;
                    ready(true);
                }
                match(function () {});
            });
        }
        try {
            var begun = false;
            function beginOnce(): void {
                if (begun) return;
                begun = true;
                begin();
            }
            var opening = env.indexedDB.open("ottplay-hosted-epg-server-v1", 1);
            opening.onupgradeneeded = function () {
                opening.result.createObjectStore("cache");
                opening.result.createObjectStore("usage");
            };
            opening.onerror = opening.onblocked = beginOnce;
            opening.onsuccess = function () {
                if (closed) {
                    opening.result.close();
                    return;
                }
                database = opening.result;
                database.onversionchange = function () {
                    database.close();
                    database = null;
                };
                beginOnce();
            };
        } catch (_) {
            begin();
        }
    }
    env.onmessage = function (event: any) {
        var value = event.data || {};
        if (closed) return;
        if (value.type === "load") load(value);
        else if (value.type === "guide") guide(String(value.id), value.query);
        else if (value.type === "cancel") {
            Object.keys(jobs).forEach(function (key) {
                var job = jobs[key];
                // finish() can synchronously drain a queued memory-cache hit.
                if (!job) return;
                job.queries = job.queries.filter(function (query: any) {
                    return String(query) !== String(value.query);
                });
                if (!job.queries.length) stopJob(job);
            });
        } else if (value.type === "close") {
            closed = true;
            env.clearTimeout(refreshTimer);
            requests.slice().forEach(function (xhr) {
                xhr.abort();
            });
            requests = [];
            Object.keys(jobs).forEach(function (key) {
                env.clearTimeout(jobs[key].timer);
            });
            queue = [];
            jobs = Object.create(null);
            matchWaiters = [];
            if (database) database.close();
            env.postMessage({ type: "closed" });
        }
    };
}
