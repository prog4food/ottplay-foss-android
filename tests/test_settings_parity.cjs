const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { compatibilitySource } = require("./helpers/english-source-fixture.cjs");
const root = path.resolve(__dirname, "..");

function selectedSource(file, functions, assignments = [], variables = []) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    return ast.statements
        .filter(
            (node) =>
                (ts.isFunctionDeclaration(node) &&
                    functions.includes(node.name?.text)) ||
                (ts.isVariableStatement(node) &&
                    node.declarationList.declarations.some((item) =>
                        variables.includes(item.name.getText(ast))
                    )) ||
                (ts.isExpressionStatement(node) &&
                    ts.isBinaryExpression(node.expression) &&
                    assignments.includes(
                        node.expression.left.getText(ast).replace("window.", "")
                    ))
        )
        .map((node) => node.getText(ast))
        .join("\n");
}
function compile(source) {
    return (
        compatibilitySource +
        ts
            .transpileModule(source, {
                compilerOptions: {
                    module: ts.ModuleKind.ES2015,
                    target: ts.ScriptTarget.ES2018,
                },
            })
            .outputText.replace(/^import .*$/gm, "")
            .replace(/^export /gm, "")
    );
}
function assertOnlyInitialPin(stored) {
    assert.deepEqual(
        [...stored],
        [
            [
                "parentPIN",
                require("./helpers/protected-pin-fixture.cjs").record("1234"),
            ],
        ]
    );
}

const menus = [
    "stbOptions",
    "settingsInterface",
    "settingsLists",
    "settingsChannels",
    "settingsInfobar",
    "settingsButtons",
    "settingsMenu",
    "settingsManage",
    "parentControlSetup",
];
function fixture(
    profile = "server",
    limited = false,
    distribution = "full",
    device
) {
    // This suite exercises menu parity, not first-install PIN migration.
    const stored = new Map([
        [
            "parentPIN",
            require("./helpers/protected-pin-fixture.cjs").record("1234"),
        ],
    ]);
    const storage = {
        del: (key) => stored.delete(key),
        get: (key) => stored.get(key) ?? null,
        getI(key, fallback) {
            const value = Number.parseInt(stored.get(key), 10);
            return Number.isNaN(value) ? fallback : value;
        },
        set: (key, value) => stored.set(key, String(value)),
        setI: (key, value) => stored.set(key, String(value)),
    };
    const elements = new Map();
    const timers = new Map();
    let nextTimer = 1;
    const calls = [];
    const w = {
        _: (text) => text,
        $() {
            return {
                append() {
                    return this;
                },
                hide() {
                    return this;
                },
                is: () => true,
            };
        },
        backColorDialog() {},
        beginPortChannelIdMigration() {},
        bufferSizes: ["auto", "1", "2"],
        channels: {},
        clearTimeout(id) {
            timers.delete(id);
        },
        closeList() {},
        colorDialog() {},
        console,
        document: {
            getElementById(id) {
                if (!elements.has(id))
                    elements.set(id, { innerHTML: "", style: {} });
                return elements.get(id);
            },
        },
        findOptionIndex() {
            return 0;
        },
        finishPortChannelIdMigration() {},
        getChannelsArray: (done) => done(),
        getMediaArray() {},
        Hls: {
            isSupported() {
                return true;
            },
        },
        invalidateEpgCache() {},
        keys: {
            ENTER: 13,
            GREEN: 71,
            LEFT: 37,
            N0: 48,
            N2: 50,
            PAUSE: 81,
            PLAY: 80,
            PREV: 83,
            RETURN: 27,
            RIGHT: 39,
            RW: 82,
        },
        launch_id: "#launch",
        noop() {},
        onChannelsLoaded() {},
        optionsList() {
            calls.push("options");
        },
        playerMode: 0,
        playerModeNames: ["html5", "hls.js", "shaka"],
        popupActions: [
            function channels() {},
            function epg() {},
            function toggleProviderSettingsVisibility() {},
        ],
        popupArray: ["Channels", "EPG", "Provider"],
        providerDelItem: (key) => storage.del("provider:" + key),
        providerGetItem: (key) => storage.get("provider:" + key),
        providerGetJson: () => [],
        providerHasItemValue(key) {
            return stored.has("provider:" + key);
        },
        providerSetItem: (key, value) => storage.set("provider:" + key, value),
        renderButtonHint() {
            return "";
        },
        selColorDialog() {},
        setAutorun() {},
        setColor() {},
        setEditor() {},
        setFontSize() {
            calls.push("font");
        },
        setListPos() {
            calls.push("position");
        },
        setPipPosBuf() {},
        setTimeout(callback, ms) {
            const id = nextTimer++;
            timers.set(id, { callback, ms });
            return id;
        },
        setTimezone() {},
        showEditKey2() {},
        showPage() {},
        showProviderSelection() {},
        showShift() {},
        stbClearAllItems() {},
        stbGetAllItems() {},
        stbGetVolume() {},
        stbIsStandby() {
            return false;
        },
        stbPlayPip() {},
        stbSetBuffer() {},
        stbSetItem: storage.set,
        stbSetOsdOpacity() {},
        stbToggleAspectRatio() {},
        stbToggleAudioTrack() {},
        stbToggleStandby() {
            calls.push("standby");
        },
        stbToggleSubtitle() {},
        storage,
        video: {
            canPlayType() {
                return "";
            },
        },
    };
    w.toggleProviderSettingsVisibility = w.popupActions[2];
    if (device !== undefined) w.ott_device = device;
    if (profile === "tauri") w.__TAURI__ = {};
    if (profile === "tauri-internals") w.__TAURI_INTERNALS__ = {};
    if (profile.startsWith("capacitor"))
        w.Capacitor = {
            getPlatform: () => (profile.endsWith("ios") ? "ios" : "android"),
        };
    if (limited) {
        for (const key of [
            "stbPlayPip",
            "stbGetVolume",
            "stbSetOsdOpacity",
            "showEditKey2",
            "getMediaArray",
            "stbClearAllItems",
        ])
            delete w[key];
        delete w.keys.RW;
        delete w.keys.PREV;
    }
    w.window = w;
    vm.createContext(w);
    require("./helpers/shared-core-runtime.cjs")(w);
    vm.runInContext(
        compile(
            fs.readFileSync(
                path.join(root, "src/localization/assets.ts"),
                "utf8"
            )
        ),
        w
    );
    vm.runInContext(
        compile(
            selectedSource("src/plugins/access-media.ts", ["accessMediaPlugin"])
        ),
        w
    );
    const policy = compile(
        selectedSource(
            "src/provider/index.ts",
            ["isPlayDistribution"],
            [],
            ["providerDistribution"]
        )
    );
    const distributionMarker = 'var providerDistribution = "full";';
    assert.equal(
        policy.split(distributionMarker).length,
        2,
        "actual provider profile declaration"
    );
    assert(["full", "play"].includes(distribution));
    vm.runInContext(
        policy.replace(
            distributionMarker,
            'var providerDistribution = "' + distribution + '";'
        ),
        w
    );
    vm.runInContext(
        compile(
            selectedSource("src/channels/index.ts", ["parentControlSetup"])
        ),
        w
    );

    vm.runInContext(
        compile(
            fs.readFileSync(path.join(root, "src/settings/store.ts"), "utf8")
        ),
        w
    );
    vm.runInContext(
        compile(
            fs.readFileSync(path.join(root, "src/settings/index.ts"), "utf8")
        ),
        w
    );
    vm.runInContext(
        compile(
            fs.readFileSync(path.join(root, "src/settings/editor.ts"), "utf8")
        ),
        w
    );
    vm.runInContext(
        compile(
            selectedSource(
                "src/index.ts",
                ["createSettingsPage", "setListArrays"],
                ["_setSetup", ...menus]
            )
        ),
        w
    );
    vm.runInContext(
        compile(
            selectedSource(
                "src/core/index.ts",
                [
                    "cancelCoreAutoPlayback",
                    "getDefaultPlayerMode",
                    "isOttplayTestWebView",
                    "normalizePlayerMode",
                    "setPlayerMode",
                    "setPlayer",
                ],
                [],
                ["_coreAutoCancel", "_corePipAutoCancel", "playerModeNames"]
            )
        ),
        w
    );
    vm.runInContext(
        compile(
            selectedSource("src/storage/index.ts", ["providerGetNum"]) +
                "\n" +
                selectedSource("src/provider/index.ts", ["loadChannels"])
        ),
        w
    );
    vm.runInContext(
        compile(
            fs.readFileSync(
                path.join(root, "src/settings/sleep-timer.ts"),
                "utf8"
            )
        ),
        w
    );
    vm.runInContext(
        "window.settings = settings; installSettingsFacade(window);",
        w
    );
    // Channel flags are normally initialized from provider storage by loadChannels.
    Object.assign(w, {
        sNextCountL: 1,
        sPreview: 0,
        sShowArchive: 1,
        sShowDescr: 1,
        sShowName: 1,
        sShowNum: 1,
        sShowPikon: 1,
        sShowProgram: 1,
        sShowProgress: 1,
    });
    // The test grant belongs to the fully initialized SettingsStore/PIN policy.
    w.parentAccess = true;
    const accessTimer = [...timers.keys()][0];
    return {
        accessTimer,
        calls,
        stored,
        timers,
        typed: () => vm.runInContext("settings", w),
        w,
    };
}
function save(w) {
    w.listKeyHandlerFn(w.keys.GREEN);
}

