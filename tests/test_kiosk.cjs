const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const acorn = require("acorn");
const { JSDOM } = require("jsdom");
function load(file, globals = {}) {
    const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES5,
        },
    }).outputText;
    acorn.parse(code, { ecmaVersion: 5 });
    const context = { exports: {}, ...globals };
    vm.runInNewContext(code, context);
    return context.exports;
}
const { localizationRuntime } = require("./helpers/localization-runtime.cjs");
const unicode = {};
vm.runInNewContext(localizationRuntime(), unicode);
const casing = load("src/utils/caseless.ts", { require: () => unicode });
const strictInput = load("src/plugins/strict-kiosk-input.ts");
const videoProgress = load("src/plugins/kiosk-video-progress.ts");
const { createKiosk } = load("src/plugins/kiosk.ts", {
    require: (name) =>
        name.includes("strict-kiosk")
            ? strictInput
            : name.includes("kiosk-video-progress")
              ? videoProgress
              : casing,
});
function rig(storage = {}) {
    let time = 0,
        position = 0,
        source = "m3u:0@one",
        playing = false,
        tick,
        fail = false;
    const played = [],
        events = {};
    const w = {
        __ottActiveProviderDriver: { id: "m3u" },
        __ottSourceIdentity: { current: () => source },
        cats: { all: ["a", "b"] },
        catsArray: ["all"],
        channels: {
            a: { channel_name: "Первый" },
            b: { channel_name: "Новости" },
        },
        cList: ["a", "b"],
        commandChannelsReady: true,
        curList: ["a", "b"],
        document: {
            addEventListener: (name, fn) => {
                events[name] = fn;
            },
        },
        performance: { now: () => time },
        playChannel: (c, i) => {
            const id = w.cats[w.catsArray[c]][i];
            if (!kiosk.admit(id)) return;
            played.push(id);
            w.curList = w.cats[w.catsArray[c]];
            w.primaryIndex = i;
        },
        primaryIndex: 0,
        setInterval: (fn) => {
            tick = fn;
            return 1;
        },
        stbGetItem: (key) => storage[key],
        stbGetPersistedItem: (key) => storage[key],
        stbGetPosTime: () => {
            if (fail) throw Error("decoder");
            return position;
        },
        stbIsPlaying: () => playing,
        stbSetItem: (key, value) => {
            storage[key] = value;
        },
    };
    const kiosk = createKiosk(w);
    w.__ottKiosk = kiosk;
    kiosk.init();
    function request(params) {
        let result;
        kiosk.request(params, (r) => {
            result = r;
        });
        return result;
    }
    return {
        advance: (seconds, progress = false) => {
            for (let i = 0; i < seconds; i++) {
                time += 1000;
                if (progress) position++;
                tick();
            }
        },
        events,
        fail: (value) => {
            fail = value;
        },
        kiosk,
        play: (value) => {
            playing = value;
        },
        played,
        request,
        source: (value) => {
            source = value;
        },
        storage,
        w,
    };
}
{
    const r = rig();
    assert.equal(r.request({ mode: "on" }).data.state, "waiting");
    r.advance(30, true);
    assert.deepEqual(r.played, []);
    r.w.playChannel(0, 1);
    assert.equal(r.kiosk.snapshot().channel.id, "b");
    r.w.playChannel(0, 0);
    assert.deepEqual(r.played, ["b"]);
    assert.equal(
        r.request({ mode: "on" }).data.state,
        "locked",
        "on cannot accidentally re-arm"
    );
    r.advance(9);
    assert.equal(r.played.length, 1);
    r.advance(1);
    assert.deepEqual(r.played, ["b", "b"]);
    r.advance(10);
    assert.equal(r.played.length, 3);
    r.play(true);
    r.advance(60, true);
    assert.equal(r.played.length, 3, "healthy playback must not restart");
    r.advance(10);
    assert.equal(r.played.length, 4, "stalled decoder restarts");
    r.fail(true);
    r.advance(10);
    assert.equal(
        r.played.length,
        5,
        "throwing health API must not disable retries"
    );
    r.fail(false);
    r.w.cats.all = ["b", "a"];
    r.advance(10);
    assert.equal(r.played.at(-1), "b", "track IDs across reordered lists");
    const count = r.played.length;
    r.source("m3u:1@other");
    r.advance(20);
    assert.equal(r.played.length, count);
    assert.equal(r.kiosk.snapshot().health, "source-unavailable");
    r.source("m3u:0@one");
    delete r.w.channels.b;
    r.advance(10);
    assert.equal(r.played.length, count);
    assert.equal(r.kiosk.snapshot().health, "channel-unavailable");
    r.request({ mode: "off" });
    r.advance(30);
    assert.equal(r.played.length, count);
    assert.equal(r.kiosk.enabled(), false);
}
{
    const r = rig();
    assert.equal(r.request({ mode: "on", query: "новости" }).status, "ok");
    assert.deepEqual(r.played, ["b"]);
    assert.equal(r.request({ mode: "set", query: "1" }).data.channel.id, "a");
    assert.deepEqual(r.played, ["b", "a"]);
    assert.equal(
        r.request({ mode: "set", query: "missing" }).status,
        "rejected"
    );
    assert.equal(r.kiosk.snapshot().channel.id, "a");
    let blocked = 0;
    r.events.click({
        preventDefault: () => blocked++,
        stopImmediatePropagation: () => blocked++,
    });
    assert.equal(blocked, 2);
    const restored = rig(r.storage);
    assert.equal(restored.kiosk.locked(), true);
    restored.w.playChannel(0, 1);
    assert.deepEqual(restored.played, []);
    restored.advance(10);
    assert.deepEqual(restored.played, ["a"]);
    // The policy stays enabled independently of remote connectivity.
    restored.w.__ottCommandServer = { status: () => ({ enabled: false }) };
    restored.advance(10);
    assert.deepEqual(restored.played, ["a", "a"]);
    restored.request({ mode: "off" });
    assert.equal(rig(r.storage).kiosk.enabled(), false);
}
{
    const r = rig();
    r.w.channels.a.channel_name = "Новости HD";
    r.w.channels.b.channel_name = "Новости";
    assert.equal(
        r.request({ mode: "on", query: "НОВОСТИ" }).data.channel.id,
        "a",
        "the first substring match wins over a later exact name"
    );
    assert.equal(
        r.request({ mode: "set", query: "2" }).data.channel.id,
        "b",
        "catalogue numbers still select the requested row"
    );
    assert.equal(
        r.request({ mode: "set", query: "ВоСт" }).data.channel.id,
        "a",
        "remote replacement uses the first case-insensitive substring match too"
    );
    r.w.channels.b.channel_name = "Новости HD";
    assert.equal(
        r.request({ mode: "set", query: "Новости HD" }).data.channel.id,
        "a",
        "duplicate full names select the first row"
    );
    r.w.cList = ["b", "a"];
    r.advance(10);
    assert.equal(
        r.played.at(-1),
        "a",
        "recovery retains the pinned ID instead of searching again"
    );
    assert.equal(
        r.request({ mode: "set", query: "новости" }).data.channel.id,
        "b",
        "a new request follows current catalogue order, not category order"
    );
    r.w.cats.all = ["a"];
    assert.equal(
        r.request({ mode: "set", query: "новости" }).status,
        "rejected",
        "an unavailable first match must not silently select the second match"
    );
    assert.equal(r.kiosk.snapshot().channel.id, "b");
    r.w.cats.all = ["a", "b"];
    r.w.ifParentalAccessChId = (id) => id === "b";
    assert.equal(
        r.request({ mode: "set", query: "новости" }).status,
        "rejected",
        "a protected first match must not silently select another channel"
    );
}
{
    const r = rig();
    r.w.ifParentalAccessChId = () => true;
    assert.equal(r.request({ mode: "on", query: "1" }).status, "rejected");
    assert.equal(r.kiosk.enabled(), false);
    r.w.ifParentalAccessChId = () => false;
    r.w.stbSetItem = () => {
        throw Error("quota");
    };
    assert.equal(r.request({ mode: "on", query: "1" }).status, "rejected");
    assert.equal(r.kiosk.enabled(), false);
    assert.deepEqual(r.played, []);
}
for (const params of [
    null,
    [],
    {},
    { mode: "other" },
    { mode: "set" },
    { mode: "off", query: "1" },
    { extra: 1, mode: "status" },
    { mode: "on", query: "" },
    { mode: "on", query: 1 },
    { mode: "on", query: "я".repeat(513) },
    { mode: "on", query: "\ud800" },
    { mode: "on", query: "a\n" },
]) {
    const r = rig();
    assert.equal(r.request(params).status, "rejected");
    assert.equal(r.kiosk.enabled(), false);
}
// Execute the real live-playback entry point with effects instrumented: blocked
// channels must not stop a decoder, cancel requests or alter the selection.
const index = fs.readFileSync("src/index.ts", "utf8");
const ast = ts.createSourceFile(
    "index.ts",
    index,
    ts.ScriptTarget.Latest,
    true
);
function declaration(name) {
    return ast.statements
        .find((n) => ts.isFunctionDeclaration(n) && n.name?.text === name)
        .getText(ast);
}
{
    const r = rig();
    r.request({ mode: "on", query: "1" });
    let cancelled = 0;
    r.w.__ottMedia = { cancelRequest: () => cancelled++ };
    const code = ts.transpileModule(declaration("_playChannel"), {
        compilerOptions: { target: ts.ScriptTarget.ES5 },
    }).outputText;
    const context = {
        cats: r.w.cats,
        catsArray: r.w.catsArray,
        console,
        window: r.w,
    };
    vm.createContext(context);
    vm.runInContext(code, context);
    context._playChannel(0, 1);
    assert.equal(cancelled, 0);
}
{
    const r = rig();
    r.request({ mode: "on" });
    const code = ts.transpileModule(declaration("_playMedia"), {
        compilerOptions: { target: ts.ScriptTarget.ES5 },
    }).outputText;
    const context = { window: r.w };
    vm.createContext(context);
    vm.runInContext(code, context);
    context._playMedia({ stream_url: "https://wrong.example" }, true); // returns before any VOD side effect
}
function diagnosticKiosk(
    markup = '<button id="remoteDiagnosticsIndicator">Remote diagnostics · Stop</button>'
) {
    const dom = new JSDOM(
        "<body>" + markup + '<button id="settings">Settings</button></body>'
    );
    const w = dom.window;
    const storedPolicy = JSON.stringify({
        channel: { id: "one", name: "One" },
        provider: "m3u",
        source: "fixture",
    });
    let stopped = 0;
    let bubbled = 0;
    let statusListener;
    const authority = {
        enabled: true,
        pending: false,
        sessionId: "capture-one",
        state: "active",
        trusted: true,
    };
    w.stbGetItem = () => storedPolicy;
    w.__ottSourceIdentity = { current: () => "fixture" };
    w.setInterval = () => 1;
    w.__ottRemoteDiagnostics = {
        status: () => ({ ...authority }),
        stopSession() {
            stopped++;
            delete authority.sessionId;
            authority.state = "ready";
            authority.message =
                "Remote control authorizes diagnostics. Ready for an operator.";
            if (statusListener) statusListener({ ...authority });
        },
    };
    const kiosk = createKiosk(w);
    w.__ottKiosk = kiosk;
    kiosk.init();
    for (const name of [
        "click",
        "pointerdown",
        "mousedown",
        "touchstart",
        "wheel",
        "keydown",
    ]) {
        w.document.addEventListener(name, () => bubbled++);
        w.document
            .getElementById("settings")
            .addEventListener(name, () => bubbled++);
        w.document
            .getElementById("remoteDiagnosticsIndicator")
            .addEventListener(name, () => bubbled++);
    }
    return {
        authority,
        bubbled: () => bubbled,
        dom,
        kiosk,
        onStatus(listener) {
            statusListener = listener;
        },
        stopped: () => stopped,
        storedPolicy,
        w,
    };
}
{
    const r = diagnosticKiosk();
    r.w._ = (value) => value;
    const controller = r.w.__ottRemoteDiagnostics;
    let render;
    const context = {
        createCommandServerTransport: () => () => {},
        document: r.w.document,
        installDiagnosticsController(_window, options) {
            render = options.onStatus;
            r.onStatus(render);
            return controller;
        },
        PLAYER_VERSION: "test",
        settings: {},
        window: r.w,
    };
    vm.createContext(context);
    vm.runInContext(
        ts.transpileModule(declaration("initRemoteDiagnostics"), {
            compilerOptions: { target: ts.ScriptTarget.ES5 },
        }).outputText,
        context
    );
    context.initRemoteDiagnostics();
    render({ enabled: false, state: "disabled" });
    render({
        enabled: true,
        message:
            "Remote control authorizes diagnostics. Ready for an operator.",
        state: "ready",
        trusted: true,
    });
    assert.equal(
        r.w.document.getElementById("remoteDiagnosticsIndicator"),
        null,
        "an idle authorized connection must not show a capture stop control"
    );
    render({
        ...r.authority,
        message: "Remote diagnostics is collecting for this connection.",
    });
    const button = r.w.document.getElementById("remoteDiagnosticsIndicator");
    button.addEventListener("click", () =>
        assert.fail("kiosk cannot leak a stop click")
    );
    const event = new r.w.Event("click", { bubbles: true, cancelable: true });
    button.dispatchEvent(event);
    assert.equal(r.stopped(), 1);
    assert.equal(event.defaultPrevented, true);
    assert.equal(
        r.w.document.getElementById("remoteDiagnosticsIndicator"),
        null
    );
    assert.equal(r.authority.enabled, true);
    assert.equal(r.authority.trusted, true);
    assert.equal(r.authority.sessionId, undefined);
    assert.equal(r.bubbled(), 0);
    assert.equal(r.kiosk.locked(), true);
    assert.equal(r.kiosk.snapshot().channel.id, "one");
    assert.equal(r.w.stbGetItem("__ottKioskV1"), r.storedPolicy);
    r.dom.window.close();
}
for (const state of [
    { sessionId: undefined, state: "ready" },
    { sessionId: undefined, state: "suspended" },
    { pending: true, sessionId: undefined, state: "storage-error" },
    { sessionId: "stale-capture", state: "ready" },
    { sessionId: "", state: "active" },
    { sessionId: "invalid id", state: "active" },
    { sessionId: 42, state: "active" },
]) {
    const r = diagnosticKiosk();
    Object.assign(r.authority, state);
    assert.equal(
        r.kiosk.stopDiagnostics(),
        false,
        "no active session means STOP must not restart an idle authorized runtime"
    );
    assert.equal(r.stopped(), 0);
    assert.equal(r.authority.trusted, true);
    assert.equal(r.kiosk.locked(), true);
    r.dom.window.close();
}
for (const type of ["click", "pointerdown", "mousedown", "touchstart"]) {
    const r = diagnosticKiosk();
    const button = r.w.document.getElementById("remoteDiagnosticsIndicator");
    const event = new r.w.Event(type, { bubbles: true, cancelable: true });
    button.dispatchEvent(event);
    assert.equal(
        r.stopped(),
        1,
        type + " must stop capture through the live controller"
    );
    assert.equal(event.defaultPrevented, true);
    assert.equal(
        r.bubbled(),
        0,
        "capture stop cannot invoke onclick, settings or delegated handlers"
    );
    assert.equal(r.kiosk.locked(), true);
    assert.equal(r.kiosk.snapshot().channel.id, "one");
    assert.equal(r.w.stbGetItem("__ottKioskV1"), r.storedPolicy);
    button.dispatchEvent(
        new r.w.Event("click", { bubbles: true, cancelable: true })
    );
    assert.equal(
        r.stopped(),
        1,
        "compatibility mouse/click events cannot stop the same capture twice"
    );
    r.dom.window.close();
}
for (const key of ["Enter", " "]) {
    const r = diagnosticKiosk();
    const button = r.w.document.getElementById("remoteDiagnosticsIndicator");
    button.focus();
    const event = new r.w.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key,
    });
    button.dispatchEvent(event);
    assert.equal(
        r.stopped(),
        1,
        "focused stop control stays keyboard accessible"
    );
    assert.equal(event.defaultPrevented, true);
    assert.equal(r.bubbled(), 0);
    assert.equal(r.kiosk.locked(), true);
    r.dom.window.close();
}
{
    const r = diagnosticKiosk();
    r.w.document
        .getElementById("settings")
        .dispatchEvent(
            new r.w.Event("click", { bubbles: true, cancelable: true })
        );
    r.w.document
        .getElementById("remoteDiagnosticsIndicator")
        .dispatchEvent(
            new r.w.Event("wheel", { bubbles: true, cancelable: true })
        );
    assert.equal(
        r.stopped(),
        0,
        "other controls and scrolling do not affect support"
    );
    assert.equal(r.bubbled(), 0);
    assert.equal(r.kiosk.locked(), true);
    r.dom.window.close();
    const wrongElement = diagnosticKiosk(
        '<div id="remoteDiagnosticsIndicator">Unrelated element</div>'
    );
    wrongElement.w.document
        .getElementById("remoteDiagnosticsIndicator")
        .dispatchEvent(
            new wrongElement.w.Event("click", {
                bubbles: true,
                cancelable: true,
            })
        );
    assert.equal(
        wrongElement.stopped(),
        0,
        "a matching ID alone is not the stop button"
    );
    assert.equal(wrongElement.bubbled(), 0);
    wrongElement.dom.window.close();
}
{
    const source = fs.readFileSync("src/key-handler/index.ts", "utf8");
    const parsed = ts.createSourceFile(
        "key-handler.ts",
        source,
        ts.ScriptTarget.Latest,
        true
    );
    const handler = parsed.statements
        .find(
            (node) =>
                ts.isFunctionDeclaration(node) &&
                node.name?.text === "keyHandler"
        )
        .getText(parsed);
    const r = diagnosticKiosk();
    r.w.__ottDevice = {
        eventToKeyCode: (event) => (event.key === "MediaStop" ? 83 : 37),
    };
    const context = {
        cancelNativeListInertia: () => {},
        exports: {},
        keys: { MUTE: 173, STOP: 83, VOL_DOWN: 174, VOL_UP: 175 },
        window: r.w,
    };
    vm.runInNewContext(
        ts.transpileModule(handler, {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES5,
            },
        }).outputText,
        context
    );
    const unrelated = new r.w.KeyboardEvent("keydown", {
        cancelable: true,
        key: "ArrowLeft",
    });
    context.exports.keyHandler(unrelated);
    assert.equal(r.stopped(), 0);
    assert.equal(unrelated.defaultPrevented, true);
    const stop = new r.w.KeyboardEvent("keydown", {
        cancelable: true,
        key: "MediaStop",
        keyCode: 413,
    });
    context.exports.keyHandler(stop);
    assert.equal(
        r.stopped(),
        1,
        "device-mapped STOP stops capture without requiring DOM focus"
    );
    assert.equal(stop.defaultPrevented, true);
    assert.equal(r.kiosk.locked(), true);
    assert.equal(r.kiosk.snapshot().channel.id, "one");
    assert.equal(r.w.stbGetItem("__ottKioskV1"), r.storedPolicy);
    context.exports.keyHandler(stop);
    assert.equal(r.stopped(), 1);
    r.dom.window.close();
}
console.log(
    "Kiosk admission, recovery, persistence, remote replacement and input tests passed"
);

