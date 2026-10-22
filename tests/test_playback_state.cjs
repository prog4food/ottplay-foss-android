const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const sharedCore = require("./helpers/shared-core-runtime.cjs");
const root = path.resolve(__dirname, "..");

function include(c, file, names) {
    const ast = ts.createSourceFile(
        file,
        fs.readFileSync(path.join(root, file), "utf8"),
        ts.ScriptTarget.Latest,
        true
    );
    const nodes = ast.statements.filter(
        (n) => ts.isFunctionDeclaration(n) && names.includes(n.name?.text)
    );
    assert.equal(nodes.length, names.length);
    const code = ts
        .transpileModule(nodes.map((n) => n.getText(ast)).join("\n"), {
            compilerOptions: {
                module: ts.ModuleKind.ES2015,
                target: ts.ScriptTarget.ES5,
            },
        })
        .outputText.replace(/^export /gm, "");
    vm.runInContext(code, c);
}

function fixture(managed = false) {
    const values = {};
    const listeners = {};
    const video = {
        addEventListener(name, callback) {
            (listeners[name] ||= []).push(callback);
        },
        currentTime: 0,
        duration: 600,
        paused: true,
        readyState: 0,
        removeEventListener(name, callback) {
            listeners[name] = (listeners[name] || []).filter(
                (v) => v !== callback
            );
        },
    };
    const c = {
        _corePipSession: 0,
        _inLiveRestart: false,
        _playSession: 1,
        _standby: false,
        catIndex: 0,
        cats: { News: [101, 202] },
        catsArray: ["News"],
        channels: { 101: { rec: 24 }, 202: { rec: 48 } },
        clearInterval() {},
        clearTimeout() {},
        console,
        coreDeviceEffects: {},
        coreMediaBackend: null,
        curList: [101, 202],
        Date,
        document: { getElementById: () => null },
        m3uArr: {
            active: 0,
            M3Us: [
                {
                    medSourceId: "one",
                    www: "https://one.invalid/?private=secret",
                },
                { medSourceId: "two", www: "https://two.invalid/" },
            ],
        },
        medHistory: [],
        p_pref: "source",
        playTime: 0,
        playType: 0,
        prevArr: [],
        primaryIndex: 0,
        providerGetItem: (key) => values[key],
        providerSetItem: (key, value) => {
            values[key] = value;
        },
        setInterval() {
            return 1;
        },
        setTimeout() {},
        settings: { prevCount: 2 },
        sFavorites: 0,
        stbGetLen: () => video.duration,
        stbGetPosTime: () => video.currentTime,
        video,
    };
    if (managed) {
        c.stbPlay = function () {};
        c.__ottCoreTransport = { play: c.stbPlay };
    }
    c.window = c;
    vm.createContext(c);
    sharedCore(c);
    c.api = c.__ottClassicPlayback;
    c.api.importLegacy(); // Explicit retained-device ingress; snapshot itself is pure.
    include(c, "src/core/index.ts", [
        "getCoreMediaBackend",
        "openCoreEngineLease",
        "stbIsPlaying",
        "stbIsStandby",
    ]);
    c.startCoreEngine = (_url, _position, observe) => {
        c._playSession++;
        if (observe) observe();
    };
    c.stopCoreEngine = () => {
        c._playSession++;
    };
    c.openBackend = () => c.getCoreMediaBackend().open({ url: "fixture.mp4" });
    c.values = values;
    c.openMedia = (item) => {
        const media = c.__ottMedia.prepare(item, item.stream_url);
        c.api.command({
            channelId: media.ref.itemId,
            item: media.item,
            type: "vod",
        });
    };
    c.mediaPosition = () =>
        JSON.parse(values["mediaJournal.v1:" + c.__ottMedia.sourceId()])
            .history[0].position;
    c.listeners = listeners;
    c.emit = (name) => [...(listeners[name] || [])].forEach((cb) => cb());
    return c;
}

