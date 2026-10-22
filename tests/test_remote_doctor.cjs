const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const acorn = require("acorn");
const { JSDOM } = require("jsdom");

const output = ts.transpileModule(
    fs.readFileSync("src/plugins/remote-doctor.ts", "utf8"),
    {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES5,
        },
    }
).outputText;
acorn.parse(output, { ecmaVersion: 5 });
const exported = {};
let wallNow = 1800000000000;
vm.runInNewContext(output, {
    Date: { now: () => wallNow },
    exports: exported,
});
const collect = exported.collectRemoteDoctor;
const plain = (value) => JSON.parse(JSON.stringify(value));
const secret = "https://secret.example/video?token=NEVER-EXPORT-ME";
let groups = 0;
function test(name, run) {
    run();
    groups++;
    console.log("ok - " + name);
}
function fixture() {
    const dom = new JSDOM(`<!doctype html><html><body>
        <div id="videoParent"><video id="video"></video></div>
        <video id="videopip" style="display:none"></video>
        <div id="list"><div id="listAbout" style="display:none"></div>
        <div id="listEdit" style="display:none"><input id="privateField"></div>
        <div id="listPopUp" style="display:none"></div></div>
        <div id="numprog" style="display:none"></div>
        <div id="dialogbox" style="display:none"></div>
        <div id="pin" style="display:none"></div>
        <div id="launch" style="display:none"></div><div id="info1"></div>
        </body></html>`);
    const w = dom.window;
    const state = {
        build: {
            buildId: "10351",
            sourceRevision: "a".repeat(40),
            version: "1.1.53-beta.6",
        },
        capabilities: [
            {
                name: "screenshot",
                reason: "source_selection_required",
                state: "unavailable",
            },
            { name: "diagnostics", reason: "ready", state: "available" },
        ],
        generation: 9,
        lane: { duration: 90, id: 7, phase: "playing", position: 12.5 },
        owner: null,
        phase: "playing",
        pip: null,
        revision: 4,
        runtime: "boot.runtime-1",
        target: { kind: "vod", payload: { token: secret }, sourceId: secret },
    };
    const reads = [];
    const readers = {
        readCapabilities: () => {
            reads.push("capabilities");
            return state.capabilities;
        },
        readIdentity: () => {
            reads.push("identity");
            return state;
        },
        readLane: (lane) => {
            reads.push("lane:" + lane);
            return lane === "main" ? state.lane : state.pip;
        },
        readPlayback: () => {
            reads.push("playback");
            return state;
        },
        readUI: () => {
            reads.push("ui");
            return state;
        },
    };
    for (const el of w.document.querySelectorAll("div, video"))
        el.getBoundingClientRect = () => ({
            height: 720,
            left: 0,
            top: 0,
            width: 1280,
        });
    const media = w.document.getElementById("video");
    Object.defineProperties(media, {
        ended: { configurable: true, value: false },
        networkState: { configurable: true, value: 2 },
        paused: { configurable: true, value: false },
        readyState: { configurable: true, value: 4 },
        videoHeight: { configurable: true, value: 1080 },
        videoWidth: { configurable: true, value: 1920 },
    });
    Object.defineProperty(w.document, "visibilityState", {
        configurable: true,
        value: "visible",
    });
    w.document.hasFocus = () => true;
    let time = 1;
    w.performance.now = () => time++;
    return { dom, media, readers, reads, state, w };
}
function onlyKeys(value, keys) {
    assert.deepEqual(Object.keys(value).sort(), keys.split(" ").sort());
}

test("fixed schema projects owned media without model, URL or credentials", () => {
    const f = fixture();
    Object.defineProperty(f.state.target, "payload", {
        get() {
            throw new Error(secret);
        },
    });
    Object.defineProperty(f.media, "currentSrc", {
        get() {
            throw new Error(secret);
        },
    });
    f.state.owner = { id: 6, kind: "editor" };
    Object.defineProperty(f.state.owner, "model", {
        get() {
            throw new Error(secret);
        },
    });
    const result = plain(collect(f.w, f.readers));
    onlyKeys(
        result,
        "version runtime capturedAt collectionMs consistent build ui media capabilities reasons"
    );
    onlyKeys(result.build, "version sourceRevision buildId identity");
    onlyKeys(
        result.ui,
        "documentVisibility documentFocused owner revision panes focus"
    );
    onlyKeys(result.media, "generation kind phase lanes displayEvidence");
    onlyKeys(
        result.media.lanes[0],
        "lane handleId phase position duration video"
    );
    onlyKeys(
        result.media.lanes[0].video,
        "exists cssVisible rect paused ended readyState networkState videoWidth videoHeight"
    );
    assert.equal(result.version, 1);
    assert.equal(result.runtime, "boot.runtime-1");
    assert.equal(result.build.identity, "embedded");
    assert.equal(result.consistent, true);
    assert.equal(result.collectionMs, 1);
    assert.equal(result.media.generation, 9);
    assert.equal(result.media.kind, "vod");
    assert.equal(result.media.lanes[0].handleId, 7);
    assert.equal(result.media.lanes[0].position, 12.5);
    assert.equal(result.media.displayEvidence, "unavailable");
    assert.ok(result.reasons.includes("physical_display_unverified"));
    assert.ok(result.reasons.includes("owned_overlay_open"));
    assert.equal(result.reasons.includes("producer_failed"), false);
    assert.equal(JSON.stringify(result).includes("secret"), false);
    assert.equal(JSON.stringify(result).includes("NEVER-EXPORT"), false);
    f.dom.window.close();
});

