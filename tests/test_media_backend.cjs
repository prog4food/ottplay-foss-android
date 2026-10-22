const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const load = require("./helpers/private-runtime.cjs");
function fixture() {
    const context = vm.createContext({ console });
    context.window = context;
    for (const file of ["adapter", "media-backend", "media-session"])
        load(context, "src/device/" + file + ".ts");
    let domain = { generation: 1, kind: "vod", position: 0 };
    const commands = [],
        leases = [],
        timers = [];
    const ports = {
        clearInterval(id) {
            timers[id].active = false;
        },
        context: () => domain,
        emit(c, type, position, duration) {
            commands.push({
                duration,
                generation: c.generation,
                position,
                type,
            });
        },
        open(request, event) {
            const sample = {
                duration: 500,
                paused: true,
                position: 0,
                ready: 0,
            };
            const lease = {
                disposed: 0,
                event,
                request,
                sample,
                selections: [],
            };
            leases.push(lease);
            return {
                diagnosticAttempt: () => lease.attempt || null,
                diagnosticEngine: () => lease.engine || null,
                dispose() {
                    lease.disposed++;
                    if (lease.onDispose) lease.onDispose();
                },
                pause() {
                    sample.paused = true;
                    event("pause");
                },
                resume() {
                    sample.paused = false;
                    event("playing");
                },
                sample: () => sample,
                seek(value) {
                    sample.position = value;
                },
                selectTrack(kind, index) {
                    lease.selections.push([kind, index]);
                },
                tracks: () => [{ id: 0 }],
            };
        },
        setInterval(callback) {
            timers.push({ active: true, callback });
            return timers.length - 1;
        },
    };
    const backend = context.__ottMediaBackend.create(ports);
    return {
        backend,
        commands,
        context,
        domain(value) {
            domain = value;
        },
        leases,
        playing(index = 0, position = 0) {
            Object.assign(leases[index].sample, {
                paused: false,
                position,
                ready: 2,
            });
            leases[index].event("playing");
        },
        ports,
        timers,
    };
}
let passed = 0;
function test(name, run) {
    const f = fixture();
    try {
        run(f);
        console.log("PASS media backend: " + name);
        passed++;
    } finally {
        f.backend.dispose();
    }
}
test("a decoder lease and its timer retire once; old events cannot update replacement", (f) => {
    const old = f.backend.open({ url: "old" });
    f.playing();
    const stale = f.leases[0].event;
    const next = f.backend.open({ url: "new" });
    const before = f.commands.length;
    stale("playing");
    stale("timeupdate");
    old.pause();
    old.seek(80);
    old.dispose();
    assert.equal(f.commands.length, before);
    assert.equal(f.leases[0].disposed, 1);
    assert.equal(old.active(), false);
    assert.equal(next.active(), true);
    assert.equal(f.timers[0].active, false);
});
test("archive uses measured media delta, not wall ticks or buffering elapsed time", (f) => {
    f.domain({ generation: 1, kind: "archive", position: 15 });
    const h = f.backend.open({ url: "archive" });
    f.playing(0, 1200);
    assert.equal(h.snapshot().position, 15);
    for (let i = 0; i < 12; i++) f.timers[0].callback();
    assert.equal(h.snapshot().position, 15);
    f.leases[0].sample.position = 1203.5;
    f.leases[0].event("timeupdate");
    assert.equal(h.snapshot().position, 18.5);
    h.pause();
    f.timers[0].callback();
    assert.equal(h.snapshot().position, 18.5);
});
test("seek rebinds the existing decoder to the new archive generation", (f) => {
    f.domain({
        generation: 1,
        kind: "archive",
        position: 0,
        sourceActive: () => true,
    });
    const h = f.backend.open({ url: "archive" });
    f.playing(0, 100);
    f.domain({ generation: 2, kind: "archive", position: 20 });
    h.seek(999); // escaped handles cannot adopt a new generation
    assert.equal(f.leases[0].sample.position, 100);
    f.backend.seek(120); // explicit same-source device ingress
    f.leases[0].sample.position = 124;
    f.leases[0].event("timeupdate");
    assert.equal(h.snapshot().position, 24);
    assert.equal(f.commands.at(-1).generation, 2);
});
test("a source generation change rejects old backend observations", (f) => {
    f.backend.open({ url: "first" });
    f.playing();
    const before = f.commands.length;
    f.domain({ generation: 2, kind: "live", position: 0 });
    f.leases[0].sample.position = 50;
    f.leases[0].event("timeupdate");
    assert.equal(f.commands.length, before);
});
test("natural completion is emitted once and late playing cannot revive the ended lease", (f) => {
    const events = [];
    f.backend.subscribe((event) => events.push(event.type));
    const handle = f.backend.open({ url: "episode" });
    f.playing();
    f.leases[0].event("ended");
    const before = f.commands.length;
    f.leases[0].event("playing");
    f.leases[0].event("pause");
    f.leases[0].event("ended");
    f.leases[0].event("timeupdate");
    assert.equal(f.commands.length, before);
    assert.equal(f.commands.at(-1).type, "ended");
    assert.equal(events.filter((type) => type === "ended").length, 1);
    assert.equal(handle.snapshot().phase, "stopped");
    assert(f.timers.every((timer) => !timer.active));
});
test("manual stop, replacement and retired source generations never emit natural completion", (f) => {
    const completed = [];
    f.backend.subscribe((event) => {
        if (event.type === "ended") completed.push(event.id);
    });
    f.backend.open({ url: "manual stop" });
    f.playing();
    f.backend.stop();
    f.leases[0].event("ended");
    f.backend.open({ url: "replaced" });
    f.playing(1);
    f.backend.open({ url: "different generation" });
    f.playing(2);
    f.leases[1].event("ended");
    f.domain({ generation: 2, kind: "vod", position: 0 });
    f.leases[2].event("ended");
    let active = true;
    f.domain({ active: () => active, generation: 3, kind: "vod", position: 0 });
    f.backend.open({ url: "retired source" });
    f.playing(3);
    active = false;
    f.leases[3].event("ended");
    assert.deepEqual(completed, []);
    assert.equal(
        f.commands.filter((command) => command.type === "ended").length,
        0
    );
});
test("decoder error stops reporting play without blocking valid in-place recovery", (f) => {
    const events = [];
    f.backend.subscribe((event) => events.push(event.type));
    const first = f.backend.open({ url: "failed" });
    f.playing();
    f.leases[0].event("error");
    assert.equal(first.snapshot().phase, "loading");
    assert.equal(f.commands.at(-1).type, "loading");
    assert(f.timers.every((timer) => !timer.active));
    const count = f.commands.length;
    for (const type of ["timeupdate", "ended", "error"])
        f.leases[0].event(type);
    assert.equal(f.commands.length, count);
    assert.equal(events.filter((type) => type === "error").length, 1);
    assert.equal(events.includes("ended"), false);
    f.leases[0].sample.ready = 0;
    f.leases[0].event("playing");
    assert.equal(
        first.snapshot().phase,
        "loading",
        "Unready events do not recover playback"
    );
    f.playing();
    assert.equal(first.snapshot().phase, "playing");
    const next = f.backend.open({ url: "next" });
    f.playing(1);
    f.leases[0].event("error");
    assert.equal(next.snapshot().phase, "playing");
    f.domain({ generation: 2, kind: "vod", position: 0 });
    const before = f.commands.length;
    f.leases[1].event("error");
    assert.equal(
        f.commands.length,
        before,
        "Retired domain cannot report an error"
    );
});

