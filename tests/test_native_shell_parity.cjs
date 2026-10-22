const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { JSDOM } = require("jsdom");
const { localizationRuntime } = require("./helpers/localization-runtime.cjs");
const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const localeCode = localizationRuntime();

function functions(file, names) {
    const ast = ts.createSourceFile(
        file,
        read(file),
        ts.ScriptTarget.Latest,
        true
    );
    const selected = ast.statements.filter(
        (node) =>
            ts.isFunctionDeclaration(node) && names.includes(node.name?.text)
    );
    assert.equal(selected.length, names.length);
    return ts.transpileModule(
        selected
            .map((node) => node.getText(ast).replace(/^export /, ""))
            .join("\n"),
        { compilerOptions: { target: ts.ScriptTarget.ES5 } }
    ).outputText;
}

const touchCode = functions("src/key-handler/index.ts", [
    "capacitorOnly",
    "cancelNativeListInertia",
    "isNativeTouchEditor",
    "resetNativeListTouch",
    "forwardNativeListTouch",
    "startNativeListTouch",
    "startNativeListInertia",
    "moveNativeListTouch",
    "updateTouchPosition",
    "handleTouchCancel",
    "handleTouchStart",
    "handleTouchMove",
    "body_handleTouchEnd",
    "checkTap",
    "getDirection",
    "keyHandler",
]);

function touchFixture(platform) {
    const calls = [];
    let now = 1000;
    let frameId = 0;
    const frames = new Map();
    const clock = {
        advance(milliseconds) {
            now += milliseconds;
        },
        frame(milliseconds = 1000 / 60) {
            now += milliseconds;
            const pending = [...frames.entries()];
            for (const [id, callback] of pending) {
                if (!frames.delete(id)) continue;
                callback(now);
            }
        },
        get now() {
            return now;
        },
        get pending() {
            return frames.size;
        },
        settle(milliseconds = 1000 / 60) {
            let count = 0;
            while (frames.size && count++ < 1000) this.frame(milliseconds);
            assert.equal(frames.size, 0, "list inertia must settle");
        },
    };
    const w = {
        _doKey: (key) => calls.push(["key", key]),
        alert: () => {},
        cancelAnimationFrame: (id) => frames.delete(id),
        Date: class extends Date {
            static now() {
                return now;
            }
        },
        document: { getElementById: () => null },
        keys: { DOWN: 40, ENTER: 13, LEFT: 37, RIGHT: 39, SETUP: 192, UP: 38 },
        MouseEvent: function (type, options) {
            Object.assign(this, { type }, options);
        },
        nativeListFrame: 0,
        nativeListInertia: null,
        nativeListTouch: null,
        performance: { now: () => now },
        requestAnimationFrame(callback) {
            frames.set(++frameId, callback);
            return frameId;
        },
        stbEventToKeyCode: (event) => event.keyCode,
        tCount: undefined,
        touch_locked: false,
        touch_min_sensX: 60,
        touch_min_sensY: 40,
        touchMaxDistance: 0,
        xDown: null,
        xMove1: null,
        xUp: null,
        yDown: null,
        yMove1: null,
        yUp: null,
    };
    w.window = w;
    if (platform === "capacitor") w.Capacitor = {};
    if (platform === "tauri") w.__TAURI__ = {};
    vm.createContext(w);
    vm.runInContext(localeCode, w);
    require("./helpers/screen-runtime.cjs")(w);
    vm.runInContext(touchCode, w);
    return { calls, clock, w };
}

