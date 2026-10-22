/* Exercise the actual classic core: encoded media bitrate is not network speed. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
const source = [
    "src/core/auto-playback.ts",
    "src/core/native-hls.ts",
    "src/core/index.ts",
]
    .map((file) =>
        ts
            .transpileModule(fs.readFileSync(path.join(root, file), "utf8"), {
                compilerOptions: {
                    module: ts.ModuleKind.ES2015,
                    target: ts.ScriptTarget.ES5,
                },
            })
            .outputText.replace(/^import .*\n/gm, "")
            .replace(/^export /gm, "")
    )
    .join("\n");
const uiAst = ts.createSourceFile(
    "src/ui/index.ts",
    fs.readFileSync(path.join(root, "src/ui/index.ts"), "utf8"),
    ts.ScriptTarget.Latest,
    true
);
const uiFunctions = uiAst.statements.filter(
    (node) =>
        ts.isFunctionDeclaration(node) &&
        node.body &&
        ["updateMediaInfo", "refreshAudioBadge"].includes(node.name.text)
);
assert.equal(uiFunctions.length, 2, "Actual media-info UI functions exist");
const uiSource = ts.transpileModule(
    uiFunctions
        .map((node) => node.getText(uiAst).replace(/^export\s+/, ""))
        .join("\n"),
    {
        compilerOptions: {
            module: ts.ModuleKind.None,
            target: ts.ScriptTarget.ES5,
        },
    }
).outputText;

function media() {
    let source = "";
    const listeners = {};
    return {
        addEventListener(event, callback) {
            (listeners[event] ||= []).push(callback);
        },
        audioTracks: [],
        canPlayType: () => "probably",
        currentTime: 0,
        emit(event) {
            for (const callback of listeners[event] || [])
                callback({ target: this, type: event });
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
            if (name === "src") this.src = "";
        },
        removeEventListener(event, callback) {
            listeners[event] = (listeners[event] || []).filter(
                (fn) => fn !== callback
            );
        },
        seeking: false,
        get src() {
            return source;
        },
        set src(value) {
            source = value;
            this.currentTime = 0;
            this.readyState = 0;
            this.videoWidth = this.videoHeight = 0;
        },
        style: {},
        videoHeight: 0,
        videoWidth: 0,
    };
}

function fixture(options = {}) {
    const players = [],
        html = {};
    const footer = {
        get innerHTML() {
            return html["#video_res"] || "";
        },
        set innerHTML(value) {
            html["#video_res"] = value;
        },
    };
    let timer = 0;
    const timeouts = new Map();
    function Hls() {
        this.events = {};
        this.levels = [{ bitrate: 90e6 }];
        this.bandwidthEstimate = 700e6;
        this.audioTracks = [];
        this.subtitleTracks = [];
        this.destroyCalls = 0;
        players.push(this);
    }
    Hls.Events = {
        AUDIO_TRACKS_UPDATED: "audio",
        ERROR: "error",
        FRAG_LOADED: "frag-loaded",
        FRAG_PARSING_INIT_SEGMENT: "tracks",
        MANIFEST_PARSED: "manifest",
    };
    Hls.ErrorTypes = { MEDIA_ERROR: "media", NETWORK_ERROR: "network" };
    Hls.isSupported = () => true;
    Hls.prototype.on = function (event, callback) {
        (this.events[event] ||= []).push(callback);
    };
    Hls.prototype.emit = function (event, data) {
        for (const callback of this.events[event] || []) callback(event, data);
    };
    Hls.prototype.loadSource = function (url) {
        this.url = url;
    };
    Hls.prototype.attachMedia = function (target) {
        this.media = target;
        target.src = "blob:hls-" + players.indexOf(this);
    };
    Hls.prototype.destroy = function () {
        this.destroyCalls++;
        if (this.media) this.media.src = "";
        // Retain callbacks deliberately to exercise stale-event guards.
    };
    Hls.prototype.recoverMediaError = function () {};
    Hls.prototype.startLoad = function () {};
    const w = {
        _: (text) => text,
        __TAURI__: options.invoke
            ? { core: { invoke: options.invoke } }
            : undefined,
        $: (selector) => ({
            attr(name, value) {
                assert.equal(selector, "video");
                for (const element of [w.video, w.videoPip])
                    element[name] = value;
                return this;
            },
            css() {},
            hide() {},
            html(value) {
                if (arguments.length) html[selector] = value;
                return html[selector];
            },
            show() {},
        }),
        addEventListener() {},
        applyChannelPreference() {},
        clearInterval() {},
        clearTimeout(id) {
            timeouts.delete(id);
        },
        console: { error() {}, log() {}, warn() {} },
        Date: class extends Date {
            static now() {
                return options.now ? options.now() : Date.now();
            }
        },
        document: {
            body: { classList: { remove() {} }, style: {} },
            getElementById(id) {
                if (id === "video") return w.video;
                if (id === "videopip") return w.videoPip;
                if (id === "video_res") return footer;
                return id === "vdiv" ? {} : null;
            },
        },
        fetch() {
            throw new Error(
                "Native transport must not fetch an upstream URL from JavaScript"
            );
        },
        Hls,
        innerHeight: 720,
        innerWidth: 1280,
        Map: undefined,
        Promise: undefined,
        Set: undefined,
        saveChannelPreference() {},
        setInterval: () => ++timer,
        setTimeout(callback, delay) {
            timeouts.set(++timer, { callback, delay });
            return timer;
        },
        showShift() {},
        XMLHttpRequest() {
            throw new Error("Native transport must not issue upstream XHRs");
        },
    };
    w.window = w;
    vm.createContext(w);
    require("./helpers/shared-core-runtime.cjs")(w);
    vm.runInContext(source, w);
    vm.runInContext(uiSource, w);
    w.video = media();
    w.videoPip = media();
    function info() {
        w.updateCoreVideoInfo();
        return html["#video_res"] || "";
    }
    function ready() {
        w.video.readyState = 3;
        w.video.videoWidth = 1920;
        w.video.videoHeight = 1080;
        w.video.paused = false;
    }
    function flushActions() {
        for (const [id, pending] of [...timeouts]) {
            if (pending.delay !== 0) continue;
            timeouts.delete(id);
            pending.callback();
        }
    }
    return { flushActions, footer, info, players, ready, w };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
function bridgeFixture() {
    const calls = [];
    function invoke(command, args) {
        let resolve, reject;
        const promise = new Promise((yes, no) => {
            resolve = yes;
            reject = no;
        });
        calls.push({
            args: JSON.parse(JSON.stringify(args)),
            command,
            reject,
            resolve,
        });
        if (command === "native_hls_stop") resolve(null);
        return promise;
    }
    return { calls, invoke };
}

function chunk(sn, bytes = 1e6, duration = 1, fragment = {}) {
    return {
        frag: {
            cc: 0,
            duration,
            level: 0,
            sn,
            stats: { loaded: bytes },
            type: "main",
            ...fragment,
        },
    };
}
function part(sn, index, bytes = 250000, duration = 0.25) {
    const data = chunk(sn, 99e6, 1);
    data.part = { duration, index, stats: { loaded: bytes } };
    return data;
}
function near(actual, expected) {
    assert.ok(
        Math.abs(actual - expected) < 1e-9,
        `Expected ${expected} Mbps, received ${actual}`
    );
}
const cases = [];
function test(name, callback) {
    cases.push([name, callback]);
}

test("encoded bitrate is independent of localhost throughput and download delay", () => {
    for (const milliseconds of [1, 10000]) {
        const meter = fixture().w.createCoreHlsBitrateMeter();
        const data = chunk(1, 5e6, 5);
        data.frag.stats.loading = { end: milliseconds, start: 0 };
        data.frag.stats.bwEstimate = 700e6;
        meter.add(data);
        near(meter.mbps(), 8);
    }
});

test("rolling samples weight bytes by duration and evict the oldest of eight", () => {
    const { w } = fixture();
    const weighted = w.createCoreHlsBitrateMeter();
    weighted.add(chunk(1, 1e6, 1));
    weighted.add(chunk(2, 9e6, 3));
    near(weighted.mbps(), 20);
    const rolling = w.createCoreHlsBitrateMeter();
    for (let sn = 0; sn < 8; sn++) rolling.add(chunk(sn));
    near(rolling.mbps(), 8);
    rolling.add(chunk(8, 9e6));
    near(rolling.mbps(), 16);
});

test("LL-HLS uses each part's bytes and duration, not the fragment estimate", () => {
    const meter = fixture().w.createCoreHlsBitrateMeter();
    meter.add(part(1, 0));
    meter.add(part(1, 1));
    near(meter.mbps(), 8);
});

test("legacy event stats and payload-only events retain correct bitrate", () => {
    const { w } = fixture();
    const legacy = w.createCoreHlsBitrateMeter();
    const data = chunk(1, 0, 2);
    delete data.frag.stats;
    data.stats = { loaded: 2e6 };
    legacy.add(data);
    near(legacy.mbps(), 8);
    const payload = w.createCoreHlsBitrateMeter();
    const payloadData = chunk(2, 0, 1);
    delete payloadData.frag.stats;
    payloadData.payload = new ArrayBuffer(125000);
    payload.add(payloadData);
    near(payload.mbps(), 1);
});

test("invalid, aborted, initialization and non-main loads do not become media samples", () => {
    const meter = fixture().w.createCoreHlsBitrateMeter();
    for (const data of [
        null,
        {},
        chunk("initSegment"),
        chunk(1, 1e6, 1, { type: "audio" }),
        chunk(1, 1e6, 1, { type: "subtitle" }),
        chunk(1, 1e6, 1, { bitrateTest: true }),
        chunk(1, 1e6, 1, { stats: { aborted: true, loaded: 1e6 } }),
        chunk(1, 0),
        chunk(1, -1),
        chunk(1, NaN),
        chunk(1, Infinity),
        chunk(1, 1e6, 0),
        chunk(1, 1e6, -1),
        chunk(1, 1e6, NaN),
        chunk(1, 1e6, Infinity),
    ]) {
        meter.add(data);
        near(meter.mbps(), 0);
    }
    meter.add(chunk(2));
    near(meter.mbps(), 8);
});

test("repeated chunk replaces its sample and discontinuities stay distinct", () => {
    const meter = fixture().w.createCoreHlsBitrateMeter();
    meter.add(chunk(1));
    meter.add(chunk(2, 3e6));
    meter.add(chunk(1));
    near(meter.mbps(), 16);
    meter.add(chunk(1, 2e6));
    near(meter.mbps(), 20);
    meter.add(chunk(1, 4e6, 1, { cc: 1 }));
    near(meter.mbps(), 24);
});

test("a complete segment supersedes its parts and ignores subsequent duplicate parts", () => {
    const meter = fixture().w.createCoreHlsBitrateMeter();
    meter.add(part(1, 0));
    meter.add(part(1, 1));
    meter.add(chunk(1, 2e6));
    near(meter.mbps(), 16);
    meter.add(part(1, 2));
    near(meter.mbps(), 16);
});

test("actual HLS footer hides guessed rates then renders measured media Mbps", () => {
    const f = fixture();
    f.w.stbInit();
    f.w.setPlayerMode(1);
    f.w.stbPlay("http://127.0.0.1:8090/channel/test/index.m3u8");
    f.ready();
    assert.match(f.info(), /1920x1080/);
    assert.doesNotMatch(f.info(), /Mbps/);
    f.players[0].emit("frag-loaded", chunk(1, 5e6, 5));
    assert.match(f.info(), /(?:<br\/?>(?:\s*)|\s)8(?:\.0+)? Mbps/);
    f.players[0].bandwidthEstimate = 710e6;
    f.w.video.webkitVideoDecodedByteCount = 999e6;
    f.w.video.emit("seeking");
    f.w.video.emit("seeked");
    assert.match(f.info(), /8(?:\.0+)? Mbps/);
    assert.doesNotMatch(f.info(), /(?:700|710|90) Mbps/);
});

test("UI media-info updates preserve and refresh measured HLS bitrate", () => {
    const f = fixture();
    f.w.setPlayerMode(1);
    f.w.stbPlay("first.m3u8");
    f.ready();
    f.players[0].emit("frag-loaded", chunk(1));
    assert.match(f.info(), /8(?:\.0+)? Mbps/);

    f.w.updateMediaInfo();
    // Read the DOM directly: another core tick would conceal the UI overwrite.
    assert.match(f.footer.innerHTML, /1920x1080.*8(?:\.0+)? Mbps/);
    f.players[0].emit("frag-loaded", chunk(2, 3e6));
    f.w.updateMediaInfo();
    assert.match(f.footer.innerHTML, /16(?:\.0+)? Mbps/);

    f.w.stbPlay("second.m3u8");
    f.ready();
    f.w.updateMediaInfo();
    assert.match(f.footer.innerHTML, /1920x1080/);
    assert.doesNotMatch(f.footer.innerHTML, /Mbps/);
});

test("UI media-info updates preserve measured native bitrate while paused", () => {
    const f = fixture();
    f.w.setPlayerMode(0);
    f.w.stbPlay("native.mp4");
    f.ready();
    f.w.video.currentTime = 1;
    f.w.video.webkitVideoDecodedByteCount = 1e6;
    f.info();
    f.w.video.currentTime = 2;
    f.w.video.webkitVideoDecodedByteCount = 2e6;
    assert.match(f.info(), /8(?:\.0+)? Mbps/);
    f.w.stbPause();

    f.w.updateMediaInfo();
    assert.match(f.footer.innerHTML, /1920x1080.*8(?:\.0+)? Mbps/);
    f.w.video.currentTime = 30;
    f.w.video.seeking = true;
    f.w.updateMediaInfo();
    assert.doesNotMatch(f.footer.innerHTML, /Mbps/);
});

test("native UI ticks between byte-counter batches preserve the rate and full sampling interval", () => {
    const f = fixture();
    f.w.setPlayerMode(0);
    f.w.stbPlay("native.mp4");
    f.ready();
    f.w.video.currentTime = 1;
    f.w.video.webkitVideoDecodedByteCount = 1e6;
    f.info();
    f.w.video.currentTime = 2;
    f.w.video.webkitVideoDecodedByteCount = 2e6;
    assert.match(f.info(), /8(?:\.0+)? Mbps/);

    for (const position of [2.25, 2.75]) {
        f.w.video.currentTime = position;
        f.w.updateMediaInfo();
        assert.match(f.footer.innerHTML, /8(?:\.0+)? Mbps/);
    }

    f.w.video.currentTime = 3;
    f.w.video.webkitVideoDecodedByteCount = 3e6;
    f.w.updateMediaInfo();
    // The new 1 MB covers one media second, not the 0.25 s since the last UI tick.
    assert.match(f.footer.innerHTML, /8(?:\.0+)? Mbps/);
    assert.doesNotMatch(f.footer.innerHTML, /32(?:\.0+)? Mbps/);
});

test("channel changes reset the meter and stale HLS callbacks cannot affect the new channel", () => {
    const f = fixture();
    f.w.setPlayerMode(1);
    f.w.stbPlay("first.m3u8");
    f.ready();
    f.players[0].emit("frag-loaded", chunk(1));
    assert.match(f.info(), /8(?:\.0+)? Mbps/);
    f.w.stbPlay("second.m3u8");
    f.ready();
    f.players[0].emit("frag-loaded", chunk(2, 99e6));
    assert.doesNotMatch(f.info(), /Mbps/);
    f.players[1].emit("frag-loaded", chunk(1, 2e6));
    assert.match(f.info(), /16(?:\.0+)? Mbps/);
    f.players[0].emit("frag-loaded", chunk(3, 99e6));
    assert.match(f.info(), /16(?:\.0+)? Mbps/);
    f.w.stbStop();
    assert.equal(f.w._coreHlsBitrate, null);
    f.players[1].emit("frag-loaded", chunk(2, 99e6));
    assert.equal(f.w._coreHlsBitrate, null);
});

test("native bitrate uses media time, preserves pause, and resets on seeking or counter reset", () => {
    const f = fixture();
    f.w.setPlayerMode(0);
    f.w.stbPlay("native.mp4");
    f.ready();
    f.w.video.currentTime = 1;
    f.w.video.webkitVideoDecodedByteCount = 1e6;
    assert.doesNotMatch(f.info(), /Mbps/);
    f.w.video.currentTime = 3;
    f.w.video.webkitVideoDecodedByteCount = 3e6;
    assert.match(f.info(), /8(?:\.0+)? Mbps/);
    f.w.stbPause();
    assert.match(f.info(), /8(?:\.0+)? Mbps/);
    f.w.video.seeking = true;
    f.w.video.currentTime = 30;
    assert.doesNotMatch(f.info(), /Mbps/);
    f.w.video.seeking = false;
    f.w.video.paused = false;
    f.w.video.currentTime = 31;
    f.w.video.webkitVideoDecodedByteCount = 4e6;
    f.info();
    f.w.video.currentTime = 32;
    f.w.video.webkitVideoDecodedByteCount = 5e6;
    assert.match(f.info(), /8(?:\.0+)? Mbps/);
    f.w.video.currentTime = 33;
    f.w.video.webkitVideoDecodedByteCount = 100;
    assert.doesNotMatch(f.info(), /Mbps/);
});

test("starting another native channel clears cumulative decoded-byte samples", () => {
    const f = fixture();
    f.w.setPlayerMode(0);
    f.w.stbPlay("first.mp4");
    f.ready();
    f.w.video.currentTime = 1;
    f.w.video.webkitVideoDecodedByteCount = 1e6;
    f.info();
    f.w.video.currentTime = 2;
    f.w.video.webkitVideoDecodedByteCount = 2e6;
    assert.match(f.info(), /8(?:\.0+)? Mbps/);
    f.w.stbPlay("second.mp4");
    f.ready();
    f.w.video.currentTime = 1;
    f.w.video.webkitVideoDecodedByteCount = 99e6;
    assert.doesNotMatch(f.info(), /Mbps/);
    f.w.video.currentTime = 2;
    f.w.video.webkitVideoDecodedByteCount = 100e6;
    assert.match(f.info(), /8(?:\.0+)? Mbps/);
});

test("native seek events reset the baseline even between footer ticks", () => {
    for (const tickDuringSeek of [false, true]) {
        const f = fixture();
        f.w.stbInit();
        assert.match(f.w.video.poster, /^data:image\/gif;base64,/);
        assert.equal(f.w.videoPip.poster, f.w.video.poster);
        f.w.setPlayerMode(0);
        f.w.stbPlay("native.mp4");
        f.ready();
        f.w.video.currentTime = 1;
        f.w.video.webkitVideoDecodedByteCount = 1e6;
        f.info();
        f.w.video.currentTime = 2;
        f.w.video.webkitVideoDecodedByteCount = 2e6;
        assert.match(f.info(), /8(?:\.0+)? Mbps/);
        f.w.stbSetPosTime(30);
        f.w.video.seeking = true;
        f.w.video.emit("seeking");
        if (tickDuringSeek) f.info();
        f.w.video.seeking = false;
        f.w.video.emit("seeked");
        f.w.video.currentTime = 31;
        f.w.video.webkitVideoDecodedByteCount = 3e6;
        assert.doesNotMatch(f.info(), /Mbps/);
        f.w.video.currentTime = 32;
        f.w.video.webkitVideoDecodedByteCount = 4e6;
        assert.match(f.info(), /8(?:\.0+)? Mbps/);
    }
});

test("native transport is inert without Tauri IPC or for unsupported URLs, without Promise globals", () => {
    const f = fixture();
    assert.equal(f.w.Promise, undefined);
    const options = {
        active: () => true,
        changed: () => assert.fail("No telemetry"),
        failed: () => assert.fail("No native preparation"),
        ready: () => assert.fail("No native preparation"),
    };
    assert.equal(
        f.w.createNativeHlsTransport(
            "https://origin.invalid/live.m3u8",
            options
        ),
        null
    );
    const bridge = bridgeFixture();
    f.w.__TAURI_INTERNALS__ = { invoke: bridge.invoke };
    for (const url of [
        "live.m3u8",
        "file:///live.m3u8",
        "https://origin.invalid/video.mp4",
        "https://origin.invalid/live.mpd",
        "http://origin.invalid/play/live.php?extension=ts",
        "http://origin.invalid/play/live.php?extension=m3u8evil",
        "http://origin.invalid/play/live.php?other_extension=m3u8",
        "http://origin.invalid/video.mp4#?extension=m3u8",
        "http://origin.invalid/video.mp4?title=movie.m3u8",
        "http://origin.invalid/video.mp4?title=movie.m3u8&extension=mp4",
        "http://origin.invalid/play/live.php&extension=m3u8",
        "http://origin.invalid/play/live.php?extension=m3u8?token=1",
        "http://origin.invalid/play/live.php?next=?extension=m3u8",
        "data:video/mpegurl,test",
    ])
        assert.equal(f.w.createNativeHlsTransport(url, options), null);
    assert.equal(bridge.calls.length, 0);
    f.w.stbPlay("https://origin.invalid/video.mp4");
    assert.equal(f.w.video.src, "https://origin.invalid/video.mp4");
    assert.equal(f.w.video.playCalls, 1);
});

test("Auto routes query-selected HLS through native transport without changing signed portal URLs", async () => {
    for (const url of [
        "http://origin.invalid/play/live.php?extension=m3u8",
        "http://origin.invalid/play/live.php?mac=02%3A00%3A00%3A00%3A00%3A01&stream=42&extension=m3u8&play_token=a%2Bb",
        "https://origin.invalid/play/live.php?stream=42&extension=m3u8#player",
        "https://origin.invalid/live.m3u8?play_token=a%2Bb%2f&duplicate=1&duplicate=2",
    ]) {
        const bridge = bridgeFixture();
        const f = fixture({ invoke: bridge.invoke });
        f.w.setPlayerMode(3);
        f.w.stbPlay(url);
        assert.equal(
            f.w.video.src,
            "",
            "WebKit must not request HTTP media directly"
        );
        assert.equal(bridge.calls[0].command, "native_hls_start");
        assert.equal(
            bridge.calls[0].args.url,
            url,
            "Preserve the complete signed URL"
        );
        bridge.calls[0].resolve({
            session: "portal",
            url: "http://127.0.0.1:12345/portal/index.m3u8",
        });
        await settle();
        assert.equal(f.w.video.src, "http://127.0.0.1:12345/portal/index.m3u8");
        assert.equal(f.w.video.playCalls, 1);
        assert.equal(f.players.length, 0);
        f.w.stbStop();
        assert.equal(bridge.calls.at(-1).command, "native_hls_stop");
    }
});

test("native transport polls IPC once per second without overlapping or extra upstream requests", async () => {
    const bridge = bridgeFixture();
    let now = 0;
    const f = fixture({ invoke: bridge.invoke, now: () => now });
    const readyUrls = [];
    let changes = 0;
    const transport = f.w.createNativeHlsTransport(
        "https://origin.invalid/live.m3u8?token=1",
        {
            active: () => true,
            changed: () => changes++,
            failed: () => assert.fail("Valid relay must start"),
            ready: (url) => readyUrls.push(url),
        }
    );
    transport.poll();
    assert.equal(bridge.calls.length, 1, "Do not poll before session creation");
    assert.deepEqual(bridge.calls[0].args, {
        url: "https://origin.invalid/live.m3u8?token=1",
    });
    bridge.calls[0].resolve({
        session: "a",
        url: "http://127.0.0.1:12345/a/index.m3u8",
    });
    await settle();
    assert.deepEqual(readyUrls, ["http://127.0.0.1:12345/a/index.m3u8"]);
    transport.poll();
    now = 5000;
    transport.poll();
    assert.equal(bridge.calls.length, 2, "Only one stats request in flight");
    assert.deepEqual(bridge.calls[1].args, { session: "a" });
    bridge.calls[1].resolve({
        bandwidthEstimate: 700e6,
        bytes: 5e6,
        samples: 1,
        seconds: 5,
    });
    await settle();
    near(transport.mbps(), 8);
    assert.equal(changes, 1);
    transport.poll();
    bridge.calls[2].reject(new Error("Stats temporarily unavailable"));
    await settle();
    near(transport.mbps(), 8);
    transport.poll();
    assert.equal(
        bridge.calls.length,
        3,
        "A failed request still respects throttle"
    );
    now += 1000;
    transport.poll();
    bridge.calls[3].resolve({ bytes: 5e6, samples: 1, seconds: 5 });
    await settle();
    assert.equal(changes, 1, "Same media sample does not cause render churn");
    transport.cancel();
    transport.cancel();
    near(transport.mbps(), 0);
    assert.deepEqual(
        bridge.calls.map((call) => call.command),
        [
            "native_hls_start",
            "native_hls_stats",
            "native_hls_stats",
            "native_hls_stats",
            "native_hls_stop",
        ]
    );
    assert.deepEqual(bridge.calls.at(-1).args, { session: "a" });
});

test("native transport cleans up a late start and ignores a late stats result after cancellation", async () => {
    for (const phase of ["start", "stats"]) {
        const bridge = bridgeFixture();
        const f = fixture({ invoke: bridge.invoke });
        let ready = 0,
            changed = 0,
            failed = 0;
        const transport = f.w.createNativeHlsTransport(
            "https://origin.invalid/live.m3u8",
            {
                active: () => true,
                changed: () => changed++,
                failed: () => failed++,
                ready: () => ready++,
            }
        );
        if (phase === "stats") {
            bridge.calls[0].resolve({
                session: "a",
                url: "http://127.0.0.1:12345/a/index.m3u8",
            });
            await settle();
            transport.poll();
        }
        transport.cancel();
        if (phase === "start")
            bridge.calls[0].resolve({
                session: "a",
                url: "http://127.0.0.1:12345/a/index.m3u8",
            });
        else bridge.calls[1].resolve({ bytes: 99e6, samples: 1, seconds: 1 });
        await settle();
        near(transport.mbps(), 0);
        assert.equal(ready, phase === "start" ? 0 : 1);
        assert.equal(changed, 0);
        assert.equal(failed, 0);
        assert.equal(
            bridge.calls.filter((call) => call.command === "native_hls_stop")
                .length,
            1
        );
    }
});

test("native transport validates measured samples and ignores an inactive owner", async () => {
    const bridge = bridgeFixture();
    let now = 0,
        active = true,
        changed = 0;
    const f = fixture({ invoke: bridge.invoke, now: () => now });
    const transport = f.w.createNativeHlsTransport(
        "https://origin.invalid/live.m3u8",
        {
            active: () => active,
            changed: () => changed++,
            failed: () => assert.fail("Valid startup"),
            ready() {},
        }
    );
    bridge.calls[0].resolve({
        session: "a",
        url: "http://127.0.0.1:12345/a/index.m3u8",
    });
    await settle();
    for (const stats of [
        null,
        { bytes: Infinity, samples: 1, seconds: 1 },
        { bytes: 1e6, samples: 1, seconds: 0 },
        { bytes: 1e6, samples: 1, seconds: NaN },
        { bytes: 1e6, samples: 0, seconds: 1 },
        { bytes: 1e6, samples: 9, seconds: 1 },
        { bandwidthEstimate: 700e6, bitrate: 90e6 },
    ]) {
        now += 1000;
        transport.poll();
        bridge.calls.at(-1).resolve(stats);
        await settle();
        near(transport.mbps(), 0);
    }
    assert.equal(changed, 0);
    now += 1000;
    transport.poll();
    const lateStats = bridge.calls.at(-1);
    active = false;
    lateStats.resolve({ bytes: 1e6, samples: 1, seconds: 1 });
    await settle();
    near(transport.mbps(), 0);
    assert.equal(changed, 0);
    assert.equal(bridge.calls.at(-1).command, "native_hls_stop");
});

test("real Tauri native playback with a zero WebKit counter renders measured media Mbps through UI refresh", async () => {
    const bridge = bridgeFixture();
    const f = fixture({ invoke: bridge.invoke });
    f.w.setPlayerMode(3);
    f.w.stbPlay("https://origin.invalid/live.m3u8");
    assert.equal(
        f.w.video.src,
        "",
        "Do not request the original master while preparing the relay"
    );
    assert.equal(f.w.video.playCalls, 0);
    bridge.calls[0].resolve({
        session: "a",
        url: "http://127.0.0.1:12345/a/index.m3u8",
    });
    await settle();
    assert.equal(f.w.video.src, "http://127.0.0.1:12345/a/index.m3u8");
    assert.equal(f.w.video.playCalls, 1);
    f.ready();
    f.w.video.webkitVideoDecodedByteCount = 0;
    assert.doesNotMatch(f.info(), /Mbps/);
    bridge.calls[1].resolve({ bytes: 5e6, samples: 1, seconds: 5 });
    await settle();
    assert.match(f.footer.innerHTML, /8(?:\.0+)? Mbps/);
    f.w.updateMediaInfo();
    assert.match(f.footer.innerHTML, /1920x1080.*8(?:\.0+)? Mbps/);
    assert.equal(f.w._corePlaybackMode, 0);
    assert.equal(
        f.players.length,
        0,
        "Telemetry must not start a second HLS loader"
    );
    assert.deepEqual(
        bridge.calls.map((call) => call.command),
        ["native_hls_start", "native_hls_stats"]
    );
    f.w.stbStop();
    assert.equal(bridge.calls.at(-1).command, "native_hls_stop");
});

test("pausing while native transport prepares preserves pause when its source arrives", async () => {
    const bridge = bridgeFixture();
    const f = fixture({ invoke: bridge.invoke });
    f.w.setPlayerMode(3);
    f.w.stbPlay("https://origin.invalid/live.m3u8");
    f.w.stbPause();
    bridge.calls[0].resolve({
        session: "a",
        url: "http://127.0.0.1:12345/a/index.m3u8",
    });
    await settle();
    assert.equal(f.w.video.src, "http://127.0.0.1:12345/a/index.m3u8");
    assert.equal(f.w.video.paused, true);
    assert.equal(f.w.video.playCalls, 0);
    f.w.stbContinue();
    assert.equal(f.w.video.playCalls, 1);
    f.w.stbStop();
});

test("late native startup cannot resurrect a stopped stream or replace a newer channel", async () => {
    for (const action of ["stop", "channel"]) {
        const bridge = bridgeFixture();
        const f = fixture({ invoke: bridge.invoke });
        f.w.setPlayerMode(3);
        f.w.stbPlay("https://origin.invalid/first.m3u8");
        if (action === "stop") f.w.stbStop();
        else {
            f.w.stbPlay("https://origin.invalid/second.m3u8");
            bridge.calls[1].resolve({
                session: "b",
                url: "http://127.0.0.1:12345/b/index.m3u8",
            });
            await settle();
        }
        bridge.calls[0].resolve({
            session: "a",
            url: "http://127.0.0.1:12345/a/index.m3u8",
        });
        await settle();
        assert.equal(
            f.w.video.src,
            action === "stop" ? "" : "http://127.0.0.1:12345/b/index.m3u8"
        );
        assert.equal(f.w.video.playCalls, action === "stop" ? 0 : 1);
        assert.deepEqual(bridge.calls.at(-1).args, { session: "a" });
        assert.equal(bridge.calls.at(-1).command, "native_hls_stop");
        f.w.stbStop();
    }
});

test("same-playSession HLS fallback rejects late native startup and stats callbacks", async () => {
    for (const phase of ["start", "stats"]) {
        const bridge = bridgeFixture();
        const f = fixture({ invoke: bridge.invoke });
        const url = "https://origin.invalid/live.m3u8";
        f.w.setPlayerMode(3);
        f.w.stbPlay(url);
        if (phase === "stats") {
            bridge.calls[0].resolve({
                session: "a",
                url: "http://127.0.0.1:12345/a/index.m3u8",
            });
            await settle();
            f.ready();
            f.info();
        }
        const session = f.w._playSession;
        // The Auto codec fallback re-enters this actual core path without a new user session.
        f.w._coreAutoHlsUsed = true;
        f.w.startCorePlayback(url, undefined, session);
        assert.equal(f.w._playSession, session);
        assert.equal(f.w._corePlaybackMode, 1);
        f.ready();
        f.players[0].emit("frag-loaded", chunk(1));
        assert.match(f.info(), /8(?:\.0+)? Mbps/);
        const activeSrc = f.w.video.src;
        if (phase === "start")
            bridge.calls[0].resolve({
                session: "a",
                url: "http://127.0.0.1:12345/a/index.m3u8",
            });
        else bridge.calls[1].resolve({ bytes: 99e6, samples: 1, seconds: 1 });
        await settle();
        assert.equal(f.w.video.src, activeSrc);
        assert.equal(f.w._coreNativeHls, null);
        assert.match(f.info(), /8(?:\.0+)? Mbps/);
        assert.equal(
            bridge.calls.filter((call) => call.command === "native_hls_stop")
                .length,
            1
        );
        f.w.stbStop();
    }
});

test("late native stats cannot restore a stopped meter or replace a newer channel's bitrate", async () => {
    for (const action of ["stop", "channel"]) {
        const bridge = bridgeFixture();
        const f = fixture({ invoke: bridge.invoke });
        f.w.setPlayerMode(3);
        f.w.stbPlay("https://origin.invalid/first.m3u8");
        bridge.calls[0].resolve({
            session: "a",
            url: "http://127.0.0.1:12345/a/index.m3u8",
        });
        await settle();
        f.ready();
        f.info();
        const staleStats = bridge.calls.at(-1);
        if (action === "stop") f.w.stbStop();
        else {
            f.w.stbPlay("https://origin.invalid/second.m3u8");
            bridge.calls.at(-1).resolve({
                session: "b",
                url: "http://127.0.0.1:12345/b/index.m3u8",
            });
            await settle();
            f.ready();
            f.info();
            bridge.calls.at(-1).resolve({ bytes: 2e6, samples: 1, seconds: 1 });
            await settle();
            assert.match(f.footer.innerHTML, /16(?:\.0+)? Mbps/);
        }
        const before = f.footer.innerHTML;
        staleStats.resolve({ bytes: 99e6, samples: 1, seconds: 1 });
        await settle();
        assert.equal(f.footer.innerHTML, before);
        if (action === "stop") assert.equal(f.w._coreNativeHls, null);
        else {
            near(f.w._coreNativeHls.mbps(), 16);
            assert.equal(f.w.video.src, "http://127.0.0.1:12345/b/index.m3u8");
        }
        f.w.stbStop();
    }
});

test("native transport startup failures preserve direct playback and relay errors retry direct only once", async () => {
    for (const failure of ["reject", "throw", "invalid", "media-error"]) {
        const bridge = bridgeFixture();
        const f = fixture({
            invoke:
                failure === "throw"
                    ? () => {
                          throw new Error("IPC unavailable");
                      }
                    : bridge.invoke,
        });
        const url = "https://origin.invalid/live.m3u8";
        f.w.setPlayerMode(3);
        f.w.stbPlay(url);
        if (failure === "reject")
            bridge.calls[0].reject(new Error("Relay unavailable"));
        if (failure === "invalid")
            bridge.calls[0].resolve({
                session: "bad",
                url: "https://elsewhere.invalid/untrusted.m3u8",
            });
        if (failure === "media-error")
            bridge.calls[0].resolve({
                session: "a",
                url: "http://127.0.0.1:12345/a/index.m3u8",
            });
        await settle();
        if (failure === "media-error") {
            f.w.video.error = { code: 2 };
            f.w.video.emit("error");
        }
        assert.equal(f.w.video.src, url);
        assert.equal(f.w.video.playCalls, failure === "media-error" ? 2 : 1);
        const plays = f.w.video.playCalls;
        f.w.video.error = { code: 2 };
        f.w.video.emit("error");
        f.flushActions();
        assert.equal(
            f.w.video.playCalls,
            plays,
            "No repeated relay/direct retry loop"
        );
        assert.equal(f.players.length, 0);
        assert.equal(
            bridge.calls.filter((call) => call.command === "native_hls_start")
                .length,
            failure === "throw" ? 0 : 1
        );
        f.w.stbStop();
    }
});

async function runCases() {
    let failures = 0;
    for (const [name, callback] of cases) {
        try {
            await callback();
            console.log("PASS " + name);
        } catch (error) {
            failures++;
            console.error("FAIL " + name);
            console.error(error);
        }
    }
    console.log(
        `${cases.length - failures}/${cases.length} stream bitrate tests passed`
    );
    process.exitCode = failures ? 1 : 0;
}
runCases().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
