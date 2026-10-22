const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "src/index.ts"), "utf8");
const begin = source.indexOf(
    "        (window as any).__ottOsMediaSession.create"
);
const end = source.indexOf("    })();\n}", begin);
assert.ok(begin > 0 && end > begin, "actual Capacitor playback wrapper exists");
const code = ts.transpileModule(source.slice(begin, end), {
    compilerOptions: {
        module: ts.ModuleKind.None,
        target: ts.ScriptTarget.ES5,
    },
}).outputText;
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, reject, resolve };
}
function fixture(legacyProxy = false) {
    const calls = [],
        supports = [],
        plays = [],
        stops = [],
        states = [],
        timers = new Map();
    let timerId = 0;
    const cap = {};
    for (const name of [
        "startBackgroundAudio",
        "stopBackgroundAudio",
        "pauseBackgroundAudio",
        "resumeBackgroundAudio",
        "updateBackgroundAudio",
    ]) {
        cap[name] = (...args) => {
            calls.push([name, ...args]);
            return Promise.resolve({ ok: true });
        };
    }
    const dash = {
        getPlaybackState() {
            const d = deferred();
            states.push(d);
            return d.promise;
        },
        isDashSupported() {
            const d = deferred();
            supports.push(d);
            return d.promise;
        },
        pauseDash() {
            calls.push(["pauseDash"]);
            return Promise.resolve({ ok: true });
        },
        playDash(options) {
            const d = deferred();
            plays.push(d);
            calls.push(["playDash", options]);
            return d.promise;
        },
        resumeDash() {
            calls.push(["resumeDash"]);
            return Promise.resolve({ ok: true });
        },
        seekDash(options) {
            calls.push(["seekDash", options]);
            return Promise.resolve({ ok: true });
        },
        stopDash() {
            const d = deferred();
            stops.push(d);
            calls.push(["stopDash"]);
            return d.promise;
        },
    };
    const optionalCalls = [];
    let dashBridge = dash;
    if (legacyProxy) {
        // Use the installed Capacitor SDK itself: old APK headers lack the new methods,
        // but property reads still produce function proxies that reject UNIMPLEMENTED.
        const sdk = {
            androidBridge: {},
            Capacitor: {
                nativePromise: (_plugin, method, options) =>
                    dash[method](options),
                PluginHeaders: [
                    {
                        methods: [
                            "isDashSupported",
                            "playDash",
                            "stopDash",
                            "pauseDash",
                            "resumeDash",
                        ].map((name) => ({ name, rtype: "promise" })),
                        name: "DashExoPlayer",
                    },
                ],
            },
            console: { error() {}, warn() {} },
            exports: {},
        };
        vm.runInNewContext(
            fs.readFileSync(require.resolve("@capacitor/core"), "utf8"),
            sdk
        );
        const proxy = sdk.exports.Capacitor.registerPlugin("DashExoPlayer");
        dashBridge = new Proxy(proxy, {
            get(target, name) {
                const method = target[name];
                if (name !== "seekDash" && name !== "getPlaybackState")
                    return method;
                return (...args) => {
                    optionalCalls.push(name);
                    return method(...args);
                };
            },
        });
    }
    let webPlaying = false;
    let webPosition = 0;
    const w = {
        cap,
        clearInterval(id) {
            timers.delete(id);
        },
        clearTimeout(id) {
            timers.delete(id);
        },
        console: { warn() {} },
        DashExoPlayer: dashBridge,
        forcePlay: true,
        nativeMediaMetadata: () => ({
            durationSec: 300,
            positionSec: 10,
            seekable: true,
            title: "Movie",
        }),
        setInterval(fn) {
            const id = ++timerId;
            timers.set(id, fn);
            return id;
        },
        setTimeout(fn) {
            const id = ++timerId;
            timers.set(id, () => {
                timers.delete(id);
                fn();
            });
            return id;
        },
        stbContinue() {
            webPlaying = !webPlaying;
            w.forcePlay = webPlaying;
        },
        stbGetLen: () => 999,
        stbGetPosTime: () => webPosition,
        stbIsPlaying: () => webPlaying,
        stbPause() {
            webPlaying = false;
            w.forcePlay = false;
        },
        stbPlay(url, pos) {
            calls.push(["webPlay", url, pos]);
            webPlaying = true;
            webPosition = pos || 0;
            w.forcePlay = true;
        },
        stbSetPosTime(pos) {
            calls.push(["webSeek", pos]);
            webPosition = pos;
        },
        stbStop() {
            calls.push(["webStop"]);
            webPlaying = false;
            w.forcePlay = false;
        },
    };
    w.window = w;
    vm.createContext(w);
    const original = {
        duration: w.stbGetLen,
        isPlaying: w.stbIsPlaying,
        position: w.stbGetPosTime,
        seek: w.stbSetPosTime,
    };
    for (const file of ["media-backend", "media-session"])
        require("./helpers/private-runtime.cjs")(
            w,
            "src/device/" + file + ".ts"
        );
    const engine = {
        pause: w.stbPause,
        play: w.stbPlay,
        resume: w.stbContinue,
        seek: w.stbSetPosTime,
        stop: w.stbStop,
    };
    const backend = w.__ottMediaBackend.create({
        clearInterval: w.clearInterval,
        context: () => null,
        emit() {},
        open(request) {
            engine.play(request.url, request.position);
            return {
                dispose: engine.stop,
                pause: engine.pause,
                resume: engine.resume,
                sample: () => ({
                    duration: 999,
                    paused: !webPlaying,
                    position: webPosition,
                    ready: 2,
                }),
                seek: engine.seek,
            };
        },
        setInterval: w.setInterval,
    });
    w.__ottCoreBackend = () => backend;
    w.stbPlay = (url, position) => backend.open({ position, url });
    w.stbStop = () => backend.stop();
    w.stbPause = () => backend.current().pause();
    w.stbContinue = () =>
        webPlaying ? backend.current().pause() : backend.current().resume();
    vm.runInContext(code, w);
    return {
        calls,
        dash,
        dashBridge,
        optionalCalls,
        original,
        plays,
        states,
        stops,
        supports,
        timers,
        w,
    };
}
// Normal Capacitor playback deliberately uses the browser TS engine. Direct
// native DASH API state/seek coverage remains in test_native_dash_state.py;
// engine attachment/teardown races remain in test_port_engine_lifecycle.cjs.
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
test("DASH and HLS stay on the same controllable TS backend", async () => {
    const { w, calls, supports, plays, states, original } = fixture();
    w.stbPlay("movie.mpd", 30);
    assert.equal(w.stbIsPlaying, original.isPlaying);
    assert.equal(w.stbGetPosTime, original.position);
    assert.equal(w.stbGetLen, original.duration);
    assert.equal(w.stbSetPosTime, original.seek);
    assert.equal(w.stbGetPosTime(), 30);
    assert.equal(w.stbGetLen(), 999);
    w.stbSetPosTime(70);
    assert.equal(w.stbGetPosTime(), 70);
    w.stbPlay("next.m3u8");
    await tick();
    assert.deepEqual(
        calls.filter((call) => call[0] === "webPlay").map((call) => call[1]),
        ["movie.mpd", "next.m3u8"]
    );
    assert.deepEqual(supports, []);
    assert.deepEqual(plays, []);
    assert.deepEqual(states, []);
    assert.ok(!calls.some((call) => /Dash$/.test(call[0])));
});
test("stop immediately stops the TS engine and invalidates delayed metadata", async () => {
    const { w, calls, timers, supports } = fixture();
    w.stbPlay("movie.mpd", 20);
    const late = [...timers.values()];
    w.stbStop();
    const stoppedCount = calls.length;
    for (const fn of late) fn();
    await tick();
    assert.equal(w.stbIsPlaying(), false);
    assert.equal(w.forcePlay, false);
    assert.equal(calls.length, stoppedCount);
    assert.equal(timers.size, 0);
    assert.deepEqual(supports, []);
    assert.deepEqual(
        calls.slice(-2).map((call) => call[0]),
        ["webStop", "stopBackgroundAudio"]
    );
});
test("new streams reject metadata from the previous playback session", () => {
    const { w, calls, timers } = fixture();
    w.stbPlay("old.mpd");
    const old = [...timers.values()];
    w.stbPlay("new.mpd", 10);
    const count = calls.length;
    for (const fn of old) fn();
    assert.equal(calls.length, count);
    assert.equal(w.stbGetPosTime(), 10);
    assert.equal(timers.size, 1);
});
test("pause and continue use actual TS state for background session updates", () => {
    const { w, calls, timers } = fixture();
    w.stbPlay("movie.mpd");
    const initial = [...timers.values()];
    w.stbPause();
    const count = calls.length;
    for (const fn of initial) fn();
    assert.equal(calls.length, count);
    assert.equal(w.stbIsPlaying(), false);
    assert.equal(w.forcePlay, false);
    assert.equal(timers.size, 0);
    w.stbContinue();
    assert.equal(w.stbIsPlaying(), true);
    assert.equal(calls.at(-1)[0], "resumeBackgroundAudio");
    assert.equal(timers.size, 1);
    w.stbContinue();
    assert.equal(w.stbIsPlaying(), false);
    assert.equal(calls.at(-1)[0], "pauseBackgroundAudio");
    assert.equal(timers.size, 0);
});
test("captured periodic callbacks cannot revive stopped or replaced background sessions", () => {
    for (const transition of ["stop", "pause", "replace"]) {
        const { w, calls, timers } = fixture();
        w.stbPlay("movie.mpd");
        [...timers.values()][0]();
        const interval = [...timers.values()][0];
        if (transition === "stop") w.stbStop();
        else if (transition === "pause") w.stbPause();
        else w.stbPlay("next.m3u8");
        const count = calls.length;
        interval();
        assert.equal(
            calls.length,
            count,
            transition + " invalidates the old interval"
        );
    }
});
test("seek to zero remains a shared TS operation", () => {
    const { w, calls } = fixture();
    w.stbPlay("movie.mpd", 90);
    w.stbSetPosTime(0);
    assert.equal(w.stbGetPosTime(), 0);
    assert.deepEqual(
        calls.filter((call) => call[0] === "webSeek"),
        [["webSeek", 0]]
    );
});
test("older installed native APK methods are never required by ordinary DASH playback", async () => {
    const { w, dashBridge, optionalCalls, supports, plays, states } =
        fixture(true);
    assert.equal(typeof dashBridge.seekDash, "function");
    assert.equal(typeof dashBridge.getPlaybackState, "function");
    w.stbPlay("old-apk.mpd", 12);
    w.stbSetPosTime(99);
    w.stbPause();
    w.stbContinue();
    await tick();
    assert.equal(w.stbGetPosTime(), 99);
    assert.equal(w.stbIsPlaying(), true);
    assert.deepEqual(optionalCalls, []);
    assert.deepEqual(supports, []);
    assert.deepEqual(plays, []);
    assert.deepEqual(states, []);
});
(async () => {
    for (const [name, fn] of tests) {
        await fn();
        console.log("PASS " + name);
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
