const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
function compile(source) {
    return ts
        .transpileModule(source, {
            compilerOptions: {
                module: ts.ModuleKind.ES2015,
                target: ts.ScriptTarget.ES5,
            },
        })
        .outputText.replace(/^import .*\n/gm, "")
        .replace(/^export /gm, "");
}
const core = [
    "src/utils/helpers.ts",
    "src/core/native-hls.ts",
    "src/plugins/access-media.ts",
    "src/core/index.ts",
]
    .map((file) => compile(read(file)))
    .join("\n");
const entry = read("src/index.ts");
const begin = entry.indexOf("// Capacitor Mode C: native media bridges");
const end = entry.indexOf("// Tauri Mode B: OS MediaSession", begin);
assert(begin >= 0 && end > begin);
const nativeEnd = entry.indexOf("// Tauri Mode B: frameless window", end);
assert(nativeEnd > end);
const entryAst = ts.createSourceFile(
    "index.ts",
    entry,
    ts.ScriptTarget.Latest,
    true
);
const metadataDeclaration = entryAst.statements.find(
    (node) =>
        ts.isFunctionDeclaration(node) &&
        node.name?.text === "nativeMediaMetadata"
);
assert(metadataDeclaration, "Exercise the actual shared metadata collector");
const metadata = compile(metadataDeclaration.getText(entryAst));
const wrapper =
    compile(read("src/plugins/access-media.ts")) +
    metadata +
    compile(entry.slice(begin, end));
const nativeWrappers =
    compile(read("src/plugins/access-media.ts")) +
    metadata +
    compile(entry.slice(begin, nativeEnd));
const settle = () => new Promise((resolve) => setImmediate(resolve));

function metadataFixture(platform) {
    const calls = [];
    const reads = [];
    const timers = new Map();
    let nextTimer = 0;
    let playing = false;
    const values = {
        channelText: "  News  ",
        duration: 300,
        fallbackText: "Fallback",
        picon: "  https://example.invalid/picon.png  ",
        position: 45,
    };
    const w = {
        channels: {
            news: { channel_name: "Channel name", icon: "fallback.png" },
        },
        clearInterval(id) {
            timers.delete(id);
        },
        clearTimeout(id) {
            timers.delete(id);
        },
        console: { warn() {} },
        curList: ["news"],
        document: {
            getElementById(id) {
                reads.push("element:" + id);
                return {
                    textContent:
                        id === "channel"
                            ? values.channelText
                            : values.fallbackText,
                };
            },
        },
        getChannelPicon(id) {
            reads.push("picon:" + id);
            return values.picon;
        },
        playType: 1,
        primaryIndex: 0,
        setInterval(fn) {
            timers.set(++nextTimer, fn);
            return nextTimer;
        },
        setTimeout(fn) {
            timers.set(++nextTimer, fn);
            return nextTimer;
        },
        stbContinue() {
            playing = !playing;
        },
        stbGetLen() {
            reads.push("duration");
            return values.duration;
        },
        stbGetPosTime() {
            reads.push("position");
            return values.position;
        },
        stbIsPlaying() {
            return playing;
        },
        stbPause() {
            playing = false;
        },
        stbPlay(url) {
            reads.push("play:" + url);
            playing = true;
        },
        stbStop() {
            playing = false;
        },
    };
    if (platform === "tauri") {
        w.__TAURI__ = {};
        w.tauriInvoke = (method, value) => {
            calls.push([method, value]);
            return Promise.resolve({ ok: true });
        };
    } else {
        w.Capacitor = { getPlatform: () => platform };
        w.MobileNativeMedia = new Proxy(
            {},
            {
                get: (_, method) => (value) => {
                    calls.push([method, value]);
                    return Promise.resolve({ ok: true });
                },
            }
        );
    }
    w.window = w;
    vm.createContext(w);
    require("./helpers/private-runtime.cjs")(w, "src/device/media-backend.ts");
    require("./helpers/private-runtime.cjs")(w, "src/device/media-session.ts");
    const backend = w.__ottMediaBackend.create({
        clearInterval: w.clearInterval,
        context: () => null,
        emit() {},
        open(request) {
            reads.push("play:" + request.url);
            playing = true;
            return {
                dispose() {
                    playing = false;
                },
                pause() {
                    playing = false;
                },
                resume() {
                    playing = true;
                },
                sample: () => ({
                    duration: values.duration,
                    paused: !playing,
                    position: values.position,
                    ready: 2,
                }),
                seek() {},
            };
        },
        setInterval: w.setInterval,
    });
    w.__ottCoreBackend = () => backend;
    w.__ottCoreTransport = { configure() {} };
    require("./helpers/private-runtime.cjs")(w, "src/device/native-pip.ts");
    w.stbPlay = (url) => backend.open({ url });
    w.stbStop = () => backend.stop();
    w.stbPause = () => backend.current().pause();
    w.stbContinue = () =>
        playing ? backend.current().pause() : backend.current().resume();
    vm.runInContext(nativeWrappers, w);
    const startName =
        platform === "tauri" ? "start_media_session" : "startBackgroundAudio";
    const updateName =
        platform === "tauri" ? "update_media_session" : "updateBackgroundAudio";
    function play() {
        w.stbPlay("fixture.mp4");
        const value = calls.findLast(([method]) => method === startName)?.[1];
        assert(value, platform + " starts its actual native metadata bridge");
        return JSON.parse(JSON.stringify(value));
    }
    function update() {
        for (const callback of [...timers.values()]) callback();
        const value = calls.findLast(([method]) => method === updateName)?.[1];
        assert(value, platform + " updates its actual native metadata bridge");
        return JSON.parse(JSON.stringify(value));
    }
    return { play, reads, update, values, w };
}