for (const operation of ["seek", "resume"]) {
    test(
        "ready " + operation + " recovery permits natural completion again",
        (f) => {
            const open = f.ports.open;
            f.ports.open = (request, event) => {
                const engine = open(request, event);
                // Real play() may resolve asynchronously, with no immediate playing event.
                engine.resume = () => {
                    f.leases[0].sample.paused = false;
                };
                return engine;
            };
            const handle = f.backend.open({ url: "recoverable" });
            f.playing();
            f.leases[0].event("error");
            assert.equal(handle.snapshot().phase, "loading");
            handle[operation](20);
            assert.equal(handle.snapshot().phase, "playing");
            assert.equal(f.timers.filter((timer) => timer.active).length, 1);
            f.leases[0].event("ended");
            f.leases[0].event("ended");
            assert.equal(handle.snapshot().phase, "stopped");
            assert.equal(
                f.commands.filter((command) => command.type === "ended").length,
                1,
                "Recovered source completes exactly once"
            );
        }
    );
}

test("unready resume cannot report recovery before the decoder is ready", (f) => {
    const handle = f.backend.open({ url: "recovering" });
    f.playing();
    f.leases[0].event("error");
    Object.assign(f.leases[0].sample, { paused: true, ready: 0 });
    const before = f.commands.length;
    handle.resume();
    assert.equal(handle.snapshot().phase, "loading");
    assert.equal(
        f.commands
            .slice(before)
            .some((command) => ["playing", "resume"].includes(command.type)),
        false
    );
    assert(f.timers.every((timer) => !timer.active));
    f.leases[0].event("ended");
    assert.equal(
        f.commands.some((command) => command.type === "ended"),
        false
    );
    f.playing();
    f.leases[0].event("ended");
    assert.equal(handle.snapshot().phase, "stopped");
    assert.equal(
        f.commands.filter((command) => command.type === "ended").length,
        1
    );
});