// Channel-backed media retains slow-resolution grace without changing live-TV retries.
for (const provider of ["vportal", "plex"]) {
    const r = rig();
    r.source(provider + ":0@one");
    r.w.__ottActiveProviderDriver = {
        capabilities: { mediaPlaylist: true },
        id: provider,
    };
    r.w.__ottMedia = {
        current: () => ({ sequence: { channel: { id: "b" } } }),
    };
    const pinned = r.request({ mode: "on", query: "Новости" });
    assert.equal(pinned.status, "ok");
    r.advance(59);
    assert.equal(
        r.played.length,
        1,
        provider + " must not interrupt slow initial resolution at ten seconds"
    );
    r.advance(1);
    assert.equal(
        r.played.length,
        2,
        provider + " retries after sixty seconds without startup progress"
    );
    assert.equal(r.kiosk.snapshot().startup_grace_seconds, 60);
    r.play(true);
    r.advance(2, true);
    assert.equal(r.kiosk.snapshot().health, "playing");
    r.advance(9);
    assert.equal(r.played.length, 2);
    r.advance(1);
    assert.equal(
        r.played.length,
        3,
        provider + " keeps the ten-second watchdog after playback starts"
    );
    r.advance(59);
    assert.equal(
        r.played.length,
        3,
        provider + " gives a recovery resolver its own startup grace"
    );
    r.advance(1);
    assert.equal(r.played.length, 4);
}
{
    const r = rig();
    r.request({ mode: "on", query: "Новости" });
    r.advance(9);
    assert.equal(r.played.length, 1);
    r.advance(1);
    assert.equal(
        r.played.length,
        2,
        "ordinary M3U startup retry remains ten seconds"
    );
    assert.equal(r.kiosk.snapshot().startup_grace_seconds, undefined);
}