function nativeListFixture({ index = 100, length = 1000 } = {}) {
    const fixture = touchFixture("capacitor");
    const { calls, clock, w } = fixture;
    const dom = new JSDOM('<!doctype html><div id="listIn"></div>', {
        pretendToBeVisual: true,
    });
    w.document = dom.window.document;
    w.MouseEvent = function (type, options) {
        return new dom.window.MouseEvent(type, {
            ...options,
            view: dom.window,
        });
    };
    const list = w.document.getElementById("listIn");
    w.__ottListRowH = 44;
    w.listPageSize = 8;
    w.listArray = Array.from({ length }, (_, id) => ({ id }));
    w.listDataArray = w.listArray;
    w.selIndex = index;
    w.isListVisible = true;
    w.__ottClassicScreenPort.commitList();
    let page = -1;
    function render() {
        const nextPage = Math.floor(w.selIndex / w.listPageSize);
        if (page === nextPage) return;
        page = nextPage;
        list.innerHTML = "";
        for (
            let id = page * w.listPageSize;
            id < Math.min(length, (page + 1) * w.listPageSize);
            id++
        ) {
            const row = w.document.createElement("div");
            row.id = "it" + id;
            row.addEventListener("click", () => {
                calls.push(["click", id]);
                calls.push(["play", id]);
            });
            list.appendChild(row);
        }
    }
    w.changeSelect = (steps) => {
        assert.ok(Number.isInteger(steps), "selection moves by whole rows");
        const next = w.selIndex + steps;
        assert.ok(
            next >= 0 && next < length,
            "selection never wraps at bounds"
        );
        calls.push(["select", steps, next]);
        w.selIndex = next;
        render();
    };
    render();
    for (const [type, callback] of [
        ["touchstart", w.handleTouchStart],
        ["touchmove", w.handleTouchMove],
        ["touchend", w.body_handleTouchEnd],
        ["touchcancel", w.handleTouchCancel],
    ])
        w.document.body.addEventListener(type, callback);
    let target;
    function send(type, { rows = 0, dx = 0, dt = 0, fingers = 1 } = {}) {
        clock.advance(dt);
        const touch = {
            clientX: 100 + dx,
            clientY: 500 + rows * w.__ottListRowH,
            identifier: 7,
            screenX: 100 + dx,
            screenY: 500 + rows * w.__ottListRowH,
            target,
        };
        const touches = Array.from({ length: fingers }, (_, finger) => ({
            ...touch,
            identifier: touch.identifier + finger,
        }));
        const event = new dom.window.Event(type, {
            bubbles: true,
            cancelable: true,
        });
        Object.defineProperties(event, {
            changedTouches: { value: touches },
            touches: {
                value:
                    type === "touchend" || type === "touchcancel"
                        ? []
                        : touches,
            },
        });
        target.dispatchEvent(event);
        return event;
    }
    return {
        ...fixture,
        begin(options) {
            target = w.document.getElementById("it" + w.selIndex);
            assert.ok(target, "gesture begins on a mounted row");
            return send("touchstart", options);
        },
        close() {
            w.handleTouchCancel();
            dom.window.close();
        },
        flick(direction = -1) {
            this.begin();
            send("touchmove", { dt: 40, rows: 2 * direction });
            send("touchmove", { dt: 40, rows: 4 * direction });
            send("touchend", { rows: 4 * direction });
        },
        send,
        get target() {
            return target;
        },
    };
}

function assertListDidNotActivate(fixture, label) {
    assert.deepEqual(
        fixture.calls.filter(([type]) => type !== "select"),
        [],
        label + " cannot click, play, or dispatch an unrelated key"
    );
}

// Drive the actual touch handlers, screen owners and detached-row listeners
// with a controllable animation clock, without browser timing variability.
for (const direction of [-1, 1]) {
    const fixture = nativeListFixture();
    try {
        fixture.flick(direction);
        const released = fixture.w.selIndex;
        assert.equal(released, 100 - 4 * direction, "finger tracks four rows");
        assert.ok(fixture.clock.pending, "fast release starts inertia");
        fixture.clock.settle();
        assert.ok(
            (released - fixture.w.selIndex) * direction >=
                fixture.w.listPageSize * 2,
            "a fast flick coasts at least two further visible pages"
        );
        assertListDidNotActivate(fixture, "fast flick");
    } finally {
        fixture.close();
    }
}

{
    const fixture = nativeListFixture();
    try {
        fixture.begin();
        fixture.send("touchend", { dt: 80, rows: -4 });
        assert.equal(
            fixture.w.selIndex,
            104,
            "coalesced touchend preserves the final four-row movement"
        );
        fixture.clock.settle();
        assert.ok(fixture.w.selIndex > 104, "coalesced fast release can coast");
        assertListDidNotActivate(fixture, "coalesced flick");
    } finally {
        fixture.close();
    }
}

{
    const fixture = nativeListFixture();
    try {
        fixture.begin();
        for (const rows of [-0.4, -0.8, -1.2, -1.6, -2, -2.4])
            fixture.send("touchmove", { dt: 100, rows });
        fixture.send("touchend", { rows: -2.4 });
        assert.equal(
            fixture.w.selIndex,
            102,
            "slow drag retains row precision"
        );
        assert.equal(fixture.clock.pending, 0, "slow release has no inertia");
        assertListDidNotActivate(fixture, "slow drag");
    } finally {
        fixture.close();
    }
}

{
    const fixture = nativeListFixture();
    try {
        fixture.begin();
        fixture.send("touchmove", { rows: -2 });
        fixture.send("touchend", { rows: -4 });
        assert.equal(
            fixture.w.selIndex,
            104,
            "same-timestamp drag still tracks"
        );
        assert.equal(
            fixture.clock.pending,
            0,
            "zero elapsed time cannot manufacture a fling velocity"
        );
        assertListDidNotActivate(fixture, "same-timestamp drag");
    } finally {
        fixture.close();
    }
}