function coreBridge(f, kind = "vod") {
    const file = "src/core/index.ts";
    const source = ts.createSourceFile(
        file,
        fs.readFileSync(path.join(__dirname, "..", file), "utf8"),
        ts.ScriptTarget.Latest,
        true
    );
    const code = source.statements
        .filter(
            (node) =>
                ts.isFunctionDeclaration(node) &&
                ["getCoreMediaBackend", "stbStop", "stbIsStandby"].includes(
                    node.name?.text
                )
        )
        .map((node) => node.getText(source).replace(/^export /, ""))
        .join("\n");
    load(f.context, "src/playback/session.ts");
    const state = f.context.__ottPlaybackSession.createState(() => {});
    function select(nextKind = kind) {
        state.open({
            channelId: "episode",
            kind: nextKind,
            sourceId: "series",
        });
    }
    select();
    const calls = [];
    Object.assign(f.context, {
        __ottClassicPlayback: {
            cancel: () => calls.push("cancel-playback"),
            command(command) {
                if (
                    command.generation !== undefined &&
                    command.generation !== state.snapshot().generation
                )
                    return;
                calls.push(command.type);
                if (command.type === "position")
                    state.position(command.position, command.duration);
                else
                    state.phase(
                        command.type === "stop" ? "stopped" : command.type
                    );
            },
            context() {
                const generation = state.snapshot().generation;
                return {
                    isCurrentBackend: () =>
                        generation === state.snapshot().generation,
                    isCurrentSource: () => true,
                };
            },
            snapshot: state.snapshot,
        },
        __ottMedia: {
            cancelAuto: () => calls.push("cancel-auto"),
            ended(generation) {
                assert.equal(state.snapshot().phase, "stopped");
                assert.equal(state.snapshot().generation, generation);
                calls.push("ended:" + generation);
            },
        },
        _standby: false,
        clearInterval: f.ports.clearInterval,
        coreMediaBackend: null,
        openCoreEngineLease: f.ports.open,
        setInterval: f.ports.setInterval,
    });
    vm.runInContext(
        ts.transpileModule(code, {
            compilerOptions: { target: ts.ScriptTarget.ES5 },
        }).outputText,
        f.context
    );
    f.backend = f.context.getCoreMediaBackend();
    return { calls, select, state };
}
test("actual core bridge commits stop before VOD completion and manual Stop cancels pending advance", (f) => {
    const { calls, state } = coreBridge(f);
    f.backend.open({ url: "episode" });
    f.playing();
    const expected = state.snapshot().generation + 1;
    f.leases[0].event("ended");
    assert.deepEqual(calls.slice(-2), ["stop", "ended:" + expected]);
    assert.equal(
        calls.includes("cancel-auto"),
        false,
        "natural completion is not an explicit Stop"
    );
    f.context.stbStop();
    assert.deepEqual(calls.slice(-3), [
        "cancel-auto",
        "cancel-playback",
        "stop",
    ]);
    assert.equal(
        state.snapshot().generation,
        expected,
        "already-stopped playback keeps its generation"
    );
    f.leases[0].event("ended");
    assert.equal(calls.filter((call) => call.startsWith("ended:")).length, 1);
});
test("core completion bridge excludes live, archive, PiP and stale VOD", (f) => {
    const { calls, select } = coreBridge(f, "live");
    f.backend.open({ url: "live" });
    f.playing();
    f.leases[0].event("ended");
    select("archive");
    f.backend.open({ url: "archive" });
    f.playing(1);
    f.leases[1].event("ended");
    select("vod");
    f.backend.open({ url: "old VOD" });
    f.playing(2);
    select("vod");
    f.leases[2].event("ended");
    f.backend.open({ lane: "pip", url: "PiP" });
    f.playing(3);
    f.leases[3].event("ended");
    assert.equal(calls.filter((call) => call.startsWith("ended:")).length, 0);
});
test("synchronous next-episode startup survives the prior decoder's completion", (f) => {
    const { calls, select, state } = coreBridge(f);
    let next;
    f.context.__ottMedia.ended = (generation) => {
        assert.equal(state.snapshot().generation, generation);
        assert.equal(state.snapshot().phase, "stopped");
        select();
        next = f.backend.open({ url: "episode 2" });
        f.playing(1);
    };
    const old = f.backend.open({ url: "episode 1" });
    f.playing();
    f.leases[0].event("ended");
    assert.equal(old.active(), false);
    assert.equal(f.leases[0].disposed, 1);
    assert.equal(next.active(), true);
    assert.equal(state.snapshot().phase, "playing");
    const before = calls.length;
    f.leases[0].event("ended");
    f.leases[0].event("playing");
    assert.equal(calls.length, before);
    assert.equal(next.snapshot().phase, "playing");
});
test("PiP and main have isolated disposal and track selection guards", (f) => {
    const main = f.backend.open({ url: "main" });
    const pip = f.backend.open({ lane: "pip", url: "pip" });
    main.selectTrack("audio", 2);
    assert.deepEqual(f.leases[0].selections, [["audio", 2]]);
    f.backend.stop("pip");
    assert.equal(main.active(), true);
    assert.equal(pip.active(), false);
    f.backend.open({ url: "replacement" });
    main.selectTrack("audio", 1);
    assert.equal(f.leases[0].selections.length, 1);
});
test("cleanup reentry keeps the latest requested handle and avoids abandoned engine startup", (f) => {
    f.backend.open({ url: "A" });
    f.leases[0].onDispose = () => f.backend.open({ url: "C" });
    const abandoned = f.backend.open({ url: "B" });
    assert.equal(abandoned.active(), false);
    assert.deepEqual(
        f.leases.map((x) => x.request.url),
        ["A", "C"]
    );
});
test("loading command reentry cannot start a retired request", (f) => {
    const emit = f.ports.emit;
    let replaced = false;
    f.ports.emit = (...args) => {
        emit(...args);
        if (!replaced) {
            replaced = true;
            f.backend.open({ url: "latest" });
        }
    };
    const abandoned = f.backend.open({ url: "old" });
    assert.equal(abandoned.active(), false);
    assert.deepEqual(
        f.leases.map((x) => x.request.url),
        ["latest"]
    );
});
test("snapshot is a pure value read without engine sampling or domain writes", (f) => {
    const h = f.backend.open({ url: "one" });
    f.playing(0, 10);
    const count = f.commands.length;
    f.leases[0].sample.position = 99;
    assert.equal(h.snapshot().position, 10);
    assert.equal(f.commands.length, count);
    const snapshot = h.snapshot();
    snapshot.position = 900;
    assert.equal(h.snapshot().position, 10);
});
test("OS observer subscribes once and stale refresh cannot update new media", (f) => {
    const calls = [],
        jobs = [];
    const observer = f.context.__ottOsMediaSession.create({
        backend: f.backend,
        clearInterval(id) {
            jobs[id].active = false;
        },
        clearTimeout(id) {
            jobs[id].active = false;
        },
        metadata: () => ({ seekable: true }),
        send(type) {
            calls.push(type);
        },
        setInterval(callback) {
            jobs.push({ active: true, callback });
            return jobs.length - 1;
        },
        setTimeout(callback) {
            jobs.push({ active: true, callback });
            return jobs.length - 1;
        },
    });
    const h = f.backend.open({ url: "first" });
    const stale = jobs[0].callback;
    f.playing();
    h.pause();
    h.resume();
    f.backend.open({ url: "second" });
    const count = calls.length;
    stale();
    assert.equal(calls.length, count);
    assert.deepEqual(calls.slice(0, 4), ["start", "pause", "resume", "stop"]);
    observer.dispose();
    f.backend.stop();
    assert.equal(calls.length, count);
    assert(jobs.every((x) => !x.active));
});
test("native pause and playing events resume OS metadata exactly once", (f) => {
    const calls = [],
        jobs = [];
    const schedule = (callback) => {
        jobs.push({ active: true, callback });
        return jobs.length - 1;
    };
    const cancel = (id) => {
        jobs[id].active = false;
    };
    const observer = f.context.__ottOsMediaSession.create({
        backend: f.backend,
        clearInterval: cancel,
        clearTimeout: cancel,
        metadata: () => ({ seekable: true }),
        send: (type) => calls.push(type),
        setInterval: schedule,
        setTimeout: schedule,
    });
    const handle = f.backend.open({ url: "native" });
    f.playing();
    f.leases[0].sample.paused = true;
    f.leases[0].event("pause");
    assert(jobs.every((job) => !job.active));
    f.playing();
    assert.deepEqual(calls, ["start", "pause", "resume"]);
    assert.equal(jobs.filter((job) => job.active).length, 1);
    handle.pause();
    handle.resume();
    assert.deepEqual(calls, ["start", "pause", "resume", "pause", "resume"]);
    assert.equal(jobs.filter((job) => job.active).length, 1);
    observer.dispose();
});
test("a retired source rejects observations and captured track/control callbacks before the next generation", (f) => {
    let active = true;
    f.domain({ active: () => active, generation: 1, kind: "vod", position: 0 });
    const handle = f.backend.open({ url: "source" });
    f.playing();
    const before = f.commands.length;
    active = false;
    f.leases[0].sample.position = 80;
    f.leases[0].event("timeupdate");
    handle.pause();
    handle.resume();
    handle.selectTrack("audio", 2);
    f.domain({
        active: () => true,
        generation: 2,
        kind: "archive",
        position: 100,
        sourceActive: () => true,
    });
    handle.seek(120);
    f.backend.seek(120);
    assert.equal(
        f.leases[0].sample.position,
        80,
        "old decoder cannot adopt a replacement source via seek"
    );
    assert.equal(handle.active(), false);
    assert.equal(f.commands.length, before);
    assert.deepEqual(f.leases[0].selections, []);
});
test("legacy device clock is explicit, elapsed-time based and does not mutate key maps", (f) => {
    let now = 0,
        managed = false,
        state = {
            generation: 1,
            phase: "playing",
            position: 3,
            target: { kind: "archive" },
        },
        playing = true;
    const writes = [],
        keys = { ENTER: 13 };
    const device = f.context.__ottDeviceAdapter.create({
        capabilities: () => ({ pip: true }),
        clearInterval() {},
        command(v) {
            writes.push(v);
            if (v.type === "position") state.position = v.position;
        },
        duration: () => 100,
        importLegacy: () => state,
        isManaged: () => managed,
        key: (e) => e.code,
        keys: () => keys,
        now: () => now,
        playing: () => playing,
        position: () => 0,
        route: () => "mag",
        setInterval: () => 1,
    });
    device.sampleLegacy();
    now = 3500;
    device.sampleLegacy();
    assert.equal(writes.at(-2).position, 6.5);
    playing = false;
    now = 4000;
    device.sampleLegacy();
    now = 14000;
    device.sampleLegacy();
    assert.equal(writes.at(-2).position, 7);
    playing = true;
    device.sampleLegacy();
    state.position = 100; // retained device seek, unchanged playback generation
    now = 15000;
    device.sampleLegacy();
    assert.equal(writes.at(-2).position, 101);
    state.position = 20;
    now = 16000;
    device.sampleLegacy();
    assert.equal(writes.at(-2).position, 21);
    managed = true;
    const before = writes.length;
    device.sampleLegacy();
    assert.equal(writes.length, before);
    const descriptor = device.describe();
    descriptor.keys.ENTER = 0;
    assert.equal(keys.ENTER, 13);
    assert.equal(device.eventToKeyCode({ code: 13 }), 13);
});
test("actual legacy device wiring preserves Window timer receivers and disposes its sampler", (f) => {
    const entry = ts.createSourceFile(
        "index.ts",
        fs.readFileSync(path.join(__dirname, "../src/index.ts"), "utf8"),
        ts.ScriptTarget.Latest,
        true
    );
    const initializers = [];
    function visit(node) {
        if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isPropertyAccessExpression(node.left) &&
            node.left.name.text === "__ottDevice" &&
            ts.isCallExpression(node.right)
        )
            initializers.push(node);
        ts.forEachChild(node, visit);
    }
    visit(entry);
    assert.equal(initializers.length, 1, "exercise the actual startup wiring");
    const wiring = ts.transpileModule(
        "var deviceHost = window;\n" + initializers[0].getText(entry) + ";",
        { compilerOptions: { target: ts.ScriptTarget.ES5 } }
    ).outputText;
    // These functions live in the browser realm: a copied timer called as a
    // ports method must fail just as it does in receiver-checking WebKit.
    vm.runInContext(
        `
        var timerJobs = {}, timerCalls = [], timerSerial = 0, deviceCommands = [];
        window.setInterval = function (callback, delay) {
            if (this !== window) throw new TypeError("setInterval requires Window");
            var id = ++timerSerial;
            timerJobs[id] = callback;
            timerCalls.push(["setInterval", id, delay]);
            return id;
        };
        window.clearInterval = function (id) {
            if (this !== window) throw new TypeError("clearInterval requires Window");
            delete timerJobs[id];
            timerCalls.push(["clearInterval", id]);
        };
        window.__ottCoreTransport = { play: function () {} };
        window.stbPlay = function () {};
        window.stbIsPlaying = function () { return true; };
        window.stbGetLen = function () { return 120; };
        window.stbGetPosTime = function () { return 0; };
        window.__ottClassicPlayback = {
            command: function (value) { deviceCommands.push(value); },
            importLegacy: function () {
                return { generation: 1, phase: "playing", position: 3,
                    target: { kind: "archive" } };
            }
        };
        ` + wiring,
        f.context
    );
    const w = f.context;
    const device = w.__ottDevice;
    device.start();
    device.start();
    assert.deepEqual(JSON.parse(JSON.stringify(w.timerCalls)), [
        ["setInterval", 1, 1000],
    ]);
    w.timerJobs[1]();
    assert.deepEqual(JSON.parse(JSON.stringify(w.deviceCommands)), [
        { duration: 120, generation: 1, position: 3, type: "position" },
        { generation: 1, type: "playing" },
    ]);
    device.dispose();
    device.dispose();
    assert.equal(Object.keys(w.timerJobs).length, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(w.timerCalls)), [
        ["setInterval", 1, 1000],
        ["clearInterval", 1],
    ]);
    w.stbPlay = w.__ottCoreTransport.play;
    device.start();
    assert.equal(
        w.timerCalls.length,
        2,
        "managed playback needs no legacy timer"
    );
});
test("async provider links belong to each lane and cannot start after stop, replacement or source change", () => {
    const f = fixture();
    const pending = [];
    f.ports.resolve = (url, done) => {
        const row = { cancelled: 0, done, url };
        pending.push(row);
        return () => {
            row.cancelled++;
        };
    };
    f.backend.open({ url: "old" });
    f.backend.open({ url: "current" });
    assert.equal(pending[0].cancelled, 1);
    pending[0].done("https://stale.test/live");
    assert.equal(f.leases.length, 0);
    f.backend.open({ lane: "pip", url: "pip" });
    pending[1].done("https://media.test/main");
    pending[1].done("https://media.test/duplicate");
    assert.equal(f.leases.length, 1);
    assert.equal(f.leases[0].request.url, "https://media.test/main");
    f.backend.stop("pip");
    pending[2].done("https://media.test/pip");
    assert.equal(f.leases.length, 1);
    assert.equal(pending[2].cancelled, 1);
    f.backend.open({ url: "different-source" });
    f.domain({ generation: 2, kind: "live", position: 0 });
    pending[3].done("https://stale.test/source");
    assert.equal(f.leases.length, 1);
});

