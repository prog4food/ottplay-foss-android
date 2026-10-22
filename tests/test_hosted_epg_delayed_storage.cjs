"use strict";

// Delayed IndexedDB lifetime for the hosted EPG server. No browser, HTTP server,
// player, or outbound network. Synthetic catalogues only.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const serverSource =
    ts.transpileModule(
        fs.readFileSync(path.join(root, "src/hosted/epg-server.ts"), "utf8"),
        { compilerOptions: { target: ts.ScriptTarget.ES5 } }
    ).outputText + "\ncreateHostedEpgServer(self);\n";
const clientSource = ts.transpileModule(
    fs.readFileSync(path.join(root, "src/hosted/epg.ts"), "utf8"),
    { compilerOptions: { target: ts.ScriptTarget.ES5 } }
).outputText;

function createDatabase() {
    const data = { cache: new Map(), usage: new Map() };
    const transactions = [];
    const db = {
        close() {
            this.closed = true;
        },
        closed: false,
        createObjectStore(name) {
            if (!data[name]) data[name] = new Map();
        },
        transaction() {
            const operations = [];
            const tx = {
                objectStore(name) {
                    const bucket = data[name];
                    return {
                        delete(key) {
                            operations.push(() => bucket.delete(key));
                        },
                        get(key) {
                            const request = {
                                onsuccess: null,
                                result: undefined,
                            };
                            operations.push(() => {
                                request.result = bucket.has(key)
                                    ? bucket.get(key)
                                    : undefined;
                                if (request.onsuccess) request.onsuccess();
                            });
                            return request;
                        },
                        openCursor() {
                            const request = { onsuccess: null, result: null };
                            operations.push(() => {
                                if (request.onsuccess) request.onsuccess();
                            });
                            return request;
                        },
                        put(value, key) {
                            const request = { onsuccess: null, result: key };
                            operations.push(() => {
                                bucket.set(key, value);
                                if (request.onsuccess) request.onsuccess();
                            });
                            return request;
                        },
                    };
                },
                onabort: null,
                oncomplete: null,
                onerror: null,
            };
            tx.deliver = (kind) => {
                if (kind === "success") {
                    operations.splice(0).forEach((operation) => operation());
                    if (tx.oncomplete) tx.oncomplete();
                } else if (kind === "abort") {
                    if (tx.onabort) tx.onabort();
                } else if (tx.onerror) tx.onerror();
            };
            transactions.push(tx);
            return tx;
        },
    };
    return { data, db, transactions };
}

function createEnv() {
    const messages = [];
    const requests = [];
    const timers = [];
    const openings = [];
    const env = {
        clearTimeout(timer) {
            if (timer) timer.cleared = true;
        },
        indexedDB: {
            open() {
                const created = createDatabase();
                const request = {
                    onblocked: null,
                    onerror: null,
                    onsuccess: null,
                    onupgradeneeded: null,
                    result: created.db,
                };
                const opening = { created, request };
                openings.push(opening);
                return request;
            },
        },
        postMessage(value) {
            messages.push(value);
        },
        setTimeout(callback, delay) {
            const timer = { callback, cleared: false, delay };
            timers.push(timer);
            return timer;
        },
        XMLHttpRequest: function XMLHttpRequest() {
            this.abort = () => {
                this.aborted = true;
                if (this.onabort) this.onabort();
            };
            this.open = (method, url) => {
                this.method = method;
                this.url = url;
            };
            this.send = (body) => {
                this.body = body && JSON.parse(body);
                requests.push(this);
            };
            this.setRequestHeader = () => {};
        },
    };
    vm.runInNewContext(serverSource, { self: env });
    return { env, messages, openings, requests, timers };
}

function load(env, id) {
    env.onmessage({
        data: {
            apiBase: "/epg/v1",
            channels: [
                {
                    archiveHours: 48,
                    id,
                    name: "Synthetic " + id,
                    tvgId: id,
                    tvgName: "",
                },
            ],
            sourceId: "epg-one",
            type: "load",
        },
    });
}

function succeedOpen(opening) {
    if (opening.request.onupgradeneeded) opening.request.onupgradeneeded();
    if (opening.request.onsuccess) opening.request.onsuccess();
}

function matchEnvelope(xhr, generation) {
    const channels = (xhr.body && xhr.body.channels) || [];
    return {
        fetchedAt: 1_700_000_000_000,
        generation,
        mappings: Object.fromEntries(
            channels.map((row) => [
                row.id,
                { channelId: row.id + "-remote", logo: "", shift: 0 },
            ])
        ),
        refreshMs: 7200000,
        source: "epg-one",
        stale: false,
        version: 1,
    };
}

function respond(xhr, status, generation) {
    xhr.status = status;
    xhr.responseText = JSON.stringify(
        status === 200 ? matchEnvelope(xhr, generation) : { error: true }
    );
    if (xhr.onload) xhr.onload();
}