test("read-only collection calls no transport, storage, timers or sampling", () => {
    const f = fixture();
    const fail = () => {
        throw new Error("forbidden effect");
    };
    Object.assign(f.w, {
        __ottCoreBackend: fail,
        fetch: fail,
        requestAnimationFrame: fail,
        setInterval: fail,
        setTimeout: fail,
        stbPlay: fail,
        stbStop: fail,
    });
    Object.assign(f.state.lane, { sample: fail, seek: fail, toJSON: fail });
    Object.defineProperty(f.w, "localStorage", { get: fail });
    const result = collect(f.w, f.readers);
    assert.equal(result.consistent, true);
    assert.equal(result.reasons.includes("producer_failed"), false);
    assert.deepEqual(f.reads, [
        "identity",
        "ui",
        "playback",
        "lane:main",
        "lane:pip",
        "capabilities",
        "ui",
        "playback",
        "identity",
        "lane:main",
        "lane:pip",
    ]);
    f.dom.window.close();
});

test("an overlay is observed without claiming occlusion or a physical frame", () => {
    const f = fixture();
    f.state.owner = { id: 8, kind: "dialog" };
    f.w.document.getElementById("dialogbox").style.display = "block";
    const result = collect(f.w, f.readers);
    assert.equal(result.media.phase, "playing");
    assert.equal(result.media.lanes[0].video.cssVisible, true);
    assert.equal(
        result.ui.panes.find((x) => x.kind === "dialog").cssVisible,
        true
    );
    assert.ok(result.reasons.includes("owned_overlay_open"));
    assert.equal(result.reasons.includes("video_css_hidden"), false);
    assert.equal(result.media.displayEvidence, "unavailable");
    assert.equal(JSON.stringify(result).includes("healthy"), false);
    f.dom.window.close();
});

test("video CSS includes hidden ancestors but visibility overrides remain valid", () => {
    const f = fixture();
    const parent = f.w.document.getElementById("videoParent");
    parent.style.display = "none";
    assert.ok(collect(f.w, f.readers).reasons.includes("video_css_hidden"));
    parent.style.display = "block";
    parent.style.opacity = "0";
    assert.equal(
        collect(f.w, f.readers).media.lanes[0].video.cssVisible,
        false
    );
    parent.style.opacity = "1";
    parent.style.visibility = "hidden";
    f.media.style.visibility = "visible";
    assert.equal(collect(f.w, f.readers).media.lanes[0].video.cssVisible, true);
    f.media.getBoundingClientRect = () => ({
        height: 0,
        left: 0,
        top: 0,
        width: 0,
    });
    assert.ok(collect(f.w, f.readers).reasons.includes("video_zero_rect"));
    f.dom.window.close();
});

test("focus is a fixed area, never a field name, input value or caption", () => {
    const f = fixture();
    const editor = f.w.document.getElementById("listEdit");
    editor.style.display = "block";
    const input = f.w.document.getElementById("privateField");
    input.value = secret;
    input.focus();
    let result = collect(f.w, f.readers);
    assert.equal(result.ui.focus, "editor");
    assert.equal(JSON.stringify(result).includes("privateField"), false);
    assert.equal(JSON.stringify(result).includes(secret), false);
    const other = f.w.document.createElement("input");
    other.id = secret;
    f.w.document.body.appendChild(other);
    other.focus();
    result = collect(f.w, f.readers);
    assert.equal(result.ui.focus, "other");
    f.dom.window.close();
});