const settledIndexes = [];
for (const frameDuration of [1000 / 120, 1000 / 60, 1000 / 30, 100]) {
    const fixture = nativeListFixture();
    try {
        fixture.flick();
        let frames = 0;
        while (fixture.clock.pending && frames++ < 1000) {
            const before = fixture.calls.length;
            fixture.clock.frame(frameDuration);
            assert.ok(
                fixture.calls.length - before <= 1,
                "one animation frame renders at most one selection change"
            );
        }
        assert.equal(fixture.clock.pending, 0, "all refresh rates settle");
        settledIndexes.push(fixture.w.selIndex);
        assertListDidNotActivate(fixture, "frame-rate-independent flick");
    } finally {
        fixture.close();
    }
}
assert.ok(
    Math.max(...settledIndexes) - Math.min(...settledIndexes) <= 1,
    "coast distance stays within one row at 120Hz, 60Hz, 30Hz and delayed frames"
);

for (const pause of [0, 200]) {
    const fixture = nativeListFixture();
    try {
        fixture.begin();
        fixture.send("touchmove", { dt: 40, rows: -3 });
        fixture.send("touchmove", { dt: 30, rows: -2 });
        fixture.send("touchmove", { dt: 30, rows: -1 });
        fixture.send("touchend", { dt: pause, rows: -1 });
        const released = fixture.w.selIndex;
        fixture.clock.settle();
        if (pause) {
            assert.equal(
                fixture.w.selIndex,
                released,
                "holding still before release discards earlier speed"
            );
        } else {
            assert.ok(
                fixture.w.selIndex < released,
                "coast follows the final direction after reversal"
            );
        }
        assertListDidNotActivate(fixture, "reversed drag");
    } finally {
        fixture.close();
    }
}

for (const [name, interrupt] of [
    ["touch cancellation", (fixture) => fixture.w.handleTouchCancel()],
    ["new touch", (fixture) => fixture.begin()],
    ["remote key", (fixture) => fixture.w.keyHandler({ keyCode: 40 })],
    ["hidden list", (fixture) => (fixture.w.isListVisible = false)],
    [
        "covered owner",
        (fixture) =>
            fixture.w.__ottClassicScreenPort.openOverlay("dialog", () => {}),
    ],
    [
        "replaced owner",
        (fixture) => {
            fixture.w.listKeyHandler = () => {};
            fixture.w.__ottClassicScreenPort.commitList();
        },
    ],
    [
        "replaced rows",
        (fixture) => {
            fixture.w.listDataArray = fixture.w.listDataArray.slice();
        },
    ],
    [
        "background document",
        (fixture) =>
            Object.defineProperty(fixture.w.document, "hidden", {
                value: true,
            }),
    ],
    ["external selection", (fixture) => fixture.w.changeSelect(1)],
    ["suspended animation", (fixture) => fixture.clock.frame(1000)],
    ["reversed animation clock", (fixture) => fixture.clock.advance(-100)],
]) {
    const fixture = nativeListFixture();
    try {
        fixture.flick();
        fixture.clock.frame();
        assert.ok(fixture.clock.pending, name + " interrupts an active coast");
        interrupt(fixture);
        const stopped = fixture.w.selIndex;
        fixture.clock.settle();
        assert.equal(
            fixture.w.selIndex,
            stopped,
            name + " stops later movement"
        );
        assertListDidNotActivate(fixture, name);
    } finally {
        fixture.close();
    }
}

for (const [index, direction, expected] of [
    [10, -1, 19],
    [9, 1, 0],
]) {
    const fixture = nativeListFixture({ index, length: 20 });
    try {
        fixture.flick(direction);
        fixture.clock.settle();
        assert.equal(fixture.w.selIndex, expected, "coast clamps at list end");
        assert.equal(fixture.clock.pending, 0, "bound clears animation work");
        assertListDidNotActivate(fixture, "boundary flick");
    } finally {
        fixture.close();
    }
}