// Quitting during a pending local startup seek must keep the requested offset.
{
    const c = fixture(true);
    c.__ottActiveProviderDriver = { id: "offline" };
    c.api.command({ channelId: 101, position: 127, type: "live" });
    c.openBackend();
    include(c, "src/index.ts", ["body_onUnload"]);
    c.__ottCoreBackendPeek = () => c.getCoreMediaBackend();
    c.body_onUnload();
    assert.equal(c.api.bookmark().playTime, 127);
    c.getCoreMediaBackend().stop();
    c.body_onUnload();
    assert.equal(c.api.bookmark().playTime, 127);
}

// The normal command path owns kind/identity; observations keep generation stable.
{
    const c = fixture(true);
    c.__ottActiveProviderDriver = { id: "offline" };
    c.api.command({ channelId: 101, type: "live" });
    c.openBackend();
    c.video.duration = 60;
    c.video.readyState = 4;
    c.video.paused = false;
    c.video.currentTime = 59;
    c.emit("playing");
    c.api.checkpoint(c.api.snapshot(), true);
    assert.equal(c.api.bookmark().playTime, 59);
    c.video.currentTime = 60;
    c.emit("ended");
    assert.equal(c.api.snapshot().position, 60);
    assert.equal(
        c.api.bookmark().playTime,
        0,
        "actual EOF resets resume even when the last periodic sample was one second earlier"
    );
}

{
    const c = fixture();
    assert.equal(c.api.snapshot().target.kind, "live");
    assert.deepEqual(
        c.values,
        {},
        "Adopting a compatibility projection never checkpoints startup"
    );
    c.api.command({
        archiveStart: 1700000000,
        channelId: 101,
        type: "archive",
    });
    c.api.command({ type: "playing" });
    c.api.command({ position: 42, type: "position" });
    const initial = c.api.snapshot();
    assert.equal(initial.target.kind, "archive");
    assert.equal(initial.target.archiveStart, 1700000000);
    assert.equal(initial.position, 42);
    assert.equal(c.playType, 1700000000);
    assert.equal(c.playTime, 42);
    initial.target.channelId = "mutated";
    initial.historyTarget.kind = "vod";
    assert.equal(c.api.snapshot().target.channelId, "101");
    assert.equal(c.api.snapshot().historyTarget.kind, "archive");
    assert.equal(c.api.snapshot().generation, initial.generation);
    c.api.command({ type: "pause" });
    assert.equal(c.api.snapshot().phase, "paused");
    c.api.command({ type: "stop" });
    c.api.command({ type: "playing" });
    c.api.command({ position: 99, type: "position" });
    assert.equal(c.api.snapshot().phase, "stopped");
    assert.equal(c.api.snapshot().position, 42);
    c.api.command({ channelId: 202, type: "live" });
    assert.equal(c.api.snapshot().target.kind, "live");
    assert.equal(c.playType, 0);
}

// Old provider writes enter through explicit reconciliation once, without durable writes.
{
    const c = fixture();
    c.api.snapshot();
    c.playType = 1700000050;
    c.playTime = 9;
    const adopted = c.api.reconcile();
    assert.equal(adopted.target.kind, "archive");
    assert.equal(adopted.position, 9);
    assert.equal(c.api.reconcile().generation, adopted.generation);
    assert.deepEqual(c.values, {});
}