function checkNativeMetadata() {
    for (const platform of ["android", "ios", "tauri"]) {
        {
            const f = metadataFixture(platform);
            const live = f.play();
            let movie = {
                payload: {
                    logo_30x30: "https://example.invalid/movie.png",
                    title: "Selected movie",
                },
            };
            f.w.__ottMedia = { current: () => movie };
            f.w.playType = -1;
            const expected = {
                ...live,
                artworkUrl: "https://example.invalid/movie.png",
                title: "Selected movie",
            };
            assert.deepEqual(f.play(), expected);
            f.values.channelText = "Late TV programme";
            f.values.position = 90;
            assert.deepEqual(f.update(), { ...expected, positionSec: 90 });
            movie = { payload: { title: "Movie without poster" } };
            const withoutPoster = {
                ...expected,
                positionSec: 90,
                title: movie.payload.title,
            };
            delete withoutPoster.artworkUrl;
            assert.deepEqual(f.play(), withoutPoster);
            movie = null;
            assert.deepEqual(f.update(), {
                ...withoutPoster,
                title: "OTT-play FOSS",
            });
            f.w.playType = 0;
            assert.deepEqual(f.play(), {
                artist: "Now playing",
                artworkUrl: live.artworkUrl,
                seekable: false,
                title: "Late TV programme",
            });
        }
        {
            const f = metadataFixture(platform);
            const first = f.play();
            assert.deepEqual(first, {
                artist: "Now playing",
                artworkUrl: "https://example.invalid/picon.png",
                durationSec: 300,
                positionSec: 45,
                seekable: true,
                title: "News",
            });
            assert.deepEqual(f.reads, [
                "play:fixture.mp4",
                "element:channel",
                "picon:news",
                "duration",
                "position",
            ]);
            f.values.channelText = "Updated title";
            f.values.position = 90;
            assert.deepEqual(f.update(), {
                ...first,
                positionSec: 90,
                title: "Updated title",
            });
            assert.equal(
                first.title,
                "News",
                "Earlier payloads remain independent"
            );
        }
        {
            const f = metadataFixture(platform);
            f.w.playType = 0;
            assert.deepEqual(f.play(), {
                artist: "Now playing",
                artworkUrl: "https://example.invalid/picon.png",
                seekable: false,
                title: "News",
            });
            assert.deepEqual(
                f.reads.slice(-2),
                ["duration", "position"],
                "Live still performs the existing reads"
            );
        }
        {
            const f = metadataFixture(platform);
            f.values.channelText = "";
            f.values.fallbackText = "";
            f.values.picon = {};
            f.values.duration = Infinity;
            f.values.position = -1;
            assert.deepEqual(f.play(), {
                artist: "Now playing",
                artworkUrl: "fallback.png",
                seekable: false,
                title: "Channel name",
            });
            assert.deepEqual(f.reads.slice(1, 3), [
                "element:channel",
                "element:cname",
            ]);
        }
        {
            const f = metadataFixture(platform);
            f.values.channelText = "   ";
            f.values.picon = "";
            f.w.channels.news.icon = "";
            f.values.position = NaN;
            assert.deepEqual(
                f.play(),
                {
                    artist: "Now playing",
                    durationSec: 300,
                    seekable: true,
                    title: "OTT-play FOSS",
                },
                "Whitespace title and invalid position retain existing omission rules"
            );
        }
        {
            const f = metadataFixture(platform);
            f.values.picon = "";
            Object.defineProperty(f.w.channels.news, "icon", {
                get() {
                    f.reads.push("throwing-icon-getter");
                    throw Error("Fixture bridge not ready");
                },
            });
            assert.deepEqual(f.play(), {
                artist: "Now playing",
                seekable: false,
                title: "News",
            });
            assert.deepEqual(
                f.reads,
                [
                    "play:fixture.mp4",
                    "element:channel",
                    "picon:news",
                    "throwing-icon-getter",
                ],
                "A thrown getter stops subsequent metadata reads without stopping playback"
            );
        }
        {
            const f = metadataFixture(platform);
            f.w.stbGetLen = () => {
                f.reads.push("throwing-duration");
                throw Error("Fixture duration unavailable");
            };
            assert.deepEqual(f.play(), {
                artist: "Now playing",
                artworkUrl: "https://example.invalid/picon.png",
                seekable: false,
                title: "News",
            });
            assert.equal(f.reads.includes("position"), false);
        }
    }
}