test("synchronous link resolution, failures and resolver reentry release the correct lease", () => {
    const f = fixture();
    let cancelled = 0;
    f.ports.resolve = (url, done) => {
        done(url === "fail" ? null : url);
        return () => cancelled++;
    };
    const failed = f.backend.open({ url: "fail" });
    assert.equal(f.leases.length, 0);
    assert.equal(failed.active(), false);
    assert.equal(cancelled, 1);
    f.backend.open({ url: "ready" });
    assert.equal(f.leases[0].request.url, "ready");
    f.backend.stop();
    assert.equal(cancelled, 2);
    f.ports.resolve = (url, done) => {
        if (url === "replace") f.backend.open({ url: "new" });
        done(url);
        return () => cancelled++;
    };
    f.backend.open({ url: "replace" });
    assert.equal(f.leases.length, 2);
    assert.equal(f.leases[1].request.url, "new");
    assert.equal(cancelled, 3);
    f.ports.resolve = () => {
        throw new Error("resolver failed");
    };
    assert.throws(() => f.backend.open({ url: "throw" }), /resolver failed/);
    assert.equal(f.backend.current(), null);
    assert.equal(f.leases[1].disposed, 1);
});

test("restart reopens the original URL and preserves measured VOD position", (f) => {
    const old = f.backend.open({ url: "movie" });
    f.playing(0, 42.5);
    const result = f.backend.restart();
    assert.equal(result.dispatched, true);
    assert.equal(result.position, 42.5);
    assert.equal(result.paused, false);
    assert.equal(f.leases[1].request.url, "movie");
    assert.equal(f.leases[1].request.position, 42.5);
    assert.equal(f.leases[0].disposed, 1);
    assert.equal(old.active(), false);
    const before = f.commands.length;
    f.leases[0].event("ended");
    assert.equal(f.commands.length, before);
});
test("restart preserves archive decoder offset and paused intent through late autoplay", (f) => {
    f.domain({ generation: 1, kind: "archive", position: 15 });
    const old = f.backend.open({ url: "archive" });
    f.playing(0, 1200);
    f.leases[0].sample.position = 1203.5;
    old.pause();
    const result = f.backend.restart();
    assert.equal(result.position, 18.5);
    assert.equal(result.paused, true);
    assert.equal(f.leases[1].request.position, 1203.5);
    f.playing(1, 1203.5);
    assert.equal(f.leases[1].sample.paused, true);
    assert.equal(f.backend.current().snapshot().phase, "paused");
    assert.equal(f.backend.current().snapshot().position, 18.5);
    f.backend.current().resume();
    assert.equal(f.leases[1].sample.paused, false);
    assert.equal(f.backend.current().snapshot().phase, "playing");
});
test("restart uses a fresh provider resolution and retires its predecessor", (f) => {
    const pending = [];
    let cancelled = 0;
    f.ports.resolve = (url, done) => {
        pending.push({ done, url });
        return () => cancelled++;
    };
    f.backend.open({ url: "provider:virtual" });
    pending[0].done("signed-old");
    f.playing(0, 7);
    f.backend.current().pause();
    const result = f.backend.restart();
    assert.equal(result.dispatched, true);
    assert.equal(cancelled, 1);
    assert.equal(pending[1].url, "provider:virtual");
    assert.equal(f.leases.length, 1);
    pending[0].done("stale");
    pending[1].done("signed-new");
    f.playing(1, 7);
    assert.equal(f.leases[1].request.url, "signed-new");
    assert.equal(f.leases[1].sample.paused, true);
});
test("restart refuses unready VOD, stale ownership and reentrant replacement", (f) => {
    f.backend.open({ url: "movie" });
    assert.equal(f.backend.restart(), null);
    assert.equal(f.leases.length, 1);
    f.playing(0, 2);
    f.domain({ generation: 2, kind: "vod", position: 0 });
    assert.equal(f.backend.restart(), null);
    assert.equal(f.leases.length, 1);
    f.backend.open({ url: "next" });
    f.playing(1, 3);
    let replaced = false;
    f.backend.subscribe((event) => {
        if (!replaced && event.type === "position") {
            replaced = true;
            f.backend.open({ url: "replacement" });
        }
    });
    assert.equal(f.backend.restart(), null);
    assert.equal(f.leases.length, 3);
    assert.equal(f.leases[2].request.url, "replacement");
});
test("live restart returns to the live edge without touching other lanes", (f) => {
    f.domain({ generation: 1, kind: "live", position: 200 });
    f.backend.open({ url: "live" });
    const preview = f.backend.open({ lane: "preview", url: "preview" });
    const result = f.backend.restart();
    assert.equal(result.position, 0);
    assert.equal(result.kind, "live");
    assert.equal(result.paused, false);
    assert.equal(f.leases[2].request.position, 0);
    assert.equal(preview.active(), true);
    assert.equal(f.leases[1].disposed, 0);
});