// Managed projection imports cannot manufacture decoder observations.
{
    const c = fixture(true);
    c.channels = { ...c.channels };
    assert.equal(
        c.api.reconcile().phase,
        "loading",
        "No backend confirmed play"
    );
    c.api.command({ type: "pause" });
    c.channels = { ...c.channels };
    assert.equal(c.api.reconcile().phase, "paused");
    c.api.command({ type: "stop" });
    c.channels = { ...c.channels };
    assert.equal(
        c.api.reconcile().phase,
        "stopped",
        "Catalog refresh cannot revive stop"
    );
    c.primaryIndex = 1;
    assert.equal(
        c.api.reconcile().phase,
        "loading",
        "A new target awaits its decoder"
    );
    c.stbPlay = function legacyPlay() {};
    c.primaryIndex = 0;
    assert.equal(
        c.api.reconcile().phase,
        "playing",
        "Unmanaged legacy fallback remains"
    );
}
for (const phase of ["pause", "stop"]) {
    const c = fixture(true);
    c.api.command({ type: phase });
    c.channels[101] = { ...c.channels[101], rec: 1 };
    assert.equal(
        c.api.reconcile().phase,
        "loading",
        "A replacement source cannot inherit " + phase
    );
}
{
    const c = fixture(true);
    c.api.command({ archiveStart: 1000, channelId: 101, type: "archive" });
    const handle = c.openBackend();
    c.video.readyState = 2;
    c.video.paused = false;
    c.emit("playing");
    c.video.currentTime = 24;
    c.emit("timeupdate");
    const before = c.api.snapshot();
    const owner = c.api.context();
    c.channels = { ...c.channels };
    const after = c.api.reconcile();
    assert.equal(
        after.generation,
        before.generation,
        "Catalog publication keeps the decoder generation"
    );
    assert.equal(
        after.position,
        before.position,
        "Catalog publication keeps measured position"
    );
    assert.equal(after.phase, "playing");
    assert.equal(handle.active(), true);
    assert.equal(owner.isCurrent(), false, "Old UI callbacks still retire");
    c.video.currentTime = 25;
    c.emit("timeupdate");
    assert.equal(c.api.snapshot().position, before.position + 1);
    c.channels[101] = { ...c.channels[101], rec: 1 };
    assert.equal(
        c.api.reconcile().phase,
        "loading",
        "A replacement channel record retires its old decoder"
    );
    assert.equal(handle.active(), false);
    c.p_pref = "other-provider";
    assert.equal(
        c.api.reconcile().phase,
        "loading",
        "A real source change awaits a new decoder"
    );
    assert.notEqual(c.api.snapshot().generation, before.generation);
    assert.equal(handle.active(), false);
}
{
    const c = fixture();
    c.openMedia({ stream_url: "failed-native.mp4" });
    const handle = c.openBackend();
    c.video.readyState = 2;
    c.video.paused = false;
    c.emit("playing");
    let ended = 0;
    c.__ottMedia.ended = () => ended++;
    c.emit("error");
    assert.equal(handle.snapshot().phase, "loading");
    assert.equal(
        c.api.snapshot().phase,
        "loading",
        "Native error stops reporting play"
    );
    const generation = c.api.snapshot().generation;
    c.emit("ended");
    assert.equal(c.api.snapshot().generation, generation);
    assert.equal(ended, 0, "Decoder failure is not natural queue completion");
    c.emit("playing");
    assert.equal(
        c.api.snapshot().phase,
        "playing",
        "In-place recovery remains valid"
    );
    c.emit("ended");
    assert.equal(ended, 1, "Recovered playback may finish normally");
}

// A new item cannot borrow the previous engine's position while attachment is pending.
{
    const c = fixture();
    const item = { current: 0, stream_url: "new.mp4" };
    c.video.currentTime = 125.9;
    c.openMedia(item);
    assert.equal(c.api.snapshot().phase, "loading");
    assert.equal(c.api.snapshot().position, 0);
    c.api.select(0, -1);
    assert.equal(
        item.current,
        0,
        "Unstarted departure does not persist previous source progress"
    );
    assert.equal(c.mediaPosition(), 0);
    c.api.command({ type: "playing" });
    c.api.select(0, -1);
    assert.equal(
        c.mediaPosition(),
        125.9,
        "A started backend supplies departure progress"
    );
}

