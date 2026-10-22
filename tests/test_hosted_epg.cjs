"use strict";
// Real Worker, gzip decoder, XML parser and IndexedDB. No network provider required.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const zlib = require("node:zlib");
const vm = require("node:vm");
const ts = require("typescript");
const { chromium } = require("playwright");
const { artifacts } = require("../scripts/hosted-epg.cjs");
const root = path.resolve(__dirname, "..");
const generated = artifacts();
const workerAst = ts.createSourceFile(
    "epg-worker.ts",
    fs.readFileSync(path.join(root, "src/hosted/epg-worker.ts"), "utf8"),
    ts.ScriptTarget.Latest,
    true
);
const workerFactory = workerAst.statements.find(
    (node) =>
        ts.isFunctionDeclaration(node) &&
        node.name.text === "createHostedEpgWorker"
);
// Exercise the real factory's scheduler and close lifecycle. Only the private
// enqueue entry point is exposed; no parser or scheduler implementation is mocked.
const schedulerFactory = ts.transpileModule(
    workerFactory
        .getText(workerAst)
        .replace(
            "env.onmessage = function",
            "env.enqueueParseForTest = yieldParse; env.onmessage = function"
        ),
    { compilerOptions: { target: ts.ScriptTarget.ES5 } }
).outputText;
for (const channelSupport of ["available", "absent", "throws"]) {
    const messages = [],
        timers = [],
        tasks = [],
        ports = [];
    const env = {
        clearInterval() {},
        clearTimeout() {},
        postMessage: (message) => messages.push(message),
        setTimeout: (callback, delay) => {
            assert.equal(delay, 0);
            timers.push(callback);
        },
    };
    if (channelSupport !== "absent") {
        env.MessageChannel = function () {
            if (channelSupport === "throws") throw new Error("unavailable");
            this.port1 = { close: () => ports.push("read"), onmessage: null };
            this.port2 = {
                close: () => ports.push("write"),
                postMessage: () => tasks.push(this.port1.onmessage),
            };
        };
    }
    vm.runInNewContext(schedulerFactory + "\ncreateHostedEpgWorker(env);", {
        env,
    });
    const queue = channelSupport === "available" ? tasks : timers;
    let calls = 0;
    env.enqueueParseForTest(() => calls++);
    assert.equal(calls, 0, "parsing must yield rather than recurse");
    assert.equal(queue.length, 1);
    queue.shift()();
    assert.equal(calls, 1);
    env.enqueueParseForTest(() => calls++);
    const pending = queue.shift();
    env.onmessage({ data: { type: "close" } });
    pending();
    env.enqueueParseForTest(() => calls++);
    assert.equal(calls, 1, "close cancels queued parsing and future work");
    assert.equal(queue.length, 0);
    assert.equal(messages.at(-1).type, "closed");
    assert.deepEqual(
        ports,
        channelSupport === "available" ? ["read", "write"] : []
    );
    env.onmessage({ data: { type: "close" } });
    assert.equal(ports.length, channelSupport === "available" ? 2 : 0);
}
console.log(
    "PASS hosted EPG parser yielding, legacy fallback and queued close"
);
// A cache reopened near expiry must keep its original refresh deadline. Drive
// the actual load/schedule paths without waiting two hours or fetching a feed.
const cacheScheduleSource = ts.transpileModule(
    ["load", "schedule", "validUrl"]
        .map((name) =>
            workerFactory.body.statements
                .find(
                    (node) =>
                        ts.isFunctionDeclaration(node) &&
                        node.name.text === name
                )
                .getText(workerAst)
        )
        .join("\n"),
    { compilerOptions: { target: ts.ScriptTarget.ES5 } }
).outputText;
function cacheScheduleFixture(age, replacementAge = age, now = 20000000) {
    const input = {
        channels: [],
        refreshMs: 7200000,
        sources: ["https://fixture.test/feed.gz"],
    };
    const signature = JSON.stringify([input.sources, input.channels]);
    const snapshot = (value) =>
        value === null ? null : { fetched: now - value, signature };
    const state = {
        delay: null,
        now,
        read: { result: snapshot(age) },
        refreshes: 0,
        replacement: snapshot(replacementAge),
    };
    const env = {
        clearTimeout() {},
        setTimeout(_callback, delay) {
            state.delay = delay;
        },
    };
    const fixture = new Function(
        "env",
        "Date",
        "state",
        "var active=null, configuration=null, database=null, databaseName='', " +
            "signature='', loading=false, closed=false, timer=null;\n" +
            "function identity() { return 'fixture'; }\n" +
            "function open(next) { database={}; next(); }\n" +
            "function transaction() { return {objectStore: function() {return {get: function() { return state.read; }};}}; }\n" +
            "function progress() {} function ready() {} function release() {}\n" +
            "function fail(code) { throw new Error(code); }\n" +
            "function lease(next) { next(); }\n" +
            "function cleanup(next) { next(state.replacement); }\n" +
            "function refresh() { state.refreshes++; }\n" +
            cacheScheduleSource +
            "\nreturn {load:load, schedule:schedule};"
    )(env, { now: () => state.now }, state);
    fixture.load(input);
    state.read.onsuccess();
    return { ...fixture, state };
}
{
    const f = cacheScheduleFixture(7200000 - 60000);
    assert.equal(f.state.refreshes, 0);
    assert.equal(
        f.state.delay,
        60000,
        "reopened cache refreshes at its original expiry, not two hours later"
    );
    f.schedule();
    assert.equal(
        f.state.delay,
        7200000,
        "normal error retries and new commits retain the full interval"
    );
    f.schedule(f.state.now - 7200000);
    assert.equal(f.state.delay, 1, "an elapsed deadline uses a positive delay");
    f.schedule(f.state.now - 7200001);
    assert.equal(
        f.state.delay,
        1,
        "crossing expiry cannot create a negative delay"
    );
    f.schedule(f.state.now + 60000);
    assert.equal(
        f.state.delay,
        7200000,
        "clock rollback cannot extend the interval"
    );
}
assert.equal(cacheScheduleFixture(0).state.delay, 7200000);
assert.equal(
    cacheScheduleFixture(60000, 60000, 60000).state.delay,
    7140000,
    "an epoch-zero fetched timestamp is a valid deadline"
);
assert.equal(
    cacheScheduleFixture(7200000, 7140000).state.delay,
    60000,
    "a fresh snapshot discovered after acquiring the lease keeps its expiry"
);
for (const age of [null, 7200000, 7200001]) {
    const f = cacheScheduleFixture(age);
    assert.equal(
        f.state.refreshes,
        1,
        "missing/expired cache refreshes immediately"
    );
    assert.equal(f.state.delay, null);
    f.schedule();
    assert.equal(
        f.state.delay,
        7200000,
        "failed refresh keeps normal retry backoff"
    );
}
console.log("PASS hosted EPG saved-cache refresh deadline and retry intervals");
const cleanupDeclaration = workerFactory.body.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name.text === "cleanup"
);
const cleanupSource = ts.transpileModule(
    cleanupDeclaration.getText(workerAst),
    {
        compilerOptions: {
            module: ts.ModuleKind.ES2015,
            target: ts.ScriptTarget.ES5,
        },
    }
).outputText;
// Exercise the shipped parser's cumulative limit at a small boundary instead
// of allocating a half-gigabyte feed in every CI run. Today's 457 MB public
// feed has 648 MB of cumulative UTF-16 strings and used to fail this check.
const parseDeclaration = workerFactory.body.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name.text === "parse"
);
// Keep pending rows across short parser yields, but persist the final partial
// batch before readiness. Exercise the actual flush and close/queue functions.
const flushSource = ts.transpileModule(
    parseDeclaration.body.statements
        .find(
            (node) =>
                ts.isFunctionDeclaration(node) && node.name.text === "flush"
        )
        .getText(workerAst) +
        "\n" +
        workerFactory.body.statements
            .filter(
                (node) =>
                    ts.isFunctionDeclaration(node) &&
                    ["continueParse", "yieldParse", "close"].includes(
                        node.name.text
                    )
            )
            .map((node) => node.getText(workerAst))
            .join("\n"),
    { compilerOptions: { target: ts.ScriptTarget.ES5 } }
).outputText;
function flushFixture(bytes, ended = false) {
    const transactions = [],
        tasks = [],
        errors = [],
        messages = [];
    const batch = { channel: [{ name: "first" }, { name: "second" }] };
    const fixture = new Function(
        "initial",
        "env",
        "transaction",
        "error",
        "var pending=initial.batch, pendingBytes=initial.bytes, ended=initial.ended, " +
            "owner='owner', generation='generation', sourceIndex=0, sequence=0, " +
            "closed=false, parseNext=null, parseChannel=null, database=null, timer=null, loading=true; " +
            "function clearDownload() {} function release(done) {if(done) done(true);}\n" +
            flushSource +
            "\nreturn {flush:flush, close:close, enqueue:yieldParse, " +
            "finish:function(){ended=true;}, state:function(){return {pending:pending, bytes:pendingBytes};}};"
    )(
        { batch, bytes, ended },
        {
            clearTimeout() {},
            postMessage: (value) => messages.push(value),
            setTimeout: (task) => tasks.push(task),
        },
        () => {
            const read = {
                result: { owner: "owner", until: Date.now() + 60000 },
            };
            const tx = {
                abort() {
                    this.aborted = true;
                    this.onabort();
                },
                aborted: false,
                commit() {
                    read.onsuccess();
                    if (!this.aborted) this.oncomplete();
                },
                objectStore: (name) =>
                    name === "meta"
                        ? { get: () => read }
                        : { put: (row) => tx.writes.push(row) },
                read,
                writes: [],
            };
            transactions.push(tx);
            return tx;
        },
        (code) => errors.push(code)
    );
    return { ...fixture, batch, errors, messages, tasks, transactions };
}
{
    const f = flushFixture(256 * 1024 - 1);
    let continued = 0;
    f.flush(() => continued++);
    assert.equal(
        continued,
        1,
        "sub-threshold batches still yield to the scheduler"
    );
    assert.equal(
        f.transactions.length,
        0,
        "a short slice needs no write transaction"
    );
    assert.equal(f.state().pending, f.batch, "deferred rows remain pending");
    assert.equal(f.state().bytes, 256 * 1024 - 1);
    f.finish();
    f.flush(() => continued++);
    assert.equal(continued, 1, "final continuation waits for commit");
    assert.equal(f.transactions.length, 1);
    assert.equal(f.state().bytes, 0);
    f.transactions[0].commit();
    assert.equal(continued, 2);
    assert.deepEqual(f.transactions[0].writes, [
        {
            channel: "channel",
            generation: "generation",
            key: "generation:0:000000",
            rows: f.batch.channel,
        },
    ]);
}
for (const failure of [null, "lease", "transaction"]) {
    const f = flushFixture(256 * 1024);
    let continued = false;
    f.flush(() => {
        continued = true;
    });
    assert.equal(
        f.transactions.length,
        1,
        "the exact threshold persists immediately"
    );
    assert.equal(continued, false);
    const tx = f.transactions[0];
    if (failure === "lease") tx.read.result.owner = "replacement-owner";
    if (failure === "transaction") tx.abort();
    else tx.commit();
    assert.equal(continued, failure === null);
    assert.deepEqual(f.errors, failure ? ["EPG_STORAGE_FAILED"] : []);
    assert.equal(tx.writes.length, failure ? 0 : 1);
}
{
    const f = flushFixture(80);
    let completed = false;
    f.flush(() =>
        f.enqueue(() => {
            f.finish();
            f.flush(() => {
                completed = true;
            });
        })
    );
    assert.equal(f.tasks.length, 1);
    f.close();
    f.tasks[0]();
    assert.equal(completed, false);
    assert.equal(
        f.transactions.length,
        0,
        "close cancels deferred persistence"
    );
    assert.deepEqual(f.messages, [{ type: "closed" }]);
}
console.log(
    "PASS hosted EPG bounded persistence, final commit, lease failure and pending close"
);
const textDeclaration = parseDeclaration.body.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name.text === "text"
);
const bytesDeclaration = workerFactory.body.statements.find(
    (node) =>
        ts.isFunctionDeclaration(node) && node.name.text === "xmlByteLength"
);
const limitSource = ts.transpileModule(
    bytesDeclaration.getText(workerAst) +
        "\n" +
        textDeclaration.getText(workerAst),
    { compilerOptions: { target: ts.ScriptTarget.ES5 } }
).outputText;
for (const chunks of [
    ["<tv>", "ascii programme data".repeat(100), "</tv>"],
    ["Программа передач", "日本語", "😀", "</tv>"],
]) {
    const limit = Buffer.byteLength(chunks.join(""), "utf8");
    const written = [];
    const accept = new Function(
        "XML_LIMIT",
        "parser",
        "var decoded = 0;\n" + limitSource + "\nreturn text;"
    )(limit, { write: (chunk) => written.push(chunk) });
    for (const chunk of chunks) accept(chunk);
    assert.deepEqual(
        written,
        chunks,
        "valid UTF-8 bytes fit exactly within the configured XML limit"
    );
    assert.throws(
        () => accept("x"),
        /EPG_XML_LIMIT/,
        "the actual input limit still rejects one extra byte"
    );
}
// Exercise the shipped accounting/limits without allocating hundreds of MiB.
// The standard 1,565-channel feed currently retains 134,648,412 estimated bytes,
// just beyond the former 128 MiB limit, while each transaction remains bounded.
const retainedSource = ts.transpileModule(
    workerFactory.body.statements
        .filter(
            (node) =>
                ts.isVariableStatement(node) &&
                node.declarationList.declarations.some((declaration) =>
                    [
                        "CACHE_BYTES",
                        "CHANNEL_BYTES",
                        "CHANNEL_RECORDS",
                    ].includes(declaration.name.getText(workerAst))
                )
        )
        .map((node) => node.getText(workerAst))
        .join("\n") +
        "\n" +
        parseDeclaration.body.statements
            .find((node) =>
                node.getText(workerAst).startsWith("parser.onclosetag =")
            )
            .getText(workerAst),
    { compilerOptions: { target: ts.ScriptTarget.ES5 } }
).outputText;
function retainFixture(overrides = {}) {
    const initial = {
        channelBytes: 0,
        channelRecords: 0,
        pendingBytes: 0,
        retainedBytes: 0,
        retainedRecords: 0,
        ...overrides,
    };
    return new Function(
        "initial",
        "var retainedBytes = initial.retainedBytes, retainedRecords = initial.retainedRecords, " +
            "pendingBytes = initial.pendingBytes, depth = 2, generation = 'fixture', sourceIndex = 0, retained = 0, " +
            "pending = {}, parser = {}, channelSizes = {'fixture|0|channel': {bytes: initial.channelBytes, rows: initial.channelRecords}}, " +
            "records = {end: function() {return {kind: 'programme', value: {id: 'channel', title: '', desc: '', begin: 1, end: 2}};}};\n" +
            retainedSource +
            "\nparser.onclosetag('programme'); return {bytes: retainedBytes, rows: retainedRecords, limit: CACHE_BYTES};"
    )(initial);
}
const cacheLimit = 192 * 1024 * 1024;
assert.equal(retainFixture().limit, cacheLimit);
assert.equal(retainFixture({ retainedBytes: 134648412 - 80 }).bytes, 134648412);
assert.equal(
    retainFixture({ retainedBytes: cacheLimit - 80 }).bytes,
    cacheLimit
);
assert.throws(
    () => retainFixture({ retainedBytes: cacheLimit - 79 }),
    /EPG_CACHE_LIMIT/
);
assert.equal(retainFixture({ retainedRecords: 299999 }).rows, 300000);
assert.throws(
    () => retainFixture({ retainedRecords: 300000 }),
    /EPG_CACHE_LIMIT/
);
for (const [property, boundary, cost, error] of [
    ["channelBytes", 8 * 1024 * 1024, 80, /EPG_CHANNEL_LIMIT/],
    ["channelRecords", 20000, 1, /EPG_CHANNEL_LIMIT/],
    ["pendingBytes", 4 * 1024 * 1024, 80, /EPG_BATCH_LIMIT/],
]) {
    assert.doesNotThrow(() => retainFixture({ [property]: boundary - cost }));
    assert.throws(
        () => retainFixture({ [property]: boundary - cost + 1 }),
        error
    );
}
// Repeated XMLTV declarations may add aliases but must neither replace the
// first metadata entry nor consume the distinct-channel budget again.
{
    const channelFixture = new Function(
        "var parser = {}, metadata = Object.create(null), metadataCount = 0, " +
            "aliases = [], indexed = false, depth = 2, row, " +
            "records = {end: function() { return {kind: 'channel', value: row}; }};\n" +
            retainedSource +
            "\nreturn {accept: function(id, name) {row = {id: id, names: [name]}; parser.onclosetag('channel');}, " +
            "metadata: metadata, aliases: aliases};"
    )();
    channelFixture.accept("first", "First name");
    channelFixture.accept("first", "Another alias");
    assert.equal(channelFixture.metadata.first.names[0], "First name");
    assert.deepEqual(channelFixture.aliases.slice(0, 2), [
        ["first", "First name"],
        ["first", "Another alias"],
    ]);
    for (let index = 1; index < 16384; index++)
        channelFixture.accept("channel" + index, "Channel " + index);
    assert.equal(Object.keys(channelFixture.metadata).length, 16384);
    assert.doesNotThrow(() => channelFixture.accept("first", "At capacity"));
    assert.throws(
        () => channelFixture.accept("one-too-many", "Overflow"),
        /EPG_CHANNEL_LIMIT/
    );
}
// Drive the actual download/cleanup functions with a deterministic XHR clock.
// Long transfers and stalled sockets must have different deadlines, without
// making the browser suite wait ten minutes for a timeout regression.
const downloadSource = ts.transpileModule(
    ["clearDownload", "fail", "close", "fetchSource"]
        .map((name) =>
            workerFactory.body.statements
                .find(
                    (node) =>
                        ts.isFunctionDeclaration(node) &&
                        node.name.text === name
                )
                .getText(workerAst)
        )
        .join("\n") +
        "\n" +
        workerFactory.body.statements
            .find((node) =>
                node.getText(workerAst).startsWith("env.onmessage =")
            )
            .getText(workerAst),
    { compilerOptions: { target: ts.ScriptTarget.ES5 } }
).outputText;
function downloadFixture() {
    let now = 0,
        nextTimer = 0;
    const timers = new Map(),
        requests = [];
    const env = {
        clearInterval(id) {
            timers.delete(id);
        },
        clearTimeout(id) {
            timers.delete(id);
        },
        location: { protocol: "https:" },
        postMessage() {},
        setTimeout(callback, delay) {
            const id = ++nextTimer;
            timers.set(id, { callback, due: now + delay });
            return id;
        },
        XMLHttpRequest: class {
            constructor() {
                this.aborts = 0;
                requests.push(this);
            }
            open() {}
            send() {
                // Model the browser's total XHR timeout; progress cannot reset it.
                this.deadline = env.setTimeout(() => {
                    if (this.ontimeout) this.ontimeout();
                }, this.timeout);
            }
            abort() {
                this.aborts++;
                env.clearTimeout(this.deadline);
                // Abort can synchronously trigger error delivery on older hosts.
                if (this.onerror) this.onerror();
            }
            progress(loaded, total = 1000000) {
                if (this.onprogress) this.onprogress({ loaded, total });
            }
            finish(status = 200) {
                env.clearTimeout(this.deadline);
                this.status = status;
                this.response = new ArrayBuffer(8);
                if (this.onload) this.onload();
            }
        },
    };
    const worker = new Function(
        "env",
        "var request = null, downloadTimer = null, loading = true, closed = false, " +
            "parseChannel = null, parseNext = null, " +
            "source = -1, downloaded = 0, total = 0, httpStatus = 0, phase = 'download', " +
            "timer = null, database = null, active = {}, scheduled = 0, parsed = 0, " +
            "messages = [], WIRE_LIMIT = 96 * 1024 * 1024, " +
            "configuration = { refreshMs: 7200000 };\n" +
            "function release(done) { if (done) done(true); }\nfunction progress() {}\n" +
            "function send(value) { if (!closed) messages.push(value); }\n" +
            "function schedule() { scheduled++; }\n" +
            "function parse() { parsed++; }\n" +
            downloadSource +
            "\nreturn { start: function() { fetchSource('https://fixture.test/feed.gz', 0, {}, function() {}); }, " +
            "fail: fail, messages: messages, state: function() { return {scheduled: scheduled, parsed: parsed, active: active, downloaded: downloaded, total: total}; } };"
    )(env);
    worker.start();
    return {
        ...worker,
        advance(milliseconds) {
            const end = now + milliseconds;
            while (true) {
                const next = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
                if (!next || next[1].due > end) break;
                now = next[1].due;
                timers.delete(next[0]);
                next[1].callback();
            }
            now = end;
        },
        close() {
            env.onmessage({ data: { type: "close" } });
        },
        requests,
        timers,
    };
}
function stoppedDownload(fixture, code, schedules = 1) {
    assert.equal(fixture.messages.length, code ? 1 : 0);
    if (code) {
        assert.equal(fixture.messages[0].code, code);
        assert.equal(
            fixture.messages[0].cached,
            true,
            "last good cache survives"
        );
    }
    assert.equal(fixture.state().scheduled, schedules);
    assert.equal(fixture.timers.size, 0, "no download timer survives cleanup");
    for (const name of ["onload", "onerror", "ontimeout", "onprogress"])
        assert.equal(fixture.requests[0][name], null);
    fixture.advance(600000);
    assert.equal(fixture.messages.length, code ? 1 : 0, "no late timeout");
}
{
    const f = downloadFixture();
    f.advance(59000);
    f.requests[0].progress(1);
    f.advance(59000);
    assert.equal(
        f.messages.length,
        0,
        "a delayed first byte renews the idle budget"
    );
    f.requests[0].finish();
    assert.equal(f.state().parsed, 1);
    stoppedDownload(f, null, 0);
}
{
    const f = downloadFixture();
    for (let index = 1; index <= 7; index++) {
        f.advance(30000);
        f.requests[0].progress(index * 1000);
    }
    assert.equal(
        f.messages.length,
        0,
        "active download survives the former 180s deadline"
    );
    f.requests[0].finish();
    assert.equal(f.state().parsed, 1);
    stoppedDownload(f, null, 0);
}
for (const [first, next] of [
    [0, 0],
    [1, 1],
    [2, 1],
]) {
    const f = downloadFixture();
    f.requests[0].progress(first, 0);
    for (let index = 0; index < 5; index++) {
        f.advance(10000);
        f.requests[0].progress(next, 0);
        assert.equal(
            f.state().downloaded,
            first,
            "downloaded byte count remains monotonic"
        );
        assert.equal(
            f.state().total,
            0,
            "unknown content length stays unknown"
        );
    }
    f.advance(10000);
    assert.equal(
        f.requests[0].aborts,
        1,
        "unchanged/zero/regressing-byte events cannot prevent an idle timeout"
    );
    stoppedDownload(f, "EPG_TIMEOUT");
}
{
    const f = downloadFixture();
    const old = f.requests[0];
    const callbacks = [old.onload, old.onerror, old.ontimeout, old.onprogress];
    f.fail("EPG_STORAGE_FAILED");
    f.start();
    const current = f.requests[1];
    for (const callback of callbacks)
        callback({ loaded: 100000001, total: 100000001 });
    assert.equal(
        f.messages.length,
        1,
        "stale terminal/progress callbacks cannot fail a retry"
    );
    assert.equal(
        f.state().downloaded,
        0,
        "stale progress cannot mutate a retry"
    );
    assert.equal(
        current.aborts,
        0,
        "a stale callback cannot abort the new request"
    );
    f.advance(59000);
    current.progress(10);
    f.advance(59000);
    current.finish();
    assert.equal(
        f.state().parsed,
        1,
        "retry retains its own live callbacks and timer"
    );
    assert.equal(f.timers.size, 0);
    f.advance(600000);
    assert.equal(f.messages.length, 1);
}
{
    const f = downloadFixture();
    for (let index = 1; index <= 10; index++) {
        f.advance(59000);
        f.requests[0].progress(index);
    }
    assert.equal(f.messages.length, 0);
    f.advance(10000);
    assert.equal(
        f.requests[0].aborts,
        1,
        "active traffic still has a 600s total deadline"
    );
    stoppedDownload(f, "EPG_TIMEOUT");
}
for (const failure of ["network", "http", "wire", "storage", "close"]) {
    const f = downloadFixture();
    if (failure === "network") f.requests[0].onerror();
    if (failure === "http") f.requests[0].finish(503);
    if (failure === "wire") f.requests[0].progress(96 * 1024 * 1024 + 1);
    if (failure === "storage") f.fail("EPG_STORAGE_FAILED");
    if (failure === "close") f.close();
    stoppedDownload(
        f,
        {
            close: null,
            http: "EPG_HTTP",
            network: "EPG_NETWORK",
            storage: "EPG_STORAGE_FAILED",
            wire: "EPG_WIRE_LIMIT",
        }[failure],
        failure === "close" || failure === "storage" ? 0 : 1
    );
}
console.log(
    "PASS hosted EPG download deadlines: first byte, increasing progress, idle, total time and cleanup"
);
// A pending failure release and a later close must join the same transaction.
const releaseSource = ts.transpileModule(
    ["release", "close"]
        .map((name) =>
            workerFactory.body.statements
                .find(
                    (node) =>
                        ts.isFunctionDeclaration(node) &&
                        node.name.text === name
                )
                .getText(workerAst)
        )
        .join("\n"),
    { compilerOptions: { target: ts.ScriptTarget.ES5 } }
).outputText;
for (const outcome of ["commit", "abort", "throw", "no-owner", "no-database"]) {
    let transactions = 0,
        deleted = 0,
        closedConnections = 0;
    const messages = [],
        read = { result: { owner: "fixture" } };
    const tx = {
        objectStore: () => ({ delete: () => deleted++, get: () => read }),
    };
    const env = {
        clearInterval() {},
        clearTimeout() {},
        postMessage(value) {
            messages.push(value);
        },
    };
    const database =
        outcome === "no-database"
            ? null
            : {
                  close() {
                      closedConnections++;
                  },
              };
    const fixture = new Function(
        "env",
        "database",
        "transaction",
        "owner",
        "var leaseTimer=null, timer=null, releasing=false, released=[], closed=false, loading=true; " +
            "var parseChannel=null, parseNext=null; " +
            "function clearDownload() {}\n" +
            releaseSource +
            "\nreturn {release:release,close:close};"
    )(
        env,
        database,
        () => {
            transactions++;
            if (outcome === "throw") throw new Error("InvalidStateError");
            return tx;
        },
        outcome === "no-owner" ? "" : "fixture"
    );
    if (outcome === "commit" || outcome === "abort") {
        fixture.release(); // failure started releasing before close arrived
        fixture.close();
        assert.equal(transactions, 1);
        assert.equal(
            messages.length,
            0,
            "pending release cannot acknowledge early"
        );
        read.onsuccess();
        assert.equal(deleted, 1);
        if (outcome === "commit") tx.oncomplete();
        else tx.onabort();
    } else assert.doesNotThrow(() => fixture.close());
    assert.equal(closedConnections, database ? 1 : 0);
    assert.equal(
        messages.length,
        outcome === "abort" || outcome === "throw" ? 0 : 1,
        "only a successful release/no-owner close acknowledges; failures use the bridge fallback"
    );
}
// The actual bridge under a controlled clock: close acknowledgement, fallback,
// stale callbacks, generation deduplication and per-refresh diagnostic timing.
const bridgeSource = ts.transpileModule(
    fs.readFileSync(path.join(root, "src/hosted/epg.ts"), "utf8"),
    { compilerOptions: { target: ts.ScriptTarget.ES5 } }
).outputText;
function bridgeFixture() {
    let now = 1000000,
        timer = 0,
        notifications = 0,
        invalidations = 0;
    const timeouts = new Map(),
        workers = [];
    const host = {
        _: (value) => value,
        __OTTPLAY_HOSTED__: {
            epg: {
                source: "https://fixture.test/feed.gz",
                workerUrl: "/hosted/epg-worker.js",
            },
            version: 1,
        },
        __ottClassicGuide: {
            invalidate() {
                invalidations++;
            },
        },
        clearInterval() {},
        clearTimeout(id) {
            timeouts.delete(id);
        },
        setInterval() {
            return 0;
        },
        setTimeout(callback, delay) {
            const id = ++timer;
            timeouts.set(id, { callback, due: now + delay });
            return id;
        },
        Worker: function () {
            this.messages = [];
            this.postMessage = (value) => this.messages.push(value);
            this.terminate = () => {
                this.terminated = true;
            };
            workers.push(this);
        },
    };
    vm.runInNewContext(bridgeSource, {
        Date: { now: () => now },
        window: host,
    });
    const session = host.__ottHostedEpg.open(
        [{ id: "18", name: "Fixture" }],
        () => notifications++
    );
    return {
        advance(milliseconds) {
            now += milliseconds;
            for (const [id, value] of timeouts)
                if (value.due <= now) {
                    timeouts.delete(id);
                    value.callback();
                }
        },
        counts: () => [notifications, invalidations],
        diagnostics: () =>
            JSON.parse(JSON.stringify(host.__ottHostedEpg.diagnostics())),
        host,
        remoteSnapshot: () => host.__ottHostedEpg.remoteSnapshot(),
        send(value, worker = workers[workers.length - 1]) {
            worker.onmessage({ data: value });
        },
        session,
        workers,
    };
}
{
    const f = bridgeFixture(),
        old = f.workers[0],
        stale = old.onmessage;
    f.session.retry();
    assert.equal(
        old.terminated,
        undefined,
        "lease release precedes termination"
    );
    assert.equal(
        f.workers.length,
        1,
        "replacement waits for the close acknowledgement"
    );
    stale({ data: { mappings: {}, type: "ready" } });
    assert.deepEqual(
        f.counts(),
        [0, 0],
        "old attempt is immediately invalidated"
    );
    f.send({ type: "closed" }, old);
    assert.equal(old.terminated, true);
    assert.equal(f.workers.length, 2);
    f.session.close();
    f.advance(1000);
    assert.equal(
        f.workers[1].terminated,
        true,
        "wedged close is bounded to one second"
    );
    assert.equal(f.diagnostics().phase, "idle");
}
{
    const f = bridgeFixture();
    const ready = {
        fetched: 1,
        generation: "retained",
        mappings: { 18: {} },
        type: "ready",
    };
    f.send(ready);
    // Exercise the same GuideService used by ClassicGuide: a cancelled hosted
    // query projects a miss and schedules a later retry until invalidation.
    const context = vm.createContext({ window: f.host });
    require("./helpers/shared-core-runtime.cjs")(context, { vendorOnly: true });
    require("./helpers/private-runtime.cjs")(context, "src/guide/service.ts");
    const reference = {
        channelId: "18",
        id: "18",
        sourceId: "fixture",
        token: {},
    };
    const service = f.host.__ottGuideService.create({
        capacity: () => 0,
        clearTimer: f.host.clearTimeout,
        context: () => "fixture",
        current: () => true,
        decode: (_ref, rows) => rows || [],
        fetch: (_ref, done) => f.session.guide("18", done),
        nextCount: () => 1,
        now: () => 100,
        select: (rows, now, count) =>
            f.host.OttPlayCore.guideScheduleSelection(rows, now, count),
        timer: f.host.setTimeout,
    });
    const invalidate = f.host.__ottClassicGuide.invalidate;
    f.host.__ottClassicGuide.invalidate = (warm) => {
        invalidate(warm);
        service.invalidate(warm);
    };
    service.subscribe(reference, () => {});
    f.advance(0);
    assert.equal(f.workers[0].messages.at(-1).type, "guide");
    f.session.retry();
    assert.equal(service.field(reference, "missing"), true);
    assert(
        service.field(reference, "retryAt") > 100,
        "cancelled query leaves a real miss throttle"
    );
    f.send({ type: "closed" });
    f.send({ ...ready, stale: true });
    f.advance(0);
    const query = f.workers[1].messages.at(-1);
    assert.equal(
        query.type,
        "guide",
        "retained generation after retry immediately refetches cancelled guide"
    );
    f.send({
        query: query.query,
        rows: [
            {
                description: "",
                end: 110,
                id: "programme",
                start: 90,
                title: "Retained guide",
            },
        ],
        type: "guide",
    });
    assert.equal(service.field(reference, "title"), "Retained guide");
    f.send({ ...ready, stale: true });
    assert.deepEqual(
        f.counts(),
        [2, 2],
        "each attempt accepts the cache once, not on every lease poll"
    );
    service.dispose();
    f.session.close();
}
{
    const f = bridgeFixture();
    f.session.retry();
    f.session.retry();
    assert.equal(f.workers.length, 1, "rapid retries share the pending close");
    f.session.close();
    f.send({ type: "closed" });
    f.advance(1000);
    assert.equal(f.workers.length, 1, "close cancels every pending restart");
}
{
    const f = bridgeFixture();
    f.advance(20000);
    const ready = {
        fetched: 1020000,
        generation: "first",
        mappings: { 18: {} },
        records: 1,
        type: "ready",
    };
    f.send(ready);
    assert.equal(f.diagnostics().finished - f.diagnostics().started, 20000);
    f.advance(7200000);
    f.send({ phase: "cache", type: "progress" });
    const started = f.diagnostics().started;
    for (let n = 0; n < 3; n++) {
        f.send({ ...ready, stale: true });
        f.send({ phase: "waiting", type: "progress" });
        f.advance(1000);
        f.send({ phase: "cache", type: "progress" });
    }
    assert.deepEqual(
        f.counts(),
        [1, 1],
        "unchanged generation does not rebuild guide mappings"
    );
    assert.equal(
        f.diagnostics().started,
        started,
        "waiting belongs to the same refresh"
    );
    f.send(ready);
    assert.equal(
        f.diagnostics().phase,
        "ready",
        "fresh/stale transitions still update status"
    );
    f.send({ ...ready, generation: "second" });
    assert.deepEqual(
        f.counts(),
        [2, 2],
        "new generation invalidates even with the same timestamp"
    );
    f.send({
        cached: true,
        code: "EPG_HTTP",
        httpStatus: 503,
        phase: "download",
        type: "error",
    });
    f.advance(7200000);
    f.send({ phase: "cache", type: "progress" });
    assert.equal(
        f.diagnostics().started - started,
        7203000,
        "scheduled recovery resets elapsed time"
    );
    f.session.close();
}
{
    const f = bridgeFixture();
    f.send({ fetched: 1, mappings: {}, type: "ready" });
    f.send({ fetched: 1, mappings: {}, type: "ready" });
    f.send({ fetched: 2, mappings: {}, type: "ready" });
    assert.deepEqual(
        f.counts(),
        [2, 2],
        "older Worker readiness uses its fetched timestamp"
    );
    f.session.close();
}
{
    const f = bridgeFixture();
    f.advance(100);
    f.send({ phase: "cache", type: "progress" });
    f.advance(900);
    f.send({ phase: "download", source: 0, type: "progress" });
    f.advance(30000);
    const duringDownload = f.diagnostics();
    assert.deepEqual(duringDownload.timings, {
        cache: 1000,
        download: 30000,
        parse: 0,
    });
    assert.deepEqual(
        f.diagnostics().timings,
        duringDownload.timings,
        "reading live diagnostics cannot count a stage twice"
    );
    const remote = f.remoteSnapshot();
    assert.deepEqual(JSON.parse(JSON.stringify(remote)), {
        available: true,
        elapsedMs: 31000,
        enabled: true,
        failedPhase: null,
        phase: "download",
        timingsMs: { cache: 1000, download: 30000, parse: 0 },
    });
    remote.phase = "private_mutation";
    remote.timingsMs.download = -1;
    assert.equal(f.remoteSnapshot().phase, "download");
    assert.equal(f.remoteSnapshot().timingsMs.download, 30000);
    f.send({ phase: "download", source: 0, type: "progress" });
    f.advance(20000);
    f.send({ phase: "parse", source: 0, type: "progress" });
    f.advance(25000);
    f.send({ phase: "download", source: 1, type: "progress" });
    f.advance(10000);
    f.send({ phase: "parse", source: 1, type: "progress" });
    f.advance(10000);
    f.send({ fetched: 1, mappings: {}, type: "ready" });
    assert.equal(f.diagnostics().finished - f.diagnostics().started, 96000);
    assert.deepEqual(f.diagnostics().timings, {
        cache: 1000,
        download: 60000,
        parse: 35000,
    });
    const completed = JSON.parse(JSON.stringify(f.remoteSnapshot()));
    assert.equal(completed.phase, "ready");
    assert.equal(completed.elapsedMs, 96000);
    assert.deepEqual(completed.timingsMs, {
        cache: 1000,
        download: 60000,
        parse: 35000,
    });
    f.advance(7200000);
    assert.deepEqual(
        f.diagnostics().timings,
        { cache: 1000, download: 60000, parse: 35000 },
        "completed stage durations freeze alongside total elapsed time"
    );
    assert.deepEqual(JSON.parse(JSON.stringify(f.remoteSnapshot())), completed);
    f.send({ phase: "cache", type: "progress" });
    f.advance(50);
    f.send({ phase: "waiting", type: "progress" });
    f.advance(1000);
    f.send({ phase: "cache", type: "progress" });
    f.send({ fetched: 1, mappings: {}, stale: true, type: "ready" });
    f.advance(50);
    f.send({ phase: "download", type: "progress" });
    f.advance(2000);
    f.send({ code: "EPG_HTTP", phase: "download", type: "error" });
    assert.deepEqual(f.diagnostics().timings, {
        cache: 1100,
        download: 2000,
        parse: 0,
    });
    f.advance(10000);
    assert.equal(
        f.diagnostics().timings.download,
        2000,
        "failure freezes timing"
    );
    assert.equal(f.remoteSnapshot().phase, "error");
    assert.equal(f.remoteSnapshot().failedPhase, "download");
    assert.equal(f.remoteSnapshot().elapsedMs, 3100);
    f.session.retry();
    f.send({ type: "closed" });
    f.advance(80);
    f.send({ fetched: 1, mappings: {}, type: "ready" });
    assert.deepEqual(
        f.diagnostics().timings,
        { cache: 80, download: 0, parse: 0 },
        "retry resets all stages; a warm cache has no download or parse time"
    );
    f.session.close();
}
{
    const f = bridgeFixture();
    f.session.close();
    const idle = JSON.parse(JSON.stringify(f.remoteSnapshot()));
    assert.deepEqual(idle, {
        available: true,
        elapsedMs: null,
        enabled: true,
        failedPhase: null,
        phase: "idle",
        timingsMs: { cache: 0, download: 0, parse: 0 },
    });
    for (const native of ["Capacitor", "__TAURI__"]) {
        f.host[native] = {};
        assert.deepEqual(JSON.parse(JSON.stringify(f.remoteSnapshot())), {
            available: true,
            enabled: false,
        });
        delete f.host[native];
    }
    delete f.host.__OTTPLAY_HOSTED__;
    assert.deepEqual(JSON.parse(JSON.stringify(f.remoteSnapshot())), {
        available: true,
        enabled: false,
    });
}
{
    const f = bridgeFixture();
    f.host.__OTTPLAY_HOSTED__.epg.source =
        "https://private_user:private_password@private-host.invalid/private-file.xml?token=private_query";
    const session = f.host.__ottHostedEpg.open(
        [{ id: "private_channel", name: "private_name" }],
        () => {}
    );
    assert.ok(JSON.stringify(f.diagnostics()).includes("private-host.invalid"));
    const expectedKeys = [
        "available",
        "elapsedMs",
        "enabled",
        "failedPhase",
        "phase",
        "timingsMs",
    ].sort();
    for (const invalid of [
        "private_phase",
        "cache download",
        "ready\n",
        {},
        [],
        null,
        0,
    ]) {
        f.send({ phase: invalid, source: "private_source", type: "progress" });
        let value = f.remoteSnapshot();
        assert.equal(value.phase, null);
        assert.deepEqual(Object.keys(value).sort(), expectedKeys);
        assert.ok(!JSON.stringify(value).includes("private"));
        f.send({
            code: "private_error",
            phase: invalid,
            type: "error",
        });
        value = f.remoteSnapshot();
        assert.equal(value.phase, "error");
        assert.equal(value.failedPhase, null);
        assert.deepEqual(Object.keys(value).sort(), expectedKeys);
        assert.ok(!JSON.stringify(value).includes("private"));
    }
    session.close();
}
for (const invalidClockDelta of [
    NaN,
    Infinity,
    -1000001,
    1.5,
    9007199254740992,
]) {
    const f = bridgeFixture();
    f.advance(invalidClockDelta);
    const value = f.remoteSnapshot();
    assert.equal(value.elapsedMs, null);
    for (const number of Object.values(value.timingsMs))
        assert.ok(
            number === null || (Number.isSafeInteger(number) && number >= 0),
            "Remote durations contain only nonnegative safe integers or null"
        );
    f.session.close();
}
console.log(
    "PASS hosted EPG bridge close/retry, generation notifications, refresh elapsed time and private remote snapshots"
);
// An EPG screen can finish empty before the first hosted index arrives. Use the
// real bridge, GuideService and GuideScreen, controlling only transport delivery.
function hostedGuideFixture() {
    const f = require("./helpers/guide-runtime-fixture.cjs")(),
        host = f.host,
        workers = [];
    host.clearInterval = function () {};
    host.setInterval = function () {
        return 0;
    };
    host.__OTTPLAY_HOSTED__ = {
        epg: {
            source: "https://fixture.test/epg.gz",
            workerUrl: "/hosted/epg-worker.js",
        },
        version: 1,
    };
    host.Worker = function () {
        workers.push(this);
        this.postMessage = (value) => {
            if (value.type === "close")
                this.onmessage({ data: { type: "closed" } });
        };
        this.terminate = function () {};
    };
    vm.runInContext(bridgeSource, host);
    const session = host.__ottHostedEpg.open(
        [{ id: "1", name: "Station A" }],
        () => {
            // M3U publication invalidates the selected channel and repaints OSD.
            host.__ottClassicGuide.invalidateChannel(1);
            host.getCurProgData(1, function () {});
        }
    );
    return {
        ...f,
        pages: () => f.calls.filter((call) => call[0] === "page").length,
        ready(generation = "downloaded") {
            workers[0].onmessage({
                data: {
                    fetched: f.now() * 1000,
                    generation,
                    mappings: { 1: { channel: "fixture" } },
                    records: 1,
                    type: "ready",
                },
            });
            f.tick();
        },
        session,
    };
}
for (const pending of [false, true]) {
    const f = hostedGuideFixture(),
        h = f.host;
    h.playType = f.now() - 300;
    h.playTime = 25;
    h.epgList(0, 0, false);
    f.tick();
    if (!pending) f.complete([]);
    f.tick(f.now() + 92);
    f.ready();
    assert.equal(
        f.requests.length,
        2,
        "ready coalesces the open guide and OSD into one fresh request"
    );
    if (pending) f.complete([f.row(undefined, undefined, "Retired")], 0);
    f.complete([f.row(undefined, undefined, "Downloaded programme")], 1);
    assert.equal(h.__ottHostedEpg.diagnostics().phase, "ready");
    assert.equal(
        h.listArray[0]?.name,
        "Downloaded programme",
        "hosted ready refreshes both completed-empty and pending guide screens"
    );
    const pages = f.pages();
    f.ready();
    assert.equal(f.requests.length, 2, "same generation does not refetch");
    assert.equal(f.pages(), pages, "same generation does not repaint");
    f.ready("replacement");
    assert.equal(f.requests.length, 3, "next generation coalesces again");
    f.complete([f.row(undefined, undefined, "Replacement programme")], 2);
    assert.equal(h.listArray[0].name, "Replacement programme");
    f.session.close();
}
for (const departure of ["close", "replace"]) {
    const f = hostedGuideFixture(),
        h = f.host;
    let dispose = null;
    h.__ottClassicScreenPort = {
        onDispose(callback) {
            dispose = callback;
            return () => {
                if (dispose === callback) dispose = null;
                callback();
            };
        },
    };
    h.epgList(0, 0, false);
    f.tick();
    f.complete([]);
    if (departure === "close") h.closeList();
    else {
        dispose();
        h.listArray = [{ name: "Replacement menu" }];
    }
    const list = h.listArray,
        pages = f.pages();
    f.ready();
    f.complete([f.row()]);
    assert.equal(h.listArray, list, departure + " preserves the current view");
    assert.equal(f.pages(), pages, departure + " cannot reopen the guide");
    assert.equal(h.__ottClassicGuideScreen.current(), null);
    f.session.close();
}
console.log(
    "PASS hosted EPG ready refreshes only the current guide and coalesces row requests"
);
const now = Math.floor(Date.now() / 1000);
const stamp = (offset) =>
    new Date((now + offset) * 1000)
        .toISOString()
        .replace(/[-:T]/g, "")
        .slice(0, 14) + " +0000";
