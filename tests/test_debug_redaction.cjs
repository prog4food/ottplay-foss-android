const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const bundle = process.argv.includes("--bundle");
async function testSource() {
    const context = vm.createContext({
        console,
        location: { origin: "https://fixture.invalid", port: "443" },
        setInterval() {},
        setTimeout() {},
    });
    context.window = context;
    const source = ts.transpileModule(
        fs.readFileSync(path.join(root, "src/debug/playback-debug.ts"), "utf8"),
        {
            compilerOptions: {
                module: ts.ModuleKind.None,
                target: ts.ScriptTarget.ES5,
            },
        }
    ).outputText;
    vm.runInContext(source, context);
    context._ottDbgEnabled = true;
    context._ottDbgLocal = true;
    // Keep queued events visible instead of sending; real serialization is exercised.
    const flushIngest = context.ottDebugFlushIngest;
    context.ottDebugFlushIngest = () => {};
    const original = {
        items: [
            "portal::[key:DUMMY_SECRET]http://portal.invalid/api/v1/",
            "portal::%5Bkey:DUMMY_SECRET%5Dhttp://portal.invalid/api/v1/",
            "Bearer DUMMY_SECRET",
            "password=DUMMY_SECRET",
            "token%3dDUMMY_SECRET",
        ],
        nested: {
            access_token: "DUMMY_SECRET",
            "api-key": "DUMMY_SECRET",
            headers: {
                Cookie: "sid=DUMMY_SECRET",
                "Set-Cookie": "sid=DUMMY_SECRET",
            },
            password: "DUMMY_SECRET",
            pwd: "DUMMY_SECRET",
            user: "DUMMY_SECRET",
        },
        status: 403,
        url: "https://user:DUMMY_SECRET@provider.invalid/live/name/DUMMY_SECRET/1?token=DUMMY_SECRET",
    };
    context.ottDebugPush(
        "net",
        "failure https://provider.invalid/path/DUMMY_SECRET",
        original
    );
    const ring = JSON.stringify(context._ottDbgRing);
    const pending = context.ottDebugBuildIngestBody(context._ottDbgPending);
    const dump = context.ottDebugDump();
    for (const text of [ring, pending, dump]) {
        assert(!text.includes("DUMMY_SECRET"));
        assert(text.includes("provider.invalid/[redacted]"));
    }
    assert.equal(context._ottDbgRing[0].data.status, 403);
    assert.equal(
        original.nested.password,
        "DUMMY_SECRET",
        "debug must not mutate playback input"
    );
    const circular = {};
    circular.self = circular;
    context.ottDebugPush("net", "cycle", circular);
    assert.doesNotThrow(() => context.ottDebugDump());
    assert(context.ottDebugDump().includes("[truncated]"));
    async function testTransport() {
        const calls = [];
        let storedToken = "";
        context.sessionStorage = { getItem: () => storedToken };
        const setToken = (token) => {
            storedToken = token;
        };
        const queue = () => {
            context._ottDbgPending = [{ cat: "net", msg: "safe event" }];
        };
        context.fetch = (url, options) => {
            calls.push({ ...options, url });
            return Promise.resolve({
                json: () => ({ enabled: false }),
                ok: true,
                status: 200,
            });
        };
        for (const token of ["", "short", "x".repeat(32) + "\n"]) {
            setToken(token);
            queue();
            flushIngest();
            assert.equal(context._ottDbgPending.length, 0);
            queue();
            context.ottDebugFlushIngestUrgent();
            context.ottDebugTryServerConfig();
        }
        assert.equal(calls.length, 0, "no unauthenticated debug requests");
        const token = "DUMMY_AUTH_TOKEN_".repeat(3);
        setToken(token);
        queue();
        flushIngest();
        queue();
        context.ottDebugFlushIngestUrgent();
        context.ottDebugTryServerConfig();
        assert.deepEqual(
            calls.map((c) => c.url),
            ["/debug/ingest", "/debug/ingest", "/debug/config"]
        );
        assert.equal(calls[1].keepalive, true);
        for (const call of calls) {
            assert.equal(call.headers.Authorization, "Bearer " + token);
            assert(!(call.body || "").includes(token));
        }
        assert(!context.ottDebugDump().includes(token));
        const xhrCalls = [];
        let xhrStatus = 200;
        context.fetch = undefined;
        context.XMLHttpRequest = function () {
            const call = { headers: {} };
            this.open = (method, url, async) =>
                Object.assign(call, { async, method, url });
            this.setRequestHeader = (key, value) => {
                call.headers[key] = value;
            };
            this.send = (body) => {
                call.body = body;
                xhrCalls.push(call);
                this.status = xhrStatus;
                this.readyState = 4;
                if (call.async && this.onreadystatechange)
                    this.onreadystatechange();
            };
        };
        queue();
        flushIngest();
        queue();
        context.ottDebugFlushIngestUrgent();
        assert.deepEqual(
            xhrCalls.map((c) => c.async),
            [true, false]
        );
        for (const call of xhrCalls) {
            assert.equal(call.headers.Authorization, "Bearer " + token);
            assert(!call.body.includes(token));
        }
        for (const status of [0, 429, 503]) {
            xhrStatus = status;
            queue();
            flushIngest();
            assert.equal(context._ottDbgPending.length, 1);
            queue();
            context.ottDebugFlushIngestUrgent();
            assert.equal(context._ottDbgPending.length, 1);
        }
        context.fetch = () => Promise.reject(new Error("offline"));
        context._ottDbgPending = Array.from({ length: 600 }, (_, i) => ({
            msg: "safe " + i,
        }));
        flushIngest();
        await new Promise(setImmediate);
        assert.equal(context._ottDbgPending.length, 600);
        const delivered = [];
        context.fetch = (_url, options) => {
            const events = JSON.parse(options.body).events;
            assert(events.length <= 500);
            assert(Buffer.byteLength(options.body, "utf8") <= 60 * 1024);
            delivered.push(...events);
            return Promise.resolve({ ok: true, status: 200 });
        };
        while (context._ottDbgPending.length) flushIngest();
        await new Promise(setImmediate);
        assert.equal(delivered.length, 600);
        assert.equal(new Set(delivered.map((e) => e.msg)).size, 600);
        context._ottDbgPending = Array.from({ length: 400 }, () => ({
            msg: "😀Я".repeat(200),
        }));
        while (context._ottDbgPending.length) flushIngest();
        await new Promise(setImmediate);
        assert.equal(
            delivered.length,
            1000,
            "multibyte batches stay within byte budget"
        );
        context._ottDbgPending = [
            { msg: "x".repeat(100000) },
            { msg: "after oversize" },
        ];
        flushIngest();
        assert.equal(delivered.at(-1).msg, "after oversize");
        for (const status of [429, 503]) {
            context.fetch = () => Promise.resolve({ ok: false, status });
            queue();
            flushIngest();
            await new Promise(setImmediate);
            assert.equal(context._ottDbgPending.length, 1);
            queue();
            context.ottDebugFlushIngestUrgent();
            await new Promise(setImmediate);
            assert.equal(context._ottDbgPending.length, 1);
        }
        context._ottDbgPending = Array.from({ length: 600 }, () => ({
            msg: "safe",
        }));
        context.ottDebugRetryBatch(
            Array.from({ length: 600 }, () => ({ msg: "retry" }))
        );
        assert.equal(context._ottDbgPending.length, context.OTT_DEBUG_RING_MAX);
        console.log(
            "PASS debug (source): redaction, authenticated fetch/XHR/unload, no-token isolation, byte/event limits and offline/HTTP retry recovery"
        );
    }
    await testTransport();
}

