const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { JSDOM } = require("jsdom");

const root = path.resolve(__dirname, "..");
function compile(source) {
    return ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.None,
            target: ts.ScriptTarget.ES5,
        },
    }).outputText;
}
const logger = compile(
    fs.readFileSync(path.join(root, "src/debug/playback-debug.ts"), "utf8")
);
// Exercise the real core late-attachment entry point without booting playback.
const core = ts.createSourceFile(
    "core.ts",
    fs.readFileSync(path.join(root, "src/core/index.ts"), "utf8"),
    ts.ScriptTarget.Latest,
    true
);
const attachCurrent = core.statements.find(
    (node) =>
        ts.isExpressionStatement(node) &&
        /^\(window as any\)\.__ottDebugAttachCurrent\s*=/.test(
            node.getText(core)
        )
);
assert(attachCurrent, "core must expose a late-attachment entry point");
const attachSource = compile(attachCurrent.getText(core));
const events = {
    ERROR: "error",
    FRAG_LOADED: "frag-loaded",
    LEVEL_LOADED: "level-loaded",
    LEVEL_SWITCHED: "level-switched",
    MANIFEST_PARSED: "manifest-parsed",
};
const secret = "DUMMY_PRIVATE_CREDENTIAL";
const token = "DUMMY_DIAGNOSTIC_TOKEN_".repeat(2);
const plain = (value) => JSON.parse(JSON.stringify(value));
const microtasks = () => new Promise(setImmediate);

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, reject, resolve };
}

function fakeHls() {
    const listeners = new Map();
    const calls = [];
    function original(...args) {
        calls.push({ args, receiver: this });
        if (args[0] instanceof Error) throw args[0];
        return args[0];
    }
    const hls = {
        bandwidthEstimate: 5000000,
        callbacks(name) {
            return [...(listeners.get(name) || [])];
        },
        calls,
        config: { xhrSetup: original },
        count() {
            return [...listeners.values()].reduce((n, set) => n + set.size, 0);
        },
        currentLevel: 2,
        emit(name, value) {
            [...(listeners.get(name) || [])].forEach((callback) =>
                callback(name, value)
            );
        },
        levels: [{ bitrate: 4000000, height: 1080 }],
        off(name, callback) {
            listeners.get(name)?.delete(callback);
        },
        on(name, callback) {
            if (!listeners.has(name)) listeners.set(name, new Set());
            listeners.get(name).add(callback);
        },
        recoverMediaError: original,
        startLoad: original,
    };
    return { hls, original };
}

function trackListeners(target) {
    const originalAdd = target.addEventListener.bind(target);
    const originalRemove = target.removeEventListener.bind(target);
    const active = [];
    target.addEventListener = (name, callback, options) => {
        if (
            !active.some(
                (item) => item.name === name && item.callback === callback
            )
        )
            active.push({ callback, name, options });
        originalAdd(name, callback, options);
    };
    target.removeEventListener = (name, callback, options) => {
        const index = active.findIndex(
            (item) => item.name === name && item.callback === callback
        );
        if (index >= 0) active.splice(index, 1);
        originalRemove(name, callback, options);
    };
    return active;
}

