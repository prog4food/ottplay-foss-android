// Repeated boot uses real DOM events and the actual classic initializer.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const source = ts.createSourceFile(
    "src/core/index.ts",
    fs.readFileSync(path.join(root, "src/core/index.ts"), "utf8"),
    ts.ScriptTarget.Latest,
    true
);
function functions(names) {
    return ts.transpileModule(
        names
            .map((name) => {
                const matches = source.statements.filter(
                    (node) =>
                        ts.isFunctionDeclaration(node) &&
                        node.name.text === name
                );
                assert.equal(
                    matches.length,
                    1,
                    name + " is the real core function"
                );
                return matches[0].getText(source).replace(/^export /, "");
            })
            .join("\n"),
        { compilerOptions: { target: ts.ScriptTarget.ES5 } }
    ).outputText;
}

function fixture() {
    const dom = new JSDOM(
        '<body><div id="launch"></div><div id="buffering"></div>' +
            '<div id="video_res"></div><div id="pip_buffering"></div></body>',
        { runScripts: "outside-only" }
    );
    const w = dom.window;
    w.eval(fs.readFileSync(path.join(root, "js/jquery-1.11.1.min.js"), "utf8"));
    const timers = new Map();
    const callbacks = [];
    const calls = {
        binds: 0,
        capture: 0,
        fullscreen: 0,
        info: 0,
        pip: 0,
        resize: 0,
    };
    const errors = [];
    const preferences = [];
    let timerId = 0,
        asleep = false;
    const show = w.$.fn.show;
    w.$.fn.show = function (...args) {
        if (this[0]?.id === "pip_buffering") calls.pip++;
        return show.apply(this, args);
    };
    Object.assign(w, {
        _: (value) => value,
        __ottStandby: {
            blocked: () => asleep,
            failed: () => errors.push("cleanup failed"),
            isStandby: () => asleep,
            set(value, resume) {
                asleep = value;
                if (!value && resume) resume();
            },
        },
        _standby: false,
        applyAspectRatio() {},
        applyChannelPreference: (name) => preferences.push(name),
        applyZoom() {},
        clearInterval: (id) => timers.delete(id),
        closeList() {},
        coreDeviceEffects: {},
        installTauriFsKeyCapture: () => calls.capture++,
        isFullscreen: false,
        requestAnimationFrame: (fn) => fn(),
        resetCoreNativeBitrate() {},
        setAspect() {},
        setAudioTrack() {},
        setInterval(fn, delay) {
            assert.equal(delay, 1000);
            callbacks.push(fn);
            timers.set(++timerId, fn);
            return timerId;
        },
        setSleepTimeout() {},
        setSubtitleTrack() {},
        setZoom() {},
        showViewportSizeIndicator: () => calls.resize++,
        stbBindKeyHandler: () => calls.binds++,
        stbStop() {},
        stbStopPip() {},
        stbToFullScreen: () => calls.fullscreen++,
        updateCoreVideoInfo: () => calls.info++,
        video: null,
        videoEvent() {},
        videoPip: null,
    });
    w.console.error = (error) => errors.push(String(error));
    w.console.log = () => {};
    w.eval(functions(["stbInit", "stbSetStandby", "stbIsStandby"]));
    w.startPlayer = () => w.stbInit();
    return { callbacks, calls, dom, errors, preferences, timers, w };
}

test("repeated initialization keeps one listener set and timer while refreshing layout/input", () => {
    const f = fixture();
    try {
        for (let i = 0; i < 3; i++) f.w.stbInit();
        assert.equal(f.timers.size, 1);
        assert.equal(f.calls.binds, 3);
        assert.equal(f.calls.fullscreen, 3);
        assert.equal(f.calls.capture, 3);
        f.w.dispatchEvent(new f.w.Event("resize"));
        assert.equal(f.calls.resize, 1);
        f.w.video.dispatchEvent(new f.w.Event("canplay"));
        assert.deepEqual(f.preferences, [
            "aAspects",
            "aZooms",
            "aSubs",
            "aAudios",
        ]);
        assert.equal(f.calls.info, 1);
        f.w.videoPip.style.display = "block";
        f.w.videoPip.dispatchEvent(new f.w.Event("loadstart"));
        assert.equal(f.calls.pip, 1);
        for (const fn of f.callbacks.slice(0, -1)) fn();
        assert.equal(
            f.calls.info,
            1,
            "retired timer callbacks cannot poll media"
        );
        [...f.timers.values()][0]();
        assert.equal(f.calls.info, 2);
        assert.deepEqual(f.errors, []);
    } finally {
        f.dom.window.close();
    }
});