for (const provider of ["vportal", "plex"]) {
    const r = rig();
    r.source(provider + ":0@one");
    const driver = { capabilities: { mediaPlaylist: true }, id: provider };
    r.w.__ottActiveProviderDriver = driver;
    let ended = false;
    r.w.__ottMedia = {
        current: () => ({ ended, sequence: { channel: { id: "b" } } }),
    };
    r.request({ mode: "on", query: "Новости" });
    r.play(true);
    r.advance(2, true);
    r.play(false);
    ended = true;
    r.advance(60);
    assert.equal(
        r.played.length,
        1,
        provider +
            " natural end gives the loop resolver sixty seconds from observation"
    );
    r.advance(1);
    assert.equal(r.played.length, 2);
    r.w.__ottActiveProviderDriver = undefined;
    r.kiosk.init();
    const restoredCount = r.played.length;
    assert.equal(r.kiosk.snapshot().startup_grace_seconds, 60);
    r.advance(59);
    assert.equal(
        r.played.length,
        restoredCount,
        provider + " cold persisted policy waits for provider mounting"
    );
    r.w.__ottActiveProviderDriver = driver;
    r.advance(1);
    assert.equal(r.played.length, restoredCount + 1);
}

// Both library providers lock their current request-backed media queue.
for (const provider of ["vportal", "plex"]) {
    const r = rig();
    r.source(provider + ":0@one");
    r.w.__ottActiveProviderDriver = {
        capabilities: { mediaPlaylist: true },
        id: provider,
    };
    r.w.__ottMedia = {
        current: () => ({ sequence: { channel: { id: "b" } } }),
        kioskSelection: () => {
            throw new Error(
                "Channel policy must not capture a detached media queue"
            );
        },
    };
    const result = r.request({ mode: "on", query: "Новости" });
    assert.equal(result.status, "ok");
    assert.equal(result.data.channel.id, "b");
    assert.deepEqual(r.played, ["b"]);
    assert.equal(r.kiosk.allowed("a"), false);
    assert.equal(r.kiosk.allowed("b"), true);
}

for (const provider of ["vportal", "plex"]) {
    const r = rig();
    const source = provider + ":0@one";
    r.source(source);
    r.w.__ottActiveProviderDriver = {
        capabilities: { mediaPlaylist: true },
        id: provider,
    };
    r.w.cList = [];
    r.w.curList = [];
    const records = [0, 1, 0].map((i) => ({
        __ottMediaRef: { itemId: "episode:" + i, sourceId: source },
        request: { episode: i },
        title: "Episode " + i,
        vportalSource: source,
    }));
    let selection = { index: 0, position: 12, records, source };
    const restored = [];
    let looped = 0;
    let ended = false;
    r.w.__ottMedia = {
        current: () => ({
            ended: ended,
            ref: selection.records[selection.index].__ottMediaRef,
            sequence: { index: selection.index, queueId: "test-queue" },
        }),
        keepKioskLoop: () => looped++,
        kioskSelection: () => selection,
        restoreKiosk: (value, guard) => {
            restored.push({ guard, value });
            return true;
        },
        sourceId: () => source,
    };
    r.w.__ottClassicPlayback = {
        snapshot: () => ({
            position: selection.position,
            target: {
                channelId:
                    selection.records[selection.index].__ottMediaRef.itemId,
                kind: "vod",
                sourceId: source,
            },
        }),
    };
    selection.queueId = "test-queue";
    const result = r.request({ mode: "on" });
    assert.equal(result.status, "ok");
    assert.equal(result.data.state, "locked");
    assert.equal(result.data.channel, null);
    assert.equal(result.data.media.total, 3);
    assert.equal(looped, 1);
    assert.equal(
        r.kiosk.allowed("a"),
        false,
        "TV cannot enter a VPortal kiosk"
    );
    assert.equal(
        r.kiosk.allowedMedia(records[1].__ottMediaRef),
        true,
        "next episode remains allowed"
    );
    assert.equal(
        r.kiosk.allowedMedia({ itemId: "unrelated", sourceId: source }),
        false
    );
    assert(
        !JSON.stringify(result).includes("request"),
        "wire status does not expose media requests"
    );
    r.advance(59);
    assert.equal(restored.length, 0, "slow native startup gets its full grace");
    r.advance(2);
    assert.equal(restored.length, 1);
    r.play(true);
    r.advance(20, true);
    assert.equal(restored.length, 1, "healthy VOD never restarts");
    for (const failure of ["write", "readback", "mismatch"]) {
        const write = r.w.stbSetItem;
        const read = r.w.stbGetItem;
        const persisted = r.storage.__ottKioskV1;
        selection.position += 10;
        r.w.stbSetItem = (key, value) => {
            if (failure === "write") throw Error("quota");
            if (failure !== "mismatch") write(key, value);
        };
        r.w.stbGetItem = (key) => {
            if (failure === "readback") throw Error("storage unavailable");
            return read(key);
        };
        // Brief buffering is still below the playback watchdog threshold.
        // A failed position checkpoint must not masquerade as a decoder error.
        r.advance(6);
        assert.equal(r.kiosk.snapshot().health, "playing", failure);
        assert.equal(restored.length, 1, failure + " does not restart video");
        if (failure !== "readback")
            assert.equal(r.storage.__ottKioskV1, persisted);
        r.w.stbSetItem = write;
        r.w.stbGetItem = read;
        r.advance(6, true);
        assert.equal(
            JSON.parse(r.storage.__ottKioskV1).media.position,
            selection.position,
            failure + " retries and persists the latest position after recovery"
        );
        assert.equal(r.kiosk.snapshot().health, "playing");
        assert.equal(restored.length, 1);
    }
    ended = true;
    r.play(false);
    r.advance(20);
    assert.equal(
        restored.length,
        1,
        "slow next-episode resolution receives startup grace"
    );
    ended = false;
    r.play(true);
    selection = { index: 1, position: 3, records, source };
    r.advance(6, true);
    assert.equal(
        JSON.parse(r.storage.__ottKioskV1).media.index,
        1,
        "episode cursor persists"
    );
    assert.equal(r.kiosk.snapshot().media.index, 1);
    selection = { index: 2, position: 17, records, source };
    r.advance(6, true);
    assert.equal(
        JSON.parse(r.storage.__ottKioskV1).media.index,
        2,
        "checkpoint retains the second occurrence of the same episode"
    );
    const reloaded = rig(r.storage);
    reloaded.source(source);
    reloaded.w.__ottActiveProviderDriver = { id: provider };
    reloaded.w.__ottMedia = r.w.__ottMedia;
    assert.equal(reloaded.kiosk.restoreMedia(), true);
    assert.equal(restored.at(-1).value.index, 2);
    const guard = restored.at(-1).guard;
    assert.equal(guard(), true);
    reloaded.request({ mode: "off" });
    assert.equal(guard(), false, "unlock invalidates delayed resume");
    let reloads = 0;
    r.w.restart = () => reloads++;
    r.play(false);
    r.advance(200);
    assert.equal(
        reloads,
        1,
        "failed VOD recovery escalates to a player reload"
    );
    const persisted = JSON.parse(r.storage.__ottKioskV1);
    assert.equal(persisted.media.index, 2);
    assert.equal(persisted.media.position, 17);
    r.w.__ottMedia.sourceId = () => "vportal:1@two";
    r.advance(60);
    assert.equal(
        r.kiosk.snapshot().health,
        "source-unavailable",
        "same IDs on another profile cannot play"
    );
    r.request({ mode: "off" });
    assert.equal(r.kiosk.allowedMedia(null), true);
}
{
    const r = rig();
    let reloads = 0;
    r.w.restart = () => reloads++;
    r.w.navigator = { onLine: false };
    r.request({ mode: "on", query: "1", strict: true });
    const before = r.played.length;
    r.advance(100);
    assert.equal(
        r.played.length,
        before,
        "offline kiosks do not hammer sources"
    );
    assert.equal(reloads, 0);
    r.w.navigator.onLine = true;
    r.advance(30);
    assert.equal(reloads, 0, "three soft retries precede reload");
    r.advance(10);
    assert.equal(reloads, 1);
    const persisted = JSON.parse(r.storage.__ottKioskV1);
    assert.equal(persisted.channel.id, "a");
    assert.equal(persisted.strict, true);
    const booted = rig(r.storage);
    booted.w.restart = () => reloads++;
    booted.advance(100);
    assert.equal(reloads, 1, "reload cooldown survives a new runtime");
    assert(booted.played.length > 3, "soft recovery continues during cooldown");
    r.request({ mode: "off" });
    r.advance(100);
    assert.equal(reloads, 1, "unlocked kiosks never auto-reload");
}
for (const failure of ["policy-write", "cooldown-readback", "source-change"]) {
    const r = rig();
    let reloads = 0;
    r.w.restart = () => reloads++;
    r.request({ mode: "on", query: "1" });
    const write = r.w.stbSetItem;
    if (failure === "source-change") r.source("m3u:1@other");
    else
        r.w.stbSetItem = (key, value) => {
            if (failure === "policy-write") throw Error("quota");
            if (key !== "__ottKioskReloadV1") write(key, value);
        };
    r.advance(80);
    assert.equal(reloads, 0, failure + " prevents an unsafe player reload");
}
{
    const r = rig();
    let reloads = 0;
    r.w.restart = () => reloads++;
    r.request({ mode: "on", query: "1" });
    r.w.commandChannelsReady = false;
    r.w.navigator = { onLine: false };
    r.advance(100);
    assert.equal(reloads, 0);
    r.w.navigator.onLine = true;
    r.advance(40);
    assert.equal(
        reloads,
        1,
        "a provider that failed during offline startup can reload after reconnect"
    );
}
{
    const r = rig();
    r.w.__ottActiveProviderDriver = { id: "vportal" };
    r.w.__ottMedia = {
        kioskSelection: () => null,
        sourceId: () => "vportal:0",
    };
    assert.equal(
        r.request({ mode: "on" }).status,
        "rejected",
        "empty library cannot masquerade as a locked video"
    );
    assert.equal(r.kiosk.enabled(), false);
}
{
    const r = rig();
    const config = {
        address: "https://plex.example:32400",
        token: "saved-token",
    };
    r.storage.plexcfg = JSON.stringify(config);
    r.w.__ottActiveProviderDriver = {
        credentials: () => ({ password: config.token, server: config.address }),
        id: "plex",
    };
    r.w.commandChannelsReady = false;
    r.w.providerMediaClient = null;
    load("src/provider/source-identity.ts", { window: r.w });
    load("src/media/classic-adapter.ts", { window: r.w });
    const source = r.w.__ottMedia.sourceId();
    assert.match(source, /^plex@/);
    assert.equal(r.w.__ottMedia.current(), null);
    const policy = JSON.stringify({
        channel: null,
        media: {
            index: 0,
            position: 12,
            records: [
                {
                    __ottMediaRef: { itemId: "7", sourceId: source },
                    request: { id: "7" },
                    title: "Retained film",
                },
            ],
            source,
        },
        provider: "plex",
        source,
        strict: true,
    });
    r.storage.__ottKioskV1 = policy;
    let reloads = 0,
        settings = 0;
    r.w.restart = () => reloads++;
    r.w.__ottEditProvider = r.w.alert = () => settings++;
    r.kiosk.init();
    r.advance(239);
    assert.equal(
        reloads,
        0,
        "unready media retains all three startup retry intervals"
    );
    assert.equal(r.kiosk.snapshot().retries, 3);
    r.advance(1);
    assert.equal(
        reloads,
        1,
        "same-source Plex startup failure reloads without a backend"
    );
    assert.equal(settings, 0);
    assert.equal(r.kiosk.strict(), true);
    assert.equal(r.w.commandChannelsReady, false);
    assert.equal(r.w.providerMediaClient, null);
    assert.equal(r.storage.__ottKioskV1, policy);
    assert.equal(r.storage.plexcfg, JSON.stringify(config));
}
console.log(
    "VPortal kiosk persistence, episode admission, startup grace and cancellation passed"
);