test("restored pause cannot control an engine after its source is retired", (f) => {
    let active = true;
    f.domain({ active: () => active, generation: 1, kind: "vod", position: 7 });
    f.backend.open({ url: "movie" });
    f.playing(0, 7);
    f.backend.current().pause();
    f.backend.restart();
    active = false;
    f.playing(1, 7);
    assert.equal(
        f.leases[1].sample.paused,
        false,
        "stale owner cannot issue pause"
    );
    assert.equal(f.backend.restart(), null);
    assert.equal(f.leases.length, 2);
});
test("restart refuses invalid measured positions and never exposes a source URL", (f) => {
    f.backend.open({ url: "https://provider.example/private?token=secret" });
    f.playing(0, 8);
    f.leases[0].sample.position = NaN;
    assert.equal(f.backend.restart(), null);
    assert.equal(f.leases.length, 1);
    f.leases[0].sample.position = 8;
    const result = f.backend.restart();
    assert.equal(JSON.stringify(result).includes("secret"), false);
    assert.deepEqual(Object.keys(result).sort(), [
        "accepted",
        "dispatched",
        "kind",
        "paused",
        "position",
        "target",
    ]);
});

test("ordinary manual pause allows a subsequent native engine resume", (f) => {
    const handle = f.backend.open({ url: "native-controls" });
    f.playing(0, 8);
    handle.pause();
    assert.equal(handle.snapshot().phase, "paused");
    assert.equal(f.leases[0].sample.paused, true);
    const before = f.commands.length;
    // Browser or native engine controls can play directly, without handle.resume().
    f.playing(0, 8);
    assert.equal(f.leases[0].sample.paused, false);
    assert.equal(handle.snapshot().phase, "playing");
    assert.equal(
        f.commands.slice(before).filter((event) => event.type === "pause")
            .length,
        0
    );
    assert.equal(
        f.commands.slice(before).filter((event) => event.type === "playing")
            .length,
        1
    );
    assert.equal(f.timers.filter((timer) => timer.active).length, 1);
});

