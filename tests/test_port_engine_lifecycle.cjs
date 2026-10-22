const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const ActualHls = require("hls.js");
const root = path.resolve(__dirname, "..");
const source = [
    "src/core/standby.ts",
    "src/plugins/access-media.ts",
    "src/core/native-hls.ts",
    "src/playback/stream-policy.ts",
    "src/core/index.ts",
]
    .map((file) => fs.readFileSync(path.join(root, file), "utf8"))
    .join("\n");
const core = ts
    .transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.ES2015,
            target: ts.ScriptTarget.ES5,
        },
    })
    .outputText.replace(/^import .*\n/gm, "")
    .replace(/^export /gm, "");
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    promise.catch(() => {});
    return { promise, reject, resolve };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
function media() {
    const listeners = {};
    let src = "",
        time = 0;
    return {
        addEventListener(name, cb) {
            (listeners[name] ||= []).push(cb);
        },
        canPlayType() {
            return "probably";
        },
        get currentTime() {
            return time;
        },
        set currentTime(value) {
            this.seekWrites.push(value);
            if (this.blockEarlySeek && this.readyState === 0)
                throw new Error("InvalidStateError");
            time = value;
        },
        listeners,
        load() {
            this.loadCalls++;
            this.selectedResource = src;
        },
        loadCalls: 0,
        metadata() {
            this.readyState = 1;
            for (const cb of [...(listeners.loadedmetadata || [])]) cb();
        },
        pause() {
            this.paused = true;
        },
        paused: true,
        play() {
            this.playCalls++;
            this.paused = false;
        },
        playCalls: 0,
        readyState: 0,
        removeAttribute(name) {
            if (name === "src") src = "";
        },
        removeEventListener(name, cb) {
            listeners[name] = (listeners[name] || []).filter((x) => x !== cb);
        },
        seekWrites: [],
        selectedResource: "",
        get src() {
            return src;
        },
        set src(value) {
            src = value;
            this.selectedResource = value;
            time = 0;
            this.readyState = 0;
        },
    };
}
function fixture() {
    const styles = {};
    const players = [],
        shakas = [],
        errors = [],
        boxes = [],
        hidden = [];
    function Hls(config) {
        this.config = config;
        this.hasEnoughToStart = false;
        this.events = {};
        this.levels = [];
        this.audioTracks = [{ name: "A" }];
        this.subtitleTracks = [];
        this.audioTrack = 0;
        this.destroyCalls = 0;
        this.startLoads = [];
        players.push(this);
    }
    Hls.Events = {
        AUDIO_TRACKS_UPDATED: "audio",
        ERROR: "error",
        MANIFEST_PARSED: "manifest",
        SUBTITLE_TRACKS_UPDATED: "subtitles",
    };
    Hls.ErrorTypes = { MEDIA_ERROR: "media", NETWORK_ERROR: "network" };
    Hls.isSupported = () => true;
    Hls.prototype.on = function (name, cb) {
        this.events[name] = cb;
    };
    Hls.prototype.loadSource = function (url) {
        this.url = url;
    };
    Hls.prototype.attachMedia = function (m) {
        this.media = m;
    };
    Hls.prototype.destroy = function () {
        this.destroyCalls++;
        if (this.media) this.media.src = "";
    };
    Hls.prototype.recoverMediaError = function () {};
    Hls.prototype.removeLevel = function (i) {
        this.removed = i;
    };
    Hls.prototype.startLoad = function (position) {
        this.startLoads.push(position);
        this.activeStartPosition = position;
    };
    function Shaka(m) {
        this.media = m;
        this.attached = deferred();
        this.loaded = deferred();
        this.destroyed = deferred();
        this.destroyCalls = 0;
        shakas.push(this);
    }
    Shaka.isBrowserSupported = () => true;
    Shaka.prototype.configure = function (config) {
        this.config = config;
    };
    Shaka.prototype.addEventListener = function (type, callback) {
        this.events ||= {};
        this.events[type] = callback;
    };
    Shaka.prototype.attach = function (media) {
        this.media = media;
        return this.attached.promise;
    };
    Shaka.prototype.getMediaElement = function () {
        return this.media;
    };
    Shaka.prototype.load = function (url, position) {
        this.url = url;
        this.position = position;
        return this.loaded.promise;
    };
    Shaka.prototype.destroy = function () {
        this.destroyCalls++;
        return this.destroyed.promise;
    };
    const w = {
        _: (s) => s,
        $: (selector) => ({
            css(values) {
                Object.assign((styles[selector] ||= {}), values);
            },
            hide() {
                hidden.push(selector);
            },
            html() {},
            show() {},
        }),
        applyChannelPreference() {},
        clearInterval,
        clearTimeout,
        console: {
            error(...args) {
                errors.push(args);
            },
            log() {},
            warn() {},
        },
        document: { body: { style: {} } },
        Hls,
        innerHeight: 720,
        innerWidth: 1280,
        Map: undefined,
        // Mode A must still run without the ES2015 Promise constructor.
        Promise: undefined,
        Set: undefined,
        saveChannelPreference() {},
        setInterval,
        setTimeout,
        shaka: { Player: Shaka },
        showSelectBox(...args) {
            boxes.push(args);
        },
        showShift() {},
    };
    w.window = w;
    vm.createContext(w);
    require("./helpers/shared-core-runtime.cjs")(w);
    vm.runInContext(core, w);
    w.video = media();
    w.videoPip = media();
    return { boxes, errors, hidden, players, shakas, styles, w };
}
function useActualHlsRecovery(hls) {
    hls._media = hls.media;
    hls.started = true;
    hls.logger = { log() {} };
    hls.config.autoStartLoad = true;
    hls.detachMedia = function () {
        this.media.readyState = 0;
        this.hasEnoughToStart = false;
        this._media = null;
    };
    hls.attachMedia = function (media) {
        this._media = this.media = media;
    };
    hls.recoverMediaError = function () {
        ActualHls.prototype.recoverMediaError.call(this);
    };
}
const cases = [];
function test(name, fn) {
    cases.push([name, fn]);
}
test("asynchronous Shaka teardown stays pending through standby and reports failure", async () => {
    for (const fail of [false, true]) {
        const { w, shakas } = fixture();
        w.Promise = Promise;
        w.document.getElementById = () => null;
        w.installStandby(
            w,
            () => "0",
            () => {}
        );
        w.playerMode = 2;
        w.stbPlay("movie.mpd");
        shakas[0].attached.resolve();
        await tick();
        shakas[0].loaded.resolve();
        await tick();
        w.stbSetStandby(true);
        assert.equal(w.__ottStandby.snapshot().state, "suspending");
        assert.equal(w.__ottStandby.snapshot().pending, 1);
        if (fail)
            shakas[0].destroyed.reject(new Error("Decoder teardown failed"));
        else shakas[0].destroyed.resolve();
        await tick();
        assert.equal(w.__ottStandby.snapshot().pending, 0);
        assert.equal(
            w.__ottStandby.snapshot().state,
            fail ? "error" : "suspended"
        );
    }
});
for (const mode of [0, 1, 2]) {
    test(
        "screen suspension destroys the active transport: engine " + mode,
        async () => {
            const { w, players, shakas } = fixture();
            w.playerMode = mode;
            w.__ottNativeRuntime = true;
            w.stbPlay("camera.m3u8");
            if (mode === 1) players[0].events.manifest();
            if (mode === 2) {
                shakas[0].attached.resolve();
                await tick();
                shakas[0].loaded.resolve();
                await tick();
            }
            const handle = w.__ottCoreBackend().current();
            const before = w.video.loadCalls;
            handle.suspend();
            assert.equal(w.video.paused, true);
            assert.equal(w.video.src, "");
            assert.equal(
                w.video.selectedResource,
                "",
                "native resource is unloaded"
            );
            assert.equal(w.video.loadCalls, before + 1);
            assert.equal(handle.snapshot().phase, "paused");
            if (mode === 1) assert.equal(players[0].destroyCalls, 1);
            if (mode === 2) assert.equal(shakas[0].destroyCalls, 1);
            const plays = w.video.playCalls;
            if (mode === 1) players[0].events.manifest();
            assert.equal(
                w.video.playCalls,
                plays,
                "late startup cannot revive the transport"
            );
            handle.suspend();
            assert.equal(
                w.video.loadCalls,
                before + 1,
                "repeated sleep does not unload twice"
            );
            if (mode === 2) {
                shakas[0].destroyed.resolve();
                await tick();
            }
        }
    );
}
test("standby cancels preview and Plex work and releases both media lanes", () => {
    for (const mode of [0, 1]) {
        const { w, players } = fixture();
        const cleared = [];
        w.clearTimeout = (timer) => cleared.push(timer);
        w.document.getElementById = () => null;
        w.playerMode = mode;
        w.stbPlay("main.m3u8");
        w.stbPlayPip("pip.m3u8");
        const main = w.__ottCoreBackend().current();
        const pip = w.__ottCoreBackend().current("pip");
        const timer = {};
        w.previewTimer = timer;
        w.previewChan = { ch_id: "preview" };
        w.pipIndex = 3;
        let restored = 0;
        w.closeList = (restorePip = true) => {
            if (restorePip || w.previewChan || w.pipIndex !== null) restored++;
        };
        let cancelled = 0;
        w.__ottPlexQueue = {
            stop() {
                assert.equal(w.stbIsStandby(), true);
                cancelled++;
            },
        };
        w.stbToggleStandby();
        assert.equal(w.stbIsStandby(), true);
        assert.equal(cancelled, 1);
        assert.equal(
            restored,
            0,
            "closing the overlay cannot restart a stream"
        );
        assert.ok(cleared.includes(timer), "preview timer is retired");
        assert.equal(main.active(), false);
        assert.equal(pip.active(), false);
        for (const video of [w.video, w.videoPip]) {
            assert.equal(video.paused, true);
            assert.equal(video.src, "");
            assert.equal(video.selectedResource, "");
            assert.ok(
                video.loadCalls > 0,
                "native resource selection is reset"
            );
        }
        for (const player of players) {
            assert.equal(player.destroyCalls, 1);
            player.events.manifest();
        }
        assert.equal(
            w.video.paused,
            true,
            "late HLS callbacks cannot resume main"
        );
        assert.equal(
            w.videoPip.paused,
            true,
            "late HLS callbacks cannot resume PiP"
        );
        let starts = 0;
        w.startPlayer = () => starts++;
        w.stbToggleStandby();
        assert.equal(starts, 1);
        assert.equal(w.stbIsStandby(), false);
    }
});
test("standby teardown continues after an overlay, queue or native cleanup failure", () => {
    for (const failure of [
        "overlay",
        "queue",
        "main-load",
        "pip-load",
        "device",
    ]) {
        const { w } = fixture();
        w.document.getElementById = () => null;
        w.playerMode = 0;
        w.stbPlay("main.mp4");
        w.stbPlayPip("pip.mp4");
        const fail = () => {
            throw new Error("Synthetic cleanup failure");
        };
        if (failure === "overlay") w.closeList = fail;
        if (failure === "queue") w.__ottPlexQueue = { stop: fail };
        if (failure === "main-load") w.video.load = fail;
        if (failure === "pip-load") w.videoPip.load = fail;
        if (failure === "device")
            w.__ottCoreTransport.configure({ standby: fail });
        assert.doesNotThrow(() => w.stbToggleStandby(), failure);
        assert.equal(w.stbIsStandby(), true, failure);
        for (const video of [w.video, w.videoPip]) {
            assert.equal(video.paused, true, failure);
            assert.equal(video.src, "", failure);
        }
        assert.equal(w.__ottCoreBackend().current(), null, failure);
        assert.equal(w.__ottCoreBackend().current("pip"), null, failure);
    }
});
test("standby blocks explicit playback until one idempotent wake", () => {
    const { w } = fixture();
    w.document.getElementById = () => null;
    w.playerMode = 0;
    let starts = 0;
    w.startPlayer = () => starts++;
    w.stbSetStandby(true);
    w.stbPlay("explicit-main.mp4");
    w.stbPlayPip("explicit-pip.mp4");
    assert.equal(w.stbIsStandby(), true);
    assert.equal(w.video.paused, true);
    assert.equal(w.videoPip.paused, true);
    assert.equal(w.__ottCoreBackend().open({ url: "bypass.mp4" }), null);
    w.stbSetStandby(true);
    assert.equal(starts, 0);
    assert.equal(w.stbIsStandby(), true);
    assert.equal(w.__ottCoreBackend().current(), null);
    assert.equal(w.__ottCoreBackend().current("pip"), null);
    assert.equal(w.video.selectedResource, "");
    assert.equal(w.videoPip.selectedResource, "");
    w.stbSetStandby(false);
    w.stbSetStandby(false);
    assert.equal(starts, 1, "repeated wake does not start the player twice");
});
test("HLS same-track restoration and unavailable native track APIs", () => {
    const { w, boxes } = fixture();
    w.playerMode = 1;
    w.stbPlay("a.m3u8");
    w.setAudioTrack(0);
    w.stbStop();
    w.setAudioTrack(0);
    w.setSubtitleTrack(0);
    assert.equal(w.stbSubtitleExists(), 0);
    w.stbToggleAudioTrack();
    assert.equal(boxes.at(-1)[1][0], "Not found");
    w.stbToggleSubtitle();
});
test("HLS restores late subtitle lists only for the current stream", () => {
    const { w, players } = fixture();
    let restorations = 0;
    w.applyChannelPreference = (name, callback) => {
        if (name === "aSubs") {
            restorations++;
            callback(2);
        }
    };
    w.playerMode = 1;
    w.stbPlay("a.m3u8");
    const old = players[0];
    old.events.subtitles();
    assert.equal(old.subtitleTrack, 1);
    w.stbPlay("b.m3u8");
    const count = restorations;
    old.events.subtitles();
    assert.equal(restorations, count);
    players[1].events.subtitles();
    assert.equal(restorations, count + 1);
    assert.equal(players[1].subtitleTrack, 1);
});
test("native late-track listeners belong to their engine lease", () => {
    const { w } = fixture();
    const listeners = [];
    w.video.textTracks = {
        addEventListener(name, callback) {
            assert.equal(name, "addtrack");
            listeners.push(callback);
        },
        length: 0,
        removeEventListener(name, callback) {
            listeners.splice(listeners.indexOf(callback), 1);
        },
    };
    let restores = 0;
    w.applyChannelPreference = (name) => {
        if (name === "aSubs") restores++;
    };
    w.playerMode = 0;
    w.stbPlay("a.mp4");
    assert.equal(listeners.length, 1);
    const old = listeners[0];
    old();
    assert.equal(restores, 1);
    w.stbPlay("b.mp4");
    assert.equal(listeners.length, 1, "replacement removes old listener");
    old();
    assert.equal(restores, 1, "retained callback has no authority");
    listeners[0]();
    assert.equal(restores, 2);
    w.stbStop();
    assert.equal(listeners.length, 0);
});
test("main engine restores aspect before metadata, including the next video", () => {
    const { w, styles } = fixture();
    w.document.getElementById = () => null;
    w.document.body.classList = { add() {}, remove() {} };
    let saved = 1;
    w.applyChannelPreference = (name, callback) => {
        if (name === "aAspects") callback(saved);
    };
    w.stbPlay("first.mp4");
    assert.equal(w.video.readyState, 0);
    assert.equal(styles["#video"]["object-fit"], "cover");
    saved = 0;
    w.stbPlay("second.mp4");
    assert.equal(w.video.readyState, 0);
    assert.equal(styles["#video"]["object-fit"], "contain");
    w.stbStop();
});
test("PiP starts after manifest and ignores callbacks after switch/stop", () => {
    const { w, players, hidden } = fixture();
    w.playerMode = 1;
    w.stbPlayPip("a.m3u8");
    assert.equal(
        w.videoPip.playCalls,
        0,
        "HLS PiP must wait for attachment/manifest"
    );
    players[0].events.manifest();
    assert.equal(w.videoPip.playCalls, 1);
    w.playerMode = 0;
    w.stbPlayPip("b.mp4");
    assert.equal(players[0].destroyCalls, 1);
    players[0].events.manifest();
    assert.equal(w.videoPip.playCalls, 2);
    w.stbStopPip();
    w.stbStopPip();
    assert.equal(players[0].destroyCalls, 1);
    assert.equal(w.videoPip.src, "");
    assert.ok(hidden.includes("#pip_buffering"));
});
test("native PiP fallback keeps source identity and uses the prepared transport", () => {
    const { w } = fixture();
    const source = "https://source.invalid/protected.m3u8";
    const local =
        "http://127.0.0.1:12345/access/" +
        "a".repeat(43) +
        "/fixture/media.m3u8";
    let original;
    w.playerMode = 0;
    w.__ottCoreTransport.configure({
        pip: {
            open(request, fallback) {
                original = request;
                return fallback(local);
            },
        },
    });
    w.stbPlayPip(source);
    assert.equal(original.url, source);
    assert.equal(w.videoPip.src, local);
    assert.equal(w.videoPip.playCalls, 1);
    w.stbStopPip();
    assert.equal(w.videoPip.src, "");
    assert.equal(w.videoPip.paused, true);
});
test("PiP loader stays compact and centered through size, corner and canvas changes", () => {
    const { w, styles } = fixture();
    const presets = [
        [256, 144],
        [384, 216],
        [512, 288],
    ];
    function rectangle(style) {
        const width = parseFloat(style.width);
        const height = parseFloat(style.height);
        assert.notEqual(style.left === "auto", style.right === "auto");
        assert.notEqual(style.top === "auto", style.bottom === "auto");
        return {
            height,
            width,
            x:
                style.left === "auto"
                    ? w.innerWidth - parseFloat(style.right) - width
                    : parseFloat(style.left),
            y:
                style.top === "auto"
                    ? w.innerHeight - parseFloat(style.bottom) - height
                    : parseFloat(style.top),
        };
    }
    function near(actual, expected, message) {
        assert.ok(Math.abs(actual - expected) < 0.000001, message);
    }
    w.playerMode = 0;
    w.stbPlayPip("preview.mp4");
    assert.equal(styles["#pip_buffering"].width, "30px");
    for (const [width, height] of [
        [1280, 720],
        [1920, 1080],
        [640, 360],
        [1024, 768],
        [720, 1280],
    ]) {
        w.innerWidth = width;
        w.innerHeight = height;
        const scale = Math.min(width / 1280, height / 720);
        for (let size = 0; size < presets.length; size++) {
            // Retain the prior CSS between opposite-corner transitions.
            for (const corner of [0, 2, 1, 3, 0]) {
                w.sPipSize = String(size);
                w.sPipPos = String(corner);
                w.setPipPosition();
                const videoStyle = styles["#videopip"];
                const loaderStyle = styles["#pip_buffering"];
                const videoRect = rectangle(videoStyle);
                const loaderRect = rectangle(loaderStyle);
                near(videoRect.width, presets[size][0] * scale, "PiP width");
                near(videoRect.height, presets[size][1] * scale, "PiP height");
                near(loaderRect.width, 30 * scale, "compact loader width");
                near(loaderRect.height, 30 * scale, "compact loader height");
                near(
                    loaderRect.x + loaderRect.width / 2,
                    videoRect.x + videoRect.width / 2,
                    "loader centered horizontally"
                );
                near(
                    loaderRect.y + loaderRect.height / 2,
                    videoRect.y + videoRect.height / 2,
                    "loader centered vertically"
                );
                for (const side of ["left", "right", "top", "bottom"])
                    assert.equal(
                        loaderStyle[side] === "auto",
                        videoStyle[side] === "auto",
                        "clear the opposite " + side + " edge"
                    );
            }
        }
    }
});
test("native Shaka awaits attach and ignores a stopped attachment", async () => {
    const { w, shakas } = fixture();
    w.__ottNativeRuntime = true;
    w.playerMode = 2;
    w.stbPlay("native.mpd", 12);
    assert.equal(shakas[0].media, w.video);
    assert.equal(shakas[0].url, undefined, "load waits for attach");
    shakas[0].attached.resolve();
    await tick();
    assert.equal(shakas[0].url, "native.mpd");
    assert.equal(shakas[0].position, 12);
    w.stbStop();
    shakas[0].loaded.resolve();
    shakas[0].destroyed.resolve();
    await tick();
    w.stbPlay("stopped.mpd");
    w.stbStop();
    shakas[1].attached.resolve();
    await tick();
    assert.equal(
        shakas[1].url,
        undefined,
        "late attach cannot revive stopped stream"
    );
    assert.equal(w.video.playCalls, 0);
});