// Strict is durable and cannot be accidentally relaxed by an idempotent on/set.
{
    const r = rig();
    assert.equal(
        r.request({ mode: "on", query: "2", strict: true }).data.strict,
        true
    );
    assert.equal(r.kiosk.strict(), true);
    assert.equal(r.request({ mode: "on" }).data.strict, true);
    assert.equal(r.request({ mode: "set", query: "1" }).data.strict, true);
    const restored = rig(r.storage);
    assert.equal(restored.kiosk.strict(), true);
    assert.equal(restored.request({ mode: "off" }).data.strict, false);
    assert.equal(restored.kiosk.strict(), false);
    for (const strict of [null, 1, "true", {}, []]) {
        assert.equal(r.request({ mode: "on", strict }).status, "rejected");
    }
    for (const mode of ["status", "off"]) {
        assert.equal(r.request({ mode, strict: true }).status, "rejected");
    }
}
{
    const r = rig();
    assert.equal(r.request({ mode: "on", strict: true }).data.state, "waiting");
    assert.equal(
        r.kiosk.strict(),
        false,
        "armed kiosk must still admit its first selection"
    );
    r.w.playChannel(0, 0);
    assert.equal(r.kiosk.strict(), true);
    r.request({ mode: "off" });
    r.request({ mode: "on", query: "2" });
    r.request({ mode: "on", strict: true });
    assert.equal(
        r.kiosk.snapshot().channel.id,
        "b",
        "upgrade retains the pinned target"
    );
    assert.equal(r.kiosk.strict(), true);
    r.request({ mode: "on", strict: false });
    assert.equal(r.kiosk.strict(), false);
    assert.equal(r.kiosk.locked(), true);
}
{
    const dom = new JSDOM(
        '<body><button id="target">Play</button><input id="editor"><button id="remoteDiagnosticsIndicator">Stop support</button></body>'
    );
    const w = dom.window;
    let active = true,
        time = 1000,
        info = 0,
        leaked = 0,
        revoked = 0;
    w.showChannelInfo = (seconds) => {
        assert.equal(seconds, 5);
        info++;
    };
    Object.defineProperty(w.performance, "now", { value: () => time });
    w.__ottKiosk = { stopDiagnostics: () => revoked++ };
    w.keys = { INFO: 457, STOP: 413 };
    const input = strictInput.createStrictKioskInput(w, () => active);
    const target = w.document.getElementById("target");
    const editor = w.document.getElementById("editor");
    editor.focus();
    input.sync();
    assert.equal(w.document.activeElement, w.document.body);
    assert(w.document.documentElement.classList.contains("ott-kiosk-strict"));
    const names = [
        "click",
        "dblclick",
        "contextmenu",
        "pointerdown",
        "pointermove",
        "pointerup",
        "pointercancel",
        "mousedown",
        "mousemove",
        "mouseup",
        "touchstart",
        "touchmove",
        "touchend",
        "touchcancel",
        "wheel",
        "keydown",
        "keyup",
        "keypress",
        "dragstart",
        "selectstart",
    ];
    for (const name of names) w.document.addEventListener(name, () => leaked++);
    function event(type, props = {}, node = target) {
        const e = new w.Event(type, { bubbles: true, cancelable: true });
        Object.assign(e, props);
        node.dispatchEvent(e);
        assert(e.defaultPrevented, type + " consumes its native default");
    }
    const point = (x, id = 1) => ({
        clientX: x,
        clientY: 100,
        identifier: id,
    });
    const touch = (type, touches, changedTouches = touches) =>
        event(type, { changedTouches, touches });
    touch("touchstart", [point(100)]);
    touch("touchend", [], [point(100)]);
    assert.equal(info, 1);
    event("click", { detail: 1 });
    assert.equal(info, 1, "compatibility click cannot duplicate a touch");
    time += 1000;
    touch("touchstart", [point(100)]);
    touch("touchmove", [point(160)]);
    touch("touchmove", [point(100)]);
    touch("touchend", [], [point(100)]);
    assert.equal(info, 1, "returning swipe is not a tap");
    touch("touchstart", [point(100)]);
    touch("touchstart", [point(100), point(150, 2)]);
    touch("touchend", [point(100)], [point(150, 2)]);
    touch("touchend", [], [point(100)]);
    assert.equal(info, 1, "two fingers never activate a control");
    touch("touchstart", [point(100)]);
    time += 1000;
    event("contextmenu");
    touch("touchend", [], [point(100)]);
    assert.equal(info, 1, "long press never activates a control");
    time += 1000;
    event("pointerdown", {
        button: 0,
        clientX: 10,
        clientY: 10,
        pointerId: 3,
        pointerType: "mouse",
    });
    event("pointerup", {
        clientX: 10,
        clientY: 10,
        pointerId: 3,
        pointerType: "mouse",
    });
    assert.equal(info, 2);
    event("click", { detail: 1 });
    assert.equal(info, 2);
    for (const keyCode of [13, 27, 32, 37, 38, 39, 40, 175, 176]) {
        event("keydown", { keyCode }, editor);
        event("keyup", { keyCode }, editor);
    }
    event("keydown", { keyCode: 457 });
    assert.equal(info, 3, "INFO has only the read-only footer action");
    event("keydown", { keyCode: 413 });
    assert.equal(
        revoked,
        1,
        "stopping the current diagnostic capture remains available"
    );
    for (const type of [
        "dblclick",
        "wheel",
        "dragstart",
        "selectstart",
        "touchcancel",
        "pointercancel",
        "keypress",
    ])
        event(type);
    assert.equal(leaked, 0, "legacy handlers never receive strict input");
    active = false;
    input.sync();
    assert(!w.document.documentElement.classList.contains("ott-kiosk-strict"));
    target.dispatchEvent(
        new w.MouseEvent("click", { bubbles: true, cancelable: true })
    );
    assert.equal(leaked, 1, "remote unlock restores local controls");
    dom.window.close();
}
console.log(
    "Strict kiosk persistence, gesture isolation and read-only input tests passed"
);

