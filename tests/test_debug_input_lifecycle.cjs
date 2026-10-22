const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const dom = new JSDOM('<button id="target">Select</button>', {
    runScripts: "outside-only",
    url: "https://fixture.invalid/",
});
const w = dom.window,
    d = w.document,
    target = d.getElementById("target");
const installed = [],
    removed = [],
    events = [];
for (const host of [w, d]) {
    const add = host.addEventListener.bind(host),
        remove = host.removeEventListener.bind(host);
    host.addEventListener = (name, callback, capture) => {
        installed.push({ callback, capture, host, name });
        add(name, callback, capture);
    };
    host.removeEventListener = (name, callback, capture) => {
        removed.push({ callback, capture, host, name });
        remove(name, callback, capture);
    };
}
w.version = "fixture";
w.__ottDebug = { enabled: false, push: (...args) => events.push(args) };
w.eval(
    fs.readFileSync(
        path.join(__dirname, "../devices/lg/webos/device.js"),
        "utf8"
    )
);
const read = () => JSON.parse(JSON.stringify(w.__ottDebugInputSnapshot()));
assert.deepEqual(read(), { available: true, enabled: false });
const before = installed.length;
w.__ottDebug.enabled = true;
w.__ottDebugInputInit();
const owned = installed.slice(before);
assert.equal(owned.length, 9);
w.__ottDebugInputInit();
assert.equal(
    installed.length,
    before + 9,
    "double init has no duplicate handlers"
);
let unrelated = 0;
d.addEventListener("click", () => unrelated++);
const fire = () => {
    for (const name of [
        "mousemove",
        "mousedown",
        "click",
        "wheel",
        "mousewheel",
    ])
        target.dispatchEvent(new w.Event(name, { bubbles: true }));
    d.dispatchEvent(
        new w.CustomEvent("cursorStateChange", { detail: { visibility: true } })
    );
    d.dispatchEvent(
        new w.CustomEvent("webOSMouse", { detail: { type: "Enter" } })
    );
    w.dispatchEvent(new w.Event("focus"));
};
fire();
assert.equal(unrelated, 1);
assert.deepEqual(
    [read().move, read().down, read().click, read().wheel],
    [1, 1, 1, 2]
);
assert.deepEqual(
    [read().cursor, read().area, read().focus],
    ["on", "in", "on"]
);
const copy = read();
copy.move = 999;
assert.equal(read().move, 1);
w.__ottDebugInputStop();
assert.equal(removed.length, 9);
for (const item of owned)
    assert(
        removed.some(
            (r) =>
                r.host === item.host &&
                r.name === item.name &&
                r.callback === item.callback &&
                r.capture === item.capture
        ),
        "exact callback/capture removed"
    );
assert.deepEqual(read(), { available: true, enabled: false });
assert.equal(w.__ottDebugInput, undefined);
const oldEvents = events.length;
fire();
assert.equal(unrelated, 2, "unrelated app listener survives stop");
assert.equal(events.length, oldEvents, "stopped input emits nothing");
w.__ottDebugInputStop();
assert.equal(removed.length, 9);
w.__ottDebugInputInit();
assert.deepEqual(
    [read().move, read().down, read().click, read().wheel],
    [0, 0, 0, 0]
);
for (const item of owned)
    item.callback(
        new w.CustomEvent(item.name, {
            detail: { type: "Enter", visibility: true },
        })
    );
assert.deepEqual(
    [read().move, read().down, read().click, read().wheel],
    [0, 0, 0, 0],
    "old callbacks cannot enter a new generation"
);
fire();
assert.equal(read().move, 1);
assert.equal(read().wheel, 2);
w.dispatchEvent(new w.Event("blur"));
assert.equal(read().focus, "off");
w.__ottDebugInputStop();
assert.equal(removed.length, 18);
dom.window.close();
console.log(
    "PASS LG diagnostic input lifecycle: exact cleanup, no duplicates, restart, immutable snapshot, unrelated handlers and stale callbacks"
);