function fixture(options = {}) {
    const dom = new JSDOM(
        '<!doctype html><body><video id="video"></video></body>',
        {
            pretendToBeVisual: true,
            runScripts: "outside-only",
            url: "https://player.invalid/",
        }
    );
    const w = dom.window;
    const timers = new Map();
    let nextTimer = 1;
    const calls = [];
    const input = { starts: 0, stops: 0 };
    w.console = { error() {}, info() {}, log() {}, warn() {} };
    w.setInterval = (callback, delay) => {
        const id = nextTimer++;
        timers.set(id, { callback, delay, repeat: true });
        return id;
    };
    w.setTimeout = (callback, delay) => {
        const id = nextTimer++;
        timers.set(id, { callback, delay, repeat: false });
        return id;
    };
    w.clearTimeout = w.clearInterval = (id) => timers.delete(id);
    w.fetch = (url, request) => {
        calls.push({ request, url });
        return options.fetch
            ? options.fetch(url, request)
            : Promise.resolve({
                  json: () => ({ enabled: false }),
                  ok: true,
                  status: 200,
              });
    };
    w.Hls = { Events: events };
    w.__ottDebugInputInit = () => input.starts++;
    w.__ottDebugInputStop = () => input.stops++;
    const documentListeners = trackListeners(w.document);
    const windowListeners = trackListeners(w);
    if (options.bootToken)
        w.sessionStorage.setItem("ottplay_debug_token", token);
    w.eval(logger);
    w.eval("var hlsInstance = null;");
    w.eval(attachSource);
    const video = w.document.getElementById("video");
    video.src = "https://provider.invalid/live/" + secret;
    Object.defineProperties(video, {
        buffered: {
            configurable: true,
            value: { end: () => 20, length: 1, start: () => 0 },
        },
        currentTime: { configurable: true, value: 4 },
        error: { configurable: true, value: { code: 2, message: secret } },
        networkState: { configurable: true, value: 2 },
        paused: { configurable: true, value: false },
        readyState: { configurable: true, value: 2 },
        videoHeight: { configurable: true, value: 1080 },
        videoWidth: { configurable: true, value: 1920 },
    });
    return {
        attach(hls) {
            w.hlsInstance = hls;
        },
        calls,
        close() {
            w.__ottDebug.disable();
            timers.clear();
            dom.window.close();
        },
        documentListeners,
        input,
        tick() {
            for (const [id, timer] of [...timers]) {
                if (!timers.has(id)) continue;
                if (!timer.repeat) timers.delete(id);
                timer.callback();
            }
        },
        timers,
        w,
        windowListeners,
    };
}

const tests = [];
function test(name, body) {
    tests.push({ body, name });
}
function stopped(f, hls) {
    assert.equal(f.w.__ottDebug.enabled, false);
    assert.equal(f.timers.size, 0, "all diagnostic timers must stop");
    if (hls) assert.equal(hls.count(), 0, "all HLS listeners must detach");
    assert.equal(f.w.document.getElementById("ott_debug_hud"), null);
    for (const name of ["keydown", "visibilitychange"])
        assert(!f.documentListeners.some((item) => item.name === name), name);
    for (const name of ["pagehide", "beforeunload"])
        assert(!f.windowListeners.some((item) => item.name === name), name);
}

test("remote capture stays hidden and never uploads to legacy debug", async () => {
    const f = fixture();
    try {
        f.w.sessionStorage.setItem("ottplay_debug_token", token);
        const received = [];
        const release = f.w.__ottDebug.capture((event) => received.push(event));
        f.w.__ottDebug.push("sys", "test", { token: secret });
        f.w.__ottDebug.onVideoEvent(new f.w.Event("waiting"));
        f.tick();
        f.w.dispatchEvent(new f.w.Event("pagehide"));
        f.w.dispatchEvent(new f.w.Event("beforeunload"));
        await microtasks();
        assert(received.some((event) => event.msg === "test"));
        assert(!JSON.stringify(received).includes(secret));
        assert.equal(
            f.calls.length,
            0,
            "remote capture must not use /debug routes"
        );
        assert.equal(f.w.document.getElementById("ott_debug_hud"), null);
        assert.equal(
            f.w.localStorage.length,
            0,
            "remote capture must not persist opt-in"
        );
        assert.notEqual(f.w.__OTT_DEBUG__, true);
        release();
        release();
        stopped(f);
        assert.deepEqual(f.input, { starts: 1, stops: 1 });
    } finally {
        f.close();
    }
});