// Full-page recovery must survive the next runtime, unlike a session fallback.
function quotaKioskStorage(saved) {
    const document = {};
    Object.defineProperty(document, "cookie", {
        get() {
            throw Error("cookies denied");
        },
        set() {
            throw Error("cookies denied");
        },
    });
    const localStorage = {
        clear() {
            throw Error("quota");
        },
        getItem: (key) => saved[key] ?? null,
        key: (index) => Object.keys(saved)[index],
        get length() {
            return Object.keys(saved).length;
        },
        removeItem() {
            throw Error("quota");
        },
        setItem() {
            throw Error("quota");
        },
    };
    return load("src/storage/index.ts", {
        console,
        document,
        window: { document, localStorage },
    });
}
{
    const seed = rig();
    seed.request({ mode: "on", query: "1", strict: true });
    const saved = { ...seed.storage };
    let reloads = 0;
    for (let boot = 0; boot < 2; boot++) {
        const storage = quotaKioskStorage(saved);
        const r = rig();
        r.w.stbGetItem = storage.stbGetItem;
        r.w.stbSetItem = storage.stbSetItem;
        r.w.stbGetPersistedItem = storage.stbGetPersistedItem;
        r.w.restart = () => reloads++;
        r.kiosk.init();
        assert.equal(
            r.kiosk.strict(),
            true,
            "pre-existing policy survives quota failure"
        );
        r.advance(80);
        assert.equal(saved.__ottKioskReloadV1, undefined);
        assert.equal(
            reloads,
            0,
            "memory-only cooldown cannot authorize a full reload"
        );
        assert(
            r.played.length >= 7,
            "soft recovery continues with failed backing storage"
        );
    }
}
for (const failure of ["missing", "unreadable"]) {
    const r = rig();
    let reloads = 0;
    r.w.restart = () => reloads++;
    r.request({ mode: "on", query: "1", strict: true });
    if (failure === "missing") delete r.w.stbGetPersistedItem;
    else
        r.w.stbGetPersistedItem = () => {
            throw Error("backing unreadable");
        };
    r.advance(80);
    assert.equal(
        reloads,
        0,
        failure + " durable reader keeps full reload disabled"
    );
    assert(
        r.played.length >= 7,
        "soft recovery does not depend on durable read support"
    );
}
{
    const r = rig();
    let reloads = 0;
    r.w.restart = () => reloads++;
    r.request({ mode: "on", query: "1", strict: true });
    r.storage.__ottKioskReloadV1 = String(Date.now());
    const read = r.w.stbGetItem;
    r.w.stbGetItem = (key) => (key === "__ottKioskReloadV1" ? null : read(key));
    r.advance(80);
    assert.equal(
        reloads,
        0,
        "persisted cooldown wins over a transient session view"
    );
    assert(r.played.length >= 7);
}
console.log(
    "Kiosk full reload requires durable policy/cooldown; memory fallback retains soft recovery"
);

function decoderRig(fps = 25) {
    const r = rig();
    let frozen = null;
    const video = {
        buffered: { end: () => 10000, length: 1, start: () => 0 },
        get currentTime() {
            return r.w.stbGetPosTime();
        },
        ended: false,
        error: null,
        getVideoPlaybackQuality: () => ({
            droppedVideoFrames: 0,
            totalVideoFrames:
                frozen === null
                    ? Math.floor(r.w.stbGetPosTime() * fps)
                    : frozen,
        }),
        paused: false,
        playbackRate: 1,
        readyState: 4,
        seeking: false,
        videoHeight: 1080,
        videoWidth: 1920,
    };
    r.w.document.getElementById = () => video;
    r.w.document.visibilityState = "visible";
    r.w.document.hasFocus = () => true;
    r.w.getComputedStyle = () => ({
        display: "block",
        opacity: "1",
        visibility: "visible",
    });
    r.w.__ottClassicPlayback = { snapshot: () => ({ generation: 1 }) };
    r.request({ mode: "on", query: "1", strict: true });
    r.play(true);
    return {
        ...r,
        freeze: () => {
            frozen = Math.floor(r.w.stbGetPosTime() * fps);
        },
        resume: () => {
            frozen = null;
        },
        video,
    };
}
{
    const r = decoderRig();
    r.advance(5, true);
    r.freeze();
    r.advance(23, true);
    assert.equal(
        r.played.length,
        1,
        "a short frame gap must not restart playback"
    );
    assert.equal(r.kiosk.snapshot().video_progress.state, "stalled");
    r.advance(2, true);
    assert.equal(
        r.played.length,
        2,
        "frozen decoded frames recover even while the media clock advances"
    );
    assert.equal(r.kiosk.snapshot().strict, true);
    assert.equal(r.kiosk.snapshot().retries, 1);
}
{
    const r = decoderRig();
    let reloads = 0;
    r.w.restart = () => reloads++;
    r.advance(5, true);
    r.freeze();
    r.advance(205, true);
    assert.equal(
        reloads,
        1,
        "a failed decoder retry must escalate to a bounded player reload"
    );
    assert.equal(r.kiosk.snapshot().retries, 3);
    assert.equal(r.kiosk.snapshot().strict, true);
    r.advance(300, true);
    assert.equal(
        reloads,
        1,
        "persistent reload cooldown prevents a decoder reload loop"
    );
    assert(
        r.kiosk.snapshot().retries > 3,
        "soft retries continue during cooldown"
    );
}
{
    const r = decoderRig();
    let reloads = 0;
    r.w.restart = () => reloads++;
    r.advance(5, true);
    for (let i = 0; i < 4; i++) {
        r.freeze();
        r.advance(25, true);
        r.resume();
        r.advance(3, true);
    }
    assert.equal(
        reloads,
        1,
        "brief frame bursts cannot continually erase the recovery budget"
    );
}
for (const fps of [1, 25]) {
    const r = decoderRig(fps);
    r.advance(90, true);
    assert.equal(
        r.played.length,
        1,
        `${fps}fps playback must remain uninterrupted`
    );
    assert.equal(r.kiosk.snapshot().video_progress.state, "progressing");
}
for (const fps of [1 / 30, 1 / 10]) {
    const r = decoderRig(fps);
    r.advance(180, true);
    assert.equal(
        r.played.length,
        1,
        "sparse slideshow frames must not be called a decoder stall"
    );
    assert.equal(r.kiosk.snapshot().video_progress.state, "warming");
}
for (const suppress of [
    (r) => {
        r.video.paused = true;
    },
    (r) => {
        r.video.seeking = true;
    },
    (r) => {
        r.video.ended = true;
    },
    (r) => {
        r.video.readyState = 2;
    },
    (r) => {
        r.video.playbackRate = 2;
    },
    (r) => {
        r.video.videoWidth = 0;
    },
    (r) => {
        r.video.videoTracks = [];
    },
    (r) => {
        r.video.buffered.end = () => r.video.currentTime + 1;
    },
    (r) => {
        r.w.document.visibilityState = "hidden";
    },
    (r) => {
        r.w.document.hasFocus = () => false;
    },
    (r) => {
        r.w.getComputedStyle = () => ({ display: "none" });
    },
    (r) => {
        r.w.getComputedStyle = () => ({ visibility: "hidden" });
    },
    (r) => {
        r.w.getComputedStyle = () => ({ opacity: "0" });
    },
    (r) => {
        r.video.parentElement = {};
        r.w.getComputedStyle = (el) => ({
            opacity: el === r.video ? "1" : "0",
        });
    },
    (r) => {
        r.video.parentElement = r.video;
    },
    (r) => {
        r.video.getBoundingClientRect = () => ({ height: 0, width: 0 });
    },
    (r) => {
        r.w.innerWidth = 1280;
        r.video.getBoundingClientRect = () => ({
            bottom: 800,
            height: 800,
            left: 1280,
            right: 2560,
            top: 0,
            width: 1280,
        });
    },
    (r) => {
        r.video.getVideoPlaybackQuality = undefined;
    },
    (r) => {
        r.video.getVideoPlaybackQuality = () => {
            throw new Error("unavailable");
        };
    },
    (r) => {
        r.video.getVideoPlaybackQuality = () => ({
            droppedVideoFrames: 0,
            totalVideoFrames: 0,
        });
    },
    (r) => {
        r.video.getVideoPlaybackQuality = () => ({
            droppedVideoFrames: 0,
            totalVideoFrames: NaN,
        });
    },
    (r) => {
        r.video.getVideoPlaybackQuality = () => ({
            droppedVideoFrames: 100,
            totalVideoFrames: 1,
        });
    },
]) {
    const r = decoderRig();
    r.advance(5, true);
    suppress(r);
    r.freeze();
    r.advance(60, true);
    assert.equal(
        r.played.length,
        1,
        "missing, suspended or never-progressing frame evidence cannot force recovery"
    );
}
for (const transition of [
    (r) => {
        r.w.__ottClassicPlayback.snapshot = () => ({ generation: 2 });
    },
    (r) => {
        r.w.document.getElementById = () => ({ ...r.video });
    },
    (r) => {
        r.video.getVideoPlaybackQuality = undefined;
        r.video.webkitDecodedFrameCount = 125;
        r.video.webkitDroppedFrameCount = 0;
    },
    (r) => {
        r.w.performance.now = () => 600000;
    },
]) {
    const r = decoderRig();
    r.advance(5, true);
    r.freeze();
    r.advance(12, true);
    transition(r);
    r.advance(30, true);
    assert.equal(
        r.played.length,
        1,
        "a new source/counter/clock needs fresh evidence"
    );
}
{
    const r = decoderRig();
    const count = r.video.getVideoPlaybackQuality;
    r.video.getVideoPlaybackQuality = undefined;
    Object.defineProperty(r.video, "webkitDecodedFrameCount", {
        get: () => count().totalVideoFrames,
    });
    r.video.webkitDroppedFrameCount = 0;
    r.advance(5, true);
    assert.equal(r.kiosk.snapshot().video_progress.source, "webkit-decoded");
    r.freeze();
    r.advance(25, true);
    assert.equal(
        r.played.length,
        2,
        "legacy WebKit counters also detect a stall"
    );
}
console.log(
    "Kiosk decoder progress catches frozen frames with an advancing clock without restarting low-fps or unobservable playback"
);