// Rendering can synchronously retire an owner or begin a newer interaction.
// The frame that caused that render must not schedule work or stop its successor.
for (const scenario of [
    { name: "cancelled during render", replace: false },
    { name: "replaced during render", replace: true },
    {
        index: 14,
        length: 20,
        name: "replaced while reaching a bound",
        replace: true,
    },
]) {
    const fixture = nativeListFixture(scenario);
    try {
        fixture.flick();
        const changeSelect = fixture.w.changeSelect;
        let interrupted = false;
        fixture.w.changeSelect = (steps) => {
            fixture.w.changeSelect = changeSelect;
            changeSelect(steps);
            interrupted = true;
            if (scenario.replace) fixture.flick(1);
            else fixture.w.handleTouchCancel();
        };
        fixture.clock.frame(40);
        assert.equal(interrupted, true, scenario.name + " runs inside render");
        const released = fixture.w.selIndex;
        assert.equal(
            fixture.clock.pending,
            scenario.replace ? 1 : 0,
            scenario.name + " leaves only the current interaction scheduled"
        );
        if (scenario.replace) {
            fixture.clock.frame(40);
            assert.ok(
                fixture.w.selIndex < released,
                scenario.name + " keeps the replacement flick moving"
            );
            fixture.w.handleTouchCancel();
            assert.equal(
                fixture.clock.pending,
                0,
                scenario.name +
                    " retains the replacement frame for cancellation"
            );
        }
        const stopped = fixture.w.selIndex;
        fixture.clock.settle();
        assert.equal(
            fixture.w.selIndex,
            stopped,
            scenario.name + " stays stopped"
        );
        assertListDidNotActivate(fixture, scenario.name);
    } finally {
        fixture.close();
    }
}

{
    const fixture = nativeListFixture({ index: 103 });
    try {
        fixture.begin();
        const originalTarget = fixture.target;
        fixture.send("touchmove", { dt: 40, rows: -2 });
        assert.equal(originalTarget.isConnected, false, "paging detaches row");
        fixture.send("touchmove", { dt: 40, rows: -4 });
        fixture.send("touchend", { rows: -4 });
        assert.equal(
            fixture.w.selIndex,
            107,
            "detached row forwards final move"
        );
        fixture.clock.frame(40);
        assert.ok(
            fixture.w.selIndex > 107,
            "detached row release starts coast"
        );
        assert.equal(
            fixture.send("touchmove", { rows: -10 }).defaultPrevented,
            false,
            "completed gesture releases detached row listeners"
        );
        assertListDidNotActivate(fixture, "detached row flick");

        fixture.begin();
        const tappedIndex = fixture.w.selIndex;
        fixture.send("touchend");
        fixture.clock.settle();
        assert.equal(fixture.w.selIndex, tappedIndex, "new tap brakes coast");
        assert.deepEqual(
            fixture.calls.filter(([type]) => type !== "select"),
            [
                ["click", tappedIndex],
                ["play", tappedIndex],
            ],
            "stationary tap after flick still activates exactly once"
        );
    } finally {
        fixture.close();
    }
}

{
    const fixture = nativeListFixture();
    try {
        fixture.begin();
        fixture.send("touchmove", { dt: 20, dx: 120, rows: -0.5 });
        fixture.send("touchend", { dx: 120, rows: -5 });
        assert.equal(fixture.clock.pending, 0, "horizontal lock cannot fling");
        assert.equal(
            fixture.w.selIndex,
            100,
            "horizontal gesture does not drag"
        );
        assert.deepEqual(fixture.calls, [["key", fixture.w.keys.RIGHT]]);
    } finally {
        fixture.close();
    }
}
console.log(
    "OK: native list flick distance, row precision, timing, bounds and cancellation"
);

// Same target and coordinates must reach the same click path in every shell,
// regardless of the previously highlighted menu/channel item.
for (const platform of ["browser", "tauri", "capacitor"]) {
    for (const [id, tagName, x, y] of [
        ["it8", "DIV", 200, 220],
        ["menu-action", "BUTTON", 20, 20],
        ["osk-key", "SPAN", 320, 600],
        ["edge", "DIV", 0, 0],
    ]) {
        const { w, calls } = touchFixture(platform);
        const touch = { clientX: x, clientY: y, screenX: x, screenY: y };
        const target = {
            dispatchEvent(e) {
                calls.push([e.type, id, e.clientX, e.clientY, e.bubbles]);
            },
            id,
            tagName,
        };
        let prevented = 0;
        w.handleTouchStart({
            preventDefault() {
                prevented++;
            },
            target,
            touches: [touch],
        });
        w.body_handleTouchEnd({
            changedTouches: [touch],
            preventDefault() {
                prevented++;
            },
            target,
            touches: [],
        });
        assert.deepEqual(
            calls,
            [["click", id, x, y, true]],
            platform + " tap " + id
        );
        assert.equal(
            prevented,
            2,
            "suppress compatibility click so activation happens once"
        );
        assert.equal(w.xDown, null);
    }
}