test("restart releases its startup pause latch before a later native resume", (f) => {
    f.backend.open({ url: "native-controls" });
    f.playing(0, 8);
    f.backend.current().pause();
    f.backend.restart();
    // A premature event cannot consume restoration before the decoder is ready.
    Object.assign(f.leases[1].sample, { paused: false, ready: 0 });
    f.leases[1].event("playing");
    assert.equal(f.leases[1].sample.paused, true);
    f.playing(1, 8);
    assert.equal(f.leases[1].sample.paused, true);
    assert.equal(f.backend.current().snapshot().phase, "paused");
    // Native controls now resume directly; no backend.resume() is required.
    f.playing(1, 8);
    assert.equal(f.leases[1].sample.paused, false);
    assert.equal(f.backend.current().snapshot().phase, "playing");
    assert.equal(f.timers.filter((timer) => timer.active).length, 1);
});
test("an engine that suppresses startup autoplay accepts the first native Play", (f) => {
    const open = f.ports.open;
    f.ports.open = (request, event) => ({
        ...open(request, event),
        supportsPausedStart: true,
    });
    f.backend.open({ url: "paused-start" });
    f.playing(0, 8);
    f.backend.current().pause();
    f.backend.restart();
    assert.equal(f.leases[1].request.paused, true);
    Object.assign(f.leases[1].sample, { paused: true, position: 8, ready: 2 });
    f.leases[1].event("loadedmetadata");
    assert.equal(f.backend.current().snapshot().phase, "paused");
    f.playing(1, 8);
    assert.equal(f.leases[1].sample.paused, false);
    assert.equal(f.backend.current().snapshot().phase, "playing");
    assert.equal(f.timers.filter((timer) => timer.active).length, 1);
});
test("restart waits for asynchronous pause confirmation before releasing restoration", (f) => {
    f.backend.open({ url: "native-controls" });
    f.playing(0, 8);
    f.backend.current().pause();
    const open = f.ports.open;
    let confirmPause;
    f.ports.open = (request, event) => {
        const engine = open(request, event);
        const pause = engine.pause;
        engine.pause = () => {
            confirmPause = pause;
        };
        return engine;
    };
    f.backend.restart();
    f.playing(1, 8);
    assert.equal(
        f.leases[1].sample.paused,
        false,
        "pause is still pending in the engine"
    );
    assert.equal(f.backend.current().snapshot().phase, "paused");
    confirmPause();
    assert.equal(f.leases[1].sample.paused, true);
    f.playing(1, 8);
    assert.equal(f.leases[1].sample.paused, false);
    assert.equal(f.backend.current().snapshot().phase, "playing");
});

test("diagnostic preview owns one decoder without emitting old channel position or completion", (f) => {
    f.domain({ generation: 1, kind: "live", position: 0 });
    f.backend.open({ url: "live-source" });
    f.playing(0, 100);
    let closed = 0;
    const observed = [];
    f.backend.subscribe((event) => observed.push(event.type));
    const preview = f.backend.preview("diagnostic.mp4", () => closed++);
    assert.ok(preview.active());
    assert.equal(f.leases[0].disposed, 1);
    assert.equal(f.leases[1].request.transient, true);
    const count = f.commands.length;
    observed.length = 0;
    f.playing(1, 2);
    f.leases[1].event("timeupdate");
    f.backend.seek(4);
    f.backend.current().pause();
    f.backend.current().resume();
    assert.equal(f.commands.length, count);
    assert.deepEqual(
        observed,
        [],
        "temporary playback does not publish OS metadata for the old channel"
    );
    f.leases[1].event("ended");
    assert.equal(closed, 1);
    assert.equal(preview.active(), false);
    assert.equal(f.leases[1].disposed, 1);
    assert.equal(f.leases[2].request.url, "live-source");
    assert.equal(f.leases[2].request.position, 0);
    assert.equal(
        f.commands.some((command) => command.type === "ended"),
        false
    );
});
test("diagnostic preview restores a paused live channel after explicit finish", (f) => {
    f.domain({ generation: 1, kind: "live", position: 0 });
    const old = f.backend.open({ url: "live-source" });
    f.playing();
    old.pause();
    const preview = f.backend.preview("diagnostic.mp4");
    preview.finish();
    preview.finish();
    assert.equal(f.leases.length, 3);
    assert.equal(f.leases[2].request.paused, true);
});
for (const reason of ["stop", "replacement", "source"])
    test("diagnostic preview never restores after " + reason, (f) => {
        f.domain({ generation: 1, kind: "live", position: 0 });
        f.backend.open({ url: "live-source" });
        f.playing();
        const preview = f.backend.preview("diagnostic.mp4");
        if (reason === "stop") f.backend.stop();
        if (reason === "replacement") f.backend.open({ url: "new-source" });
        if (reason === "source")
            f.domain({ generation: 2, kind: "live", position: 0 });
        f.leases[1].event("ended");
        preview.finish();
        assert.equal(
            f.leases.filter((lease) => lease.request.url === "live-source")
                .length,
            1
        );
        if (reason === "replacement") assert.equal(f.leases[2].disposed, 0);
    });
for (const kind of ["vod", "archive"])
    test(
        "diagnostic preview leaves " + kind + " history and decoder untouched",
        (f) => {
            f.domain({ generation: 1, kind, position: 50 });
            const old = f.backend.open({ position: 50, url: "recording" });
            f.playing(0, 50);
            assert.equal(f.backend.preview("diagnostic.mp4"), null);
            assert.equal(f.backend.current(), old);
            assert.equal(f.leases[0].disposed, 0);
        }
    );
