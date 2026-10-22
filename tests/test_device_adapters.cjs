const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const acorn = require("acorn");

const adapters = [
    "android",
    "dune",
    "mag",
    "spark",
    "lg/webos",
    "samsung/tizen",
    "samsung/maple",
];
for (const adapter of adapters) {
    const file = path.join(__dirname, "..", "devices", adapter, "device.js");
    const code = fs.readFileSync(file, "utf8");
    acorn.parse(code, { ecmaVersion: 5 });
    for (const result of [undefined, true, false, { then() {} }]) {
        const calls = [];
        const callbacks = [];
        let readyCalls = 0;
        const deviceCalls = [];
        const cursorChanges = [];
        const w = {
            Android: {},
            Common: { API: {} },
            console: { log() {} },
            Dune: {},
            gSTB: { GetMACAddress: () => "device-mac" },
            onStbReady() {
                readyCalls++;
            },
            STB: {},
            stb: { getMacAddress: () => "base-mac" },
            stbInit() {
                calls.push({ args: Array.from(arguments), receiver: this });
                if (result === false) callbacks.push(() => w.onStbReady());
                return result;
            },
            tizen: {},
            version: "test",
            webOS: {
                app: { requestWindowFocus: () => deviceCalls.push("focus") },
                device: {
                    cursorVisible: (visible) => cursorChanges.push(visible),
                },
                platform: {
                    setWindowOrientation: () => deviceCalls.push("orientation"),
                },
                system: { hideSplashScreen: () => deviceCalls.push("splash") },
            },
        };
        w.window = w;
        vm.createContext(w);
        const originalInit = w.stbInit;
        vm.runInContext(code, w, { filename: file });
        assert.notEqual(
            w.stbInit,
            originalInit,
            adapter + " installs its wrapper"
        );
        assert.equal(
            calls.length,
            0,
            adapter + " must not initialize while loading"
        );
        const receiver = { name: "caller" };
        const actual = w.stbInit.call(receiver, "argument");
        assert.equal(
            calls.length,
            1,
            adapter + " must call the original initializer once"
        );
        assert.equal(calls[0].receiver, receiver);
        assert.deepEqual(calls[0].args, ["argument"]);
        assert.equal(
            actual,
            result,
            adapter + " must preserve false/async return contracts"
        );
        assert.equal(
            readyCalls,
            0,
            adapter + " must not finish an asynchronous initializer early"
        );
        callbacks.forEach((callback) => callback());
        assert.equal(readyCalls, result === false ? 1 : 0);
        if (adapter === "mag")
            assert.equal(w.stb.getMacAddress(), "device-mac");
        if (adapter === "lg/webos") {
            assert.deepEqual(
                cursorChanges,
                [],
                "LG initialization must preserve Magic Remote pointer mode"
            );
            assert.deepEqual(deviceCalls, ["splash", "orientation", "focus"]);
        }
    }
    // Native platform APIs are optional; an absent API must retain the base result too.
    const w = {
        stb: { getMacAddress: () => "base-mac" },
        stbInit: () => false,
        version: "test",
    };
    w.window = w;
    vm.createContext(w);
    vm.runInContext(code, w, { filename: file });
    assert.equal(
        w.stbInit(),
        false,
        adapter + " must preserve deferred init without platform APIs"
    );
}
// Some hosted webOS engines deliver semantic/page keys rather than TV codes.
// Native codes and all other base codec behavior remain authoritative.
{
    const file = path.join(__dirname, "..", "devices/lg/webos/device.js");
    const listeners = [];
    const routed = [];
    const exitTimers = [];
    const historyReturns = [];
    let historyWrites = 0;
    let exitCalls = 0;
    const originalState = { caller: "host" };
    const w = {
        addEventListener(name, callback) {
            assert.equal(name, "popstate");
            listeners.push(callback);
        },
        history: {
            go(offset) {
                historyReturns.push(offset);
            },
            length: 2,
            pushState(state, title) {
                assert.equal(title, "");
                historyWrites++;
                this.state = state;
                this.length = 3;
            },
            replaceState(state) {
                this.state = state;
            },
            state: originalState,
        },
        keyHandler(event) {
            routed.push(event.keyCode);
            event.preventDefault();
            event.stopPropagation();
        },
        setTimeout(callback, delay) {
            assert.equal(delay, 100);
            exitTimers.push(callback);
        },
        stbEventToKeyCode: (event) => event.keyCode || event.which || 991,
        stbExit() {
            exitCalls++;
            return "base exit";
        },
        stbInit: () => false,
        version: "test",
    };
    w.window = w;
    vm.createContext(w);
    vm.runInContext(fs.readFileSync(file, "utf8"), w, { filename: file });
    for (const [event, expected] of [
        [{ keyCode: 427 }, 427],
        [{ which: 428 }, 428],
        [{ keyCode: 33 }, 427],
        [{ keyCode: 34 }, 428],
        [{ key: "ChannelUp" }, 427],
        [{ code: "ChannelDown" }, 428],
        [{ code: "ChannelUp", key: "Unidentified" }, 427],
        [{ key: "PageUp" }, 427],
        [{ key: "PageDown" }, 428],
        [{ key: "BrowserBack" }, 461],
        [{ code: "GoBack" }, 461],
        [{ keyCode: 403 }, 403],
        [{ keyCode: 404 }, 404],
        [{ keyCode: 405 }, 405],
        [{ keyCode: 406 }, 406],
        [{ key: "ColorF0Red" }, 403],
        [{ key: "ColorF1Green" }, 404],
        [{ key: "ColorF2Yellow" }, 405],
        [{ key: "ColorF3Blue" }, 406],
        [{ code: "ColorF2Yellow", key: "Unidentified" }, 405],
        [{ code: "ColorF3Blue", key: "Unidentified" }, 406],
        [{ key: "ColorF3Blue", keyCode: 403 }, 403],
        [{ key: "ChannelUp", keyCode: 39 }, 39],
        [{ key: "unhandled" }, 991],
        [null, 0],
    ])
        assert.equal(w.stbEventToKeyCode(event), expected);
    assert.equal(historyWrites, 0, "loading the adapter does not navigate");
    w.stbInit();
    w.stbInit();
    assert.equal(listeners.length, 1, "initialization binds Back once");
    assert.equal(historyWrites, 1, "initialization adds one same-page entry");
    assert.deepEqual(originalState, { caller: "host" });
    listeners[0]({ state: originalState });
    assert.deepEqual(routed, [461], "history Back enters normal modal routing");
    assert.equal(historyWrites, 2, "history guard is rearmed before routing");
    listeners[0]({ state: w.history.state });
    assert.deepEqual(
        routed,
        [461],
        "forward to the guard does not repeat Back"
    );
    assert.equal(w.stbExit(), "base exit");
    assert.equal(exitCalls, 1, "confirmed exit preserves the base exit");
    assert.equal(
        historyReturns.length,
        0,
        "native close gets the first chance"
    );
    assert.equal(exitTimers.length, 1);
    exitTimers[0]();
    assert.deepEqual(
        historyReturns,
        [-2],
        "blocked close returns past our entry"
    );
    listeners[0]({ state: originalState });
    assert.deepEqual(routed, [461], "confirmed exit releases history control");
    assert.equal(historyWrites, 2);
    w.stbExit();
    assert.equal(exitTimers.length, 1, "exit fallback is scheduled only once");
}
console.log(
    "OK: seven ES5 device adapters call base init once and preserve deferred readiness"
);
