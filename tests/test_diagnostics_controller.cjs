const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const acorn = require("acorn");

function loadSource(file, dependencies) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    const code = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES5,
        },
    }).outputText;
    acorn.parse(code, { ecmaVersion: 5 });
    const context = {
        exports: {},
        require(name) {
            assert.ok(
                Object.prototype.hasOwnProperty.call(dependencies, name),
                name
            );
            return dependencies[name];
        },
        URL,
    };
    vm.runInNewContext(code, context, { filename: file });
    return context.exports;
}
const commandServer = loadSource("src/plugins/command-server.ts", {
    "../shared/wire-contracts": require("./load-wire.cjs")(),
});
const realRemote = loadSource("src/plugins/remote-diagnostics.ts", {
    "../shared/wire-contracts": require("./load-wire.cjs")(),
    "./diagnostic-buffer": loadSource("src/plugins/diagnostic-buffer.ts", {}),
});
const { installDiagnosticsController } = loadSource(
    "src/plugins/diagnostics-controller.ts",
    {
        "../commands/remote-restart": loadSource(
            "src/commands/remote-restart.ts",
            {
                "./remote-app-update": {
                    remoteAppUpdateAvailable: () => false,
                },
                "./remote-favorites-contract": loadSource(
                    "src/commands/remote-favorites-contract.ts",
                    {}
                ),
                "./remote-plex": loadSource("src/commands/remote-plex.ts", {}),
            }
        ),
        "./command-server": commandServer,
        "./diagnostics-permission": loadSource(
            "src/plugins/diagnostics-permission.ts",
            {}
        ),
        "./remote-diagnostics": {
            createRemoteDiagnostics() {
                throw new Error("Inject a client");
            },
        },
    }
);
const plain = (value) => JSON.parse(JSON.stringify(value));
const token = "device_" + "x".repeat(40);

function eventTarget() {
    const listeners = [];
    const removed = [];
    return {
        addEventListener(type, callback, capture) {
            listeners.push({ callback, capture, type });
        },
        dispatch(type) {
            listeners
                .slice()
                .filter((item) => item.type === type)
                .forEach((item) => item.callback());
        },
        listeners,
        removed,
        removeEventListener(type, callback, capture) {
            const index = listeners.findIndex(
                (item) =>
                    item.type === type &&
                    item.callback === callback &&
                    item.capture === capture
            );
            assert.ok(index >= 0, "remove only an owned listener");
            removed.push(listeners.splice(index, 1)[0]);
        },
    };
}
function harness(real = false, permissionStore, runtimeLabel) {
    let now = 100;
    let nextTimer = 0;
    let randomSequence = 0;
    const timers = new Map();
    const timerHistory = [];
    const document = Object.assign(eventTarget(), {
        hidden: false,
        visibilityState: "visible",
    });
    const w = Object.assign(eventTarget(), {
        clearTimeout(id) {
            timers.delete(id);
        },
        crypto: {
            getRandomValues(bytes) {
                bytes.fill(++randomSequence);
                return bytes;
            },
        },
        document,
        navigator: { onLine: true },
        performance: { now: () => now },
        setTimeout(callback, delay) {
            const timer = { at: now + delay, callback };
            timers.set(++nextTimer, timer);
            timerHistory.push(timer);
            return nextTimer;
        },
    });
    Object.defineProperty(w, "localStorage", {
        get() {
            throw new Error("Consent must not be persisted");
        },
    });
    const h = {
        advance(ms) {
            const target = now + ms;
            for (;;) {
                let next = null;
                for (const [id, timer] of timers)
                    if (
                        timer.at <= target &&
                        (!next || timer.at < next.timer.at)
                    )
                        next = { id, timer };
                if (!next) break;
                now = next.timer.at;
                timers.delete(next.id);
                next.timer.callback();
            }
            now = target;
        },
        captures: [],
        clients: [],
        config: {
            address: "https://control.example/ottplay",
            enabled: true,
            token,
        },
        getConfigCalls: 0,
        onConfigure: null,
        onFactory: null,
        onRelease: null,
        onStatus: null,
        rawSnapshot: {
            available: true,
            counters: { errors: 2 },
            enabled: true,
            video: { currentTime: 10, paused: false },
        },
        releaseCalls: 0,
        requests: [],
        setNow(value) {
            now = value;
        },
        snapshotCalls: 0,
        startCapture(index = h.clients.length - 1) {
            const current = h.clients[index];
            current.release = current.options.capture(
                (event) => current.events.push(plain(event)),
                () => current.captureStops++
            );
            return h.captures[h.captures.length - 1];
        },
        statuses: [],
        timerHistory,
        timers,
        w,
    };
    w.__ottDebug = {
        capture(event, stopped) {
            const capture = { active: true, event, stopped };
            h.captures.push(capture);
            return () => {
                h.releaseCalls++;
                capture.active = false;
                if (h.onRelease) h.onRelease(capture);
            };
        },
        snapshot() {
            h.snapshotCalls++;
            return h.rawSnapshot;
        },
    };
    h.controller = installDiagnosticsController(w, {
        clientFactory(options) {
            if (real) return realRemote.createRemoteDiagnostics(options);
            const current = {
                captureStops: 0,
                configs: [],
                configure(config) {
                    current.configs.push(plain(config));
                    options.onStatus({ runtimeId: "rt-1", state: "ready" });
                    if (h.onConfigure) h.onConfigure(current);
                },
                events: [],
                options,
                release: null,
                stop(reason) {
                    current.stops.push(reason);
                    if (current.release) current.release();
                    options.onStatus({ reason, state: "stopped" });
                },
                stops: [],
            };
            h.clients.push(current);
            if (h.onFactory) h.onFactory(current);
            return current;
        },
        getConfig() {
            h.getConfigCalls++;
            return h.config;
        },
        onStatus(status) {
            h.statuses.push(plain(status));
            if (h.onStatus) h.onStatus(status);
        },
        permissionStore,
        runtimeLabel,
        send(request, complete) {
            const entry = { canceled: false, complete, request };
            h.requests.push(entry);
            return () => {
                entry.canceled = true;
            };
        },
    });
    return h;
}
function stopped(h, message) {
    assert.equal(h.controller.status().enabled, false, message);
    assert.equal(h.timers.size, 0, "no remaining wrapper timers");
    assert.equal(h.w.listeners.length, 0, "no remaining window listeners");
    assert.equal(
        h.w.document.listeners.length,
        0,
        "no remaining document listeners"
    );
}
function test(name, body) {
    body();
    console.log("PASS " + name);
}