test("replacement video nodes acquire hooks without duplicating global work", () => {
    const f = fixture();
    try {
        f.w.stbInit();
        for (const id of ["video", "videopip"])
            f.w.document
                .getElementById(id)
                .replaceWith(
                    Object.assign(f.w.document.createElement("video"), { id })
                );
        f.w.stbInit();
        f.w.stbInit();
        f.w.video.dispatchEvent(new f.w.Event("canplay"));
        assert.equal(f.preferences.length, 4);
        assert.equal(f.calls.info, 1);
        f.w.videoPip.style.display = "block";
        f.w.videoPip.dispatchEvent(new f.w.Event("loadstart"));
        assert.equal(f.calls.pip, 1);
        f.w.dispatchEvent(new f.w.Event("resize"));
        assert.equal(f.calls.resize, 1);
        assert.equal(f.timers.size, 1);
        assert.deepEqual(f.errors, []);
    } finally {
        f.dom.window.close();
    }
});

test("standby cancels media polling and wake owns one fresh timer for every cycle", () => {
    const f = fixture();
    try {
        f.w.stbInit();
        for (let cycle = 0; cycle < 2; cycle++) {
            const retired = [...f.timers.values()][0];
            f.w.stbSetStandby(true);
            assert.equal(f.timers.size, 0);
            retired();
            assert.equal(f.calls.info, cycle);
            f.w.stbInit();
            assert.equal(
                f.timers.size,
                0,
                "persisted-asleep boot starts no poll"
            );
            f.w.stbSetStandby(false);
            assert.equal(f.timers.size, 1);
            retired();
            assert.equal(
                f.calls.info,
                cycle,
                "old timer remains retired after go"
            );
            [...f.timers.values()][0]();
            assert.equal(f.calls.info, cycle + 1);
        }
        assert.deepEqual(f.errors, []);
    } finally {
        f.dom.window.close();
    }
});

test("native bootstrap starts polling only after the current probe allows startup", () => {
    const f = fixture();
    try {
        const ready = [];
        let probing = true;
        const awake = f.w.__ottStandby.isStandby;
        f.w.__ottStandby.isStandby = () => probing || awake();
        f.w.__ottStandby.ready = (callback) => ready.push(callback);
        f.w.stbInit();
        f.w.stbInit();
        assert.equal(f.timers.size, 0);
        probing = false;
        ready[0]();
        assert.equal(
            f.timers.size,
            0,
            "the previous bootstrap cannot own a timer"
        );
        ready[1]();
        assert.equal(
            f.timers.size,
            1,
            "healthy native startup resumes information polling"
        );
        [...f.timers.values()][0]();
        assert.equal(f.calls.info, 1);
        f.w.stbSetStandby(true);
        assert.equal(f.timers.size, 0);
        ready[1]();
        assert.equal(
            f.timers.size,
            0,
            "standby retires a delayed ready callback"
        );
        assert.deepEqual(f.errors, []);
    } finally {
        f.dom.window.close();
    }
});

test("late media-info events cannot poll native HLS while standby admission is closed", () => {
    const f = fixture();
    try {
        f.w.stbInit();
        Object.defineProperty(f.w.video, "videoWidth", { value: 1920 });
        let polls = 0;
        Object.assign(f.w, {
            _coreNativeHls: { mbps: () => 0, poll: () => polls++ },
            hlsInstance: null,
        });
        f.w.eval(functions(["updateCoreVideoInfo"]));
        f.w.updateCoreVideoInfo();
        assert.equal(polls, 1);
        f.w.stbSetStandby(true);
        f.w.updateCoreVideoInfo();
        f.w.video.dispatchEvent(new f.w.Event("canplay"));
        assert.equal(
            polls,
            1,
            "neither direct info refresh nor late canplay may poll"
        );
        assert.deepEqual(f.errors, []);
    } finally {
        f.dom.window.close();
    }
});
