"use strict";
// Real dedicated Worker, XHR and IndexedDB; every response is a local fixture.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { chromium } = require("playwright");
const { artifacts } = require("../scripts/hosted-epg.cjs");
const root = path.resolve(__dirname, "..");
const generated = artifacts();
const bridge = ts.transpileModule(
    fs.readFileSync(path.join(root, "src/hosted/epg.ts"), "utf8"),
    { compilerOptions: { target: ts.ScriptTarget.ES5 } }
).outputText;
const publicSource = "https://cdn.epg.one/epg2.xml.gz";
const profile = {
    apiBase: "/epg/v1",
    mode: "server",
    serverWorkerUrl: "/epg-server.js",
    source: publicSource,
    sourceId: "epg-one",
    workerUrl: "/epg-worker.js",
};
// Routing is tested at the actual bridge boundary without fetching any XMLTV.
for (const [urls, expected] of [
    [undefined, "server"],
    [[publicSource], "server"],
    [["http://epg.one/epg2.xml.gz"], "server"],
    [["https://epg.it999.ru/epg2.xml.gz"], "server"],
    [[publicSource + "?token=private"], "client"],
    [["https://private.invalid/paid.xml.gz"], "client"],
    [["https://private.invalid/paid.xml.gz", publicSource], "client"],
    [[publicSource, "https://private.invalid/paid.xml.gz"], "client"],
]) {
    const created = [];
    const messages = [];
    const timeouts = [];
    const host = {
        _: (s) => s,
        __OTTPLAY_HOSTED__: { epg: profile, version: 1 },
        clearInterval() {},
        clearTimeout() {},
        setInterval() {},
        setTimeout(callback, delay) {
            if (delay >= 15000) timeouts.push(callback);
        },
        Worker: function (url) {
            created.push(url);
            this.postMessage = (value) => messages.push(value);
            this.terminate = () => {};
        },
    };
    vm.runInNewContext(bridge, { window: host });
    const session = host.__ottHostedEpg.open(
        [{ id: "18", name: "REN", xmltv_urls: urls }],
        () => {}
    );
    assert.deepEqual(created, [
        "/epg-" + (expected === "server" ? "server" : "worker") + ".js",
    ]);
    assert.equal(host.__ottHostedEpg.diagnostics().transport, expected);
    assert.equal(host.__OTT_HOSTED_EPG_SERVER_VERSION__, 1);
    let expired = false;
    session.guide("18", (rows) => {
        assert.equal(rows, null);
        expired = true;
    });
    timeouts[0]();
    assert(expired);
    assert.equal(
        messages.filter((value) => value.type === "cancel").length,
        expected === "server" ? 1 : 0
    );
    session.close();
}

// Cancellation can synchronously drain queued hits when IndexedDB is absent.
// Exercise the emitted worker itself with controllable XHR completions.
{
    const posted = [];
    const held = [];
    const env = {
        clearTimeout() {},
        postMessage(value) {
            posted.push(value);
        },
        setTimeout() {
            return 1;
        },
        XMLHttpRequest: function () {
            this.open = (method, url) => {
                this.method = method;
                this.url = url;
            };
            this.setRequestHeader = () => {};
            this.send = (body) => {
                this.body = body;
                held.push(this);
            };
            this.abort = () => {
                this.aborted = true;
                if (this.onabort) this.onabort();
            };
        },
    };
    vm.runInNewContext(generated["epg-server.js"].toString(), { self: env });
    const send = (value) => env.onmessage({ data: value });
    const respond = (xhr, value) => {
        xhr.status = 200;
        xhr.responseText = JSON.stringify(value);
        xhr.onload();
    };
    const envelope = {
        fetchedAt: Date.now(),
        generation: "cancel-cache",
        source: "epg-one",
        version: 1,
    };
    const ids = ["A", "C", "D", "E", "B"];
    send({
        apiBase: "/epg/v1",
        channels: ids.map((id) => ({
            archiveHours: 48,
            id,
            name: id,
            tvgId: id,
            tvgName: "",
        })),
        sourceId: "epg-one",
        type: "load",
    });
    respond(held[0], {
        ...envelope,
        mappings: Object.fromEntries(
            ids.map((id) => [id, { channelId: id, logo: "", shift: 0 }])
        ),
        refreshMs: 7200000,
        stale: false,
    });
    send({ id: "B", query: "warm", type: "guide" });
    respond(held[1], {
        ...envelope,
        rows: [
            {
                descr: "Complete",
                icon: "",
                name: "Programme",
                time: Math.floor(Date.now() / 1000),
                time_to: Math.floor(Date.now() / 1000) + 3600,
            },
        ],
    });
    ids.slice(0, 4).forEach((id) => send({ id, query: id, type: "guide" }));
    send({ id: "B", query: "cached", type: "guide" });
    assert.equal(held.length, 6);
    assert.doesNotThrow(() => send({ query: "A", type: "cancel" }));
    assert.equal(
        held.length,
        6,
        "queued B was served from memory, without another GET"
    );
    assert.equal(
        posted.filter(
            (value) => value.type === "guide" && value.query === "cached"
        ).length,
        1
    );
    assert.equal(
        posted.filter((value) => value.type === "guide" && value.query === "A")
            .length,
        0
    );
    assert.equal(held[2].aborted, true);
    send({ type: "close" });
}

