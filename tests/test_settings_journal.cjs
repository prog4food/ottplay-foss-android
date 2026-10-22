const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const code = ts.transpileModule(
    fs.readFileSync("src/storage/index.ts", "utf8"),
    {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES5,
        },
    }
).outputText;
require("acorn").parse(code, { ecmaVersion: 5 });
function backing(initial) {
    const map = new Map(Object.entries(initial));
    const snapshots = [];
    const port = {
        clear() {
            map.clear();
        },
        getItem: (key) => map.get(key) ?? null,
        key: (index) => [...map.keys()][index],
        get length() {
            return map.size;
        },
        map,
        removeItem(key) {
            map.delete(key);
            snapshots.push(Object.fromEntries(map));
        },
        setItem(key, value) {
            if (port.reject === key) throw Error("quota");
            map.set(key, value);
            snapshots.push(Object.fromEntries(map));
        },
        snapshots,
    };
    return port;
}
function load(port, document = { cookie: "" }) {
    const context = {
        document,
        exports: {},
        window: { localStorage: port },
    };
    vm.runInNewContext(code, context);
    return context.exports;
}
const initial = { one: "old", removed: "before", untouched: "same" };
const expected = { added: "after", one: "new", untouched: "same" };
const writes = [
    { after: "new", before: "old", key: "one" },
    { after: null, before: "before", key: "removed" },
    { after: "after", before: null, key: "added" },
];
const port = backing(initial),
    api = load(port);
api.writeSettingsJournal(port, writes, () => true);
assert.deepEqual(Object.fromEntries(port.map), expected);
for (const snapshot of port.snapshots) {
    const restored = backing(snapshot);
    load(restored); // Actual bootstrap recovery, before any caller reads settings.
    assert.deepEqual(
        Object.fromEntries(restored.map),
        snapshot.ottplaySettingsJournalV1 ? initial : expected
    );
}
const prepared = port.snapshots[1];
const repeated = backing(prepared);
api.recoverSettingsJournal(repeated);
for (const snapshot of repeated.snapshots) {
    const restarted = backing(snapshot);
    load(restarted);
    assert.deepEqual(
        Object.fromEntries(restarted.map),
        initial,
        "Recovery itself can restart after every write"
    );
}
const foreign = backing({ ...prepared, one: "external" });
api.recoverSettingsJournal(foreign);
assert.equal(foreign.getItem("one"), "external");
const full = backing(initial);
full.reject = "ottplaySettingsJournalV1";
assert.throws(
    () => api.writeSettingsJournal(full, writes, () => true),
    /quota/
);
assert.deepEqual(Object.fromEntries(full.map), initial);
const invalid = backing({
    ...initial,
    ottplaySettingsJournalV1:
        '{"version":1,"writes":[{"key":"one","after":"old"}]}',
});
const invalidApi = load(invalid);
assert.equal(invalidApi.settingsRecoveryRequired(), true);
assert.equal(invalidApi.stbGetItem("one"), null);
assert.deepEqual(Object.keys(invalidApi.stbGetAllItems()), []);
assert.throws(
    () => invalidApi.recoverStoredSettings(false),
    /Invalid settings journal/
);
assert.equal(invalid.getItem("one"), "old");
assert.equal(api.isStorageMetadataKey("ottplaySettingsJournalV1"), true);
const originalJournal = JSON.stringify({
    version: 1,
    writes: [{ after: "new", before: "old", key: "one" }],
});
const foreignJournal = JSON.stringify({
    version: 1,
    writes: [{ after: "foreign", before: null, key: "two" }],
});
const replaced = backing({
    one: "new",
    ottp: "unrelated",
    ottplaySettingsJournalV1: originalJournal,
});
const originalSet = replaced.setItem;
replaced.setItem = function (key, value) {
    originalSet(key, value);
    if (key === "one")
        replaced.map.set("ottplaySettingsJournalV1", foreignJournal);
};
assert.throws(
    () => api.recoverSettingsJournal(replaced),
    /Settings journal changed/
);
assert.equal(
    replaced.getItem("ottplaySettingsJournalV1"),
    foreignJournal,
    "Recovery must not remove a replacement journal"
);

