const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const includeCore = require("./helpers/shared-core-runtime.cjs");
const sourcePath = path.resolve(__dirname, "../src/channels/index.ts");
const source = ts.createSourceFile(
    sourcePath,
    fs.readFileSync(sourcePath, "utf8"),
    ts.ScriptTarget.Latest,
    true
);
const names = ["selectEpg", "showPlaybackSeekDialog"];
const functions = source.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)
);
assert.equal(functions.length, names.length);
const code = ts
    .transpileModule(functions.map((node) => node.getText(source)).join("\n"), {
        compilerOptions: {
            module: ts.ModuleKind.ES2015,
            target: ts.ScriptTarget.ES5,
        },
    })
    .outputText.replace(/^export /gm, "");

function fixture(pin = false) {
    const calls = [],
        prompts = [],
        timers = [],
        stored = {};
    let now = 1000000;
    const row = {
        name: "Selected programme",
        time: now - 60,
        time_to: now + 60,
    };
    const chain = {
        hide() {
            calls.push(["hide"]);
            return chain;
        },
        html() {
            return chain;
        },
        show() {
            return chain;
        },
    };
    const c = {
        _: (value) => value,
        $: () => chain,
        catIndex: 0,
        cats: { All: [11, 22] },
        catsArray: ["All"],
        channels: { 11: { rec: 1 }, 22: { rec: 24 } },
        clearTimeout() {},
        closeList: () => calls.push(["close"]),
        console,
        Date: class extends Date {
            static now() {
                return now * 1000;
            }
        },
        document: { getElementById: () => ({ innerHTML: "" }) },
        epg_ch_id: 11,
        ifParentalAccessChId: (id, callback) => {
            if (pin) prompts.push(callback);
            return pin;
        },
        keys: { DOWN: 40, ENTER: 13, EXIT: 27, RETURN: 8, UP: 38 },
        listArray: [row],
        listCatIndex: 0,
        listChannel: 0,
        listEpgArray: [row],
        medHistory: [],
        p_pref: "archive-entrypoint",
        playArchive: (epoch) => calls.push(["archive", epoch]),
        playTime: 0,
        playType: 0,
        prevArr: [],
        primaryIndex: 0,
        providerGetItem: (key) => stored[key],
        providerSetItem: (key, value) => {
            stored[key] = value;
        },
        selIndex: 0,
        setCurrent: (category, index) =>
            calls.push(["select", category, index]),
        setTimeout: (callback, delay) => {
            timers.push({ callback, delay });
            return timers.length;
        },
        settings: { prevCount: 2 },
        shiftArchive: (delta) => calls.push(["seek", delta]),
        stbGetLen: () => 100,
        stbGetPosTime: () => 0,
    };
    c.curList = c.cats.All;
    c.window = c;
    vm.createContext(c);
    includeCore(c);
    vm.runInContext(code, c, { filename: sourcePath });
    require("./helpers/guide-runtime-fixture.cjs").install(c);
    c.getChannelEpg = (id, callback) => callback(id, [row]);
    c.metadataText = (value) => String(value || "");
    c.showPage = () => {};
    c.infoBox = () => {};
    c.epgList(0, 0, false);
    timers[0].callback();
    timers.length = 0;
    calls.length = 0;
    c.__ottClassicPlayback.command({ channelId: 11, type: "live" });
    c.__ottClassicPlayback.command({ type: "playing" });
    return {
        advance: (seconds) => {
            now += seconds;
        },
        c,
        calls,
        prompts,
        timers,
    };
}
function playbackCalls(f) {
    return f.calls.filter((row) => row[0] === "archive" || row[0] === "seek");
}
for (const pin of [false, true]) {
    const f = fixture(pin);
    f.c.selectEpg();
    if (pin) {
        assert.equal(f.prompts.length, 1);
        f.prompts[0]();
        f.prompts[0]();
    }
    assert.deepEqual(playbackCalls(f), [["archive", 999940]]);
    assert.deepEqual(
        f.calls.filter((row) => row[0] === "select"),
        [["select", 0, 0]]
    );
}
const mutations = {
    "channel revoked": (f) => {
        f.c.channels[11].rec = 0;
    },
    "explicit cancel": (f) => {
        f.c.__ottClassicPlayback.cancel();
    },
    "new row": (f) => {
        f.c.listArray = [{ time: 999930 }];
    },
    "new selection": (f) => {
        f.c.selIndex = 1;
    },
    "playing selection changed": (f) => {
        f.c.__ottClassicPlayback.command({ channelId: 22, type: "live" });
    },
    "programme expired": (f) => {
        f.advance(3600);
    },
    "same-ID catalog replacement": (f) => {
        f.c.channels = { 11: { rec: 1 } };
    },
    "source changed": (f) => {
        f.c.p_pref = "replacement";
    },
    "stopped session": (f) => {
        f.c.__ottClassicPlayback.command({ type: "stop" });
    },
};
// Compatibility projections and row reordering cannot change the accepted identity.
for (const mutate of [
    (f) => f.c.cats.All.reverse(),
    (f) => {
        f.c.listEpgArray = [];
    },
    (f) => {
        f.c.listArray[0].time--;
    },
]) {
    const f = fixture(true);
    f.c.selectEpg();
    mutate(f);
    f.prompts[0]();
    assert.deepEqual(playbackCalls(f), [["archive", 999940]]);
    assert.deepEqual(
        f.calls.filter((row) => row[0] === "select"),
        [["select", 0, f.c.cats.All.indexOf(11)]],
        "Re-resolve the authorized channel after projection changes"
    );
}
for (const [name, mutate] of Object.entries(mutations)) {
    const f = fixture(true);
    f.c.selectEpg();
    mutate(f);
    f.prompts[0]();
    assert.deepEqual(
        f.calls,
        [],
        "Retired PIN selection must be inert: " + name
    );
}
{
    const f = fixture();
    f.c.showPlaybackSeekDialog(10);
    const first = f.timers[0];
    f.c.dialogBoxKeyHandler(f.c.keys.UP);
    const last = f.timers.at(-1);
    assert.equal(last.delay, 3000);
    first.callback();
    assert.deepEqual(playbackCalls(f), [], "Cleared timer cannot submit early");
    last.callback();
    first.callback();
    assert.deepEqual(
        playbackCalls(f),
        [["seek", 70]],
        "Only one accumulated seek"
    );
}
for (const action of [
    "enter",
    "return",
    "stop",
    "cancel",
    "catalog",
    "source",
    "replacement dialog",
]) {
    const f = fixture();
    f.c.showPlaybackSeekDialog(10);
    const delayed = f.timers[0];
    if (action === "enter") f.c.dialogBoxKeyHandler(f.c.keys.ENTER);
    if (action === "return") f.c.dialogBoxKeyHandler(f.c.keys.RETURN);
    if (action === "stop") f.c.__ottClassicPlayback.command({ type: "stop" });
    if (action === "cancel") f.c.__ottClassicPlayback.cancel();
    if (action === "catalog") f.c.channels = { 11: { rec: 24 } };
    if (action === "source") f.c.p_pref = "replacement";
    if (action === "replacement dialog") f.c.dialogBoxKeyHandler = () => {};
    const hides = f.calls.filter((row) => row[0] === "hide").length;
    delayed.callback();
    assert.deepEqual(
        playbackCalls(f),
        action === "enter" ? [["seek", 10]] : [],
        action
    );
    if (["stop", "catalog", "source", "replacement dialog"].includes(action))
        assert.equal(
            f.calls.filter((row) => row[0] === "hide").length,
            hides,
            "No stale dialog mutation: " + action
        );
}
{
    const f = fixture();
    f.c.showPlaybackSeekDialog(10);
    const old = f.timers[0];
    f.c.showPlaybackSeekDialog(20);
    old.callback();
    assert.deepEqual(f.calls, [], "Old dialog cannot hide the replacement");
    f.timers.at(-1).callback();
    assert.deepEqual(playbackCalls(f), [["seek", 20]]);
}
console.log(
    "PASS archive entrypoints: captured PIN selection/expiry and one-shot source-bound seek dialogs (22 scenarios)"
);