async function testInputDiagnostics() {
    const { JSDOM } = require("jsdom");
    const source = fs.readFileSync(
        path.join(root, "src/debug/playback-debug.ts"),
        "utf8"
    );
    const code = bundle
        ? fs.readFileSync(path.join(root, "dist/player.js"), "utf8")
        : ts.transpileModule(source, {
              compilerOptions: {
                  module: ts.ModuleKind.None,
                  target: ts.ScriptTarget.ES5,
              },
          }).outputText;
    for (const enabledAtBoot of [false, true]) {
        const dom = new JSDOM(
            "<!doctype html><button id='target'>Select</button>",
            {
                runScripts: "outside-only",
                url: "https://fixture.invalid/",
            }
        );
        const context = dom.getInternalVMContext();
        // Fixed timestamps cannot accidentally contain the tested secret coordinates.
        context.Date.now = () => 1700000000000;
        context.Math.random = () => 0.25;
        const timers = [];
        const requests = [];
        const nativeCalls = [];
        context.setTimeout = () => 1;
        context.setInterval = (callback, ms) => {
            timers.push({ callback, ms });
            return timers.length;
        };
        context.console = { error() {}, info() {}, log() {}, warn() {} };
        context.fetch = (url) => {
            requests.push(url);
            return Promise.resolve({ ok: false });
        };
        context.__OTT_DEBUG__ = enabledAtBoot;
        if (!enabledAtBoot)
            context.localStorage.setItem("ottplay_debug_hud", "0");
        context.webOS = {
            device: { cursorVisible: (value) => nativeCalls.push(value) },
        };
        try {
            if (bundle) {
                vm.runInContext(
                    fs.readFileSync(
                        path.join(root, "js/runtime-polyfills.js"),
                        "utf8"
                    ),
                    context
                );
                require("./helpers/shared-core-runtime.cjs")(context);
            }
            vm.runInContext(code, context);
            context.version = "fixture";
            vm.runInContext(
                fs.readFileSync(
                    path.join(root, "devices/lg/webos/device.js"),
                    "utf8"
                ),
                context
            );
            const document = context.document;
            const target = document.getElementById("target");
            const snapshot = () =>
                JSON.parse(JSON.stringify(context.__ottDebugInputSnapshot()));
            function readSnapshot() {
                const registrations = [];
                const targets = [context, document];
                const original = targets.map((item) => item.addEventListener);
                const before = {
                    enabled: context.__ottDebug.enabled,
                    hud: document.getElementById("ott_debug_hud"),
                    log: context.__ottDebug.dump(),
                    native: nativeCalls.length,
                    requests: requests.length,
                    timers: timers.length,
                };
                targets.forEach((item, index) => {
                    item.addEventListener = function (...args) {
                        registrations.push(args[0]);
                        return original[index].apply(this, args);
                    };
                });
                let result;
                try {
                    result = snapshot();
                } finally {
                    targets.forEach((item, index) => {
                        item.addEventListener = original[index];
                    });
                }
                assert.deepEqual(registrations, []);
                assert.equal(context.__ottDebug.enabled, before.enabled);
                assert.equal(
                    document.getElementById("ott_debug_hud"),
                    before.hud
                );
                assert.equal(context.__ottDebug.dump(), before.log);
                assert.equal(nativeCalls.length, before.native);
                assert.equal(requests.length, before.requests);
                assert.equal(timers.length, before.timers);
                return result;
            }
            if (!enabledAtBoot) {
                assert.deepEqual(readSnapshot(), {
                    available: true,
                    enabled: false,
                });
                const disabled = context.__ottDebugInputSnapshot();
                disabled.enabled = true;
                assert.deepEqual(readSnapshot(), {
                    available: true,
                    enabled: false,
                });
                assert.equal(
                    context.__ottDebugInput,
                    undefined,
                    "Disabled diagnostics collect no pointer events"
                );
                assert.equal(document.getElementById("ott_debug_hud"), null);
                target.dispatchEvent(
                    new context.MouseEvent("mousemove", { bubbles: true })
                );
                assert.deepEqual(readSnapshot(), {
                    available: true,
                    enabled: false,
                });
                if (bundle) context.toggleDebugHudInfo();
                else context.__ottDebug.toggleHud();
            }
            const api = context.__ottDebug;
            assert.equal(
                api.enabled,
                true,
                "The menu enables diagnostics immediately"
            );
            const hud = () => document.getElementById("ott_debug_hud");
            assert(hud(), "No restart or video is needed for the HUD");
            const refresh = () => {
                const updates = timers.filter((timer) => timer.ms === 1000);
                assert.equal(updates.length, 1);
                updates[0].callback();
            };
            refresh();
            assert(hud().textContent.includes("cursor=unknown"));
            assert(hud().textContent.includes("move=0 down=0 click=0 wheel=0"));
            assert(hud().textContent.includes("(no video)"));
            assert.deepEqual(readSnapshot(), {
                area: "unknown",
                available: true,
                click: 0,
                cursor: "unknown",
                down: 0,
                enabled: true,
                focus: document.hasFocus() ? "on" : "off",
                move: 0,
                page: "unknown",
                wheel: 0,
            });
            const cursor = (visibility) =>
                document.dispatchEvent(
                    new context.CustomEvent("cursorStateChange", {
                        detail: { visibility },
                    })
                );
            cursor(true);
            context.dispatchEvent(new context.Event("focus"));
            document.dispatchEvent(
                new context.CustomEvent("webOSMouse", {
                    detail: { type: "Enter" },
                })
            );
            refresh();
            assert(hud().textContent.includes("cursor=on focus=on"));
            assert(hud().textContent.includes("area=in"));
            const active = readSnapshot();
            assert.equal(active.cursor, "on");
            assert.equal(active.focus, "on");
            assert.equal(active.area, "in");
            const returned = context.__ottDebugInputSnapshot();
            returned.cursor = "DUMMY_SECRET";
            returned.move = 9999;
            assert.deepEqual(readSnapshot(), active);
            for (const value of ["visible", "hidden", "DUMMY_SECRET"]) {
                Object.defineProperty(document, "visibilityState", {
                    configurable: true,
                    value,
                });
                assert.equal(
                    readSnapshot().page,
                    value === "DUMMY_SECRET" ? "unknown" : value
                );
            }
            delete document.visibilityState;
            cursor("DUMMY_SECRET");
            document.dispatchEvent(
                new context.CustomEvent("webOSMouse", {
                    detail: { type: "DUMMY_SECRET" },
                })
            );
            assert(
                !api.dump().includes("DUMMY_SECRET"),
                "Only documented state values are retained"
            );
            const beforeMoves = api.dump();
            let moves = 0;
            let clicks = 0;
            let wheels = 0;
            target.addEventListener("mousemove", () => moves++);
            target.addEventListener("click", () => clicks++);
            target.addEventListener("wheel", () => wheels++);
            target.addEventListener("mousewheel", () => wheels++);
            function wheel(type) {
                const event = new context.WheelEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    clientX: 9876,
                    clientY: 5432,
                    deltaY: 7654,
                });
                assert(target.dispatchEvent(event));
                assert.equal(event.defaultPrevented, false);
            }
            wheel("wheel");
            wheel("mousewheel");
            for (let index = 0; index < 1000; index++) {
                const event = new context.MouseEvent("mousemove", {
                    bubbles: true,
                    cancelable: true,
                    clientX: 9876,
                    clientY: 5432,
                });
                assert(target.dispatchEvent(event));
                assert.equal(event.defaultPrevented, false);
            }
            target.dispatchEvent(
                new context.MouseEvent("mousedown", { bubbles: true })
            );
            target.dispatchEvent(
                new context.MouseEvent("click", { bubbles: true })
            );
            target.dispatchEvent(
                new context.KeyboardEvent("keydown", {
                    bubbles: true,
                    key: "DUMMY_SECRET",
                })
            );
            assert.equal(
                moves,
                1000,
                "Diagnostics leave pointer events available to the player"
            );
            assert.equal(clicks, 1);
            assert.equal(wheels, 2);
            assert.equal(
                api.dump(),
                beforeMoves,
                "Mouse traffic does not flood the event ring"
            );
            refresh();
            assert(
                hud().textContent.includes("move=1000 down=1 click=1 wheel=2")
            );
            assert.deepEqual(readSnapshot(), {
                ...active,
                click: 1,
                down: 1,
                move: 1000,
                wheel: 2,
            });
            cursor(false);
            context.dispatchEvent(new context.Event("blur"));
            document.dispatchEvent(
                new context.CustomEvent("webOSMouse", {
                    detail: { type: "Leave" },
                })
            );
            refresh();
            assert(hud().textContent.includes("cursor=off focus=off"));
            assert(hud().textContent.includes("area=out"));
            assert(!api.dump().includes("9876"));
            assert(!api.dump().includes("7654"));
            assert(!api.dump().includes("DUMMY_SECRET"));
            const timerCount = timers.length;
            api.toggleHud();
            assert.equal(hud(), null);
            const hidden = readSnapshot();
            assert.equal(hidden.enabled, true);
            assert.equal(hidden.cursor, "off");
            assert.equal(hidden.focus, "off");
            assert.equal(hidden.area, "out");
            assert.equal(hidden.wheel, 2);
            wheel("mousewheel");
            assert.equal(readSnapshot().wheel, 3);
            assert.equal(
                hud(),
                null,
                "Reading input state keeps the HUD hidden"
            );
            api.toggleHud();
            target.dispatchEvent(
                new context.MouseEvent("mousemove", { bubbles: true })
            );
            refresh();
            assert(
                hud().textContent.includes("move=1001"),
                "Reopening the HUD must not duplicate listeners"
            );
            wheel("wheel");
            refresh();
            assert(hud().textContent.includes("wheel=4"));
            assert.equal(wheels, 4);
            assert.equal(timers.length, timerCount);
            assert.equal(
                context.localStorage.getItem("ottplay_debug"),
                null,
                "Menu opt-in is limited to this page"
            );
            assert.equal(
                requests.length,
                0,
                "Local diagnosis sends no requests without an explicit debug token"
            );
            assert.deepEqual(
                nativeCalls,
                [],
                "Diagnostics never change native pointer visibility"
            );
            assert.notEqual(document.body.style.cursor, "none");
        } finally {
            dom.window.close();
        }
    }
    // Exercise persisted preferences and opt-in through page boot, then render
    // errors through the same public video-event API used during playback.
    for (const [query, preference, enabled] of [
        ["?nodebug=1", null, false],
        ["?debug=10", null, false],
        ["?debug=trueish", null, false],
        ["?next=debug=1", null, false],
        ["?next=https://example.invalid/?debug=1", null, false],
        ["?next=https://example.invalid/?debug=true", null, false],
        ["?debug=1&other=yes", null, true],
        ["?other=yes&debug=true", null, true],
        ["?debug=1", "0", true],
        ["?debug=1", "1", true],
    ]) {
        const dom = new JSDOM("<!doctype html><video id='video'></video>", {
            runScripts: "outside-only",
            url: "https://fixture.invalid/" + query,
        });
        const context = dom.getInternalVMContext();
        const timers = [];
        let requests = 0;
        context.setTimeout = () => 1;
        context.setInterval = (callback, ms) => {
            timers.push({ callback, ms });
            return timers.length;
        };
        context.console = { error() {}, info() {}, log() {}, warn() {} };
        context.fetch = () => {
            requests++;
            return Promise.resolve({ ok: false });
        };
        if (preference !== null)
            context.localStorage.setItem("ottplay_debug_hud", preference);
        try {
            if (bundle) {
                vm.runInContext(
                    fs.readFileSync(
                        path.join(root, "js/runtime-polyfills.js"),
                        "utf8"
                    ),
                    context
                );
                require("./helpers/shared-core-runtime.cjs")(context);
            }
            vm.runInContext(code, context);
            const api = context.__ottDebug;
            const hud = () => context.document.getElementById("ott_debug_hud");
            assert.equal(api.enabled, enabled, query);
            if (!enabled) {
                assert.equal(hud(), null);
                assert.equal(timers.length, 0, "Unrelated queries do no work");
            } else {
                assert.equal(Boolean(hud()), preference !== "0");
                if (preference === "0") api.toggleHud();
                assert(hud(), "The menu can reopen a persisted hidden HUD");
                const video = context.document.getElementById("video");
                Object.defineProperty(video, "error", {
                    value: {
                        code: 4,
                        message:
                            "failed https://user:DUMMY_SECRET@provider.invalid/live/DUMMY_SECRET " +
                            "<strong id='injected'>diagnostic</strong>",
                    },
                });
                api.onVideoEvent(new context.Event("error"));
                timers.find((timer) => timer.ms === 1000).callback();
                assert(!hud().textContent.includes("DUMMY_SECRET"));
                assert(
                    hud().textContent.includes("provider.invalid/[redacted]")
                );
                assert(hud().textContent.includes("<strong"));
                assert.equal(context.document.getElementById("injected"), null);
                assert(!api.dump().includes("DUMMY_SECRET"));
            }
            assert.equal(
                requests,
                0,
                "HUD diagnosis remains local without auth"
            );
        } finally {
            dom.window.close();
        }
    }
    console.log(
        "PASS debug input/HUD: exact opt-in, persisted visibility, safe error text, menu activation, native state, pointer/wheel delivery, bounded counters, session scope and no upload"
    );
}