function seekRig() {
    const r = rig();
    const source = "plex:0@local";
    const records = [0, 1].map((i) => ({
        __ottMediaRef: { itemId: "episode:" + i, sourceId: source },
        request: { id: i },
        title: "Episode " + i,
        vportalSource: source,
    }));
    const selection = {
        index: 0,
        position: 10,
        queueId: "seek-queue",
        records,
        source,
    };
    const state = {
        generation: 1,
        target: { channelId: "episode:0", kind: "vod", sourceId: source },
    };
    const sample = { duration: 120, phase: "playing" };
    const seeks = [];
    const handle = {
        active: () => true,
        seek: (value) => seeks.push(value),
        snapshot: () => sample,
    };
    const backend = { current: () => handle };
    r.source(source);
    r.w.__ottActiveProviderDriver = { id: "plex" };
    r.w.__ottCoreTransport = { play() {} };
    r.w.stbPlay = r.w.__ottCoreTransport.play;
    r.w.__ottCoreBackendPeek = () => backend;
    r.w.__ottClassicPlayback = { snapshot: () => state };
    r.w.__ottMedia = {
        current: () => ({ ref: records[selection.index].__ottMediaRef }),
        keepKioskLoop() {},
        kioskSelection: () => selection,
        sourceId: () => source,
    };
    r.request({ mode: "on", strict: true });
    return { ...r, backend, handle, sample, seeks, selection, state };
}
{
    const r = seekRig();
    assert.equal(r.kiosk.beginSeek()(0.75), true);
    assert.equal(r.kiosk.beginSeek()(0.25), true);
    assert.equal(r.kiosk.beginSeek()(-2), true);
    assert.equal(r.kiosk.beginSeek()(2), true);
    assert.deepEqual(r.seeks, [90, 30, 0, 119]);
    assert.equal(r.kiosk.snapshot().strict, true);
    assert.equal(r.kiosk.snapshot().media.total, 2);
    assert.equal(r.selection.index, 0);
}
for (const change of [
    (r) => r.state.generation++,
    (r) => {
        r.selection.index = 1;
        r.state.target.channelId = "episode:1";
    },
    (r) => {
        r.w.__ottMedia.sourceId = () => "plex:1@other";
    },
    (r) => {
        r.backend.current = () => ({ ...r.handle });
    },
    (r) => {
        r.handle.active = () => false;
    },
    (r) => {
        r.w.stbPlay = () => {};
    },
    (r) => {
        r.sample.phase = "loading";
    },
    (r) => {
        r.sample.duration = Infinity;
    },
    (r) => {
        r.request({ mode: "off" });
    },
    (r) => {
        r.request({ mode: "on", strict: false });
    },
]) {
    const r = seekRig();
    const commit = r.kiosk.beginSeek();
    assert.equal(typeof commit, "function");
    change(r);
    assert.equal(
        commit(0.5),
        false,
        "a changed player or kiosk retires the gesture"
    );
    assert.deepEqual(r.seeks, []);
}
{
    const r = seekRig();
    assert.equal(r.kiosk.beginSeek()(NaN), false);
    r.state.target.kind = "live";
    assert.equal(r.kiosk.beginSeek(), null);
    assert.deepEqual(r.seeks, []);
}
for (const frozenSeconds of [20, 25]) {
    const r = seekRig();
    const clockPosition = r.w.stbGetPosTime;
    let offset = 0,
        frozenFrames = null,
        reloads = 0;
    r.sample.duration = 1200;
    r.w.stbGetPosTime = () => clockPosition() + offset;
    r.handle.seek = (value) => {
        r.seeks.push(value);
        offset = value - clockPosition();
    };
    r.w.__ottClassicPlayback.snapshot = () => ({
        ...r.state,
        position: r.w.stbGetPosTime(),
    });
    r.w.__ottMedia.restoreKiosk = () => true;
    r.w.restart = () => reloads++;
    const video = {
        buffered: { end: () => 10000, length: 1, start: () => 0 },
        get currentTime() {
            return r.w.stbGetPosTime();
        },
        ended: false,
        error: null,
        getVideoPlaybackQuality: () => ({
            droppedVideoFrames: 0,
            totalVideoFrames:
                frozenFrames === null
                    ? Math.floor(clockPosition() * 25)
                    : frozenFrames,
        }),
        paused: false,
        playbackRate: 1,
        readyState: 4,
        seeking: false,
        videoHeight: 1080,
        videoWidth: 1920,
    };
    r.w.document.getElementById = () => video;
    r.w.document.visibilityState = "visible";
    r.w.document.hasFocus = () => true;
    r.w.getComputedStyle = () => ({
        display: "block",
        opacity: "1",
        visibility: "visible",
    });
    r.play(true);
    r.advance(5, true);
    frozenFrames = Math.floor(clockPosition() * 25);
    r.advance(frozenSeconds, true);
    const before = r.kiosk.snapshot().retries;
    assert.equal(before, frozenSeconds === 20 ? 0 : 1);
    assert.equal(
        r.kiosk.snapshot().video_progress.state,
        frozenSeconds === 20 ? "stalled" : "warming"
    );
    assert.equal(r.kiosk.beginSeek()(0.5), true);
    assert.deepEqual(r.seeks, [600]);
    r.advance(59, true);
    assert.equal(
        r.kiosk.snapshot().retries,
        before,
        "intentional seek receives its startup grace"
    );
    r.advance(1, true);
    assert.equal(
        r.kiosk.snapshot().retries,
        before + 1,
        "seek must preserve unresolved frame recovery"
    );
    r.advance(240, true);
    assert.equal(
        reloads,
        1,
        "frozen frames still reach bounded reload after seeking"
    );
    assert.equal(r.kiosk.snapshot().strict, true);
    assert.equal(video.getVideoPlaybackQuality().totalVideoFrames, 125);
}
console.log(
    "Kiosk footer seek stays within the captured episode, decoder and policy"
);

{
    const dom = new JSDOM(
        '<body><div id="info1"><div id="progress_div"><div id="progress"></div></div></div><button id="elsewhere"></button></body>'
    );
    const w = dom.window;
    const bar = w.document.getElementById("progress_div");
    const child = w.document.getElementById("progress");
    const other = w.document.getElementById("elsewhere");
    let time = 1000,
        leaked = 0;
    const seeks = [];
    bar.getBoundingClientRect = () => ({
        bottom: 124,
        height: 24,
        left: 40,
        right: 240,
        top: 100,
        width: 200,
    });
    Object.defineProperty(w.performance, "now", { value: () => time });
    w.showChannelInfo = () => {};
    w.__ottKiosk = {
        beginSeek: () => (f) => {
            seeks.push(f);
            return true;
        },
    };
    strictInput.createStrictKioskInput(w, () => true);
    for (const type of [
        "touchstart",
        "touchmove",
        "touchend",
        "click",
        "pointerdown",
        "pointerup",
    ])
        w.document.addEventListener(type, () => leaked++);
    function send(node, type, props) {
        const e = new w.Event(type, { bubbles: true, cancelable: true });
        Object.assign(e, props);
        node.dispatchEvent(e);
        assert(e.defaultPrevented);
    }
    const point = (x, y = 110, identifier = 1) => ({
        clientX: x,
        clientY: y,
        identifier,
    });
    function touch(node, type, points, changed = points) {
        send(node, type, { changedTouches: changed, touches: points });
    }
    touch(child, "touchstart", [point(90)]);
    touch(child, "touchmove", [point(200)]);
    touch(child, "touchend", [], [point(200)]);
    assert.deepEqual(seeks, [0.8], "one commit on drag release");
    send(child, "click", { clientX: 200, clientY: 110, detail: 1 });
    assert.equal(seeks.length, 1, "compatibility click cannot seek twice");
    time += 1000;
    touch(child, "touchstart", [point(90)]);
    touch(child, "touchmove", [point(90, 180)]);
    touch(child, "touchmove", [point(90)]);
    touch(child, "touchend", [], [point(90)]);
    assert.equal(seeks.length, 1, "returning vertical swipe remains cancelled");
    touch(child, "touchstart", [point(190)]);
    touch(child, "touchmove", [point(190, 135)]);
    touch(child, "touchend", [], [point(190, 135)]);
    assert.equal(seeks.length, 1, "short vertical swipe cannot become a seek");
    touch(child, "touchstart", [point(90)]);
    touch(child, "touchstart", [point(90), point(180, 110, 2)]);
    touch(child, "touchend", [], [point(90)]);
    assert.equal(seeks.length, 1, "multi-touch cannot seek");
    touch(other, "touchstart", [point(90)]);
    touch(child, "touchend", [], [point(90)]);
    assert.equal(seeks.length, 1, "gesture must begin on the progress bar");
    time += 1000;
    send(child, "pointerdown", {
        button: 0,
        clientX: 140,
        clientY: 110,
        pointerId: 3,
        pointerType: "mouse",
    });
    send(child, "pointerup", {
        clientX: 90,
        clientY: 110,
        pointerId: 3,
        pointerType: "mouse",
    });
    assert.deepEqual(seeks, [0.8, 0.25]);
    touch(child, "touchstart", [point(90)]);
    bar.id = "old-progress";
    touch(child, "touchend", [], [point(90)]);
    assert.equal(seeks.length, 2, "retired footer cannot commit");
    assert.equal(
        leaked,
        0,
        "seek exception never dispatches to ordinary controls"
    );
    dom.window.close();
}
console.log(
    "Strict footer drag/tap has one seek, no escaped input, and cancels stale or multi-touch gestures"
);

