const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const acorn = require("acorn");
const { JSDOM } = require("jsdom");
const output = ts.transpileModule(
    fs.readFileSync("src/plugins/runtime-debug.ts", "utf8"),
    {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES5,
        },
    }
).outputText;
acorn.parse(output, { ecmaVersion: 5 });
const exportsObject = {};
vm.runInNewContext(output, { Date, exports: exportsObject, Promise });
const plain = (value) => JSON.parse(JSON.stringify(value));
const secret = "https://private.invalid/?token=DO-NOT-EXPORT";
function fixture(native) {
    const w = new JSDOM("<!doctype html><video id='video'></video>").window;
    let time = 100,
        serial = 0,
        currentRuntime = "runtime-1";
    const timers = new Map();
    let config = { address: secret, enabled: false, token: secret };
    w.performance.now = () => time;
    w.setTimeout = (fn, delay) => {
        const id = ++serial;
        timers.set(id, { at: time + delay, fn });
        return id;
    };
    w.clearTimeout = (id) => timers.delete(id);
    Object.defineProperty(w.document, "visibilityState", {
        configurable: true,
        value: "visible",
    });
    w.document.hasFocus = () => true;
    w.fetch = w.__ottCoreBackend = () => {
        throw new Error("unexpected mutation/network");
    };
    w.__ottClassicPlayback = {
        snapshot: () => ({ generation: 7, token: secret }),
    };
    w.__ottCoreBackendPeek = () => ({ current: () => ({ id: 9 }) });
    const media = w.document.getElementById("video");
    Object.defineProperties(media, {
        buffered: { value: { end: () => 15, length: 1, start: () => 0 } },
        currentSrc: {
            get() {
                throw new Error("must never read source");
            },
        },
        currentTime: { configurable: true, value: 12 },
        duration: { configurable: true, value: Infinity },
        networkState: { value: 2 },
        readyState: { value: 4 },
        videoHeight: { value: 1080 },
        videoWidth: { value: 1920 },
    });
    media.getVideoPlaybackQuality = () => ({
        corruptedVideoFrames: NaN,
        droppedVideoFrames: 5,
        totalVideoFrames: 234,
    });
    const api = exportsObject.installRuntimeDebug(w, {
        getConfig: () => config,
        native,
        runtime: () => currentRuntime,
    });
    function enable() {
        config.enabled = true;
        api.configurationChanged();
    }
    function fire(at) {
        time = at;
        const ready = [...timers].filter(([, timer]) => timer.at <= time);
        for (const [id, timer] of ready) if (timers.delete(id)) timer.fn();
    }
    return {
        api,
        close: () => {
            api.dispose();
            w.close();
        },
        enable,
        fire,
        media,
        replace: (value) => {
            config = value;
            api.configurationChanged();
        },
        runtime: (value) => {
            currentRuntime = value;
        },
        timers,
        w,
    };
}
const producer = {
    appVersion: "1.2.3",
    metrics: {
        foreground: true,
        password: secret,
        pssBytes: 1200,
        residentBytes: -1,
    },
    osVersion: "10",
    platform: "android",
    token: secret,
    version: 1,
    webviewVersion: null,
};
let groups = 0;
async function test(name, run) {
    await run();
    groups++;
    console.log("ok - " + name);
}
(async () => {
    await test("disabled connection has no timer or observation authority", async () => {
        const f = fixture();
        assert.equal(f.timers.size, 0);
        await assert.rejects(f.api.snapshot(), /unavailable/);
        f.close();
    });
    await test("bounded pre-failure history records classifications, never event contents", async () => {
        const f = fixture();
        f.enable();
        for (let i = 0; i < 50; i++)
            f.w.dispatchEvent(
                new f.w.ErrorEvent("error", {
                    filename: secret,
                    message: secret,
                })
            );
        f.w.dispatchEvent(new f.w.Event("unhandledrejection"));
        const data = plain(await f.api.snapshot());
        assert.equal(data.events.length, 32);
        assert.equal(data.eventsDropped, 20);
        assert.equal(data.metrics.errorCount, 50);
        assert.equal(data.metrics.rejectionCount, 1);
        assert.equal(data.events.at(-1).code, "unhandled_rejection");
        assert(!JSON.stringify(data).includes("private"));
        assert(
            data.events.every(
                (e, i, es) => !i || es[i - 1].sequence < e.sequence
            )
        );
        f.close();
    });
    await test("engine identity accepts only the attached owner's bounded enum", async () => {
        const f = fixture();
        f.enable();
        for (const engine of [
            "hls.js",
            "shaka",
            "html5",
            null,
            secret,
            "auto",
            {},
        ]) {
            f.w.__ottCoreBackendPeek = () => ({
                current: () => ({ diagnosticEngine: () => engine, id: 9 }),
            });
            const data = plain(await f.api.snapshot(2));
            assert.equal(data.version, 2);
            assert.equal(
                data.media[0].engine,
                ["hls.js", "shaka", "html5"].includes(engine) ? engine : null
            );
            assert(!JSON.stringify(data).includes(secret));
        }
        f.w.__ottCoreBackendPeek = () => ({ current: () => null });
        assert.equal((await f.api.snapshot(2)).media[0].engine, null);
        const legacy = plain(await f.api.snapshot());
        assert.equal(legacy.version, 1);
        assert(!Object.hasOwn(legacy.media[0], "engine"));
        for (const version of [0, 4, "2", "3", null, true])
            await assert.rejects(f.api.snapshot(version), /invalid_request/);
        f.close();
    });
    await test("attempt counters are bounded, complete, copied and absent from debug v1/v2", async () => {
        const f = fixture();
        f.enable();
        const counters = {
            attachment: 1,
            engineStarts: 3,
            fatalErrors: 2,
            nativeFallbacks: 1,
            streamRetries: 1,
        };
        let value = { ...counters, url: secret };
        let reads = 0;
        f.w.__ottCoreBackendPeek = () => ({
            current: () => ({
                diagnosticAttempt() {
                    reads++;
                    return value;
                },
                diagnosticEngine: () => "hls.js",
                id: 9,
            }),
        });
        const before = reads;
        for (const version of [1, 2]) {
            const legacy = plain(await f.api.snapshot(version));
            assert.equal(
                reads,
                before,
                "legacy versions never call the new producer"
            );
            assert.deepEqual(
                Object.keys(legacy.media[0]).sort(),
                (version === 1
                    ? ["generation", "handleId", "lane", "metrics"]
                    : ["engine", "generation", "handleId", "lane", "metrics"]
                ).sort()
            );
        }
        const modern = plain(await f.api.snapshot(3));
        assert.deepEqual(modern.media[0].attempt, counters);
        assert(!JSON.stringify(modern).includes(secret));
        for (const bad of [
            -1,
            0.5,
            Infinity,
            NaN,
            9007199254740992,
            "1",
            null,
        ]) {
            value = { ...counters, streamRetries: bad };
            assert.equal((await f.api.snapshot(3)).media[0].attempt, null);
        }
        value = { ...counters };
        delete value.nativeFallbacks;
        assert.equal((await f.api.snapshot(3)).media[0].attempt, null);
        value = null;
        assert.equal((await f.api.snapshot(3)).media[0].attempt, null);
        f.close();
    });
    await test("retired attempt projection survives missing handle and sanitizes history", async () => {
        const f = fixture();
        f.enable();
        const final = {
            attachment: 1,
            engineStarts: 3,
            fatalErrors: 2,
            generation: 7,
            handleId: 9,
            nativeFallbacks: 1,
            reason: "ended",
            streamRetries: 1,
        };
        let value = { ...final, url: secret };
        f.w.__ottCoreBackendPeek = () => ({
            current: () => null,
            lastAttempt: () => value,
        });
        const data = plain(await f.api.snapshot(3));
        assert.equal(data.media[0].attempt, null);
        assert.deepEqual(data.media[0].lastAttempt, final);
        assert(!JSON.stringify(data).includes(secret));
        for (const patch of [
            { reason: secret },
            { handleId: -1 },
            { generation: "7" },
            { streamRetries: Infinity },
        ]) {
            value = { ...final, ...patch };
            assert.equal((await f.api.snapshot(3)).media[0].lastAttempt, null);
        }
        f.close();
    });
    await test("read-only media counters retain identity and omit unavailable numeric values", async () => {
        const f = fixture();
        f.enable();
        const data = plain(await f.api.snapshot());
        assert.deepEqual(data.media[0], {
            generation: 7,
            handleId: 9,
            lane: "main",
            metrics: {
                bufferAheadSeconds: 3,
                droppedFrames: 5,
                ended: false,
                muted: false,
                networkState: 2,
                paused: true,
                positionSeconds: 12,
                readyState: 4,
                seeking: false,
                totalFrames: 234,
                videoHeight: 1080,
                videoWidth: 1920,
                volume: 1,
            },
        });
        assert.equal(data.native.state, "unsupported");
        f.media.getVideoPlaybackQuality = undefined;
        f.media.webkitDecodedFrameCount = 42;
        assert.equal(
            (await f.api.snapshot()).media[0].metrics.decodedFrames,
            42
        );
        f.close();
    });
    await test("foreground lag is measured; hidden and suspended intervals are not false stalls", async () => {
        const f = fixture();
        f.enable();
        f.fire(1100);
        f.fire(3100);
        let data = await f.api.snapshot();
        assert.equal(data.metrics.loopDelayMs, 1000);
        assert.equal(data.metrics.loopLongDelays, 1);
        Object.defineProperty(f.w.document, "visibilityState", {
            configurable: true,
            value: "hidden",
        });
        f.w.document.dispatchEvent(new f.w.Event("visibilitychange"));
        f.fire(100000);
        assert.equal((await f.api.snapshot()).metrics.loopLongDelays, 1);
        f.w.dispatchEvent(new f.w.Event("pagehide"));
        assert.equal(f.timers.size, 0);
        await assert.rejects(f.api.snapshot(), /unavailable/);
        f.w.dispatchEvent(new f.w.Event("pageshow"));
        assert.equal(f.timers.size, 1);
        f.close();
    });
    await test("credential change clears history and disabled/disposed collector removes listeners", async () => {
        const f = fixture();
        f.enable();
        f.w.dispatchEvent(new f.w.Event("error"));
        f.replace({
            address: "https://new.invalid",
            enabled: true,
            token: "new",
        });
        let data = await f.api.snapshot();
        assert.equal(data.events.length, 1);
        assert.equal(data.metrics.errorCount, 0);
        assert.equal(f.timers.size, 1);
        f.replace({ enabled: false });
        assert.equal(f.timers.size, 0);
        f.w.dispatchEvent(new f.w.Event("error"));
        await assert.rejects(f.api.snapshot());
        f.close();
        assert.equal(f.timers.size, 0);
    });
    await test("native producer is allowlisted, correctly labelled and no invalid memory values escape", async () => {
        const f = fixture(() => Promise.resolve(producer));
        f.w.Capacitor = { getPlatform: () => "android" };
        f.enable();
        const data = plain(await f.api.snapshot());
        assert.equal(data.platform, "capacitor-android");
        assert.equal(data.native.state, "available");
        assert.deepEqual(data.native.data.metrics, {
            foreground: true,
            pssBytes: 1200,
        });
        assert(!JSON.stringify(data).includes("private"));
        f.close();
        assert.equal(
            exportsObject.projectNativeDebug({
                metrics: {},
                platform: "evil",
                version: 1,
            }),
            null
        );
    });
    await test("native deadline returns web evidence and prevents unbounded hung native requests", async () => {
        let resolve,
            calls = 0;
        const f = fixture(() => {
            calls++;
            return new Promise((r) => {
                resolve = r;
            });
        });
        f.w.Capacitor = { getPlatform: () => "android" };
        f.enable();
        const pending = f.api.snapshot();
        f.fire(1600);
        const data = await pending;
        assert.equal(data.native.state, "timeout");
        assert.equal(data.media.length, 1);
        assert.equal((await f.api.snapshot()).native.state, "unavailable");
        assert.equal(calls, 1);
        resolve(producer);
        await Promise.resolve();
        await Promise.resolve();
        f.close();
    });
    await test("native response from retired connection is rejected rather than relabelled", async () => {
        let resolve;
        const f = fixture(
            () =>
                new Promise((r) => {
                    resolve = r;
                })
        );
        f.w.Capacitor = { getPlatform: () => "android" };
        f.enable();
        const pending = f.api.snapshot();
        const rejected = assert.rejects(pending, /unavailable/);
        f.replace({ address: "new", enabled: true, token: "new" });
        await rejected;
        resolve(producer);
        await Promise.resolve();
        await Promise.resolve();
        assert.equal(f.timers.size, 1);
        f.close();
    });
    await test("wrong native platform is invalid and runtime replacement cancels its result", async () => {
        const f = fixture(() =>
            Promise.resolve({ ...producer, platform: "ios" })
        );
        f.w.Capacitor = { getPlatform: () => "android" };
        f.enable();
        assert.equal((await f.api.snapshot()).native.state, "invalid");
        f.close();
        let resolve;
        const g = fixture(
            () =>
                new Promise((r) => {
                    resolve = r;
                })
        );
        g.w.__TAURI__ = {};
        g.enable();
        const pending = g.api.snapshot();
        g.runtime("runtime-2");
        resolve({ ...producer, platform: "tauri" });
        await assert.rejects(pending, /unavailable/);
        g.close();
    });
    await test("immediate web and busy-native results reject synchronous connection replacement", async () => {
        for (const native of [undefined, () => new Promise(() => {})]) {
            const f = fixture(native);
            if (native) f.w.Capacitor = { getPlatform: () => "android" };
            f.enable();
            if (native) {
                const first = f.api.snapshot();
                f.fire(1600);
                await first;
            }
            const result = f.api.snapshot();
            f.replace({
                address: "replacement",
                enabled: true,
                token: "replacement",
            });
            await assert.rejects(result, /unavailable/);
            f.close();
        }
    });
    await test("PiP does not borrow main playback generation", async () => {
        const f = fixture();
        f.enable();
        const pip = f.w.document.createElement("video");
        pip.id = "videopip";
        f.w.document.body.appendChild(pip);
        const before = await f.api.snapshot();
        f.w.__ottClassicPlayback.snapshot = () => ({ generation: 99 });
        const after = await f.api.snapshot();
        assert.equal(before.media[1].generation, null);
        assert.equal(after.media[1].generation, null);
        assert.equal(after.media[0].generation, 99);
        assert.equal(before.media[1].handleId, after.media[1].handleId);
        f.close();
    });
    console.log(`${groups} runtime debug groups passed`);
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