// A failed recovery is a recoverable boot state, never permission to read
// partially imported values or silently switch to stale cookie overrides.
for (const journal of ["{broken", "[]", "x".repeat(2 * 1024 * 1024 + 1)]) {
    const quarantined = backing({
        one: "partial",
        ottplaySettingsJournalV1: journal,
    });
    const doc = {
        cookie: "one=cookie; ottplayStorageFallback=%5B%22one%22%5D",
    };
    const api = load(quarantined, doc);
    const before = Object.fromEntries(quarantined.map);
    const cookie = doc.cookie;
    assert.equal(api.settingsRecoveryRequired(), true);
    assert.equal(api.storage.get("one"), null);
    assert.equal(api.stbGetPersistedItem("one"), null);
    assert.equal(api.storage.getI("one", 7), 7);
    assert.equal(api.storage.has("one"), false);
    assert.equal(api.storage.hasValue("one"), false);
    assert.deepEqual(Object.keys(api.storage.dump()), []);
    api.storage.set("one", "new");
    api.storage.setI("count", 3);
    api.storage.del("one");
    api.storage.clear();
    api.storage.reset();
    assert.deepEqual(Object.fromEntries(quarantined.map), before);
    assert.equal(doc.cookie, cookie);
}

const retryPort = backing({
    one: "new",
    ottplaySettingsJournalV1: originalJournal,
});
retryPort.reject = "one";
const retryApi = load(retryPort);
assert.equal(retryApi.settingsRecoveryRequired(), true);
assert.equal(retryApi.stbGetItem("one"), null);
assert.throws(() => retryApi.recoverStoredSettings(false), /quota/);
assert.equal(retryPort.getItem("one"), "new");
delete retryPort.reject;
retryApi.recoverStoredSettings(false);
assert.equal(retryPort.getItem("one"), "old");
assert.equal(
    retryApi.stbGetItem("one"),
    null,
    "Old page stays closed until reload"
);
assert.equal(load(retryPort).stbGetItem("one"), "old");

// Use the real domain-to-native transaction path: protected rollback bytes
// must survive the adapter boundary without journaling the legacy preimage.
const domain = { exports: {} };
vm.runInNewContext(
    ts.transpileModule(fs.readFileSync("src/settings/store.ts", "utf8"), {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES5,
        },
    }).outputText,
    domain
);
const pinFixture = require("./helpers/protected-pin-fixture.cjs");
const previousPin = pinFixture.record("2468");
const nextPin = pinFixture.record("9876");
function protectedBatch(native, api) {
    return [
        { after: nextPin, key: "parentPIN", rollback: previousPin },
        { after: "after", key: "ordinary" },
    ].map(({ key, after, rollback }) => ({
        after,
        before: native.getItem(key),
        ...(rollback === undefined ? {} : { rollback }),
        storage: {
            key,
            read: () => api.storage.get(key),
            remove: () => api.storage.del(key),
            transaction: api.storage.transaction,
            write: (value) => api.storage.set(key, value),
        },
    }));
}
for (const fail of [false, true]) {
    const native = backing({ ordinary: "before", parentPIN: "2468" });
    const api = load(native);
    if (fail) native.reject = "ordinary";
    const commit = () =>
        domain.exports.commitSettingsWrites(
            protectedBatch(native, api),
            () => true,
            () => true
        );
    if (fail) assert.throws(commit, /quota/);
    else commit();
    assert.equal(native.getItem("parentPIN"), fail ? previousPin : nextPin);
    assert.equal(native.getItem("ordinary"), fail ? "before" : "after");
    for (const snapshot of native.snapshots) {
        if (!snapshot.ottplaySettingsJournalV1) continue;
        const journal = JSON.parse(snapshot.ottplaySettingsJournalV1);
        assert.equal(journal.version, 1);
        const pin = journal.writes.find((entry) => entry.key === "parentPIN");
        assert.deepEqual(Object.keys(pin).sort(), ["after", "before", "key"]);
        assert.equal(pin.before, previousPin);
        assert.equal(pin.after, nextPin);
        const restarted = backing(snapshot);
        load(restarted);
        assert.equal(restarted.getItem("ordinary"), "before");
        assert.equal(
            restarted.getItem("parentPIN"),
            snapshot.parentPIN === "2468" ? "2468" : previousPin,
            "A restart never writes the legacy PIN back after replacement"
        );
    }
}
const changedNative = backing({ ordinary: "before", parentPIN: "2468" });
const changedApi = load(changedNative);
const staleWrites = protectedBatch(changedNative, changedApi);
changedNative.map.set("parentPIN", previousPin);
assert.throws(
    () =>
        domain.exports.commitSettingsWrites(
            staleWrites,
            () => true,
            () => true
        ),
    /Settings changed/,
    "Optimistic admission compares raw preimages, not protected rollback bytes"
);
assert.deepEqual(changedNative.snapshots, []);
const badRollback = backing({ one: "old" });
assert.throws(
    () =>
        api.writeSettingsJournal(
            badRollback,
            [{ after: "new", before: "old", key: "one", rollback: undefined }],
            () => true
        ),
    /Invalid settings batch/
);
assert.deepEqual(badRollback.snapshots, []);