function fixture(platform = "android") {
    const nativeCalls = [];
    const streams = [];
    const timers = new Map();
    let timerId = 0;
    const elements = {};
    function element(id) {
        return (elements[id] ||= {
            clientHeight: 288,
            clientWidth: 512,
            style: {},
        });
    }
    function media(id) {
        const events = new Map();
        return Object.assign(element(id), {
            addEventListener(name, callback) {
                if (!events.has(name)) events.set(name, new Set());
                events.get(name).add(callback);
            },
            audioTracks: [{ enabled: true }, { enabled: false }],
            canPlayType: () => "probably",
            currentTime: 0,
            duration: 600,
            muted: id === "videopip",
            pause() {
                this.paused = true;
                for (const callback of events.get("pause") || []) callback();
            },
            paused: true,
            play() {
                this.paused = false;
                this.playCalls++;
                for (const callback of events.get("playing") || []) callback();
                return Promise.resolve();
            },
            playCalls: 0,
            readyState: 2,
            removeAttribute(name) {
                delete this[name];
            },
            removeEventListener(name, callback) {
                events.get(name)?.delete(callback);
            },
            textTracks: [
                { kind: "subtitles", label: "English", mode: "disabled" },
            ],
            videoHeight: 720,
            videoWidth: 1280,
            volume: 1,
        });
    }
    function Hls() {
        this.events = {};
        streams.push(this);
    }
    Hls.Events = {
        AUDIO_TRACKS_UPDATED: "audio",
        ERROR: "error",
        MANIFEST_PARSED: "manifest",
    };
    Hls.ErrorTypes = { MEDIA_ERROR: "media", NETWORK_ERROR: "network" };
    Hls.isSupported = () => true;
    Hls.prototype.loadSource = function (url) {
        this.url = url;
    };
    Hls.prototype.attachMedia = function (video) {
        this.video = video;
    };
    Hls.prototype.on = function (event, callback) {
        this.events[event] = callback;
    };
    Hls.prototype.destroy = function () {
        this.destroyed = true;
    };
    function Shaka(video) {
        this.video = video;
        streams.push(this);
    }
    Shaka.isBrowserSupported = () => true;
    Shaka.prototype.load = function (url, position) {
        this.url = url;
        this.position = position;
        return Promise.resolve().then(() => {
            this.video.currentTime = position || 0;
        });
    };
    Shaka.prototype.destroy = function () {
        this.destroyed = true;
        return Promise.resolve();
    };
    const w = {
        _: (key) =>
            key === "Picture in Picture" ? "Картинка в картинке" : key,
        $: (selector) => {
            const el = element(selector.slice(1));
            return {
                css(styles) {
                    Object.assign(el.style, styles);
                    return this;
                },
                hide() {
                    el.style.display = "none";
                    return this;
                },
                html() {
                    return this;
                },
                show() {
                    el.style.display = "block";
                    return this;
                },
            };
        },
        applyChannelPreference() {},
        Capacitor: { getPlatform: () => platform },
        clearInterval(id) {
            timers.delete(id);
        },
        clearTimeout(id) {
            timers.delete(id);
        },
        console: { error() {}, log() {}, warn() {} },
        DashExoPlayer: new Proxy(
            {},
            {
                get() {
                    throw Error(
                        "normal playback must not enter a native overlay"
                    );
                },
            }
        ),
        document: {
            body: { classList: { add() {}, remove() {} }, style: {} },
            getElementById: (id) => elements[id] || null,
        },
        Hls,
        innerHeight: 720,
        innerWidth: 1280,
        MobileNativeMedia: new Proxy(
            {},
            {
                get:
                    (_, method) =>
                    (...args) => {
                        nativeCalls.push([method, ...args]);
                        return Promise.resolve({ ok: true });
                    },
            }
        ),
        playType: -1,
        setInterval(fn) {
            timers.set(++timerId, fn);
            return timerId;
        },
        setTimeout(fn) {
            timers.set(++timerId, fn);
            return timerId;
        },
        shaka: { Player: Shaka },
    };
    w.window = w;
    vm.createContext(w);
    require("./helpers/shared-core-runtime.cjs")(w);
    vm.runInContext(core, w);
    w.video = media("video");
    w.videoPip = media("videopip");
    element("vdiv");
    const original = {
        audio: w.setAudioTrack,
        isPlaying: w.stbIsPlaying,
        mute: w.stbToggleMute,
        seek: w.stbSetPosTime,
    };
    vm.runInContext(wrapper, w);
    return { elements, nativeCalls, original, streams, timers, w };
}