function screenRig() {
    const r = seekRig();
    const calls = [];
    let subscriber;
    r.state.position = 37;
    r.handle.pause = () => {
        calls.push("pause");
        r.sample.phase = "paused";
        if (subscriber) subscriber({ handle: r.handle, type: "pause" });
    };
    let suspended = false;
    r.handle.suspend = () => {
        if (suspended && r.sample.phase === "paused") return;
        suspended = true;
        calls.push("suspend");
        r.sample.phase = "paused";
        if (subscriber) subscriber({ handle: r.handle, type: "suspend" });
    };
    r.handle.resume = () => {
        calls.push("resume");
        r.sample.phase = "playing";
    };
    r.backend.subscribe = (fn) => {
        subscriber = fn;
        return () => {
            subscriber = null;
        };
    };
    return { ...r, calls, publish: () => subscriber({ handle: r.handle }) };
}
function localScreenRig(mode = "off") {
    const r = screenRig();
    r.request({ mode: "off" });
    r.w.__ottActiveProviderDriver = { id: "offline" };
    r.source("offline:device");
    if (mode === "waiting") r.request({ mode: "on" });
    if (mode === "folder") {
        Object.assign(r.w.channels.a, {
            __ottLocalSource: "local-folder",
            __ottLocalSourceName: "Local",
        });
        r.w.__ottLocalMedia = {
            completedSources: () => [
                { id: "local-folder", kind: "folder", name: "Local" },
            ],
        };
        assert.equal(
            r.request({ mode: "on", query: "folder:Local", strict: true })
                .status,
            "ok"
        );
    }
    r.calls.length = 0;
    return r;
}
for (const mode of ["off", "waiting", "folder"]) {
    const r = localScreenRig(mode);
    r.kiosk.setScreenAwake(false);
    assert.deepEqual(
        r.calls,
        ["suspend"],
        "local screen off suspends in " + mode
    );
    assert.equal(r.kiosk.screenBlocked(), true);
    r.advance(90);
    assert.equal(r.kiosk.snapshot().retries, 0);
    r.sample.phase = "playing";
    r.publish();
    assert.deepEqual(
        r.calls,
        ["suspend", "suspend"],
        "late local start remains suspended"
    );
    r.kiosk.setScreenAwake(true);
    r.kiosk.setScreenAwake(true);
    assert.equal(r.calls.filter((c) => c === "resume").length, 1);
    assert.equal(r.state.position, 37);
}
{
    const r = screenRig();
    r.request({ mode: "off" });
    r.kiosk.setScreenAwake(false);
    r.w.__ottActiveProviderDriver = { id: "offline" };
    r.source("offline:device");
    r.events.play();
    assert.deepEqual(r.calls, ["suspend"]);
    r.kiosk.setScreenAwake(true);
    assert.deepEqual(
        r.calls,
        ["suspend", "resume"],
        "provider loaded while asleep owns its wake"
    );
}
for (const change of [
    (r) => r.source("offline:other"),
    (r) => {
        r.w.__ottActiveProviderDriver = { id: "plex" };
    },
    (r) => {
        r.backend.current = () => ({ ...r.handle });
    },
    (r) => {
        r.w.__ottStandby = { blocked: () => true };
    },
]) {
    const r = localScreenRig();
    r.kiosk.setScreenAwake(false);
    change(r);
    r.kiosk.setScreenAwake(true);
    assert.equal(
        r.calls.includes("resume"),
        false,
        "stale/standby local wake is inert"
    );
}
{
    const r = localScreenRig();
    let ends = 0;
    r.kiosk.setScreenAwake(false);
    r.kiosk.deferScreenEnd(() => {
        ends++;
    });
    assert.equal(ends, 0);
    r.kiosk.setScreenAwake(true);
    r.kiosk.setScreenAwake(true);
    assert.equal(ends, 1, "deferred local completion resumes once on wake");
}
{
    const r = screenRig();
    r.kiosk.setScreenAwake(false);
    r.kiosk.setScreenAwake(false);
    assert.deepEqual(
        r.calls,
        ["suspend"],
        "sleep is idempotent, including reentrant backend events"
    );
    assert.equal(JSON.parse(r.storage.__ottKioskV1).media.position, 37);
    r.advance(900);
    assert.equal(
        r.kiosk.snapshot().retries,
        0,
        "sleep never trips the watchdog"
    );
    assert.equal(r.kiosk.snapshot().screen_suspended, true);
    assert.equal(r.kiosk.snapshot().health, "waiting");
    r.sample.phase = "playing";
    r.events.play();
    assert.deepEqual(
        r.calls,
        ["suspend", "suspend"],
        "late HTML autoplay is suspended"
    );
    r.sample.phase = "loading";
    r.publish();
    assert.equal(
        r.calls.at(-1),
        "suspend",
        "late native backend start is suspended"
    );
    r.kiosk.setScreenAwake(true);
    r.kiosk.setScreenAwake(true);
    assert.equal(r.calls.filter((c) => c === "resume").length, 1);
    assert.equal(r.state.position, 37);
    assert.deepEqual(
        r.seeks,
        [],
        "resume does not seek or replace the episode"
    );
    assert.equal(r.kiosk.snapshot().strict, true);
    assert.equal(r.kiosk.snapshot().media.total, 2);
    r.advance(9);
    assert.equal(
        r.kiosk.snapshot().retries,
        0,
        "wake starts a fresh watchdog grace"
    );
}
for (const strict of [false, true]) {
    const r = screenRig();
    r.request({ mode: "on", strict: !strict });
    r.kiosk.setScreenAwake(false);
    assert.equal(r.request({ mode: "on", strict }).status, "ok");
    assert.equal(r.kiosk.snapshot().strict, strict);
    assert.deepEqual(
        r.calls,
        ["suspend"],
        "policy update must not wake playback"
    );
    r.kiosk.setScreenAwake(true);
    assert.deepEqual(
        r.calls,
        ["suspend", "resume"],
        "changing input strictness keeps ownership of the same sleeping episode"
    );
    assert.equal(r.state.position, 37);
}
for (const change of [
    (r) => r.request({ mode: "off" }),
    (r) => {
        r.w.__ottMedia.sourceId = () => "plex:other";
    },
    (r) => {
        r.backend.current = () => ({ ...r.handle });
    },
    (r) => {
        r.handle.active = () => false;
    },
    (r) => {
        r.sample.phase = "stopped";
    },
]) {
    const r = screenRig();
    r.kiosk.setScreenAwake(false);
    change(r);
    r.kiosk.setScreenAwake(true);
    assert.equal(
        r.calls.includes("resume"),
        false,
        "never resume a retired session"
    );
}
{
    const r = screenRig();
    r.sample.phase = "paused";
    r.kiosk.setScreenAwake(false);
    r.kiosk.setScreenAwake(true);
    assert.deepEqual(
        r.calls,
        ["suspend"],
        "sleep releases a pre-existing paused transport without resuming it"
    );
    r.calls.length = 0;
    r.request({ mode: "off" });
    r.sample.phase = "playing";
    r.kiosk.setScreenAwake(false);
    r.events.play();
    r.advance(60);
    assert.deepEqual(r.calls, [], "non-kiosk background audio is unaffected");
}
{
    const r = rig();
    r.kiosk.setScreenAwake(false);
    r.request({ mode: "on", query: "1", strict: true });
    r.advance(900);
    assert.deepEqual(
        r.played,
        [],
        "boot/remote selection cannot start while asleep"
    );
    r.kiosk.setScreenAwake(true);
    assert.deepEqual(r.played, ["a"], "deferred kiosk startup runs on wake");
}
{
    const r = rig();
    r.kiosk.setScreenAwake(false);
    r.request({ mode: "on", query: "1" });
    r.request({ mode: "on", strict: true });
    assert.deepEqual(
        r.played,
        [],
        "strict update cannot start a sleeping player"
    );
    r.kiosk.setScreenAwake(true);
    assert.deepEqual(
        r.played,
        ["a"],
        "strict update preserves an unstarted channel deferred until wake"
    );
}
{
    const r = rig();
    const calls = [];
    let phase = "playing";
    const handle = {
        active: () => true,
        pause: () => {
            calls.push("pause");
            phase = "paused";
        },
        resume: () => calls.push("resume"),
        snapshot: () => ({ phase }),
    };
    const backend = { current: () => handle };
    r.w.__ottCoreBackendPeek = () => backend;
    r.request({ mode: "on", query: "1" });
    r.kiosk.setScreenAwake(false);
    r.request({ mode: "set", query: "2" });
    r.request({ mode: "on", strict: true });
    r.kiosk.setScreenAwake(true);
    assert.deepEqual(
        r.played,
        ["a", "b"],
        "wake starts the replacement channel"
    );
    assert.deepEqual(calls, ["pause"], "a replaced channel never resumes");
}

for (const kind of ["live", "archive"]) {
    const r = rig();
    const calls = [];
    let phase = "playing";
    const handle = {
        active: () => true,
        resume: () => calls.push("resume"),
        snapshot: () => ({ phase }),
        suspend: () => {
            calls.push("suspend");
            phase = "paused";
        },
    };
    r.w.__ottCoreBackendPeek = () => ({ current: () => handle });
    r.w.__ottClassicPlayback = {
        snapshot: () => ({ position: 123, target: { kind } }),
    };
    r.request({ mode: "on", query: "1" });
    r.kiosk.setScreenAwake(false);
    r.kiosk.setScreenAwake(true);
    assert.deepEqual(
        r.played,
        kind === "live" ? ["a", "a"] : ["a"],
        "only live playback resolves the channel again; archive stays at its saved cursor"
    );
    assert.deepEqual(
        calls,
        kind === "live" ? ["suspend"] : ["suspend", "resume"],
        "archive resumes its saved lease instead of being replaced with the live channel"
    );
}