const { JSDOM } = require("jsdom");
function recoveryPage(port, options = {}) {
    const dom = new JSDOM(
        "<!doctype html><html><body><div id='launch'></div></body></html>",
        {
            url: "https://player.test/",
        }
    );
    const { document } = dom.window;
    document.cookie = "one=stale; path=/";
    document.cookie = "ottplayStorageFallback=%5B%22one%22%5D; path=/";
    if (options.rejectCookies)
        Object.defineProperty(document, "cookie", {
            get: () => "one=stale",
            set: () => {},
        });
    const api = load(port, document);
    let reloads = 0;
    const ui = {};
    const translations = {
        Cancel: "Отмена",
        "Clear settings": "Очистить настройки",
        Retry: "Повторить",
    };
    const window = {
        addEventListener: dom.window.addEventListener.bind(dom.window),
        keys: { ENTER: 900, LEFT: 903, RETURN: 901, RIGHT: 902 },
        location: {
            reload: () => {
                reloads++;
            },
        },
    };
    const uiCode = ts.transpileModule(
        fs.readFileSync("src/storage/recovery-ui.ts", "utf8"),
        {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES5,
            },
        }
    ).outputText;
    require("acorn").parse(uiCode, { ecmaVersion: 5 });
    vm.runInNewContext(uiCode, {
        document,
        exports: ui,
        require: (name) =>
            name === "./index" ? api : { _: (key) => translations[key] || key },
        window,
    });
    return {
        api,
        click(label) {
            const element = [...document.querySelectorAll("button")].find(
                (button) =>
                    button.textContent === (translations[label] || label)
            );
            assert.ok(element, "Visible recovery action: " + label);
            element.click();
        },
        document,
        dom,
        press(keyCode, options = {}) {
            const event = new dom.window.KeyboardEvent("keydown", {
                bubbles: true,
                cancelable: true,
                keyCode,
                ...options,
            });
            document.activeElement.dispatchEvent(event);
            return event;
        },
        get reloads() {
            return reloads;
        },
        ui,
    };
}

const uiPort = backing({
    one: "partial-secret",
    ottplaySettingsJournalV1: "{secret",
});
const page = recoveryPage(uiPort);
assert.equal(page.ui.showSettingsRecovery(), true);
assert.equal(page.ui.showSettingsRecovery(), true);
assert.equal(page.document.querySelectorAll("[role=alertdialog]").length, 1);
assert.equal(page.document.activeElement.textContent, "Повторить");
assert.doesNotMatch(page.document.body.textContent, /secret/);
assert.equal(page.press(900).defaultPrevented, true);
assert.equal(page.reloads, 0, "An invalid retry keeps the recovery screen");
assert.equal(uiPort.getItem("one"), "partial-secret");
page.press(902);
page.press(900);
assert.equal(page.document.activeElement.textContent, "Отмена");
page.press(900, { repeat: true });
assert.equal(
    page.document.activeElement.textContent,
    "Отмена",
    "Held Enter cannot confirm reset"
);
page.press(901);
assert.equal(page.document.activeElement.textContent, "Повторить");
assert.equal(
    uiPort.getItem("one"),
    "partial-secret",
    "Back cancels without mutating storage"
);
page.click("Clear settings");
page.click("Cancel");
assert.equal(page.reloads, 0);
page.click("Clear settings");
page.press(9);
page.press(900);
assert.equal(page.reloads, 1);
assert.equal(uiPort.length, 0);
assert.equal(
    page.document.cookie,
    "ottplayStorageFallback.reset=1; ottplayStorageFallback=%5B%5D"
);
assert.equal(
    page.api.settingsRecoveryRequired(),
    true,
    "Reload, not in-place hydration"
);
assert.equal(load(uiPort).settingsRecoveryRequired(), false);
page.dom.window.close();

// A reset crash at every native operation retains an invalid barrier until the
// last removal. Retrying ordinary recovery must never hydrate the partial reset.
for (const snapshot of uiPort.snapshots.slice(0, -1)) {
    const interruptedApi = load(backing(snapshot));
    assert.equal(interruptedApi.settingsRecoveryRequired(), true);
    assert.equal(interruptedApi.stbGetItem("one"), null);
}
const rejectedPort = backing({
    one: "partial",
    ottplaySettingsJournalV1: "{broken",
});
const rejectedPage = recoveryPage(rejectedPort, { rejectCookies: true });
rejectedPage.ui.showSettingsRecovery();
rejectedPage.click("Clear settings");
rejectedPage.click("Clear settings");
assert.equal(rejectedPage.reloads, 0);
assert.ok(rejectedPort.getItem("ottplaySettingsJournalV1"));
assert.equal(load(rejectedPort).settingsRecoveryRequired(), true);
assert.equal(rejectedPage.document.activeElement.textContent, "Повторить");
rejectedPage.dom.window.close();

