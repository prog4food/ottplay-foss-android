// Samsung Simulator 10.0.6 replaces the app iframe's onkeydown on focus/blur.
// Use real DOM event delivery to check that remote input survives those writes.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const acorn = require("acorn");
const ts = require("typescript");
const { JSDOM } = require("jsdom");

const root = path.resolve(__dirname, "..");
function read(file) {
    return fs.readFileSync(path.join(root, file), "utf8");
}
function declarations(code, names, label) {
    const ast = acorn.parse(code, { ecmaVersion: 5 });
    return names
        .map((name) => {
            const matches = ast.body.filter(
                (node) =>
                    node.type === "FunctionDeclaration" && node.id.name === name
            );
            assert.equal(matches.length, 1, label + " exposes " + name);
            return code.slice(matches[0].start, matches[0].end);
        })
        .join("\n");
}
function compile(file) {
    return ts
        .transpileModule(read(file), {
            compilerOptions: {
                module: ts.ModuleKind.ES2015,
                target: ts.ScriptTarget.ES5,
            },
        })
        .outputText.split("\n")
        .filter(
            (line) =>
                !line.trim().startsWith("import ") && !/^export\s*\{/.test(line)
        )
        .map((line) => line.replace(/^export /, ""))
        .join("\n");
}
const adapter = read("devices/samsung/tizen/device.js");
const typedCore = compile("src/core/index.ts");
const typedHandlers = compile("src/key-handler/index.ts");
const sourceHandlers =
    declarations(typedCore, ["stbEventToKeyCode"], "source") +
    declarations(
        typedHandlers,
        ["cancelNativeListInertia", "keyHandler"],
        "source"
    );
const cases = [
    { core: typedCore, handlers: sourceHandlers, name: "source" },
    {
        core: read("devices/legacy-core.js"),
        handlers: sourceHandlers,
        name: "legacy core",
    },
];
if (process.argv.includes("--bundle")) {
    const bundle = read("dist/player.js");
    cases.push({
        core: bundle,
        handlers: declarations(
            bundle,
            ["stbEventToKeyCode", "cancelNativeListInertia", "keyHandler"],
            "classic bundle"
        ),
        name: "classic bundle",
    });
}

for (const testCase of cases) {
    const binding = declarations(
        testCase.core,
        ["stbBindKeyHandler"],
        testCase.name
    );
    const initializer = declarations(testCase.core, ["stbInit"], testCase.name);
    assert.match(
        initializer,
        /\bstbBindKeyHandler\(\)/,
        "Player init installs the tested binding"
    );
    for (const legacy of [false, true]) {
        const dom = new JSDOM("<!doctype html><body></body>", {
            runScripts: "outside-only",
        });
        const w = dom.window;
        require("./helpers/screen-runtime.cjs")(w);
        const addEventListener = w.addEventListener;
        try {
            let selected = 5;
            let oldPropertyCalls = 0;
            Object.assign(w, {
                $: () => ({ is: () => false }),
                changeSelect: (delta) => {
                    selected += delta;
                },
                isEditMode: false,
                isListVisible: true,
                isSelectBox: false,
                listKeyHandlerFn: () => false,
                nativeListInertia: null,
                settings: { volumeStep: 5 },
                stbInit() {},
                version: "test",
            });
            w.console.log = () => {};
            w.eval(testCase.handlers);
            w.eval(adapter);
            w.eval(binding);
            function remoteKey(code) {
                // The SDK uses Event, not KeyboardEvent, and sets only keyCode.
                const event = w.document.createEvent("Events");
                event.initEvent("keydown", true, true);
                event.keyCode = code;
                w.document.body.dispatchEvent(event);
            }
            // Model the SDK's app-iframe focus handlers. A property-only app
            // binding really does lose arrow delivery after either transition.
            w.onfocus = () => {
                w.onkeydown = () => {};
            };
            w.onblur = () => {
                w.onkeydown = null;
            };
            w.onkeydown = w.keyHandler;
            remoteKey(40);
            assert.equal(selected, 6);
            w.dispatchEvent(new w.Event("focus"));
            remoteKey(40);
            assert.equal(selected, 6, "SDK focus reproduces the old failure");
            w.onkeydown = w.keyHandler;
            w.dispatchEvent(new w.Event("blur"));
            remoteKey(38);
            assert.equal(selected, 6, "SDK blur reproduces the old failure");

            if (legacy) w.addEventListener = undefined;
            w.onkeydown = () => {
                oldPropertyCalls++;
            };
            w.stbBindKeyHandler();
            remoteKey(40);
            assert.equal(selected, 7, "Bound Down is delivered once");
            assert.equal(
                oldPropertyCalls,
                0,
                "Init still replaces the previous property binding"
            );
            w.stbBindKeyHandler();
            w.stbBindKeyHandler();
            remoteKey(38);
            assert.equal(selected, 6, "Repeated init must not duplicate Up");

            if (!legacy) {
                w.dispatchEvent(new w.Event("focus"));
                remoteKey(40);
                assert.equal(
                    selected,
                    7,
                    "Arrow survives SDK onfocus overwrite"
                );
                w.dispatchEvent(new w.Event("blur"));
                remoteKey(38);
                assert.equal(selected, 6, "Arrow survives SDK onblur clearing");
            }
            const originalHandler = w.keyHandler;
            let replacementCalls = 0;
            w.keyHandler = function (event) {
                assert.equal(
                    this,
                    w,
                    "Current handler retains window receiver"
                );
                replacementCalls++;
                originalHandler.call(this, event);
            };
            remoteKey(40);
            assert.equal(
                selected,
                7,
                "The listener uses a later handler replacement"
            );
            assert.equal(replacementCalls, 1);
            // Remove an old-style property binding when upgrading/reinitializing.
            w.onkeydown = w.keyHandler;
            w.stbBindKeyHandler();
            remoteKey(38);
            assert.equal(
                selected,
                6,
                "Listener and property must not double-deliver"
            );
            assert.equal(replacementCalls, 2);
            delete w.keyHandler;
            assert.doesNotThrow(() => remoteKey(40));
            assert.equal(
                selected,
                6,
                "An unavailable current handler is ignored"
            );
        } finally {
            w.addEventListener = addEventListener;
            w.close();
        }
    }
}
for (const testCase of cases) {
    for (const device of ["pc", "android", "samsung/maple", "lg/webos"]) {
        const dom = new JSDOM("<!doctype html><body><input></body>", {
            runScripts: "outside-only",
        });
        const w = dom.window;
        const delivered = [];
        try {
            require("./helpers/screen-runtime.cjs")(w);
            Object.assign(w, {
                $: () => ({ is: () => false }),
                isListVisible: true,
                listKeyHandlerFn: (code) => {
                    delivered.push(code);
                    return true;
                },
                nativeListInertia: null,
                settings: { volumeStep: 5 },
                stbInit() {},
                version: "test",
            });
            w.eval(testCase.handlers);
            w.eval(read("devices/" + device + "/device.js"));
            w.eval(
                declarations(
                    testCase.core,
                    ["stbBindKeyHandler"],
                    testCase.name
                )
            );
            w.stbBindKeyHandler();
            function send(fields, target = w.document.body) {
                const before = delivered.length;
                target.dispatchEvent(
                    new w.KeyboardEvent("keydown", {
                        bubbles: true,
                        cancelable: true,
                        ...fields,
                    })
                );
                return delivered.slice(before);
            }
            for (const [code, key, shifted, legacy, standard, action] of [
                ["Equal", "=", "+", 61, 187, "CH_UP"],
                ["Minus", "-", "_", 173, 189, "CH_DOWN"],
            ]) {
                for (const fields of [
                    { code, key, keyCode: legacy },
                    { key, which: legacy },
                    { code, key: "Unidentified", keyCode: legacy },
                    { code, key: shifted, keyCode: legacy, shiftKey: true },
                    { code, key, keyCode: standard },
                    { code, key, keyCode: 0 },
                ])
                    assert.deepEqual(
                        send(fields),
                        [w.keys[action]],
                        testCase.name + "/" + device + " keyboard " + action
                    );
                assert.deepEqual(
                    send(
                        { code, key, keyCode: legacy },
                        w.document.querySelector("input")
                    ),
                    [],
                    "Channel shortcuts preserve punctuation in text inputs"
                );
                assert.equal(
                    w.stbEventToKeyCode({ keyCode: legacy }),
                    legacy,
                    "Bare remote code retains its platform meaning"
                );
            }
            assert.equal(
                w.stbEventToKeyCode({ key: "AudioVolumeMute", keyCode: 173 }),
                173,
                "Mute is not channel down"
            );
            assert.equal(
                w.stbEventToKeyCode({
                    code: "Equal",
                    key: "=",
                    keyCode: w.keys.INFO,
                }),
                w.keys.INFO,
                "A declared remote code still wins over a punctuation label"
            );
            for (let digit = 0; digit <= 9; digit++) {
                for (const event of [
                    { key: String(digit), keyCode: 0 },
                    { code: "Digit" + digit, key: "Unidentified", keyCode: 0 },
                    { code: "Numpad" + digit, key: String(digit), keyCode: 0 },
                    {
                        code: "Numpad" + digit,
                        key: String(digit),
                        keyCode: [45, 35, 40, 34, 37, 12, 39, 36, 38, 33][
                            digit
                        ],
                        shiftKey: true,
                    },
                    {
                        code: "Numpad" + digit,
                        key: String(digit),
                        keyCode: 96 + digit,
                        location: 3,
                    },
                    { location: 3, which: 96 + digit },
                    { keyCode: w.keys["N" + digit] },
                ])
                    assert.deepEqual(
                        send(event),
                        [w.keys["N" + digit]],
                        testCase.name + "/" + device + " digit " + digit
                    );
            }
            assert.deepEqual(
                send(
                    { code: "Numpad5", key: "5", keyCode: 101, location: 3 },
                    w.document.querySelector("input")
                ),
                [],
                "Numeric shortcuts never consume input typing"
            );
            assert.equal(
                w.stbEventToKeyCode({
                    code: "Numpad5",
                    key: "Clear",
                    keyCode: 0,
                }),
                0,
                "NumLock-off Clear is not digit 5"
            );
            for (const [key, code, keyCode] of [
                ["End", "Numpad1", 35],
                ["ArrowDown", "Numpad2", 40],
                ["ArrowLeft", "Numpad4", 37],
                ["Home", "Numpad7", 36],
            ])
                for (const legacy of [0, keyCode])
                    assert.equal(
                        w.stbEventToKeyCode({ code, key, keyCode: legacy }),
                        keyCode,
                        "NumLock-off " + key + " retains navigation"
                    );
            if (device === "pc") {
                assert.deepEqual(send({ keyCode: 101 }), [w.keys.N5]);
                assert.deepEqual(send({ which: 105 }), [w.keys.N9]);
            }
            if (device === "samsung/maple")
                assert.deepEqual(
                    send({ keyCode: 99 }),
                    [w.keys.INFO],
                    "Maple INFO is not an unidentified Numpad3"
                );
            assert.equal(
                w.stbEventToKeyCode({
                    code: "Digit9",
                    key: "9",
                    keyCode: w.keys.INFO,
                }),
                w.keys.INFO,
                "A declared nonzero remote code retains priority"
            );
        } finally {
            w.close();
        }
    }
}
console.log(
    "Numeric DOM shortcuts preserve device codes, NumLock navigation and text inputs"
);
console.log(
    "Keyboard binding survives host focus changes, repeated init and handler replacement (" +
        cases.map((item) => item.name).join(", ") +
        ")"
);

// Real DOM delivery: native video can stop bubble handlers, while the admitted
// shortcut must still seek exactly once and leave editors/menu navigation alone.
const shortcutCases = [{ code: typedHandlers, name: "source" }];
if (process.argv.includes("--bundle"))
    shortcutCases.push({
        code: read("dist/player.js"),
        name: "classic bundle",
    });
for (const testCase of shortcutCases) {
    const dom = new JSDOM(
        '<body><video id="video" tabindex="0"></video><input id="input"><textarea></textarea><select><option>A</option></select><div contenteditable="true"><span id="nested">Text</span></div><div contenteditable=""><span id="empty-editable">Text</span></div></body>',
        { runScripts: "outside-only" }
    );
    const w = dom.window;
    const seeks = [];
    const normal = [];
    const volumes = [];
    let screen = null;
    let hasTarget = true;
    let phase = "playing";
    let sleepResets = 0;
    try {
        Object.assign(w, {
            __ottClassicPlayback: {
                snapshot: () =>
                    hasTarget ? { phase, target: { kind: "vod" } } : null,
            },
            __ottClassicScreenPort: {
                dispatch: (code) => normal.push(code),
                reconcile() {},
                screens: { current: () => screen },
            },
            $: () => ({ is: () => false }),
            changeVolume: (delta) => volumes.push(delta),
            keys: { LEFT: 37, RIGHT: 39 },
            nativeListInertia: null,
            setSleepTimeout: () => sleepResets++,
            shiftArchive: (delta) => seeks.push(delta),
            stbEventToKeyCode: (event) => event.keyCode || 0,
            sVolumeStep: 5,
        });
        w.eval(
            declarations(
                testCase.code,
                [
                    "tryKeyboardSeek",
                    "tryKeyboardRandom",
                    "installKeyboardSeek",
                    "cancelNativeListInertia",
                    "keyHandler",
                ],
                testCase.name
            )
        );
        w.addEventListener("keydown", w.keyHandler);
        w.installKeyboardSeek();
        w.installKeyboardSeek();
        const video = w.document.querySelector("video");
        video.addEventListener("keydown", (event) => event.stopPropagation());
        function send(init, target = video) {
            const before = seeks.length;
            const event = new w.KeyboardEvent("keydown", {
                bubbles: true,
                cancelable: true,
                ...init,
            });
            target.dispatchEvent(event);
            return { delta: seeks.slice(before), event };
        }
        for (const modifier of ["altKey", "ctrlKey", "metaKey"]) {
            for (const [key, direction] of [
                ["ArrowLeft", -1],
                ["ArrowRight", 1],
            ]) {
                for (const repeat of [false, true]) {
                    const result = send({ key, [modifier]: true, repeat });
                    assert.deepEqual(result.delta, [direction * 10]);
                    assert.equal(result.event.defaultPrevented, true);
                }
            }
        }
        assert.deepEqual(
            normal,
            [],
            "captured shortcuts never double-dispatch"
        );
        assert.deepEqual(
            send({ altKey: true, code: "ArrowLeft" }).delta,
            [-10]
        );
        assert.deepEqual(send({ keyCode: 39, metaKey: true }).delta, [10]);
        w.__ottTauriNativeFs = true;
        assert.deepEqual(
            send({ key: "ArrowLeft", metaKey: true }).delta,
            [-10]
        );
        const shortcut = { altKey: true, key: "ArrowRight" };
        for (const selector of [
            "input",
            "textarea",
            "select",
            "#nested",
            "#empty-editable",
        ]) {
            const result = send(shortcut, w.document.querySelector(selector));
            assert.deepEqual(result.delta, [], "editable target " + selector);
        }
        const input = w.document.querySelector("input");
        input.focus();
        assert.deepEqual(send(shortcut).delta, [], "active native editor wins");
        input.blur();
        for (const extra of [
            { isComposing: true },
            { keyCode: 229 },
            { ctrlKey: true },
            { shiftKey: true },
            { metaKey: true },
        ]) {
            const result = send({ ...shortcut, ...extra });
            assert.deepEqual(result.delta, []);
            assert.equal(result.event.defaultPrevented, false);
        }
        for (const kind of ["list", "editor", "dialog", "about"]) {
            screen = { kind };
            assert.deepEqual(send(shortcut).delta, [], "screen owns " + kind);
        }
        screen = null;
        hasTarget = false;
        assert.deepEqual(send(shortcut).delta, [], "no active playback target");
        hasTarget = true;
        for (const inactive of ["stopped", "idle", "loading", "error"]) {
            phase = inactive;
            const result = send(shortcut);
            assert.deepEqual(result.delta, [], "inactive phase " + inactive);
            assert.equal(result.event.defaultPrevented, false);
        }
        phase = "paused";
        assert.deepEqual(send(shortcut).delta, [10], "paused media can seek");
        phase = "playing";
        for (const mode of ["strict", "locked"]) {
            w.__ottKiosk = {
                [mode]: () => true,
                strictKey() {},
            };
            assert.deepEqual(send(shortcut).delta, [], "kiosk " + mode);
        }
        delete w.__ottKiosk;
        assert.equal(
            sleepResets,
            seeks.length,
            "accepted seeks reset sleep once"
        );
        const plain = send({ key: "ArrowLeft", keyCode: 37 }, w.document.body);
        assert.deepEqual(plain.delta, []);
        assert.deepEqual(
            normal.slice(-1),
            [37],
            "plain arrows keep navigation"
        );
        w.ott_device = "pc";
        for (const platform of ["pc", "pc2"]) {
            w.ott_device = platform;
            for (const [key, direction] of [
                ["ArrowLeft", -1],
                ["ArrowRight", 1],
            ]) {
                const result = send({ key });
                assert.deepEqual(
                    result.delta,
                    [],
                    "plain desktop arrow never seeks"
                );
                assert.equal(result.event.defaultPrevented, true);
                assert.equal(volumes[volumes.length - 1], direction * 5);
            }
        }
        screen = { kind: "list" };
        const beforeVolumes = volumes.length;
        assert.equal(send({ key: "ArrowRight" }).event.defaultPrevented, false);
        assert.equal(
            volumes.length,
            beforeVolumes,
            "menus retain their arrows"
        );
        screen = null;
        // Programmatic/legacy dispatch shares the same shortcut admission.
        const direct = new w.KeyboardEvent("keydown", {
            ...shortcut,
            cancelable: true,
        });
        const before = seeks.length;
        const beforeSleep = sleepResets;
        w.keyHandler(direct);
        assert.deepEqual(seeks.slice(before), [10]);
        assert.equal(
            sleepResets - beforeSleep,
            1,
            "direct seek resets sleep once"
        );
    } finally {
        w.close();
    }
}
console.log(
    "Modifier seek: capture delivery, native video, repeats, editors, screens and kiosk passed"
);

// Q/power is Exit, including when a native shell closes asynchronously or a
// browser denies window.close(). It must retire both lanes without persisting
// standby, so reopening can restore the checkpointed file and position.
for (const testCase of shortcutCases) {
    for (const scenario of [
        { failure: null, list: false },
        { failure: null, list: true },
        { failure: "checkpoint", list: false },
        { failure: "main", list: true },
        { failure: "pip", list: true },
    ]) {
        const dom = new JSDOM("<body></body>", {
            runScripts: "outside-only",
            url: "https://player.example/",
        });
        const w = dom.window;
        const calls = [];
        function effect(name) {
            calls.push(name);
            if (scenario.failure === name) throw new Error("fixture " + name);
        }
        try {
            w.localStorage.setItem("__ottStandbyV1", "0");
            require("./helpers/screen-runtime.cjs")(w);
            Object.assign(w, {
                $: () => ({ is: () => false }),
                body_onUnload: () => effect("checkpoint"),
                isListVisible: scenario.list,
                keys: { POWER: 81 },
                listKeyHandlerFn: () => {
                    calls.push("list");
                    return true;
                },
                nativeListInertia: null,
                settings: {},
                stbEventToKeyCode: (event) => event.keyCode,
                stbExit: () => {
                    effect("exit");
                    return new Promise(() => {});
                },
                stbStop: () => effect("main"),
                stbStopPip: () => effect("pip"),
                toggleMainPlayback() {},
                toggleStandby: () => {
                    calls.push("standby");
                    w.localStorage.setItem("__ottStandbyV1", "1");
                },
            });
            w.eval(
                declarations(
                    testCase.code,
                    ["cancelNativeListInertia", "keyHandler", "handleMainKey"],
                    testCase.name
                )
            );
            w.__ottClassicScreenPort.reconcile();
            assert.equal(
                w.__ottClassicScreenPort.screens.current()?.kind || null,
                scenario.list ? "list" : null
            );
            const event = new w.KeyboardEvent("keydown", {
                cancelable: true,
                key: "q",
                keyCode: 81,
            });
            assert.doesNotThrow(() => w.keyHandler(event));
            assert.deepEqual(
                calls,
                ["checkpoint", "main", "pip", "exit"],
                testCase.name +
                    " Exit completes every cleanup: " +
                    JSON.stringify(scenario)
            );
            assert.equal(w.localStorage.getItem("__ottStandbyV1"), "0");
            assert.equal(event.defaultPrevented, true);
        } finally {
            w.close();
        }
    }
}
console.log("Exit checkpoints and stops both lanes without persisting standby");

// R selects inside the current collection, without stealing browser/editor keys.
for (const testCase of shortcutCases) {
    const dom = new JSDOM(
        '<body><video tabindex="0"></video><input><div contenteditable=""><span>text</span></div></body>',
        { runScripts: "outside-only" }
    );
    const w = dom.window;
    const calls = [];
    let owner = null;
    let playing = null;
    try {
        Object.assign(w, {
            __ottClassicScreenPort: {
                reconcile() {},
                screens: { current: () => owner },
            },
            __ottMedia: {
                current: () => playing,
                randomPlay: (fromList) => calls.push(["media", fromList]),
            },
            catIndex: 1,
            cats: { All: [1, 2, 3, 4], Favorites: [3, 1], Other: [4, 2] },
            catsArray: ["All", "Favorites", "Other"],
            channels: { 1: {}, 2: {}, 3: {}, 4: {} },
            channelsKeyHandler() {},
            closeList: () => calls.push(["close"]),
            curList: [3, 1],
            listArray: [4, 2],
            listCatIndex: 2,
            mediaKeyHandler() {},
            ott_device: "pc",
            playChannel: (category, index) =>
                calls.push(["channel", category, index]),
            primaryIndex: 0,
        });
        w.eval(
            declarations(testCase.code, ["tryKeyboardRandom"], testCase.name)
        );
        w.document.addEventListener("keydown", w.tryKeyboardRandom, true);
        const video = w.document.querySelector("video");
        video.addEventListener("keydown", (e) => e.stopPropagation());
        function send(init, target = video) {
            const before = calls.length;
            const event = new w.KeyboardEvent("keydown", {
                bubbles: true,
                cancelable: true,
                code: "KeyR",
                key: "r",
                ...init,
            });
            target.dispatchEvent(event);
            return { calls: calls.slice(before), event };
        }
        assert.deepEqual(
            send({}).calls,
            [["channel", 1, 1]],
            "R stays in Favorites and excludes current channel"
        );
        w.ott_device = "pc2";
        assert.deepEqual(
            send({ key: "к" }).calls,
            [["channel", 1, 1]],
            "physical R works on another layout"
        );
        assert.deepEqual(
            send({ repeat: true }).calls,
            [],
            "held key does not select again"
        );
        for (const modifier of ["altKey", "ctrlKey", "metaKey", "shiftKey"]) {
            const result = send({ [modifier]: true });
            assert.deepEqual(result.calls, []);
            assert.equal(
                result.event.defaultPrevented,
                false,
                "browser modifier shortcut remains native"
            );
        }
        for (const device of ["android", "webos", "tizen"]) {
            w.ott_device = device;
            assert.deepEqual(send({}).calls, []);
        }
        w.ott_device = "pc";
        for (const target of [
            w.document.querySelector("input"),
            w.document.querySelector("span"),
        ]) {
            const result = send({}, target);
            assert.deepEqual(result.calls, []);
            assert.equal(result.event.defaultPrevented, false);
        }
        for (const kind of ["editor", "dialog", "about", "picker"]) {
            owner = { kind };
            assert.deepEqual(send({}).calls, []);
        }
        owner = { kind: "list" };
        assert.deepEqual(
            send({}).calls,
            [],
            "settings and unknown lists do not select channels"
        );
        const customRepeat = send({ repeat: true });
        assert.deepEqual(customRepeat.calls, []);
        assert.equal(
            customRepeat.event.defaultPrevented,
            true,
            "custom search list repeat is consumed before its numeric handler"
        );
        w.listKeyHandlerFn = w.channelsKeyHandler;
        w.Math.random = () => 0;
        assert.deepEqual(
            send({}).calls,
            [["close"], ["channel", 2, 0]],
            "visible list uses its category rather than playing category"
        );
        w.listKeyHandlerFn = w.mediaKeyHandler;
        assert.deepEqual(
            send({}).calls,
            [["media", true]],
            "visible media list owns random selection"
        );
        owner = null;
        playing = { sequence: { items: [{}, {}] } };
        assert.deepEqual(
            send({}).calls,
            [["media", false]],
            "VOD uses current sequence rather than underlying IPTV list"
        );
        playing = null;
        w.curList = [3];
        w.cats.Favorites = [3];
        assert.deepEqual(
            send({}).calls,
            [],
            "single-item list does not restart current playback"
        );
        w.__ottKiosk = { locked: () => true };
        assert.deepEqual(send({}).calls, [], "kiosk cannot switch");
        w.__ottKiosk = { strict: () => true };
        assert.deepEqual(send({}).calls, [], "strict kiosk cannot switch");
    } finally {
        w.close();
    }
}
console.log(
    "PC R random shortcut: collection boundaries, media dispatch, modifiers, editors, repeat and kiosk protection"
);