test("runtime, UI revision, playback generation and decoder replacement invalidate consistency", () => {
    for (const change of [
        (s) => {
            s.runtime = "boot.runtime-2";
        },
        (s) => {
            s.revision++;
        },
        (s) => {
            s.generation++;
        },
        (s) => {
            s.lane.id++;
        },
    ]) {
        const f = fixture();
        f.readers.readCapabilities = () => {
            change(f.state);
            return f.state.capabilities;
        };
        const result = collect(f.w, f.readers);
        assert.equal(result.consistent, false);
        assert.ok(result.reasons.includes("state_changed_during_snapshot"));
        f.dom.window.close();
    }
});

test("missing or throwing producers give bounded unknown evidence without leaking errors", () => {
    let result = plain(collect({}, {}));
    assert.equal(result.consistent, false);
    assert.equal(result.runtime, "unknown");
    assert.equal(result.build.identity, "partial");
    assert.equal(result.ui.documentVisibility, "unknown");
    assert.equal(result.media.generation, null);
    assert.ok(result.reasons.includes("producer_unavailable"));
    assert.ok(result.reasons.includes("build_identity_partial"));
    const f = fixture();
    for (const name of Object.keys(f.readers))
        f.readers[name] = () => {
            throw new Error(secret);
        };
    f.w.getComputedStyle = () => {
        throw new Error(secret);
    };
    result = plain(collect(f.w, f.readers));
    assert.ok(result.reasons.includes("producer_failed"));
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(result.ui.panes.length, 8);
    assert.equal(result.media.lanes.length, 2);
    f.dom.window.close();
});

test("invalid primitives, secret handle IDs and arbitrary capabilities are rejected", () => {
    const f = fixture();
    Object.assign(f.state, {
        generation: NaN,
        owner: { id: -1, kind: secret },
        revision: 0.5,
        runtime: secret,
    });
    f.state.build = {
        buildId: secret,
        sourceRevision: "bad",
        version: "v".repeat(65),
    };
    f.state.lane = {
        duration: Infinity,
        id: secret,
        phase: secret,
        position: -1,
    };
    f.state.target.kind = secret;
    f.media.getBoundingClientRect = () => ({
        height: 720,
        left: Infinity,
        top: 0,
        width: 1280,
    });
    Object.defineProperty(f.media, "readyState", { value: 99 });
    f.state.capabilities = [
        { name: secret, reason: "ready", state: "available" },
        { name: "screenshot", reason: "ready", state: "unavailable" },
        { name: "input", reason: "policy_restricted", state: "available" },
        { name: "input", reason: "policy_restricted", state: "unavailable" },
        { name: "input", reason: "ready", state: "available" },
    ];
    const result = plain(collect(f.w, f.readers));
    assert.equal(result.runtime, "unknown");
    assert.equal(result.media.lanes[0].handleId, null);
    assert.equal(result.media.lanes[0].video.rect, null);
    assert.equal(result.media.lanes[0].video.readyState, null);
    assert.equal(result.media.lanes[0].position, null);
    assert.equal(result.media.lanes[0].duration, null);
    assert.equal(result.media.kind, "unknown");
    assert.deepEqual(result.capabilities, [
        { name: "input", reason: "policy_restricted", state: "unavailable" },
    ]);
    assert.ok(result.reasons.includes("invalid_sample"));
    assert.equal(JSON.stringify(result).includes(secret), false);
    f.dom.window.close();
});

test("unknown capture support and absent HTML video are not fake frame evidence", () => {
    const f = fixture();
    f.media.remove();
    f.state.capabilities = [
        { name: "screenshot", reason: "not_implemented", state: "unavailable" },
    ];
    const result = collect(f.w, f.readers);
    assert.ok(result.reasons.includes("video_element_missing"));
    assert.equal(result.media.lanes[0].phase, "playing");
    assert.equal(result.media.lanes[0].video.exists, false);
    assert.equal(result.media.displayEvidence, "unavailable");
    assert.equal(result.capabilities[0].reason, "not_implemented");
    f.dom.window.close();
});

test("observed paused/ended/not-ready and hidden document have separate reason codes", () => {
    const f = fixture();
    Object.defineProperty(f.w.document, "visibilityState", { value: "hidden" });
    f.w.document.hasFocus = () => false;
    Object.defineProperties(f.media, {
        ended: { value: true },
        paused: { value: true },
        readyState: { value: 1 },
    });
    const result = collect(f.w, f.readers);
    for (const code of [
        "document_hidden",
        "document_unfocused",
        "decoder_not_ready",
        "decoder_paused",
        "decoder_ended",
    ])
        assert.ok(result.reasons.includes(code));
    assert.equal(JSON.stringify(result).includes("stalled"), false);
    f.dom.window.close();
});