// Media-language rows appear only for managed engines, with persisted codes
// independent of translated/native display names and the interface locale.
for (const managed of [false, true]) {
    const { w, stored } = fixture();
    w.__ottCoreTransport = { play() {} };
    if (managed) w.stbPlay = w.__ottCoreTransport.play;
    w.settingsInterface();
    const audio = w.listArray.find(
        (row) => row.settingId === "preferredAudioLanguage"
    );
    const subtitle = w.listArray.find(
        (row) => row.settingId === "preferredSubtitleLanguage"
    );
    assert.equal(Boolean(audio), managed);
    assert.equal(Boolean(subtitle), managed);
    if (managed) {
        assert.equal(audio.settingValues.length, 89);
        assert.equal(subtitle.settingValues.length, 90);
        assert.equal(audio.settingValues[0], "");
        assert.equal(subtitle.settingValues[1], "off");
        audio.val = audio.settingValues.indexOf("_rus");
        subtitle.val = 1;
        assert.equal(w.__ottSettingsEditor.save(), true);
        assert.equal(stored.get("sPreferredAudioLanguage"), "_rus");
        assert.equal(stored.get("sPreferredSubtitleLanguage"), "off");
    }
}

// Source access uses the same native capability for playback and Settings.
for (const profile of ["server", "capacitor-ios", "capacitor-android"]) {
    const { w, calls } = fixture(profile);
    if (w.Capacitor)
        w.Capacitor.Plugins = {
            AccessMedia: { manage: () => calls.push("source-access") },
        };
    w.settingsManage();
    const access = w.listArray.find((item) => item.name === "Source access");
    assert.equal(Boolean(access), profile === "capacitor-ios");
    if (access) {
        access.action();
        assert.equal(calls.at(-1), "source-access");
        delete w.Capacitor.Plugins.AccessMedia;
        w.settingsManage();
        assert.equal(
            w.listArray.some((item) => item.name === "Source access"),
            false
        );
    }
}

// Row construction must preserve extension-visible translation order, receiver
// and the distinction between an absent draft value and an explicit value.
{
    const { w } = fixture();
    const trace = [];
    let initialRows;
    const createEditor = w.createSettingsEditor;
    w.createSettingsEditor = function (host, rows) {
        initialRows = rows.map((row) => ({
            fields: Object.keys(row),
            id: row.settingId,
            name: row.name,
            val: row.val,
            values: row.values,
        }));
        return createEditor(host, rows);
    };
    w.translationReceiver = "settings-host";
    w._ = function (text) {
        assert.equal(this.translationReceiver, "settings-host");
        trace.push("translate:" + text);
        return text === "Editor" || text === "Font type" ? "" : "T:" + text;
    };
    const editorValue = w.sEditor;
    Object.defineProperty(w, "sEditor", {
        configurable: true,
        get() {
            trace.push("read:editor");
            return editorValue;
        },
    });
    w.stbOptions();
    const editorStart = trace.indexOf("translate:Editor");
    assert.deepEqual(trace.slice(editorStart, editorStart + 4), [
        "translate:Editor",
        "read:editor",
        "translate:built-in",
        "translate:native",
    ]);
    const editor = initialRows.find((row) => row.id === "editor");
    assert.equal(editor.name, "Editor");
    assert.equal(editor.val, editorValue);
    assert.deepEqual(editor.fields, ["name", "settingId", "val", "values"]);
    assert.deepEqual(Array.from(editor.values), ["T:built-in", "T:native"]);
    assert.equal(
        initialRows.at(-1).name,
        '<div class="btn">T:Save Settings</div>'
    );
    assert.equal(initialRows.at(-2).values, w.noop);
    w.settingsInterface();
    const stopPlay = initialRows.find((row) => row.id === "stopPlay");
    assert.equal(stopPlay.fields.includes("val"), false);
    assert.equal(
        initialRows.find((row) => row.id === "fontSize").name,
        "Font type"
    );
    assert.equal(typeof w.__ottSettingsEditor.save, "function");
    w.strENTER = "ENTER";
    w.settingsChannels();
    assert.equal(
        initialRows.find((row) => row.id === "preview").values[2],
        "T:on ENTER"
    );
}
console.log(
    "OK: settings rows preserve translation receiver/order, fallback labels and initial draft fields"
);

