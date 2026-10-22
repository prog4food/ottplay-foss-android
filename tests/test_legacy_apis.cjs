const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");

function compile(file, names) {
    const ast = ts.createSourceFile(
        file,
        fs.readFileSync(path.join(root, file), "utf8"),
        ts.ScriptTarget.Latest,
        true
    );
    const statements = ast.statements.filter(
        (node) =>
            !ts.isImportDeclaration(node) &&
            (!names ||
                (ts.isFunctionDeclaration(node) &&
                    names.includes(node.name.text)))
    );
    if (names) assert.equal(statements.length, names.length);
    return ts.transpileModule(
        statements
            .map((node) => node.getText(ast).replace(/^export\s+/, ""))
            .join("\n"),
        {
            compilerOptions: {
                module: ts.ModuleKind.None,
                target: ts.ScriptTarget.ES5,
            },
        }
    ).outputText;
}

const storageCode = compile("src/storage/index.ts");
function storageFixture(
    mode,
    cookiesDenied = false,
    persisted,
    contextOnly = false
) {
    const saved = persisted ? persisted.saved : { original: "keep me" };
    const cookies = persisted
        ? persisted.cookies
        : { malformed: "%ZZ", valid: "stored" };
    const document = {};
    Object.defineProperty(document, "cookie", {
        get() {
            if (cookiesDenied) throw new Error("Cookie SecurityError");
            return Object.keys(cookies)
                .map((key) => key + "=" + cookies[key])
                .join("; ");
        },
        set(value) {
            if (cookiesDenied) throw new Error("Cookie SecurityError");
            if (persisted && persisted.cookieWrites)
                persisted.cookieWrites.push(value);
            if (
                persisted &&
                persisted.cookieLimit &&
                Buffer.byteLength(value, "utf8") > persisted.cookieLimit
            )
                return;
            if (
                persisted &&
                persisted.rejectCookie &&
                persisted.rejectCookie(value)
            )
                return;
            const pair = value.split(";")[0];
            const equals = pair.indexOf("=");
            const key = pair.slice(0, equals);
            if (value.includes("1970")) delete cookies[key];
            else cookies[key] = pair.slice(equals + 1);
        },
    });
    let keyReads = 0;
    const local = {
        clear() {
            if (mode === "clear") throw new Error("SecurityError");
            for (const key of Object.keys(saved)) delete saved[key];
        },
        getItem(key) {
            if (mode === "read" || (persisted && persisted.failReadKey === key))
                throw new Error("SecurityError");
            return Object.hasOwn(saved, key) ? saved[key] : null;
        },
        key(index) {
            if (mode === "dump" && ++keyReads === 1)
                throw new Error("Transient enumeration failure");
            return Object.keys(saved)[index];
        },
        get length() {
            return Object.keys(saved).length;
        },
        removeItem(key) {
            if (mode === "remove") throw new Error("SecurityError");
            delete saved[key];
        },
        setItem(key, value) {
            if (mode === "write") throw new Error("QuotaExceededError");
            saved[key] = value;
        },
    };
    const c = vm.createContext({ console, document, localStorage: local });
    c.window = c;
    require("./helpers/screen-runtime.cjs")(c);
    if (mode === "access")
        Object.defineProperty(c, "localStorage", {
            get() {
                throw new Error("SecurityError");
            },
        });
    if (mode === "missing") c.localStorage = undefined;
    vm.runInContext(storageCode, c);
    return contextOnly ? c : c.storage;
}
for (const mode of ["write", "remove", "dump"]) {
    const storage = storageFixture(mode, false, {
        cookies: {},
        saved: { original: "kept" },
    });
    if (mode === "write") storage.set("ordinary", "new");
    else if (mode === "remove") storage.del("ordinary");
    else storage.dump();
    assert.equal(storage.get("original"), "kept");
    assert.equal(
        storage.get("parentPIN"),
        null,
        mode + ": complete failover proves PIN absence"
    );
}
{
    const storage = storageFixture("write", false, {
        cookies: {},
        failReadKey: "original",
        saved: { original: "unreadable" },
    });
    storage.set("ordinary", "new");
    assert.equal(
        storage.get("parentPIN"),
        "!locked-invalid-pin",
        "incomplete failover must not invent PIN absence"
    );
}
for (const mode of ["read"]) {
    const storage = storageFixture(mode, false, {
        cookies: {},
        saved: { parentPIN: "9876" },
    });
    assert.equal(
        storage.get("parentPIN"),
        "!locked-invalid-pin",
        mode + ": unreadable native PIN must not become default1234"
    );
}
assert.equal(
    storageFixture("native", false, {
        cookies: { parentPIN: "%ZZ" },
        saved: {},
    }).get("parentPIN"),
    null
);
assert.equal(
    storageFixture("missing", false, {
        cookies: { parentPIN: "%ZZ" },
        saved: {},
    }).get("parentPIN"),
    "!locked-invalid-pin"
);
assert.equal(
    storageFixture("missing", true).get("parentPIN"),
    "!locked-invalid-pin"
);
assert.equal(
    storageFixture("missing", false, {
        cookies: { parentPIN: "9876" },
        saved: {},
    }).get("parentPIN"),
    "9876",
    "readable legacy cookies remain usable"
);
{
    const { JSDOM } = require("jsdom");
    const dom = new JSDOM("", {
        runScripts: "outside-only",
        url: "https://example.invalid",
    });
    Object.defineProperty(dom.window, "localStorage", {
        get() {
            throw new Error("denied");
        },
    });
    dom.window.eval(storageCode);
    assert.equal(dom.window.storage.get("parentPIN"), "!locked-invalid-pin");
    dom.window.close();
}
function persistedOverrides(state) {
    const runtime = storageFixture("native", false, state, true);
    const keys = runtime.readStorageFallback(runtime.readStorageCookies());
    return keys && Array.from(keys);
}
for (const mode of ["native", "access", "read", "write", "missing"]) {
    for (const cookiesDenied of [false, true]) {
        const storage = storageFixture(mode, cookiesDenied);
        const key = "provider/[name] ä=key";
        storage.set(key, "value & %; preserved");
        assert.equal(storage.get(key), "value & %; preserved", mode);
        assert(storage.has(key));
        assert(storage.hasValue(key));
        if (mode === "write")
            assert.equal(
                storage.get("original"),
                "keep me",
                "Quota failover keeps readable native keys"
            );
        storage.set("empty", "");
        assert(storage.has("empty"));
        assert(!storage.hasValue("empty"));
        storage.setI("count", 17);
        assert.equal(storage.getI("count"), 17);
        assert.equal(storage.getI("missing", 9), 9);
        assert.equal(storage.dump()[key], "value & %; preserved");
        storage.del(key);
        assert.equal(storage.get(key), null);
        assert(!storage.has(key));
        storage.clear();
        assert.equal(Object.keys(storage.dump()).length, 0);
        assert.equal(storage.get("original"), null);
        storage.set("after-clear", "works");
        assert.equal(storage.get("after-clear"), "works");
    }
}
// A remote persistence receipt must describe a fresh boot, not session memory.
for (const mode of ["native", "access", "read", "write", "missing"]) {
    for (const denied of [false, true]) {
        const state = { cookies: {}, saved: { aspect: "fit" } };
        const runtime = storageFixture(mode, denied, state, true);
        runtime.storage.set("aspect", "fill");
        const before = JSON.stringify(state);
        assert.equal(
            runtime.stbGetPersistedItem("aspect"),
            storageFixture(mode, denied, state).get("aspect"),
            "Persisted read follows fresh boot: " + mode + "/" + denied
        );
        assert.equal(JSON.stringify(state), before, "Durability read is pure");
        assert.equal(
            runtime.stbGetPersistedItem("ottplayStorageFallback"),
            null
        );
    }
}
{
    const state = { cookies: {}, saved: { aspect: "fit" } };
    const runtime = storageFixture("write", true, state, true);
    runtime.storage.set("aspect", "fill");
    assert.equal(runtime.storage.get("aspect"), "fill");
    assert.equal(runtime.stbGetPersistedItem("aspect"), "fit");
    assert.equal(runtime.stbGetPersistedItem("missing"), null);
}
const cookieStorage = storageFixture("missing");
assert.equal(cookieStorage.get("valid"), "stored");
assert.equal(cookieStorage.get("malformed"), null);