test("enabled connection auto-registers without separate permission or collection", () => {
    const h = harness();
    assert.equal(
        h.clients.length,
        0,
        "registration waits until settings commit returns"
    );
    h.advance(0);
    assert.equal(h.clients.length, 1);
    assert.equal(h.controller.status().enabled, true);
    assert.equal(h.controller.status().trusted, true);
    assert.equal(h.controller.status().pending, false);
    assert.match(
        h.controller.status().message,
        /Remote control authorizes diagnostics/
    );
    assert.equal(h.captures.length, 0);
    assert.equal(h.snapshotCalls, 0);
    assert.equal(h.clients[0].configs[0].token, token);
    assert.equal(
        h.clients[0].configs[0].address,
        "https://control.example/ottplay/api/webhook/commands"
    );
    assert.equal(h.controller.status().remainingMs, undefined);
    h.controller.subscribe((status) => {
        status.enabled = false;
        status.message = token;
    });
    assert.equal(h.controller.status().enabled, true);
    assert.ok(!JSON.stringify(h.statuses).includes(token));
    h.controller.subscribe(null);
    h.controller.stop();
    stopped(h);
});

test("disconnected or invalid connection cannot start diagnostics; HTTPS remains required", () => {
    for (const patch of [
        { enabled: false },
        { token: "short" },
        { address: "http://control.example" },
        { address: "https://user:secret@control.example" },
        { address: "https://control.example?token=secret" },
    ]) {
        const h = harness();
        Object.assign(h.config, patch);
        h.controller.configurationChanged(h.config);
        h.advance(0);
        assert.equal(h.clients.length, 0);
        assert.equal(h.controller.status().trusted, false);
        assert.ok(!JSON.stringify(h.statuses).includes("secret"));
        stopped(h);
    }
    for (const mutate of [
        (h) => delete h.w.__ottDebug.capture,
        (h) => delete h.w.__ottDebug.snapshot,
        (h) => delete h.w.performance,
        (h) => {
            h.w.performance.now = () => NaN;
        },
    ]) {
        const h = harness();
        mutate(h);
        h.advance(0);
        assert.equal(h.clients.length, 0);
        assert.equal(h.controller.status().state, "unavailable");
        h.controller.stop();
        stopped(h);
    }
});

