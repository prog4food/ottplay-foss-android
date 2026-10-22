const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const acorn = require("acorn");
const { JSDOM } = require("jsdom");
const runtime = require("./helpers/private-runtime.cjs");
const root = path.resolve(__dirname, "..");

function functions(file, names) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const selected = ast.statements.filter(
        (node) =>
            ts.isFunctionDeclaration(node) && names.includes(node.name.text)
    );
    assert.equal(selected.length, names.length);
    const code = ts.transpileModule(
        selected
            .map((node) => node.getText(ast).replace(/^export /, ""))
            .join("\n"),
        {
            compilerOptions: {
                module: ts.ModuleKind.None,
                target: ts.ScriptTarget.ES5,
            },
        }
    ).outputText;
    acorn.parse(code, { ecmaVersion: 5 });
    return code;
}

const channelCode = functions("src/channels/index.ts", [
    "onChannelsLoaded",
    "channelPreferenceTarget",
    "getChannelPreference",
    "captureChannelPreference",
    "applyChannelPreference",
    "saveChannelPreference",
]);
const coreCode = functions("src/core/index.ts", [
    "setAspect",
    "captureAspectTarget",
    "applyAspectRatio",
    "stbToggleAspectRatio",
    "applyZoom",
    "setZoom",
]);

function fixture({ durable = new Map(), mediaOnly = false } = {}) {
    const dom = new JSDOM('<div id="vdiv"><video id="video"></video></div>');
    const video = dom.window.document.getElementById("video");
    Object.defineProperties(video, {
        videoHeight: { value: 1080 },
        videoWidth: { value: 1920 },
    });
    const session = new Map(durable);
    let source = "plex@account-one",
        failure = "",
        writes = 0,
        menuChoice = 0;
    let owner = { active: () => true };
    const host = {
        _: (text) => text,
        __ottSourceIdentity: { current: () => source },
        $(selector) {
            return {
                css(styles) {
                    for (const element of host.document.querySelectorAll(
                        selector
                    ))
                        for (const [key, value] of Object.entries(styles))
                            element.style.setProperty(key, String(value));
                },
                hide() {},
            };
        },
        aspectGeneration: 0,
        aspectRatio: 0,
        catIndex: 0,
        channels: mediaOnly
            ? {}
            : {
                  11: {
                      category: { name: "TV" },
                      channel_name: "First",
                      itemId: "first",
                  },
                  12: {
                      category: { name: "TV" },
                      channel_name: "Second",
                      itemId: "second",
                  },
              },
        cList: mediaOnly ? [] : [11, 12],
        console: {
            error(error) {
                throw error;
            },
            log() {},
        },
        coreMediaBackend: { current: () => owner },
        curList: mediaOnly ? [] : [11, 12],
        document: dom.window.document,
        favoritesArray: [],
        innerHeight: 800,
        innerWidth: 1280,
        isFullscreen: true,
        playType: mediaOnly ? -1e11 : 0,
        primaryIndex: 0,
        providerGetItem: (key) => session.get(key) ?? null,
        providerGetPersistedItem: (key) => durable.get(key) ?? null,
        providerSetItem(key, value) {
            writes++;
            if (failure === "throw") throw Error("storage full");
            session.set(key, value);
            if (failure !== "memory") durable.set(key, value);
        },
        settings: {},
        sFavorites: false,
        showSelectBox(_current, _labels, callback) {
            callback(menuChoice);
        },
        video,
        zoomLevel: 0,
        zoomScales: [1, 1.25, 1.5, 1.75],
    };
    host.stbPlay = function () {};
    host.__ottCoreTransport = { play: host.stbPlay };
    host.window = host;
    vm.createContext(host);
    runtime(host, "src/channels/library.ts");
    runtime(host, "src/channels/classic-library.ts");
    vm.runInContext(channelCode + "\n" + coreCode, host);
    if (mediaOnly) {
        host.__ottActiveProviderDriver = {
            capabilities: { libraryOnly: true },
            id: "plex",
            libraryReady: () => true,
        };
        host.providerMediaClient = {};
        host.getMediaArray = () => {};
        host.__ottMedia = {
            restoreLast() {
                host.playType = -1e11;
                return true;
            },
            sourceId: () => source,
            useSource() {},
        };
        host.onChannelsLoaded();
    } else host.__ottChannels.mount(host);
    return {
        durable,
        fail: (mode) => {
            failure = mode;
        },
        host,
        local(mode) {
            menuChoice = mode;
            host.stbToggleAspectRatio();
        },
        owner: () => {
            owner = { active: () => true };
        },
        restore() {
            host.applyChannelPreference("aAspects", host.setAspect);
        },
        session,
        source: (next) => {
            source = next;
        },
        writes: () => writes,
    };
}