// A failed write must stay authoritative after a fresh adapter/bootstrap,
// without exposing internal fallback bookkeeping in backups.
const persistent = { cookies: {}, saved: { ottplaylang: "_eng" } };
const quota = storageFixture("write", false, persistent);
quota.set("ottplaylang", "_rus");
quota.set("ottplaylangmode", "system");
assert.equal(persistent.saved.ottplaylang, "_eng");
const restarted = storageFixture("native", false, persistent);
assert.equal(restarted.get("ottplaylang"), "_rus");
assert.equal(restarted.get("ottplaylangmode"), "system");
assert.equal(restarted.dump().ottplaylang, "_rus");
assert(!Object.hasOwn(restarted.dump(), "ottplayStorageFallback"));
restarted.set("ottplaylang", "_fra");
assert.equal(
    storageFixture("native", false, persistent).get("ottplaylang"),
    "_fra"
);
assert.equal(
    storageFixture("native", false, persistent).get("ottplaylangmode"),
    "system"
);
const removal = storageFixture("remove", false, persistent);
removal.del("ottplaylang");
assert.equal(
    storageFixture("native", false, persistent).get("ottplaylang"),
    null
);
const clearing = storageFixture("clear", false, persistent);
clearing.clear();
assert.deepEqual(
    Object.keys(storageFixture("native", false, persistent).dump()),
    []
);

