const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const acorn = require("acorn");
const sharedCore = require("./helpers/shared-core-runtime.cjs");
const root = path.resolve(__dirname, "..");
const plain = (value) => JSON.parse(JSON.stringify(value));

function fixture() {
    let nextTimer = 0;
    const timers = new Map();
    const cancelled = new Set();
    const effects = [];
    const stored = {};
    const c = {
        _: (text) => text,
        _prog100: { name: "Programme" },
        catIndex: 0,
        cats: { one: [101, 202, 303], two: [101, 303] },
        catsArray: ["one", "two"],
        channels: { 101: { rec: 24 }, 202: { rec: 48 }, 303: { rec: 0 } },
        clearTimeout: (id) => {
            cancelled.add(id);
        },
        console,
        curList: [101, 202, 303],
        Date: class extends Date {
            static now() {
                return 1000000000;
            }
        },
        formatSeekOffset: String,
        medHistory: [],
        p_pref: "source-a",
        playArchive: (epoch) => effects.push(["archive", epoch]),
        playChannel: (category, index) =>
            effects.push(["live", category, index]),
        playTime: 0,
        playType: 0,
        prevArr: [],
        primaryIndex: 0,
        providerGetItem: (key) => stored[key],
        providerSetItem: (key, value) => {
            stored[key] = value;
        },
        setTimeout: (callback) => {
            const id = ++nextTimer;
            timers.set(id, callback);
            return id;
        },
        settings: { prevCount: 4 },
        sFavorites: 0,
        showChannelInfo: () => {},
        showShift: (text) => effects.push(["message", text]),
        sInfoRew: 0,
        stbGetLen: () => 600,
        stbGetPosTime: () => 125.9,
        stbSetPosTime: (position) => effects.push(["seek", position]),
        timeShift: (offset) => effects.push(["timeshift", offset]),
    };
    c.window = c;
    vm.createContext(c);
    require("./helpers/english-source-fixture.cjs").attachSourceAliases(c);
    sharedCore(c);
    c.effects = effects;
    c.stored = stored;
    c.flush = () => {
        const jobs = [...timers];
        timers.clear();
        for (const [id, callback] of jobs) if (!cancelled.has(id)) callback();
    };
    c.late = () => {
        for (const callback of timers.values()) callback();
        timers.clear();
    };
    return c;
}

function include(c, file, names) {
    names = require("./helpers/english-source-fixture.cjs").sourceNames(
        file,
        names
    );
    const ast = ts.createSourceFile(
        file,
        fs.readFileSync(path.join(root, file), "utf8"),
        ts.ScriptTarget.Latest,
        true
    );
    const functions = ast.statements.filter(
        (node) =>
            ts.isFunctionDeclaration(node) && names.includes(node.name?.text)
    );
    assert.equal(functions.length, names.length);
    const code = ts
        .transpileModule(
            functions.map((node) => node.getText(ast)).join("\n"),
            {
                compilerOptions: {
                    module: ts.ModuleKind.ES2015,
                    target: ts.ScriptTarget.ES5,
                },
            }
        )
        .outputText.replace(/^export /gm, "");
    vm.runInContext(code, c);
}

// Classic view remains usable, but history identity is no longer a category index.
{
    const c = fixture();
    include(c, "src/channels/index.ts", ["setCurrent", "shiftArchive"]);
    c.prevArr = [
        { c: 0, ci: 202, i: 1, marker: "destination" },
        { c: 0, ci: 303, i: 2, marker: "keep" },
    ];
    c.setCurrent(0, 1); // Omitted archive flag must mean live, just like false.
    assert.deepEqual(
        plain(c.prevArr).map((row) => row.ci),
        [101, 303]
    );
    assert.equal(c.prevArr[1].marker, "keep");
    assert.equal(c.primaryIndex, 1);
    assert.equal(c.curList, c.cats.one);
    assert.equal(c.stored.primaryIndex, "1");
    assert.equal(JSON.parse(c.stored.continueWatch).channelId, 202);
    c.primaryIndex = 0;
    c.prevArr = [{ c: 0, ci: 303, i: 2 }];
    c.setCurrent(1, 0); // Same channel in another category is not a departure.
    assert.deepEqual(
        plain(c.prevArr).map((row) => row.ci),
        [303]
    );
    assert.equal(c.catIndex, 1);
}