test("legacy permissions, absent storage and storage failures cannot override connection authority", () => {
    for (const value of [
        null,
        {
            address: "https://old.example",
            revision: "old",
            token: "z".repeat(40),
        },
    ]) {
        const store = {
            available() {
                assert.fail("legacy availability must not be consulted");
            },
            read() {
                assert.fail("legacy grant or denial must not be read");
            },
            subscribe() {
                assert.fail("legacy notifications cannot control connection");
            },
            value,
            write() {
                assert.fail("no legacy profile mutation");
            },
        };
        const first = harness(false, store, "webos.1.2.3");
        first.advance(0);
        assert.equal(first.controller.status().trusted, true);
        assert.match(
            first.clients[0].configs[0].instanceId,
            /^webos\.1\.2\.3\./
        );
        first.advance(600001);
        assert.equal(
            first.controller.status().enabled,
            true,
            "connection authorization has no ten-minute expiry"
        );
        assert.equal(first.captures.length, 0);
        const reopened = harness(false, store);
        reopened.advance(0);
        assert.equal(
            reopened.clients.length,
            1,
            "reload restores only an idle runtime from connection config"
        );
        assert.equal(reopened.captures.length, 0);
        first.config.enabled = false;
        first.controller.configurationChanged(first.config);
        assert.equal(first.controller.status().trusted, false);
        first.controller.stop();
        reopened.controller.stop();
        stopped(first);
        stopped(reopened);
    }
});

test("local capture stop and legacy setters retain connection authority without reopening capture", () => {
    for (const method of ["stopSession", "setEnabled", "setTrusted"]) {
        const h = harness();
        h.advance(0);
        const current = h.clients[0];
        const capture = h.startCapture();
        current.options.onStatus({
            runtimeId: "rt-1",
            sessionId: "capture-1",
            state: "active",
            token,
        });
        assert.equal(h.controller.status().sessionId, "capture-1");
        h.controller[method](false);
        assert.equal(capture.active, false);
        assert.equal(h.releaseCalls, 1);
        assert.equal(h.controller.status().trusted, true);
        assert.equal(h.controller.status().sessionId, undefined);
        h.advance(0);
        assert.equal(h.clients.length, 2);
        assert.equal(h.captures.length, 1);
        assert.equal(h.controller.status().enabled, true);
        for (const key of ["consentEpoch", "instanceId", "bootId"])
            assert.notEqual(
                h.clients[1].configs[0][key],
                current.configs[0][key]
            );
        current.options.onStatus({ sessionId: "stale", state: "active" });
        assert.equal(h.controller.status().sessionId, undefined);
        assert.deepEqual(plain(current.options.snapshot()), {});
        h.controller.stop();
        stopped(h);
    }
});

test("background diagnostics remains available; OS suspension and offline retire and resume automatically", () => {
    const background = harness();
    background.advance(0);
    background.startCapture();
    background.w.document.visibilityState = "hidden";
    background.w.document.hidden = true;
    background.w.document.dispatch("visibilitychange");
    background.advance(1000);
    assert.equal(background.controller.status().enabled, true);
    assert.equal(background.captures[0].active, true);
    assert.equal(
        plain(background.clients[0].options.snapshot()).available,
        true
    );
    background.controller.stop();
    stopped(background);
    for (const [event, resume, target] of [
        ["freeze", "resume", "document"],
        ["pagehide", "pageshow", "window"],
        ["offline", "online", "window"],
    ]) {
        const h = harness();
        h.advance(0);
        const first = h.clients[0];
        const capture = h.startCapture();
        if (event === "offline") h.w.navigator.onLine = false;
        (target === "document" ? h.w.document : h.w).dispatch(event);
        assert.equal(h.controller.status().enabled, false);
        assert.equal(h.controller.status().trusted, true);
        assert.equal(capture.active, false);
        assert.equal(h.timers.size, 0);
        h.w.navigator.onLine = true;
        (target === "document" ? h.w.document : h.w).dispatch(resume);
        h.advance(0);
        assert.equal(h.clients.length, 2);
        assert.equal(h.captures.length, 1);
        assert.notEqual(
            first.configs[0].consentEpoch,
            h.clients[1].configs[0].consentEpoch
        );
        first.options.onStatus({ sessionId: "old", state: "active" });
        assert.equal(h.controller.status().sessionId, undefined);
        h.controller.stop();
        stopped(h);
    }
});