async function testScreenBridge() {
    const { bindKioskScreen } = load("src/plugins/kiosk-screen.ts", {
        Promise,
    });
    const states = [];
    let listener, reply;
    const w = {
        __ottKiosk: { setScreenAwake: (v) => states.push(v) },
        Capacitor: {
            getPlatform: () => "android",
            Plugins: {
                MobileNativeMedia: {
                    addListener: (name, fn) => {
                        assert.equal(name, "screenStateChanged");
                        listener = fn;
                        return Promise.resolve({ remove() {} });
                    },
                    getScreenState: () =>
                        new Promise((resolve) => {
                            reply = resolve;
                        }),
                },
            },
        },
    };
    bindKioskScreen(w);
    await Promise.resolve();
    listener({ awake: false, ok: true, revision: 2 });
    reply({ awake: true, ok: true, revision: 1 });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.deepEqual(
        states,
        [false, false],
        "stale initial state cannot undo screen-off"
    );
    listener({ awake: true, ok: true, revision: 3 });
    assert.equal(states.at(-1), true);
    states.length = 0;
    w.Capacitor.Plugins.MobileNativeMedia.getScreenState = () =>
        Promise.reject(Error("old APK"));
    bindKioskScreen(w);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    assert.deepEqual(
        states,
        [false, true],
        "old APKs retain existing playback behavior"
    );
    states.length = 0;
    w.Capacitor.getPlatform = () => "ios";
    bindKioskScreen(w);
    assert.deepEqual(states, [], "Android power bridge does not change iOS");
    console.log(
        "Android kiosk sleep pauses, suppresses recovery, checkpoints and safely resumes the active queue"
    );
}
testScreenBridge().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
{
    const r = rig();
    r.request({ mode: "on" });
    r.w.playChannel(0, 1);
    const started = r.played.length;
    r.w.__ottStandby = { blocked: () => true };
    r.w.restart = () => assert.fail("standby watchdog must not reload");
    r.play(false);
    r.advance(120);
    r.kiosk.restoreMedia();
    assert.equal(
        r.played.length,
        started,
        "manual standby suppresses watchdog and restore playback"
    );
    r.w.__ottStandby.blocked = () => false;
    r.advance(10);
    assert(r.played.length > started, "wake restores normal kiosk recovery");
}
{
    const r = rig();
    r.w.__ottActiveProviderDriver = { id: "offline" };
    r.source("offline:device");
    r.w.channels = {
        a: {
            __ottLocalSource: "folder-1",
            __ottLocalSourceName: "Winnie",
            channel_name: "First",
        },
        b: {
            __ottLocalSource: "folder-2",
            __ottLocalSourceName: "Other",
            channel_name: "Outside",
        },
        c: {
            __ottLocalSource: "folder-1",
            __ottLocalSourceName: "Winnie",
            channel_name: "Last",
        },
    };
    r.w.cats.all = r.w.cList = r.w.curList = ["a", "b", "c"];
    const sources = [
        { id: "folder-1", kind: "folder", name: "Winnie" },
        { id: "folder-2", kind: "folder", name: "Other" },
    ];
    r.w.__ottLocalMedia = { completedSources: () => sources };
    const result = r.request({
        mode: "on",
        query: "folder:Winnie",
        strict: true,
    });
    assert.equal(result.status, "ok");
    assert.equal(r.kiosk.strict(), true);
    assert.equal(r.kiosk.snapshot().folder.total, 2);
    assert.equal(r.kiosk.allowed("b"), false);
    assert.equal(r.kiosk.folderNext("a", r.w.curList), "c");
    assert.equal(r.kiosk.folderNext("c", r.w.curList), "a");
    assert.equal(r.kiosk.admit("c"), true);
    assert.equal(r.kiosk.snapshot().channel.id, "c");
    assert.equal(r.kiosk.admit("b"), false);
    const saved = JSON.parse(r.storage.__ottKioskV1);
    assert.equal(saved.folder.id, "folder-1");
    assert.equal(saved.channel.id, "c");
    const restored = rig(r.storage);
    restored.w.__ottActiveProviderDriver = { id: "offline" };
    restored.source("offline:device");
    restored.w.channels = r.w.channels;
    assert.equal(restored.kiosk.allowed("c"), true);
    assert.equal(restored.kiosk.allowed("b"), false);
    restored.source("offline:another-profile");
    assert.equal(restored.kiosk.allowed("c"), false);
    assert.equal(restored.kiosk.folderNext("c", ["a", "c"]), null);
    r.w.channels.d = {
        __ottLocalSource: "folder-3",
        __ottLocalSourceName: "Winnie",
        channel_name: "Ambiguous",
    };
    r.w.cList.push("d");
    sources.push({ id: "folder-3", kind: "folder", name: "Winnie" });
    assert.equal(
        r.request({ mode: "set", query: "folder:Winnie" }).status,
        "rejected"
    );
    assert.equal(
        r.kiosk.snapshot().channel.id,
        "c",
        "failed selection keeps the current policy"
    );
    assert.equal(
        r.request({ mode: "set", query: "folder:missing" }).status,
        "rejected"
    );
}
console.log(
    "PASS strict local-folder membership, wrapping, persistence, ambiguity and source isolation"
);
async function testFolderRecovery() {
    const r = rig();
    r.w.__ottActiveProviderDriver = { id: "offline" };
    r.source("offline:device");
    r.w.channels.a.__ottLocalSource = "folder-1";
    r.w.channels.a.__ottLocalSourceName = "Winnie";
    r.w.channels.c = {
        __ottLocalSource: "folder-1",
        __ottLocalSourceName: "Winnie",
        channel_name: "Last",
    };
    r.w.cats.all = r.w.cList = r.w.curList = ["a", "b", "c"];
    r.w.__ottLocalMedia = {
        completedSources: () => [
            { id: "folder-1", kind: "folder", name: "Winnie" },
        ],
    };
    r.request({ mode: "on", query: "folder:Winnie", strict: true });
    delete r.w.channels.a;
    let scanning = true;
    r.w.__ottLocalMedia = {
        snapshot: () =>
            scanning ? Promise.reject(Error("scanning")) : Promise.resolve({}),
    };
    const flush = () => new Promise((resolve) => setImmediate(resolve));
    const before = r.played.length;
    r.advance(10);
    await flush();
    assert.equal(
        r.played.length,
        before,
        "partial scan cannot replace saved file"
    );
    scanning = false;
    r.advance(10);
    await flush();
    assert.equal(r.played.at(-1), "c", "completed scan recovers within folder");
    assert.equal(JSON.parse(r.storage.__ottKioskV1).channel.id, "c");
    delete r.w.channels.c;
    const recovered = r.played.length;
    r.advance(10);
    await flush();
    assert.equal(
        r.played.length,
        recovered,
        "empty folder cannot play outside entry"
    );
    r.w.channels.c = {
        __ottLocalSource: "folder-1",
        channel_name: "Last",
    };
    let finish;
    r.w.__ottLocalMedia.snapshot = () =>
        new Promise((resolve) => {
            finish = resolve;
        });
    delete r.w.channels.c;
    r.advance(10);
    await flush();
    r.source("offline:other-profile");
    r.w.channels.c = { __ottLocalSource: "folder-1" };
    finish({});
    await flush();
    assert.equal(
        r.played.length,
        recovered,
        "late recovery cannot cross profile"
    );
    console.log(
        "PASS folder recovery waits for complete scan and stays source-scoped"
    );
}
async function testEarlyMissingFolderRecovery() {
    const r = rig();
    r.w.__ottActiveProviderDriver = { id: "offline" };
    r.source("offline:device");
    r.w.channels.a.__ottLocalSource = "folder-1";
    r.w.channels.a.__ottLocalSourceName = "Winnie";
    r.w.channels.c = { __ottLocalSource: "folder-1", channel_name: "Next" };
    r.w.cats.all = r.w.cList = r.w.curList = ["a", "b", "c"];
    r.w.__ottLocalMedia = {
        completedSources: () => [
            { id: "folder-1", kind: "folder", name: "Winnie" },
        ],
    };
    r.request({ mode: "on", query: "folder:Winnie", strict: true });
    delete r.w.channels.a;
    let probes = 0;
    r.w.__ottLocalMedia = {
        preferredState: (id) => {
            assert.equal(id, "a");
            return "missing";
        },
        snapshot: () => {
            probes++;
            return Promise.reject(Error("still scanning"));
        },
    };
    r.advance(10);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
        r.played.at(-1),
        "c",
        "confirmed missing saved file recovers during partial scan"
    );
    assert.equal(
        probes,
        0,
        "early recovery does not wait for a complete snapshot"
    );
    assert.equal(JSON.parse(r.storage.__ottKioskV1).channel.id, "c");
    console.log(
        "PASS confirmed missing folder item recovers early within its captured source"
    );
}
testEarlyMissingFolderRecovery().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
testFolderRecovery().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
{
    const r = rig();
    r.w.__ottActiveProviderDriver = { id: "offline" };
    r.source("offline:device");
    Object.assign(r.w.channels.a, {
        __ottLocalSource: "folder-1",
        __ottLocalSourceName: "Winnie",
    });
    let sources = null;
    r.w.__ottLocalMedia = { completedSources: () => sources };
    const bind = () =>
        r.request({ mode: "on", query: "folder:Winnie", strict: true });
    assert.equal(
        bind().status,
        "rejected",
        "partial catalog cannot authorize folder"
    );
    assert.equal(r.kiosk.enabled(), false);
    sources = [
        { id: "folder-1", kind: "folder", name: "Winnie" },
        { id: "folder-empty", kind: "folder", name: "wInNiE" },
    ];
    assert.equal(
        bind().status,
        "rejected",
        "empty same-name folder is still ambiguous"
    );
    assert.equal(r.kiosk.enabled(), false);
    sources.pop();
    assert.equal(bind().status, "ok");
    assert.equal(r.kiosk.snapshot().folder.total, 1);
    assert.equal(r.kiosk.allowed("b"), false);
}
console.log(
    "PASS folder binding waits for full catalog and rejects empty duplicate sources"
);