test("late attach is idempotent and restores HLS callbacks exactly", () => {
    const f = fixture();
    const { hls, original } = fakeHls();
    try {
        const thirdParty = () => {};
        hls.on(events.ERROR, thirdParty);
        f.attach(hls);
        const release = f.w.__ottDebug.capture(() => {});
        assert.equal(hls.count(), 6);
        f.w.__ottDebug.attachHls(hls);
        f.w.__ottDebugAttachCurrent();
        assert.equal(
            hls.count(),
            6,
            "repeated attachment must not duplicate listeners"
        );
        assert.notEqual(hls.startLoad, original);
        assert.notEqual(hls.config.xhrSetup, original);
        release();
        assert.equal(
            hls.count(),
            1,
            "third-party listener must survive detach"
        );
        assert.deepEqual(hls.callbacks(events.ERROR), [thirdParty]);
        assert.equal(hls.recoverMediaError, original);
        assert.equal(hls.startLoad, original);
        assert.equal(hls.config.xhrSetup, original);
        stopped(f);
    } finally {
        f.close();
    }
});

test("wrappers preserve receiver, all arguments, return values and exceptions", () => {
    const f = fixture();
    const { hls } = fakeHls();
    try {
        f.attach(hls);
        const release = f.w.__ottDebug.capture(() => {});
        const receiver = {};
        const value = { marker: true };
        const failure = new Error("original failure");
        for (const callback of [hls.startLoad, hls.recoverMediaError]) {
            assert.equal(callback.call(receiver, value, 2, 3), value);
            assert.deepEqual(hls.calls.at(-1), {
                args: [value, 2, 3],
                receiver,
            });
            assert.throws(
                () => callback.call(receiver, failure),
                (error) => error === failure
            );
        }
        const xhr = new f.w.EventTarget();
        xhr.status = 503;
        const listeners = trackListeners(xhr);
        assert.equal(
            hls.config.xhrSetup.call(
                receiver,
                xhr,
                "https://provider.invalid/",
                value
            ),
            xhr
        );
        assert.deepEqual(hls.calls.at(-1), {
            args: [xhr, "https://provider.invalid/", value],
            receiver,
        });
        assert.equal(listeners.length, 3);
        const throws = f.w.__ottDebug.wrapXhrSetup(function () {
            throw failure;
        });
        assert.throws(
            () => throws.call(receiver, xhr, "https://provider.invalid/"),
            (error) => error === failure
        );
        assert.equal(
            listeners.length,
            3,
            "a failed original callback must not install hooks"
        );
        xhr.dispatchEvent(new f.w.Event("loadend"));
        assert.equal(listeners.length, 0);
        release();
    } finally {
        f.close();
    }
});

test("replacing the engine detaches only owned wrappers and listeners", () => {
    const f = fixture();
    const first = fakeHls();
    const second = fakeHls();
    try {
        const received = [];
        f.attach(first.hls);
        const release = f.w.__ottDebug.capture((event) => received.push(event));
        const stale = first.hls.callbacks(events.ERROR)[0];
        const replacement = () => "new wrapper";
        first.hls.startLoad = replacement;
        f.w.__ottDebug.attachHls(second.hls);
        assert.equal(first.hls.count(), 0);
        assert.equal(first.hls.startLoad, replacement);
        assert.equal(first.hls.recoverMediaError, first.original);
        const before = received.length;
        stale(events.ERROR, { fatal: true });
        assert.equal(received.length, before);
        second.hls.emit(events.ERROR, {
            details: "failed",
            fatal: true,
            type: "network",
        });
        assert.equal(received.length, before + 1);
        release();
        stopped(f, second.hls);
        assert.equal(second.hls.config.xhrSetup, second.original);
    } finally {
        f.close();
    }
});

test("retiring an engine removes its in-flight network listeners", () => {
    const f = fixture();
    const first = fakeHls();
    const second = fakeHls();
    try {
        const received = [];
        f.attach(first.hls);
        const release = f.w.__ottDebug.capture((event) => received.push(event));
        const xhr = new f.w.EventTarget();
        xhr.status = 503;
        const listeners = trackListeners(xhr);
        first.hls.config.xhrSetup(xhr, "https://provider.invalid/old-stream");
        assert.equal(listeners.length, 3);
        f.w.__ottDebug.attachHls(second.hls);
        const before = received.length;
        xhr.dispatchEvent(new f.w.Event("load"));
        assert.equal(
            received.length,
            before,
            "an old stream must not contribute new network events"
        );
        assert.equal(
            listeners.length,
            0,
            "engine detach must remove pending request hooks"
        );
        release();
    } finally {
        f.close();
    }
});