// Media-origin events are generation-bound; native finite-channel detection is reclassification.
{
    const c = fixture();
    include(c, "src/core/index.ts", ["stbIsPlaying"]);
    include(c, "src/index.ts", ["checkMedia"]);
    c.mediaCheckTimer = null;
    c.updateMediaInfoDisplay = () => {};
    c.api.command({ channelId: 101, type: "live" });
    c.openBackend();
    c.video.paused = false;
    c.video.readyState = 2;
    c.emit("playing");
    const generation = c.api.snapshot().generation;
    c.checkMedia();
    assert.equal(
        c.api.snapshot().generation,
        generation,
        "Finite detection keeps backend ownership"
    );
    assert.equal(c.api.snapshot().target.kind, "vod");
    assert.equal(c.api.snapshot().target.channelId, "channel:101");
    assert.equal(c.api.snapshot().historyTarget.kind, "live");
    c.video.currentTime = 80;
    c.emit("timeupdate");
    assert.equal(c.api.snapshot().position, 80);
    c.video.paused = true;
    c.emit("pause");
    assert.equal(c.api.snapshot().phase, "paused");
    const old = Object.fromEntries(
        Object.entries(c.listeners).map(([k, v]) => [k, [...v]])
    );
    c.api.command({
        channelId: "next.mp4",
        item: { stream_url: "next.mp4" },
        type: "vod",
    });
    c._playSession++;
    c.openBackend();
    c.video.currentTime = 211;
    c.video.paused = false;
    for (const name of ["playing", "timeupdate", "pause"])
        for (const cb of old[name] || []) cb();
    assert.equal(c.api.snapshot().phase, "loading");
    assert.equal(c.api.snapshot().position, 0);
    c.video.readyState = 0;
    c.emit("playing");
    assert.equal(
        c.api.snapshot().phase,
        "loading",
        "Unready replacement cannot admit stale playing event"
    );
    c.video.currentTime = 0;
    c.video.readyState = 2;
    c.emit("playing");
    assert.equal(c.api.snapshot().phase, "playing");
    c.api.command({ type: "stop" });
    c.emit("playing");
    c.emit("timeupdate");
    assert.equal(c.api.snapshot().phase, "stopped");
}

// Local sources have media seek semantics before metadata; other provider heuristics stay unchanged.
for (const [provider, duration, expected] of [
    ["offline", 40, "vod"],
    ["offline", 0.25, "vod"],
    ["offline", 0, "vod"],
    ["offline", NaN, "vod"],
    ["offline", Infinity, "vod"],
    ["m3u", 40, "live"],
    ["m3u", 180, "live"],
    ["m3u", 181, "vod"],
    ["m3u", Infinity, "live"],
]) {
    const c = fixture();
    include(c, "src/index.ts", ["checkMedia"]);
    c.mediaCheckTimer = null;
    c.updateMediaInfoDisplay = () => {};
    c.__ottActiveProviderDriver = { id: provider };
    c.video.duration = duration;
    c.api.command({ channelId: 101, type: "live" });
    const generation = c.api.snapshot().generation;
    c.checkMedia();
    assert.equal(
        c.api.snapshot().target.kind,
        expected,
        `${provider}: ${duration}`
    );
    assert.equal(
        c.api.snapshot().generation,
        generation,
        "Detection keeps the playback session"
    );
    assert.equal(
        c.api.snapshot().historyTarget.kind,
        "live",
        "Local files retain channel identity"
    );
}

// The periodic native bridge cannot mark the old Shaka backend as a new attached source.
{
    const c = fixture();
    include(c, "src/core/index.ts", ["stbIsPlaying"]);
    include(c, "src/ui/index.ts", ["initBackgroundIntervals", "_t2"]);
    const timers = [];
    c.setInterval = (cb) => timers.push(cb);
    c.openMedia({ stream_url: "pending.mp4", title: "Pending" });
    c.video.currentTime = 220;
    c.video.readyState = 4;
    c.video.paused = false;
    c.initBackgroundIntervals();
    timers[0]();
    assert.equal(c.api.snapshot().phase, "loading");
    assert.equal(c.api.snapshot().position, 0);
    assert.equal(c.mediaPosition(), 0);
}

// Seeking inside one archive file rebinds the retained backend without mixing its file offset with archive time.
{
    const c = fixture();
    include(c, "src/core/index.ts", ["stbSetPosTime"]);
    c.seekCoreMedia = (position) => {
        c.video.currentTime = position;
    };
    c.api.command({
        archiveStart: 1700000000,
        channelId: 101,
        type: "archive",
    });
    c.openBackend();
    c.video.paused = false;
    c.video.readyState = 2;
    c.emit("playing");
    c.api.command({
        archiveStart: 1700000100,
        channelId: 101,
        type: "archive",
    });
    c.stbSetPosTime(120);
    assert.equal(c.api.snapshot().phase, "playing");
    assert.equal(
        c.api.snapshot().position,
        0,
        "Backend file offset is not logical archive elapsed time"
    );
    c.video.paused = true;
    c.emit("pause");
    assert.equal(c.api.snapshot().phase, "paused");
}