// A quota failure snapshots readable native keys without marking every copy as
// an override. After native storage recovers, changes must invalidate those old
// snapshots too: a later denied-storage boot must not resurrect them.
for (const operation of ["set", "del", "clear"]) {
    const state = {
        cookies: {},
        saved: { ottplaylang: "_eng", playlist: "original playlist" },
    };
    const failed = storageFixture("write", false, state);
    failed.set("preferredAudioLanguage", "_rus");
    assert.equal(state.cookies.ottplaylang, "_eng");
    assert.deepEqual(
        persistedOverrides(state),
        ["preferredAudioLanguage"],
        "The language snapshot is unmarked; the failed write is authoritative"
    );
    const recovered = storageFixture("native", false, state);
    if (operation === "set") recovered.set("ottplaylang", "_fra");
    else if (operation === "del") recovered.del("ottplaylang");
    else recovered.clear();
    assert.equal(
        recovered.get("ottplaylang"),
        operation === "set" ? "_fra" : null
    );
    const denied = storageFixture("access", false, state);
    assert.equal(
        denied.get("ottplaylang"),
        null,
        operation + " must not leave a stale language for a denied-storage boot"
    );
    assert(!Object.hasOwn(denied.dump(), "ottplaylang"));
    if (operation === "clear") {
        assert.deepEqual(Object.keys(denied.dump()), []);
        assert.deepEqual(state.saved, {});
        assert.deepEqual(state.cookies, {});
    } else {
        assert.equal(denied.get("preferredAudioLanguage"), "_rus");
        assert.equal(recovered.get("preferredAudioLanguage"), "_rus");
        assert.equal(denied.get("playlist"), "original playlist");
        assert.deepEqual(
            persistedOverrides(state),
            ["preferredAudioLanguage"],
            "Changing one native key preserves unrelated cookie overrides"
        );
        // A subsequent quota failure copies the current native state, so it
        // can restore an updated value, but never a successfully deleted one.
        storageFixture("write", false, state).set("another", "pending");
        assert.equal(
            storageFixture("access", false, state).get("ottplaylang"),
            operation === "set" ? "_fra" : null
        );
    }
}

// Cookie setters silently reject oversized encoded writes in real browsers.
// Multiple small value cookies must not lose precedence when their key index grows.
const boundedCookies = {
    cookieLimit: 4096,
    cookies: {},
    cookieWrites: [],
    saved: { ottplaylang: "_eng" },
};
const boundedStorage = storageFixture("write", false, boundedCookies);
for (let index = 0; index < 12; index++) {
    const key = "provider-" + index + ":" + "настройка🎬".repeat(20);
    boundedCookies.saved[key] = "old";
    boundedStorage.set(key, "new");
}
boundedStorage.set("ottplaylang", "_rus");
assert.equal(
    storageFixture("native", false, boundedCookies).get("ottplaylang"),
    "_rus",
    "Bounded marker persists the newest override after reload"
);
const markerName = "ottplayStorageFallback";
const metadataNames = (state) =>
    Object.keys(state.cookies).filter(
        (key) => key === markerName || key.startsWith(markerName + ".")
    );
const copyState = (state) => ({
    cookieLimit: 4096,
    cookies: { ...state.cookies },
    cookieWrites: [],
    saved: { ...state.saved },
});
const completeBounded = copyState(boundedCookies);
assert(
    metadataNames(completeBounded).length > 2,
    "The real writer produced multiple parts"
);
for (const key of Object.keys(boundedCookies.saved))
    assert.equal(
        storageFixture("native", false, boundedCookies).get(key),
        key === "ottplaylang" ? "_rus" : "new"
    );