test("remote releases preserve local ownership and other captures", () => {
    const f = fixture();
    try {
        f.w.__ottDebug.enable();
        const first = [];
        const second = [];
        const release1 = f.w.__ottDebug.capture((event) => first.push(event));
        const release2 = f.w.__ottDebug.capture((event) => second.push(event));
        release1();
        f.w.__ottDebug.push("video", "playing");
        assert.equal(first.length, 0);
        assert.equal(second.length, 1);
        release2();
        assert.equal(f.w.__ottDebug.enabled, true);
        assert(f.w.document.getElementById("ott_debug_hud"));
        assert.equal(f.input.stops, 0);
        f.w.__ottDebug.disable();
        stopped(f);
    } finally {
        f.close();
    }
});

test("multiple remote consumers share instrumentation until the last release", () => {
    const f = fixture();
    try {
        const first = [];
        const second = [];
        const release1 = f.w.__ottDebug.capture((event) => first.push(event));
        const timerCount = f.timers.size;
        const release2 = f.w.__ottDebug.capture((event) => second.push(event));
        assert.equal(f.timers.size, timerCount);
        assert.equal(f.input.starts, 1);
        release1();
        const before = first.length;
        f.w.__ottDebug.push("video", "playing");
        assert.equal(first.length, before);
        assert.equal(second.length, 1);
        assert.equal(f.w.__ottDebug.enabled, true);
        release2();
        stopped(f);
        assert.equal(f.input.stops, 1);
    } finally {
        f.close();
    }
});

test("capture payloads are independent and disable notifies every consumer once", () => {
    const f = fixture();
    try {
        let stops1 = 0;
        let stops2 = 0;
        const received = [];
        const release1 = f.w.__ottDebug.capture(
            (event) => {
                event.msg = "mutated";
                throw new Error("consumer failed");
            },
            () => {
                stops1++;
                throw new Error("stop failed");
            }
        );
        const release2 = f.w.__ottDebug.capture(
            (event) => received.push(event),
            () => stops2++
        );
        f.w.__ottDebug.push("video", "original", { nested: { safe: 1 } });
        assert.equal(received.at(-1).msg, "original");
        assert(f.w.__ottDebug.dump().includes("original"));
        assert(!f.w.__ottDebug.dump().includes("mutated"));
        f.w.__ottDebug.disable();
        f.w.__ottDebug.disable();
        release1();
        release2();
        assert.equal(stops1, 1);
        assert.equal(stops2, 1);
        stopped(f);
    } finally {
        f.close();
    }
});

test("reentrant disable during event delivery retires remaining consumers", () => {
    const f = fixture();
    try {
        let subsequent = 0;
        const release1 = f.w.__ottDebug.capture((event) => {
            if (event.msg === "stop-now") f.w.__ottDebug.disable();
        });
        const release2 = f.w.__ottDebug.capture(() => subsequent++);
        f.w.__ottDebug.push("video", "stop-now");
        assert.equal(subsequent, 0);
        release1();
        release2();
        stopped(f);
        // A callback can also cancel during the first boot event.
        const release3 = f.w.__ottDebug.capture(() => f.w.__ottDebug.disable());
        release3();
        stopped(f);
    } finally {
        f.close();
    }
});

test("stopping from a waiting event cannot reinstall a stall timer", () => {
    const f = fixture();
    try {
        const release = f.w.__ottDebug.capture((event) => {
            if (event.msg === "waiting") f.w.__ottDebug.disable();
        });
        f.w.__ottDebug.onVideoEvent(new f.w.Event("waiting"));
        release();
        stopped(f);
    } finally {
        f.close();
    }
});

