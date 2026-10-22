const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const { JSDOM } = require("jsdom");
const dom = new JSDOM(
    '<button id="launch">Open</button><div id="listCaption">Programme guide</div><div id="listIn"><div class="item" data-idx="8" tabindex="0">Eight</div><div class="item" data-idx="9" tabindex="-1">Nine</div></div><div id="listAbout" style="display:none"><button id="back">Back</button><button id="next">Next</button></div><div id="dialogbox" style="display:none"><button id="yes">Yes</button><button id="no">No</button></div><div id="listEdit" style="display:none"><input></div>',
    { runScripts: "outside-only" }
);
const h = dom.window,
    d = h.document,
    timers = [],
    listeners = new Map();
h._ = (s) => s;
h.setTimeout = (f) => timers.push(f);
h.$ = (node) => ({
    on(event, callback) {
        let map = listeners.get(node);
        if (!map) listeners.set(node, (map = {}));
        map[event.split(".")[0]] = callback;
        return this;
    },
});
function flush() {
    while (timers.length) timers.shift()();
}
function show(id) {
    const node = d.getElementById(id);
    listeners.get(node).show();
    node.style.display = "block";
    flush();
}
function hide(id) {
    const node = d.getElementById(id);
    listeners.get(node).hide();
    node.style.display = "none";
    flush();
}
function tab(shift = false) {
    const event = new h.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Tab",
        keyCode: 9,
        shiftKey: shift,
    });
    d.activeElement.dispatchEvent(event);
    return event;
}
vm.runInContext(
    ts.transpileModule(fs.readFileSync("src/ui/accessibility.ts", "utf8"), {
        compilerOptions: { target: ts.ScriptTarget.ES5 },
    }).outputText,
    dom.getInternalVMContext()
);
h.__ottAccessibility.install();
h.__ottAccessibility.install();
d.getElementById("launch").focus();
show("listAbout");
assert.equal(d.activeElement.id, "back");
assert.equal(
    d.getElementById("listAbout").getAttribute("aria-label"),
    "Programme guide"
);
d.getElementById("next").focus();
assert.equal(tab().defaultPrevented, true);
assert.equal(d.activeElement.id, "back");
assert.equal(tab(true).defaultPrevented, true);
assert.equal(d.activeElement.id, "next");
show("dialogbox");
assert.equal(d.activeElement.id, "dialogbox");
assert.equal(tab().defaultPrevented, true);
assert.equal(d.activeElement.id, "yes");
hide("dialogbox");
assert.equal(d.activeElement.id, "next");
hide("listAbout");
assert.equal(d.activeElement.id, "launch");
const list = d.getElementById("listIn");
h.__ottAccessibility.select(list, 9, true);
assert.equal(d.activeElement.textContent, "Nine");
assert.deepEqual(
    Array.from(list.children, (n) => [
        n.tabIndex,
        n.getAttribute("aria-selected"),
    ]),
    [
        [-1, "false"],
        [0, "true"],
    ]
);
// Mouse focus must not pre-select a row and turn the first PC click into Enter.
h.selIndex = 9;
const moves = [];
h.changeSelect = (delta) => {
    moves.push(delta);
    h.selIndex += delta;
};
list.children[0].dispatchEvent(
    new h.MouseEvent("mousedown", { bubbles: true })
);
list.children[0].focus();
assert.deepEqual(moves, []);
flush();
list.children[1].focus();
list.children[0].focus();
assert.deepEqual(moves, [-1], "non-pointer focus still synchronizes selection");
show("listEdit");
assert.equal(
    d.activeElement.tagName,
    "INPUT",
    "native editor keeps input focus"
);
hide("listEdit");
list.children[1].focus();
// An obsolete zero-delay open must not steal focus after dismissal.
listeners.get(d.getElementById("listAbout")).show();
listeners.get(d.getElementById("listAbout")).hide();
flush();
assert.equal(d.activeElement.textContent, "Nine");
dom.window.close();
console.log(
    "Classic accessibility: focus trap, nested return, labels, roving selection and stale-open checks passed"
);