// Overlay/footer controls are outside the native list gesture owner. A drag
// must never click its original control, even when it returns to the start or
// the WebView delivers the only movement together with the final touchend.
for (const platform of ["browser", "tauri", "capacitor"]) {
    for (const scenario of [
        { end: [250, 100], moves: [], name: "coalesced horizontal end" },
        { end: [100, 250], moves: [], name: "coalesced vertical end" },
        {
            moves: [
                [220, 100],
                [100, 100],
            ],
            name: "horizontal reversal",
        },
        {
            moves: [
                [100, 220],
                [100, 100],
            ],
            name: "vertical reversal",
        },
        {
            moves: [
                [106, 100],
                [100, 100],
            ],
            name: "tap threshold boundary",
        },
        { cancel: true, moves: [[220, 100]], name: "cancelled drag" },
    ]) {
        const { w, calls } = touchFixture(platform);
        const target = {
            dispatchEvent(event) {
                calls.push([event.type]);
            },
            tagName: "BUTTON",
        };
        const touch = ([x, y]) => ({
            clientX: x,
            clientY: y,
            screenX: x,
            screenY: y,
        });
        const event = (coordinates, ended = false) => ({
            changedTouches: [touch(coordinates)],
            preventDefault() {},
            target,
            touches: ended ? [] : [touch(coordinates)],
        });
        w.handleTouchStart(event([100, 100]));
        for (const coordinates of scenario.moves)
            w.handleTouchMove(event(coordinates));
        if (scenario.cancel) w.handleTouchCancel();
        w.body_handleTouchEnd(event(scenario.end || [100, 100], true));
        assert.equal(
            calls.some(([type]) => type === "click"),
            false,
            platform + " " + scenario.name + " cannot activate the control"
        );
        if (scenario.name.endsWith("reversal"))
            assert.equal(calls.length, 2, "both directional shortcuts remain");

        // Reset after a completed drag: ordinary jitter and a repeated terminal
        // event still produce exactly one click on the next stationary tap.
        calls.length = 0;
        w.handleTouchStart(event([100, 100]));
        w.handleTouchMove(event([104, 103]));
        w.body_handleTouchEnd(event([102, 101], true));
        w.body_handleTouchEnd(event([102, 101], true));
        assert.deepEqual(calls, [["click"]], platform + " next tap is single");
    }
}

for (const platform of ["browser", "tauri", "capacitor"]) {
    for (const fingers of [2, 3]) {
        const { w, calls } = touchFixture(platform);
        const touch = {
            clientX: 100,
            clientY: 100,
            screenX: 100,
            screenY: 100,
        };
        const event = {
            changedTouches: [touch],
            preventDefault() {},
            target: { tagName: "BUTTON" },
            touches: Array.from({ length: fingers }, () => ({ ...touch })),
        };
        w.handleTouchStart(event);
        w.body_handleTouchEnd({ ...event, touches: [] });
        assert.deepEqual(
            calls,
            [["key", fingers === 2 ? w.keys.ENTER : w.keys.SETUP]],
            platform + " preserves " + fingers + "-finger shortcut"
        );
    }
}

for (const target of [
    { tagName: "INPUT" },
    { tagName: "TEXTAREA" },
    { tagName: "SELECT" },
    { parentElement: { isContentEditable: true } },
]) {
    const { w, calls } = touchFixture("capacitor");
    const event = {
        preventDefault() {
            assert.fail("must leave native editor touch default intact");
        },
        target,
        touches: [{ screenX: 20, screenY: 30 }],
    };
    w.handleTouchStart(event);
    w.handleTouchMove(event);
    w.body_handleTouchEnd({ ...event, touches: [] });
    assert.deepEqual(calls, []);
}

{
    const { w, calls } = touchFixture("capacitor");
    w.handleTouchStart({
        preventDefault() {},
        touches: [{ screenX: 20, screenY: 30 }],
    });
    w.handleTouchMove({
        preventDefault() {},
        touches: [{ screenX: 160, screenY: 30 }],
    });
    w.body_handleTouchEnd({
        changedTouches: [],
        preventDefault() {},
        touches: [],
    });
    assert.equal(calls.length, 1, "swipe emits a remote key, not a click");
}

// The native editor exception must not bypass touchscreen lock or its unlock gesture.
for (const fingers of [1, 4]) {
    const { w } = touchFixture("capacitor");
    w.touch_locked = true;
    let prevented = 0;
    w.handleTouchStart({
        preventDefault() {
            prevented++;
        },
        target: { tagName: "INPUT" },
        touches: Array.from({ length: fingers }, () => ({
            screenX: 20,
            screenY: 30,
        })),
    });
    assert.equal(prevented, 1);
    assert.equal(w.touch_locked, fingers !== 4);
}