// The classic channel journal excludes VOD before applying its capacity.
{
    const c = fixture();
    c.settings.prevCount = 0; // One previous channel.
    c.prevArr = [{ c: 0, ci: 303, i: 2 }];
    const media = c.__ottMedia.prepare(
        { id: "movie", stream_url: "movie.mp4", title: "Movie" },
        "movie.mp4"
    );
    c.__ottClassicPlayback.command({
        channelId: media.ref.itemId,
        item: media.item,
        type: "vod",
    });
    c.__ottClassicPlayback.command({ type: "playing" });
    c.__ottClassicPlayback.select(0, -1);
    assert.deepEqual(
        plain(c.prevArr).map((row) => row.ci),
        [303]
    );
    assert.equal(c.medHistory[0].current, 125.9);
    assert.equal(
        JSON.parse(c.stored["mediaJournal.v1:" + media.ref.sourceId]).history[0]
            .position,
        125.9
    );
    assert.equal(c.stored.primaryIndex, undefined);
    assert.equal(c.stored.continueWatch, undefined);
    c.sFavorites = -1;
    delete c.stored.medHistory;
    c.__ottClassicPlayback.select(0, -1);
    assert.equal(c.stored.medHistory, undefined);
}

// Finite platform channel files use media seeking but retain channel history.
{
    const c = fixture();
    c.playType = -99999999999;
    c.medHistory = [{ current: 11, stream_url: "unrelated.mp4" }];
    c.__ottClassicPlayback.select(0, 1);
    assert.equal(c.prevArr[0].ci, 101);
    assert.equal(c.medHistory[0].current, 11);
    assert.equal(c.stored.medHistory, undefined);
}

// Local/finite channel files seek as media without borrowing the channel archive.
{
    const c = fixture();
    c.__ottActiveProviderDriver = { id: "offline" };
    c.stbGetLen = () => NaN; // Metadata arrived after the one-shot probe.
    let position = 125;
    c.stbGetPosTime = () => position;
    c.stbSetPosTime = (value) => {
        position = value;
        c.effects.push(["seek", value]);
    };
    c.__ottClassicPlayback.command({ channelId: 101, type: "live" });
    c.__ottClassicPlayback.command({ type: "playing" });
    const generation = c.__ottClassicPlayback.snapshot().generation;
    assert.equal(c.__ottClassicPlayback.snapshot().target.kind, "vod");
    assert.equal(c.__ottClassicPlayback.snapshot().historyTarget.kind, "live");
    c.__ottClassicPlayback.shift(10);
    c.flush();
    assert.equal(position, 135);
    assert.equal(c.__ottClassicPlayback.snapshot().phase, "playing");
    c.__ottClassicPlayback.command({ type: "pause" });
    c.stbGetLen = () => 600;
    c.__ottClassicPlayback.shift(-10);
    c.flush();
    assert.equal(position, 125);
    c.__ottClassicPlayback.shift(-1000);
    c.flush();
    assert.equal(position, 0);
    c.__ottClassicPlayback.shift(1000);
    c.flush();
    assert.equal(
        position,
        0,
        "an out-of-range seek does not restart the media"
    );
    assert.equal(c.__ottClassicPlayback.snapshot().phase, "paused");
    assert.equal(c.__ottClassicPlayback.snapshot().generation, generation);
    assert.equal(
        c.effects.some((row) =>
            ["archive", "timeshift", "live"].includes(row[0])
        ),
        false,
        "offline channels never restart or request IPTV catch-up while seeking"
    );
}

// Other providers retain live-stream behavior even with a finite decoder length.
{
    const c = fixture();
    c.__ottActiveProviderDriver = { id: "m3u" };
    c.__ottClassicPlayback.command({ channelId: 303, type: "live" });
    assert.equal(c.__ottClassicPlayback.snapshot().target.kind, "live");
    assert.equal(c.playType, 0);
}

