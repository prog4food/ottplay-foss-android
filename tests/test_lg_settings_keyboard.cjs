const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { JSDOM } = require("jsdom");
const { languageAssetPath } = require("../scripts/localization-catalog.cjs");
const { keyboardCode } = require("./helpers/localized-keyboard.cjs");
const { settingsSource } = require("./helpers/settings-source-fixture.cjs");
const { compatibilitySource } = require("./helpers/english-source-fixture.cjs");
const root = path.resolve(__dirname, "..");
function read(file) {
    return fs.readFileSync(path.join(root, file), "utf8");
}
function functions(file, names) {
    const source = ts.createSourceFile(
        file,
        read(file),
        ts.ScriptTarget.Latest,
        true
    );
    return ts
        .transpileModule(
            source.statements
                .filter(
                    (node) =>
                        ts.isFunctionDeclaration(node) &&
                        names.includes(node.name && node.name.text)
                )
                .map((node) => node.getText(source))
                .join("\n"),
            {
                compilerOptions: {
                    module: ts.ModuleKind.ES2015,
                    target: ts.ScriptTarget.ES5,
                },
            }
        )
        .outputText.replace(/^export /gm, "");
}
function lgDeclarations() {
    const source = read("devices/lg/webos/device.js");
    function slice(start, end) {
        const from = source.indexOf(start);
        const to = source.indexOf(end, from + start.length);
        if (from < 0 || to < 0)
            throw new Error("LG declaration not found: " + start);
        return source.slice(from, to);
    }
    return [
        slice("var keys = {", "var strEXIT"),
        "var _baseWebosKey = window.stbEventToKeyCode;",
        slice("window.stbEventToKeyCode = function", "var _webosBackBound"),
        slice("var _webosBackBound = false;", "var _baseWebosExit"),
        slice(
            "function _bindWebosBackHistory()",
            "// Capture the existing initializer"
        ),
    ].join("\n");
}
function fixture() {
    const dom = new JSDOM(
        '<div id="dialogbox" style="display:none"></div><div id="listEdit" style="display:none;width:700px"></div><div id="listAbout" style="display:none"></div><div id="listCaption">Settings</div><div id="listPodval">Footer</div><div id="listDetail">Detail</div><div id="numprog"></div><div id="list_window"></div>',
        { runScripts: "outside-only" }
    );
    const w = dom.window;
    const initialPin = require("./helpers/protected-pin-fixture.cjs").record(
        "1234"
    );
    const data = new Map([["parentPIN", initialPin]]);
    const effects = [];
    const shifts = [];
    let reject = null;
    w.eval(read("js/jquery-1.11.1.min.js"));
    const originalIs = w.$.fn.is;
    w.$.fn.is = function (query) {
        return query === ":visible"
            ? !!this[0] && this[0].style.display !== "none"
            : originalIs.call(this, query);
    };
    let timer = 0;
    Object.assign(w, {
        _: (value) => value,
        changeSelect() {},
        changeVolume() {},
        clearInterval() {},
        curColor: "#fff",
        curColorB: "#000",
        listCaptionElement: w.document.getElementById("listCaption"),
        listDetailElement: w.document.getElementById("listDetail"),
        listFooterElement: w.document.getElementById("listPodval"),
        nativeListInertia: null,
        ott_device: "lg-webos",
        setInterval() {
            return ++timer;
        },
        setTimeout() {
            return ++timer;
        },
        showShift(value) {
            shifts.push(String(value));
        },
        sNoColorKeys: true,
        stbEventToKeyCode(event) {
            return (event && (event.keyCode || event.which)) || 0;
        },
        stbGetItem(key) {
            return key === "ottplaylang" ? w.fixtureLocale : null;
        },
        storage: {
            del(key) {
                data.delete(key);
            },
            get(key) {
                return data.has(key) ? data.get(key) : null;
            },
            set(key, value) {
                if (reject !== key) data.set(key, String(value));
            },
            setI(key, value) {
                if (reject !== key) data.set(key, String(value));
            },
        },
        swopLoadValue() {},
    });
    w.eval(lgDeclarations());
    require("./helpers/screen-runtime.cjs")(w);
    w.eval(keyboardCode());
    w.eval(
        functions("src/ui/index.ts", [
            "saveListPanelState",
            "restoreListPanelState",
        ])
    );
    w.eval(
        functions("src/key-handler/index.ts", [
            "cancelNativeListInertia",
            "keyHandler",
            "dispatchKey",
        ])
    );
    require("./helpers/pin-runtime.cjs")(w);
    w.eval(compatibilitySource + settingsSource());
    w.editKey = w.editKey1;
    w.loadSettings();
    w.setFontSize = () => effects.push("setFontSize");
    w.setListPos = () => effects.push("setListPos");
    w.listKeyHandler = () => true;
    w.__ottClassicScreenPort.commitList();
    w._bindWebosBackHistory();
    return {
        close: () => dom.window.close(),
        data,
        effects,
        initialPin,
        press(code, extra) {
            w.keyHandler(
                Object.assign(
                    {
                        keyCode: code,
                        preventDefault() {},
                        stopPropagation() {},
                    },
                    extra
                )
            );
        },
        reject(key) {
            reject = key;
        },
        shifts,
        w,
    };
}
function moveTo(f, index) {
    let guard = 0;
    while (f.w._keyCur !== index) {
        const column = f.w._keyCur % 10;
        const targetColumn = index % 10;
        const row = Math.floor(f.w._keyCur / 10);
        const targetRow = Math.floor(index / 10);
        if (row < targetRow) f.press(f.w.keys.DOWN);
        else if (row > targetRow) f.press(f.w.keys.UP);
        else if (column < targetColumn) f.press(f.w.keys.RIGHT);
        else f.press(f.w.keys.LEFT);
        if (++guard > 80)
            throw new Error("keyboard focus did not reach " + index);
    }
}
function openKeyboard(f) {
    f.w.editvar = "";
    f.w.editCaption = "Label";
    f.w.showEditKey1();
    assert.equal(f.w.__ottScreens.current().kind, "editor");
    assert.equal(f.w.__ottClassicScreenPort.owner("editor").foreground(), true);
}
let passed = 0;
function test(name, run) {
    const f = fixture();
    try {
        run(f);
        passed++;
        console.log("PASS lg-settings: " + name);
    } finally {
        f.close();
    }
}
function trackReturns(f) {
    const original = f.w.keyHandler;
    const returns = [];
    f.w.keyHandler = function (event) {
        if (event && event.keyCode === f.w.keys.RETURN)
            returns.push(event.keyCode);
        return original.call(this, event);
    };
    return returns;
}
function settingsList(f, rows) {
    f.w.listArray = rows;
    f.w.listKeyHandler = () => true;
    return f.w.__ottClassicScreenPort.commitList();
}
test("LG aliases stay on the shipped key map and History Back is one return", (f) => {
    assert.equal(f.w.keys.RETURN, 461);
    assert.equal(f.w.keys.CH_UP, 427);
    assert.equal(f.w.stbEventToKeyCode({ key: "GoBack", keyCode: 0 }), 461);
    assert.equal(
        f.w.stbEventToKeyCode({ code: "BrowserBack", keyCode: 0 }),
        461
    );
    assert.equal(f.w.stbEventToKeyCode({ key: "ColorF0Red", keyCode: 0 }), 403);
    assert.equal(f.w.stbEventToKeyCode({ key: "PageUp", keyCode: 0 }), 427);
    const returns = trackReturns(f);
    const armed = f.w.history.state;
    assert.equal(armed && armed.ottplayWebosBack, f.w._webosBackDepth);
    const before = f.w.history.length;
    f.w.dispatchEvent(new f.w.PopStateEvent("popstate", { state: armed }));
    assert.equal(
        returns.length,
        0,
        "armed history state must not dispatch RETURN"
    );
    assert.equal(f.w.history.length, before);
    f.w._bindWebosBackHistory();
    f.w.dispatchEvent(new f.w.PopStateEvent("popstate", { state: null }));
    assert.equal(
        returns.length,
        1,
        "one eligible popstate must dispatch exactly one RETURN"
    );
    assert.equal(f.w.history.length, before + 1);
    assert.equal(f.w.__ottScreens.current().kind, "list");
});
test("Latin, Turkish and paged Vietnamese input stay with the settings owner", (f) => {
    const rows = [{ settingId: "pageSize" }];
    settingsList(f, rows);
    const editor = f.w.createSettingsEditor(f.w, rows);
    editor.attach();
    openKeyboard(f);
    const latin = f.w._keys.indexOf("a");
    moveTo(f, latin);
    f.press(f.w.keys.ENTER);
    assert.equal(f.w.editvar, "a");
    const focus = f.w._keyCur;
    f.press(0, { key: "PageUp" });
    assert.equal(f.w.editvar, "a");
    assert.equal(f.w._keyCur, focus);
    f.w.eval(
        fs.readFileSync(
            path.join(root, languageAssetPath("_tur").slice(1)),
            "utf8"
        )
    );
    f.w.fixtureLocale = "_tur";
    f.press(f.w.keys.GREEN);
    f.press(0, { key: "ColorF0Red" });
    const turkish = f.w._keys.indexOf("i");
    assert(turkish >= 0, "Turkish i is on the localized layout");
    moveTo(f, turkish);
    f.press(f.w.keys.ENTER);
    assert.equal(f.w.editvar, "aİ");
    f.w.eval(
        fs.readFileSync(
            path.join(root, languageAssetPath("_vie").slice(1)),
            "utf8"
        )
    );
    f.w.fixtureLocale = "_vie";
    f.press(f.w.keys.GREEN);
    f.press(f.w.keys.GREEN);
    assert(f.w._keyPages > 1, "Vietnamese uses more than one keyboard page");
    const pager = Array.from(f.w._keys).findIndex(
        (character) => character.charCodeAt(0) === 8
    );
    moveTo(f, pager);
    f.press(f.w.keys.ENTER);
    assert.equal(f.w._keyPage, 1);
    const pageCharacter = f.w._localizedAlphabet()[40];
    moveTo(f, f.w._keys.indexOf(pageCharacter));
    f.press(f.w.keys.ENTER);
    assert.equal(f.w.editvar, "aİ" + f.w._keyboardCharacter(pageCharacter));
    assert.equal(f.w.document.getElementById("ee").getAttribute("dir"), "auto");
    assert.equal(editor.active(), true);
    assert.deepEqual([...f.data], [["parentPIN", f.initialPin]]);
    assert.equal(f.w.__ottScreens.current().kind, "editor");
});
test("replacement, History Back and a stale save leave the new draft intact", (f) => {
    const returns = trackReturns(f);
    const rows = [{ settingId: "pageSize" }];
    settingsList(f, rows);
    const oldEditor = f.w.createSettingsEditor(f.w, rows);
    oldEditor.attach();
    rows[0].val = 30;
    const stale = () => {
        rows[0].val = 30;
        return oldEditor.save();
    };
    f.w.setEdit = stale;
    openKeyboard(f);
    const retiredOwner = f.w.__ottClassicScreenPort.owner("editor");
    assert.equal(retiredOwner.model.save, stale);
    const replacementRows = [{ settingId: "pageSize" }];
    let replacementSaves = 0;
    f.w.setEdit = () => {
        replacementSaves++;
    };
    settingsList(f, replacementRows);
    const replacement = f.w.createSettingsEditor(f.w, replacementRows);
    replacement.attach();
    openKeyboard(f);
    const visibleOwner = f.w.__ottClassicScreenPort.owner("editor");
    const visibleScreen = f.w.__ottScreens.current();
    assert.notEqual(visibleOwner, retiredOwner);
    assert.equal(visibleOwner.model.save === stale, false);
    moveTo(f, f.w._keys.indexOf("a"));
    f.press(f.w.keys.ENTER);
    assert.equal(f.w.editvar, "a");
    const listEdit = f.w.document.getElementById("listEdit");
    assert.notEqual(listEdit.style.display, "none");
    assert.equal(stale(), false);
    assert.equal(retiredOwner.model.save(), false);
    assert.equal(f.w.editvar, "a");
    assert.equal(f.w.__ottClassicScreenPort.owner("editor"), visibleOwner);
    assert.equal(visibleOwner.foreground(), true);
    assert.equal(f.w.__ottScreens.current(), visibleScreen);
    assert.equal(visibleScreen.kind, "editor");
    assert.notEqual(listEdit.style.display, "none");
    assert.equal(oldEditor.active(), false);
    assert.equal(replacement.active(), true);
    assert.equal(replacementSaves, 0);
    assert.deepEqual([...f.data], [["parentPIN", f.initialPin]]);
    assert.equal(f.effects.length, 0);
    const beforeReturns = returns.length;
    f.w.dispatchEvent(new f.w.PopStateEvent("popstate", { state: null }));
    assert.equal(
        returns.length,
        beforeReturns + 1,
        "one eligible popstate must dispatch exactly one RETURN"
    );
    f.press(f.w.keys.N0);
    assert.equal(oldEditor.active(), false);
    assert.equal(replacement.active(), true);
    assert.equal(visibleScreen.active(), false);
    assert.equal(f.w.__ottScreens.current().kind, "list");
    assert.equal(f.data.has("sPageSize"), false);
    assert.equal(f.effects.length, 0);
    replacementRows[0].val = 12;
    assert.equal(replacement.save(), true);
    assert.equal(replacement.save(), false);
    assert.equal(f.data.get("sPageSize"), "12");
    assert.deepEqual(f.effects, ["setFontSize", "setListPos"]);
});
test("storage rejection keeps the editor recoverable and retry commits once", (f) => {
    const rows = [{ settingId: "pageSize" }];
    settingsList(f, rows);
    const editor = f.w.createSettingsEditor(f.w, rows);
    editor.attach();
    rows[0].val = 16;
    f.reject("sPageSize");
    assert.equal(editor.save(), false);
    assert.equal(editor.active(), true);
    assert.equal(f.data.has("sPageSize"), false);
    assert.equal(f.effects.length, 0);
    assert.match(f.shifts.join("\n"), /Settings could not be saved/);
    f.reject(null);
    assert.equal(editor.save(), true);
    assert.equal(editor.active(), false);
    assert.equal(f.data.get("sPageSize"), "16");
    assert.deepEqual(f.effects, ["setFontSize", "setListPos"]);
    assert.equal(editor.save(), false);
    assert.equal(f.data.get("sPageSize"), "16");
});
console.log(JSON.stringify({ cases: passed, result: "pass" }));