// The packaged runtime is tested through its supported API, scheduled work and
// real DOM lifecycle events. No private state is exposed for the test harness.
async function testBundle() {
    const { JSDOM } = require("jsdom");
    const code = fs.readFileSync(path.join(root, "dist/player.js"), "utf8");
    const token = "DUMMY_AUTH_TOKEN_".repeat(3);
    const settle = () => new Promise(setImmediate);
    function fixture(enabled, initialToken = "", serverEnabled = false) {
        const dom = new JSDOM("<!doctype html><video id='video'></video>", {
            runScripts: "outside-only",
            url: "https://fixture.invalid/",
        });
        const context = dom.getInternalVMContext();
        const calls = [];
        const intervals = [];
        let respond = () =>
            Promise.resolve({
                json: () => ({ enabled: serverEnabled }),
                ok: true,
                status: 200,
            });
        context.setTimeout = () => 1;
        context.setInterval = (callback, ms) => {
            intervals.push({ callback, ms });
            return intervals.length;
        };
        context.console = { error() {}, info() {}, log() {}, warn() {} };
        context.__OTT_DEBUG__ = enabled;
        context.sessionStorage.setItem("ottplay_debug_token", initialToken);
        const fetch = (url, options) => {
            calls.push({ ...options, url });
            return respond(url, options);
        };
        context.fetch = fetch;
        vm.runInContext(
            fs.readFileSync(path.join(root, "js/runtime-polyfills.js"), "utf8"),
            context
        );
        require("./helpers/shared-core-runtime.cjs")(context);
        vm.runInContext(code, context);
        return {
            api: () => context.__ottDebug,
            calls,
            context,
            dom,
            fetch,
            flush() {
                const ingest = intervals.filter((timer) => timer.ms === 2000);
                assert.equal(
                    ingest.length,
                    1,
                    "Debug schedules one ingest interval"
                );
                ingest[0].callback();
            },
            intervals,
            respond: (callback) => {
                respond = callback;
            },
            urgent() {
                context.dispatchEvent(new context.Event("pagehide"));
            },
        };
    }
    function events(calls) {
        return calls
            .filter((call) => call.url === "/debug/ingest")
            .flatMap((call) => {
                const parsed = JSON.parse(call.body);
                assert(parsed.events.length <= 500);
                assert(Buffer.byteLength(call.body, "utf8") <= 60 * 1024);
                return parsed.events;
            });
    }
    function assertAuthenticated(calls) {
        assert(calls.length > 0);
        for (const call of calls) {
            assert.equal(call.headers.Authorization, "Bearer " + token);
            assert(!(call.body || "").includes(token));
        }
    }
    for (const invalidToken of ["", "short", "x".repeat(32) + "\n"]) {
        for (const enabled of [false, true]) {
            const f = fixture(enabled, invalidToken);
            try {
                assert.equal(f.api().enabled, enabled);
                f.api().push("net", "must not leave the client");
                if (enabled) {
                    f.flush();
                    f.api().push("net", "urgent without auth");
                    f.urgent();
                    f.context.sessionStorage.setItem(
                        "ottplay_debug_token",
                        token
                    );
                    f.flush();
                } else
                    assert.equal(
                        f.intervals.length,
                        0,
                        "Disabled debug schedules no work"
                    );
                await settle();
                assert.equal(
                    f.calls.length,
                    0,
                    "Invalid tokens cannot send or retain queued debug data"
                );
            } finally {
                f.dom.window.close();
            }
        }
    }
    for (const serverEnabled of [false, true]) {
        const auto = fixture(false, token, serverEnabled);
        try {
            assert.equal(auto.api().enabled, false);
            assert.equal(auto.calls[0].url, "/debug/config");
            assertAuthenticated(auto.calls);
            await settle();
            assert.equal(auto.api().enabled, serverEnabled);
            if (serverEnabled) {
                assert.equal(auto.calls[1].url, "/debug/ingest");
                assert.equal(events(auto.calls)[0].msg, "boot");
                assertAuthenticated(auto.calls);
                auto.flush();
            }
        } finally {
            auto.dom.window.close();
        }
    }

    const f = fixture(true);
    try {
        const api = f.api();
        for (const privateName of [
            "_ottDbgRing",
            "_ottDbgPending",
            "ottDebugPush",
            "ottDebugFlushIngest",
            "OTT_DEBUG_RING_MAX",
        ])
            assert.equal(
                f.context[privateName],
                undefined,
                privateName + " stays private"
            );
        f.context.sessionStorage.setItem("ottplay_debug_token", token);
        api.clear();
        const original = {
            items: [
                "portal::[key:DUMMY_SECRET]http://portal.invalid/api/v1/",
                "portal::%5Bkey:DUMMY_SECRET%5Dhttp://portal.invalid/api/v1/",
                "Bearer DUMMY_SECRET",
                "password=DUMMY_SECRET",
                "token%3dDUMMY_SECRET",
            ],
            nested: {
                access_token: "DUMMY_SECRET",
                "api-key": "DUMMY_SECRET",
                headers: {
                    Cookie: "sid=DUMMY_SECRET",
                    "Set-Cookie": "sid=DUMMY_SECRET",
                },
                password: "DUMMY_SECRET",
                pwd: "DUMMY_SECRET",
                user: "DUMMY_SECRET",
            },
            status: 403,
            url: "https://user:DUMMY_SECRET@provider.invalid/live/name/DUMMY_SECRET/1?token=DUMMY_SECRET",
        };
        api.push(
            "net",
            "failure https://provider.invalid/path/DUMMY_SECRET",
            original
        );
        assert(!api.dump().includes("DUMMY_SECRET"));
        assert(api.dump().includes("provider.invalid/[redacted]"));
        assert.equal(original.nested.password, "DUMMY_SECRET");
        const circular = {};
        circular.self = circular;
        api.push("net", "cycle", circular);
        assert(api.dump().includes("[truncated]"));
        f.flush();
        await settle();
        assertAuthenticated(f.calls);
        assert(!f.calls[0].body.includes("DUMMY_SECRET"));
        assert(f.calls[0].body.includes("provider.invalid/[redacted]"));
        assert.equal(events(f.calls)[0].data.status, 403);
        api.push("net", "urgent event");
        f.urgent();
        assert.equal(f.calls.at(-1).keepalive, true);
        assert(events(f.calls).some((event) => event.msg === "unload-stats"));
        assertAuthenticated(f.calls);

        const xhrCalls = [];
        let xhrStatus = 200;
        f.context.fetch = undefined;
        f.context.XMLHttpRequest = function () {
            const call = { headers: {} };
            this.open = (method, url, async) =>
                Object.assign(call, { async, method, url });
            this.setRequestHeader = (name, value) => {
                call.headers[name] = value;
            };
            this.send = (body) => {
                call.body = body;
                xhrCalls.push(call);
                this.status = xhrStatus;
                this.readyState = 4;
                if (call.async && this.onreadystatechange)
                    this.onreadystatechange();
            };
        };
        api.clear();
        api.push("net", "async xhr");
        f.flush();
        api.push("net", "urgent xhr");
        f.urgent();
        assert.deepEqual(
            xhrCalls.map((call) => call.async),
            [true, false]
        );
        assertAuthenticated(xhrCalls);
        for (const status of [0, 429, 503]) {
            for (const urgent of [false, true]) {
                api.clear();
                xhrCalls.length = 0;
                xhrStatus = status;
                api.push("net", "retry xhr " + status);
                urgent ? f.urgent() : f.flush();
                const failed = events(xhrCalls).filter(
                    (event) => event.cat === "net"
                );
                xhrStatus = 200;
                xhrCalls.length = 0;
                f.flush();
                assert.deepEqual(
                    events(xhrCalls).filter((event) => event.cat === "net"),
                    failed
                );
                assert.equal(
                    events(xhrCalls).filter((event) => event.cat === "net")
                        .length,
                    1,
                    "Failed XHR batch is retried once"
                );
                const count = xhrCalls.length;
                f.flush();
                assert.equal(xhrCalls.length, count);
            }
        }
        f.context.fetch = f.fetch;
        for (const failure of [
            () => Promise.reject(new Error("offline")),
            ...[429, 503].map(
                (status) => () => Promise.resolve({ ok: false, status })
            ),
        ]) {
            for (const urgent of [false, true]) {
                api.clear();
                f.calls.length = 0;
                f.respond(failure);
                api.push("net", "retry fetch");
                urgent ? f.urgent() : f.flush();
                await settle();
                f.respond(() => Promise.resolve({ ok: true, status: 200 }));
                f.calls.length = 0;
                f.flush();
                await settle();
                assert.equal(
                    events(f.calls).filter(
                        (event) => event.msg === "retry fetch"
                    ).length,
                    1
                );
                const count = f.calls.length;
                f.flush();
                assert.equal(
                    f.calls.length,
                    count,
                    "Successfully retried batch leaves the queue"
                );
            }
        }
        api.clear();
        f.calls.length = 0;
        for (let index = 0; index < 600; index++)
            api.push("net", "safe " + index);
        for (let tick = 0; tick < 4; tick++) f.flush();
        await settle();
        assert.equal(events(f.calls).length, 600);
        assert.equal(
            new Set(events(f.calls).map((event) => event.msg)).size,
            600
        );
        api.clear();
        f.calls.length = 0;
        for (let index = 0; index < 400; index++)
            api.push("net", "😀Я".repeat(200));
        for (let tick = 0; tick < 40; tick++) f.flush();
        await settle();
        assert.equal(
            events(f.calls).length,
            400,
            "Multibyte events arrive within byte limits"
        );
        api.clear();
        f.calls.length = 0;
        api.push("net", "x".repeat(100000));
        api.push("net", "after oversize");
        f.flush();
        assert.deepEqual(
            events(f.calls).map((event) => event.msg),
            ["[truncated]", "after oversize"]
        );
        assert(
            !api.dump().includes("x".repeat(100000)) &&
                api.dump().includes("[truncated]"),
            "Oversize messages retain a marker without retaining the raw allocation"
        );
        api.clear();
        f.calls.length = 0;
        let rejectPending;
        f.respond(
            () =>
                new Promise((_resolve, reject) => {
                    rejectPending = reject;
                })
        );
        for (let index = 0; index < 500; index++)
            api.push("net", "old " + index);
        f.flush();
        for (let index = 0; index < 600; index++)
            api.push("net", "new " + index);
        rejectPending(new Error("offline"));
        await settle();
        f.respond(() => Promise.resolve({ ok: true, status: 200 }));
        f.calls.length = 0;
        for (let tick = 0; tick < 4; tick++) f.flush();
        await settle();
        const retained = events(f.calls);
        assert.equal(retained.length, 800, "Offline retry queue is capped");
        assert.equal(retained[0].msg, "old 300");
        assert.equal(retained.at(-1).msg, "new 599");
        assert.equal(
            api.dump().split("\n").length,
            800,
            "Local event ring remains bounded"
        );
        assert(!api.dump().includes(token));
    } finally {
        f.dom.window.close();
    }
    console.log(
        "PASS debug (bundle public API): private scope, redaction, authenticated fetch/XHR/unload, no-token isolation, byte/event limits and offline/HTTP retry recovery"
    );
}

(bundle ? testBundle() : testSource())
    .then(testInputDiagnostics)
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