// Each page must keep its own return target and close behavior when sharing
// draft setup. A retained save callback cannot commit after cancellation.
for (const [menu, caption] of [
    ["stbOptions", "Settings STB"],
    ["settingsInterface", "Interface settings"],
    ["settingsInfobar", "Infobar settings"],
    ["settingsLists", "Lists settings"],
    ["settingsChannels", "Channel list settings"],
    ["settingsButtons", "Buttons settings"],
    ["settingsMenu", "Select menu items"],
]) {
    for (const cancel of [false, true]) {
        const { w, stored } = fixture();
        const returnTarget = w[menu];
        w[menu]();
        assert.equal(
            w.document.getElementById("listCaption").innerHTML,
            caption
        );
        const editor = w.__ottSettingsEditor;
        const row = w.listArray.find(
            (item) => item.settingId && Array.isArray(item.values)
        );
        row.val = (row.val + 1) % row.values.length;
        const saveRow = w.listArray[w.listArray.length - 1].values;
        assert.equal(
            saveRow.name,
            menu === "stbOptions" ? "saveSettings" : "save"
        );
        assert.equal(saveRow.length, 0);
        const navigation = [];
        w.closeList = () => navigation.push("close");
        w.optionsList = (target) => navigation.push(target);
        if (menu === "stbOptions")
            w.stbOptions = () => navigation.push(returnTarget);
        if (cancel) {
            w.listKeyHandlerFn(w.keys.RETURN);
            saveRow();
            assert.equal(
                stored.size,
                1,
                menu +
                    ": cancelled draft preserves only the existing protected PIN"
            );
            assertOnlyInitialPin(stored);
        } else {
            saveRow();
            assert.ok(stored.size > 1, menu + ": save row commits its draft");
        }
        assert.equal(editor.active(), false, menu + ": draft is closed");
        assert.deepEqual(
            navigation,
            !cancel && menu !== "settingsMenu"
                ? ["close", returnTarget]
                : [returnTarget],
            menu + ": return behavior is preserved"
        );
    }
}

// LG Left opens Menu by default even when the shared HTML5 core exposes volume
// APIs. This is a platform default only: existing explicit mappings stay intact.
const leftDefaultFailures = [];
for (const device of [
    "lg/webos",
    "lg/netcast",
    "pc",
    "pc2",
    "nodejs",
    "android",
    "mag",
    "samsung/tizen",
    "samsung/maple",
    undefined,
]) {
    for (const limited of [false, true]) {
        const { w, stored, typed } = fixture("server", limited, "full", device);
        const expected = device?.startsWith("lg/") ? 1 : 14;
        try {
            assert.equal(typed().alFun, expected, "Initial default");
            assert.equal(
                w.defaultSettings().alFun,
                expected,
                "Factory reset default"
            );
            assert.equal(
                w.defaultSettings().arFun,
                device?.startsWith("lg/") ? 4 : 13,
                "LG Right opens channel information; other defaults stay unchanged"
            );
            vm.runInContext("loadSettings();", w);
            assert.equal(typed().alFun, expected, "Absent stored Left mapping");
            assert.equal(w.sALfun, expected, "Legacy global matches settings");
            assert.equal(
                stored.has("sALfun"),
                false,
                "Reading defaults does not persist them"
            );

            for (const invalid of ["", "NaN", "invalid"]) {
                stored.set("sALfun", invalid);
                vm.runInContext("loadSettings();", w);
                assert.equal(
                    typed().alFun,
                    expected,
                    "Invalid stored mapping: " + invalid
                );
                assert.equal(
                    stored.get("sALfun"),
                    invalid,
                    "Loading does not rewrite stored preferences"
                );
            }
            for (const explicit of [0, 1, 4, 14, 19]) {
                stored.set("sALfun", String(explicit));
                vm.runInContext("loadSettings();", w);
                assert.equal(
                    typed().alFun,
                    explicit,
                    "Keep explicit action " + explicit
                );
                assert.equal(w.sALfun, explicit);
                assert.equal(
                    w.defaultSettings().alFun,
                    expected,
                    "Factory defaults ignore current preferences"
                );
                vm.runInContext("saveSettings(settings); loadSettings();", w);
                assert.equal(
                    typed().alFun,
                    explicit,
                    "Explicit action survives a save/reload"
                );
                assert.equal(stored.get("sALfun"), String(explicit));
            }
            stored.clear();
            vm.runInContext("loadSettings();", w);
            assert.equal(
                typed().alFun,
                expected,
                "Cleared settings restore platform default"
            );
        } catch (error) {
            leftDefaultFailures.push(
                String(device) +
                    " / volume API " +
                    !limited +
                    ": " +
                    error.message
            );
        }
    }
}
for (const device of ["lg/webos", "lg/netcast"]) {
    const { w, typed } = fixture();
    assert.equal(
        typed().alFun,
        14,
        "Settings can initialize before device is known"
    );
    w.ott_device = device;
    try {
        vm.runInContext("loadSettings();", w);
        assert.equal(
            typed().alFun,
            1,
            "Device detection before settings load updates the fallback"
        );
        assert.equal(
            w.defaultSettings().alFun,
            1,
            "Factory defaults read current device"
        );
    } catch (error) {
        leftDefaultFailures.push(
            device + " / late device detection: " + error.message
        );
    }
}
assert.equal(leftDefaultFailures.length, 0, leftDefaultFailures.join("\n"));
const noWindowSettings = vm.createContext({});
vm.runInContext(
    compile(
        fs.readFileSync(path.join(root, "src/settings/store.ts"), "utf8") +
            "\n" +
            fs.readFileSync(path.join(root, "src/settings/index.ts"), "utf8")
    ),
    noWindowSettings
);
assert.equal(
    noWindowSettings.defaultSettings().alFun,
    14,
    "Settings remain usable without a browser window"
);
console.log(
    "OK: LG Left defaults to Menu, other platforms retain volume and explicit mappings survive save/reset"
);