test("Shaka owns load position, respects late pause and releases before the next engine", async () => {
    const { w, shakas } = fixture();
    w.playerMode = 2;
    w.stbPlay("a.mpd", 43);
    assert.equal(shakas[0].position, 43);
    assert.equal(w.video.playCalls, 0);
    w.stbPause();
    shakas[0].loaded.resolve();
    await tick();
    assert.equal(w.video.playCalls, 0);
    w.stbContinue();
    assert.equal(w.video.playCalls, 1);
    w.playerMode = 0;
    w.stbPlay("b.mp4");
    assert.equal(shakas[0].destroyCalls, 1);
    assert.notEqual(w.video.src, "b.mp4", "await asynchronous Shaka detach");
    assert.equal(
        w.video.listeners.playing.length,
        0,
        "replacement must not observe the retiring decoder"
    );
    const pending = w.__ottCoreBackend().current();
    assert.equal(pending.snapshot().phase, "loading");
    w.stbPlay("c.mp4");
    shakas[0].destroyed.resolve();
    await tick();
    assert.equal(w.video.src, "c.mp4");
    assert.equal(
        w.video.listeners.playing.length,
        1,
        "only the attached replacement owns observations"
    );
    assert.equal(pending.active(), false);
    assert.equal(w.video.playCalls, 2);
});
test("Shaka late load/rejection cannot resurrect stopped playback", async () => {
    const { w, shakas, errors } = fixture();
    w.playerMode = 2;
    w.stbPlay("a.mpd");
    w.stbStop();
    assert.equal(shakas[0].destroyCalls, 1);
    shakas[0].loaded.resolve();
    shakas[0].destroyed.resolve();
    await tick();
    assert.equal(w.video.playCalls, 0);
    w.stbPlay("bad.mpd");
    shakas[1].loaded.reject(new Error("manifest failed"));
    await tick();
    assert.equal(w.video.playCalls, 0);
    assert.equal(errors.length, 1);
});
for (const mode of [0, 1, 2]) {
    for (const deferredSource of [false, true]) {
        test(
            "paused restart permits first native Play: engine " +
                mode +
                ", deferred source " +
                deferredSource,
            async () => {
                const { w, players, shakas } = fixture();
                const prepared = [];
                const state = {
                    generation: 1,
                    position: 8,
                    target: { kind: "vod" },
                };
                w.__ottClassicPlayback = {
                    command(value) {
                        if (value.type === "position")
                            state.position = value.position;
                    },
                    context: () => ({
                        isCurrentBackend: () => true,
                        isCurrentSource: () => true,
                    }),
                    snapshot: () => state,
                };
                w.playerMode = mode;
                w.__ottNativeRuntime = true;
                if (deferredSource)
                    w.__ottCoreTransport.configure({
                        prepareSource(_url, ready) {
                            prepared.push(ready);
                            return () => {};
                        },
                    });
                async function finishStartup(index) {
                    if (mode === 2 && index) {
                        shakas[index - 1].destroyed.resolve();
                        await tick();
                    }
                    if (deferredSource) prepared[index]("prepared.mp4");
                    if (mode === 1) players[index].events.manifest();
                    if (mode === 2) {
                        shakas[index].attached.resolve();
                        await tick();
                        shakas[index].loaded.resolve();
                        await tick();
                    }
                }
                function nativePlay() {
                    w.video.play();
                    for (const listener of [...w.video.listeners.playing])
                        listener();
                }
                const backend = w.__ottCoreBackend();
                backend.open({ url: "movie.mp4" });
                await finishStartup(0);
                w.video.readyState = 2;
                w.video.currentTime = 8;
                for (const listener of [...w.video.listeners.playing])
                    listener();
                backend.current().pause();
                const plays = w.video.playCalls;
                w.video.autoplay = true;
                assert.equal(backend.restart().paused, true);
                assert.equal(
                    w.forcePlay,
                    false,
                    "pause intent precedes asynchronous startup"
                );
                assert.equal(
                    w.video.autoplay,
                    false,
                    "the reflected native autoplay attribute is disabled"
                );
                await finishStartup(1);
                w.video.metadata();
                w.video.readyState = 2;
                assert.equal(w.video.paused, true);
                assert.equal(
                    w.video.playCalls,
                    plays,
                    "neither source preparation nor decoder ready may play"
                );
                assert.equal(backend.current().snapshot().phase, "paused");
                nativePlay();
                assert.equal(
                    w.video.paused,
                    false,
                    "first native Play is not mistaken for delayed autoplay"
                );
                assert.equal(backend.current().snapshot().phase, "playing");
                backend.current().pause();
                backend.current().resume();
                assert.equal(
                    w.forcePlay,
                    true,
                    "explicit backend resume still owns autoplay intent"
                );
                assert.equal(w.video.paused, false);
                backend.dispose();
                shakas.forEach((player) => player.destroyed.resolve());
            }
        );
    }
}
test("local startup offset waits for metadata and resets only when beyond the new file end", () => {
    const { w } = fixture();
    w.__ottActiveProviderDriver = { id: "offline" };
    w.video.blockEarlySeek = true;
    w.stbPlay("local.mp4", 37);
    assert.equal(w.video.currentTime, 0);
    w.video.duration = 100;
    w.video.metadata();
    assert.equal(w.video.currentTime, 37);
    w.video.readyState = 0;
    w.video.duration = NaN;
    w.stbPlay("replaced-local.mp4", 137);
    w.video.duration = 100;
    w.video.metadata();
    assert.equal(w.video.currentTime, 0);
});