test("idle diagnostic error cleans up without starting an old channel", (f) => {
    f.domain(null);
    const preview = f.backend.preview("diagnostic.mp4");
    f.leases[0].event("error");
    assert.equal(preview.active(), false);
    assert.equal(f.backend.current(), null);
    assert.equal(f.commands.length, 0);
});
test("diagnostic completion callback cannot overwrite a synchronously selected channel", (f) => {
    f.domain({ generation: 1, kind: "live", position: 0 });
    f.backend.open({ url: "live-source" });
    f.playing();
    const preview = f.backend.preview("diagnostic.mp4", () =>
        f.backend.open({ url: "chosen-in-callback" })
    );
    preview.finish();
    assert.equal(f.leases.length, 3);
    assert.equal(f.leases[2].request.url, "chosen-in-callback");
});

test("diagnostic startup exception restores the previous live decoder", (f) => {
    f.domain({ generation: 1, kind: "live", position: 0 });
    f.backend.open({ url: "live-source" });
    f.playing();
    const originalOpen = f.ports.open;
    f.ports.open = (request, event) => {
        if (request.transient) throw new Error("failed test decoder");
        return originalOpen(request, event);
    };
    assert.equal(f.backend.preview("diagnostic.mp4"), null);
    assert.equal(f.leases.length, 2);
    assert.equal(f.leases[1].request.url, "live-source");
});

test("diagnostic suspension preserves transient source identity and hides retired events", (f) => {
    f.domain({ generation: 1, kind: "live", position: 0 });
    f.backend.open({ url: "live-source" });
    f.playing();
    const resolutions = [];
    const events = [];
    f.ports.resolve = (url, done) => {
        resolutions.push({ done, url });
        return () => {};
    };
    f.backend.subscribe((event) => events.push(event));
    const preview = f.backend.preview("diagnostic.mp4");
    const handle = f.backend.current();
    resolutions[0].done("signed-diagnostic-1");
    f.leases[1].engine = "hls.js";
    f.playing(1, 2);
    assert.equal(handle.diagnosticEngine(), "hls.js");
    handle.suspend();
    assert.equal(handle.diagnosticEngine(), null);
    assert.equal(f.leases[1].disposed, 1);
    handle.resume();
    resolutions[0].done("retired-signed-diagnostic");
    assert.equal(f.leases.length, 2);
    assert.equal(resolutions[1].url, "diagnostic.mp4");
    resolutions[1].done("signed-diagnostic-2");
    assert.equal(f.leases[2].request.sourceUrl, "diagnostic.mp4");
    assert.equal(f.leases[2].request.url, "signed-diagnostic-2");
    assert.equal(f.leases[2].request.transient, true);
    f.leases[2].engine = "html5";
    assert.equal(handle.diagnosticEngine(), "html5");
    f.leases[1].event("ended");
    assert.equal(preview.active(), true);
    f.playing(2, 3);
    f.leases[2].event("ended");
    assert.equal(preview.active(), false);
    assert.equal(resolutions[2].url, "live-source");
    resolutions[2].done("fresh-live-source");
    assert.equal(f.leases[3].request.sourceUrl, "live-source");
    assert.equal(f.leases[3].request.transient, false);
    assert.equal(
        events.some((event) => event.id === handle.id),
        false
    );
});

test("diagnostic resolver failure stays private and retires the preview", (f) => {
    f.domain(null);
    const events = [];
    f.backend.subscribe((event) => events.push(event.type));
    f.ports.resolve = (_url, done) => {
        done(null);
        return () => {};
    };
    const preview = f.backend.preview("unavailable-diagnostic.mp4");
    assert.equal(preview.active(), false);
    assert.equal(f.backend.current(), null);
    assert.equal(f.leases.length, 0);
    assert.deepEqual(events, []);
    assert.deepEqual(f.commands, []);
});

for (const kind of ["live", "vod", "archive"])
    test("screen suspension releases transport and reopens " + kind, () => {
        const f = fixture();
        f.domain({
            generation: 1,
            kind,
            position: kind === "archive" ? 1000 : 0,
        });
        const h = f.backend.open({ position: 10, url: "stream" });
        f.playing(0, 37);
        const saved = h.snapshot().position;
        h.suspend();
        h.suspend();
        assert.equal(f.leases[0].disposed, 1);
        assert.equal(f.backend.current(), h);
        assert.equal(h.snapshot().phase, "paused");
        assert.equal(h.snapshot().position, saved);
        assert.equal(
            f.timers.some((timer) => timer.active),
            false
        );
        f.leases[0].event("playing");
        assert.equal(
            h.snapshot().phase,
            "paused",
            "retired decoder events are ignored"
        );
        h.resume();
        assert.equal(f.leases.length, 2);
        assert.equal(f.leases[1].request.position, kind === "live" ? 0 : 37);
        assert.equal(f.leases[1].request.paused, false);
        f.playing(1, kind === "live" ? 0 : 37);
        assert.equal(h.snapshot().phase, "playing");
        assert.equal(h.snapshot().position, kind === "live" ? 0 : saved);
    });