// A second metadata write must not decide whether an explicit choice survives.
for (const useDraft of [false, true]) {
    const { w, typed, stored } = fixture();
    w.ott_device = "lg/webos";
    stored.set("sARfun", "13");
    const write = w.storage.set;
    w.storage.set = (key, value) => {
        if (key === "sLgRightInfoMigrated") return;
        write(key, value);
    };
    vm.runInContext("loadSettings();", w);
    assert.equal(typed().arFun, 4);
    assert.equal(stored.get("sARfun"), "4");
    assert.equal(
        vm.runInContext(
            useDraft
                ? "var choice = beginSettingsDraft(); choice.set('arFun', 13); choice.commit();"
                : "saveSettings({ arFun: 13 });",
            w
        ),
        true
    );
    vm.runInContext("loadSettings();", w);
    assert.equal(
        typed().arFun,
        13,
        "Explicit choice survives missing migration metadata"
    );
    assert.equal(stored.get("sARfun"), "+13");
    assert.equal(
        w.storage.getI("sARfun"),
        13,
        "Legacy integer readers remain compatible"
    );
}
for (const initial of [4, 13]) {
    const { w, typed, stored } = fixture();
    w.ott_device = "lg/netcast";
    vm.runInContext(
        "loadSettings(); saveSettings({ arFun: " + initial + " });",
        w
    );
    const before = stored.get("sARfun");
    const write = w.storage.set;
    w.storage.set = (key, value) => {
        if (key === "sEfun") throw new Error("Rejected later field");
        write(key, value);
    };
    assert.equal(
        vm.runInContext(
            "var choice = beginSettingsDraft(); choice.set('arFun', " +
                (initial === 4 ? 13 : 4) +
                "); choice.set('eFun', 2); choice.commit();",
            w
        ),
        false
    );
    assert.equal(
        stored.get("sARfun"),
        before,
        "Failed transaction restores exact choice bytes"
    );
    vm.runInContext("loadSettings();", w);
    assert.equal(
        typed().arFun,
        initial,
        "Rollback also preserves the interpretation after reload"
    );
}

// Upgrade legacy LG volume defaults once; later explicit choices remain valid.
for (const device of ["lg/webos", "lg/netcast", "pc", undefined]) {
    for (const value of [13, 0, 1, 4, 10, 19]) {
        const { w, typed, stored } = fixture();
        w.ott_device = device;
        stored.set("sARfun", String(value));
        vm.runInContext("loadSettings();", w);
        const expected = device?.startsWith("lg/") && value === 13 ? 4 : value;
        assert.equal(typed().arFun, expected, device + ": migrated Right");
        assert.equal(w.sARfun, expected, "Legacy facade matches UI setting");
        assert.equal(stored.get("sARfun"), String(expected));
        vm.runInContext("loadSettings();", w);
        assert.equal(typed().arFun, expected, "Upgrade survives reload");
        vm.runInContext("saveSettings({ arFun: 13 }); loadSettings();", w);
        assert.equal(
            typed().arFun,
            13,
            "Post-upgrade volume choice is retained"
        );
    }
}
for (const failure of ["throw", "memory-only"]) {
    const { w, typed, stored } = fixture();
    w.ott_device = "lg/webos";
    stored.set("sARfun", "13");
    const write = w.storage.setI;
    const read = w.storage.get;
    let memory;
    w.storage.get = (key) => (key === "sARfun" && memory ? memory : read(key));
    w.storage.setI = (key, value) => {
        if (key !== "sARfun") return write(key, value);
        if (failure === "throw") throw new Error("Storage unavailable");
        memory = String(value);
    };
    vm.runInContext("loadSettings();", w);
    assert.equal(typed().arFun, 4, failure + ": Info works in this session");
    assert.equal(stored.get("sARfun"), "13", "Backing value was not changed");
    vm.runInContext("loadSettings();", w);
    assert.equal(typed().arFun, 4, "Same-page reload still uses Info");
    w.storage.get = read;
    w.storage.setI = write;
    vm.runInContext("loadSettings();", w);
    assert.equal(typed().arFun, 4);
    assert.equal(stored.get("sARfun"), "4");
}
console.log(
    "OK: legacy LG Right volume migrates to Info once and retries failed persistence"
);

for (const device of ["lg/webos", "lg/netcast", "pc", undefined]) {
    for (const [field, legacy, webosDefault, otherDefault, explicit] of [
        ["arFun", "sARfun", 4, 13, [0, 1, 4, 10, 13, 19]],
        ["eFun", "sEfun", 1, 0, [0, 1, 2, 3, 4]],
    ]) {
        const { w, typed, stored } = fixture();
        w.ott_device = device;
        const platformDefault =
            field === "arFun"
                ? device?.startsWith("lg/")
                : device === "lg/webos";
        const fallback = platformDefault ? webosDefault : otherDefault;
        vm.runInContext("loadSettings();", w);
        assert.equal(
            typed()[field],
            fallback,
            field + ": detected platform default"
        );
        assert.equal(w[legacy], fallback, field + ": legacy alias");
        assert.equal(
            stored.has(legacy),
            false,
            field + ": defaults are not persisted"
        );
        for (const invalid of ["", "NaN", "invalid", "-1", "65"]) {
            stored.set(legacy, invalid);
            vm.runInContext("loadSettings();", w);
            assert.equal(
                typed()[field],
                fallback,
                field + ": invalid fallback"
            );
            assert.equal(stored.get(legacy), invalid, "No preference rewrite");
        }
        for (const value of explicit) {
            stored.set(
                legacy,
                field === "arFun" && platformDefault && value === 13
                    ? "+13"
                    : String(value)
            );
            vm.runInContext(
                "loadSettings(); saveSettings(settings); loadSettings();",
                w
            );
            assert.equal(
                typed()[field],
                value,
                field + ": explicit mapping survives reload"
            );
            assert.equal(
                w[legacy],
                value,
                field + ": legacy alias preserves mapping"
            );
            assert.equal(
                w.defaultSettings()[field],
                fallback,
                field + ": reset uses platform default"
            );
        }
        stored.clear();
        vm.runInContext("loadSettings();", w);
        assert.equal(
            typed()[field],
            fallback,
            field + ": cleared preference restores default"
        );
    }
}
console.log(
    "OK: LG information/exit defaults preserve explicit remote mappings"
);