const resetDenied = backing({
    one: "partial",
    ottplaySettingsJournalV1: "{broken",
});
resetDenied.reject = "ottplaySettingsJournalV1";
const deniedApi = load(resetDenied);
assert.throws(() => deniedApi.recoverStoredSettings(true), /quota/);
assert.equal(resetDenied.getItem("one"), "partial");

const eraseDenied = backing({
    one: "partial",
    ottplaySettingsJournalV1: "{broken",
});
eraseDenied.removeItem = () => {};
const eraseApi = load(eraseDenied);
assert.throws(
    () => eraseApi.recoverStoredSettings(true),
    /Settings recovery failed/
);
assert.equal(eraseDenied.getItem("one"), "partial");
assert.equal(load(eraseDenied).settingsRecoveryRequired(), true);

const retryUiPort = backing({
    one: "new",
    ottplaySettingsJournalV1: originalJournal,
});
retryUiPort.reject = "one";
const retryPage = recoveryPage(retryUiPort);
retryPage.ui.showSettingsRecovery();
retryPage.click("Retry");
assert.equal(retryPage.reloads, 0);
delete retryUiPort.reject;
retryPage.click("Retry");
assert.equal(retryPage.reloads, 1);
assert.equal(retryUiPort.getItem("one"), "old");
assert.equal(retryUiPort.getItem("ottplaySettingsJournalV1"), null);
assert.equal(retryPage.api.stbGetItem("one"), null);
retryPage.dom.window.close();

// A nested host cookie is not owned by the root-path player adapter. Unknown
// legacy cookies remain physically untouched but cannot hydrate after reset.
const nestedDom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://player.test/ott/index.html",
});
const nestedDoc = nestedDom.window.document;
nestedDoc.cookie = "hostingPreference=x; path=/ott";
nestedDoc.cookie = "legacyAccount=private; path=/";
const nestedPort = backing({
    m3um3uArr: "private",
    ottplaySettingsJournalV1: "{broken",
});
load(nestedPort, nestedDoc).recoverStoredSettings(true);
assert.equal(nestedPort.length, 0);
assert.match(nestedDoc.cookie, /hostingPreference=x/);
assert.match(nestedDoc.cookie, /legacyAccount=private/);
for (const native of [nestedPort, null]) {
    const fresh = load(native, nestedDoc);
    assert.equal(fresh.settingsRecoveryRequired(), false);
    assert.equal(fresh.stbGetItem("hostingPreference"), null);
    assert.equal(fresh.stbGetItem("legacyAccount"), null);
    assert.equal(fresh.stbGetPersistedItem("legacyAccount"), null);
    assert.deepEqual(Object.keys(fresh.storage.dump()), []);
}
const nextFallback = load(null, nestedDoc);
nextFallback.stbSetItem("newAccount", "new");
assert.equal(load(null, nestedDoc).stbGetItem("newAccount"), "new");
assert.equal(load(null, nestedDoc).stbGetItem("legacyAccount"), null);
const laterNative = backing({ readable: "keep" });
const later = load(laterNative, nestedDoc);
laterNative.reject = "changed";
later.stbSetItem("changed", "updated");
assert.equal(load(null, nestedDoc).stbGetItem("readable"), "keep");
assert.equal(load(null, nestedDoc).stbGetItem("changed"), "updated");
assert.equal(load(null, nestedDoc).stbGetItem("legacyAccount"), null);
nestedDom.window.close();

// Exercise the actual entry function, not a mirrored guard: no player hooks,
// settings reads, device setup or UI initialization may precede recovery.
const main = ts.createSourceFile(
    "src/index.ts",
    fs.readFileSync("src/index.ts", "utf8"),
    ts.ScriptTarget.Latest,
    true
);
const start = main.statements.find(
    (node) =>
        ts.isFunctionDeclaration(node) && node.name?.text === "startPlayer"
);
const entryCode = ts.transpileModule(start.getText(main), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText;
const entryContext = { exports: {}, showSettingsRecovery: () => true };
vm.runInNewContext(entryCode, entryContext);
assert.doesNotThrow(() => entryContext.exports.startPlayer());
console.log(
    "PASS settings journal: crash recovery, quarantine, explicit retry/reset UI, remote/keyboard, reset barriers, entry guard, metadata exclusion"
);