for (const write of boundedCookies.cookieWrites) {
    const name = decodeURIComponent(write.split("=")[0]);
    if (name === markerName || name.startsWith(markerName + "."))
        assert(
            Buffer.byteLength(write, "utf8") <= 4096,
            "Encoded marker names, values and attributes fit the cookie limit"
        );
}
for (const mode of ["native", "access"])
    assert(
        !Object.keys(storageFixture(mode, false, boundedCookies).dump()).some(
            (key) => key.startsWith(markerName)
        )
    );

// Existing single-cookie installations migrate on the next fallback change.
const legacyMarker = {
    cookieLimit: 4096,
    cookies: {
        [markerName]: encodeURIComponent('["ottplaylang"]'),
        ottplaylang: "_rus",
    },
    saved: { ottplaylang: "_eng" },
};
assert.equal(
    storageFixture("native", false, legacyMarker).get("ottplaylang"),
    "_rus"
);
storageFixture("write", false, legacyMarker).set("ottplaylangmode", "system");
assert.equal(
    JSON.parse(decodeURIComponent(legacyMarker.cookies[markerName])).v,
    2
);
assert.deepEqual(persistedOverrides(legacyMarker), [
    "ottplaylang",
    "ottplaylangmode",
]);

// A long single key may span multiple metadata parts; no stale native value
// may survive its tombstone, even if the key itself cannot fit a value cookie.
const longKey = "長い設定🎬".repeat(350);
const longState = {
    cookieLimit: 4096,
    cookies: {},
    cookieWrites: [],
    saved: { [longKey]: "must stay deleted" },
};
storageFixture("remove", false, longState).del(longKey);
assert(metadataNames(longState).length > 2);
assert.equal(storageFixture("native", false, longState).get(longKey), null);
for (const write of longState.cookieWrites)
    if (write.startsWith(markerName)) assert(Buffer.byteLength(write) <= 4096);

// Shrinking the set cleans old parts, and a successful full clear removes the
// manifest and orphan parts without exposing them through user backups.
const shrinking = storageFixture("native", false, boundedCookies);
for (const key of Object.keys(boundedCookies.saved))
    if (key !== "ottplaylang") shrinking.set(key, "recovered");
assert.deepEqual(metadataNames(boundedCookies).sort(), [
    markerName,
    markerName + ".0",
]);
assert.deepEqual(persistedOverrides(boundedCookies), ["ottplaylang"]);
shrinking.clear();
assert.deepEqual(boundedCookies.cookies, {});
assert.deepEqual(boundedCookies.saved, {});
shrinking.set("after-clear", "new native value");
assert.equal(shrinking.get("after-clear"), "new native value");

// Rejected pending writes cannot publish either parts or value cookies. The
// attempted edit stays in session memory; persistence is impossible under this
// metadata policy, so the previously committed cookie transaction is retained.
const noPending = copyState(completeBounded);
const beforePending = { ...noPending.cookies };
noPending.saved.later = "previous native";
noPending.rejectCookie = (value) => value.startsWith(markerName + "=pending;");
const sessionOnly = storageFixture("write", false, noPending);
sessionOnly.set("later", "session-only edit");
assert.equal(sessionOnly.get("later"), "session-only edit");
assert.equal(
    decodeURIComponent(noPending.cookies.later),
    "previous native",
    "Rejected barrier must not publish the new value"
);
for (const key of metadataNames(noPending))
    assert.equal(noPending.cookies[key], beforePending[key]);

// A rejected part or final manifest must leave the durable barrier visible,
// including migration from the old single-cookie format.
for (const rejected of ["part", "ready"]) {
    const state = copyState(legacyMarker);
    state.rejectCookie = (value) =>
        rejected === "part"
            ? value.startsWith(markerName + ".1=")
            : value.startsWith(markerName + "=%7B");
    const fallback = storageFixture("write", false, state);
    for (let i = 0; i < 5; i++)
        fallback.set("large-" + i + ":" + "設定🎬".repeat(80), "new");
    fallback.set("ottplaylang", "_fra");
    assert.equal(state.cookies[markerName], "pending");
    assert.equal(persistedOverrides(state), null);
    assert.equal(
        storageFixture("native", false, state).get("ottplaylang"),
        "_fra"
    );
}