// webOS hides engine details in both menus and ignores an old manual preference
// at runtime, while preserving it in storage for another platform.
for (const device of ["lg/webos", "lg/netcast", "pc"]) {
    for (const limited of [false, true]) {
        for (const preference of [null, 0, 1, 2, 3]) {
            const { w, stored, typed } = fixture(
                "server",
                limited,
                "full",
                device
            );
            if (preference !== null)
                stored.set("provider:sPlayers", String(preference));
            w.loadChannels();
            if (device === "lg/webos") {
                assert.equal(w.playerMode, 3, "webOS runtime always uses Auto");
                assert.equal(w.sPlayers, 3);
                assert.equal(typed().players, 3);
            }
            for (const menu of ["stbOptions", "settingsInterface"]) {
                w[menu]();
                assert.equal(
                    w.listArray.some(
                        (row) => row.name === "Type of player for streaming"
                    ),
                    device !== "lg/webos",
                    device + " " + menu + ": player choice visibility"
                );
                assert.equal(w.listArray, w.listDataArray);
                const buffer = w.listArray.find(
                    (row) => row.name === "Buffer Size, s"
                );
                const nextBuffer = (w.sBufSize + 1) % buffer.values.length;
                buffer.val = nextBuffer;
                const editor = w.listArray.find((row) => row.name === "Editor");
                if (editor) editor.val = 1;
                save(w);
                assert.equal(
                    w.sBufSize,
                    nextBuffer,
                    "Buffer row remains aligned after removing the engine row"
                );
                assert.equal(stored.get("sBufSize"), String(nextBuffer));
                if (editor)
                    assert.equal(
                        w.sEditor,
                        1,
                        "Previous row still saves correctly"
                    );
                if (device === "lg/webos") {
                    assert.equal(w.playerMode, 3);
                    assert.equal(
                        stored.get("provider:sPlayers"),
                        preference === null ? undefined : String(preference),
                        "Hidden choice must not overwrite a saved preference"
                    );
                }
            }
        }
    }
}
console.log(
    "OK: webOS engine selector hidden in both menus; Auto and neighbouring saves preserved; PC/NetCast choices retained"
);

// Defaults apply per provider. Manual choices retain their original numeric
// values, and both settings entry points can persist Auto without a restart.
for (const profile of [
    "server",
    "tauri",
    "tauri-internals",
    "capacitor-android",
    "capacitor-ios",
]) {
    const { w, stored, typed } = fixture(profile);
    const isTauri = profile.startsWith("tauri");
    const choices = ["html5", "hls.js", "shaka"];
    if (isTauri) choices.push("auto");
    w.loadChannels();
    assert.equal(w.sPlayers, isTauri ? 3 : 0, profile + ": provider default");
    assert.equal(
        w.playerMode,
        isTauri ? 3 : 1,
        "Auto remains selected while legacy platforms keep their HLS fallback"
    );
    assert.equal(typed().players, w.sPlayers, "typed preference stays in sync");
    assert.equal(
        stored.has("provider:sPlayers"),
        false,
        "default is not persisted"
    );
    for (const menu of ["stbOptions", "settingsInterface"]) {
        w[menu]();
        let row = w.listArray.find(
            (item) => item.name === "Type of player for streaming"
        );
        assert.deepEqual(
            Array.from(row.values),
            choices,
            profile + ": choices"
        );
        assert.equal(
            row.val,
            w.sPlayers,
            "menu shows loaded provider preference"
        );
        row.val = 2;
        save(w);
        assert.equal(typed().players, 2, menu + ": typed choice follows save");
        if (isTauri) {
            w[menu]();
            row = w.listArray.find(
                (item) => item.name === "Type of player for streaming"
            );
            row.val = 3;
            save(w);
            assert.equal(
                w.playerMode,
                3,
                menu + ": Auto is selected immediately"
            );
            assert.equal(stored.get("provider:sPlayers"), "3");
            assert.equal(typed().players, 3);
            w.loadChannels();
            assert.equal(w.sPlayers, 3, "Auto survives provider reload");
        }
    }
    for (const explicit of [0, 1, 2]) {
        stored.set("provider:sPlayers", String(explicit));
        w.loadChannels();
        assert.equal(w.sPlayers, explicit, profile + ": stored preference");
        assert.equal(w.playerMode, explicit, "stored engine remains explicit");
        assert.equal(typed().players, explicit);
    }
    if (!isTauri) {
        stored.set("provider:sPlayers", "3");
        w.loadChannels();
        assert.equal(
            w.sPlayers,
            1,
            "imported Auto uses HLS when native HLS is unavailable"
        );
        assert.equal(w.playerMode, 1);
        assert.equal(typed().players, 1);
        assert.equal(
            stored.get("provider:sPlayers"),
            "3",
            "import remains intact"
        );
    }
    stored.delete("provider:sPlayers");
    w.loadChannels();
    assert.equal(
        w.sPlayers,
        isTauri ? 3 : 0,
        "next provider gets its own default"
    );
}

// A Tauri export can be imported into browsers with or without native HLS.
// These media fixtures deliberately omit track APIs, as Firefox does.
for (const nativeHls of [false, true]) {
    for (const supportedHls of [false, true]) {
        const { w, stored, typed } = fixture("server");
        w.video.canPlayType = () => (nativeHls ? "probably" : "");
        w.Hls.isSupported = () => supportedHls;
        stored.set("provider:sPlayers", "3");
        w.loadChannels();
        const expected = !nativeHls && supportedHls ? 1 : 0;
        assert.equal(
            w.sPlayers,
            expected,
            "Imported Auto uses a supported mode"
        );
        assert.equal(w.playerMode, expected, "Effective engine matches menu");
        assert.equal(typed().players, expected, "Typed engine matches menu");
        assert.equal(stored.get("provider:sPlayers"), "3");
        w.setPlayerMode(3);
        assert.equal(
            w.playerMode,
            expected,
            "Direct mode selection is consistent"
        );
        for (const explicit of [0, 1, 2]) {
            stored.set("provider:sPlayers", String(explicit));
            w.loadChannels();
            assert.equal(
                w.playerMode,
                explicit,
                "Explicit modes stay unchanged"
            );
            assert.equal(w.sPlayers, explicit);
            assert.equal(typed().players, explicit);
        }
    }
}