function types(messages, type) {
    return messages.filter((row) => row.type === type);
}

function liveTimers(timers) {
    return timers.filter((timer) => !timer.cleared);
}

const closedDuringRead = createEnv();
load(closedDuringRead.env, "delay-read");
assert.equal(closedDuringRead.openings.length, 1);
succeedOpen(closedDuringRead.openings[0]);
assert.equal(closedDuringRead.openings[0].created.transactions.length, 1);
const readTransaction = closedDuringRead.openings[0].created.transactions[0];
closedDuringRead.env.onmessage({ data: { type: "close" } });
readTransaction.deliver("success");
assert.deepEqual(
    closedDuringRead.messages.map((row) => row.type),
    ["progress", "closed"]
);
assert.equal(closedDuringRead.requests.length, 0);
assert.equal(liveTimers(closedDuringRead.timers).length, 0);
liveTimers(closedDuringRead.timers).forEach((timer) => timer.callback());
assert.equal(closedDuringRead.requests.length, 0);

const openControl = createEnv();
load(openControl.env, "open-control");
succeedOpen(openControl.openings[0]);
openControl.openings[0].created.transactions[0].deliver("success");
assert.equal(openControl.requests.length, 1);
respond(openControl.requests[0], 200, "open-generation");
const writeTransaction = openControl.openings[0].created.transactions[1];
assert.equal(types(openControl.messages, "ready").length, 0);
writeTransaction.deliver("success");
assert.equal(types(openControl.messages, "ready").length, 1);
assert.equal(types(openControl.messages, "error").length, 0);
assert.equal(
    types(openControl.messages, "ready")[0].mappings["open-control"].channel,
    "open-control-remote"
);

for (const terminal of ["success", "abort", "error"]) {
    const pendingWrite = createEnv();
    load(pendingWrite.env, "final-write-" + terminal);
    succeedOpen(pendingWrite.openings[0]);
    pendingWrite.openings[0].created.transactions[0].deliver("success");
    respond(pendingWrite.requests[0], 200, "pending-" + terminal);
    assert.equal(
        pendingWrite.openings[0].created.transactions.length,
        2,
        terminal + " must reach a pending final cache write"
    );
    const pending = pendingWrite.openings[0].created.transactions[1];
    assert.equal(types(pendingWrite.messages, "ready").length, 0);
    pendingWrite.env.onmessage({ data: { type: "close" } });
    const messagesBefore = pendingWrite.messages.length;
    const requestsBefore = pendingWrite.requests.length;
    assert.equal(liveTimers(pendingWrite.timers).length, 0);
    pending.deliver(terminal);
    assert.equal(
        pendingWrite.messages.length,
        messagesBefore,
        terminal + " must not publish after close"
    );
    assert.equal(
        pendingWrite.requests.length,
        requestsBefore,
        terminal + " must not create a request"
    );
    assert.equal(
        liveTimers(pendingWrite.timers).length,
        0,
        terminal + " must not resurrect refresh timer"
    );
}

const blocked = createEnv();
load(blocked.env, "blocked");
blocked.openings[0].request.onblocked();
assert.equal(blocked.requests.length, 1, "blocked open starts one match");
succeedOpen(blocked.openings[0]);
assert.equal(
    blocked.requests.length,
    1,
    "late open success does not replay match"
);
assert.equal(blocked.openings[0].created.db.closed, false);
assert.equal(
    blocked.openings[0].created.transactions.length,
    0,
    "late open must not replay the initial cache read"
);
respond(blocked.requests[0], 200, "blocked-generation");
assert.equal(
    blocked.openings[0].created.transactions.length,
    1,
    "late open must only host the final active write"
);
blocked.openings[0].created.transactions[0].deliver("success");
assert.equal(types(blocked.messages, "ready").length, 1);

const closedBeforeOpen = createEnv();
load(closedBeforeOpen.env, "before-open");
closedBeforeOpen.env.onmessage({ data: { type: "close" } });
succeedOpen(closedBeforeOpen.openings[0]);
assert.equal(closedBeforeOpen.openings[0].created.db.closed, true);
assert.equal(closedBeforeOpen.requests.length, 0);
assert.deepEqual(
    closedBeforeOpen.messages.map((row) => row.type),
    ["progress", "closed"]
);
closedBeforeOpen.openings[0].request.onblocked();
closedBeforeOpen.openings[0].request.onerror();
assert.equal(closedBeforeOpen.requests.length, 0);