// Explicit finite detection remains available to non-local channel adapters.
{
    const c = fixture();
    c.p_pref = "offline";
    c.__ottActiveProviderDriver = { id: "offline" };
    let slot = -1;
    c.__ottOfflineProfiles = {
        namespace: () => (slot < 0 ? "offline" : "offline:" + slot),
    };
    function save(position) {
        c.__ottClassicPlayback.command({
            channelId: 101,
            position,
            type: "live",
        });
        c.__ottClassicPlayback.checkpoint(
            c.__ottClassicPlayback.snapshot(),
            true
        );
    }
    save(23);
    const original = c.stored.playbackJournal;
    slot = 0;
    save(17);
    slot = 1;
    save(41);
    slot = 0;
    assert.equal(c.__ottClassicPlayback.bookmark().playTime, 17);
    slot = 1;
    assert.equal(c.__ottClassicPlayback.bookmark().playTime, 41);
    slot = -1;
    assert.equal(c.__ottClassicPlayback.bookmark().playTime, 23);
    assert.equal(
        c.stored.playbackJournal,
        original,
        "profile writes preserve the unprofiled journal"
    );
    assert.equal(
        JSON.parse(c.stored["playbackJournal:offline:0"]).sourceId,
        "offline:0"
    );
    assert.equal(
        JSON.parse(c.stored["playbackJournal:offline:1"]).sourceId,
        "offline:1"
    );
    const unclaimed = fixture();
    unclaimed.p_pref = "offline";
    unclaimed.__ottActiveProviderDriver = { id: "offline" };
    unclaimed.stored.playbackJournal = original;
    unclaimed.__ottOfflineProfiles = { namespace: () => "offline:0" };
    assert.equal(unclaimed.__ottClassicPlayback.bookmark(), null);
    unclaimed.__ottClassicPlayback.command({
        channelId: 101,
        position: 9,
        type: "live",
    });
    unclaimed.__ottClassicPlayback.checkpoint(
        unclaimed.__ottClassicPlayback.snapshot(),
        true
    );
    assert.equal(unclaimed.__ottClassicPlayback.bookmark().playTime, 9);
    assert.equal(unclaimed.stored.playbackJournal, original);
    assert.equal(
        unclaimed.stored.playbackJournalSource,
        undefined,
        "a slot cannot claim an unowned foreign journal"
    );
    const claimed = fixture();
    claimed.p_pref = "offline";
    claimed.__ottActiveProviderDriver = { id: "offline" };
    claimed.__ottOfflineProfiles = { namespace: () => "offline:0" };
    claimed.stored.playbackJournalSource = "offline:0";
    const legacyProfile = JSON.parse(original);
    legacyProfile.sourceId = "offline:0";
    claimed.stored.playbackJournal = JSON.stringify(legacyProfile);
    assert.equal(
        claimed.__ottClassicPlayback.bookmark().playTime,
        23,
        "an explicitly owned old profile journal remains readable"
    );
}

{
    for (const provider of ["offline", "m3u"]) {
        const c = fixture();
        c.p_pref = provider;
        c.__ottActiveProviderDriver = { id: provider };
        c.stored.continueWatch = JSON.stringify({
            catIndex: 0,
            channelId: 101,
            mode: "vod",
            playTime: 64,
            playType: -99999999999,
            updatedAt: c.Date.now(),
            v: 1,
        });
        const bookmark = c.__ottClassicPlayback.bookmark();
        if (provider === "offline") {
            assert.equal(bookmark.mode, "live");
            assert.equal(
                bookmark.playTime,
                64,
                "old finite-local bookmarks migrate without losing position"
            );
        } else
            assert.equal(
                bookmark,
                null,
                "legacy TV/VOD import semantics remain unchanged"
            );
    }
}