test("config rotation retires old capture and stale requests before starting new authority", () => {
    for (const patch of [
        { address: "https://other.example" },
        { token: "z".repeat(40) },
        { enabled: false },
    ]) {
        const h = harness();
        h.advance(0);
        h.startCapture();
        const old = h.clients[0];
        const request = {
            headers: {},
            method: "POST",
            timeoutMs: 4000,
            url: "https://control.example/diagnostics",
        };
        let replies = 0;
        old.options.send(request, () => replies++);
        Object.assign(h.config, patch);
        h.controller.configurationChanged(h.config);
        assert.equal(h.captures[0].active, false);
        h.requests[0].complete({ body: "{}", status: 200 });
        assert.equal(replies, 0);
        old.options.send(request, () => replies++);
        assert.equal(h.requests.length, 1);
        old.options.capture(() => assert.fail("stale events"));
        assert.deepEqual(plain(old.options.snapshot()), {});
        h.advance(0);
        assert.equal(h.clients.length, patch.enabled === false ? 1 : 2);
        if (patch.enabled !== false)
            assert.equal(h.clients[1].configs[0].token, h.config.token);
        h.controller.stop();
        stopped(h);
    }
});

test("silent config change invalidates response, event, repair and timer boundaries", () => {
    for (const trigger of ["response", "event", "repair", "timer"]) {
        const h = harness();
        h.advance(0);
        const old = h.clients[0];
        const capture = h.startCapture();
        let replies = 0;
        old.options.send(
            {
                headers: {},
                method: "POST",
                timeoutMs: 4000,
                url: "https://control.example/diagnostics",
            },
            () => replies++
        );
        let reloads = 0;
        let effect;
        h.w.restart = () => reloads++;
        old.options.executeRepair(
            "reload_player",
            () => {},
            (fn) => (effect = fn)
        );
        h.config.token = "n".repeat(40);
        if (trigger === "response")
            h.requests[0].complete({ body: "{}", status: 200 });
        if (trigger === "event")
            capture.event({ cat: "video", msg: "playing" });
        if (trigger === "repair") effect();
        if (trigger === "timer") h.advance(1000);
        assert.equal(replies, 0);
        assert.equal(reloads, 0);
        assert.equal(capture.active, false);
        assert.equal(old.events.length, 0);
        h.advance(0);
        assert.equal(h.clients.length, 2);
        assert.equal(h.clients[1].configs[0].token, h.config.token);
        h.controller.stop();
        stopped(h);
    }
});

test("equivalent config is stable and disconnect cancels a pending startup or reconnect", () => {
    const h = harness();
    h.advance(0);
    h.controller.configurationChanged({
        ...h.config,
        address: "https://control.example/ottplay/api/webhook/commands",
    });
    h.advance(0);
    assert.equal(h.clients.length, 1);
    h.clients[0].options.onStatus({
        reason: "disconnected",
        state: "regrant_required",
    });
    assert.equal(h.controller.status().trusted, true);
    h.advance(999);
    assert.equal(h.clients.length, 1);
    h.advance(1);
    assert.equal(h.clients.length, 2);
    h.clients[1].options.onStatus({
        reason: "server_restarted",
        state: "regrant_required",
    });
    h.config.enabled = false;
    h.controller.configurationChanged(h.config);
    h.advance(600000);
    assert.equal(h.clients.length, 2);
    stopped(h);
    const pending = harness();
    pending.config.enabled = false;
    pending.controller.configurationChanged(pending.config);
    pending.advance(0);
    assert.equal(pending.clients.length, 0);
    stopped(pending);
});

test("stale startup and reconnect timers cannot steal a newer connection's cancellation", () => {
    const h = harness();
    const stale = h.timerHistory[0].callback;
    h.config.token = "j".repeat(40);
    h.controller.configurationChanged(h.config);
    stale();
    h.config.enabled = false;
    h.controller.configurationChanged(h.config);
    assert.equal(h.timers.size, 0);
    h.advance(0);
    assert.equal(h.clients.length, 0);
    stopped(h);
    const ready = harness();
    ready.advance(0);
    ready.clients[0].options.onStatus({
        reason: "disconnected",
        state: "error",
    });
    const old = ready.timerHistory[ready.timerHistory.length - 1].callback;
    ready.controller.setEnabled(true);
    old();
    assert.equal(
        ready.clients.length,
        1,
        "canceled backoff cannot start runtime early"
    );
    ready.advance(0);
    assert.equal(ready.clients.length, 2);
    ready.controller.stop();
    stopped(ready);
});