// The four-finger lock uses the loaded player dictionary on each gesture.
{
    const { w } = touchFixture("capacitor");
    const messages = [];
    w.alert = (message) => messages.push(message);
    vm.runInContext(read("locales/russian.js"), w);
    w.__ottInterfaceLanguage = "_rus";
    const gesture = {
        preventDefault() {},
        touches: Array.from({ length: 4 }, () => ({
            screenX: 20,
            screenY: 30,
        })),
    };
    w.handleTouchStart(gesture);
    assert.equal(w.touch_locked, true);
    assert.equal(messages.at(-1), w.keyStrings["Touchscreen locked"]);
    assert.notEqual(messages.at(-1), "Touchscreen locked");
    vm.runInContext(read("locales/arabic.js"), w);
    w.__ottInterfaceLanguage = "_ara";
    w.handleTouchStart(gesture);
    assert.equal(w.touch_locked, false);
    assert.equal(messages.at(-1), w.keyStrings["Touchscreen unlocked"]);
    assert.notEqual(messages.at(-1), "Touchscreen unlocked");
}

// Main-window drag exclusions and the body click bands must use the same
// viewport geometry. Execute both production paths against real DOM targets.
const bandCode = functions("src/key-handler/index.ts", [
    "ottBandViewportHeight",
    "ottBottomInfoBandStart",
    "body_onClick",
]);
const indexAst = ts.createSourceFile(
    "src/index.ts",
    read("src/index.ts"),
    ts.ScriptTarget.Latest,
    true
);
const dragBindings = new Set([
    "STRIP_ID",
    "NO_DRAG_SEL",
    "DRAG_SEL",
    "SURFACE_OK_SEL",
    "isDragHandle",
]);
const dragDeclarations = [];
function visitDragDeclarations(node) {
    if (ts.isVariableDeclaration(node) && dragBindings.has(node.name.text)) {
        dragDeclarations.push("var " + node.getText(indexAst) + ";");
    }
    ts.forEachChild(node, visitDragDeclarations);
}
visitDragDeclarations(indexAst);
assert.equal(dragDeclarations.length, dragBindings.size);
const dragCode = ts.transpileModule(dragDeclarations.join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES5 },
}).outputText;

for (const [innerHeight, viewportHeight, documentHeight, expected] of [
    [800, 600, 5000, 600],
    [600, 800, 5000, 600],
    [800, undefined, 5000, 800],
    [0, 300, 5000, 300],
    [0, 0, 640, 640],
    [0, undefined, 0, 0],
]) {
    const dom = new JSDOM(
        '<!doctype html><html><body><video id="video"></video><button>Menu</button><div id="ott-tauri-drag-strip"></div></body></html>',
        { runScripts: "outside-only" }
    );
    try {
        const w = dom.window;
        require("./helpers/screen-runtime.cjs")(w);
        const calls = [];
        w.innerHeight = innerHeight;
        w.visualViewport =
            viewportHeight === undefined
                ? undefined
                : { height: viewportHeight };
        Object.defineProperty(w.document.documentElement, "clientHeight", {
            value: documentHeight,
        });
        w.document.body.getBoundingClientRect = () => {
            throw new Error(
                "body dimensions must not define the visible viewport"
            );
        };
        w.keys = { ENTER: 13 };
        w._doKey = (key) => calls.push(key);
        w.popupList = () => calls.push("popup");
        w.showChannelInfo = () => calls.push("info");
        w.listOverlayOpen = () => !!w.isListVisible;
        w.eval(bandCode + "\n" + dragCode);
        assert.equal(w.ottBandViewportHeight(), expected);
        const video = w.document.getElementById("video");
        if (!expected) {
            w.body_onClick({ clientY: 100 });
            assert.deepEqual(
                calls,
                [],
                "missing dimensions do not invent a click band"
            );
            continue;
        }
        const bottom = w.ottBottomInfoBandStart(expected);
        assert.equal(bottom, expected - Math.max(expected * 0.3, 140));
        for (const [y, action, draggable] of [
            [expected * 0.2 - 1, "popup", true],
            [expected * 0.2, 13, true],
            [bottom, 13, true],
            [bottom + 1, "info", false],
        ]) {
            calls.length = 0;
            let prevented = 0;
            let stopped = 0;
            w.body_onClick({
                clientY: y,
                preventDefault() {
                    prevented++;
                },
                stopPropagation() {
                    stopped++;
                },
            });
            assert.deepEqual(calls, [action]);
            assert.equal(prevented, action === "info" ? 1 : 0);
            assert.equal(stopped, action === "info" ? 1 : 0);
            assert.equal(w.isDragHandle(video, y), draggable);
        }
        assert.equal(
            w.isDragHandle(w.document.querySelector("button"), 10),
            false
        );
        assert.equal(
            w.isDragHandle(
                w.document.getElementById("ott-tauri-drag-strip"),
                10
            ),
            true
        );
        w.__ottTauriNativeFs = true;
        assert.equal(w.isDragHandle(video, 10), false);
        w.__ottTauriNativeFs = false;
        w.isListVisible = true;
        calls.length = 0;
        w.body_onClick({ clientY: bottom + 1 });
        assert.deepEqual(calls, []);
        assert.equal(w.isDragHandle(video, 10), false);
        w.isListVisible = false;
        for (const flag of [
            "__ottTauriSuppressClick",
            "__ottInfoBandFromMouseUp",
        ]) {
            w[flag] = true;
            w.body_onClick({ clientY: bottom + 1 });
            assert.deepEqual(
                calls,
                [],
                "drag release and mouseup handling suppress duplicate clicks"
            );
            w[flag] = false;
        }
    } finally {
        dom.window.close();
    }
}
console.log(
    "OK: shared native drag/click geometry, viewport fallbacks, exact boundaries and overlay exclusions"
);