{
    const c = fixture();
    c.__ottActiveProviderDriver = { id: "offline" };
    c.__ottClassicPlayback.command({ channelId: 101, type: "live" });
    c.__ottClassicPlayback.command({ type: "playing" });
    c.__ottClassicPlayback.command({
        duration: 600,
        position: 125,
        type: "position",
    });
    include(c, "src/channels/index.ts", ["restoreContinueWatch"]);
    include(c, "src/index.ts", ["body_onUnload"]);
    let active = true;
    c.__ottCoreBackendPeek = () => ({
        current: () => ({
            active: () => active,
            sample: () =>
                c.__ottClassicPlayback.command({
                    duration: 600,
                    position: 127,
                    type: "position",
                }),
        }),
    });
    c.body_onUnload();
    assert.equal(
        c.__ottClassicPlayback.bookmark().playTime,
        127,
        "exit samples the decoder before saving"
    );
    c.__ottCoreBackendPeek = () => {
        throw new Error("Decoder retired");
    };
    c.body_onUnload();
    assert.equal(
        c.__ottClassicPlayback.bookmark().playTime,
        127,
        "a failed fresh sample still saves the last known clock"
    );
    c.__ottClassicPlayback.command({ type: "stop" });
    active = false;
    c.body_onUnload();
    assert.equal(
        c.__ottClassicPlayback.bookmark().playTime,
        127,
        "later unload after Q/Stop retains the saved position"
    );
    const calls = [];
    c.playChannel = (...args) => {
        calls.push(args);
        return true;
    };
    c.Date.now = () => 1000000000 + 8 * 86400000;
    assert.equal(
        c.restoreContinueWatch(),
        true,
        "local positions do not expire like TV archives"
    );
    assert.equal(calls[0][4].position, 127);
    assert.equal(calls[0][4].channelId, "101");
    c.primaryIndex = 1;
    assert.equal(
        c.restoreContinueWatch(),
        false,
        "a selected profile/file cannot be replaced by an old bookmark"
    );
    c.primaryIndex = 0;
    c.__ottActiveProviderDriver = { id: "m3u" };
    assert.equal(
        c.restoreContinueWatch(),
        false,
        "live TV never restores a local media offset"
    );
    c.__ottActiveProviderDriver = { id: "offline" };
    c.__ottClassicPlayback.command({ channelId: 101, type: "live" });
    assert.equal(
        c.__ottClassicPlayback.snapshot().position,
        0,
        "a manual channel selection starts from zero"
    );
    c.__ottClassicPlayback.command({
        duration: 600,
        position: 600,
        type: "position",
    });
    c.__ottClassicPlayback.checkpoint(c.__ottClassicPlayback.snapshot(), true);
    assert.equal(
        c.__ottClassicPlayback.bookmark().playTime,
        0,
        "completed local files restart instead of immediately reaching EOF"
    );
}

{
    const c = fixture();
    c.p_pref = "offline";
    c.channels[101].rec = 0;
    c.__ottClassicPlayback.command({ channelId: 101, type: "live" });
    c.__ottClassicPlayback.command({ duration: 600, type: "finite-channel" });
    c.__ottClassicPlayback.command({
        duration: 600,
        position: 125.9,
        type: "position",
    });
    c.__ottClassicPlayback.shift(10);
    c.flush();
    assert.deepEqual(
        c.effects.filter((row) => row[0] === "seek"),
        [["seek", 135.9]]
    );
    assert.equal(c.__ottClassicPlayback.snapshot().target.kind, "vod");
    assert.equal(c.__ottClassicPlayback.snapshot().historyTarget.kind, "live");
    assert.equal(
        c.effects.some((row) =>
            ["archive", "timeshift", "live"].includes(row[0])
        ),
        false,
        "A local file never asks a TV provider for catch-up"
    );
}

// Archive history stores an absolute resume time and preserves old input objects.
{
    const c = fixture();
    c.playType = 990000;
    c.playTime = 90;
    const previous = { c: 0, ci: 303, extra: "opaque", i: 2, t: 980000 };
    c.prevArr = [previous, { ci: 404, t: "bad" }, null, { ci: 505, t: -10 }];
    c.__ottClassicPlayback.select(0, 1);
    assert.equal(c.prevArr[0].t, 990090);
    assert.equal(c.prevArr.length, 2);
    assert.equal(c.prevArr[1].extra, "opaque");
    assert.equal(previous.t, 980000);
    // The v1 bookmark contract still refers to the outgoing playback mode.
    assert.equal(JSON.parse(c.stored.continueWatch).mode, "archive");
}

// Missing startup channels and malformed stored rows never create invalid visits.
{
    const c = fixture();
    c.cats = {};
    c.catsArray = [];
    c.prevArr = {};
    c.__ottClassicPlayback.select(0, 0);
    assert.deepEqual(plain(c.prevArr), []);
}

// Debounce adds intents within one session; the observation at execution is fresh.
{
    const c = fixture();
    c.playType = -1e11;
    c.__ottClassicPlayback.shift(15);
    c.__ottClassicPlayback.shift(30);
    c.flush();
    assert.deepEqual(
        c.effects.filter((row) => row[0] === "seek"),
        [["seek", 170.9]]
    );
    c.effects.length = 0;
    c.__ottClassicPlayback.shift(-6e6);
    assert.deepEqual(
        c.effects.filter((row) => row[0] === "seek"),
        [["seek", 0]]
    );
    c.effects.length = 0;
    c.__ottClassicPlayback.shift(1000);
    c.flush();
    assert.equal(
        c.effects.some((row) => row[0] === "seek"),
        false
    );
}