test("screen suspension retires EOF callbacks before sampling the final local clock", (f) => {
    const originalOpen = f.ports.open;
    let finalSample = false;
    f.ports.open = (request, event) => {
        const engine = originalOpen(request, event);
        const read = engine.sample;
        engine.sample = () => {
            if (finalSample) event("ended");
            return read();
        };
        return engine;
    };
    const originalEmit = f.ports.emit;
    f.ports.emit = (...args) => {
        originalEmit(...args);
        if (args[1] === "ended") f.backend.open({ url: "next-local-file" });
    };
    const handle = f.backend.open({ url: "local-file" });
    f.playing(0, 12);
    f.leases[0].sample.position = 499;
    finalSample = true;
    handle.suspend();
    assert.equal(f.leases.length, 1, "suspend cannot launch the next file");
    assert.equal(
        f.commands.some((event) => event.type === "ended"),
        false
    );
    assert.equal(
        handle.snapshot().position,
        499,
        "final cursor is checkpointed"
    );
    assert.equal(f.commands.at(-2).type, "position");
    assert.equal(f.commands.at(-2).position, 499);
    assert.equal(handle.snapshot().phase, "paused");
    assert.equal(f.leases[0].disposed, 1);
    f.leases[0].event("ended");
    assert.equal(f.leases.length, 1, "late native EOF remains retired");
    finalSample = false;
    handle.resume();
    assert.equal(f.leases[1].request.position, 499);
});
test("screen suspension releases an unreadable decoder without losing its saved clock", (f) => {
    const originalOpen = f.ports.open;
    let failSample = false;
    f.ports.open = (request, event) => {
        const engine = originalOpen(request, event);
        const read = engine.sample;
        engine.sample = () => {
            if (failSample) throw Error("native decoder detached");
            return read();
        };
        return engine;
    };
    const handle = f.backend.open({ url: "local-file" });
    f.playing(0, 31);
    failSample = true;
    handle.suspend();
    assert.equal(handle.snapshot().position, 31);
    assert.equal(handle.snapshot().phase, "paused");
    assert.equal(f.leases[0].disposed, 1);
    assert.equal(
        f.timers.some((timer) => timer.active),
        false
    );
});

test("screen suspension cancels resolution and ignores late results", () => {
    const f = fixture();
    const callbacks = [];
    let cancelled = 0;
    f.ports.resolve = (url, done) => {
        callbacks.push(done);
        return () => cancelled++;
    };
    const h = f.backend.open({ url: "expiring" });
    h.suspend();
    assert.equal(cancelled, 1);
    callbacks[0]("old");
    assert.equal(f.leases.length, 0);
    h.resume();
    assert.equal(callbacks.length, 2, "wake resolves a fresh session");
    callbacks[0]("old-again");
    callbacks[1]("new");
    assert.equal(f.leases.length, 1);
    assert.equal(f.leases[0].request.url, "new");
    h.suspend();
    h.dispose();
    h.resume();
    assert.equal(
        callbacks.length,
        2,
        "a disposed sleeping lease cannot reopen"
    );
});
test("ordinary pause keeps its transport while screen suspension releases it", () => {
    const f = fixture();
    const h = f.backend.open({ url: "stream" });
    f.playing(0, 37);
    h.pause();
    assert.equal(f.leases[0].disposed, 0);
    h.suspend();
    assert.equal(f.leases[0].disposed, 1);
    assert.equal(h.snapshot().phase, "paused");
    assert.equal(
        f.leases.length,
        1,
        "no automatic reload of an already paused item"
    );
    h.resume();
    assert.equal(
        f.leases.length,
        2,
        "explicit Play can resume the released item"
    );
});

test("a sleeping subscriber prevents replacement source resolution", () => {
    const f = fixture();
    const prior = f.backend.open({ url: "first" });
    const resolutions = [];
    f.ports.resolve = (url, done) => {
        resolutions.push(url);
        done(url);
        return () => {};
    };
    f.backend.subscribe(() => {
        const current = f.backend.current();
        if (current && current !== prior) current.suspend();
    });
    const replacement = f.backend.open({ url: "asleep" });
    assert.equal(replacement.snapshot().phase, "paused");
    assert.deepEqual(
        resolutions,
        [],
        "sleep must block source preparation too"
    );
    assert.equal(f.leases.length, 1);
});

test("engine diagnostics follow ownership, suspension and natural stop without sampling", () => {
    const f = fixture();
    const first = f.backend.open({ url: "first" });
    f.leases[0].engine = "hls.js";
    const commandCount = f.commands.length;
    assert.equal(first.diagnosticEngine(), "hls.js");
    assert.equal(
        f.commands.length,
        commandCount,
        "observation emits no commands"
    );
    first.suspend();
    assert.equal(first.diagnosticEngine(), null);
    first.resume();
    f.leases[1].engine = "html5";
    assert.equal(first.diagnosticEngine(), "html5");
    const next = f.backend.open({ url: "next" });
    f.leases[2].engine = "shaka";
    assert.equal(first.diagnosticEngine(), null);
    assert.equal(next.diagnosticEngine(), "shaka");
    f.playing(2);
    f.leases[2].event("ended");
    assert.equal(next.diagnosticEngine(), null);
    const retired = f.backend.open({ url: "retired" });
    f.leases[3].engine = "hls.js";
    f.domain({ generation: 2, kind: "vod", position: 0 });
    assert.equal(
        retired.diagnosticEngine(),
        null,
        "retired source has no authority"
    );
    f.backend.dispose();
});

test("EOF retains one final attempt before synchronous engine disposal", () => {
    const f = fixture();
    const first = f.backend.open({ url: "first" });
    f.leases[0].attempt = {
        engineStarts: 3,
        fatalErrors: 2,
        nativeFallbacks: 1,
        streamRetries: 1,
    };
    const attachment = first.diagnosticAttempt().attachment;
    f.playing();
    const emit = f.ports.emit;
    f.ports.emit = (...args) => {
        emit(...args);
        if (args[1] === "ended") f.backend.dispose();
    };
    f.leases[0].event("ended");
    assert.equal(f.backend.current(), null);
    assert.equal(first.diagnosticAttempt(), null);
    const final = f.backend.lastAttempt();
    assert.equal(final.handleId, first.id);
    assert.equal(final.generation, 1);
    assert.equal(final.attachment, attachment);
    assert.equal(final.reason, "ended");
    assert.equal(final.engineStarts, 3);
    assert.equal(final.nativeFallbacks, 1);
    assert.equal(final.streamRetries, 1);
    final.streamRetries = 0;
    assert.equal(f.backend.lastAttempt().streamRetries, 1);
    const second = f.backend.open({ url: "second" });
    f.leases[1].attempt = {
        ...f.leases[0].attempt,
        engineStarts: 1,
        streamRetries: 0,
    };
    f.playing(1);
    f.leases[1].event("ended");
    assert.equal(f.backend.lastAttempt().handleId, second.id);
    f.leases[0].event("ended");
    assert.equal(
        f.backend.lastAttempt().handleId,
        second.id,
        "stale EOF cannot overwrite new history"
    );
    assert.equal(f.backend.lastAttempt("pip"), null);
});

console.log(
    "PASS media backend: " + passed + " ES5 lease/observer/device scenarios"
);