// Full and Play use the same production renderer and real distribution helper.
// Every action is present, matching the actual window aliases, so undefined
// fixture functions cannot accidentally make the Play filter hide extra rows.
for (const distribution of ["full", "play"]) {
    const { w, stored, calls } = fixture(
        "capacitor-android",
        false,
        distribution
    );
    for (const action of [
        "cloudSendSettings",
        "cloudLoadSettings",
        "exportSettingsUI",
        "importSettingsUI",
        "edit_dealer",
        "edit_dealer_remote",
        "loadOpt",
        "saveOpt",
    ])
        w[action] = () => calls.push(action);
    let confirmClear;
    w.confirmBox = (_message, yes) => {
        confirmClear = yes;
    };
    w.stbClearAllItems = () => {
        calls.push("clear");
        stored.clear();
    };
    w.restart = () => calls.push("restart");
    stored.set("saved-provider-setting", "preserved");
    w.settingsManage();
    const fullRows = [
        "Save settings to storage",
        "Load settings from storage",
        "Save settings",
        "Load settings",
        "",
        "Export settings",
        "Import settings",
        "",
        "Clear settings",
        "",
        "Enter Provider Code",
        "Enter Provider Code on PC or Phone",
        "Debug HUD",
    ];
    const playRows = [
        "Save settings to storage",
        "Save settings",
        "",
        "Export settings",
        "",
        "Clear settings",
        "",
        "Debug HUD",
    ];
    assert.deepEqual(
        Array.from(w.listArray, (item) => item.name),
        distribution === "play" ? playRows : fullRows,
        distribution + " exact management menu"
    );
    assert.equal(
        w.listDataArray,
        w.listArray,
        distribution + " renders its final filtered rows"
    );
    if (distribution === "play") {
        for (const action of [
            w.edit_dealer,
            w.edit_dealer_remote,
            w.cloudLoadSettings,
            w.importSettingsUI,
            w.loadOpt,
        ])
            assert(
                !w.listArray.some((item) => item.action === action),
                "Play cannot invoke activation/import through any management row"
            );
    }
    function choose(label) {
        w.selIndex = w.listArray.findIndex((item) => item.name === label);
        assert(w.selIndex >= 0, label + " remains available");
        assert.equal(w.listKeyHandlerFn(w.keys.ENTER), true);
    }
    choose("Export settings");
    choose("Save settings to storage");
    assert.deepEqual(calls, ["exportSettingsUI", "saveOpt"]);
    assert.equal(stored.get("saved-provider-setting"), "preserved");
    choose("Clear settings");
    assert.equal(
        typeof confirmClear,
        "function",
        "clear still requires confirmation"
    );
    assert.deepEqual(
        [...stored],
        [
            [
                "parentPIN",
                require("./helpers/protected-pin-fixture.cjs").record("1234"),
            ],
            ["saved-provider-setting", "preserved"],
        ],
        "opening confirmation preserves both the PIN and ordinary settings"
    );
    confirmClear();
    assert.deepEqual(calls.slice(-2), ["clear", "restart"]);
    assert.equal(stored.size, 0);
    w.listKeyHandlerFn(w.keys.RETURN);
    assert.equal(calls[calls.length - 1], "options");
}
console.log(
    "OK: Android Full management unchanged; Play hides activation and every load/import route while export, save and confirmed clear remain"
);