// Epoch-based archive seeking, live rewind, and crossing the live edge.
{
    const c = fixture();
    c.__ottClassicPlayback.shift(-30);
    c.flush();
    assert(c.effects.some((row) => row[0] === "timeshift" && row[1] === 30));
    c.effects.length = 0;
    c.playType = 999900;
    c.playTime = 20;
    c.__ottClassicPlayback.shift(30);
    c.flush();
    assert(c.effects.some((row) => row[0] === "archive" && row[1] === 999950));
    c.__ottClassicPlayback.shift(200);
    c.flush();
    assert(c.effects.some((row) => row[0] === "live"));
}

// Plain live TV has no synthetic seek, and archive bounds keep their epoch semantics.
{
    const c = fixture();
    c.primaryIndex = 2; // This channel advertises no archive.
    c.__ottClassicPlayback.shift(-10);
    c.flush();
    assert.equal(
        c.effects.some((row) =>
            ["seek", "archive", "timeshift", "live"].includes(row[0])
        ),
        false
    );
}
{
    const c = fixture();
    c.playType = 999900;
    c.playTime = 90;
    c.__ottClassicPlayback.shift(10); // Exactly now, not ten seconds into a file.
    c.flush();
    assert(c.effects.some((row) => row[0] === "live"));
    assert.equal(
        c.effects.some((row) => row[0] === "seek"),
        false
    );
}
{
    const c = fixture();
    c.channels[101].rec = 1; // Earliest retained epoch is 996400.
    c.playType = 996405;
    c.playTime = 0;
    c.__ottClassicPlayback.shift(-10);
    c.flush();
    assert.deepEqual(
        c.effects.filter((row) => row[0] === "archive"),
        [["archive", 996400]],
        "Archive rewind stops at the earliest retained broadcast instant"
    );
}

// Delayed callbacks cannot survive cancellation even if a timer fires after clearTimeout.
for (const change of [
    (c) => c.__ottClassicPlayback.cancel(),
    (c) => c.__ottClassicPlayback.select(0, 1),
    (c) => {
        c.p_pref = "source-b";
    },
    (c) => {
        c.primaryIndex = 2;
    },
    (c) => {
        c.channels = { ...c.channels };
        c.cats = { ...c.cats };
    },
    (c) => {
        c.channels[101] = { rec: 48 };
    },
    (c) => {
        c.cats.one = [...c.cats.one];
    },
]) {
    const c = fixture();
    c.__ottClassicPlayback.shift(-30);
    change(c);
    c.late();
    assert.equal(
        c.effects.some((row) =>
            ["timeshift", "seek", "archive", "live"].includes(row[0])
        ),
        false
    );
}

// A real timeShift callback is admitted once, and cannot switch a replacement source.
for (const replacement of [null, "catalog", "channel", "list"]) {
    const c = fixture();
    include(c, "src/channels/index.ts", ["timeShift", "setCurrent"]);
    let reply;
    c.getChannelEpgCached = (_id, callback) => {
        reply = callback;
    };
    c.setCurProg = () => {};
    c.curProg = 0;
    c.getArchiveUrl = (_id, epoch) => "archive:" + epoch;
    c.stbPlay = (url) => c.effects.push(["open", url]);
    c.timeShift(30);
    if (replacement === "catalog") c.channels = { ...c.channels };
    if (replacement === "channel") c.channels[101] = { rec: 48 };
    if (replacement === "list") c.cats.one = [...c.cats.one];
    reply(101, [
        { descr: "", name: "Current", time: 999000, time_to: 1001000 },
    ]);
    reply(101, []);
    assert.equal(
        c.effects.filter((row) => row[0] === "open").length,
        replacement ? 0 : 1
    );
}

// Live pause owns its asynchronous EPG work as well as the later media effect.
{
    const c = fixture();
    include(c, "src/channels/index.ts", ["liveStop"]);
    let reply;
    c.getChannelEpgCached = (_id, callback) => {
        reply = callback;
    };
    c.stbIsPlaying = () => true;
    c.stbPause = () => c.effects.push(["pause"]);
    c.setCurProg = () => {};
    c.liveStop();
    c.__ottClassicPlayback.cancel();
    reply(101, []);
    assert.equal(c.playType, 0);
    assert.equal(c.effects.length, 0);
}