async function run() {
    checkNativeMetadata();
    {
        const { w, streams, original, nativeCalls, elements } = fixture();
        w.setPlayerMode(2);
        w.stbPlay("https://example.invalid/video.mpd", 31);
        assert.equal(streams.length, 1);
        assert.equal(
            streams[0].video,
            w.video,
            "DASH uses the same controllable video as browser TS"
        );
        assert.equal(streams[0].url, "https://example.invalid/video.mpd");
        assert.equal(streams[0].position, 31);
        assert.equal(w.stbIsPlaying, original.isPlaying);
        assert.equal(
            w.stbIsPlaying(),
            false,
            "Shaka must finish loading before play"
        );
        await settle();
        assert.equal(w.stbIsPlaying(), true);
        assert.equal(w.stbGetPosTime(), 31);
        assert.equal(w.stbGetLen(), 600);
        w.stbPause();
        assert.equal(w.stbIsPlaying(), false);
        w.stbContinue();
        assert.equal(w.stbIsPlaying(), true);
        w.stbSetPosTime(95);
        w.stbToggleMute();
        w.setAudioTrack(1);
        assert.equal(w.video.currentTime, 95);
        assert.equal(w.video.muted, true);
        assert.equal(w.video.audioTracks[1].enabled, true);
        w.stbSetWindow();
        assert.equal(
            elements.vdiv.style.width,
            "512px",
            "OTT list preview retains its DOM bounds"
        );
        assert.equal(w.video, streams[0].video);
        assert.equal(
            nativeCalls.some(([name]) => /Dash|Pip/.test(name)),
            false
        );
        w.setPlayerMode(1);
        w.stbPlay("https://example.invalid/channel.m3u8");
        assert.equal(streams[0].destroyed, true);
        assert.equal(streams.length, 1, "new engine waits for Shaka detach");
        await settle();
        const hls = streams.at(-1);
        hls.events.manifest();
        assert.equal(
            hls.video,
            w.video,
            "switching formats keeps one shared video surface"
        );
        w.stbStop();
        assert.equal(hls.destroyed, true);
        assert.equal(w.stbIsPlaying(), false);
    }
    {
        const { w, streams, timers, nativeCalls } = fixture();
        w.setPlayerMode(1);
        w.stbPlay("https://example.invalid/channel.m3u8");
        const lateManifest = streams[0].events.manifest;
        const lateMeta = [...timers.values()][0];
        w.stbStop();
        const callsAtStop = nativeCalls.length;
        lateManifest();
        lateMeta();
        await Promise.resolve();
        assert.equal(
            w.stbIsPlaying(),
            false,
            "queued callbacks cannot restart stopped playback"
        );
        assert.equal(
            nativeCalls.length,
            callsAtStop,
            "late metadata cannot recreate the stopped background session"
        );
        assert.equal(timers.size, 0);
    }
    {
        const { w, timers, nativeCalls } = fixture();
        w.stbPlay("https://example.invalid/first.mp4");
        const oldMeta = [...timers.values()][0];
        w.stbPlay("https://example.invalid/second.mp4");
        const currentMeta = [...timers.values()][0];
        const calls = nativeCalls.length;
        oldMeta();
        assert.equal(
            nativeCalls.length,
            calls,
            "superseded stream metadata stays cancelled"
        );
        w.stbPause();
        currentMeta();
        assert.equal(nativeCalls.at(-1)[0], "pauseBackgroundAudio");
        assert.equal(timers.size, 0);
    }
    for (const platform of ["android", "web"]) {
        const { w, streams, nativeCalls, elements } = fixture(platform);
        w.setPlayerMode(1);
        w.stbPlay("https://example.invalid/main.m3u8");
        streams[0].events.manifest();
        w.stbPlayPip("https://example.invalid/second.m3u8");
        assert.equal(streams[1].url, "https://example.invalid/second.m3u8");
        assert.equal(streams[1].video, w.videoPip);
        assert.equal(w.videoPip.muted, true);
        assert.equal(elements.videopip.style.display, "block");
        assert.equal(w.stbIsPlaying(), true);
        w.stbStopPip();
        assert.equal(streams[1].destroyed, true);
        assert.equal(w.videoPip.paused, true);
        assert.equal(
            w.stbIsPlaying(),
            true,
            "closing the second channel leaves the primary stream playing"
        );
        assert.equal(
            nativeCalls.some(([name]) => /Pip/.test(name)),
            false,
            "second-channel controls never enter or exit Activity PiP"
        );
    }
    {
        const { w, nativeCalls, elements } = fixture("ios");
        w.stbPlayPip("https://example.invalid/second.m3u8");
        await settle();
        assert.equal(nativeCalls[0][0], "playPip");
        assert.equal(nativeCalls[0][1].subtitle, "Картинка в картинке");
        assert.equal(
            nativeCalls[0][1].url,
            "https://example.invalid/second.m3u8"
        );
        assert.equal(elements.videopip.style.display, "none");
        w.stbStopPip();
        await settle();
        assert.equal(nativeCalls.at(-1)[0], "stopPip");
    }
    console.log(
        "OK: Capacitor shares TS playback/control/layout and cancels stale callbacks; both native shells preserve shared metadata and exception behavior"
    );
}
run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