// Execute JS extracted from each actual native bridge, with the actual loaded
// device keymap and actual TS dispatch chain. No OS or native player is mocked
// as successful by these assertions.
const dispatch = functions("src/key-handler/index.ts", [
    "cancelNativeListInertia",
    "dispatchKey",
    "keyHandler",
    "handleMainKey",
]);
const nativeSources = {
    android: read(
        "android/app/src/main/java/play/ott/foss/MediaPlaybackService.kt"
    ),
    ios: read("ios/App/App/Plugins/MobileNativeMedia.swift"),
    tauri: read("src-tauri/src/commands/media_session.rs"),
};
function nativeScript(platform, action) {
    const text = nativeSources[platform];
    const string = '"(?:\\\\.|[^"\\\\])*"';
    let match;
    if (platform === "tauri") {
        match = text.match(
            new RegExp(
                "const JS_" +
                    action.toUpperCase() +
                    ": &str = (" +
                    string +
                    ");"
            )
        );
    } else {
        const method =
            platform === "ios"
                ? {
                      next: "nextTrack",
                      pause: "pause",
                      play: "play",
                      prev: "previousTrack",
                      stop: "stop",
                  }[action] + "Command.addTarget"
                : "fun drive" +
                  action[0].toUpperCase() +
                  action.slice(1) +
                  "()";
        const block = text.slice(text.indexOf(method));
        match = block.match(
            new RegExp(
                (platform === "ios" ? "evalVideoJS" : "evalOnWebView") +
                    "\\(\\s*(" +
                    string +
                    ")"
            )
        );
    }
    assert.ok(match, platform + " " + action);
    return JSON.parse(match[1]);
}

for (const platform of Object.keys(nativeSources)) {
    for (const device of ["pc", "android"]) {
        const calls = [];
        const w = {
            isEditMode: false,
            isSelectBox: false,
            keyFun: (v) => calls.push(v),
            nativeListFrame: 0,
            nativeListInertia: null,
            settings: { nextFun: 13, prevFun: 14 },
            stbContinue: () => calls.push("continue"),
            stbEventToKeyCode: (e) => e.keyCode,
            stbIsPlaying: () => false,
            stbPause: () => calls.push("pause"),
            stbStop: () => calls.push("stop"),
            version: "",
        };
        w.window = w;
        vm.createContext(w);
        require("./helpers/screen-runtime.cjs")(w);
        vm.runInContext(
            read("devices/" + device + "/device.js") +
                "\n" +
                dispatch +
                "\nwindow._doKey=dispatchKey;",
            w
        );
        for (const action of ["next", "prev", "play", "pause", "stop"])
            vm.runInContext(nativeScript(platform, action), w);
        assert.deepEqual(
            calls,
            [13, 14, "continue", "pause", "stop"],
            platform + "/" + device
        );
    }
}