// Stop really invalidates the private controller before touching media objects.
{
    const c = fixture();
    include(c, "src/core/index.ts", ["stbStop"]);
    c.getCoreMediaBackend = () => ({ stop() {} });
    c.video = { pause() {}, removeAttribute() {} };
    c._playSession = 0;
    c.hlsInstance = null;
    for (const name of [
        "cancelLiveRestart",
        "cancelCoreSeek",
        "cancelCoreAutoPlayback",
        "cancelCoreNativeHls",
        "resetCoreNativeBitrate",
        "setCoreDemoMute",
        "destroyCoreShaka",
        "clearPlayTimeInterval",
    ])
        c[name] = () => {};
    c.__ottClassicPlayback.shift(-30);
    c.stbStop();
    c.late();
    assert.equal(
        c.effects.some((row) => row[0] === "timeshift"),
        false
    );
}

// Injected host effects can replace a seek while its old callback is on the stack.
function controllerFixture() {
    const context = vm.createContext({ window: {} });
    const core = sharedCore(context, { vendorOnly: true });
    require("./helpers/private-runtime.cjs")(
        context,
        "src/playback/session.ts"
    );
    const jobs = new Map(),
        applied = [];
    let next = 0;
    const f = { applied, jobs };
    const target = { channelId: "one", kind: "vod", sourceId: "source" };
    f.controller = context.window.__ottPlaybackSession.create(core, {
        apply(plan) {
            applied.push(plan.position);
        },
        observe() {
            if (f.onObserve) f.onObserve();
            return {
                archiveAvailable: false,
                duration: 1000,
                now: 1000,
                position: 100,
                target,
            };
        },
        preview() {
            if (f.onPreview) f.onPreview();
        },
        schedule(callback) {
            const id = ++next;
            jobs.set(id, callback);
            if (f.onSchedule) f.onSchedule();
            return id;
        },
        unschedule(id) {
            jobs.delete(id);
            if (f.onCancel) f.onCancel();
        },
    });
    f.shift = (value) => f.controller.request({ intent: "offset", value });
    f.flush = () => {
        for (const callback of [...jobs.values()]) callback();
    };
    return f;
}
{
    const f = controllerFixture();
    f.shift(10);
    f.shift(Number.NaN);
    f.flush();
    assert.deepEqual(
        f.applied,
        [110],
        "invalid offsets preserve a pending seek"
    );
}
for (const hook of ["onObserve", "onCancel"]) {
    const f = controllerFixture();
    f.shift(10);
    f[hook] = () => {
        f[hook] = null;
        f.controller.request({ intent: "absolute", value: 300 });
    };
    f.flush();
    assert.deepEqual(f.applied, [300], hook + " replacement must win");
    assert.equal(f.jobs.size, 0);
}
for (const hook of ["onPreview", "onSchedule"]) {
    const f = controllerFixture();
    f[hook] = () => {
        f[hook] = null;
        f.controller.cancel();
    };
    f.shift(10);
    assert.equal(f.jobs.size, 0, hook + " cancellation must retire its timer");
    f.flush();
    assert.deepEqual(f.applied, []);
}
{
    const f = controllerFixture();
    f.onSchedule = () => {
        f.onSchedule = null;
        f.shift(20);
    };
    f.shift(10);
    assert.equal(f.jobs.size, 1, "replacement keeps only its own timer");
    f.flush();
    assert.deepEqual(
        f.applied,
        [130],
        "schedule reentry preserves accumulated intent"
    );
    assert.equal(f.jobs.size, 0);
}
{
    const f = controllerFixture();
    f.shift(10);
    f.onCancel = () => {
        f.onCancel = null;
        f.shift(30);
    };
    f.shift(20);
    f.flush();
    assert.deepEqual(
        f.applied,
        [130],
        "cleanup replacement must survive the outer request"
    );
}
{
    const f = controllerFixture();
    let calls = 0;
    const callback = f.controller.guard(() => {
        calls++;
    });
    f.onObserve = () => {
        f.onObserve = null;
        f.controller.cancel();
    };
    callback();
    assert.equal(calls, 0, "guard must recheck ownership after observing");
}

// Production TS lowering remains valid for old browser grammars.
for (const file of ["session.ts", "classic-adapter.ts"]) {
    const source = fs.readFileSync(
        path.join(root, "src/playback", file),
        "utf8"
    );
    const compiled = ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES5 },
    }).outputText;
    acorn.parse(compiled, { ecmaVersion: 5 });
}
console.log(
    "PASS playback sessions: history, VOD/native files, archive clocks, migration records, stale seeks/EPG and stop ownership"
);