// Remote pause/resume also updates owned state when a native adapter replaces core methods.
{
    const c = fixture();
    include(c, "src/key-handler/index.ts", ["toggleMainPlayback"]);
    c._ = (text) => text;
    c.stbIsPlaying = () => !c.video.paused;
    c.stbPause = () => {
        c.video.paused = true;
    };
    c.stbContinue = () => {
        c.video.paused = false;
    };
    c.api.command({ channelId: "native.mp4", type: "vod" });
    c.api.command({ type: "playing" });
    c.video.paused = false;
    c.toggleMainPlayback();
    assert.equal(c.api.snapshot().phase, "paused");
    c.toggleMainPlayback();
    assert.equal(c.api.snapshot().phase, "playing");
    c.api.command({
        archiveStart: 1700000000,
        channelId: 101,
        type: "archive",
    });
    c.api.command({ type: "pause" });
    c.api.command({ position: 45, type: "position" });
    c.video.paused = true;
    c.s10resum = true;
    let epoch;
    c.playArchive = (value) => {
        epoch = value;
    };
    c.toggleMainPlayback();
    assert.equal(epoch, 1700000035);
}

// Polling a backend value first cannot suppress its next durable position report.
{
    const c = fixture();
    let now = 1700000000000;
    c.Date = class extends Date {
        static now() {
            return now;
        }
    };
    c.openMedia({ stream_url: "progress.mp4", title: "Progress" });
    c.openBackend();
    c.video.paused = false;
    c.video.readyState = 2;
    c.emit("playing");
    now += 6000;
    c.video.currentTime = 37;
    assert.equal(
        c.api.snapshot().position,
        0,
        "snapshot must not sample the backend"
    );
    c.emit("timeupdate");
    assert.equal(c.mediaPosition(), 37);
}

// Playlist identity is slot-scoped; private URLs/config fingerprints do not enter domain IDs.
for (const mutate of [
    (c) => {
        c.m3uArr.active = 1;
    },
    (c) => {
        c.m3uArr.M3Us[0] = { ...c.m3uArr.M3Us[0] };
    },
    (c) => {
        c.m3uArr.M3Us[0].www = "https://replacement.invalid/";
    },
]) {
    const c = fixture();
    c.p_pref = "m3u";
    c.api.command({ channelId: 101, type: "live" });
    assert.equal(
        c.api.snapshot().target.sourceId,
        c.__ottSourceIdentity.current(c)
    );
    let effects = 0;
    const callback = c.api.guard(() => effects++);
    mutate(c);
    callback();
    assert.equal(effects, 0);
}
for (const vod of [false, true]) {
    const c = fixture();
    c.p_pref = "m3u";
    if (vod) c.openMedia({ id: 41, stream_url: "movie.mp4", title: "Film" });
    else c.api.command({ channelId: 101, type: "live" });
    let effects = 0;
    const callback = c.api.guard(() => effects++);
    c.m3uArr.M3Us[0].medSourceId = "replacement";
    c.medSourceId = "replacement";
    callback();
    assert.equal(
        effects,
        vod ? 0 : 1,
        "Media-only source change affects VOD ownership but preserves TV"
    );
}
{
    const c = fixture();
    c.p_pref = "m3u";
    c.api.command({ channelId: 101, type: "live" });
    let effects = 0;
    const callback = c.api.guard(() => effects++);
    c.m3uArr.M3Us[0].medSourceId = "replacement";
    c.medSourceId = "replacement";
    callback();
    assert.equal(
        effects,
        1,
        "media portal changes preserve live channel ownership"
    );
}
{
    const c = fixture();
    c.p_pref = "m3u";
    let effects = 0;
    const callback = c.api.guard(() => effects++);
    c.m3uArr.active = "0";
    callback();
    callback();
    assert.equal(
        effects,
        1,
        "Equivalent slot representations retain one-shot ownership"
    );
}

