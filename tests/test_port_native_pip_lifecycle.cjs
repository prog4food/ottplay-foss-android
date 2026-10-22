/* Actual native PiP shims: deferred native replies must obey the latest play/stop. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const source = fs.readFileSync(
    process.argv[2] || path.join(__dirname, "../src/index.ts"),
    "utf8"
);

function between(startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    assert(start >= 0 && end > start, "Production PiP block markers exist");
    return ts.transpileModule(source.slice(start, end), {
        compilerOptions: {
            module: ts.ModuleKind.None,
            target: ts.ScriptTarget.ES5,
        },
    }).outputText;
}
const snippets = {
    Capacitor: between(
        "const capacitorHost = (window as any).Capacitor;",
        "(window as any).__ottOsMediaSession.create"
    ),
    Tauri: between(
        "// Native PiP is a decoder port;",
        "window.setSleepTimeout = setSleepTimeout;"
    ),
};

function fixture(platform, capacitorPlatform = "ios", deferStop = false) {
    const nativeCalls = [];
    const boundsCalls = [];
    const requests = [];
    const stopRequests = [];
    const cssPlays = [];
    const displays = [];
    let cssStops = 0;
    let display = "existing-css-player";
    const style = {};
    Object.defineProperty(style, "display", {
        get: () => display,
        set(value) {
            display = value;
            displays.push(value);
        },
    });
    function nativePlay(url) {
        nativeCalls.push(["play", url]);
        let resolve;
        let reject;
        const promise = new Promise((yes, no) => {
            resolve = yes;
            reject = no;
        });
        requests.push({ reject, resolve, url });
        return promise;
    }
    function nativeStop() {
        nativeCalls.push(["stop"]);
        if (!deferStop) return Promise.resolve();
        return new Promise((resolve, reject) =>
            stopRequests.push({ reject, resolve })
        );
    }
    const c = {
        _: (key) =>
            ({
                "Loading...": "Загрузка…",
                "Picture in Picture": "Картинка в картинке",
            })[key] || key,
        __TAURI__: {},
        Capacitor: { getPlatform: () => capacitorPlatform },
        cap: {
            playPip: ({ url, loop, subtitle }) => {
                assert.equal(
                    subtitle,
                    "Картинка в картинке",
                    "iOS system card uses the player language"
                );
                const result = nativePlay(url);
                requests.at(-1).loop = loop;
                return result;
            },
            stopPip: nativeStop,
        },
        console: { warn() {} },
        document: {
            getElementById(id) {
                assert.equal(id, "videopip");
                return { style };
            },
        },
        location: { href: "https://fixture.invalid/" },
        Promise,
        playerMode: 2,
        setPipPosition() {},
        sPipPos: 3,
        sPipSize: 1,
        stbPlayPip(url) {
            cssPlays.push(url);
            style.display = `css:${url}`;
        },
        stbStopPip() {
            cssStops++;
            style.display = "stopped";
        },
        tauriInvoke(command, args) {
            if (command === "play_pip") {
                const result = nativePlay(args.url);
                requests.at(-1).engine = args.engine;
                requests.at(-1).loop = args.loop;
                requests.at(-1).labels = args.labels;
                assert.equal(
                    args.labels.loading,
                    "Загрузка…",
                    "Native PiP receives current app translations"
                );
                return result;
            }
            if (command === "set_pip_bounds") {
                boundsCalls.push({ position: args.position, size: args.size });
                return Promise.resolve();
            }
            assert.equal(command, "stop_pip");
            return nativeStop();
        },
        URL,
    };
    c.window = c;
    vm.createContext(c);
    vm.runInContext(
        ts
            .transpileModule(
                fs.readFileSync(
                    path.join(__dirname, "../src/plugins/access-media.ts"),
                    "utf8"
                ),
                {
                    compilerOptions: {
                        module: ts.ModuleKind.ES2015,
                        target: ts.ScriptTarget.ES5,
                    },
                }
            )
            .outputText.replace(/^export /gm, ""),
        c
    );
    for (const file of ["media-backend", "native-pip"])
        require("./helpers/private-runtime.cjs")(
            c,
            "src/device/" + file + ".ts"
        );
    const effects = {};
    c.__ottCoreTransport = {
        configure: (value) => Object.assign(effects, value),
    };
    const cssPlay = c.stbPlayPip,
        cssStop = c.stbStopPip;
    function cssLease(request) {
        cssPlay(request.url);
        return {
            dispose: cssStop,
            pause() {},
            resume() {},
            sample: () => ({
                duration: NaN,
                paused: false,
                position: 0,
                ready: 2,
            }),
            seek() {},
        };
    }
    const backend = c.__ottMediaBackend.create({
        clearInterval() {},
        context: () => null,
        emit() {},
        open(request) {
            if (effects.pip) {
                cssStop();
                return effects.pip.open(request, (url) =>
                    cssLease(Object.assign({}, request, { url }))
                );
            }
            return cssLease(request);
        },
        setInterval() {
            return 1;
        },
    });
    c.stbPlayPip = (url) => backend.open({ lane: "pip", url });
    c.stbStopPip = () => backend.stop("pip");
    vm.runInContext(snippets[platform], c, {
        filename: `actual-${platform}-pip.js`,
    });
    return {
        boundsCalls,
        cssPlays,
        get cssStops() {
            return cssStops;
        },
        displays,
        nativeCalls,
        play: (url) => c.stbPlayPip(url),
        requests,
        stop: () => c.stbStopPip(),
        stopRequests,
        succeed: (request) =>
            request.resolve(
                platform === "Capacitor" ? { ok: true } : undefined
            ),
        window: c,
    };
}
// Drain the real Promise queue; no sleeps, native runtimes or network required.
const settle = () => new Promise((resolve) => setImmediate(resolve));
const tests = [];
function test(name, run) {
    tests.push({ name, run });
}

for (const platform of ["Capacitor", "Tauri"]) {
    test(`${platform}: reentrant failure reporting cannot start a retired CSS fallback`, async () => {
        const f = fixture(platform);
        f.play("old");
        await settle();
        f.window.console.warn = () => {
            f.window.console.warn = () => {};
            f.play("new");
        };
        f.requests[0].reject(new Error("old decoder failed"));
        await settle();
        assert.deepEqual(
            f.cssPlays,
            [],
            "failure reporting replaced the owner before fallback"
        );
        assert.equal(f.requests.length, 2);
    });
}

// Capacitor Stop cancels a pending native play. Replacement plays wait only for
// teardown acknowledgement, never for the cancelled player's readiness. Tauri's
// Rust controller owns cancellation, so its JS commands must not form a queue.
for (const platform of ["Capacitor"]) {
    const results = ["success", "failure", "unsupported"];
    for (const result of results) {
        test(`${platform}: stop during native play (${result})`, async () => {
            const f = fixture(platform);
            f.play("A");
            await settle();
            assert.equal(f.requests.length, 1);
            f.stop();
            const afterStop = f.displays.length;
            assert.deepEqual(
                f.nativeCalls,
                [["play", "A"], ["stop"]],
                "Native stop must cancel in-flight play before its acknowledgement"
            );
            if (result === "failure")
                f.requests[0].reject(new Error("native failure"));
            else if (result === "unsupported")
                f.requests[0].resolve({ ok: false });
            else f.succeed(f.requests[0]);
            await settle();
            assert.deepEqual(
                f.cssPlays,
                [],
                "Stopped native work must never restart the CSS decoder"
            );
            assert.equal(
                f.displays.length,
                afterStop,
                "Late native success must not hide or mutate the stopped UI"
            );
            assert.deepEqual(
                f.nativeCalls,
                [["play", "A"], ["stop"]],
                "Late play settlement must not issue another stop"
            );
        });
    }
    for (const oldResult of ["success", "failure"]) {
        test(`${platform}: A → B with late A ${oldResult}`, async () => {
            const f = fixture(platform);
            f.play("A");
            assert.equal(
                f.cssStops,
                1,
                "New native play synchronously stops a previous CSS decoder"
            );
            await settle();
            f.play("B");
            assert.equal(f.cssStops, 2);
            await settle();
            assert.deepEqual(
                f.nativeCalls,
                [["play", "A"], ["stop"], ["play", "B"]],
                "B starts after teardown without waiting for A's readiness"
            );
            const afterB = f.displays.length;
            if (oldResult === "failure")
                f.requests[0].reject(new Error("A failed"));
            else f.succeed(f.requests[0]);
            await settle();
            assert.deepEqual(
                f.cssPlays,
                [],
                "A's late failure cannot start its obsolete CSS fallback"
            );
            assert.equal(
                f.displays.length,
                afterB,
                "A's late success cannot hide B's pending UI"
            );
            assert.deepEqual(f.nativeCalls, [
                ["play", "A"],
                ["stop"],
                ["play", "B"],
            ]);
            f.succeed(f.requests[1]);
            await settle();
            assert.equal(
                f.displays.at(-1),
                "none",
                "Only current native success hides the CSS layer"
            );
        });
    }
    test(`${platform}: obsolete queued plays are skipped`, async () => {
        const f = fixture(platform);
        f.play("A");
        f.play("B");
        f.play("C");
        await settle();
        assert.deepEqual(f.nativeCalls, [["play", "C"]]);
        f.succeed(f.requests[0]);
        await settle();
        assert.deepEqual(f.cssPlays, []);
    });
    test(`${platform}: play → stop → play preserves native command order`, async () => {
        const f = fixture(platform);
        f.play("A");
        await settle();
        f.stop();
        f.play("B");
        await settle();
        assert.deepEqual(f.nativeCalls, [
            ["play", "A"],
            ["stop"],
            ["play", "B"],
        ]);
        f.succeed(f.requests[0]);
        await settle();
        assert.deepEqual(f.nativeCalls, [
            ["play", "A"],
            ["stop"],
            ["play", "B"],
        ]);
        f.succeed(f.requests[1]);
        await settle();
        assert.deepEqual(f.cssPlays, []);
    });
    for (const failure of ["reject", "unsupported"]) {
        test(`${platform}: current ${failure} falls back exactly once`, async () => {
            const f = fixture(platform);
            f.play("A");
            await settle();
            if (failure === "reject")
                f.requests[0].reject(new Error("current failure"));
            else f.requests[0].resolve({ ok: false });
            await settle();
            assert.deepEqual(f.cssPlays, ["A"]);
            assert.equal(f.displays.at(-1), "css:A");
            f.stop();
            await settle();
            assert.deepEqual(
                f.cssPlays,
                ["A"],
                "Stopping fallback must not restart it"
            );
            assert.equal(f.displays.at(-1), "stopped");
        });
    }
}

for (const oldResult of ["success", "failure"]) {
    for (const stopResult of ["success", "failure"]) {
        test(`Capacitor: pending teardown owns the queue after late A ${oldResult} and stop ${stopResult}`, async () => {
            const f = fixture("Capacitor", "ios", true);
            f.play("A");
            await settle();
            f.stop();
            f.play("B");
            await settle();
            assert.deepEqual(f.nativeCalls, [["play", "A"], ["stop"]]);
            assert.equal(f.stopRequests.length, 1);
            if (oldResult === "failure")
                f.requests[0].reject(new Error("retired A failed"));
            else f.succeed(f.requests[0]);
            await settle();
            // A's old queue-tail completion must not clear the newer teardown.
            // Replace queued B after A settles to exercise that queue ownership.
            f.play("C");
            await settle();
            assert.deepEqual(
                f.nativeCalls,
                [["play", "A"], ["stop"]],
                "No decoder may start before teardown settles"
            );
            if (stopResult === "failure")
                f.stopRequests[0].reject(new Error("native teardown failed"));
            else f.stopRequests[0].resolve();
            await settle();
            assert.deepEqual(f.nativeCalls, [
                ["play", "A"],
                ["stop"],
                ["play", "C"],
            ]);
            assert.deepEqual(f.cssPlays, []);
            f.succeed(f.requests[1]);
            await settle();
            assert.equal(f.displays.at(-1), "none");
            f.stop();
            f.stopRequests[1].resolve();
            await settle();
            f.play("D");
            await settle();
            assert.deepEqual(f.nativeCalls.at(-1), ["play", "D"]);
            f.succeed(f.requests[2]);
            await settle();
            assert.deepEqual(f.cssPlays, [], "Settled queue can be reused");
        });
    }
}

const absolute = (value) => new URL(value, "https://fixture.invalid/").href;
for (const result of ["success", "failure", "unsupported"]) {
    test(`Tauri: stop cancels pending actual-playback wait (${result})`, async () => {
        const f = fixture("Tauri");
        f.play("A");
        await settle();
        assert.equal(f.requests.length, 1);
        f.stop();
        await settle();
        assert.deepEqual(
            f.nativeCalls,
            [["play", absolute("A")], ["stop"]],
            "Native cancellation must dispatch before playback acknowledgement"
        );
        const afterStop = f.displays.length;
        if (result === "failure") f.requests[0].reject(new Error("cancelled"));
        else if (result === "unsupported") f.requests[0].resolve({ ok: false });
        else f.succeed(f.requests[0]);
        await settle();
        assert.equal(f.displays.length, afterStop);
        assert.deepEqual(f.cssPlays, []);
        assert.deepEqual(f.boundsCalls, []);
    });
}
for (const result of ["success", "failure", "unsupported"]) {
    test(`Tauri: B immediately supersedes pending A (${result})`, async () => {
        const f = fixture("Tauri");
        f.play("A");
        await settle();
        f.play("B");
        await settle();
        assert.deepEqual(
            f.nativeCalls,
            [
                ["play", absolute("A")],
                ["play", absolute("B")],
            ],
            "The latest source must reach Rust while the previous decoder is pending"
        );
        const afterB = f.displays.length;
        if (result === "failure") f.requests[0].reject(new Error("superseded"));
        else if (result === "unsupported") f.requests[0].resolve({ ok: false });
        else f.succeed(f.requests[0]);
        await settle();
        assert.equal(f.displays.length, afterB);
        assert.deepEqual(f.cssPlays, []);
        assert.deepEqual(f.boundsCalls, []);
        f.succeed(f.requests[1]);
        await settle();
        assert.equal(f.displays.at(-1), "none");
        assert.deepEqual(
            f.boundsCalls,
            [{ position: 3, size: 1 }],
            "Only the current visible PiP receives the user's saved bounds"
        );
    });
}
test("Tauri: play → stop → play reaches Rust without waiting for old media", async () => {
    const f = fixture("Tauri");
    f.play("A");
    f.stop();
    f.play("B");
    await settle();
    assert.deepEqual(f.nativeCalls, [
        ["play", absolute("A")],
        ["stop"],
        ["play", absolute("B")],
    ]);
    f.succeed(f.requests[1]);
    await settle();
    const afterB = f.displays.length;
    f.requests[0].reject(new Error("A cancelled late"));
    await settle();
    assert.equal(f.displays.length, afterB);
    assert.deepEqual(f.cssPlays, []);
    assert.equal(f.boundsCalls.length, 1);
});
for (const failure of ["reject", "unsupported"]) {
    test(`Tauri: current ${failure} preserves the existing CSS fallback`, async () => {
        const f = fixture("Tauri");
        f.play("A");
        await settle();
        if (failure === "reject")
            f.requests[0].reject(new Error("decoder did not start"));
        else f.requests[0].resolve({ ok: false });
        await settle();
        assert.deepEqual(f.cssPlays, ["A"]);
        assert.equal(f.displays.at(-1), "css:A");
        assert.deepEqual(f.boundsCalls, []);
        f.stop();
        await settle();
        assert.equal(f.displays.at(-1), "stopped");
    });
}
test("Tauri: native request preserves engine and resolves a relative playlist URL", async () => {
    const f = fixture("Tauri");
    f.window.location.href = "https://fixture.invalid/player/index.html";
    f.window.playerMode = 3;
    f.play("../streams/list.m3u8?token=literal%2Bvalue");
    await settle();
    assert.equal(
        f.requests[0].url,
        "https://fixture.invalid/streams/list.m3u8?token=literal%2Bvalue"
    );
    assert.equal(f.requests[0].engine, 3);
});
test("Capacitor Android second-channel PiP never invokes Activity PiP", async () => {
    const f = fixture("Capacitor", "android");
    f.play("requested-A.m3u8");
    f.play("requested-B.m3u8");
    f.stop();
    await settle();
    assert.deepEqual(f.nativeCalls, []);
    assert.deepEqual(f.cssPlays, ["requested-A.m3u8", "requested-B.m3u8"]);
    assert.equal(
        f.cssStops,
        2,
        "replacement and final stop each release their CSS lease"
    );
    assert.equal(f.displays.at(-1), "stopped");
});

for (const mode of [1, 2]) {
    test(`Tauri: demo MP4 uses direct looping playback while preserving mode ${mode}`, async () => {
        const f = fixture("Tauri");
        f.window.playerMode = mode;
        f.window.ottplayDemoActive = true;
        f.play(
            "https://liminal-sketch-vv8r.here.now/demo/pattern.mp4?version=1"
        );
        await settle();
        assert.equal(f.requests[0].engine, 0);
        assert.equal(f.requests[0].loop, true);
        assert.equal(f.window.playerMode, mode);
        f.play("https://liminal-sketch-vv8r.here.now/demo/pattern.m3u8");
        await settle();
        assert.equal(f.requests[1].engine, mode);
        assert.equal(f.requests[1].loop, true);
        f.window.ottplayDemoActive = false;
        f.play("https://provider.invalid/movie.mp4");
        await settle();
        assert.equal(f.requests[2].engine, mode);
        assert.equal(f.requests[2].loop, false);
        assert.equal(f.window.playerMode, mode);
    });
}

for (const action of ["stop", "replace"]) {
    test(`Capacitor iOS: ${action} during source login cannot start the retired stream`, async () => {
        const f = fixture("Capacitor");
        const pending = [];
        const cancelled = [];
        f.window.Capacitor.Plugins = {
            AccessMedia: {
                cancelPrepare: ({ requestId }) => {
                    cancelled.push(requestId);
                    return Promise.resolve();
                },
                prepare: ({ url, requestId }) =>
                    new Promise((resolve) =>
                        pending.push({ requestId, resolve, url })
                    ),
            },
        };
        f.play("https://source.invalid/old.m3u8");
        await settle();
        assert.equal(pending.length, 1);
        assert.equal(f.requests.length, 0);
        if (action === "stop") f.stop();
        else f.play("https://source.invalid/new.m3u8");
        await settle();
        assert.deepEqual(
            cancelled,
            [pending[0].requestId],
            "retired sign-in reaches native cancellation"
        );
        if (action === "stop") {
            assert.deepEqual(
                f.nativeCalls,
                [["stop"]],
                "Stop must not wait for the sign-in prompt"
            );
        } else {
            assert.equal(
                pending.length,
                2,
                "the new source can prepare before the retired login finishes"
            );
        }
        pending[0].resolve({ url: pending[0].url });
        await settle();
        assert.equal(
            f.requests.length,
            0,
            "old auth callback never reaches native playback"
        );
        if (action === "replace") {
            assert.equal(pending.length, 2);
            pending[1].resolve({ url: pending[1].url });
            await settle();
            assert.equal(f.requests.length, 1);
            assert.equal(f.requests[0].url, "https://source.invalid/new.m3u8");
        }
        assert.deepEqual(f.cssPlays, []);
    });
}

test("Capacitor iOS: rejected source sign-in never starts CSS fallback", async () => {
    const f = fixture("Capacitor");
    f.window.Capacitor.Plugins = {
        AccessMedia: {
            prepare: () =>
                Promise.reject(new Error("Source sign-in cancelled")),
        },
    };
    f.play("https://source.invalid/private.m3u8");
    await settle();
    assert.deepEqual(f.nativeCalls, []);
    assert.deepEqual(f.cssPlays, []);
});

for (const result of ["success", "failure"]) {
    test(`Capacitor iOS: playing A stops while replacement B awaits sign-in (${result})`, async () => {
        const f = fixture("Capacitor");
        const old = "https://source.invalid/A.m3u8";
        const next = "https://source.invalid/B.m3u8";
        f.play(old);
        await settle();
        f.succeed(f.requests[0]);
        await settle();
        let resolve, reject;
        f.window.Capacitor.Plugins = {
            AccessMedia: {
                prepare: () =>
                    new Promise((yes, no) => {
                        resolve = yes;
                        reject = no;
                    }),
            },
        };
        f.play(next);
        await settle();
        assert.deepEqual(
            f.nativeCalls,
            [["play", old], ["stop"]],
            "The replaced decoder stops without waiting for B's login"
        );
        if (result === "failure") reject(new Error("Sign-in cancelled"));
        else resolve({ url: next });
        await settle();
        assert.deepEqual(
            f.nativeCalls,
            result === "failure"
                ? [["play", old], ["stop"]]
                : [["play", old], ["stop"], ["play", next]]
        );
        assert.deepEqual(f.cssPlays, []);
    });
}

for (const result of ["failure", "unsupported"]) {
    test(`Capacitor iOS: prepared source survives native ${result} into CSS fallback`, async () => {
        const f = fixture("Capacitor");
        const source = "https://source.invalid/protected.m3u8";
        const local =
            "http://127.0.0.1:12345/access/" +
            "a".repeat(43) +
            "/fixture/media.m3u8";
        f.window.Capacitor.Plugins = {
            AccessMedia: { prepare: () => Promise.resolve({ url: local }) },
        };
        f.play(source);
        await settle();
        assert.equal(f.requests[0].url, local);
        if (result === "failure")
            f.requests[0].reject(new Error("Native decoder failed"));
        else f.requests[0].resolve({ ok: false });
        await settle();
        assert.deepEqual(f.cssPlays, [local]);
        f.stop();
        await settle();
        assert.equal(f.displays.at(-1), "stopped");
        assert.deepEqual(f.cssPlays, [local]);
    });
}

test("Capacitor iOS: shared HTTPS demo loops and real streams clear the native flag", async () => {
    const f = fixture("Capacitor", "ios");
    const base = "https://liminal-sketch-vv8r.here.now/demo/";
    f.window.ottplayDemoActive = true;
    for (const file of ["pattern.mp4", "pattern.m3u8"]) {
        f.play(base + file);
        await settle();
        const request = f.requests.at(-1);
        assert.equal(request.url, base + file);
        assert.equal(request.loop, true);
        f.succeed(request);
        await settle();
    }
    f.window.ottplayDemoActive = false;
    f.play("https://provider.invalid/live.m3u8");
    await settle();
    assert.equal(f.requests.at(-1).loop, false);
    assert.equal(f.requests.at(-1).url, "https://provider.invalid/live.m3u8");
    assert.deepEqual(f.cssPlays, []);
});

(async () => {
    let failures = 0;
    for (const { name, run } of tests) {
        try {
            await run();
            console.log(`PASS ${name}`);
        } catch (error) {
            failures++;
            console.error(`FAIL ${name}: ${error.message}`);
        }
    }
    assert.equal(
        failures,
        0,
        `${failures}/${tests.length} actual native PiP lifecycle scenarios failed`
    );
    console.log(
        `PASS all ${tests.length} actual native PiP lifecycle scenarios`
    );
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