test("native and HLS recovery preserve seek on engines rejecting pre-metadata currentTime", () => {
    const { w, players } = fixture();
    w.video.blockEarlySeek = true;
    w.stbPlay("archive.mp4", 37);
    w.stbPause();
    w.video.metadata();
    assert.equal(w.video.currentTime, 37);
    assert.equal(w.video.paused, true);
    w.playerMode = 1;
    w.stbPlay("archive.m3u8", 54);
    players[0].events.manifest();
    w.video.metadata();
    assert.equal(players[0].config.startPosition, 54);
    w.video.currentTime = 73;
    players[0].hasEnoughToStart = true;
    w.stbPause();
    const fatal = { details: "bufferAppendError", fatal: true, type: "media" };
    players[0].events.error(null, fatal);
    players[0].events.error(null, fatal);
    w.video.metadata();
    assert.equal(w.video.currentTime, 73);
    assert.equal(w.video.paused, true);
    w.playerMode = 0;
    w.stbPlay("old.mp4", 88);
    const stale = [...w.video.listeners.loadedmetadata];
    w.stbPlay("new.mp4", 12);
    for (const cb of stale) cb();
    w.video.metadata();
    assert.equal(w.video.currentTime, 12);
});
test("HLS resumes through its buffered-start position without early DOM seeks", () => {
    const { w, players } = fixture();
    w.playerMode = 1;
    const position = 0.114871958;
    w.stbPlay("resume.m3u8", position);
    assert.equal(players[0].config.startPosition, position);
    assert.deepEqual(w.video.seekWrites, []);
    players[0].events.manifest();
    w.video.metadata();
    assert.equal(w.video.playCalls, 1);
    assert.deepEqual(
        w.video.seekWrites,
        [],
        "manifest and metadata leave the initial seek to the HLS engine"
    );
    assert.equal(w._corePendingSeek, null);
    w.stbPlay("replacement.m3u8", 0.25);
    players[0].events.manifest();
    assert.equal(
        w.video.playCalls,
        1,
        "retired manifest cannot resume playback"
    );
    players[1].events.manifest();
    w.video.metadata();
    assert.equal(players[1].config.startPosition, 0.25);
    assert.equal(w.video.playCalls, 2);
    assert.deepEqual(w.video.seekWrites, []);
    w.stbStop();
});
test("HLS retains its default start policy unless a finite positive resume exists", () => {
    for (const position of [undefined, 0, -1, NaN, Infinity]) {
        const { w, players } = fixture();
        w.playerMode = 1;
        w.stbPlay("live.m3u8", position);
        assert.equal(players[0].config.startPosition, undefined);
        players[0].events.manifest();
        w.video.metadata();
        assert.deepEqual(w.video.seekWrites, []);
        w.stbStop();
    }
});
test("HLS failure before its first frame preserves requested native fallback resume", () => {
    const { w, players } = fixture();
    w.playerMode = 1;
    w.video.blockEarlySeek = true;
    w.stbPlay("resume.m3u8", 54);
    players[0].events.manifest();
    assert.equal(w.video.currentTime, 0);
    const fatal = { details: "bufferAppendError", fatal: true, type: "media" };
    players[0].events.error(null, fatal);
    players[0].events.error(null, fatal);
    w.video.metadata();
    assert.equal(w.video.currentTime, 54);
    w.stbStop();
});
test("HLS recovery preserves an explicit seek to zero through native fallback", () => {
    const { w, players } = fixture();
    w.playerMode = 1;
    w.video.blockEarlySeek = true;
    w.stbPlay("resume.m3u8", 35);
    const hls = players[0];
    hls.events.manifest();
    w.video.metadata();
    w.video.currentTime = 35;
    hls.hasEnoughToStart = true;
    w.stbSetPosTime(0);
    w.video.seekWrites.length = 0;
    hls.recoverMediaError = function () {
        assert.equal(
            this.config.startPosition,
            0,
            "HLS reattachment must not restore the original resume position"
        );
        this.media.src = "blob:recovered";
        this.hasEnoughToStart = false;
    };
    const fatal = { details: "bufferAppendError", fatal: true, type: "media" };
    hls.events.error(null, fatal);
    assert.equal(w.video.readyState, 0);
    hls.events.error(null, fatal);
    assert.equal(w.video.src, "resume.m3u8");
    w.video.metadata();
    assert.equal(w.video.currentTime, 0);
    assert.deepEqual(w.video.seekWrites, []);
    w.stbStop();
});
test("explicit seeks survive actual HLS recovery before metadata without reviving old positions", () => {
    for (const phase of ["startup", "before-recovery", "during-recovery"]) {
        for (const position of [0, 12]) {
            const { w, players } = fixture();
            w.playerMode = 1;
            w.video.blockEarlySeek = true;
            w.stbPlay("resume.m3u8", 35);
            const hls = players[0];
            hls.events.manifest();
            const fatal = {
                details: "bufferAppendError",
                fatal: true,
                type: "media",
            };
            if (phase !== "startup") {
                w.video.metadata();
                w.video.currentTime = 50;
                hls.hasEnoughToStart = true;
            }
            useActualHlsRecovery(hls);
            if (phase === "during-recovery") hls.events.error(null, fatal);
            w.video.readyState = 0;
            w.stbSetPosTime(position);
            assert.equal(hls.config.startPosition, position, phase);
            assert.equal(hls.activeStartPosition, position, phase);
            if (phase === "before-recovery")
                assert.ok(
                    w._corePendingSeek,
                    "the rejected DOM seek is pending"
                );
            else {
                assert.equal(w._corePendingSeek, null);
                assert.equal(
                    w.video.seekWrites.length,
                    phase === "startup" ? 0 : 1
                );
            }
            assert.equal(w.video.currentTime, phase === "startup" ? 0 : 50);
            if (phase !== "during-recovery") hls.events.error(null, fatal);
            assert.equal(hls.config.startPosition, position, phase);
            assert.equal(hls.activeStartPosition, position, phase);
            if (phase === "before-recovery")
                assert.deepEqual(
                    hls.startLoads.slice(-2),
                    [50, position],
                    "the requested target overrides actual HLS recovery's stale currentTime"
                );
            assert.equal(
                w._corePendingSeek,
                null,
                "HLS owns the recovery seek"
            );
            const writes = w.video.seekWrites.length;
            w.video.metadata();
            assert.equal(
                w.video.seekWrites.length,
                writes,
                "metadata cannot replay an early DOM seek"
            );
            hls.events.error(null, fatal);
            assert.equal(w.video.src, "resume.m3u8");
            w.video.metadata();
            assert.equal(w.video.currentTime, position, phase);
            assert.equal(w._corePendingSeek, null);
            w.stbStop();
        }
    }
});
test("stale and invalid seek requests preserve the active pending seek", () => {
    const { w, players } = fixture();
    w.playerMode = 0;
    w.video.blockEarlySeek = true;
    w.stbPlay("resume.m3u8", 35);
    w.stbSetPosTime(12);
    const pending = w._corePendingSeek;
    assert.ok(pending);
    w.seekCoreMedia(77, w._playSession - 1);
    for (const position of [-1, NaN, Infinity])
        w.seekCoreMedia(position, w._playSession);
    assert.equal(w._corePendingSeek, pending);
    assert.equal(players.length, 0);
    w.video.metadata();
    assert.equal(w.video.currentTime, 12);
    assert.equal(w._corePendingSeek, null);
    w.stbStop();
});
test("buffered HLS seeks use the DOM even while waiting for data", () => {
    const { w, players } = fixture();
    w.playerMode = 1;
    w.stbPlay("resume.m3u8", 35);
    const hls = players[0];
    hls.hasEnoughToStart = true;
    w.video.readyState = 1;
    w.stbSetPosTime(12);
    assert.equal(w.video.currentTime, 12);
    assert.deepEqual(
        hls.startLoads,
        [],
        "a normal seek must not restart loading"
    );
    assert.equal(w._corePendingSeek, null);
    w.stbStop();
});
test("HLS startup seeks wait for buffering instead of replaying at metadata", () => {
    const { w, players } = fixture();
    w.playerMode = 1;
    w.video.blockEarlySeek = true;
    w.stbPlay("resume.m3u8", 35);
    const hls = players[0];
    w.stbSetPosTime(12);
    w.stbSetPosTime(0);
    w.seekCoreMedia(77, w._playSession - 1);
    w.seekCoreMedia(NaN, w._playSession);
    assert.deepEqual(hls.startLoads, [12, 0]);
    assert.equal(hls.activeStartPosition, 0);
    w.video.metadata();
    assert.deepEqual(w.video.seekWrites, []);
    assert.equal(w._corePendingSeek, null);
    hls.hasEnoughToStart = true;
    w.video.readyState = 2;
    w.video.currentTime = hls.activeStartPosition;
    assert.equal(w.video.currentTime, 0);
    w.stbStop();
});
test("HLS recovery cannot restart a retired instance after synchronous reentry", () => {
    for (const action of ["stop", "replace"]) {
        const { w, players } = fixture();
        w.playerMode = 1;
        w.stbPlay("resume.m3u8", 35);
        const hls = players[0];
        hls.recoverMediaError = function () {
            if (action === "stop") w.stbStop();
            else w.stbPlay("replacement.m3u8", 12);
        };
        hls.events.error(null, { fatal: true, type: "media" });
        assert.deepEqual(hls.startLoads, []);
        if (action === "replace") assert.deepEqual(players[1].startLoads, []);
        w.stbStop();
    }
});
test("a synchronous HLS load error observes the pending explicit seek", () => {
    const { w, players } = fixture();
    w.playerMode = 1;
    w.video.blockEarlySeek = true;
    w.stbPlay("resume.m3u8", 35);
    const hls = players[0];
    w.video.metadata();
    w.video.currentTime = 50;
    w.video.readyState = 0;
    hls.hasEnoughToStart = true;
    useActualHlsRecovery(hls);
    const startLoad = hls.startLoad;
    let first = true;
    hls.startLoad = function (position) {
        startLoad.call(this, position);
        if (first) {
            first = false;
            this.events.error(null, { fatal: true, type: "media" });
        }
    };
    w.stbSetPosTime(0);
    assert.equal(hls.config.startPosition, 0);
    assert.equal(hls.activeStartPosition, 0);
    assert.deepEqual(hls.startLoads, [0, 50, 0]);
    assert.equal(w._corePendingSeek, null);
    const writes = w.video.seekWrites.length;
    w.video.metadata();
    assert.equal(w.video.seekWrites.length, writes);
    w.stbStop();
});
test("HLS retries preserve startup and pending seeks while healthy playback uses its default position", () => {
    for (const route of ["network", "drop-level"]) {
        for (const phase of ["startup", "started-pending", "healthy"]) {
            for (const position of [0, 12]) {
                const { w, players } = fixture();
                w.playerMode = 1;
                w.video.blockEarlySeek = true;
                w.stbPlay("resume.m3u8", 35);
                const hls = players[0];
                if (phase !== "startup") {
                    w.video.metadata();
                    w.video.currentTime = 50;
                    hls.hasEnoughToStart = true;
                }
                if (phase === "started-pending") w.video.readyState = 0;
                if (phase !== "healthy") w.stbSetPosTime(position);
                assert.equal(!!w._corePendingSeek, phase === "started-pending");
                // The controller may sample stale decoder time before retry.
                hls.activeStartPosition = 50;
                hls.recoverMediaError = () =>
                    assert.fail("retry should not reattach media");
                if (route === "drop-level") hls.levels = [{}, {}];
                hls.events.error(null, {
                    details:
                        route === "network"
                            ? "fragLoadError"
                            : "bufferAppendError",
                    fatal: true,
                    level: 1,
                    type: route === "network" ? "network" : "media",
                });
                const expected = phase === "healthy" ? -1 : position;
                assert.equal(
                    hls.activeStartPosition,
                    expected,
                    `${route}/${phase}`
                );
                assert.equal(
                    hls.startLoads.at(-1),
                    expected,
                    `${route}/${phase}`
                );
                w.video.metadata();
                if (phase === "startup") {
                    assert.deepEqual(w.video.seekWrites, []);
                    assert.equal(w.video.currentTime, 0);
                } else {
                    assert.equal(
                        w.video.currentTime,
                        phase === "healthy" ? 50 : position
                    );
                }
                assert.equal(w._corePendingSeek, null);
                w.stbStop();
            }
        }
    }
});
test("iOS source login cannot replace a newer channel or revive stopped playback", async () => {
    const { w } = fixture();
    const first = deferred(),
        second = deferred(),
        stopped = deferred();
    const pending = [first, second, stopped];
    const prepared = [],
        cancelled = [];
    w.__ottCoreTransport.configure({ prepareSource: w.prepareAccessMedia });
    w.Capacitor = {
        getPlatform: () => "ios",
        Plugins: {
            AccessMedia: {
                cancelPrepare: ({ requestId }) => {
                    cancelled.push(requestId);
                    return Promise.resolve();
                },
                prepare: ({ requestId }) => {
                    prepared.push(requestId);
                    return pending.shift().promise;
                },
            },
        },
    };
    const local =
        "http://127.0.0.1:12345/access/" +
        "a".repeat(43) +
        "/fixture/media.m3u8";
    w.stbPlay("https://source.invalid/old.m3u8");
    w.stbPlay("https://source.invalid/new.m3u8", 12);
    assert.deepEqual(cancelled, [prepared[0]]);
    assert.notEqual(prepared[0], prepared[1]);
    first.resolve({ url: local + "old" });
    await tick();
    assert.equal(w.video.playCalls, 0);
    second.resolve({ url: local });
    await tick();
    assert.equal(w.video.src, local);
    assert.equal(w.video.playCalls, 1);
    w.stbPlay("https://source.invalid/stopped.m3u8");
    w.stbStop();
    assert.deepEqual(
        cancelled,
        [prepared[0], prepared[2]],
        "only unfinished preparation is cancelled"
    );
    stopped.resolve({ url: local });
    await tick();
    assert.equal(w.video.playCalls, 1);
});
for (const behavior of [
    "missing",
    "nonfunction",
    "throw",
    "empty",
    "reject",
    "getter",
]) {
    test(`iOS source cancellation tolerates ${behavior} optional bridge`, async () => {
        for (const settled of [false, true]) {
            const { w } = fixture();
            const pending = deferred();
            let calls = 0;
            let ready = 0;
            let failed = 0;
            const plugin = { prepare: () => pending.promise };
            if (behavior === "getter")
                Object.defineProperty(plugin, "cancelPrepare", {
                    get() {
                        throw new Error("bridge unavailable");
                    },
                });
            else if (behavior === "nonfunction") plugin.cancelPrepare = true;
            else if (behavior !== "missing")
                plugin.cancelPrepare = function () {
                    assert.equal(this, plugin);
                    calls++;
                    if (behavior === "throw")
                        throw new Error("bridge unavailable");
                    if (behavior === "reject")
                        return Promise.reject(new Error("unsupported"));
                };
            w.Capacitor = {
                getPlatform: () => "ios",
                Plugins: { AccessMedia: plugin },
            };
            const source = "https://source.invalid/live.m3u8";
            const cancel = w.prepareAccessMedia(
                source,
                () => ready++,
                () => failed++
            );
            assert.equal(typeof cancel, "function");
            if (settled) {
                pending.resolve({ url: source });
                await tick();
            }
            assert.doesNotThrow(() => {
                cancel();
                cancel();
            });
            pending.resolve({ url: source });
            await tick();
            assert.equal(ready, settled ? 1 : 0);
            assert.equal(failed, 0);
            assert.equal(
                calls,
                !settled && ["throw", "empty", "reject"].includes(behavior)
                    ? 1
                    : 0
            );
        }
    });
}
test("iOS HLS reconnect prepares the original source again, not a stale loopback URL", async () => {
    const { w, players } = fixture();
    const prepared = [];
    const timers = [];
    const source = "https://source.invalid/live.m3u8";
    const local =
        "http://127.0.0.1:12345/access/" +
        "a".repeat(43) +
        "/fixture/media.m3u8";
    w.playerMode = 1;
    w.setTimeout = (callback) => {
        timers.push(callback);
        return timers.length;
    };
    w.clearTimeout = () => {};
    w.__ottCoreTransport.configure({ prepareSource: w.prepareAccessMedia });
    w.Capacitor = {
        getPlatform: () => "ios",
        Plugins: {
            AccessMedia: {
                prepare: ({ url }) => {
                    prepared.push(url);
                    return Promise.resolve({ url: local });
                },
            },
        },
    };
    w.stbPlay(source);
    await tick();
    players[0].events.error(null, {
        details: "manifestParsingError",
        fatal: true,
        type: "network",
    });
    assert.equal(timers.length, 1);
    timers[0]();
    await tick();
    assert.deepEqual(prepared, [source, source]);
    assert.equal(players.length, 2);
    w.stbStop();
});