const programme = (offset, end, title, description = "", id = "18") =>
    `<programme channel="${id}" start="${stamp(offset)}" stop="${stamp(end)}"><title>${title}</title><desc>${description}</desc></programme>`;
const header =
    '<?xml version="1.0"?><!DOCTYPE tv SYSTEM "http://feed.test/inert.dtd"><tv><channel id="18"><display-name>РЕН ТВ HD</display-name><display-name>РЕН ТВ</display-name><icon src="https://example.test/ren.png"/></channel>';
const base =
    header +
    programme(-360000, -356400, "Archive") +
    programme(-3600, 3600, "Now &amp; next") +
    programme(3600, 7200, "Later") +
    "</tv>";
let body = zlib.gzipSync(base),
    status = 200,
    calls = 0,
    holdFeed = false;
const heldResponses = new Set();
let diagnosticsCalls = 0,
    diagnosticsStatus = 200,
    holdDiagnostics = false;
let diagnosticsBody = generated["epg-diagnostics.js"];
const heldDiagnostics = new Set();
function releaseDiagnostics() {
    for (const response of heldDiagnostics) response.end(diagnosticsBody);
    heldDiagnostics.clear();
}
async function waitDiagnostics(expected) {
    for (let i = 0; i < 200 && diagnosticsCalls < expected; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(diagnosticsCalls, expected);
}
const server = http.createServer((request, response) => {
    const name = new URL(request.url, "http://fixture").pathname;
    if (name === "/") {
        response.setHeader("Content-Type", "text/html");
        response.end("<!doctype html><title>Hosted EPG tests</title>");
        return;
    }
    if (name === "/feed.gz") {
        calls++;
        response.statusCode = status;
        if (holdFeed) {
            heldResponses.add(response);
            response.on("close", () => heldResponses.delete(response));
            response.write(body.subarray(0, 10));
        } else response.end(body);
        return;
    }
    if (name === "/hosted/epg-diagnostics.js") {
        diagnosticsCalls++;
        response.statusCode = diagnosticsStatus;
        response.setHeader("Content-Type", "text/javascript");
        response.setHeader("Cache-Control", "no-store");
        if (holdDiagnostics) {
            heldDiagnostics.add(response);
            response.on("close", () => heldDiagnostics.delete(response));
        } else response.end(diagnosticsBody);
        return;
    }
    if (name.startsWith("/hosted/") && generated[name.slice(8)]) {
        response.setHeader("Content-Type", "text/javascript");
        response.end(generated[name.slice(8)]);
        return;
    }
    const source =
        name === "/js/ottplay-core.js"
            ? "vendor/ottplay-core.js"
            : name === "/js/runtime-polyfills.js"
              ? "js/runtime-polyfills.js"
              : null;
    if (source) {
        response.setHeader("Content-Type", "text/javascript");
        response.end(fs.readFileSync(path.join(root, source)));
        return;
    }
    response.statusCode = 404;
    response.end();
});
(async () => {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.goto("http://127.0.0.1:" + server.address().port);
        // Execute the actual cleanup function over real IndexedDB at the exact
        // race boundary, without timer-dependent interleaving of two downloads.
        const cleanupRaces = await page.evaluate(async (source) => {
            const results = [];
            for (const scenario of [
                "stale-pointer",
                "lost-owner",
                "expired-owner",
            ]) {
                const name = "epg-cleanup-race-" + scenario;
                const database = await new Promise((resolve, reject) => {
                    const opening = indexedDB.open(name, 1);
                    opening.onupgradeneeded = () => {
                        opening.result.createObjectStore("meta", {
                            keyPath: "key",
                        });
                        opening.result
                            .createObjectStore("rows", {
                                keyPath: "key",
                            })
                            .createIndex("generation", "generation");
                    };
                    opening.onsuccess = () => resolve(opening.result);
                    opening.onerror = () => reject(opening.error);
                });
                await new Promise((resolve, reject) => {
                    const tx = database.transaction(
                        ["meta", "rows"],
                        "readwrite"
                    );
                    tx.objectStore("meta").put({
                        generation: "new",
                        key: "active",
                        signature: "fixture",
                    });
                    tx.objectStore("meta").put({
                        key: "lease",
                        owner:
                            scenario === "lost-owner"
                                ? "replacement"
                                : "holder",
                        until:
                            Date.now() +
                            (scenario === "expired-owner" ? -1000 : 60000),
                    });
                    for (const generation of ["old", "new", "orphan"])
                        for (const batch of [0, 1])
                            tx.objectStore("rows").put({
                                generation,
                                key: generation + ":" + batch,
                                rows: [{ descr: "Full programme description" }],
                            });
                    tx.oncomplete = resolve;
                    tx.onabort = () => reject(tx.error);
                });
                const scopes = [];
                // Cleaning a generation must not deserialize its programme data.
                const valueDescriptor = Object.getOwnPropertyDescriptor(
                    IDBCursorWithValue.prototype,
                    "value"
                );
                let valuesRead = 0;
                Object.defineProperty(IDBCursorWithValue.prototype, "value", {
                    ...valueDescriptor,
                    get() {
                        valuesRead++;
                        return valueDescriptor.get.call(this);
                    },
                });
                const outcome = await new Promise((resolve) => {
                    const cleanup = new Function(
                        "transaction",
                        "owner",
                        "signature",
                        "fail",
                        "schedule",
                        source + "\nreturn cleanup;"
                    )(
                        (stores, write) => {
                            scopes.push(stores);
                            return database.transaction(
                                stores,
                                write ? "readwrite" : "readonly"
                            );
                        },
                        "holder",
                        "fixture",
                        (code) => resolve({ code }),
                        () => {}
                    );
                    // The old implementation accepted the stale value from load.
                    // Passing it here makes the regression fail against that code.
                    if (cleanup.length === 2)
                        cleanup("old", () => resolve({ code: null }));
                    else cleanup(() => resolve({ code: null }));
                });
                Object.defineProperty(
                    IDBCursorWithValue.prototype,
                    "value",
                    valueDescriptor
                );
                const keys = await new Promise((resolve) => {
                    const tx = database.transaction(["rows"], "readonly"),
                        read = tx.objectStore("rows").getAllKeys();
                    read.onsuccess = () => resolve(read.result);
                });
                database.close();
                results.push({ keys, outcome, scenario, scopes, valuesRead });
            }
            return results;
        }, cleanupSource);
        assert.deepEqual(
            cleanupRaces[0].keys,
            ["new:0", "new:1"],
            "cleanup retains the committed pointer, not load's stale snapshot"
        );
        for (const race of cleanupRaces.slice(1)) {
            assert.equal(race.outcome.code, "EPG_LEASE_LOST", race.scenario);
            assert.deepEqual(
                race.keys,
                ["new:0", "new:1", "old:0", "old:1", "orphan:0", "orphan:1"],
                "unowned cleanup must not delete any rows"
            );
        }
        assert.deepEqual(
            cleanupRaces[0].scopes,
            [["meta", "rows"]],
            "lease, pointer and deletion share one transaction"
        );
        assert.equal(
            cleanupRaces[0].valuesRead,
            0,
            "generation cleanup reads keys without cloning programme descriptions"
        );
        await page.evaluate(() => {
            window.messages = [];
            window.makeWorker = function () {
                if (window.worker) window.worker.terminate();
                window.messages = [];
                window.worker = new Worker("/hosted/epg-worker.js");
                window.worker.onmessage = (event) => {
                    if (event.data.cacheName)
                        window.cacheName = event.data.cacheName;
                    window.messages.push(event.data);
                };
                window.worker.onerror = (event) =>
                    window.messages.push({
                        code: event.message,
                        type: "fatal",
                    });
            };
            window.waitMessage = function (type) {
                return new Promise((resolve, reject) => {
                    const started = Date.now();
                    const interval = setInterval(() => {
                        const at = window.messages.findIndex(
                            (m) => m.type === type || m.type === "fatal"
                        );
                        if (at >= 0) {
                            clearInterval(interval);
                            resolve(window.messages.splice(at, 1)[0]);
                        } else if (Date.now() - started > 30000) {
                            clearInterval(interval);
                            reject(
                                new Error(
                                    "Worker timeout: " +
                                        type +
                                        JSON.stringify(window.messages)
                                )
                            );
                        }
                    }, 5);
                });
            };
            window.configure = function () {
                const source = location.origin + "/feed.gz";
                worker.postMessage({
                    channels: [
                        {
                            archiveHours: 168,
                            id: "long",
                            name: "РЕН ТВ HD",
                            sources: [source],
                            tvgId: "18",
                            tvgName: "",
                        },
                        {
                            archiveHours: 24,
                            id: "short",
                            name: "РЕН ТВ +2",
                            sources: [source],
                            tvgId: "18",
                            tvgName: "",
                        },
                    ].concat(window.extraChannels || []),
                    refreshMs: 7200000,
                    sources: [source],
                    type: "load",
                });
            };
            window.getGuide = async function (id) {
                worker.postMessage({ id, query: id, type: "guide" });
                return (await waitMessage("guide")).rows;
            };
            window.expire = function (name) {
                return new Promise((resolve, reject) => {
                    const opening = indexedDB.open(name || window.cacheName, 1);
                    opening.onsuccess = () => {
                        const db = opening.result,
                            tx = db.transaction(["meta"], "readwrite"),
                            store = tx.objectStore("meta");
                        const read = store.get("active");
                        read.onsuccess = () => {
                            const value = read.result;
                            value.fetched = 0;
                            store.put(value);
                        };
                        tx.oncomplete = () => {
                            db.close();
                            resolve();
                        };
                        tx.onabort = () => reject(new Error("expire failed"));
                    };
                });
            };
            makeWorker();
            configure();
        });
        const ready = await page.evaluate(() => waitMessage("ready"));
        assert.equal(ready.stale, false);
        const phases = await page.evaluate(() =>
            messages.filter((m) => m.type === "progress")
        );
        assert(phases.some((m) => m.phase === "cache"));
        assert(
            phases.some(
                (m) => m.phase === "download" && m.loaded > 0 && m.source === 0
            )
        );
        assert(
            phases.some(
                (m) =>
                    m.phase === "parse" && m.loaded === m.total && m.records > 0
            )
        );
        let long = await page.evaluate(() => getGuide("long"));
        let short = await page.evaluate(() => getGuide("short"));
        assert.equal(long.length, 3);
        assert.equal(short.length, 2);
        assert.equal(long[1].name, "Now & next");
        assert.equal(
            short[0].time,
            long[1].time + 7200,
            "regional shift exactly once"
        );
        assert.equal(ready.mappings.long.logo, "https://example.test/ren.png");

        const before = calls;
        await page.evaluate(() => {
            makeWorker();
            configure();
        });
        await page.evaluate(() => waitMessage("ready"));
        assert.equal(calls, before, "fresh cache avoids another full download");

        // Seed beta.6's actual database/record layout. Its programme windows
        // were admitted with the old brand offset, so they require a new parse.
        const identitySource = ts.transpileModule(
            workerFactory.body.statements
                .find(
                    (node) =>
                        ts.isFunctionDeclaration(node) &&
                        node.name.text === "identity"
                )
                .getText(workerAst),
            { compilerOptions: { target: ts.ScriptTarget.ES5 } }
        ).outputText;
        const legacyBrandCache = await page.evaluate(async (source) => {
            const identity = new Function(source + "\nreturn identity;")();
            const url = location.origin + "/feed.gz";
            window.brandInput = {
                channels: [
                    {
                        archiveHours: 48,
                        id: "brand",
                        name: "Россия-1",
                        sources: [url],
                        tvgId: "18",
                        tvgName: "",
                    },
                ],
                refreshMs: 7200000,
                sources: [url],
                type: "load",
            };
            const signature = JSON.stringify([
                brandInput.sources,
                brandInput.channels,
            ]);
            const name = "ottplay-hosted-epg-v1-" + identity(signature);
            const now = Math.floor(Date.now() / 1000);
            await new Promise((resolve, reject) => {
                const opening = indexedDB.open(name, 1);
                opening.onupgradeneeded = () => {
                    const db = opening.result;
                    db.createObjectStore("meta", { keyPath: "key" });
                    const rows = db.createObjectStore("rows", {
                        keyPath: "key",
                    });
                    rows.createIndex("channel", "channel");
                    rows.createIndex("generation", "generation");
                };
                opening.onsuccess = () => {
                    const db = opening.result,
                        tx = db.transaction(["meta", "rows"], "readwrite");
                    tx.objectStore("meta").put({
                        fetched: Date.now(),
                        generation: "beta6",
                        key: "active",
                        mappings: {
                            brand: {
                                archiveHours: 48,
                                channel: "beta6|0|18",
                                logo: "",
                                priority: 0,
                                shift: -3600,
                            },
                        },
                        records: 1,
                        signature,
                    });
                    tx.objectStore("rows").put({
                        channel: "beta6|0|18",
                        generation: "beta6",
                        key: "beta6|0|18|0",
                        rows: [
                            {
                                descr: "",
                                icon: "",
                                name: "Wrong beta6 brand offset",
                                time: now - 600,
                                time_to: now + 3600,
                            },
                        ],
                    });
                    tx.oncomplete = () => {
                        db.close();
                        resolve();
                    };
                    tx.onabort = () => {
                        db.close();
                        reject(tx.error);
                    };
                };
                opening.onerror = () => reject(opening.error);
            });
            return name;
        }, identitySource);
        holdFeed = true;
        status = 503;
        await page.evaluate(() => {
            makeWorker();
            worker.postMessage(brandInput);
        });
        for (let i = 0; i < 200 && !heldResponses.size; i++)
            await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(
            heldResponses.size,
            1,
            "Old matching semantics require a fresh feed"
        );
        assert.equal(
            await page.evaluate(() => messages.some((m) => m.type === "ready")),
            false
        );
        assert.equal(
            await page.evaluate(() => getGuide("brand")),
            null,
            "Delayed refresh cannot use beta.6 brand offsets"
        );
        holdFeed = false;
        for (const response of heldResponses) response.end();
        const upgradeFailure = await page.evaluate(() => waitMessage("error"));
        assert.equal(upgradeFailure.cached, false);
        assert.equal(
            await page.evaluate(() => getGuide("brand")),
            null,
            "Failed refresh cannot use beta.6 brand offsets"
        );
        status = 200;
        await page.evaluate(() => {
            makeWorker();
            worker.postMessage(brandInput);
        });
        const correctedBrandReady = await page.evaluate(() =>
            waitMessage("ready")
        );
        assert.notEqual(correctedBrandReady.cacheName, legacyBrandCache);
        assert.equal(correctedBrandReady.mappings.brand.shift, 0);
        const correctedBrandRows = await page.evaluate(() => getGuide("brand"));
        assert.equal(correctedBrandRows[0].name, "Now & next");
        assert.equal(correctedBrandRows[0].time, now - 3600);
        const afterBrandMigration = calls;
        await page.evaluate(() => {
            makeWorker();
            worker.postMessage(brandInput);
        });
        await page.evaluate(() => waitMessage("ready"));
        assert.deepEqual(
            await page.evaluate(() => getGuide("brand")),
            correctedBrandRows
        );
        assert.equal(
            calls,
            afterBrandMigration,
            "Corrected cache avoids another full download"
        );
        await page.evaluate(() => {
            makeWorker();
            configure();
        });
        await page.evaluate(() => waitMessage("ready"));

        for (const failure of [
            "truncated-gzip",
            "invalid-xml",
            "entities",
            "network",
        ]) {
            await page.evaluate(() => expire());
            status = failure === "network" ? 503 : 200;
            body =
                failure === "truncated-gzip"
                    ? zlib.gzipSync(base).subarray(0, -8)
                    : failure === "invalid-xml"
                      ? zlib.gzipSync(base.slice(0, -5))
                      : failure === "entities"
                        ? zlib.gzipSync(
                              '<!DOCTYPE tv [<!ENTITY secret "external">]><tv/>'
                          )
                        : body;
            await page.evaluate(() => {
                makeWorker();
                configure();
            });
            assert.equal(
                (await page.evaluate(() => waitMessage("ready"))).stale,
                true
            );
            const error = await page.evaluate(() => waitMessage("error"));
            assert.equal(error.cached, true, failure);
            if (failure === "network") {
                assert.equal(error.code, "EPG_HTTP");
                assert.equal(error.httpStatus, 503);
                assert.equal(error.phase, "download");
                assert.equal(error.source, 0);
            }
            long = await page.evaluate(() => getGuide("long"));
            assert.equal(
                long.length,
                3,
                failure + " must preserve good snapshot"
            );
        }

        // Two same-origin workers are independent tabs. Only one owns a refresh;
        // both read the newly committed pointer even when their in-memory state is old.
        status = 200;
        body = zlib.gzipSync(base);
        const beforeConcurrent = calls;
        await page.evaluate(() => {
            const source = location.origin + "/feed.gz";
            window.pairInput = {
                channels: [
                    {
                        archiveHours: 168,
                        id: "concurrent",
                        name: "РЕН ТВ HD",
                        sources: [source],
                        tvgId: "18",
                        tvgName: "",
                    },
                ],
                refreshMs: 7200000,
                sources: [source],
                type: "load",
            };
            window.pair = [0, 1].map(() => {
                const value = {
                    messages: [],
                    worker: new Worker("/hosted/epg-worker.js"),
                };
                value.worker.onmessage = (event) =>
                    value.messages.push(event.data);
                value.worker.postMessage(window.pairInput);
                return value;
            });
            window.pairWait = (index, type) =>
                new Promise((resolve, reject) => {
                    const started = Date.now(),
                        interval = setInterval(() => {
                            const messages = window.pair[index].messages,
                                at = messages.findIndex((m) => m.type === type);
                            if (at >= 0) {
                                clearInterval(interval);
                                resolve(messages.splice(at, 1)[0]);
                            } else if (Date.now() - started > 30000) {
                                clearInterval(interval);
                                reject(new Error("pair timeout"));
                            }
                        }, 10);
                });
        });
        const pairReady = await page.evaluate(() =>
            Promise.all([pairWait(0, "ready"), pairWait(1, "ready")])
        );
        assert.equal(
            calls,
            beforeConcurrent + 1,
            "concurrent tabs coalesce source downloads"
        );
        await page.evaluate((name) => expire(name), pairReady[0].cacheName);
        body = zlib.gzipSync(base.replace("Now &amp; next", "Refreshed"));
        await page.evaluate(() => pair[1].worker.postMessage(pairInput));
        await page.evaluate(() => pairWait(1, "ready")); // stale pointer
        await page.evaluate(() => pairWait(1, "ready")); // replacement
        const refreshed = await page.evaluate(async () => {
            pair[0].worker.postMessage({
                id: "concurrent",
                query: 1,
                type: "guide",
            });
            const value = await pairWait(0, "guide");
            pair.forEach((item) => item.worker.terminate());
            return value.rows;
        });
        assert.equal(
            refreshed[1].name,
            "Refreshed",
            "old tab follows new atomic pointer after cleanup"
        );
        assert.equal(
            (await page.evaluate(() => getGuide("long"))).length,
            3,
            "different playlist cache is isolated"
        );

        // A close acknowledgement means the lease transaction has committed.
        // Version changes during both download and parsing stop all continuations.
        holdFeed = true;
        await page.evaluate(() => {
            makeWorker();
            worker.postMessage({ ...pairInput, force: true });
        });
        await page.waitForFunction(() =>
            messages.some((m) => m.phase === "download")
        );
        await page.evaluate(() => worker.postMessage({ type: "close" }));
        assert.equal(
            (await page.evaluate(() => waitMessage("closed"))).type,
            "closed"
        );
        const leaseAfterClose = await page.evaluate(
            (name) =>
                new Promise((resolve, reject) => {
                    const request = indexedDB.open(name, 1);
                    request.onerror = () => reject(request.error);
                    request.onsuccess = () => {
                        const db = request.result,
                            tx = db.transaction("meta"),
                            read = tx.objectStore("meta").get("lease");
                        tx.oncomplete = () => {
                            db.close();
                            resolve(read.result || null);
                        };
                    };
                }),
            pairReady[0].cacheName
        );
        assert.equal(
            leaseAfterClose,
            null,
            "close releases rather than waiting 30 seconds for expiry"
        );
        for (const phase of ["download", "parse"]) {
            holdFeed = phase === "download";
            if (!holdFeed)
                body = zlib.gzipSync(
                    header +
                        Array.from({ length: 10000 }, (_, i) =>
                            programme(
                                -1800,
                                1800,
                                "Version change " + i,
                                "description ".repeat(50)
                            )
                        ).join("") +
                        "</tv>"
                );
            await page.evaluate(() => {
                makeWorker();
                worker.postMessage({ ...pairInput, force: true });
            });
            await page.waitForFunction(
                (value) => messages.some((m) => m.phase === value),
                phase
            );
            await page.evaluate((name) => {
                window.storageDeleted = new Promise((resolve, reject) => {
                    const request = indexedDB.deleteDatabase(name);
                    request.onsuccess = () => resolve(true);
                    request.onerror = () => reject(request.error);
                });
            }, pairReady[0].cacheName);
            const changed = await page.evaluate(() => waitMessage("error"));
            assert.equal(changed.code, "EPG_STORAGE_CHANGED", phase);
            assert.equal(changed.phase, phase);
            assert.equal(
                (await page.evaluate(() => waitMessage("closed"))).type,
                "closed"
            );
            assert.equal(await page.evaluate(() => storageDeleted), true);
            await page.waitForTimeout(100); // queued parser/transaction continuations must remain inert
            assert.equal(
                await page.evaluate(
                    () =>
                        messages.filter(
                            (m) =>
                                m.type === "fatal" ||
                                m.type === "error" ||
                                (m.type === "ready" && !m.stale)
                        ).length
                ),
                0
            );
        }
        holdFeed = false;

        // Equal-time records must retain XML order across double-digit block
        // numbers. Plain XML and ~32 KiB retained rows force distinct batches;
        // each description stays below the shared 16384-character field limit.
        const tiedTitles = Array.from({ length: 117 }, (_, i) => "Tied " + i);
        tiedTitles.push(tiedTitles[3]); // Identical programmes are not deduplicated.
        const tiedDescription = "x".repeat(16000);
        const tiedXml = "<![CDATA[" + tiedDescription + "]]>";
        body = Buffer.from(
            header +
                tiedTitles
                    .map((title) => programme(-1800, 1800, title, tiedXml))
                    .join("") +
                "</tv>"
        );
        await page.evaluate(() => {
            makeWorker();
            const source = location.origin + "/feed.gz";
            worker.postMessage({
                channels: [
                    {
                        archiveHours: 48,
                        id: "tied",
                        name: "РЕН ТВ HD",
                        sources: [source],
                        tvgId: "18",
                        tvgName: "",
                    },
                ],
                refreshMs: 7200000,
                sources: [source],
                type: "load",
            });
        });
        const tiedReady = await page.evaluate(() => waitMessage("ready"));
        const tiedBlocks = await page.evaluate(
            (name) =>
                new Promise((resolve, reject) => {
                    const opening = indexedDB.open(name, 1);
                    opening.onerror = () => reject(opening.error);
                    opening.onsuccess = () => {
                        const db = opening.result,
                            tx = db.transaction(["meta", "rows"]);
                        const read = tx.objectStore("meta").get("active");
                        let count;
                        read.onsuccess = () => {
                            count = tx
                                .objectStore("rows")
                                .index("channel")
                                .count(
                                    IDBKeyRange.only(
                                        read.result.mappings.tied.channel
                                    )
                                );
                        };
                        tx.oncomplete = () => {
                            db.close();
                            resolve(count.result);
                        };
                        tx.onabort = () => {
                            db.close();
                            reject(tx.error);
                        };
                    };
                }),
            tiedReady.cacheName
        );
        assert(
            tiedBlocks >= 12,
            "ordering regression spans at least twelve persisted blocks"
        );
        const tiedRows = await page.evaluate(() => getGuide("tied"));
        assert.deepEqual(
            tiedRows.map((row) => row.name),
            tiedTitles
        );
        assert(
            tiedRows.every(
                (row) =>
                    row.descr === tiedDescription &&
                    row.icon === "" &&
                    row.time === now - 1800 &&
                    row.time_to === now + 1800
            )
        );

        // More than the former 50,000-programme policy. Every admitted record survives.
        status = 200;
        let large = header;
        for (let i = 1; i <= 20; i++)
            large += `<channel id="extra${i}"><display-name>Extra ${i}</display-name></channel>`;
        large +=
            Array.from({ length: 50001 }, (_, i) =>
                programme(
                    -1800,
                    1800,
                    "Entry " + i,
                    "",
                    i % 21 ? "extra" + (i % 21) : "18"
                )
            ).join("") + "</tv>";
        body = zlib.gzipSync(large);
        await page.evaluate(() => {
            window.extraChannels = Array.from({ length: 20 }, (_, i) => ({
                archiveHours: 168,
                id: "extra" + (i + 1),
                name: "Extra " + (i + 1),
                sources: [location.origin + "/feed.gz"],
                tvgId: "extra" + (i + 1),
                tvgName: "",
            }));
        });
        await page.evaluate(() => {
            makeWorker();
            configure();
        });
        await page.evaluate(() => waitMessage("ready")); // replacement committed
        const size = await page.evaluate(async () => {
            let total = (await getGuide("long")).length;
            for (let i = 1; i <= 20; i++)
                total += (await getGuide("extra" + i)).length;
            return total;
        });
        assert.equal(size, 50001, "no silent programme cap");
        await page.evaluate(() => expire());
        body = zlib.gzipSync(
            header +
                Array.from({ length: 20001 }, (_, i) =>
                    programme(-1800, 1800, "Overload " + i)
                ).join("") +
                "</tv>"
        );
        await page.evaluate(() => {
            makeWorker();
            configure();
        });
        await page.evaluate(() => waitMessage("ready"));
        assert.equal(
            (await page.evaluate(() => waitMessage("error"))).code,
            "EPG_CHANNEL_LIMIT"
        );
        assert.equal(
            (await page.evaluate(() => getGuide("long"))).length,
            Math.ceil(50001 / 21),
            "explicit size failure preserves good snapshot"
        );
        // Oversized records from an older/corrupt cache fail the read without
        // continuing an already-aborted cursor or throwing a Worker error.
        await page.evaluate(
            () =>
                new Promise((resolve, reject) => {
                    const opening = indexedDB.open(window.cacheName, 1);
                    opening.onsuccess = () => {
                        const db = opening.result;
                        const tx = db.transaction(
                            ["meta", "rows"],
                            "readwrite"
                        );
                        const read = tx.objectStore("meta").get("active");
                        read.onsuccess = () => {
                            const cursor = tx
                                .objectStore("rows")
                                .index("channel")
                                .openCursor(
                                    IDBKeyRange.only(
                                        read.result.mappings.long.channel
                                    )
                                );
                            cursor.onsuccess = () => {
                                const item = cursor.result;
                                const value = item.value;
                                value.rows = Array(20001).fill(value.rows[0]);
                                item.update(value);
                            };
                        };
                        tx.oncomplete = () => {
                            db.close();
                            resolve();
                        };
                        tx.onabort = () => reject(tx.error);
                    };
                    opening.onerror = () => reject(opening.error);
                })
        );
        assert.equal(await page.evaluate(() => getGuide("long")), null);
        assert.ok(
            (await page.evaluate(() => getGuide("extra1"))).length > 0,
            "oversized cache read must leave the Worker responsive without errors"
        );
        // The actual bridge/UI must retain an actionable error after the boot
        // screen is hidden, without displaying credentials in source URLs.
        await page.goto("http://127.0.0.1:" + server.address().port);
        await page.addScriptTag({
            path: path.join(root, "js/jquery-1.11.1.min.js"),
        });
        await page.evaluate(() => {
            document.body.innerHTML =
                '<div id="launch" style="display:none"></div><div id="listCaption"></div><div id="listAbout"></div><div id="footer"></div>';
            window._ = (value, arg) => value.replace("%1", String(arg));
            window.keys = { DOWN: 40, ENTER: 13, EXIT: 27, RETURN: 8, UP: 38 };
            window.listFooter = document.getElementById("footer");
            window.saveListPanelState = () => {};
            window.restoreListPanelState = () => {};
            window.renderButtonHint = (_key, _label, title) => title;
            window.showShift = (value) => {
                window.lastNotice = value;
            };
            window.__OTTPLAY_HOSTED__ = {
                epg: {
                    source:
                        location.origin + "/feed.gz?token=private-source-test",
                    workerUrl: "/hosted/epg-worker.js",
                },
                version: 1,
            };
        });
        await page.addScriptTag({
            content: ts.transpileModule(
                fs.readFileSync(path.join(root, "src/hosted/epg.ts"), "utf8"),
                { compilerOptions: { target: ts.ScriptTarget.ES5 } }
            ).outputText,
        });
        status = 503;
        await page.evaluate(() => {
            window.epgSession = __ottHostedEpg.open(
                [{ channel_name: "РЕН ТВ HD", id: "diagnostics", rec: 168 }],
                () => {},
                (value) => $("#launch").append(value)
            );
        });
        await page.waitForFunction(
            () => __ottHostedEpg.diagnostics().phase === "error"
        );
        // The optional panel never steals a later screen or survives a cancelled request.
        const noLatePanel = async () => {
            releaseDiagnostics();
            await new Promise((resolve) => setTimeout(resolve, 100));
            assert.equal(await page.locator("#listAbout pre").count(), 0);
            assert.equal(
                await page.locator('script[src*="epg-diagnostics.js"]').count(),
                0
            );
        };
        const beginDiagnostics = async () => {
            await page.evaluate(() => {
                delete window.__ottHostedEpgDiagnostics;
                __ottHostedEpg.showDiagnostics();
            });
        };
        holdDiagnostics = true;
        let expectedDiagnostics = diagnosticsCalls + 1;
        await beginDiagnostics();
        await page.evaluate(() => __ottHostedEpg.showDiagnostics());
        await waitDiagnostics(expectedDiagnostics);
        await page.keyboard.press("Escape");
        await noLatePanel();
        assert.equal(
            diagnosticsCalls,
            expectedDiagnostics,
            "concurrent opens share one asset request"
        );

        expectedDiagnostics++;
        await beginDiagnostics();
        await waitDiagnostics(expectedDiagnostics);
        await page.evaluate(() => {
            window.aboutKeyHandler = () => true;
            document.getElementById("listAbout").textContent = "Another screen";
        });
        await noLatePanel();
        assert.equal(
            await page.locator("#listAbout").innerText(),
            "Another screen"
        );
        await page.evaluate(() => {
            window.aboutKeyHandler = null;
            $("#listAbout").hide().empty();
        });

        for (const action of ["retry", "close"]) {
            expectedDiagnostics++;
            await beginDiagnostics();
            await waitDiagnostics(expectedDiagnostics);
            await page.evaluate((action) => epgSession[action](), action);
            await noLatePanel();
            if (action === "close")
                await page.evaluate(() => {
                    window.epgSession = __ottHostedEpg.open(
                        [
                            {
                                channel_name: "РЕН ТВ HD",
                                id: "diagnostics",
                                rec: 168,
                            },
                        ],
                        () => {}
                    );
                });
            await page.waitForFunction(
                () => __ottHostedEpg.diagnostics().phase === "error"
            );
        }

        // A stalled asset request is bounded even though no Worker timeout is involved.
        expectedDiagnostics++;
        await beginDiagnostics();
        await waitDiagnostics(expectedDiagnostics);
        await page.waitForFunction(
            () => lastNotice.includes("could not load"),
            null,
            { timeout: 15000 }
        );
        await noLatePanel();
        holdDiagnostics = false;
        diagnosticsStatus = 503;
        expectedDiagnostics++;
        await beginDiagnostics();
        await waitDiagnostics(expectedDiagnostics);
        await page.waitForFunction(() => lastNotice.includes("could not load"));
        await noLatePanel();

        diagnosticsStatus = 200;
        diagnosticsBody = "window.__ottHostedEpgDiagnostics={version:0};";
        expectedDiagnostics++;
        await beginDiagnostics();
        await waitDiagnostics(expectedDiagnostics);
        await page.waitForFunction(() => lastNotice.includes("could not load"));
        await noLatePanel();
        diagnosticsBody = generated["epg-diagnostics.js"];

        for (const url of [
            "https://private.invalid/ui.js",
            "//private.invalid/ui.js",
            "/\\private.invalid/ui.js",
        ]) {
            await page.evaluate((url) => {
                delete window.__ottHostedEpgDiagnostics;
                __OTTPLAY_HOSTED__.epg.diagnosticsUrl = url;
                __ottHostedEpg.showDiagnostics();
            }, url);
            assert.equal(
                diagnosticsCalls,
                expectedDiagnostics,
                "diagnostics URLs cannot escape the publisher origin"
            );
            assert.match(
                await page.evaluate(() => lastNotice),
                /could not load/
            );
        }
        await page.evaluate(() => {
            delete __OTTPLAY_HOSTED__.epg.diagnosticsUrl;
        });

        const diagnosticsStyle = fs
            .readFileSync(path.join(root, "styles/player.css"), "utf8")
            .match(/\.hosted-epg-diagnostics\s*\{[^}]+\}/)[0];
        await page.addStyleTag({ content: diagnosticsStyle });
        await page.evaluate(() => {
            document.getElementById("listAbout").style.cssText =
                "height:500px;font-size:20px;font-family:Arial";
            __ottHostedEpg.showDiagnostics();
        });
        await page.waitForSelector("#listAbout pre");
        assert.deepEqual(
            await page.locator("#listAbout pre").evaluate((element) => {
                const style = getComputedStyle(element);
                return [
                    style.fontFamily,
                    style.fontSize,
                    style.height,
                    style.overflow,
                    style.touchAction,
                    style.whiteSpace,
                ];
            }),
            ["Arial", "16px", "400px", "auto", "pan-y", "pre-wrap"],
            "the shared stylesheet preserves the diagnostics panel layout"
        );
        await page.evaluate(() => {
            window.originalDiagnosticsModule = __ottHostedEpgDiagnostics;
            window.originalDiagnosticsHandler = aboutKeyHandler;
        });
        await page.addScriptTag({
            content: generated["epg-diagnostics.js"].toString(),
        });
        assert.equal(
            await page.evaluate(
                () => __ottHostedEpgDiagnostics === originalDiagnosticsModule
            ),
            true,
            "late duplicate script execution preserves the active module"
        );
        const loadedDiagnosticsCalls = diagnosticsCalls;
        await page.evaluate(() => __ottHostedEpg.showDiagnostics());
        assert.equal(await page.locator("#listAbout pre").count(), 1);
        assert.equal(
            await page.evaluate(
                () => aboutKeyHandler === originalDiagnosticsHandler
            ),
            true,
            "reopening after duplicate registration does not nest another panel"
        );
        assert.equal(
            diagnosticsCalls,
            loadedDiagnosticsCalls,
            "registered diagnostics module is reused"
        );
        let details = await page.locator("#listAbout").innerText();
        assert.match(details, /HTTP 503/);
        assert.match(details, /EPG_HTTP/);
        assert(!details.includes("private-source-test"));
        assert.match(await page.evaluate(() => lastNotice), /EPG diagnostics/);
        status = 200;
        body = zlib.gzipSync(base);
        await page.getByRole("button", { name: "Retry EPG download" }).click();
        await page.waitForFunction(
            () => __ottHostedEpg.diagnostics().phase === "ready",
            null,
            { timeout: 45000 }
        );
        await page.waitForFunction(() =>
            document
                .getElementById("listAbout")
                .textContent.includes("EPG channels: 1/1")
        );
        details = await page.locator("#listAbout").innerText();
        assert.match(details, /EPG programmes: 3/);
        assert.match(details, /EPG cache and wait time: [\d.]+ s/);
        assert.match(details, /EPG download time: [\d.]+ s/);
        assert.match(details, /EPG processing and storage time: [\d.]+ s/);
        assert(!details.includes("EPG_HTTP"));
        const beforeRetry = calls;
        await page.evaluate(() => aboutKeyHandler(keys.ENTER));
        // The previous cache can remain ready until the worker receives retry.
        // Observe the new download before accepting its final ready state.
        const retryDeadline = Date.now() + 45000;
        while (calls === beforeRetry && Date.now() < retryDeadline)
            await new Promise((resolve) => setTimeout(resolve, 10));
        await page.waitForFunction(
            () => __ottHostedEpg.diagnostics().phase === "ready",
            null,
            { timeout: 45000 }
        );
        assert.equal(
            calls,
            beforeRetry + 1,
            "remote retry refreshes even a fresh cache"
        );
        await page.evaluate(() => aboutKeyHandler(keys.RETURN));
        assert.equal(await page.locator("#listAbout").isVisible(), false);
        await page.evaluate(() => {
            epgSession.close();
            window.Worker = undefined;
            epgSession = __ottHostedEpg.open(
                [{ id: "unsupported", name: "РЕН ТВ HD" }],
                () => {}
            );
            __ottHostedEpg.showDiagnostics();
        });
        assert.match(
            await page.locator("#listAbout").innerText(),
            /EPG_WORKER/
        );
        assert.match(
            await page.locator("#listAbout").innerText(),
            /Playback will stop/
        );
        await page.evaluate(() => {
            window.restarts = 0;
            window.restart = () => {
                restarts++;
            };
        });
        await page
            .getByRole("button", { exact: true, name: "Restart player" })
            .click();
        assert.equal(
            await page.evaluate(() => restarts),
            1,
            "restart requires an explicit action"
        );
        await page.evaluate(() => aboutKeyHandler(keys.RETURN));
        assert.equal(
            await page.evaluate(() => restarts),
            1,
            "Back only closes diagnostics"
        );
        await page.evaluate(() => {
            epgSession.close();
            window.fakeWorkers = [];
            window.Worker = function () {
                fakeWorkers.push(this);
                this.postMessage = (value) => {
                    if (value.type === "close")
                        this.onmessage({ data: { type: "closed" } });
                };
                this.terminate = () => {};
            };
            epgSession = __ottHostedEpg.open(
                [{ id: "race", name: "Fixture" }],
                () => {}
            );
            __ottHostedEpg.showDiagnostics();
            // The visible Retry label must not silently become destructive.
            fakeWorkers[0].onerror();
            document.querySelector("#listAbout button").click();
        });
        assert.equal(
            await page.evaluate(() => restarts),
            1,
            "stale Retry activation only updates its label"
        );
        assert.equal(
            await page
                .getByRole("button", { exact: true, name: "Restart player" })
                .count(),
            1
        );
        assert.match(
            await page.locator("#footer").innerText(),
            /Restart player/
        );
        await page.evaluate(() => aboutKeyHandler(keys.ENTER));
        assert.equal(
            await page.evaluate(() => restarts),
            2,
            "remote OK invokes the advertised restart"
        );
        await page.evaluate(() => {
            fakeWorkers[0].onmessage({
                data: { fetched: 1, mappings: {}, type: "ready" },
            });
            aboutKeyHandler(keys.ENTER);
        });
        assert.equal(
            await page.evaluate(() => restarts),
            2,
            "stale Restart activation cannot restart a recovered player"
        );
        assert.equal(
            await page.evaluate(() => fakeWorkers.length),
            1,
            "mode change only renders the new action"
        );
        await page.evaluate(() => aboutKeyHandler(keys.ENTER));
        assert.equal(
            await page.evaluate(() => fakeWorkers.length),
            2,
            "recovered mode retains normal retry"
        );
        await page.evaluate(() => {
            aboutKeyHandler(keys.RETURN);
            epgSession.close();
        });
        await page.evaluate(() => {
            window.Worker = function () {
                this.postMessage = () => {};
                this.terminate = () => {
                    window.stalledTerminated = true;
                };
            };
            epgSession = __ottHostedEpg.open(
                [{ id: "stalled", name: "РЕН ТВ HD" }],
                () => {}
            );
            const clock = Date.now;
            window.restoreClock = () => {
                Date.now = clock;
            };
            Date.now = () => clock() + 61000;
        });
        await page.waitForFunction(
            () => __ottHostedEpg.diagnostics().code === "EPG_STALLED"
        );
        await page.waitForFunction(() => window.stalledTerminated === true);
        await page.evaluate(() => {
            restoreClock();
            epgSession.close();
        });
        console.log(
            "PASS hosted EPG: actual ES5 worker/IndexedDB, cache refresh, gzip/XML corruption, archive windows, 50k+ records, visible diagnostics and remote retry"
        );
    } finally {
        await browser.close();
        for (const response of heldResponses) response.destroy();
        await new Promise((resolve) => server.close(resolve));
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