const lastGood = createEnv();
load(lastGood.env, "last-good");
succeedOpen(lastGood.openings[0]);
lastGood.openings[0].created.transactions[0].deliver("success");
respond(lastGood.requests[0], 200, "kept-generation");
lastGood.openings[0].created.transactions[1].deliver("success");
const readyBefore = types(lastGood.messages, "ready").at(-1);
const refresh = liveTimers(lastGood.timers).at(-1);
assert(refresh);
refresh.callback();
assert.equal(lastGood.requests.length, 2);
respond(lastGood.requests[1], 500, "failed-generation");
assert.equal(types(lastGood.messages, "error").length, 1);
assert.deepEqual(types(lastGood.messages, "ready").at(-1), readyBefore);
lastGood.env.onmessage({
    data: { id: "last-good", query: "guide-1", type: "guide" },
});
assert.equal(types(lastGood.messages, "guide").length, 0);
const guideRead = lastGood.openings[0].created.transactions.at(-1);
guideRead.deliver("success");
assert.equal(lastGood.requests.length, 3);
assert.match(lastGood.requests[2].url, /channelId=last-good-remote/);
assert.match(lastGood.requests[2].url, /generation=kept-generation/);

const notifications = [];
const workers = [];
const intervals = [];
const host = {
    _: (value) => value,
    __OTTPLAY_HOSTED__: {
        epg: {
            apiBase: "/epg/v1",
            mode: "server",
            serverWorkerUrl: "/epg-server.js",
            source: "https://cdn.epg.one/epg2.xml.gz",
            sourceId: "epg-one",
            workerUrl: "/epg-worker.js",
        },
        version: 1,
    },
    clearInterval() {},
    clearTimeout(timer) {
        if (timer) timer.cleared = true;
    },
    setInterval(callback, delay) {
        const timer = { callback, delay };
        intervals.push(timer);
        return timer;
    },
    setTimeout(callback, delay) {
        return { callback, cleared: false, delay };
    },
    Worker: function Worker(url) {
        const runtime = createEnv();
        const posted = [];
        runtime.env.postMessage = (value) => {
            posted.push(value);
            if (this.onmessage) this.onmessage({ data: value });
        };
        this.posted = posted;
        this.runtime = runtime;
        this.url = url;
        this.postMessage = (value) => runtime.env.onmessage({ data: value });
        this.terminate = () => {
            this.terminated = true;
            this.onmessage = null;
        };
        workers.push(this);
    },
};
vm.runInNewContext(clientSource, { window: host });
const firstNotifications = [];
const first = host.__ottHostedEpg.open(
    [
        {
            id: "old",
            name: "Old",
            xmltv_urls: ["https://cdn.epg.one/epg2.xml.gz"],
        },
    ],
    (mappings) => firstNotifications.push(mappings)
);
assert.equal(workers.length, 1);
succeedOpen(workers[0].runtime.openings[0]);
workers[0].runtime.openings[0].created.transactions[0].deliver("success");
assert.equal(workers[0].runtime.requests.length, 1);
respond(workers[0].runtime.requests[0], 200, "old-pending");
const oldTransactions = workers[0].runtime.openings[0].created.transactions;
assert.equal(
    oldTransactions.length,
    2,
    "replacement must observe a pending cache write"
);
assert.equal(workers[0].posted.filter((row) => row.type === "ready").length, 0);
const secondNotifications = [];
const second = host.__ottHostedEpg.open(
    [
        {
            id: "new",
            name: "New",
            xmltv_urls: ["https://cdn.epg.one/epg2.xml.gz"],
        },
    ],
    (mappings) => secondNotifications.push(mappings)
);
assert.equal(workers[0].terminated, true);
assert.equal(oldTransactions.length, 2);
const postedBefore = workers[0].posted.length;
const requestsBefore = workers[0].runtime.requests.length;
oldTransactions[1].deliver("success");
assert.equal(
    workers[0].posted.length,
    postedBefore,
    "pending replacement write must not publish"
);
assert.equal(
    workers[0].runtime.requests.length,
    requestsBefore,
    "pending replacement write must not create a request"
);
assert.equal(
    liveTimers(workers[0].runtime.timers).length,
    0,
    "pending replacement write must not resurrect refresh timer"
);
assert.deepEqual(firstNotifications, []);
assert.equal(
    workers[0].posted.filter(
        (row) =>
            row.type === "ready" || row.type === "error" || row.type === "guide"
    ).length,
    0
);
succeedOpen(workers[1].runtime.openings[0]);
workers[1].runtime.openings[0].created.transactions[0].deliver("success");
respond(workers[1].runtime.requests[0], 200, "replacement-generation");
workers[1].runtime.openings[0].created.transactions[1].deliver("success");
assert.equal(secondNotifications.length, 1);
assert.equal(secondNotifications[0]["new"].channel, "new-remote");
assert.deepEqual(firstNotifications, []);
first.close();
second.close();

console.log(
    JSON.stringify({
        cases: 9,
        result: "pass",
        timersObserved: intervals.length,
    })
);