// Missing/corrupt/evicted markers fail closed. Later edits cannot manufacture a
// partial ready list and revive unknown deleted overrides on the next reload.
for (const corrupt of [
    "missing-part",
    "missing-manifest",
    "bad-part",
    "bad-json",
    "bad-percent",
    "bad-type",
]) {
    const state = copyState(completeBounded);
    if (corrupt === "missing-part") delete state.cookies[markerName + ".0"];
    if (corrupt === "missing-manifest") delete state.cookies[markerName];
    if (corrupt === "bad-part")
        state.cookies[markerName + ".0"] = encodeURIComponent("wrong bytes");
    if (corrupt === "bad-json") state.cookies[markerName] = "%7B";
    if (corrupt === "bad-percent") state.cookies[markerName] = "%ZZ";
    if (corrupt === "bad-type")
        state.cookies = {
            [markerName]: encodeURIComponent("[42]"),
            ottplaylang: "_rus",
        };
    state.saved.deleted = "stale deleted native";
    const runtime = storageFixture("native", false, state);
    assert.equal(runtime.get("ottplaylang"), "_rus", corrupt);
    assert.equal(
        runtime.get("deleted"),
        null,
        corrupt + " must not copy stale native snapshots"
    );
    runtime.set("later", "cookie edit");
    assert.equal(state.cookies[markerName], "pending");
    const again = storageFixture("native", false, state);
    assert.equal(again.get("deleted"), null);
    assert.equal(again.get("later"), "cookie edit");
    again.clear();
    assert.deepEqual(state.saved, {});
    assert.deepEqual(state.cookies, {});
}

// Failed clear must retain tombstones that already have no value cookie.
const tombstones = {
    cookieLimit: 4096,
    cookies: {},
    saved: { kept: "old", removed: "old" },
};
const deletion = storageFixture("remove", false, tombstones);
deletion.del("removed");
deletion.set("kept", "new");
storageFixture("clear", false, tombstones).clear();
assert.deepEqual(
    Object.keys(storageFixture("native", false, tombstones).dump()),
    []
);
assert.equal(storageFixture("native", false, tombstones).get("removed"), null);

// Metadata cannot be imported, surfaced as a setting, or recopied by failover;
// similarly named real application settings remain ordinary portable data.
const reservedState = {
    cookies: {},
    saved: {
        [markerName]: "not a setting",
        [markerName + ".0"]: "not a setting",
        ottplayStorageFallbackUser: "ordinary",
    },
};
const reserved = storageFixture("write", false, reservedState, true);
reserved.storage.set(markerName + ".injected", "forbidden");
reserved.storage.del(markerName);
reserved.storage.set("trigger", "fallback");
assert.equal(reserved.storage.get(markerName), null);
assert.equal(reserved.storage.get(markerName + ".0"), null);
assert(!Object.hasOwn(reserved.storage.dump(), markerName + ".0"));
assert(!Object.hasOwn(reserved.stbGetAllItems(), markerName));
assert.equal(reserved.storage.get("ottplayStorageFallbackUser"), "ordinary");
require("./helpers/shared-core-runtime.cjs")(reserved, { vendorOnly: true });
assert(reserved.isPortableSettingsKey("ottplayStorageFallbackUser"));
assert(!reserved.isPortableSettingsKey(markerName));
assert(!reserved.isPortableSettingsKey(markerName + ".0"));
assert.deepEqual(
    Object.keys(
        reserved.portableSettingsSnapshot({
            [markerName]: "bad",
            [markerName + ".1"]: "bad",
            ordinary: "good",
        })
    ),
    ["ordinary"]
);

for (const mode of ["access", "read", "missing", "native", "write"]) {
    const runtime = storageFixture(mode, false, undefined, true);
    vm.runInContext(
        compile("src/index.ts", ["hasReadableLocalStorage"]),
        runtime
    );
    assert.equal(
        runtime.hasReadableLocalStorage(),
        mode === "native" || mode === "write",
        "client_can storage detection: " + mode
    );
}

// ErrorEvent.error can be null (for example for opaque script failures).
// Reporting that failure must not throw from the error handler itself.
const reports = [];
const errorContext = vm.createContext({
    console: { error() {} },
    sendClientFeedback(message) {
        reports.push(message);
    },
});
errorContext.window = errorContext;
vm.runInContext(compile("src/app/init.ts"), errorContext);
for (const error of [null, undefined, { stack: "retained stack" }]) {
    assert.equal(
        errorContext.onerror({ error, message: "script failure" }),
        true
    );
    assert.equal(
        reports.pop(),
        "window_onerror::script failure__<no_url>__??:??__" +
            (error ? error.stack : "<no_stack>")
    );
}