for (const profile of [
    "server",
    "tauri",
    "capacitor-android",
    "capacitor-ios",
]) {
    for (const limited of [false, true]) {
        for (const menu of menus) {
            const { w, stored } = fixture(profile, limited);
            w[menu]();
            assert.ok(w.listArray.length > 2, `${profile}: ${menu} populated`);
            assert.equal(
                w.listDataArray,
                w.listArray,
                `${menu}: renderer sees current rows`
            );
            for (const row of w.listArray) {
                assert.equal(typeof w.getListItem(row, 0), "string");
                if (Array.isArray(row.values)) {
                    assert.ok(
                        Number.isInteger(row.val) &&
                            row.val >= 0 &&
                            row.val < row.values.length,
                        `${menu}: valid selection ${row.name}`
                    );
                }
            }
            w.listKeyHandlerFn(w.keys.RETURN);
            assert.equal(
                stored.size,
                1,
                `${menu}: cancel preserves only the existing protected PIN`
            );
            assertOnlyInitialPin(stored);
        }
    }
    const saveCases = [
        [
            "settingsLists",
            ["sNoSmall", "sPageSize", "sFontShift", "sListPos", "sShowScroll"],
        ],
        [
            "settingsInfobar",
            [
                "sInfoTimeout",
                "sInfoSlide",
                "sInfoSwitch",
                "sInfoChange",
                "sInfoRew",
                "sThumbnail",
            ],
        ],
        [
            "settingsChannels",
            [
                "sShowNum",
                "sShowPikon",
                "sShowName",
                "sShowProgram",
                "sShowProgress",
                "sShowArchive",
                "sShowDescr",
                "sPreview",
                "sNextCountL",
                "sFavorites",
            ],
        ],
        [
            "settingsButtons",
            [
                "sArrowFun",
                "sRewFun",
                "sPNFun",
                "sALfun",
                "sARfun",
                "sAUfun",
                "sADfun",
                "sRWfun",
                "sFFfun",
                "sPREVfun",
                "sNEXTfun",
                "sRfun",
                "sGfun",
                "sYfun",
                "sBfun",
                "sEfun",
                "sOkfun",
            ],
        ],
    ];
    for (const [menu, keys] of saveCases) {
        const current = fixture(profile).w;
        current[menu]();
        const expected = keys.map((key, index) => {
            const row = current.listArray[index];
            row.val = (row.val + 1) % row.values.length;
            return (
                row.val +
                (key === "sPageSize" ? 10 : key === "sInfoTimeout" ? 3 : 0)
            );
        });
        save(current);
        keys.forEach((key, index) =>
            assert.equal(
                current[key],
                expected[index],
                `${menu}: ${key} applies selected value`
            )
        );
    }
    const parental = fixture(profile);
    parental.w.parentControlSetup();
    parental.w.listArray[1].val = 0;
    parental.w.listArray[2].val = 1;
    parental.w.listArray[3].val = 1;
    save(parental.w);
    assert.equal(parental.stored.get("sPSchannels"), "0");
    assert.equal(parental.stored.get("sPSoptions"), "1");
    assert.equal(parental.typed().requirePinForProviderSelection, 1);
    const { w, stored, typed, timers, accessTimer } = fixture(profile);
    assert.equal(
        typed().localHttpEnabled,
        0,
        `${profile}: HTTP remote is opt-in`
    );
    assert.equal(typed().localHttpDeviceCode, "");
    assert.equal(w.sLocalHttpEnabled, 0);
    assert.equal(typed().commandServerEnabled, 0);
    assert.equal(typed().commandServerToken, "");
    w.settingsButtons();
    save(w);
    assert.deepEqual(
        [w.s13dur, w.s46dur, w.s79dur],
        [15, 180, 600],
        "unchanged save preserves seconds"
    );
    const durations = [
        5, 10, 15, 20, 30, 60, 120, 180, 240, 300, 600, 900, 1200, 1800, 3600,
    ];
    for (let index = 0; index < durations.length; index++) {
        w.settingsButtons();
        const rows = w.listArray.filter((row) =>
            row.name.startsWith("Rewind step")
        );
        rows.forEach((row) => {
            row.val = index;
        });
        save(w);
        assert.deepEqual(
            [w.s13dur, w.s46dur, w.s79dur],
            [durations[index], durations[index], durations[index]]
        );
        assert.equal(stored.get("s13dur"), String(durations[index]));
        assert.equal(typed().seek13Duration, durations[index]);
    }
    w.settingsInterface();
    const themeRow = w.listArray.find(
        (row) => row.settingId === "interfaceTheme"
    );
    assert.equal(
        themeRow.val,
        2,
        "Studio 2026 is selected in interface settings"
    );
    themeRow.val = 0;
    w.listArray.find((row) => row.name === "Type of player for streaming").val =
        2;
    w.listArray.find((row) => row.name === "Sleep timer").val = 1;
    save(w);
    assert.equal(w.playerMode, 2, "actual engine mode changes");
    assert.equal(typed().interfaceTheme, 0);
    assert.equal(stored.get("sInterfaceTheme"), "0");
    assert.equal(stored.get("provider:sPlayers"), "2");
    assert.equal(
        [...timers.entries()].filter(([id]) => id !== accessTimer)[0][1].ms,
        1800000,
        "save immediately rearms 30-minute timer"
    );
    w.settingsMenu();
    w.listArray[0].val = 1;
    save(w);
    assert.deepEqual(Array.from(typed().hideMenus), ["channels"]);
    vm.runInContext("loadSettings();", w);
    assert.deepEqual(
        Array.from(w.sHideMenus),
        ["channels"],
        "hidden menu survives restart"
    );
    // Editing a parental/remote value followed by export or another bulk save must not overwrite it.
    Object.assign(w, {
        parentPIN: "9876",
        sLocalCmdUrl: "https://example.invalid/local",
        sLocalHttpDeviceCode: "a".repeat(64),
        sLocalHttpEnabled: 1,
        sNoColorKeys: 1,
        sPSoptions: 1,
        sRfun: 4,
    });
    vm.runInContext(
        'settings.commandServerAddress = "http://private-server:8081"; settings.commandServerToken = "private-code"; settings.commandServerEnabled = 1;',
        w
    );
    let serverRevoked = false;
    w.__ottCommandServer = {
        configure(config) {
            assert.equal(config.enabled, false);
            serverRevoked = true;
        },
    };
    const exported = JSON.parse(w.exportSettings());
    for (const key of [
        "commandServerAddress",
        "commandServerToken",
        "commandServerEnabled",
    ])
        assert.equal(Object.hasOwn(exported.settings, key), false);

    assert.equal(exported.settings.rFun, 4);
    assert.equal(
        Object.hasOwn(exported.settings, "localHttpEnabled"),
        false,
        "exports cannot grant HTTP access on another device"
    );
    assert.equal(
        Object.hasOwn(exported.settings, "localHttpDeviceCode"),
        false,
        "exports cannot disclose the local credential"
    );
    assert.equal(exported.settings.noColorKeys, 1);
    assert.equal(exported.settings.psOptions, 1);
    assert.match(exported.settings.parentPin, /^pbkdf2-sha256\$600000\$/);
    const pinParts = exported.settings.parentPin.split("$");
    assert.equal(
        pinParts[3],
        require("node:crypto")
            .pbkdf2Sync(
                "9876",
                Buffer.from(pinParts[2], "hex"),
                600000,
                32,
                "sha256"
            )
            .toString("hex")
    );
    assert.equal(
        exported.settings.localCmdUrl,
        "https://example.invalid/local"
    );
    vm.runInContext("saveSettings(settings); loadSettings();", w);
    assert.equal(typed().rFun, 4);
    assert.match(typed().parentPin, /^pbkdf2-sha256\$600000\$/);
    const savedPinParts = typed().parentPin.split("$");
    assert.equal(
        savedPinParts[3],
        require("node:crypto")
            .pbkdf2Sync(
                "9876",
                Buffer.from(savedPinParts[2], "hex"),
                600000,
                32,
                "sha256"
            )
            .toString("hex")
    );
    assert.equal(
        typed().localHttpEnabled,
        1,
        "explicit local consent survives restart"
    );
    assert.equal(typed().localHttpDeviceCode, "a".repeat(64));
    w.importSettings(
        JSON.stringify({
            ...exported,
            settings: {
                ...exported.settings,
                commandServerAddress: "https://attacker",
                commandServerEnabled: 1,
                commandServerToken: "injected-code",
                localHttpDeviceCode: "injected",
                localHttpEnabled: 1,
            },
        })
    );
    assert.equal(
        typed().localHttpDeviceCode,
        "a".repeat(64),
        "import cannot replace this device's credential"
    );
    assert.equal(
        serverRevoked,
        true,
        "JSON import revokes an active connection immediately"
    );
    assert.equal(typed().commandServerEnabled, 0);
    assert.equal(typed().commandServerToken, "private-code");
    assert.equal(typed().commandServerAddress, "http://private-server:8081");
    stored.set("sLocalHttpEnabled", "0");
    stored.set("sLocalHttpDeviceCode", "");
    vm.runInContext("loadSettings();", w);
    w.importSettings(
        JSON.stringify({
            ...exported,
            settings: {
                ...exported.settings,
                commandServerAddress: "https://attacker",
                commandServerEnabled: 1,
                commandServerToken: "injected-code",
                localHttpDeviceCode: "injected",
                localHttpEnabled: 1,
            },
        })
    );
    assert.equal(
        typed().localHttpEnabled,
        0,
        "import cannot enable HTTP access"
    );
    assert.equal(typed().localHttpDeviceCode, "");
}
for (const bad of [-1, 1, 2, 7, 999, Number.NaN]) {
    const { w, stored } = fixture();
    for (const key of ["s13dur", "s46dur", "s79dur"])
        stored.set(key, String(bad));
    vm.runInContext("loadSettings();", w);
    assert.deepEqual([w.s13dur, w.s46dur, w.s79dur], [15, 180, 600]);
    // The menu also protects against invalid values introduced by an old adapter.
    Object.assign(w, { s13dur: bad, s46dur: bad, s79dur: bad });
    w.settingsButtons();
    save(w);
    assert.deepEqual([w.s13dur, w.s46dur, w.s79dur], [15, 180, 600]);
}
const { w, timers, calls, accessTimer } = fixture();
// Authorization expiry is independent of inactivity, including the 60-minute case.
const inactivity = () =>
    [...timers.entries()]
        .filter(([id]) => id !== accessTimer)
        .map(([, job]) => job);
for (const [index, minutes] of [0, 30, 60, 120, 180].entries()) {
    vm.runInContext(`settings.sleepTimeout = ${index}; setSleepTimeout();`, w);
    assert.equal(inactivity().length, minutes ? 1 : 0);
    if (minutes) assert.equal(inactivity()[0].ms, minutes * 60000);
}
const retiredInactivity = inactivity()[0].callback;
vm.runInContext("setSleepTimeout();", w);
retiredInactivity();
assert.equal(
    calls.filter((call) => call === "standby").length,
    0,
    "an escaped old timeout cannot interrupt a refreshed inactivity period"
);
const disabledInactivity = inactivity()[0].callback;
vm.runInContext("settings.sleepTimeout = 0; setSleepTimeout();", w);
assert.equal(inactivity().length, 0, "disable cancels pending timer");
disabledInactivity();
assert.equal(
    calls.filter((call) => call === "standby").length,
    0,
    "an escaped timeout cannot restore disabled inactivity"
);
vm.runInContext("settings.sleepTimeout = 1; setSleepTimeout();", w);
inactivity()[0].callback();
assert.equal(calls.filter((call) => call === "standby").length, 1);
vm.runInContext("settings.sleepTimeout = 0; setSleepTimeout();", w);
const limited = fixture("server", true).w;
limited.settingsManage();
assert.ok(limited.listArray.some((row) => row.name === "Export settings"));
assert.ok(!limited.listArray.some((row) => row.name === "Clear settings"));
console.log(
    "OK: Settings submenu population, save/cancel, duration/engine application and persistence across four platform profiles"
);