test("iOS source login failure does not fall back to an unprotected URL", async () => {
    const { w } = fixture();
    const messages = [];
    w.showShift = (message) => messages.push(message);
    w.__ottCoreTransport.configure({ prepareSource: w.prepareAccessMedia });
    w.Capacitor = {
        getPlatform: () => "ios",
        Plugins: {
            AccessMedia: {
                prepare: () => Promise.reject(new Error("cancelled")),
            },
        },
    };
    w.stbPlay("https://source.invalid/blocked.m3u8");
    await tick();
    assert.equal(w.video.playCalls, 0);
    assert.deepEqual(messages, ["Source sign-in required"]);
});
test("HLS level zero is never confused with current higher level", () => {
    const { w, players } = fixture();
    w.playerMode = 1;
    w.stbPlay("live.m3u8");
    players[0].levels = [{}, {}, {}];
    players[0].currentLevel = 2;
    players[0].events.error(null, {
        fatal: true,
        frag: { level: 0 },
        type: "media",
    });
    assert.equal(players[0].removed, undefined);
});
test("Shaka retries are bounded across player recreation and retain VOD position", async () => {
    const { w, shakas } = fixture();
    const timers = new Map(),
        messages = [];
    let serial = 0;
    w.setTimeout = (callback) => {
        timers.set(++serial, callback);
        return serial;
    };
    w.clearTimeout = (id) => timers.delete(id);
    w.showShift = (message) => messages.push(message);
    w.playerMode = 2;
    w.stbPlay("https://source.invalid/movie.mpd", 20);
    for (let i = 0; i < 3; i++) {
        const player = shakas[i];
        player.attached.resolve();
        await tick();
        if (i) assert.equal(player.position, 37);
        w.video.currentTime = 37;
        w.video.readyState = 3;
        player.loaded.reject({
            category: 1,
            code: 1001,
            data: ["secret URL", 503],
        });
        await tick();
        if (i < 2) {
            assert.equal(timers.size, 1);
            const [id, run] = timers.entries().next().value;
            timers.delete(id);
            run();
            assert.equal(player.destroyCalls, 1);
            assert.equal(
                shakas.length,
                i + 1,
                "must await destroy before attaching retry"
            );
            player.destroyed.resolve();
            await tick();
        }
    }
    assert.equal(timers.size, 0);
    assert.equal(messages.pop(), "Stream could not be played");
    assert.equal(w.__ottStreamPolicy.snapshot().attempts, 2);
    w.stbStop();
    shakas[2].destroyed.resolve();
    await tick();
});
test("Shaka error event deduplicates load rejection and Stop cancels its retry", async () => {
    const { w, shakas } = fixture();
    const timers = new Map();
    let serial = 0;
    w.setTimeout = (callback) => {
        timers.set(++serial, callback);
        return serial;
    };
    w.clearTimeout = (id) => timers.delete(id);
    w.playerMode = 2;
    w.stbPlay("https://source.invalid/live.mpd");
    shakas[0].attached.resolve();
    await tick();
    const error = { category: 1, code: 1003, severity: 2 };
    shakas[0].events.error({ detail: error });
    shakas[0].loaded.reject(error);
    await tick();
    assert.equal(timers.size, 1);
    const stale = [...timers.values()][0];
    w.stbStop();
    shakas[0].destroyed.resolve();
    await tick();
    stale();
    await tick();
    assert.equal(timers.size, 0);
    assert.equal(shakas.length, 1);
});
test("Shaka enforces user restrictions and reports an impossible ceiling without retries", async () => {
    const { w, shakas } = fixture();
    const messages = [];
    w.showShift = (message) => messages.push(message);
    w.sStreamMaxHeight = 720;
    w.sStreamMaxBitrate = 4000000;
    w.playerMode = 2;
    w.stbPlay("https://source.invalid/live.mpd");
    assert.equal(shakas[0].config.restrictions.maxHeight, 720);
    assert.equal(shakas[0].config.restrictions.maxBandwidth, 4000000);
    shakas[0].attached.resolve();
    await tick();
    shakas[0].loaded.reject({ category: 4, code: 4012 });
    await tick();
    assert.equal(messages.pop(), "No stream meets the quality limits");
    assert.equal(w.__ottStreamPolicy.snapshot().attempts, 0);
    w.stbStop();
    shakas[0].destroyed.resolve();
    await tick();
});
for (const terminal of [
    { category: 1, code: 1001, data: ["upstream", 401], severity: 2 },
    { category: 1, code: 1001, data: ["upstream", 403], severity: 2 },
    { category: 6, code: 6001, severity: 2 },
    { category: 4, code: 4012, severity: 2 },
])
    test(
        "Shaka terminal error cancels an already queued transient retry: " +
            JSON.stringify(terminal),
        async () => {
            const { w, shakas } = fixture();
            const timers = new Map();
            let serial = 0;
            w.setTimeout = (callback) => {
                timers.set(++serial, callback);
                return serial;
            };
            w.clearTimeout = (id) => timers.delete(id);
            w.playerMode = 2;
            w.stbPlay("https://source.invalid/live.mpd");
            const first = shakas[0];
            first.attached.resolve();
            await tick();
            const transient = { category: 1, code: 1003, severity: 2 };
            first.events.error({ detail: transient });
            assert.equal(timers.size, 1);
            const stale = [...timers.values()][0];
            first.events.error({ detail: terminal });
            assert.equal(
                timers.size,
                0,
                "terminal failure must remove the pending timer"
            );
            assert.equal(
                w.__ottStreamPolicy.snapshot().state,
                terminal.category === 1 ? "access-denied" : "failed"
            );
            // The same failure can arrive through both the event and load rejection.
            first.loaded.reject(transient);
            stale();
            await tick();
            assert.equal(
                shakas.length,
                1,
                "stale timer cannot recreate the failed decoder"
            );
            assert.equal(w.__ottStreamPolicy.snapshot().attempts, 0);
            assert.equal(timers.size, 0);
            w.stbStop();
            first.destroyed.resolve();
            await tick();
        }
    );