test("maximum legal payload stays below 8 KiB; input lengths never drive traversal", () => {
    const f = fixture();
    f.state.runtime = "r".repeat(96);
    f.state.build.version = "v".repeat(64);
    f.state.build.buildId = "b".repeat(96);
    f.state.revision = Number.MAX_SAFE_INTEGER;
    f.state.generation = Number.MAX_SAFE_INTEGER;
    f.state.owner = { id: Number.MAX_SAFE_INTEGER, kind: "editor" };
    f.state.lane = {
        duration: 315576000,
        id: Number.MAX_SAFE_INTEGER,
        phase: "playing",
        position: 315576000,
    };
    f.state.pip = f.state.lane;
    f.state.capabilities = [
        "screenshot",
        "diagnostics",
        "input",
        "restart_stream",
        "reload_player",
        "restart_app",
        "exit_app",
        "reboot_device",
        "standby",
        "wake",
    ].map((name) => ({
        name,
        reason: "current_state_unsupported",
        state: "unavailable",
    }));
    // A poisoned eleventh entry must never be inspected.
    Object.defineProperty(f.state.capabilities, "10", {
        get() {
            throw new Error(secret);
        },
    });
    f.state.capabilities.length = 1000000;
    const result = plain(collect(f.w, f.readers));
    const serialized = JSON.stringify(result);
    assert.ok(Buffer.byteLength(serialized, "utf8") <= 8192);
    assert.equal(result.capabilities.length, 10);
    assert.equal(result.ui.panes.length, 8);
    assert.equal(result.media.lanes.length, 2);
    assert.ok(result.reasons.length <= 16);
    assert.equal(new Set(result.reasons).size, result.reasons.length);
    assert.equal(result.reasons.includes("producer_failed"), false);
    assert.equal(serialized.includes("secret"), false);
    f.dom.window.close();
});

test("unknown wall-clock time cannot claim a consistent timed observation", () => {
    const f = fixture();
    for (const value of [-1, 0, NaN, Infinity, undefined]) {
        wallNow = value;
        const result = collect(f.w, f.readers);
        assert.equal(result.capturedAt, 0);
        assert.equal(result.consistent, false);
        assert.ok(result.reasons.includes("invalid_sample"));
    }
    wallNow = 1800000000000;
    assert.equal(collect(f.w, f.readers).consistent, true);
    f.dom.window.close();
});

test("unavailable timing and bounded ancestry do not block snapshot completion", () => {
    const f = fixture();
    f.w.performance.now = () => NaN;
    let reads = 0;
    const node = {
        getBoundingClientRect: () => ({ height: 1, left: 0, top: 0, width: 1 }),
    };
    node.parentElement = node;
    f.w.document.getElementById = () => node;
    f.w.getComputedStyle = () => {
        reads++;
        return { display: "block", opacity: "1", visibility: "visible" };
    };
    const result = collect(f.w, f.readers);
    assert.equal(result.collectionMs, null);
    assert.equal(result.media.lanes[0].video.cssVisible, null);
    assert.ok(reads <= 320);
    f.dom.window.close();
});

test("identity rejects trailing newlines; projection reads changing properties only once", () => {
    const f = fixture();
    f.state.runtime = "safe\n";
    f.state.build.sourceRevision = "a".repeat(40) + "\n";
    let result = collect(f.w, f.readers);
    assert.equal(result.runtime, "unknown");
    assert.equal(result.build.sourceRevision, null);
    const reads = { name: 0, reason: 0, state: 0, visibility: 0 };
    const capability = {};
    for (const [key, value] of Object.entries({
        name: "input",
        reason: "ready",
        state: "available",
    }))
        Object.defineProperty(capability, key, {
            get() {
                return reads[key]++ === 0 ? value : secret;
            },
        });
    f.state.capabilities = [capability];
    Object.defineProperty(f.w.document, "visibilityState", {
        get() {
            return reads.visibility++ === 0 ? "visible" : secret;
        },
    });
    result = plain(collect(f.w, f.readers));
    assert.deepEqual(result.capabilities, [
        { name: "input", reason: "ready", state: "available" },
    ]);
    assert.equal(result.ui.documentVisibility, "visible");
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.deepEqual(reads, { name: 1, reason: 1, state: 1, visibility: 1 });
    f.state.build.version = "1.1.53-beta.6+plex-arrows";
    f.state.build.sourceRevision = "a".repeat(40);
    result = collect(f.w, f.readers);
    assert.equal(result.build.version, "1.1.53-beta.6+plex-arrows");
    assert.equal(result.build.identity, "embedded");
    f.dom.window.close();
});

console.log("PASS remote doctor: " + groups + " groups");