// Editing identity follows stable IDs after capabilities filter or reorder rows.
{
    const f = fixture("server", true),
        w = f.w;
    w.settingsInterface();
    const timezone = w.listArray.find((row) => row.settingId === "timezone");
    const font = w.listArray.find((row) => row.settingId === "fontSize");
    timezone.val = 2;
    font.val = 3;
    w.listArray.reverse();
    save(w);
    assert.equal(f.stored.get("sTimezone"), "2");
    assert.equal(f.stored.get("sFont"), "3");
    assert.equal(
        f.stored.has("sPipSize"),
        false,
        "hidden controls are never written"
    );
    w.settingsLists();
    w.listArray.find((row) => row.settingId === "pageSize").val = 17;
    w.providerId = "replacement";
    save(w);
    assert.equal(
        f.stored.has("sPageSize"),
        false,
        "source replacement revokes a settings draft"
    );
}
{
    const f = fixture(),
        w = f.w;
    w.parentPIN = "*";
    w.parentControlSetup();
    w.listArray[0].val = 1;
    const pins = [];
    w.enterPinCode = (_message, callback) => pins.push(callback);
    save(w);
    assert.equal(pins.length, 1);
    assert.equal(f.stored.size, 1);
    assertOnlyInitialPin(f.stored);
    w.listKeyHandlerFn(w.keys.RETURN);
    pins[0]("9876");
    assert.equal(pins.length, 1, "cancel revokes the nested PIN continuation");
    assert.equal(f.stored.size, 1);
    assertOnlyInitialPin(f.stored);
    assert.equal(w.parentPIN, "*");
}
console.log(
    "OK: actual filtered/reordered settings rows and cancelled PIN/source continuations"
);

// Execute actual shared standby functions and both native wrapper bodies. Only
// native APIs/DOM/playback are mocked; the production state and timer logic run.
const indexText = fs.readFileSync(path.join(root, "src/index.ts"), "utf8");
const indexAst = ts.createSourceFile(
    "index.ts",
    indexText,
    ts.ScriptTarget.Latest,
    true
);
const standbyWrappers = [];
function collectStandby(node) {
    if (
        ts.isPropertyAssignment(node) &&
        node.name.getText(indexAst) === "standby" &&
        ts.isFunctionExpression(node.initializer)
    ) {
        standbyWrappers.push(
            "coreDeviceEffects.standby = " + node.initializer.getText(indexAst)
        );
    }
    ts.forEachChild(node, collectStandby);
}
collectStandby(indexAst);
assert.equal(standbyWrappers.length, 2);
for (const profile of [
    "server",
    "tauri",
    "capacitor-android",
    "capacitor-ios",
]) {
    const { w, timers, calls, accessTimer } = fixture(profile);
    const inactivity = () =>
        [...timers.entries()]
            .filter(([id]) => id !== accessTimer)
            .map(([, job]) => job);
    w.document.body = { style: {} };
    w.stbStop = () => calls.push("stop");
    w.startPlayer = () => calls.push("start");
    vm.runInContext("var _standby = false; var coreDeviceEffects = {};", w);
    vm.runInContext(
        compile(
            selectedSource("src/core/index.ts", [
                "stbIsStandby",
                "stbSetStandby",
                "stbToggleStandby",
            ])
        ),
        w
    );
    const original = w.stbToggleStandby;
    w.orig = original;
    w.origStandby = original;
    w.tauriInvoke = (command) => {
        calls.push(command);
        return Promise.resolve({ ok: true });
    };
    w.cap = {
        allowSleep: () => {
            calls.push("allow_sleep");
            return Promise.resolve();
        },
        preventSleep: () => {
            calls.push("prevent_sleep");
            return Promise.resolve();
        },
    };
    if (profile !== "server")
        vm.runInContext(
            compile(standbyWrappers[profile === "tauri" ? 0 : 1]),
            w
        );
    // A device override must still be used by the inactivity callback.
    const platformToggle = w.stbToggleStandby;
    let dispatches = 0;
    w.stbToggleStandby = () => {
        dispatches++;
        platformToggle();
    };
    vm.runInContext("settings.sleepTimeout = 1; setSleepTimeout();", w);
    const oldCallback = inactivity()[0].callback;
    w.stbToggleStandby();
    assert.equal(w.stbIsStandby(), true);
    assert.equal(
        inactivity().length,
        0,
        "manual standby cancels inactivity timer"
    );
    oldCallback();
    assert.equal(
        w.stbIsStandby(),
        true,
        "queued timeout cannot wake manual standby"
    );
    assert.equal(calls.filter((call) => call === "start").length, 0);
    w.stbToggleStandby();
    assert.equal(w.stbIsStandby(), false);
    assert.equal(inactivity().length, 1, "waking rearms inactivity timer");
    inactivity()[0].callback();
    assert.equal(w.stbIsStandby(), true);
    assert.equal(dispatches, 3, "timeout honors the current platform override");
    if (profile !== "server")
        assert.deepEqual(
            calls.filter((call) => call.endsWith("_sleep")),
            ["allow_sleep", "prevent_sleep", "allow_sleep"]
        );
}
console.log(
    "OK: inactivity never wakes manual standby; native wake locks follow actual shared state"
);

// Quality ceilings use explicit semantic values, not menu indexes, in storage.
{
    const { w, stored, typed } = fixture();
    w.settingsInterface();
    const height = w.listArray.find(
        (row) => row.settingId === "streamMaxHeight"
    );
    const bitrate = w.listArray.find(
        (row) => row.settingId === "streamMaxBitrate"
    );
    assert.equal(height.val, 0);
    height.val = height.settingValues.indexOf(720);
    bitrate.val = bitrate.settingValues.indexOf(4000000);
    assert.equal(w.__ottSettingsEditor.save(), true);
    assert.equal(stored.get("sStreamMaxHeight"), "720");
    assert.equal(stored.get("sStreamMaxBitrate"), "4000000");
    assert.equal(typed().streamMaxHeight, 720);
    assert.equal(typed().streamMaxBitrate, 4000000);
    w.settingsInterface();
    assert.equal(
        w.listArray.find((row) => row.settingId === "streamMaxHeight").val,
        3
    );
}
console.log(
    "OK: quality ceiling choices persist semantic height and bitrate values"
);