// Exercise deadline adaptation without waiting for real timeout/backoff clocks.
// XHR status 504 is the only signal that permits splitting a match request.
{
    function fixture(count, transform = (row) => row) {
        const messages = [];
        const requests = [];
        const timers = [];
        const env = {
            clearTimeout(timer) {
                if (timer) timer.cleared = true;
            },
            postMessage(value) {
                messages.push(value);
            },
            setTimeout(callback, delay) {
                const timer = { callback, delay };
                timers.push(timer);
                return timer;
            },
            XMLHttpRequest: function () {
                this.open = (method, url) => {
                    this.method = method;
                    this.url = url;
                };
                this.setRequestHeader = () => {};
                this.send = (body) => {
                    this.body = body && JSON.parse(body);
                    requests.push(this);
                };
                this.abort = () => {
                    this.aborted = true;
                    if (this.onabort) this.onabort();
                };
            },
        };
        vm.runInNewContext(generated["epg-server.js"].toString(), {
            self: env,
        });
        const send = (value) => env.onmessage({ data: value });
        const envelope = (generation = "split-generation") => ({
            fetchedAt: Date.now(),
            generation,
            source: "epg-one",
            version: 1,
        });
        function respond(xhr, status = 200, generation, overrides) {
            xhr.status = status;
            xhr.responseText = JSON.stringify({
                ...envelope(generation),
                mappings: Object.fromEntries(
                    (xhr.body?.channels || []).map((row) => [
                        row.id,
                        { channelId: row.id, logo: "", shift: 0 },
                    ])
                ),
                refreshMs: 7200000,
                stale: false,
                ...overrides,
            });
            if (xhr.onload) xhr.onload();
        }
        send({
            apiBase: "/epg/v1",
            channels: Array.from({ length: count }, (_, index) =>
                transform({
                    archiveHours: 48,
                    id: String(index),
                    name: "Channel " + index,
                    tvgId: "",
                    tvgName: "",
                })
            ),
            sourceId: "epg-one",
            type: "load",
        });
        return { envelope, messages, requests, respond, send, timers };
    }
    const ready = (f) => f.messages.filter((row) => row.type === "ready");
    const errors = (f) => f.messages.filter((row) => row.type === "error");
    function refresh(f) {
        const timer = f.timers.findLast((row) => !row.cleared);
        assert(timer && timer.delay >= 5000);
        timer.callback();
    }

    const large = fixture(3608);
    let completed = 0;
    while (completed < large.requests.length) {
        const xhr = large.requests[completed++];
        assert.equal(
            ready(large).length,
            0,
            "no partial catalogue is published"
        );
        large.respond(xhr, xhr.body.channels.length > 64 ? 504 : 200);
        assert(completed <= 59, "two reductions plus 57 successful batches");
    }
    assert.equal(completed, 59);
    assert.deepEqual(
        large.requests.slice(0, 3).map((xhr) => xhr.body.channels.length),
        [256, 128, 64]
    );
    assert.equal(ready(large).length, 1);
    assert.equal(Object.keys(ready(large)[0].mappings).length, 3608);
    assert.equal(errors(large).length, 0);
    refresh(large);
    while (completed < large.requests.length) {
        const xhr = large.requests[completed++];
        assert(
            xhr.body.channels.length <= 64,
            "refresh retains the learned cap"
        );
        large.respond(xhr);
    }
    assert.equal(ready(large).length, 2);

    const tail = fixture(320);
    tail.respond(tail.requests[0]);
    assert.equal(ready(tail).length, 0);
    tail.respond(tail.requests[1], 504);
    tail.respond(tail.requests[2]);
    tail.respond(tail.requests[3]);
    assert.deepEqual(
        tail.requests.map((xhr) => xhr.body.channels.length),
        [256, 64, 32, 32],
        "split the actual short final batch, retaining successful candidate mappings"
    );
    assert.equal(ready(tail).length, 1);
    assert.equal(Object.keys(ready(tail)[0].mappings).length, 320);

    const shortTail = fixture(260);
    shortTail.respond(shortTail.requests[0]);
    shortTail.respond(shortTail.requests[1], 504);
    assert.deepEqual(
        shortTail.requests.map((xhr) => xhr.body.channels.length),
        [256, 4],
        "a short tail below the floor fails without creating tiny retries"
    );
    assert.equal(ready(shortTail).length, 0);
    assert.equal(errors(shortTail)[0].code, "EPG_TIMEOUT");

    const escaped = fixture(100, (row) => ({
        ...row,
        id: row.id.padEnd(512, "\u0001"),
        name: "\u0001".repeat(512),
        tvgId: "\u0001".repeat(512),
        tvgName: "\u0001".repeat(512),
    }));
    assert.equal(escaped.requests[0].body.channels.length, 41);
    escaped.respond(escaped.requests[0], 504);
    for (let index = 1; index < escaped.requests.length; index++) {
        assert(
            Buffer.byteLength(JSON.stringify(escaped.requests[index].body)) <=
                500 * 1024
        );
        escaped.respond(escaped.requests[index]);
    }
    assert.deepEqual(
        escaped.requests.slice(1).map((xhr) => xhr.body.channels.length),
        [32, 32, 32, 4],
        "repack escaped metadata across former byte-limited boundaries"
    );
    assert.equal(Object.keys(ready(escaped)[0].mappings).length, 100);

    const maximum = fixture(16384);
    let successful = 0;
    for (let index = 0; index < maximum.requests.length; index++) {
        const xhr = maximum.requests[index];
        if (xhr.body.channels.length > 32) maximum.respond(xhr, 504);
        else maximum.respond(xhr, 200, ++successful < 512 ? "before" : "after");
        assert(
            index < 1027,
            "maximum catalogue permits at most two passes and three reductions"
        );
    }
    assert.equal(successful, 1024);
    assert.equal(maximum.requests.length, 1027);
    assert.equal(ready(maximum).length, 1);
    assert.equal(Object.keys(ready(maximum)[0].mappings).length, 16384);

    const drift = fixture(600);
    let success = 0;
    for (let index = 0; index < drift.requests.length; index++) {
        const xhr = drift.requests[index];
        if (xhr.body.channels.length > 64) drift.respond(xhr, 504);
        else {
            assert.equal(ready(drift).length, 0);
            drift.respond(xhr, 200, ++success === 1 ? "before" : "after");
        }
        assert(
            index < 20,
            "splitting cannot reset the generation restart budget"
        );
    }
    assert.equal(ready(drift).length, 1);
    assert.equal(ready(drift)[0].generation, "after");
    assert.equal(Object.keys(ready(drift)[0].mappings).length, 600);
    assert.equal(success, 12, "two initial chunks, then one complete restart");

    const unstable = fixture(600);
    let generation = 0;
    for (let index = 0; index < unstable.requests.length; index++) {
        const xhr = unstable.requests[index];
        if (xhr.body.channels.length > 64) unstable.respond(xhr, 504);
        else unstable.respond(xhr, 200, "changed-" + ++generation);
        assert(
            index < 6,
            "deadline adaptation cannot reset the generation retry budget"
        );
    }
    assert.equal(generation, 4);
    assert.equal(ready(unstable).length, 0);
    assert.equal(errors(unstable)[0].code, "EPG_GENERATION");

    const floor = fixture(256);
    for (let index = 0; index < floor.requests.length; index++) {
        floor.respond(floor.requests[index], 504);
        assert(index < 4, "halving terminates at the minimum batch size");
    }
    assert.deepEqual(
        floor.requests.map((xhr) => xhr.body.channels.length),
        [256, 128, 64, 32]
    );
    assert.equal(ready(floor).length, 0);
    assert.equal(errors(floor).length, 1);
    assert.equal(errors(floor)[0].code, "EPG_TIMEOUT");

    const saved = fixture(1);
    saved.respond(saved.requests[0]);
    const now = Math.floor(Date.now() / 1000);
    const rows = [
        {
            descr: "",
            icon: "",
            name: "Last good",
            time: now,
            time_to: now + 3600,
        },
    ];
    saved.send({ id: "0", query: "warm", type: "guide" });
    saved.respond(saved.requests[1], 200, undefined, { rows });
    refresh(saved);
    saved.respond(saved.requests[2], 504);
    saved.send({ id: "0", query: "outage", type: "guide" });
    assert.equal(
        saved.requests.length,
        3,
        "last-good guide remains usable after terminal match timeout"
    );
    assert.equal(
        saved.messages.find((row) => row.query === "outage").rows[0].name,
        "Last good"
    );

    for (const failure of [429, 503, "network", "timeout", "malformed"]) {
        const f = fixture(3608);
        const xhr = f.requests[0];
        if (failure === "network") xhr.onerror();
        else if (failure === "timeout") xhr.ontimeout();
        else if (failure === "malformed")
            f.respond(xhr, 200, undefined, { version: 99 });
        else f.respond(xhr, failure);
        assert.equal(f.requests.length, 1, String(failure) + " does not split");
        assert.equal(errors(f).length, 1);
    }

    const closed = fixture(3608);
    closed.respond(closed.requests[0], 504);
    assert.equal(closed.requests.length, 2);
    closed.send({ type: "close" });
    assert.equal(closed.requests[1].aborted, true);
    closed.respond(closed.requests[1]);
    closed.timers.forEach((timer) => {
        if (!timer.cleared) timer.callback();
    });
    assert.equal(
        closed.requests.length,
        2,
        "close prevents the remaining split requests"
    );
    assert.equal(ready(closed).length, 0);
}

