const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
const core = ts
    .transpileModule(
        ["src/core/native-hls.ts", "src/core/index.ts"]
            .map((file) => fs.readFileSync(path.join(root, file), "utf8"))
            .join("\n"),
        {
            compilerOptions: {
                module: ts.ModuleKind.ES2015,
                target: ts.ScriptTarget.ES5,
            },
        }
    )
    .outputText.replace(/^import .*\n/gm, "")
    .replace(/^export /gm, "");

function fixture() {
    const players = [];
    const timers = new Map();
    let nextTimer = 0;
    function Hls(config) {
        this.config = config;
        this.events = {};
        this.levels = [];
        players.push(this);
    }
    Hls.Events = {
        AUDIO_TRACKS_UPDATED: "audio",
        ERROR: "error",
        MANIFEST_PARSED: "manifest",
    };
    Hls.ErrorTypes = { MEDIA_ERROR: "media", NETWORK_ERROR: "network" };
    Hls.isSupported = () => true;
    Hls.prototype.on = function (event, callback) {
        this.events[event] = callback;
    };
    Hls.prototype.loadSource = function (url) {
        this.url = url;
    };
    Hls.prototype.attachMedia = function () {};
    Hls.prototype.destroy = function () {
        this.destroyed = true;
    };
    Hls.prototype.recoverMediaError = function () {
        this.recovered = true;
    };
    Hls.prototype.startLoad = function () {};
    const w = {
        _: (s) => s,
        $: () => ({ hide() {}, html() {} }),
        applyChannelPreference() {},
        clearInterval() {},
        clearTimeout(id) {
            timers.delete(id);
        },
        console: { error() {}, log() {}, warn() {} },
        document: { body: { style: {} } },
        Hls,
        setInterval() {},
        setTimeout(fn) {
            timers.set(++nextTimer, fn);
            return nextTimer;
        },
        showShift() {},
    };
    w.window = w;
    vm.createContext(w);
    require("./helpers/shared-core-runtime.cjs")(w);
    vm.runInContext(core, w);
    w.playerMode = 1;
    w.playType = 1700000000;
    w.video = {
        canPlayType: () => "probably",
        currentTime: 0,
        pause() {
            this.paused = true;
        },
        paused: true,
        play() {
            this.paused = false;
            this.playCalls++;
        },
        playCalls: 0,
        removeAttribute() {},
    };
    return { players, timers, w };
}

{
    const { w, players } = fixture();
    w.stbPlay("archive.m3u8", 35);
    w.stbPause();
    players[0].events.manifest();
    assert.equal(
        w.video.paused,
        true,
        "a late manifest must preserve explicit pause"
    );
    assert.equal(w.video.playCalls, 0);
    assert.equal(
        players[0].config.startPosition,
        35,
        "pause must not discard the requested archive seek"
    );
    assert.equal(w.video.currentTime, 0, "HLS controls its buffered seek");
    w.stbContinue();
    assert.equal(w.video.paused, false, "explicit resume must still work");
    players[0].events.error(null, {
        details: "bufferAppendError",
        fatal: true,
        type: "media",
    });
    assert.equal(
        players[0].recovered,
        true,
        "pause must not invalidate current HLS error handlers"
    );
}

{
    const { w, players } = fixture();
    w.stbPlay("archive.m3u8");
    players[0].events.manifest();
    w.stbPause();
    const fatal = { details: "bufferAppendError", fatal: true, type: "media" };
    players[0].events.error(null, fatal);
    players[0].events.error(null, fatal);
    assert.equal(w.video.src, "archive.m3u8");
    assert.equal(
        w.video.paused,
        true,
        "native recovery must preserve explicit pause"
    );
    assert.equal(w.video.playCalls, 1);
    w.stbContinue();
    assert.equal(w.video.paused, false);
}

{
    const { w, players, timers } = fixture();
    w.playType = 0;
    w.stbPlay("live.m3u8");
    players[0].events.error(null, {
        details: "manifestParsingError",
        fatal: true,
        type: "network",
    });
    assert.equal(timers.size, 1);
    const staleRetry = [...timers.values()][0];
    w.stbPause();
    assert.equal(timers.size, 0, "pause must cancel a queued reconnect");
    staleRetry();
    assert.equal(
        players.length,
        1,
        "a queued callback must not restart paused playback"
    );
    w.stbPlay("live.m3u8");
    players[1].events.manifest();
    assert.equal(
        w.video.paused,
        false,
        "a new explicit request must clear paused intent"
    );
}

console.log(
    "OK: late HLS manifests, native recovery, and reconnect preserve pause intent"
);