let f = fixture();
let { host: w } = f;
let writes = f.writes();
let capture = w.captureAspectTarget();
assert.equal(capture.mode, "fit");
assert.equal(capture.savedMode, null);
assert.equal(capture.current(), true);
assert.equal(
    f.writes(),
    writes,
    "reading aspect never writes or mounts storage"
);
assert.equal(capture.set("fill"), true);
assert.equal(w.captureAspectTarget().mode, "fill");
assert.equal(w.captureAspectTarget().savedMode, "fill");
assert.equal(w.video.style.width, "1422px");
assert.equal(w.video.style.height, "800px");
assert.equal(
    w.video.style.left,
    "-71px",
    "cover crops equally without stretch"
);
assert.equal(capture.current(), false, "applied ticket cannot be reused");
capture = w.captureAspectTarget();
assert.equal(capture.set("fit"), true);
assert.equal(w.video.style.width, "1280px");
assert.equal(w.video.style.height, "720px");

for (const value of [
    "cover",
    "contain",
    "Fill screen",
    "FILL",
    "",
    1,
    0,
    null,
    undefined,
]) {
    writes = f.writes();
    assert.equal(w.captureAspectTarget().set(value), false);
    assert.equal(
        f.writes(),
        writes,
        "invalid mode is rejected before persistence"
    );
}

for (const change of [
    (rig) => {
        rig.host.primaryIndex = 1;
    },
    (rig) => rig.source("plex@different-account"),
    (rig) => rig.host.__ottChannels.mount(rig.host),
    (rig) => rig.owner(),
    (rig) => rig.local(1),
    (rig) => rig.host.video.remove(),
    (rig) => {
        rig.host.stbPlay = function legacyDecoder() {};
    },
    (rig) => {
        rig.host.stbPlay = rig.host.__ottCoreTransport.play =
            function legacyDecoder() {};
    },
]) {
    f = fixture();
    capture = f.host.captureAspectTarget();
    change(f);
    writes = f.writes();
    assert.equal(
        capture.current(),
        false,
        "changed target invalidates deferred command"
    );
    assert.equal(capture.set("fill"), false);
    assert.equal(f.writes(), writes);
}

for (const mode of ["throw", "memory"]) {
    f = fixture();
    w = f.host;
    f.fail(mode);
    assert.equal(w.captureAspectTarget().set("fill"), false);
    assert.equal(w.captureAspectTarget().mode, "fit");
    assert.equal(w.captureAspectTarget().savedMode, null);
    f.restore();
    assert.equal(
        w.captureAspectTarget().mode,
        "fit",
        "failed save cannot leak via canplay"
    );
    f.fail("");
    assert.equal(
        w.captureAspectTarget().set("fill"),
        true,
        "retry writes even if session has bytes already"
    );
    assert.equal(w.captureAspectTarget().savedMode, "fill");
}

f = fixture();
w = f.host;
assert.equal(w.captureAspectTarget().set("fill"), true);
w.primaryIndex = 1;
f.restore();
assert.equal(
    w.captureAspectTarget().mode,
    "fit",
    "unconfigured channel defaults to fit"
);
w.primaryIndex = 0;
f.restore();
assert.equal(
    w.captureAspectTarget().mode,
    "fill",
    "channel preference is isolated"
);
f.durable.delete("channelLibrary:plex@account-one");
assert.equal(
    w.captureAspectTarget().savedMode,
    null,
    "read reports backing storage, not cached preference"
);
for (const corrupt of [
    "{",
    JSON.stringify({ sourceId: "plex@account-one", version: 2 }),
    JSON.stringify({
        groups: [],
        hidden: [],
        locks: [],
        preferences: { aspect: { first: 1 } },
        sourceId: "plex@other-account",
        version: 1,
    }),
]) {
    f.durable.set("channelLibrary:plex@account-one", corrupt);
    assert.equal(w.captureAspectTarget().savedMode, null);
}
f = fixture();
f.host.providerGetPersistedItem = () => {
    throw Error("storage unreadable");
};
f.host.__ottChannels.mount(f.host);
assert.equal(f.host.captureAspectTarget().savedMode, null);
assert.equal(f.host.captureAspectTarget().set("fill"), false);
assert.equal(f.host.captureAspectTarget().mode, "fit");

// Plex has no TV channels: actual libraryOnly startup must mount a preference owner.
f = fixture({ mediaOnly: true });
assert.deepEqual(Array.from(f.host.cList), []);
assert(
    f.host.captureAspectTarget(),
    "media-only provider still supports aspect capture"
);
f.local(1);
assert.equal(f.host.captureAspectTarget().savedMode, "fill");
const restarted = fixture({ durable: f.durable, mediaOnly: true });
restarted.restore();
assert.equal(
    restarted.host.captureAspectTarget().mode,
    "fill",
    "Plex restart restores local menu choice"
);
restarted.owner();
restarted.host.setAspect(0);
restarted.restore();
assert.equal(
    restarted.host.captureAspectTarget().mode,
    "fill",
    "next media uses the shared media preference"
);
assert.equal(restarted.host.captureAspectTarget().set("fit"), true);
assert.equal(restarted.host.captureAspectTarget().savedMode, "fit");

console.log(
    "PASS aspect: ES5, fit/cover geometry, durable writes, target fencing, per-channel and Plex media-only restart"
);