test("clock failure and unsupported environment stop capture without reflecting arbitrary server errors", () => {
    for (const value of [0, NaN, Infinity]) {
        const h = harness();
        h.advance(0);
        h.startCapture();
        h.setNow(value);
        h.clients[0].options.snapshot();
        assert.equal(h.controller.status().state, "unavailable");
        assert.equal(h.captures[0].active, false);
        assert.equal(h.clients[0].stops[0], "unsupported");
        h.controller.stop();
        stopped(h);
    }
    const h = harness();
    h.advance(0);
    h.startCapture();
    h.clients[0].options.onStatus({ reason: token, state: "error" });
    assert.ok(!JSON.stringify(h.statuses).includes(token));
    assert.equal(h.captures[0].active, false);
    h.controller.stop();
    stopped(h);
    const local = harness();
    local.advance(0);
    local.startCapture().stopped();
    assert.equal(local.releaseCalls, 1);
    assert.equal(local.clients[0].captureStops, 1);
    assert.equal(local.controller.status().trusted, true);
    local.advance(0);
    assert.equal(local.clients.length, 2);
    local.controller.stop();
    stopped(local);
});
test("event and snapshot allowlists copy each field once without raw data", () => {
    const h = harness();
    h.controller.setEnabled(true);
    h.advance(0);
    const capture = h.startCapture();
    let reads = 0;
    const data = {
        code: -1,
        size: Infinity,
        status: 503,
        url: "https://private.example/" + token,
    };
    Object.defineProperty(data, "loadMs", {
        get() {
            return ++reads === 1 ? 12 : token;
        },
    });
    capture.event({ cat: "hls", data, msg: "FRAG_LOADED", stack: token });
    assert.deepEqual(h.clients[0].events, [
        { cat: "hls", data: { loadMs: 12, status: 503 }, msg: "FRAG_LOADED" },
    ]);
    assert.equal(reads, 1);
    capture.event({ cat: "video", data: { code: 3 }, msg: token });
    capture.event({ cat: "private", data: { code: 3 }, msg: "error" });
    assert.equal(h.clients[0].events.length, 1);
    const counters = { errors: 2, provider: token, recoveries: NaN };
    Object.defineProperty(counters, "dropped", {
        get() {
            throw new Error(token);
        },
    });
    const video = {
        currentTime: 9,
        ended: true,
        paused: false,
        source: token,
        videoWidth: 1920,
    };
    let pauseReads = 0;
    Object.defineProperty(video, "paused", {
        get() {
            pauseReads++;
            return pauseReads === 1 ? false : token;
        },
    });
    h.rawSnapshot = {
        available: true,
        counters,
        enabled: true,
        url: token,
        video,
    };
    assert.deepEqual(plain(h.clients[0].options.snapshot()), {
        available: true,
        counters: { errors: 2 },
        enabled: true,
        video: { currentTime: 9, ended: true, paused: false, videoWidth: 1920 },
    });
    assert.equal(pauseReads, 1);
    h.controller.stop();
    capture.event({ cat: "video", data: { code: 3 }, msg: "error" });
    assert.equal(h.clients[0].events.length, 1);
});

test("available platform adapters only report observed safe metrics", () => {
    const h = harness();
    h.w.__ottDebugInputSnapshot = () => ({
        available: true,
        click: 4,
        down: 3,
        enabled: true,
        key: token,
        move: 2,
        wheel: 5,
    });
    h.w.__ottHostedEpg = {
        remoteSnapshot() {
            return {
                available: true,
                enabled: false,
                phase: "error",
                url: token,
            };
        },
    };
    h.controller.setEnabled(true);
    h.advance(0);
    const options = h.clients[0].options;
    assert.deepEqual(plain(options.capabilities), [
        "playback",
        "network",
        "input",
        "epg",
    ]);
    assert.deepEqual(plain(options.inputSnapshot()), {
        available: true,
        enabled: true,
        inputEvents: 14,
    });
    assert.deepEqual(plain(options.epgSnapshot()), {
        available: true,
        enabled: false,
    });
    h.w.__ottDebugInputSnapshot = () => ({
        available: true,
        click: 4,
        down: null,
        enabled: true,
        move: 2,
        wheel: 5,
    });
    assert.deepEqual(plain(options.inputSnapshot()), {
        available: true,
        enabled: true,
    });
    h.w.__ottDebugInputSnapshot = () => ({
        available: true,
        click: 0,
        down: 1,
        enabled: true,
        move: Number.MAX_SAFE_INTEGER,
        wheel: 0,
    });
    assert.deepEqual(plain(options.inputSnapshot()), {
        available: true,
        enabled: true,
    });
    h.controller.stop();
    assert.deepEqual(plain(options.inputSnapshot()), {});
    assert.deepEqual(plain(options.epgSnapshot()), {});
});