// A native performance.now does not imply Date.now exists in the host engine.
const dateContext = vm.createContext({
    performance: {
        now() {
            return 42;
        },
    },
});
dateContext.window = dateContext;
vm.runInContext(
    "Date.now = undefined;" +
        fs.readFileSync(path.join(root, "js/runtime-polyfills.js"), "utf8"),
    dateContext
);
assert.equal(vm.runInContext("typeof Date.now()", dateContext), "number");
assert.equal(dateContext.performance.now(), 42);

// Old WebKit mouse events have no Element.closest; the installed jQuery provides it.
const handlers = {};
const nodes = {};
function node(id) {
    return (nodes[id] ||= {
        addEventListener(type, callback) {
            handlers[id + ":" + type] = callback;
        },
        contains() {
            return true;
        },
        focus() {},
        getAttribute(name) {
            return this[name] || null;
        },
        id,
        nodeType: 1,
        removeEventListener() {},
        style: {},
        value: "",
    });
}
function $(target) {
    const chain = new Proxy(
        {},
        {
            get(_obj, key) {
                if (key === "val") return () => node("editvar").value;
                if (key === "closest")
                    return (selector) => {
                        let current = target;
                        while (current) {
                            if (current.selector === selector) return [current];
                            current = current.parent;
                        }
                        return [];
                    };
                return () => chain;
            },
        }
    );
    return chain;
}
$.each = (items, callback) =>
    items.forEach((item, index) => callback(index, item));
$.fn = { hide() {}, show() {} };
const selected = [];
const keys = [];
const savedValues = [];
const windowEvents = new EventTarget();
const runtimeErrors = [];
const c = vm.createContext({
    _: (value) => value,
    _doKey(key) {
        keys.push(key);
    },
    $,
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
    console: { ...console, error: (...args) => runtimeErrors.push(args) },
    document: {
        getElementById: node,
        querySelector() {
            return {};
        },
    },
    jQuery: $,
    keys: { ENTER: 13, EXIT: 27, RETURN: 8 },
    list_OnClick() {},
    removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
    restoreListPanelState() {},
    saveListPanelState() {},
    setEdit() {
        savedValues.push(c.editvar);
    },
    setSelect(index) {
        selected.push(index);
    },
});
c.window = c;
require("./helpers/screen-runtime.cjs")(c);
vm.runInContext(
    compile("src/utils/helpers.ts", [
        "metadataText",
        "metadataImageUrl",
        "metadataCssUrl",
        "metadataHtml",
        "hasTmdbService",
    ]) +
        compile("src/ui/index.ts", [
            "usesLgPointerInput",
            "uiInit",
            "showEditKey2",
            "editKey2",
        ]),
    c
);
c.uiInit();
const row = {
    getAttribute(name) {
        return name === "data-idx" ? "3" : null;
    },
    nodeType: 1,
    selector: ".item",
};
const button = {
    getAttribute() {
        return "13";
    },
    nodeType: 1,
    selector: "span[data-ott-key]",
};
function click(target) {
    return {
        preventDefault() {},
        stopImmediatePropagation() {},
        stopPropagation() {},
        target,
    };
}
handlers["listIn:click"](click({ nodeType: 1, parent: row }));
assert.deepEqual(selected, [3]);
handlers["listPodval:click"](click({ nodeType: 1, parent: button }));
assert.deepEqual(keys, [13]);
handlers["listIn:click"](click({ nodeType: 1, selector: ".list-scroll" }));
assert.deepEqual(selected, [3]);

c.editvar = 'password&copy;="quoted"<literal>';
c.showEditKey2();
assert.equal(
    node("editvar").value,
    c.editvar,
    "Input values must not be decoded as HTML entities"
);
const inputKey = handlers["editvar:keydown"];
let compositionStopped = false;
inputKey({
    ...click(node("editvar")),
    isComposing: true,
    key: "Enter",
    preventDefault() {
        assert.fail("IME composition default must be preserved");
    },
    stopPropagation() {
        compositionStopped = true;
    },
});
assert(
    compositionStopped,
    "IME Enter must not bubble into the player key router"
);
inputKey({ ...click(node("editvar")), keyCode: 229 });
assert.equal(
    savedValues.length,
    0,
    "IME composition must not submit the input"
);
inputKey({ ...click(node("editvar")), keyCode: 13 });
assert.deepEqual(
    savedValues,
    [c.editvar],
    "Old keyCode-only events submit exactly once"
);
assert.deepEqual(
    runtimeErrors,
    [],
    "Native input teardown must not swallow runtime errors"
);
console.log(
    "PASS: denied/quota storage with cookie/memory fallback, legacy Date/mouse APIs and exact native input"
);