// Explicit OS Play must be idempotent even though the legacy stbContinue API
// toggles. Execute the actual core methods to avoid hiding this with a spy.
const coreControls = functions("src/core/index.ts", [
    "setCoreDemoMute",
    "isCoreThenable",
    "playCoreMedia",
    "cancelCoreSeek",
    "cancelCoreAutoPlayback",
    "cancelCoreSourcePreparation",
    "cancelCoreStreamAttempt",
    "countCoreAttempt",
    "createCoreStreamAttempt",
    "cancelCoreNativeHls",
    "destroyCoreShaka",
    "resetCoreNativeBitrate",
    "stbContinue",
    "stbPause",
    "stbResume",
    "stbStop",
    "getCoreMediaBackend",
    "openCoreEngineLease",
    "stopCoreEngine",
    "stbIsPlaying",
    "stbIsStandby",
]);
for (const platform of Object.keys(nativeSources)) {
    let destroyed = 0,
        cancelled = 0;
    let timerId = 0;
    const timers = new Map();
    const w = {
        _: (text) => text,
        _coreAutoCancel: null,
        _coreDemoMute: null,
        _coreNativeAttempt: 0,
        _coreNativeHls: null,
        _coreNativeHlsCleanup: null,
        _corePendingSeek: null,
        _corePendingSeekPosition: null,
        _corePipSession: 0,
        _coreShakaTeardown: null,
        _coreTransientPlayback: false,
        _playSession: 0,
        _standby: false,
        $: () => ({ hide() {} }),
        clearInterval() {},
        clearPlayTimeInterval() {},
        clearTimeout(id) {
            timers.delete(id);
        },
        coreAttemptCounters: {
            engineStarts: 1,
            fatalErrors: 0,
            nativeFallbacks: 0,
            streamRetries: 0,
        },
        coreAvTest: null,
        coreDeviceEffects: {},
        coreMediaBackend: null,
        coreSourcePreparationCancel() {
            cancelled++;
        },
        coreStreamAttempt: null,
        hlsInstance: {
            destroy() {
                destroyed++;
            },
        },
        setInterval() {
            return 1;
        },
        setTimeout(callback) {
            timers.set(++timerId, callback);
            return timerId;
        },
        showShift() {},
        video: {
            pause() {
                this.paused = true;
            },
            paused: true,
            play() {
                this.paused = false;
            },
            readyState: 0,
            removeAttribute() {},
        },
    };
    w.window = w;
    vm.createContext(w);
    require("./helpers/screen-runtime.cjs")(w);
    require("./helpers/private-runtime.cjs")(w, "src/device/media-backend.ts");
    w.startCoreEngine = () => {
        w._playSession++;
    };
    vm.runInContext(coreControls, w);
    w.stbResume();
    w.getCoreMediaBackend().open({ url: "fixture.mp4" });
    for (const readyState of [0, 1, 2]) {
        w.video.readyState = readyState;
        w.stbPause();
        for (let i = 0; i < 2; i++) {
            vm.runInContext(nativeScript(platform, "play"), w);
            assert.equal(
                w.video.paused,
                false,
                platform + " repeated explicit Play at readyState " + readyState
            );
            assert.equal(w.stbIsPlaying(), readyState >= 2);
        }
    }
    for (let i = 0; i < 2; i++)
        vm.runInContext(nativeScript(platform, "pause"), w);
    assert.equal(w.video.paused, true, platform + " explicit Pause");
    assert.equal(w.forcePlay, false);
    assert.equal(cancelled, 0, platform + " Pause keeps pending preparation");

    w._standby = true;
    vm.runInContext(nativeScript(platform, "play"), w);
    w.stbContinue();
    assert.equal(w.video.paused, true, platform + " Play cannot wake standby");
    w._standby = false;

    // Exercise the actual retry owner through each shipped native media action.
    // Pause retains retry intent; repeated Play schedules one attempt; Stop retires it.
    let restarted = 0;
    w.coreStreamAttempt = w.createCoreStreamAttempt(
        w._playSession,
        "fixture.mp4",
        () => restarted++
    );
    vm.runInContext(nativeScript(platform, "play"), w);
    w.coreStreamAttempt.fail("network", 503);
    assert.equal(timers.size, 1, platform + " transient failure queues retry");
    vm.runInContext(nativeScript(platform, "pause"), w);
    assert.equal(timers.size, 0, platform + " Pause defers retry");
    for (let i = 0; i < 2; i++)
        vm.runInContext(nativeScript(platform, "play"), w);
    assert.equal(timers.size, 1, platform + " repeated Play coalesces retry");
    const staleRetry = [...timers.values()][0];
    vm.runInContext(nativeScript(platform, "stop"), w);
    assert.equal(timers.size, 0, platform + " Stop cancels retry");
    staleRetry();
    assert.equal(restarted, 0, platform + " retired retry cannot restart");
    assert.equal(w.coreAttemptCounters.streamRetries, 0);
    assert.equal(w.coreStreamAttempt, null);
    assert.equal(destroyed, 1, platform + " Stop tears down HLS");
    assert.equal(cancelled, 1, platform + " Stop cancels pending preparation");
    assert.equal(w._playSession, 2);
}

// Run the shipped dedicated PiP document, including the pre-play mute assertion,
// asynchronous native/media lifecycle, decoder callbacks and frameless dragging.
require("./test_tauri_pip_window.cjs")()
    .then(() =>
        console.log(
            "OK: native touch targets/editor defaults, device media actions, TS lifecycle and silent Tauri PiP"
        )
    )
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