test("cleanup reentry and stale callbacks cannot destroy a fresh grant", () => {
    const h = harness();
    h.controller.setEnabled(true);
    h.advance(0);
    h.startCapture();
    const oldTimer = h.timerHistory[0].callback;
    const oldHandlers = [...h.w.listeners, ...h.w.document.listeners].map(
        (value) => value.callback
    );
    let reentered = false;
    h.onRelease = () => {
        if (!reentered) {
            reentered = true;
            h.controller.setEnabled(true);
            h.advance(0);
        }
    };
    h.controller.stop();
    assert.equal(h.clients.length, 2);
    assert.deepEqual(h.clients[0].stops, ["local_stop"]);
    assert.deepEqual(h.clients[1].stops, []);
    assert.equal(h.controller.status().enabled, true);
    assert.equal(h.timers.size, 1);
    oldTimer();
    oldHandlers.forEach((handler) => handler());
    assert.equal(h.controller.status().enabled, true);
    assert.equal(h.timers.size, 1);
    h.clients[0].options.onStatus({ state: "regrant_required" });
    assert.equal(h.controller.status().enabled, true);
    h.controller.stop();
    stopped(h);
});

test("synchronous factory and capture callbacks cannot leave an orphan client", () => {
    const h = harness();
    h.onFactory = () => h.controller.stop();
    h.controller.setEnabled(true);
    h.advance(0);
    stopped(h);
    assert.equal(h.clients.length, 1);
    assert.deepEqual(h.clients[0].stops, ["consent_revoked"]);
    const next = harness();
    next.w.__ottDebug.capture = (_event, stop) => {
        stop();
        return () => next.releaseCalls++;
    };
    next.onConfigure = (client) => {
        if (client === next.clients[0]) next.startCapture();
    };
    next.controller.setEnabled(true);
    next.advance(0);
    assert.equal(next.controller.status().enabled, true);
    assert.equal(next.controller.status().trusted, true);
    assert.equal(next.clients.length, 2);
    next.controller.stop();
    stopped(next);
    assert.equal(next.releaseCalls, 1);
    const reentrant = harness();
    reentrant.onConfigure = (current) => {
        if (current !== reentrant.clients[0]) return;
        reentrant.controller.stop();
        reentrant.controller.setEnabled(true);
        reentrant.advance(0);
        throw new Error("Old configure failed after a fresh grant");
    };
    reentrant.controller.setEnabled(true);
    reentrant.advance(0);
    assert.equal(reentrant.controller.status().enabled, true);
    assert.equal(reentrant.clients.length, 2);
    assert.equal(reentrant.clients[1].stops.length, 0);
    reentrant.controller.stop();
    stopped(reentrant);
});

