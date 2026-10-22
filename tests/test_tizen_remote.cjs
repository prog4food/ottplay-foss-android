const {
    attachSourceAliases,
    sourceNames,
} = require("./helpers/english-source-fixture.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const acorn = require("acorn");
const { JSDOM } = require("jsdom");
const { localizationRuntime } = require("./helpers/localization-runtime.cjs");

const root = path.resolve(__dirname, "..");
function source(file, names) {
    names = sourceNames(file, names);
    const text = fs.readFileSync(path.join(root, file), "utf8");
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const selected = names
        ? ast.statements
              .filter(
                  (node) =>
                      ts.isFunctionDeclaration(node) &&
                      names.includes(node.name?.text)
              )
              .map((node) => node.getText(ast))
              .join("\n")
        : text;
    return ts
        .transpileModule(selected, {
            compilerOptions: {
                module: ts.ModuleKind.ES2015,
                target: ts.ScriptTarget.ES5,
            },
        })
        .outputText.replace(/^import .*\n/gm, "")
        .replace(/^export /gm, "");
}
const adapters = {
    shipped: fs.readFileSync(
        path.join(root, "devices/samsung/tizen/device.js"),
        "utf8"
    ),
    typescript: source("src/devices/samsung/tizen/device.ts"),
};
let handlers =
    localizationRuntime() +
    source("src/utils/helpers.ts", ["metadataText"]) +
    source("src/core/index.ts", ["stbEventToKeyCode"]) +
    source("src/key-handler/index.ts", [
        "cancelNativeListInertia",
        "keyHandler",
        "handleMainKey",
        "toggleMainPlayback",
    ]) +
    source("src/index.ts", [
        "selectLang",
        "loadInterfaceLanguage",
        "checkTauriUpdatesAfterLanguage",
    ]) +
    source("src/provider/index.ts", ["firstRun"]);
const useBundle = process.argv.includes("--bundle");
if (useBundle) {
    const bundle = fs.readFileSync(path.join(root, "dist/player.js"), "utf8");
    const ast = acorn.parse(bundle, { ecmaVersion: 5 });
    const selected = new Map();
    function includeDeclaration(name) {
        if (selected.has(name)) return;
        const declarations = ast.body.filter(
            (node) =>
                (node.type === "FunctionDeclaration" &&
                    node.id.name === name) ||
                (node.type === "VariableDeclaration" &&
                    node.declarations.some((item) => item.id.name === name))
        );
        assert.equal(
            declarations.length,
            1,
            "The classic bundle must expose one production " + name + " binding"
        );
        const declaration = declarations[0];
        selected.set(name, bundle.slice(declaration.start, declaration.end));
        // Keep actual linker-generated import readers as well: replacing them
        // with test stubs would conceal broken classic aliases in the handlers.
        function visit(node) {
            if (!node || typeof node !== "object") return;
            if (
                node.type === "Identifier" &&
                /^__ottReadImport\d+$/.test(node.name)
            )
                includeDeclaration(node.name);
            for (const value of Object.values(node)) {
                if (Array.isArray(value)) value.forEach(visit);
                else if (value && typeof value === "object") visit(value);
            }
        }
        visit(declaration.body || declaration);
    }
    for (const name of [
        "cancelNativeListInertia",
        "keyHandler",
        "handleMainKey",
        "toggleMainPlayback",
        "selectLang",
        "loadInterfaceLanguage",
        "checkTauriUpdatesAfterLanguage",
        "metadataText",
        "firstRun",
        "stbEventToKeyCode",
        "legacyPlayerBindings",
        "installEnglishPlayerAliases",
    ])
        includeDeclaration(name);
    handlers =
        localizationRuntime("dist/player.js") +
        Array.from(selected.values()).join("\n");
}

// Independent platform contract, from Samsung's Remote Control guide:
// https://developer.samsung.com/smarttv/develop/guides/user-interaction/remote-control.html
const officialCodes = {
    ASPECT: 10140,
    AUDIO: 10195,
    BLUE: 406,
    CH_DOWN: 428,
    CH_LIST: 10073,
    CH_UP: 427,
    DOWN: 40,
    ENTER: 13,
    EPG: 458,
    EXIT: 10182,
    FF: 417,
    GREEN: 404,
    INFO: 457,
    LEFT: 37,
    MUTE: 449,
    NEXT: 10233,
    PAUSE: 19,
    PLAY: 415,
    PLAYPAUSE: 10252,
    PRECH: 10190,
    PREV: 10232,
    REC: 416,
    RED: 403,
    RETURN: 10009,
    RIGHT: 39,
    RW: 412,
    SETUP: 18,
    STOP: 413,
    TOOLS: 10135,
    UP: 38,
    VOL_DOWN: 448,
    VOL_UP: 447,
    YELLOW: 405,
};

function fixture(code, nativeMode = "working") {
    const calls = [];
    const registered = [];
    const dom = new JSDOM("<!doctype html><html><body></body></html>");
    const document = dom.window.document;
    const elements = { body: document.body, html: document.documentElement };
    const storage = { ottplaylang: "_eng" };
    function element(id) {
        if (!elements[id]) {
            const node = document.createElement("div");
            node.id = id;
            document.body.appendChild(node);
            elements[id] = node;
        }
        return elements[id];
    }
    const chain = { hide() {}, is: () => false };
    const baseInit = () => {
        calls.push("baseInit");
        return false;
    };
    const w = {
        _: (text) => text,
        $: () => chain,
        baseStbInit: baseInit,
        btnDiv: () => "",
        console: { log() {} },
        document,
        edit_dealer() {},
        edit_dealer_remote() {},
        focus() {},
        isEditMode: false,
        isListVisible: false,
        isPlayDistribution: () => false,
        isSelectBox: false,
        listCaptionElement: element("listCaption"),
        listDetail: element("listDetail"),
        listElement: element("list_window"),
        listPodval: element("listPodval"),
        loadProv(provider) {
            calls.push(["loadProv", provider]);
            if (!provider) w.firstRun();
        },
        loadSettings() {},
        nativeListInertia: null,
        nofun() {},
        optionsList: () => calls.push("settings"),
        playType: 0,
        popupList: () => calls.push("menu"),
        screen: {},
        selectProvaider() {},
        settings: { volumeStep: 5 },
        showPage() {
            w.isListVisible = true;
        },
        stbGetItem: (key) => storage[key],
        stbInit: baseInit,
        stbSetItem: (key, value) => {
            storage[key] = value;
        },
        translate: (text) => text,
        version: "test",
    };
    if (nativeMode !== "absent") {
        const input = {
            registerKey(name) {
                assert.equal(this, input, "Registration retains API receiver");
                registered.push(name);
                if (
                    nativeMode === "denied" ||
                    (nativeMode === "one-unsupported" && name === "0")
                )
                    throw new Error("TV input key unavailable");
            },
        };
        w.tizen = { tvinputdevice: input };
        if (nativeMode === "throwing-getter")
            Object.defineProperty(w.tizen, "tvinputdevice", {
                get() {
                    throw new Error("Native input API unavailable");
                },
            });
    }
    w.window = w;
    vm.createContext(w);
    require("./helpers/screen-runtime.cjs")(w);
    vm.runInContext(handlers, w);
    // This remote-key fixture begins after a successful English bootstrap.
    // A stored language alone no longer represents a loaded dictionary.
    vm.runInContext(
        fs.readFileSync(path.join(root, "locales/english.js"), "utf8"),
        w
    );
    w.applyLanguageMetadata("_eng");
    if (useBundle) {
        // Extracted production handlers depend on the production bootstrap's
        // live alias map. Load it from this artifact, never from source fixtures.
        w.installEnglishPlayerAliases(w);
    } else attachSourceAliases(w);
    vm.runInContext(code, w);
    if (!process.argv.includes("--bundle")) attachSourceAliases(w);
    function key(keyCode) {
        w.keyHandler({
            keyCode,
            preventDefault() {},
            stopPropagation() {},
        });
    }
    return {
        calls,
        close: () => dom.window.close(),
        elements,
        key,
        registered,
        storage,
        w,
    };
}

for (const [name, code] of Object.entries(adapters)) {
    acorn.parse(code, { ecmaVersion: 5 });
    const f = fixture(code);
    assert.equal(f.calls.length, 0, name + " waits for initialization");
    assert.equal(f.registered.length, 0);
    f.w.stbInit();
    assert.deepEqual(f.calls, ["baseInit"]);
    for (const [key, expected] of Object.entries(officialCodes))
        assert.equal(f.w.keys[key], expected, name + " " + key);
    for (let digit = 0; digit < 10; digit++) {
        assert.equal(f.w.keys["N" + digit], 48 + digit);
        assert(f.registered.includes(String(digit)));
    }
    assert.equal(new Set(f.registered).size, f.registered.length);
    for (const key of ["ArrowLeft", "ArrowRight", "Enter", "Back"])
        assert(!f.registered.includes(key), "Basic keys are automatic");
    for (const key of [
        "ColorF0Red",
        "ColorF1Green",
        "ColorF2Yellow",
        "ColorF3Blue",
        "ChannelUp",
        "ChannelDown",
        "ChannelList",
        "PreviousChannel",
        "MediaPlayPause",
        "MediaPlay",
        "MediaPause",
        "MediaStop",
        "MediaRewind",
        "MediaFastForward",
        "MediaTrackPrevious",
        "MediaTrackNext",
        "VolumeUp",
        "VolumeDown",
        "VolumeMute",
        "Info",
        "Guide",
        "Menu",
        "Tools",
    ])
        assert(f.registered.includes(key), name + " registers " + key);

    // Reproduce the simulator failure using real language/first-run handlers,
    // sending the TV's documented numeric OK rather than reading keys.ENTER.
    f.w.selectLang();
    assert.equal(f.elements.listCaption.innerHTML, "Choose language");
    f.key(13);
    assert.equal(f.elements.listCaption.innerHTML, "First-run setup");
    f.key(13);
    assert.equal(f.storage.ottplayprov, "demo", "OK activates the menu item");
    assert.deepEqual(f.calls.at(-1), ["loadProv", "demo"]);
    f.key(10009);
    assert.equal(f.elements.listCaption.innerHTML, "Choose language");

    f.w.isListVisible = false;
    f.key(18);
    assert.equal(f.calls.at(-1), "settings", "Menu key reaches setup");
    f.w.isListVisible = false;
    f.key(10135);
    assert.equal(f.calls.at(-1), "menu", "Tools opens the main menu");

    f.w.liveStop = () => f.calls.push("live-toggle");
    assert.equal(
        f.w.pauseLivePlayback,
        f.w.liveStop,
        "A late device replacement is visible through the production alias"
    );
    f.key(10252);
    assert.equal(f.calls.at(-1), "live-toggle");
    let playing = true;
    f.w.playType = -1e11;
    f.w.showShift = (text) => f.calls.push(["transport", text]);
    f.w.stbIsPlaying = () => playing;
    f.w.stbPause = () => {
        playing = false;
    };
    f.w.stbContinue = () => {
        playing = true;
    };
    f.key(10252);
    assert.equal(playing, false, "Smart Remote pauses VOD");
    assert.deepEqual(f.calls.at(-1), ["transport", "Pause"]);
    f.key(10252);
    assert.equal(playing, true, "Smart Remote resumes VOD");
    assert.deepEqual(f.calls.at(-1), ["transport", "Play"]);
    f.w.isListVisible = true;
    f.w.listKeyHandlerFn = (key) => {
        f.calls.push(["list-key", key]);
        return true;
    };
    f.key(10252);
    assert.deepEqual(f.calls.at(-1), ["list-key", 415]);

    for (const mode of [
        "absent",
        "one-unsupported",
        "denied",
        "throwing-getter",
    ]) {
        const broken = fixture(code, mode);
        assert.doesNotThrow(() => broken.w.stbInit(), name + " " + mode);
        assert.deepEqual(broken.calls, ["baseInit"]);
        if (mode === "one-unsupported" || mode === "denied")
            assert.deepEqual(broken.registered, f.registered);
        else assert.deepEqual(broken.registered, []);
        broken.w.selectLang();
        broken.key(13);
        assert.equal(broken.elements.listCaption.innerHTML, "First-run setup");
        broken.close();
    }
    f.close();
}
console.log(
    "Samsung Tizen remote keys, real UI handlers and registration failures passed (" +
        (useBundle ? "dist/player.js" : "source") +
        ")"
);