// User catalog projections can be republished without retiring the playing channel.
{
    const c = fixture();
    c.api.command({ archiveStart: 1000, channelId: 101, type: "archive" });
    const handle = c.openBackend();
    c.video.readyState = 2;
    c.video.paused = false;
    c.emit("playing");
    const oldView = c.api.context();
    assert.equal(typeof oldView.isCurrentBackend, "function");
    c.cats = { Favorites: [202], Renamed: [202, 101] };
    c.catsArray = ["Favorites", "Renamed"];
    c.catIndex = 1;
    c.primaryIndex = 1;
    c.curList = c.cats.Renamed;
    assert.equal(oldView.isCurrent(), false, "Old UI callbacks still retire");
    assert.equal(handle.active(), true, "Decoder belongs to channel identity");
    c.video.currentTime = 11;
    c.emit("timeupdate");
    assert.equal(c.api.snapshot().position, 11);
    let seeks = 0;
    c.seekCoreMedia = (position) => {
        seeks++;
        c.video.currentTime = position;
    };
    c.api.command({
        archiveStart: 1000,
        channelId: 101,
        position: 50,
        type: "archive",
    });
    c.getCoreMediaBackend().seek(5);
    assert.equal(seeks, 1, "Same channel can rebind after group reorder");
    c.api.command({
        archiveStart: 1000,
        channelId: 202,
        position: 50,
        type: "archive",
    });
    c.getCoreMediaBackend().seek(10);
    assert.equal(seeks, 1, "Different target needs its own decoder");
}

// The actual core port can rebind archive seeks only within its captured source.
{
    const c = fixture();
    c.api.command({
        archiveStart: 1000,
        channelId: 101,
        position: 0,
        type: "archive",
    });
    const handle = c.openBackend();
    c.video.readyState = 2;
    c.video.paused = false;
    c.video.currentTime = 5;
    c.emit("playing");
    let seeks = 0;
    c.seekCoreMedia = (position) => {
        seeks++;
        c.video.currentTime = position;
    };
    c.api.command({
        archiveStart: 1000,
        channelId: 101,
        position: 20,
        type: "archive",
    });
    handle.seek(25);
    assert.equal(
        seeks,
        0,
        "escaped decoder handle cannot adopt a fresh generation"
    );
    c.getCoreMediaBackend().seek(25);
    assert.equal(
        seeks,
        1,
        "explicit same-source file seek rebinds the decoder"
    );
    c.p_pref = "replacement";
    const lastPosition = c.api.snapshot().position;
    assert.equal(
        handle.active(),
        false,
        "Source retires before the next command"
    );
    c.video.currentTime = 90;
    c.emit("timeupdate");
    assert.equal(
        c.api.snapshot().position,
        lastPosition,
        "Old source event is inert"
    );
    handle.seek(30);
    c.getCoreMediaBackend().seek(30);
    assert.equal(seeks, 1, "Both seek routes reject the departed source");
    c.api.command({
        archiveStart: 1000,
        channelId: 101,
        position: 100,
        type: "archive",
    });
    c.getCoreMediaBackend().seek(30);
    assert.equal(seeks, 1, "replacement source must wait for its own decoder");
}

// Backgrounding persists actual archive/VOD semantics and respects reset suspension.
for (const kind of ["archive", "vod"]) {
    const c = fixture();
    include(c, "src/index.ts", ["body_onUnload"]);
    include(c, "src/channels/index.ts", ["setCurrent"]);
    const item = { stream_url: "movie.mp4" };

    if (kind === "vod") c.openMedia(item);
    else
        c.api.command(
            kind === "archive"
                ? { archiveStart: 1700000000, channelId: 101, type: kind }
                : { channelId: item.stream_url, item, type: kind }
        );
    c.api.command({ type: "playing" });
    c.video.currentTime = 30;
    c.api.command({ position: 30, type: "position" });
    c.prevArr = [{ c: 0, ci: 202, i: 1 }];
    c.body_onUnload();
    assert.equal(c.prevArr.length, 1);
    assert.equal(
        c.prevArr[0].ci,
        202,
        "Backgrounding does not insert the current channel into previous history"
    );
    assert.equal(
        kind === "vod"
            ? c.mediaPosition()
            : JSON.parse(c.values.playbackJournal).bookmark.position,
        30,
        "Visibility forces the last position despite the periodic throttle"
    );
    assert.equal(c.api.snapshot().target.kind, kind);
    assert.equal(c.api.snapshot().position, 30);
    if (kind === "archive")
        assert.equal(JSON.parse(c.values.playbackJournal).bookmark.kind, kind);
    c.api.suspendPersistence();
    for (const key of Object.keys(c.values)) delete c.values[key];
    c.body_onUnload();
    c.api.command({ type: "stop" });
    assert.deepEqual(
        c.values,
        {},
        "Hidden/unload/stop cannot resurrect reset persistence"
    );
}
console.log(
    "PASS: owned playback state, media-event lifetime, M3U scope, loading position, and visibility persistence"
);

