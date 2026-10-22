const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const acorn = require("acorn");
const tick = () => new Promise((resolve) => setImmediate(resolve));
function emit(file) {
    const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES5,
        },
    }).outputText;
    acorn.parse(code, { ecmaVersion: 5 });
    return code;
}
let wallClock = 1800000000000;
const exports_ = {};
vm.runInNewContext(emit("src/plugins/remote-screenshot.ts"), {
    Date: { now: () => wallClock },
    exports: exports_,
    URL,
});
const install = exports_.installRemoteScreenshot;
const plain = (x) => JSON.parse(JSON.stringify(x));
const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=";
const image = {
    height: 1,
    image: png,
    source: "player-view",
    video: "unknown",
    width: 1,
};
function deferred() {
    let resolve, reject;
    const promise = new Promise((a, b) => {
        resolve = a;
        reject = b;
    });
    return { promise, reject, resolve };
}
function harness(native = true, extra = {}, mobile) {
    let now = 1000,
        revision = 1,
        protectedUI = false;
    let config = {
        address: "https://controller.example",
        enabled: true,
        token: "D".repeat(32),
    };
    const timers = new Map(),
        calls = [],
        observers = [];
    const nativeReply = deferred();
    let screenshot = () => Promise.resolve({ ...image });
    const doc = {
        documentElement: {},
        hidden: false,
        querySelectorAll: () =>
            protectedUI ? [{ getClientRects: () => [1] }] : [],
    };
    const w = {
        __ottClassicScreenPort: { revision: () => revision },
        addEventListener: (event, fn) => calls.push([event, fn]),
        atob: (x) => Buffer.from(x, "base64").toString("binary"),
        cancelAnimationFrame() {},
        clearTimeout: (id) => timers.delete(id),
        document: doc,
        getComputedStyle: () => ({ visibility: "visible" }),
        MutationObserver: class {
            constructor(fn) {
                this.fn = fn;
                observers.push(this);
            }
            observe() {}
            disconnect() {
                this.dead = true;
            }
        },
        performance: { now: () => now },
        requestAnimationFrame: (fn) => {
            fn();
            return 1;
        },
        setTimeout: (fn, ms) => {
            const id = {};
            timers.set(id, { fn, ms });
            return id;
        },
        ...extra,
    };
    if (native)
        w.__TAURI__ = {
            core: {
                invoke: (command, args) => {
                    calls.push(command);
                    assert.deepEqual(plain(args), {});
                    return command === "screenshot_capabilities"
                        ? nativeReply.promise
                        : screenshot();
                },
            },
        };
    const statuses = [];
    const hook = install(w, {
        getConfig: () => config,
        mobile,
        onStatus: (x) => statuses.push(plain(x)),
    });
    return {
        accept: async () => {
            nativeReply.resolve({ source: "player-view", supported: true });
            await tick();
        },
        advance: (value) => (now += value),
        calls,
        capture: () => new Promise((resolve) => hook.capture(resolve)),
        config: (value) => (config = { ...config, ...value }),
        event: (name) => {
            for (const entry of calls)
                if (Array.isArray(entry) && entry[0] === name)
                    entry[1]({ persisted: true });
        },
        hook,
        mutations: () =>
            observers.forEach((o) => {
                if (!o.dead) o.fn();
            }),
        nativeReply,
        protected: (yes) => (protectedUI = yes),
        revise: () => revision++,
        screenshot: (value) => (screenshot = value),
        statuses,
        timeout: (ms) => {
            for (const [id, t] of timers) {
                if (t.ms === ms) {
                    timers.delete(id);
                    t.fn();
                    return;
                }
            }
            throw Error("missing timer " + ms);
        },
        timers,
        w,
        wall: (value) => (wallClock += value),
    };
}
let count = 0;
async function test(name, fn) {
    await fn();
    count++;
    console.log("PASS " + name);
}
(async () => {
    await test("doctor peek reads capabilities without syncing or releasing a source", async () => {
        const native = harness();
        assert.equal(
            native.hook.peek().known,
            false,
            "Pending native probe is unknown"
        );
        assert.equal(native.hook.peek().busy, true);
        await native.accept();
        assert.equal(native.hook.peek().ready, true);
        assert.equal(native.hook.peek().state, "ready");
        assert.equal(native.hook.peek().source, "player-view");
        const calls = native.calls.length;
        const statuses = native.statuses.length;
        native.config({ token: "E".repeat(32) });
        assert.equal(
            native.hook.peek().known,
            false,
            "Changed connection must not inherit cached ready state"
        );
        assert.equal(native.hook.peek().ready, false);
        assert.equal(native.hook.peek().state, "permission_required");
        assert.equal(native.hook.peek().source, null);
        assert.equal(native.calls.length, calls);
        assert.equal(native.statuses.length, statuses);

        let stopped = 0;
        let prompts = 0;
        const track = {
            addEventListener() {},
            getSettings: () => ({ displaySurface: "browser" }),
            readyState: "live",
            stop: () => stopped++,
        };
        const stream = {
            active: true,
            getAudioTracks: () => [],
            getTracks: () => [track],
            getVideoTracks: () => [track],
        };
        const browser = harness(false, {
            ImageCapture: class {
                grabFrame() {}
            },
            isSecureContext: true,
            navigator: {
                mediaDevices: {
                    getDisplayMedia: () => {
                        prompts++;
                        return Promise.resolve(stream);
                    },
                },
            },
        });
        assert.equal(browser.hook.peek().needsSourceSelection, true);
        assert.equal(prompts, 0);
        browser.hook.selectSource(true);
        await tick();
        assert.equal(browser.hook.peek().ready, true);
        assert.equal(browser.hook.peek().state, "ready");
        assert.equal(browser.hook.peek().source, "browser-tab");
        browser.config({ address: "https://other.example" });
        assert.equal(browser.hook.peek().known, false);
        assert.equal(browser.hook.peek().state, "permission_required");
        assert.equal(browser.hook.peek().source, null);
        assert.equal(
            stopped,
            0,
            "Read-only peek must not stop selected tracks"
        );
        assert.equal(prompts, 1);
        browser.hook.configurationChanged();
        assert.equal(
            stopped,
            1,
            "Normal lifecycle still retires the old source"
        );
    });
    await test("connected native probe is read-only and automatically enables screenshots", async () => {
        const h = harness();
        assert.equal(h.hook.snapshot().state, "unsupported");
        await h.accept();
        assert.deepEqual(plain(h.hook.snapshot()), {
            source: "player-view",
            state: "ready",
        });
        assert.equal(h.calls.includes("capture_screenshot"), false);
        assert.equal(h.hook.status().connected, true);
        assert.equal(h.hook.status().browserSelectionSupported, false);
        assert.equal(h.hook.status().needsSourceSelection, false);
        h.w.__ottRemoteInputActive = true;
        assert.deepEqual(plain((await h.capture()).data), image);
        assert.equal(h.hook.grant, undefined);
    });
    await test("native authority follows connection across time, stop, reconfiguration and reload", async () => {
        const h = harness();
        await h.accept();
        h.advance(86400000);
        h.wall(86400000);
        assert.equal((await h.capture()).status, "ok");
        h.wall(-86400001);
        assert.equal((await h.capture()).status, "ok");
        assert.equal(
            h.timers.size,
            0,
            "No application permission expiry timer"
        );
        h.hook.stop();
        assert.equal(h.hook.snapshot().state, "ready");
        h.config({ enabled: false });
        h.hook.configurationChanged();
        assert.equal(h.hook.status().connected, false);
        assert.equal((await h.capture()).status, "rejected");
        h.config({ enabled: true, token: "E".repeat(32) });
        h.hook.configurationChanged();
        assert.equal((await h.capture()).status, "ok");
        h.config({ address: "https://other.example" });
        assert.equal((await h.capture()).status, "ok");
        const reloaded = harness();
        await reloaded.accept();
        assert.equal((await reloaded.capture()).status, "ok");
    });
    await test("invalid or disconnected controller cannot capture and exact loopback remains valid", async () => {
        for (const config of [
            { enabled: false },
            { token: "short" },
            { address: "http://controller.example" },
            { address: "http://127.0.0.2" },
            { address: "https://user:password@controller.example" },
            { address: "https://controller.example/#fragment" },
            { address: "not a URL" },
        ]) {
            const h = harness();
            await h.accept();
            h.config(config);
            assert.equal(h.hook.status().connected, false);
            assert.equal((await h.capture()).status, "rejected");
            assert.equal(h.calls.includes("capture_screenshot"), false);
        }
        for (const address of [
            "http://localhost:9876",
            "http://127.0.0.1:9876",
            "http://[::1]:9876",
        ]) {
            const h = harness();
            await h.accept();
            h.config({ address });
            assert.equal((await h.capture()).status, "ok");
        }
    });
    await test("connected controller can diagnose PIN, settings, input and background views", async () => {
        const h = harness();
        await h.accept();
        h.protected(true);
        h.w.document.hidden = true;
        h.w.__ottParental = { needs: () => true };
        h.w.__ottClassicScreenPort.screens = {
            current: () => ({ model: { localOnlyInput: true } }),
        };
        h.w.__ottClassicScreenPort.listOwner = () => ({
            model: { localOnlyInput: true },
        });
        assert.equal((await h.capture()).status, "ok");
        const d = deferred();
        h.screenshot(() => d.promise);
        const pending = h.capture();
        h.revise();
        h.mutations();
        h.protected(false);
        d.resolve(image);
        assert.equal((await pending).status, "ok");
    });
    await test("configuration, runtime disposal and bridge changes discard pending native images", async () => {
        for (const change of [
            (h) => h.hook.stop(),
            (h) => h.hook.configurationChanged(),
            (h) => h.config({ enabled: false }),
            (h) => h.config({ token: "E".repeat(32) }),
            (h) => h.config({ address: "https://other.example" }),
            (h) => {
                h.w.__TAURI__ = {};
            },
            (h) => {
                h.w.__ottRemoteScreenshot = {};
            },
            (h) =>
                h.calls.find(
                    (entry) => Array.isArray(entry) && entry[0] === "pagehide"
                )[1](),
            (h) => {
                h.config({ enabled: false });
                h.hook.configurationChanged();
                h.config({ enabled: true });
                h.hook.configurationChanged();
            },
        ]) {
            const h = harness();
            await h.accept();
            const d = deferred();
            h.screenshot(() => d.promise);
            const pending = h.capture();
            change(h);
            d.resolve(image);
            const result = await pending;
            assert.equal(result.status, "rejected");
            assert.equal(JSON.stringify(result).includes(png), false);
        }
    });
    await test("BFCache resume restores native connection authority without stale images", async () => {
        const h = harness();
        await h.accept();
        const old = deferred();
        h.screenshot(() => old.promise);
        const pending = h.capture();
        h.event("pagehide");
        assert.equal(h.hook.status().connected, false);
        h.event("pageshow");
        assert.equal(h.hook.snapshot().state, "ready");
        old.resolve(image);
        const result = await pending;
        assert.equal(result.status, "rejected");
        assert.equal(JSON.stringify(result).includes(png), false);
        h.screenshot(() => Promise.resolve(image));
        assert.equal((await h.capture()).status, "ok");

        const probing = harness();
        probing.event("pagehide");
        await probing.accept();
        assert.equal(probing.hook.status().connected, false);
        probing.event("pageshow");
        assert.equal(probing.hook.snapshot().state, "ready");
        assert.equal(probing.calls.includes("capture_screenshot"), false);
        assert.equal((await probing.capture()).status, "ok");

        const replaced = harness();
        await replaced.accept();
        replaced.event("pagehide");
        const statuses = replaced.statuses.length;
        replaced.w.__ottRemoteScreenshot = {};
        replaced.event("pageshow");
        assert.equal(replaced.statuses.length, statuses);
        assert.equal((await replaced.capture()).status, "rejected");
    });
    await test("BFCache resume requires a new browser source without restoring old selection", async () => {
        let prompts = 0,
            stopped = 0;
        const selections = [];
        const track = {
            addEventListener() {},
            getSettings: () => ({ displaySurface: "browser" }),
            readyState: "live",
            stop: () => stopped++,
        };
        const stream = {
            active: true,
            getAudioTracks: () => [],
            getTracks: () => [track],
            getVideoTracks: () => [track],
        };
        const h = harness(false, {
            ImageCapture: class {
                grabFrame() {}
            },
            isSecureContext: true,
            navigator: {
                mediaDevices: {
                    getDisplayMedia: () => {
                        prompts++;
                        const selection = deferred();
                        selections.push(selection);
                        return selection.promise;
                    },
                },
            },
        });
        h.hook.selectSource(true);
        selections[0].resolve(stream);
        await tick();
        assert.equal(h.hook.snapshot().state, "ready");
        h.event("pagehide");
        assert.equal(stopped, 1);
        assert.equal(h.hook.status().connected, false);
        h.event("pageshow");
        assert.equal(h.hook.status().connected, true);
        assert.equal(h.hook.status().needsSourceSelection, true);
        assert.equal(h.hook.snapshot().source, null);
        assert.equal(h.hook.snapshot().state, "permission_required");
        assert.equal(prompts, 1, "Resuming never prompts through the OS");
        h.hook.selectSource(true);
        h.event("pagehide");
        h.event("pageshow");
        selections[1].resolve(stream);
        await tick();
        assert.equal(stopped, 2, "Pre-suspension picker result is stopped");
        assert.equal(h.hook.snapshot().state, "permission_required");
        h.hook.selectSource(true);
        selections[2].resolve(stream);
        await tick();
        assert.equal(prompts, 3);
        assert.equal(h.hook.snapshot().state, "ready");
    });
    await test("Capacitor uses the same connection authority without an application grant", async () => {
        let captures = 0;
        const h = harness(
            false,
            {
                Capacitor: {
                    isNativePlatform: () => true,
                    isPluginAvailable: () => true,
                },
            },
            {
                capabilities: () =>
                    Promise.resolve({ source: "player-view", supported: true }),
                capture: () => {
                    captures++;
                    return Promise.resolve({ ...image, video: "excluded" });
                },
            }
        );
        await tick();
        assert.equal(h.hook.snapshot().state, "ready");
        assert.equal(h.hook.status().browserSelectionSupported, false);
        assert.equal((await h.capture()).data.video, "excluded");
        assert.equal(captures, 1);
        h.config({ enabled: false });
        assert.equal((await h.capture()).status, "rejected");
        assert.equal(captures, 1);
    });
    await test("single flight and timeout keep pending native callbacks bounded", async () => {
        const h = harness();
        await h.accept();
        h.hook.selectSource(true);
        const d = deferred();
        h.screenshot(() => d.promise);
        const first = h.capture();
        assert.equal((await h.capture()).status, "rejected");
        h.timeout(12000);
        assert.equal((await first).status, "rejected");
        assert.equal((await h.capture()).status, "rejected");
        d.resolve(image);
        await tick();
        h.screenshot(() => Promise.resolve(image));
        assert.equal((await h.capture()).status, "ok");
    });
    await test("cancelled request discards callback and new capture waits for native drain", async () => {
        const h = harness();
        await h.accept();
        h.hook.selectSource(true);
        const d = deferred();
        h.screenshot(() => d.promise);
        let replies = 0;
        const cancel = h.hook.capture(() => replies++);
        cancel();
        assert.equal((await h.capture()).status, "rejected");
        d.resolve(image);
        await tick();
        assert.equal(replies, 0);
    });
    await test("native output is bounded, dimension checked and cannot carry metadata injection", async () => {
        for (const bad of [
            { ...image, width: 2 },
            { ...image, width: 1281 },
            { ...image, image: png + "junk" },
            { ...image, image: "x".repeat(1398108) },
            { ...image, source: "display" },
            { ...image, video: "included" },
            { ...image, secret: "never relay" },
            { ...image, image: Buffer.from("not PNG").toString("base64") },
        ]) {
            const h = harness();
            await h.accept();
            h.hook.selectSource(true);
            h.screenshot(() => Promise.resolve(bad));
            assert.equal((await h.capture()).status, "rejected");
        }
    });
    await test("browser capture never prompts remotely and stale/late selection is stopped", async () => {
        const d = deferred();
        let prompts = 0,
            stopped = 0;
        const h = harness(false, {
            ImageCapture: class {
                grabFrame() {}
            },
            isSecureContext: true,
            navigator: {
                mediaDevices: {
                    getDisplayMedia: (options) => {
                        prompts++;
                        assert.equal(options.audio, false);
                        return d.promise;
                    },
                },
            },
        });
        assert.equal(h.hook.snapshot().state, "permission_required");
        assert.equal((await h.capture()).status, "rejected");
        assert.equal(prompts, 0);
        assert.equal(h.hook.status().browserSelectionSupported, true);
        assert.equal(h.hook.status().needsSourceSelection, true);
        h.hook.selectSource(false);
        h.w.__ottRemoteInputActive = true;
        h.hook.selectSource(true);
        h.w.__ottRemoteInputActive = false;
        h.config({ enabled: false });
        assert.equal(h.hook.status().connected, false);
        h.hook.selectSource(true);
        assert.equal(prompts, 0);
        h.config({ enabled: true });
        h.hook.selectSource(true);
        assert.equal(prompts, 1);
        h.hook.stop();
        d.resolve({ getTracks: () => [{ stop: () => stopped++ }] });
        await tick();
        assert.equal(stopped, 1);
        assert.equal(h.hook.status().enabled, false);
    });
    await test("browser picker and selected stream remain bound to one controller connection", async () => {
        for (const change of [
            (h) => h.config({ enabled: false }),
            (h) => h.config({ token: "E".repeat(32) }),
            (h) => h.config({ address: "https://other.example" }),
            (h) => h.hook.configurationChanged(),
        ]) {
            let stopped = 0;
            const selection = deferred();
            const track = {
                addEventListener() {},
                getSettings: () => ({ displaySurface: "window" }),
                readyState: "live",
                stop: () => stopped++,
            };
            const stream = {
                active: true,
                getAudioTracks: () => [],
                getTracks: () => [track],
                getVideoTracks: () => [track],
            };
            const h = harness(false, {
                ImageCapture: class {
                    grabFrame() {}
                },
                isSecureContext: true,
                navigator: {
                    mediaDevices: { getDisplayMedia: () => selection.promise },
                },
            });
            h.hook.selectSource(true);
            assert.equal(h.hook.status().pending, true);
            change(h);
            selection.resolve(stream);
            await tick();
            assert.equal(stopped, 1);
            assert.equal(h.hook.status().pending, false);
            assert.equal(h.hook.snapshot().state, "permission_required");
            assert.equal(h.hook.snapshot().source, null);
        }
        let ended;
        let stopped = 0;
        const track = {
            addEventListener: (event, fn) => {
                if (event === "ended") ended = fn;
            },
            getSettings: () => ({ displaySurface: "browser" }),
            readyState: "live",
            stop: () => stopped++,
        };
        const stream = {
            active: true,
            getAudioTracks: () => [],
            getTracks: () => [track],
            getVideoTracks: () => [track],
        };
        const h = harness(false, {
            ImageCapture: class {
                grabFrame() {}
            },
            isSecureContext: true,
            navigator: {
                mediaDevices: {
                    getDisplayMedia: () => Promise.resolve(stream),
                },
            },
        });
        h.hook.selectSource(true);
        await tick();
        assert.equal(h.hook.snapshot().state, "ready");
        h.config({ token: "E".repeat(32) });
        assert.equal(h.hook.snapshot().state, "permission_required");
        assert.equal(stopped, 1);
        assert.equal(h.hook.snapshot().source, null);
        h.hook.selectSource(true);
        await tick();
        assert.equal(h.hook.snapshot().state, "ready");
        ended();
        assert.equal(h.hook.snapshot().state, "permission_required");
        assert.equal(h.hook.status().needsSourceSelection, true);
        assert.equal(stopped, 2);
    });
    await test("unsupported or insecure browser has no pretend image fallback", async () => {
        for (const extra of [
            {},
            {
                isSecureContext: false,
                navigator: {
                    mediaDevices: {
                        getDisplayMedia: () => {
                            throw Error("unexpected");
                        },
                    },
                },
            },
        ]) {
            const h = harness(false, extra);
            assert.equal(h.hook.snapshot().state, "unsupported");
            h.hook.selectSource(true);
            assert.equal(h.hook.status().enabled, false);
        }
    });
    await test("browser live frames survive visibility changes and close bitmaps on stop or timeout", async () => {
        const frames = [];
        let stops = 0,
            closed = 0;
        const track = {
            addEventListener() {},
            getSettings: () => ({ displaySurface: "browser" }),
            muted: false,
            readyState: "live",
            stop() {
                stops++;
                this.readyState = "ended";
            },
        };
        const stream = {
            active: true,
            getAudioTracks: () => [],
            getTracks: () => [track],
            getVideoTracks: () => [track],
        };
        const h = harness(false, {
            ImageCapture: class {
                grabFrame() {
                    const d = deferred();
                    frames.push(d);
                    return d.promise;
                }
            },
            isSecureContext: true,
            navigator: {
                mediaDevices: {
                    getDisplayMedia: () => {
                        track.readyState = "live";
                        return Promise.resolve(stream);
                    },
                },
            },
        });
        h.w.document.createElement = () => ({
            getContext: () => ({ drawImage() {} }),
            height: 0,
            toDataURL: () => "data:image/png;base64," + png,
            width: 0,
        });
        const bitmap = () => ({ close: () => closed++, height: 1, width: 1 });
        h.hook.selectSource(true);
        await tick();
        assert.equal(h.hook.snapshot().state, "ready");
        assert.equal(h.hook.status().needsSourceSelection, false);
        h.advance(86400000);
        h.wall(86400000);
        assert.equal(
            h.timers.size,
            0,
            "Browser selection has no application TTL"
        );
        assert.equal(h.hook.snapshot().state, "ready");
        h.w.requestAnimationFrame = () => {
            throw Error(
                "Background captures must not wait for animation frames"
            );
        };
        h.w.document.hidden = true;
        const first = h.capture();
        assert.equal(frames.length, 1);
        h.w.document.hidden = false;
        h.revise();
        frames[0].resolve(bitmap());
        assert.equal((await first).data.source, "browser-tab");
        assert.equal(closed, 1);
        const pending = h.hook.capture(() => {
            throw Error("cancelled image escaped");
        });
        h.hook.stop();
        h.hook.selectSource(true);
        await tick();
        const next = h.capture();
        frames[1].resolve(bitmap());
        await tick();
        assert.equal(
            (await h.capture()).status,
            "rejected",
            "old callback must not clear newer busy capture"
        );
        frames[2].resolve(bitmap());
        assert.equal((await next).status, "ok");
        const timed = h.capture();
        h.timeout(12000);
        assert.equal((await timed).status, "rejected");
        h.hook.stop();
        h.hook.selectSource(true);
        await tick();
        const retried = h.capture();
        frames[3].resolve(bitmap());
        frames[4].resolve(bitmap());
        assert.equal((await retried).status, "ok");
        assert.equal(closed, 5);
        assert.ok(stops >= 2);
        const animationFrames = [];
        h.w.requestAnimationFrame = (fn) => {
            animationFrames.push(fn);
            return animationFrames.length;
        };
        const visible = h.capture();
        assert.equal(frames.length, 5, "Visible capture waits for paint");
        animationFrames.shift()();
        assert.equal(frames.length, 5);
        animationFrames.shift()();
        assert.equal(frames.length, 6);
        frames[5].resolve(bitmap());
        assert.equal((await visible).status, "ok");
        assert.equal(h.timers.size, 0);

        const becomesHidden = h.capture();
        animationFrames.shift()();
        h.w.document.hidden = true;
        h.timeout(100);
        assert.equal(frames.length, 7, "Paused animation cannot block capture");
        animationFrames.shift()();
        assert.equal(frames.length, 7, "Late paint cannot double capture");
        frames[6].resolve(bitmap());
        assert.equal((await becomesHidden).status, "ok");
        assert.equal(h.timers.size, 0);

        h.w.document.hidden = false;
        h.w.requestAnimationFrame = undefined;
        const withoutAnimationAPI = h.capture();
        assert.equal(frames.length, 8);
        frames[7].resolve(bitmap());
        assert.equal((await withoutAnimationAPI).status, "ok");

        h.w.requestAnimationFrame = (fn) => {
            animationFrames.push(fn);
            return animationFrames.length;
        };
        h.hook.capture(() => {
            throw Error("cancelled paint wait escaped");
        });
        h.hook.stop();
        animationFrames.shift()();
        assert.equal(animationFrames.length, 0);
        assert.equal(frames.length, 8);
        assert.equal(h.timers.size, 0);
        pending();
    });
    await test("RPC requires the exact runtime and uses the existing controller connection", async () => {
        const commandExports = {};
        vm.runInNewContext(emit("src/commands/remote-screenshot.ts"), {
            exports: commandExports,
            require: () => ({
                remotePlayerInfo: () => ({ runtime: "runtime-1" }),
            }),
        });
        const h = harness();
        await h.accept();
        const exec = commandExports.executeRemoteScreenshot;
        function run(params) {
            return new Promise((resolve) => exec(h.w, params, resolve));
        }
        for (const params of [
            {},
            { runtime: "stale" },
            { extra: 1, runtime: "runtime-1" },
            [],
        ])
            assert.equal((await run(params)).status, "rejected");
        const result = await run({ runtime: "runtime-1" });
        assert.equal(result.status, "ok");
        assert.equal(result.data.runtime, "runtime-1");
        assert.equal(result.data.mime, "image/png");
        assert.equal(result.data.image, png);
        assert.equal(typeof result.data.captured_at, "number");
    });
    await test("native IPC grants both screenshot commands only to the main player", () => {
        const scope = JSON.parse(
            fs.readFileSync(
                "src-tauri/capabilities/remote-screenshot.json",
                "utf8"
            )
        );
        const normal = JSON.parse(
            fs.readFileSync("src-tauri/capabilities/default.json", "utf8")
        );
        const config = JSON.parse(
            fs.readFileSync("src-tauri/tauri.conf.json", "utf8")
        );
        const permissions = [
            "allow-screenshot-capabilities",
            "allow-capture-screenshot",
        ];
        assert.equal(scope.identifier, "remote-screenshot");
        assert.deepEqual(scope.windows, ["main"]);
        assert.equal(
            scope.webviews,
            undefined,
            "A webview wildcard would bypass the main-window scope"
        );
        assert.notEqual(scope.local, false);
        assert.deepEqual(scope.remote, normal.remote);
        assert.deepEqual(scope.permissions, permissions);
        assert.ok(
            !config.app.security.capabilities ||
                config.app.security.capabilities.includes(scope.identifier),
            "The packaged application must load the screenshot capability"
        );
        for (const name of permissions) {
            const permission = fs.readFileSync(
                "src-tauri/permissions/" + name + ".toml",
                "utf8"
            );
            const command = name.slice("allow-".length).replaceAll("-", "_");
            assert.match(
                permission,
                new RegExp('^identifier = "' + name + '"$', "m")
            );
            assert.match(
                permission,
                new RegExp('^commands\\.allow = \\["' + command + '"\\]$', "m")
            );
        }
        for (const file of fs.readdirSync("src-tauri/capabilities")) {
            if (!file.endsWith(".json") || file === "remote-screenshot.json")
                continue;
            const other = JSON.parse(
                fs.readFileSync("src-tauri/capabilities/" + file, "utf8")
            );
            for (const permission of other.permissions || []) {
                const identifier =
                    typeof permission === "string"
                        ? permission
                        : permission.identifier;
                assert.ok(
                    !permissions.includes(identifier),
                    file + " must not widen screenshot access"
                );
            }
        }
    });
    console.log("PASS remote screenshots: " + count + " behavior groups");
})().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