async function main() {
    let browser;
    let state;
    const errors = [];
    const requests = [];
    const pending = [];
    const pendingMatches = [];
    const baseRow = (name = "Full programme") => ({
        descr: "Complete description — not a shortened bootstrap.",
        icon: "",
        name,
        time: Math.floor((Date.now() + (state.timeOffset || 0)) / 1000) - 600,
        time_to:
            Math.floor((Date.now() + (state.timeOffset || 0)) / 1000) + 3600,
    });
    const reset = () => {
        state = {
            emptyGuide: false,
            generation: "generation-1",
            guideDelay: false,
            guideErrors: [],
            malformedRows: false,
            matchDelay: false,
            matchError: false,
            matchGenerations: [],
            matchSizeLimit: 0,
            peak: 0,
            running: 0,
            stale: false,
            timeOffset: 0,
        };
        requests.length = 0;
    };
    reset();
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, "http://fixture.invalid");
        function json(code, value) {
            if (res.destroyed) return;
            res.writeHead(code, {
                "Cache-Control": "no-store",
                "Content-Type": "application/json",
            });
            res.end(JSON.stringify(value));
        }
        if (url.pathname === "/") {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end("<!doctype html><title>Hosted EPG server fixture</title>");
        } else if (
            url.pathname === "/epg-server.js" ||
            url.pathname === "/epg-server-no-idb.js" ||
            url.pathname === "/epg-server-clock.js"
        ) {
            res.writeHead(200, { "Content-Type": "application/javascript" });
            const disabled = url.pathname.includes("no-idb")
                ? 'Object.defineProperty(self,"indexedDB",{value:{open:function(){throw new Error("fixture unavailable");}}});\n'
                : url.pathname.includes("clock")
                  ? "var fixtureNow=Date.now;Date.now=function(){return fixtureNow()+7201000;};\n"
                  : "";
            res.end(disabled + generated["epg-server.js"]);
        } else if (url.pathname === "/epg/v1/match") {
            let body = "";
            for await (const data of req) body += data;
            const value = JSON.parse(body);
            requests.push({
                body: value,
                bytes: Buffer.byteLength(body),
                method: req.method,
                path: url.pathname,
            });
            if (state.matchDelay)
                await new Promise((resolve) => pendingMatches.push(resolve));
            const matchError =
                state.matchError ||
                (state.matchSizeLimit &&
                value.channels.length > state.matchSizeLimit
                    ? 504
                    : 0);
            if (matchError) {
                json(matchError, {
                    error: {
                        code:
                            matchError === 504
                                ? "EPG_TIMEOUT"
                                : "EPG_NOT_READY",
                    },
                    source: "epg-one",
                    version: 1,
                });
                return;
            }
            state.generation =
                state.matchGenerations.shift() || state.generation;
            const mappings = Object.fromEntries(
                value.channels.map((row) => [
                    row.id,
                    {
                        channelId: row.tvgId || row.id,
                        logo: "",
                        shift: row.name.includes("+3") ? 10800 : 0,
                    },
                ])
            );
            json(200, {
                fetchedAt: Date.now(),
                generation: state.generation,
                mappings,
                refreshMs: 7200000,
                source: "epg-one",
                stale: state.stale,
                version: 1,
            });
        } else if (url.pathname === "/epg/v1/programmes") {
            requests.push({
                method: req.method,
                path: url.pathname,
                query: Object.fromEntries(url.searchParams),
            });
            state.running++;
            state.peak = Math.max(state.peak, state.running);
            let released = false;
            const release = () => {
                if (released) return;
                released = true;
                state.running--;
            };
            res.once("close", release);
            const respond = () => {
                release();
                const code = state.guideErrors.shift();
                if (code) {
                    if (code === 409) state.generation += "-next";
                    json(code, {
                        error: {
                            code:
                                code === 409
                                    ? "EPG_GENERATION"
                                    : "EPG_NOT_READY",
                        },
                        source: "epg-one",
                        version: 1,
                    });
                } else {
                    const row = baseRow();
                    const shift = Number(url.searchParams.get("shift"));
                    row.time += shift;
                    row.time_to += shift;
                    if (state.malformedRows) row.time_to = row.time;
                    row.unexpectedField = "must not enter a cached guide";
                    json(200, {
                        fetchedAt: Date.now(),
                        generation: state.generation,
                        rows: state.emptyGuide ? [] : [row],
                        source: "epg-one",
                        version: 1,
                    });
                }
            };
            if (state.guideDelay) pending.push(respond);
            else respond();
        } else {
            errors.push("Unexpected request: " + url.pathname);
            res.writeHead(404);
            res.end();
        }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = "http://127.0.0.1:" + server.address().port;
    try {
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext();
        await context.route("**/*", (route) => {
            if (
                route
                    .request()
                    .url()
                    .startsWith(origin + "/")
            )
                return route.continue();
            errors.push("External request attempted");
            return route.abort();
        });
        const page = await context.newPage();
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(origin);
        const install = async () => {
            await page.addScriptTag({ content: bridge });
            await page.evaluate((profile) => {
                window._ = (text) => text;
                window.__OTTPLAY_HOSTED__ = { epg: profile, version: 1 };
                window.invalidations = 0;
                window.__ottClassicGuide = {
                    invalidate() {
                        window.invalidations++;
                    },
                };
                window.openGuide = function (rows, overrides) {
                    window.notifications = [];
                    window.results = {};
                    window.__OTTPLAY_HOSTED__.epg = Object.assign(
                        {},
                        profile,
                        overrides
                    );
                    window.session = window.__ottHostedEpg.open(
                        rows,
                        (mappings) => window.notifications.push(mappings)
                    );
                };
                window.getGuide = (id) =>
                    new Promise((resolve) => window.session.guide(id, resolve));
            }, profile);
        };
        await install();
        const channels = (id) => [
            {
                epg: id,
                id,
                name: "REN HD",
                rec: 48,
                stream: "https://private.invalid/media?token=secret",
            },
        ];
        const open = async (rows, overrides = {}) => {
            await page.evaluate(
                ([rows, overrides]) => window.openGuide(rows, overrides),
                [rows, overrides]
            );
            await page.waitForFunction(
                () => window.__ottHostedEpg.diagnostics().phase === "ready"
            );
        };
        const get = (id) => page.evaluate((id) => window.getGuide(id), id);
        const close = () => page.evaluate(() => window.session.close());
        const guideRequests = () =>
            requests.filter((row) => row.path.endsWith("programmes"));
        const matchRequests = () =>
            requests.filter((row) => row.path.endsWith("match"));

        await open(channels("18"));
        const first = await get("18");
        assert.equal(first.length, 1);
        assert.equal(first[0].descr, baseRow().descr);
        assert.deepEqual(Object.keys(first[0]).sort(), [
            "descr",
            "icon",
            "name",
            "time",
            "time_to",
        ]);
        const match = matchRequests()[0].body;
        assert.deepEqual(Object.keys(match).sort(), [
            "channels",
            "source",
            "version",
        ]);
        assert.deepEqual(Object.keys(match.channels[0]).sort(), [
            "id",
            "name",
            "tvgId",
            "tvgName",
        ]);
        assert(!JSON.stringify(match).includes("private"));
        assert.deepEqual(guideRequests()[0].query, {
            channelId: "18",
            generation: "generation-1",
            hours: "48",
            shift: "0",
        });
        assert.deepEqual(await get("18"), first);
        assert.equal(
            guideRequests().length,
            1,
            "accepted full guide is reused"
        );

        // Close/reopen uses genuine persisted IndexedDB rows immediately while
        // background matching is unavailable; no raw XMLTV or fallback GET.
        await close();
        for (const [status, diagnostic] of [
            [503, "EPG_HTTP"],
            [504, "EPG_TIMEOUT"],
        ]) {
            reset();
            state.matchError = status;
            await page.reload();
            await install();
            await page.evaluate(
                (rows) => window.openGuide(rows),
                channels("18")
            );
            await page.waitForFunction(() => window.notifications.length > 0);
            assert.deepEqual(await get("18"), first);
            assert.equal(guideRequests().length, 0);
            await page.waitForFunction(
                (code) => window.__ottHostedEpg.diagnostics().code === code,
                diagnostic
            );
            assert.equal(
                await page.evaluate(
                    () => window.__ottHostedEpg.diagnostics().cached
                ),
                true,
                "server unavailability or deadline preserves the saved guide"
            );
            await close();
        }

        // Beta.6 stored this exact unversioned signature and a brand-derived
        // negative shift. Neither delayed nor failed rematching may expose it.
        reset();
        const brand = [{ ...channels("brand")[0], epg: "1", name: "Россия-1" }];
        state.matchDelay = true;
        state.matchError = 503;
        await page.evaluate(async (rows) => {
            const row = rows[0],
                now = Math.floor(Date.now() / 1000);
            const opening = indexedDB.open("ottplay-hosted-epg-server-v1", 1);
            await new Promise((resolve, reject) => {
                opening.onsuccess = () => {
                    const db = opening.result,
                        tx = db.transaction(["cache", "usage"], "readwrite"),
                        store = tx.objectStore("cache");
                    store.put(
                        {
                            fetchedAt: Date.now(),
                            generation: "beta6",
                            mappings: {
                                brand: {
                                    channelId: "1",
                                    logo: "",
                                    shift: -3600,
                                },
                            },
                            refreshMs: 7200000,
                            signature: JSON.stringify([
                                "epg-one",
                                [[row.id, row.name, row.epg, "", row.rec]],
                            ]),
                            source: "epg-one",
                            stale: false,
                            version: 1,
                        },
                        "active"
                    );
                    store.put(
                        {
                            bytes: 200,
                            generation: "beta6",
                            rows: [
                                {
                                    descr: "",
                                    icon: "",
                                    name: "Wrong beta6 brand offset",
                                    time: now - 4200,
                                    time_to: now + 600,
                                },
                            ],
                            used: Date.now(),
                        },
                        JSON.stringify(["1", -3600, row.rec])
                    );
                    tx.objectStore("usage").put(
                        { bytes: 200, used: Date.now() },
                        JSON.stringify(["1", -3600, row.rec])
                    );
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
            window.openGuide(rows);
        }, brand);
        await page.waitForFunction(
            () => window.__ottHostedEpg.diagnostics().phase === "download"
        );
        assert.deepEqual(await page.evaluate(() => window.notifications), []);
        assert.equal(
            await get("brand"),
            null,
            "Delayed rematch cannot use beta.6 brand offsets"
        );
        for (let i = 0; i < 200 && !pendingMatches.length; i++)
            await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(pendingMatches.length, 1);
        pendingMatches.splice(0).forEach((done) => done());
        await page.waitForFunction(
            () => window.__ottHostedEpg.diagnostics().phase === "error"
        );
        assert.deepEqual(await page.evaluate(() => window.notifications), []);
        assert.equal(
            await get("brand"),
            null,
            "Failed rematch cannot use beta.6 brand offsets"
        );
        assert.equal(guideRequests().length, 0);
        await close();

        reset();
        state.generation = "corrected-brand-policy";
        await open(brand);
        assert.equal(
            await page.evaluate(() => window.notifications[0].brand.shift),
            0
        );
        const correctedBrand = await get("brand");
        assert.equal(correctedBrand[0].name, "Full programme");
        assert.equal(guideRequests()[0].query.shift, "0");
        assert.equal(guideRequests().length, 1);
        await close();
        reset();
        state.matchError = 503;
        await page.evaluate((rows) => window.openGuide(rows), brand);
        await page.waitForFunction(() => window.notifications.length > 0);
        assert.deepEqual(await get("brand"), correctedBrand);
        assert.equal(
            guideRequests().length,
            0,
            "Corrected cache remains available offline after migration"
        );
        await close();

        const catalogue = (count, prefix) =>
            Array.from({ length: count }, (_, i) => channels(prefix + i)[0]);
        reset();
        await open(catalogue(3000, "catalogue-"));
        assert.deepEqual(
            matchRequests().map((row) => row.body.channels.length),
            [...Array(11).fill(256), 184]
        );
        assert.equal(await page.evaluate(() => window.notifications.length), 1);
        assert.equal(
            await page.evaluate(
                () => Object.keys(window.notifications[0]).length
            ),
            3000
        );
        assert.equal((await get("catalogue-2999")).length, 1);
        await close();

        reset();
        state.matchSizeLimit = 64;
        await open(catalogue(3608, "adaptive-"));
        assert.equal(matchRequests().length, 59);
        assert.deepEqual(
            matchRequests()
                .slice(0, 3)
                .map((row) => row.body.channels.length),
            [256, 128, 64]
        );
        assert.equal(await page.evaluate(() => window.notifications.length), 1);
        assert.equal(
            await page.evaluate(
                () => Object.keys(window.notifications[0]).length
            ),
            3608,
            "real worker publishes the complete catalogue after bounded deadline adaptation"
        );
        assert.equal((await get("adaptive-3607")).length, 1);
        await close();

        reset();
        await open(
            catalogue(400, "unicode-").map((row) => ({
                ...row,
                name: "界".repeat(512),
                tn: "😀".repeat(256),
            }))
        );
        assert(
            matchRequests().length > 1,
            "UTF8 metadata splits before the 512KiB server limit"
        );
        assert.equal(
            matchRequests().reduce(
                (sum, row) => sum + row.body.channels.length,
                0
            ),
            400
        );
        assert(
            matchRequests().every(
                (row) =>
                    row.bytes <= 500 * 1024 && row.body.channels.length <= 256
            )
        );
        assert.equal(
            await page.evaluate(
                () => Object.keys(window.notifications[0]).length
            ),
            400
        );
        await close();

        reset();
        state.matchGenerations = [
            "generation-1",
            "generation-2",
            "generation-2",
            "generation-2",
        ];
        await open(catalogue(3000, "restart-"));
        assert.equal(
            matchRequests().length,
            14,
            "one complete restart on generation drift between batches"
        );
        assert.equal(
            await page.evaluate(() => window.notifications.length),
            1,
            "partial batch mappings never become visible"
        );
        assert.equal(
            await page.evaluate(
                () => Object.keys(window.notifications[0]).length
            ),
            3000
        );
        assert.equal((await get("restart-2999")).length, 1);
        assert.equal(guideRequests()[0].query.generation, "generation-2");
        await close();

        reset();
        state.matchGenerations = [
            "generation-1",
            "generation-2",
            "generation-3",
            "generation-4",
        ];
        await page.evaluate(
            (rows) => window.openGuide(rows),
            catalogue(3000, "unstable-")
        );
        await page.waitForFunction(
            () => window.__ottHostedEpg.diagnostics().code === "EPG_GENERATION"
        );
        assert.equal(
            matchRequests().length,
            4,
            "a second generation drift stops instead of looping"
        );
        assert.equal(await page.evaluate(() => window.notifications.length), 0);
        await close();

        reset();
        await open([{ ...channels("profile-a")[0], epg: "shared-canonical" }]);
        const sharedGuide = await get("profile-a");
        await close();
        await open([{ ...channels("profile-b")[0], epg: "shared-canonical" }]);
        assert.deepEqual(await get("profile-b"), sharedGuide);
        assert.equal(
            matchRequests().length,
            2,
            "a different local profile matches independently"
        );
        assert.equal(
            guideRequests().length,
            1,
            "the fixed-source canonical guide is reusable across profiles"
        );
        await close();

        reset();
        await open(channels("no-idb"), {
            serverWorkerUrl: "/epg-server-no-idb.js",
        });
        assert.equal((await get("no-idb")).length, 1);
        assert.equal((await get("no-idb")).length, 1);
        assert.equal(
            guideRequests().length,
            1,
            "IDB unavailable still has bounded memory cache"
        );
        await close();

        reset();
        await open([{ ...channels("shifted")[0], name: "REN +3" }]);
        const shifted = await get("shifted");
        assert.equal(guideRequests()[0].query.shift, "10800");
        assert(Math.abs(shifted[0].time - (baseRow().time + 10800)) <= 1);
        assert(Math.abs(shifted[0].time_to - (baseRow().time_to + 10800)) <= 1);
        await close();

        reset();
        await open(channels("recover"));
        state.guideErrors = [503];
        assert.equal(await get("recover"), null);
        await page.waitForFunction(
            () => window.__ottHostedEpg.diagnostics().phase === "error"
        );
        assert.equal(
            await page.evaluate(
                () => window.__ottHostedEpg.diagnostics().cached
            ),
            false,
            "mappings alone are not a saved programme guide"
        );
        assert.equal((await get("recover")).length, 1);
        await page.waitForFunction(
            () => window.__ottHostedEpg.diagnostics().phase === "ready"
        );
        assert.equal(
            await page.evaluate(() => window.__ottHostedEpg.diagnostics().code),
            ""
        );
        await close();

        reset();
        await open(channels("invalid"));
        state.malformedRows = true;
        assert.equal(await get("invalid"), null);
        assert.equal(await get("invalid"), null);
        assert.equal(
            guideRequests().length,
            2,
            "malformed rows never poison the accepted cache"
        );
        assert.equal(
            await page.evaluate(() => window.__ottHostedEpg.diagnostics().code),
            "EPG_RESPONSE"
        );
        await close();

        reset();
        await open(channels("generation"));
        state.guideErrors = [409];
        assert.equal((await get("generation")).length, 1);
        assert.equal(matchRequests().length, 2);
        assert.equal(guideRequests().length, 2);
        assert.equal(guideRequests()[1].query.generation, "generation-1-next");
        assert.equal(await page.evaluate(() => window.notifications.length), 2);
        await close();

        reset();
        await open(channels("bounded-409"));
        state.guideErrors = [409, 409];
        assert.equal(await get("bounded-409"), null);
        assert.equal(matchRequests().length, 2);
        assert.equal(guideRequests().length, 2, "generation retry cannot loop");
        await close();

        reset();
        state.stale = true;
        await open(channels("stale"));
        assert.equal(
            await page.evaluate(
                () => window.__ottHostedEpg.diagnostics().sourceStale
            ),
            true
        );
        assert.equal((await get("stale")).length, 1);
        const count = await page.evaluate(() => window.notifications.length);
        await page.evaluate(() => window.session.retry());
        await page.waitForFunction(
            () => window.__ottHostedEpg.diagnostics().phase === "ready"
        );
        assert.equal(
            await page.evaluate(() => window.notifications.length),
            count + 1,
            "retry accepts cache generation once, same response does not re-invalidate"
        );
        await close();

        reset();
        await open(
            Array.from({ length: 7 }, (_, i) => channels("queue-" + i)[0])
        );
        state.guideDelay = true;
        const batch = page.evaluate(() =>
            Promise.all(
                [
                    "queue-0",
                    "queue-0",
                    "queue-1",
                    "queue-2",
                    "queue-3",
                    "queue-4",
                    "queue-5",
                    "queue-6",
                ].map(window.getGuide)
            )
        );
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.equal(pending.length, 4);
        assert.equal(state.peak, 4);
        pending.splice(0).forEach((done) => done());
        await new Promise((resolve) => setTimeout(resolve, 150));
        pending.splice(0).forEach((done) => done());
        const batchRows = await batch;
        assert.equal(batchRows.length, 8);
        assert.equal(
            guideRequests().length,
            7,
            "same-channel in-flight queries coalesce"
        );
        assert.deepEqual(batchRows[0], batchRows[1]);
        await close();

        reset();
        await open(
            Array.from({ length: 30 }, (_, i) => channels("evict-" + i)[0])
        );
        for (let i = 0; i < 30; i++)
            assert.equal((await get("evict-" + i)).length, 1);
        const stored = await page.evaluate(
            () =>
                new Promise((resolve, reject) => {
                    const opening = indexedDB.open(
                        "ottplay-hosted-epg-server-v1",
                        1
                    );
                    opening.onerror = () => reject(opening.error);
                    opening.onsuccess = () => {
                        const db = opening.result;
                        const tx = db.transaction(
                            ["cache", "usage"],
                            "readonly"
                        );
                        const count = tx.objectStore("cache").count();
                        const usage = tx.objectStore("usage").getAll();
                        const records = tx.objectStore("cache").getAll();
                        tx.oncomplete = () => {
                            db.close();
                            resolve({
                                count: count.result,
                                records: records.result,
                                usage: usage.result,
                            });
                        };
                    };
                })
        );
        assert.equal(
            stored.count,
            25,
            "one active snapshot plus 24 guides across all previous profiles"
        );
        assert.equal(stored.usage.length, 24);
        assert(
            stored.records
                .filter((record) => Array.isArray(record.rows))
                .every((record) => !Object.hasOwn(record, "signature")),
            "guide records never duplicate unbounded playlist metadata"
        );
        assert.equal(
            stored.records.filter((record) =>
                Object.hasOwn(record, "signature")
            ).length,
            1,
            "only the active mapping snapshot stores the exact profile signature"
        );
        assert(
            stored.usage.reduce((sum, entry) => sum + entry.bytes, 0) <=
                32 * 1024 * 1024
        );
        assert(
            stored.usage.every(
                (entry) => Object.keys(entry).sort().join() === "bytes,used"
            ),
            "eviction scans metadata only"
        );
        await close();

        reset();
        state.emptyGuide = true;
        await open(
            Array.from({ length: 24 }, (_, i) => channels("empty-" + i)[0])
        );
        for (let i = 0; i < 24; i++)
            assert.deepEqual(await get("empty-" + i), []);
        const emptyEntries = await page.evaluate(
            () =>
                new Promise((resolve) => {
                    const opening = indexedDB.open(
                        "ottplay-hosted-epg-server-v1",
                        1
                    );
                    opening.onsuccess = () => {
                        const db = opening.result;
                        const tx = db.transaction(["usage"], "readonly");
                        const all = tx.objectStore("usage").getAll();
                        tx.oncomplete = () => {
                            db.close();
                            resolve(all.result);
                        };
                    };
                })
        );
        assert.equal(
            emptyEntries.length,
            24,
            "empty valid guides consume zero row bytes, not 8MB each"
        );
        assert(emptyEntries.every((entry) => entry.bytes === 0));
        await close();

        reset();
        await open(channels("timeout"));
        state.guideDelay = true;
        assert.equal(await get("timeout"), null);
        await page.waitForFunction(
            () => window.__ottHostedEpg.diagnostics().code === "EPG_TIMEOUT"
        );
        assert.equal(guideRequests().length, 1);
        pending.splice(0).forEach((done) => done());
        await close();

        reset();
        await open(
            Array.from({ length: 20 }, (_, i) => channels("deadline-" + i)[0])
        );
        state.guideDelay = true;
        const expiredRows = await page.evaluate(() =>
            Promise.all(
                Array.from({ length: 20 }, (_, i) =>
                    window.getGuide("deadline-" + i)
                )
            )
        );
        assert(expiredRows.every((rows) => rows === null));
        const expiredRequestCount = guideRequests().length;
        assert(
            expiredRequestCount <= 16,
            "last queued consumers expire before another 12s request can start"
        );
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.equal(
            guideRequests().length,
            expiredRequestCount,
            "expired queued jobs never leak delayed requests"
        );
        assert.equal(
            state.running,
            0,
            "all active timed-out XHRs have been aborted"
        );
        pending.splice(0).forEach((done) => done());
        await close();

        reset();
        await open(channels("closed"));
        state.guideDelay = true;
        await page.evaluate(() =>
            window.session.guide("closed", (rows) => {
                window.results.late = rows;
            })
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        await close();
        pending.splice(0).forEach((done) => done());
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(
            await page.evaluate(() => window.results.late),
            undefined,
            "late response after close is ignored"
        );
        assert.equal(
            await page.evaluate(
                () => window.__ottHostedEpg.diagnostics().phase
            ),
            "idle"
        );
        reset();
        await open(channels("clock"));
        const beforeClock = await get("clock");
        await close();
        state.timeOffset = 7201000;
        state.stale = true;
        await open(channels("clock"), {
            serverWorkerUrl: "/epg-server-clock.js",
        });
        const afterClock = await get("clock");
        assert.equal(
            guideRequests().length,
            2,
            "same-generation history-only cache expires after 2h"
        );
        assert(afterClock[0].time >= beforeClock[0].time + 7200);
        assert.equal(matchRequests()[1].body.source, "epg-one");
        await close();

        assert.deepEqual(errors, []);
        await context.close();
        console.log(
            "PASS hosted server EPG: private metadata projection, real Worker/IndexedDB, reload outage cache, global metadata-only eviction, storage failure, bounded generation retry, stale data, shifted full rows, malformed response/recovery, request coalescing/concurrency/deadlines, UTF8 catalogue batches, atomic bounded rematch, cache freshness, timeout/close and custom-source routing"
        );
    } finally {
        if (browser) await browser.close();
        pending.splice(0).forEach((done) => done());
        pendingMatches.splice(0).forEach((done) => done());
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