test("real transport sends only bounded consent revocation after wrapper cleanup", () => {
    const runtime = "2".repeat(32);
    const serverEpoch = "1".repeat(32);
    const runtimeToken = "runtime_" + "r".repeat(36);
    const envelope = (value) => ({
        diagnostics_protocol: 2,
        server_epoch: serverEpoch,
        ...value,
    });
    for (const reason of ["stop", "configuration"]) {
        const h = harness(true);
        assert.equal(h.requests.length, 0);
        h.controller.setEnabled(true);
        h.advance(0);
        const registration = h.requests[0];
        const consent = JSON.parse(registration.request.body).consent;
        assert.equal(
            registration.request.url,
            "https://control.example/ottplay/api/v2/diagnostics/runtimes"
        );
        registration.complete({
            body: JSON.stringify(
                envelope({
                    device_id: "test-device",
                    limits: {
                        event_bytes_max: 1024,
                        events_body_bytes: 16384,
                        events_per_batch: 32,
                        poll_after_ms: 3000,
                        session_lease_ms_max: 600000,
                    },
                    runtime_credential: runtimeToken,
                    runtime_id: runtime,
                    runtime_ttl_ms: 600000,
                })
            ),
            status: 201,
        });
        h.advance(0);
        const poll = h.requests[h.requests.length - 1];
        assert.equal(poll.request.url.endsWith("/poll"), true);
        poll.complete({
            body: JSON.stringify(
                envelope({
                    control: {
                        action: "start",
                        consent_epoch: consent.epoch,
                        lease_ms: 60000,
                        profile: "standard",
                        request_id: "3".repeat(32),
                        session_id: "4".repeat(32),
                    },
                    control_revision: 1,
                    poll_after_ms: 1000,
                    runtime_id: runtime,
                })
            ),
            status: 200,
        });
        const result = h.requests[h.requests.length - 1];
        assert.equal(result.request.url.endsWith("/results"), true);
        result.complete({
            body: JSON.stringify(envelope({ status: "recorded" })),
            status: 200,
        });
        h.advance(0);
        assert.equal(h.controller.status().state, "active");
        assert.equal(h.captures.length, 1);
        const count = h.requests.length;
        if (reason === "stop") h.controller.stop();
        if (reason === "configuration") {
            h.config.enabled = false;
            h.controller.configurationChanged(h.config);
        }
        assert.equal(h.controller.status().enabled, false);
        assert.equal(h.captures[0].active, false);
        assert.equal(h.releaseCalls, 1);
        assert.equal(h.w.listeners.length, 0);
        assert.equal(h.w.document.listeners.length, 0);
        assert.equal(
            h.requests.length,
            count + 1,
            reason + " must notify the original controller"
        );
        const revoke = h.requests[h.requests.length - 1];
        assert.equal(
            revoke.request.url,
            "https://control.example/ottplay/api/v2/diagnostics/poll"
        );
        assert.equal(
            revoke.request.headers.Authorization,
            "Bearer " + runtimeToken
        );
        assert.deepEqual(JSON.parse(revoke.request.body), {
            consent: { granted: false },
            last_control_revision: 1,
            poll_seq: 2,
            runtime_id: runtime,
        });
        assert.equal(revoke.request.timeoutMs, 1000);
        assert.equal(
            h.timers.size,
            1,
            "only bounded independent revoke timeout survives"
        );
        h.advance(1000);
        stopped(h);
        assert.equal(revoke.canceled, true);
        revoke.complete({
            body: JSON.stringify(
                envelope({
                    control: null,
                    control_revision: 2,
                    poll_after_ms: 1000,
                    runtime_id: runtime,
                })
            ),
            status: 200,
        });
        h.advance(600000);
        assert.equal(
            h.requests.length,
            count + 1,
            "late response cannot retry or restore consent"
        );
        assert.equal(h.controller.status().enabled, false);
    }
});

test("repair adapter preserves backend ownership, ACK and local cancellation guards", () => {
    const h = harness();
    h.advance(0);
    const options = h.clients[0].options;
    const replies = [];
    options.executeRepair(
        "restart_stream",
        (value) => replies.push(value),
        () => assert.fail("stream has no deferred effect")
    );
    assert.deepEqual(replies, ["unsupported"]);
    let restarted = 0;
    const play = () => {};
    h.w.stbPlay = play;
    h.w.__ottCoreTransport = { play };
    h.w.__ottCoreBackend = () => ({
        restart: () => {
            restarted++;
            return { safe: true };
        },
    });
    options.executeRepair(
        "restart_stream",
        (value) => replies.push(value),
        () => {}
    );
    assert.equal(restarted, 1);
    assert.equal(replies[1], "applied");
    let reloads = 0;
    let effect;
    h.w.restart = () => reloads++;
    const cancel = options.executeRepair(
        "reload_player",
        (value) => replies.push(value),
        (callback) => {
            effect = callback;
        }
    );
    assert.equal(reloads, 0);
    assert.equal(replies[2], "accepted");
    cancel();
    effect();
    assert.equal(reloads, 0, "canceled receipt must not reload");
    options.executeRepair(
        "reload_player",
        (value) => replies.push(value),
        (callback) => {
            effect = callback;
        }
    );
    effect();
    assert.equal(reloads, 1);
    options.executeRepair(
        "reload_player",
        () => {},
        (callback) => {
            effect = callback;
        }
    );
    h.controller.stop();
    effect();
    assert.equal(reloads, 1, "old runtime may not reload after local stop");
});

console.log("diagnostics controller tests passed");