// Old numeric/hash history cannot silently bind to another current provider ID.
for (const oldDocument of ["mirrors", "unscoped", "scoped"]) {
    const c = fixture();
    c.__ottActiveProviderDriver = {
        credentials: () => ({
            server: "https://account.invalid",
            username: "one",
        }),
        id: "source",
    };
    c.channels = {
        7: { itemId: "station:other" },
        21: { itemId: "station:wanted", legacyChannelId: 7 },
        30: { itemId: "station:safe", legacyChannelId: 9 },
    };
    c.cats = { News: [7, 21, 30] };
    c.curList = c.cats.News;
    const history = [
        { channelId: "7", kind: "live" },
        { archiveStart: 100, channelId: "9", kind: "archive" },
        { channelId: "40", kind: "live" },
    ];
    const key = "playbackJournal:" + c.__ottSourceIdentity.current(c);
    if (oldDocument !== "mirrors")
        c.values[oldDocument === "scoped" ? key : "playbackJournal"] =
            JSON.stringify({
                bookmark: history[0],
                history,
                sourceId:
                    oldDocument === "scoped"
                        ? c.__ottSourceIdentity.current(c)
                        : "source",
                updatedAt: 10,
                version: 2,
            });
    else {
        c.values.prevArr = JSON.stringify([
            { c: 0, ci: 7 },
            { c: 0, ci: 9, t: 100 },
            { c: 0, ci: 40 },
        ]);
        c.values.continueWatch = JSON.stringify({
            channelId: 7,
            mode: "live",
            v: 1,
        });
    }
    c.api.hydrate();
    assert.equal(
        c.api.bookmark(),
        null,
        "A colliding raw bookmark never opens the other channel"
    );
    assert.equal(c.prevArr[0].i, -1);
    assert(c.prevArr[0].ci.includes('"ambiguous":true'));
    assert.equal(c.prevArr[1].ci, 30, "Unique old alias resolves");
    assert.equal(c.prevArr[2].i, -1, "Missing legacy reference is retained");
    c.api.command({ channelId: 21, type: "live" });
    const saved = JSON.parse(c.values[key]);
    assert.equal(saved.channelReferences, 1);
    assert(saved.history[0].channelId.includes('"ambiguous":true'));
    c.channels[40] = { itemId: "station:returning" };
    c.cats.News.push(40);
    c.api.hydrate();
    assert.equal(
        c.prevArr[2].ci,
        40,
        "An absent unambiguous channel can return"
    );
    // Even after the competing station disappears, known ambiguity is retained.
    delete c.channels[7];
    c.cats.News.shift();
    c.api.hydrate();
    assert.equal(c.prevArr[0].i, -1);
    c.values[key] = JSON.stringify({
        bookmark: { channelId: "21", kind: "live" },
        channelReferences: 1,
        history: [],
        sourceId: c.__ottSourceIdentity.current(c),
        updatedAt: 20,
        version: 2,
    });
    c.channels[50] = { itemId: "station:new", legacyChannelId: 21 };
    c.cats.News.push(50);
    let referenceIndexes = 0;
    const createReferences = c.__ottChannelReferences.create;
    c.__ottChannelReferences.create = (...args) => {
        referenceIndexes++;
        return createReferences(...args);
    };
    assert.equal(
        c.api.bookmark().channelId,
        21,
        "Scoped canonical records ignore old aliases"
    );
    assert.equal(
        referenceIndexes,
        0,
        "Canonical checkpoints do not scan the channel catalog"
    );
}
console.log(
    "PASS conservative journal imports: collision, absent/returning and scoped canonical IDs"
);