test("HLS quality restriction is applied before fragment loading", () => {
    const { w, players } = fixture();
    w.sStreamMaxHeight = 720;
    w.playerMode = 1;
    w.stbPlay("https://source.invalid/live.m3u8");
    const player = players[0];
    assert.equal(player.config.autoStartLoad, false);
    player.levels = [{ height: 480 }, { height: 720 }, { height: 1080 }];
    player.removeLevel = function (index) {
        this.levels.splice(index, 1);
    };
    player.events.manifest();
    assert.deepEqual(
        player.levels.map((level) => level.height),
        [480, 720]
    );
    assert.equal(player.startLoads.length, 1);
    assert.equal(player.autoLevelCapping, 1);
    w.stbStop();
});
test("HLS quality-limited startup preserves finite positive resume positions and otherwise uses live edge", () => {
    for (const limits of [
        { sStreamMaxHeight: 720 },
        { sStreamMaxBitrate: 4000000 },
        { sStreamMaxBitrate: 4000000, sStreamMaxHeight: 720 },
    ]) {
        for (const position of [
            undefined,
            0,
            -1,
            -20,
            NaN,
            Infinity,
            -Infinity,
            0.25,
            37,
        ]) {
            const { w, players } = fixture();
            Object.assign(w, limits);
            w.playerMode = 1;
            w.stbPlay("https://source.invalid/stream.m3u8", position);
            const player = players[0];
            const expected =
                Number.isFinite(position) && position > 0 ? position : -1;
            assert.equal(player.config.autoStartLoad, false);
            assert.equal(player.config.startPosition ?? -1, expected);
            assert.deepEqual(player.startLoads, []);
            player.levels = [{ bitrate: 2000000, height: 720 }];
            player.events.manifest();
            assert.deepEqual(
                player.startLoads,
                [expected],
                `quality-limited start position ${String(position)}`
            );
            w.stbStop();
        }
    }
});
test("HLS outer recovery samples the VOD position before destroy resets the media", () => {
    const { w, players } = fixture();
    let retry;
    w.setTimeout = (callback) => {
        retry = callback;
        return 1;
    };
    w.clearTimeout = () => {};
    w.playerMode = 1;
    w.stbPlay("https://source.invalid/movie.m3u8", 20);
    w.video.currentTime = 37;
    w.video.readyState = 3;
    players[0].hasEnoughToStart = true;
    players[0].events.error(null, {
        details: "manifestParsingError",
        fatal: true,
        type: "network",
    });
    assert.equal(
        w.video.currentTime,
        0,
        "fixture models destroy resetting the media"
    );
    retry();
    assert.equal(players[1].config.startPosition, 37);
    w.stbStop();
});
for (const details of [
    ["manifestParsingError", "manifestParsingError"],
    ["levelParsingError", "levelParsingError"],
    ["manifestLoadError", "manifestLoadError", "manifestLoadError"],
    ["manifestParsingError", "manifestLoadError", "manifestParsingError"],
    ["manifestLoadError", "levelParsingError", "levelParsingError"],
    ["manifestLoadError", "manifestLoadError", "levelParsingError"],
]) {
    test(
        "HLS shares its outer retry budget without repeating parse recovery: " +
            details.join(", "),
        () => {
            const { w, players } = fixture();
            const timers = new Map();
            let sequence = 0;
            w.setTimeout = (callback) => {
                timers.set(++sequence, callback);
                return sequence;
            };
            w.clearTimeout = (id) => timers.delete(id);
            w.playerMode = 1;
            w.stbPlay("https://source.invalid/live.m3u8");
            for (let attempt = 0; attempt < details.length; attempt++) {
                const player = players.at(-1);
                // A successful manifest must not replenish the request's budget.
                player.events.manifest();
                const detail = details[attempt];
                const inEngineAttempts = detail.includes("Parsing") ? 1 : 3;
                for (let failure = 0; failure < inEngineAttempts; failure++) {
                    player.events.error(null, {
                        details: detail,
                        fatal: true,
                        type: "network",
                    });
                }
                assert.equal(player.destroyCalls, 1);
                if (attempt === details.length - 1) {
                    assert.equal(
                        timers.size,
                        0,
                        "exhausted request cannot reconnect"
                    );
                } else {
                    assert.equal(timers.size, 1);
                    const [id, callback] = timers.entries().next().value;
                    timers.delete(id);
                    callback();
                    assert.equal(players.length, attempt + 2);
                }
            }
            assert.equal(players.length, details.length);
            w.stbStop();
        }
    );
}
test("explicit A/V diagnostic forces the MP4 decoder and restores mute after end", () => {
    const { w, players, shakas } = fixture();
    w.playerMode = 2;
    w.sStreamMaxHeight = 360;
    w.video.muted = true;
    assert.equal(
        w.video.src,
        "",
        "No diagnostic request before explicit start"
    );
    assert.equal(w.__ottAvTest.start(), true);
    assert.equal(
        w.video.src,
        "https://mantra-basin-76mq.here.now/diagnostics/av-v1.mp4"
    );
    assert.equal(
        new URL(w.video.src, "https://player.test/f/lg/webos/").href,
        w.video.src,
        "Device entry routes must preserve the hosted HTTPS fixture"
    );
    assert.equal(w.video.muted, false);
    assert.equal(
        w.stbIsPlaying(),
        false,
        "diagnostic playback must not enter live catch-up on Pause"
    );
    assert.equal(w.playerMode, 2);
    assert.equal(players.length, 0);
    assert.equal(shakas.length, 0);
    for (const callback of [...w.video.listeners.ended]) callback();
    assert.equal(w.video.muted, true);
    assert.equal(w.__ottCoreBackend().current(), null);
});
test("hosted A/V network failure closes the diagnostic and restores mute", () => {
    const { w } = fixture();
    const messages = [];
    w.showShift = (text) => messages.push(text);
    w.video.muted = true;
    assert.equal(w.__ottAvTest.start(), true);
    w.video.error = { code: 2 };
    for (const callback of [...w.video.listeners.error]) callback();
    assert.equal(w.__ottCoreBackend().current(), null);
    assert.equal(w.video.muted, true);
    assert(messages.includes("Stream could not be played"));
});
test("A/V diagnostic Stop cannot restart and its deadline cannot replace a new channel", () => {
    const { w } = fixture();
    let deadline;
    w.setTimeout = (callback) => {
        deadline = callback;
        return 1;
    };
    w.clearTimeout = () => {};
    assert.equal(w.__ottAvTest.start(), true);
    const stale = deadline;
    w.stbStop();
    stale();
    assert.equal(w.__ottCoreBackend().current(), null);
    assert.equal(w.__ottAvTest.start(), true);
    const replaced = deadline;
    w.stbPlay("new-channel.mp4");
    replaced();
    assert.equal(w.video.src, "new-channel.mp4");
    w.stbStop();
});
test("A/V diagnostic is unavailable on an optional native engine without taking its decoder", () => {
    const { w } = fixture();
    w.__ottCoreTransport.configure({
        engine: () => assert.fail("should not open a test engine"),
    });
    assert.equal(w.__ottAvTest.start(), false);
});
test("A/V diagnostic does not persist the demo's temporary mute as the user's choice", () => {
    const { w } = fixture();
    w.ottplayDemoActive = true;
    w.video.muted = true;
    w._coreDemoMute = { media: w.video, muted: false };
    assert.equal(w.__ottAvTest.start(), true);
    w.__ottAvTest.stop();
    assert.equal(w.video.muted, false);
});
test("A/V diagnostic keeps normal mute and resume controls while Demo is selected", () => {
    const { w } = fixture();
    w.ottplayDemoActive = true;
    w.video.muted = true;
    w._coreDemoMute = { media: w.video, muted: false };
    assert.equal(w.__ottAvTest.start(), true);
    assert.equal(w.video.muted, false);
    assert.equal(
        w._coreDemoMute,
        null,
        "the transient decoder is not a silent demo"
    );
    w.stbPause();
    w.stbResume();
    assert.equal(
        w.video.muted,
        false,
        "resuming the diagnostic retains audible output"
    );
    w.stbToggleMute();
    assert.equal(w.video.muted, true);
    w.stbToggleMute();
    assert.equal(w.video.muted, false, "the user can unmute the diagnostic");
    w.__ottAvTest.stop();
    assert.equal(
        w.video.muted,
        false,
        "idle retains the original user mute choice"
    );
    w.stbPlay("https://demo.invalid/demo/pattern.mp4");
    assert.equal(w.video.muted, true, "ordinary demo playback is still silent");
    w.stbStop();
    assert.equal(w.video.muted, false);
});
test("Shaka DRM capability failure is terminal without claiming provider login is required", async () => {
    const { w, shakas } = fixture();
    const messages = [];
    w.showShift = (text) => messages.push(text);
    w.playerMode = 2;
    w.stbPlay("https://source.invalid/protected.mpd");
    shakas[0].attached.resolve();
    await tick();
    shakas[0].loaded.reject({ category: 6, code: 6001 });
    await tick();
    assert.equal(messages.pop(), "Stream could not be played");
    assert.equal(w.__ottStreamPolicy.snapshot().attempts, 0);
    w.stbStop();
    shakas[0].destroyed.resolve();
    await tick();
});
test("engine diagnostics identify attached ownership, not a mode preference", () => {
    const { w, players } = fixture();
    w.playerMode = 1;
    w.stbPlay("first.m3u8");
    const first = w.__ottCoreBackend().current();
    assert.equal(first.diagnosticEngine(), "hls.js");
    players[0].media = null;
    assert.equal(first.diagnosticEngine(), null, "detached HLS is unavailable");
    players[0].media = w.video;
    const fatal = { fatal: true, type: "media" };
    players[0].events.error(null, fatal);
    players[0].events.error(null, fatal);
    assert.equal(w.playerMode, 1, "saved HLS preference is unchanged");
    assert.equal(
        first.diagnosticEngine(),
        "html5",
        "actual fallback is visible"
    );
    w.stbPlay("replacement.m3u8");
    assert.equal(first.diagnosticEngine(), null);
    const replacement = w.__ottCoreBackend().current();
    assert.equal(replacement.diagnosticEngine(), "hls.js");
    replacement.suspend();
    assert.equal(replacement.diagnosticEngine(), null);
    replacement.resume();
    assert.equal(replacement.diagnosticEngine(), "hls.js");
    w.stbStop();
    assert.equal(replacement.diagnosticEngine(), null);
    w.Hls.isSupported = () => false;
    w.stbPlay("native.m3u8");
    assert.equal(w.__ottCoreBackend().current().diagnosticEngine(), "html5");
    w.stbStop();
});
test("attempt diagnostics retain fallback and retry history on the same handle", () => {
    const { w, players } = fixture();
    const timers = new Map();
    let serial = 0;
    w.setTimeout = (callback) => {
        timers.set(++serial, callback);
        return serial;
    };
    w.clearTimeout = (id) => timers.delete(id);
    w.playerMode = 1;
    w.stbPlay("https://source.invalid/live.m3u8");
    const handle = w.__ottCoreBackend().current();
    const initial = JSON.parse(JSON.stringify(handle.diagnosticAttempt()));
    assert.equal(initial.engineStarts, 1);
    assert.equal(initial.streamRetries, 0);
    assert.equal(initial.nativeFallbacks, 0);
    assert.equal(initial.fatalErrors, 0);
    const fatal = { fatal: true, type: "media" };
    players[0].events.error(null, fatal);
    players[0].events.error(null, fatal);
    assert.equal(handle.diagnosticEngine(), "html5");
    w.video.error = { code: 2 };
    for (const callback of w.video.listeners.error) callback();
    for (let i = 0; i < 2; i++) {
        assert.equal(timers.size, 1);
        const [id, callback] = timers.entries().next().value;
        timers.delete(id);
        callback();
    }
    assert.equal(w.__ottCoreBackend().current(), handle);
    assert.equal(handle.diagnosticEngine(), "hls.js");
    const after = JSON.parse(JSON.stringify(handle.diagnosticAttempt()));
    assert.deepEqual(after, {
        attachment: initial.attachment,
        engineStarts: 3,
        fatalErrors: 2,
        nativeFallbacks: 1,
        streamRetries: 1,
    });
    after.engineStarts = 0;
    assert.equal(
        handle.diagnosticAttempt().engineStarts,
        3,
        "snapshot is a copy"
    );
    handle.suspend();
    assert.equal(handle.diagnosticAttempt(), null);
    handle.resume();
    const resumed = handle.diagnosticAttempt();
    assert(
        resumed.attachment > initial.attachment,
        "same handle reattachment is visible"
    );
    assert.equal(resumed.engineStarts, 1);
    players[0].events.error(null, fatal);
    assert.equal(
        handle.diagnosticAttempt().fatalErrors,
        0,
        "stale callback cannot affect replacement"
    );
    w.stbPlay("https://source.invalid/next.m3u8");
    assert.equal(handle.diagnosticAttempt(), null);
    assert.equal(
        w.__ottCoreBackend().current().diagnosticAttempt().engineStarts,
        1
    );
    w.stbStop();
});
test("fallback and return between samples remain visible after EOF", () => {
    const { w, players } = fixture();
    const timers = new Map();
    let serial = 0;
    w.setTimeout = (callback) => {
        timers.set(++serial, callback);
        return serial;
    };
    w.clearTimeout = (id) => timers.delete(id);
    w.playerMode = 1;
    w.stbPlay("https://source.invalid/live.m3u8");
    const backend = w.__ottCoreBackend(),
        handle = backend.current();
    const initial = handle.diagnosticAttempt();
    // No diagnostic read is made between the first frame and final EOF.
    for (let i = 0; i < 2; i++)
        players[0].events.error(null, { fatal: true, type: "media" });
    w.video.error = { code: 2 };
    for (const callback of w.video.listeners.error) callback();
    for (let i = 0; i < 2; i++) {
        const [id, callback] = timers.entries().next().value;
        timers.delete(id);
        callback();
    }
    w.video.error = null;
    w.video.readyState = 4;
    w.video.paused = false;
    for (const callback of w.video.listeners.playing) callback();
    for (const callback of w.video.listeners.ended) callback();
    const final = backend.lastAttempt();
    assert.equal(final.handleId, handle.id);
    assert.equal(final.attachment, initial.attachment);
    assert.equal(final.reason, "ended");
    assert.equal(final.engineStarts, 3);
    assert.equal(final.streamRetries, 1);
    assert.equal(final.nativeFallbacks, 1);
    assert.equal(final.fatalErrors, 2);
    w.stbStop();
    assert.equal(backend.lastAttempt().reason, "ended");
});
test("unattached and failed engines never borrow a prior native identity", async () => {
    const { w, players, shakas } = fixture();
    w.stbPlay("first.mp4");
    let ready;
    w.__ottCoreTransport.configure({
        prepareSource(_url, callback) {
            ready = callback;
            return () => {};
        },
    });
    w.stbPlay("pending.m3u8");
    const pending = w.__ottCoreBackend().current();
    assert.equal(pending.diagnosticEngine(), null);
    w.stbStop();
    ready("stale.mp4");
    assert.equal(pending.diagnosticEngine(), null);
    w.__ottCoreTransport.configure({ prepareSource: null });
    w.playerMode = 1;
    w.stbPlay("fatal.m3u8");
    players[0].events.error(null, { fatal: true, type: "other" });
    assert.equal(w.__ottCoreBackend().current().diagnosticEngine(), null);
    w.playerMode = 2;
    w.__ottNativeRuntime = true;
    w.shaka.Player.prototype.attach = function (media) {
        return this.attached.promise.then(() => {
            this.media = media;
        });
    };
    w.stbPlay("pending.mpd");
    const shaka = w.__ottCoreBackend().current();
    assert.equal(
        shaka.diagnosticEngine(),
        null,
        "construction is not attachment"
    );
    shakas[0].attached.resolve();
    await tick();
    assert.equal(shaka.diagnosticEngine(), "shaka");
    w.stbStop();
    assert.equal(shaka.diagnosticEngine(), null);
});
test("native retry clears engine ownership while the next source is unresolved", () => {
    const { w } = fixture();
    const timers = new Map();
    let serial = 0,
        ready;
    w.setTimeout = (callback) => {
        timers.set(++serial, callback);
        return serial;
    };
    w.clearTimeout = (id) => timers.delete(id);
    w.playerMode = 0;
    w.stbPlay("https://source.invalid/live.mp4");
    const handle = w.__ottCoreBackend().current();
    assert.equal(handle.diagnosticEngine(), "html5");
    w.__ottCoreTransport.configure({
        prepareSource(_url, callback) {
            ready = callback;
            return () => {};
        },
    });
    w.video.error = { code: 2 };
    for (const callback of w.video.listeners.error) callback();
    // The first task classifies the native failure; the second starts the retry.
    for (let i = 0; i < 2; i++) {
        assert.equal(timers.size, 1);
        const [id, callback] = timers.entries().next().value;
        timers.delete(id);
        callback();
    }
    assert.equal(w.__ottCoreBackend().current(), handle);
    assert.equal(w.__ottStreamPolicy.snapshot().attempts, 1);
    assert.equal(w.video.src, "");
    assert.equal(
        handle.diagnosticEngine(),
        null,
        "detached native is not active"
    );
    w.video.error = null;
    ready("https://source.invalid/recovered.mp4");
    assert.equal(handle.diagnosticEngine(), "html5");
    w.stbStop();
});
test("screen suspension cancels a queued stream retry before resuming a fresh lease", () => {
    const { w, players } = fixture();
    const timers = new Map();
    let serial = 0;
    w.setTimeout = (callback) => {
        timers.set(++serial, callback);
        return serial;
    };
    w.clearTimeout = (id) => timers.delete(id);
    w.playerMode = 1;
    w.stbPlay("https://source.invalid/live.m3u8");
    const handle = w.__ottCoreBackend().current();
    players[0].events.error(null, {
        details: "manifestParsingError",
        fatal: true,
        type: "network",
    });
    assert.equal(timers.size, 1);
    const stale = timers.values().next().value;
    handle.suspend();
    assert.equal(timers.size, 0);
    assert.equal(handle.diagnosticEngine(), null);
    stale();
    assert.equal(players.length, 1, "suspended transport cannot be recreated");
    handle.resume();
    assert.equal(players.length, 2);
    assert.equal(handle.diagnosticEngine(), "hls.js");
    stale();
    assert.equal(
        players.length,
        2,
        "old recovery cannot replace the new lease"
    );
    w.stbStop();
});
test("PiP diagnostics use their own attached engine and clear on stop", () => {
    const { w } = fixture();
    w.playerMode = 1;
    w.stbPlay("main.m3u8");
    w.playerMode = 0;
    w.stbPlayPip("pip.mp4");
    const main = w.__ottCoreBackend().current();
    const pip = w.__ottCoreBackend().current("pip");
    assert.equal(main.diagnosticEngine(), "hls.js");
    assert.equal(pip.diagnosticEngine(), "html5");
    w.stbStopPip();
    assert.equal(pip.diagnosticEngine(), null);
    assert.equal(main.diagnosticEngine(), "hls.js");
    w.stbStop();
});

(async () => {
    let failures = 0;
    for (const [name, fn] of cases) {
        try {
            await fn();
            console.log("PASS " + name);
        } catch (error) {
            failures++;
            console.error("FAIL " + name + "\n" + error.stack);
        }
    }
    if (failures) process.exitCode = 1;
})();