test("stale config and ingest responses cannot enable or refill a new session", async () => {
    const config = deferred();
    const ingest = [];
    const f = fixture({
        bootToken: true,
        fetch(url) {
            if (url === "/debug/config") return config.promise;
            const pending = deferred();
            ingest.push(pending);
            return pending.promise;
        },
    });
    try {
        f.w.__ottDebug.disable();
        config.resolve({
            json: () => ({ enabled: true }),
            ok: true,
            status: 200,
        });
        await microtasks();
        stopped(f);
        f.w.__ottDebug.enable();
        f.w.__ottDebug.push("sys", "pending local");
        f.w.dispatchEvent(new f.w.Event("pagehide"));
        assert(ingest.length >= 2);
        f.w.__ottDebug.disable();
        const release = f.w.__ottDebug.capture(() => {});
        for (const [index, pending] of ingest.entries()) {
            if (index % 2) pending.reject(new Error("offline"));
            else pending.resolve({ ok: false, status: 503 });
        }
        await microtasks();
        assert.equal(
            f.w._ottDbgPending.length,
            0,
            "old retries must not reach the new session"
        );
        release();
        stopped(f);
    } finally {
        f.close();
    }
});

test("stale HLS and XHR callbacks are inert after disable and restart", () => {
    const f = fixture();
    const { hls } = fakeHls();
    try {
        f.attach(hls);
        const release1 = f.w.__ottDebug.capture(() => {});
        const oldError = hls.callbacks(events.ERROR)[0];
        const oldRecover = hls.recoverMediaError;
        const oldSetup = hls.config.xhrSetup;
        const xhr = new f.w.EventTarget();
        xhr.status = 503;
        const listeners = trackListeners(xhr);
        oldSetup(xhr, "https://provider.invalid/private/" + secret);
        const oldLoad = listeners.find((item) => item.name === "load").callback;
        const oldXhrError = listeners.find(
            (item) => item.name === "error"
        ).callback;
        release1();
        assert.equal(listeners.length, 0, "stop removes pending XHR hooks");
        const received = [];
        const release2 = f.w.__ottDebug.capture((event) =>
            received.push(event)
        );
        const before = received.length;
        oldError(events.ERROR, { fatal: true });
        assert.equal(oldRecover.call(hls, 42), 42);
        oldSetup(xhr, "https://provider.invalid/");
        oldLoad();
        oldXhrError();
        assert.equal(
            listeners.length,
            0,
            "a stale setup must not install new hooks"
        );
        assert.equal(
            received.length,
            before,
            "stale callbacks must not report into a new capture"
        );
        release2();
        stopped(f, hls);
    } finally {
        f.close();
    }
});

test("snapshot is an allowlisted URL-free observation even while disabled", () => {
    const f = fixture();
    try {
        const snapshot = plain(f.w.__ottDebug.snapshot());
        assert.equal(snapshot.available, true);
        assert.equal(snapshot.enabled, false);
        assert.equal(snapshot.counters, null);
        assert.equal(snapshot.video.errorCode, 2);
        assert.equal(snapshot.video.currentTime, 4);
        assert.equal(snapshot.video.bufferAhead, 16);
        const serialized = JSON.stringify(snapshot);
        assert(!serialized.includes(secret));
        assert(!serialized.includes("provider.invalid"));
        assert(!serialized.includes("player.invalid"));
        assert(!serialized.includes("http"));
        assert.deepEqual(Object.keys(snapshot).sort(), [
            "available",
            "counters",
            "enabled",
            "video",
        ]);
        assert.equal(f.timers.size, 0);
        assert.equal(f.calls.length, 0);
    } finally {
        f.close();
    }
});

(async () => {
    let failed = 0;
    for (const { body, name } of tests) {
        try {
            await body();
            console.log("PASS " + name);
        } catch (error) {
            failed++;
            console.error("FAIL " + name + "\n" + error.stack);
        }
    }
    assert.equal(failed, 0, failed + " debug lifecycle test(s) failed");
    console.log("Debug lifecycle tests passed (" + tests.length + ").");
})().catch((error) => {
    console.error(error.stack);
    process.exitCode = 1;
});
