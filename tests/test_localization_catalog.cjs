const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const {
    audit,
    collectSourceKeys,
    languageAssets,
    languageAssetPath,
    readDictionary,
    validateDictionary,
    validateEnglishFallbacks,
    validateIdenticalAllowlist,
} = require("../scripts/localization-catalog.cjs");
const root = path.resolve(__dirname, "..");
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "ottplay-localization-"));
function write(file, source) {
    const target = path.join(fixture, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
    return target;
}
try {
    for (const directory of ["src", "devices", "providers"])
        fs.mkdirSync(path.join(fixture, directory));
    write(
        "src/index.ts",
        `
        _( "New static message %1", version );
        w._(enabled ? "Enabled status" : "Disabled status");
        label("New setting label");
        renderButtonHint(13, "OK", "New action caption");
        createSettingsPage(w, "privateId", "New settings title", true, false);
        const choices = ["First choice", "Second choice"];
        w._(choices[index]);
        const object = { first: "First prompt", second: "Second prompt" };
        w._(object[index]);
        const raw = "Finite label";
        _(raw);
        optionsArr.push({ action: action, name: "New option", desc: "Option explanation" });
        var infoArr = [{ action: action, name: "New information", desc: "Information explanation" }];
        function it(value, title) { return _(title); }
        it(year, "New metadata heading");
        _(externalProvider.title);
        console.log("Not a translated message");
    `
    );
    write(
        "src/ui/menu-registry.ts",
        `var screenMenuDefinitions = [
        ["pip.toggle", "action", "Start PiP / Swap PiP", "PiP explanation"],
        ["settings.open", "action", "Another menu label", "Menu explanation"]
    ];`
    );
    write("src/ui/index.ts", 'hint(13, "ENTER", "Native editor action");');
    write("devices/example.js", '_("Adapter message");');
    write(
        "src/plugins/control-discovery.ts",
        `
        var message = "Discovery initial status";
        notify("waiting", "Approve at %1", address);
        finish("error", "Discovery failed");
    `
    );
    write("providers/example/provider.js", 'translate("Provider message");');
    write(
        "src/plugins/remote-screenshot.ts",
        `
        var message = "Screenshots initially disabled";
        message = "Screenshots permission active";
        failSelection("Screenshot source unavailable");
        var text = ready ? "Native screenshots connected" : "Select browser source";
        console.log("Not a screenshot UI message");
    `
    );
    write(
        "src/settings/cloud.ts",
        'fail("Cloud app-owned failure", response.detail);'
    );
    write(
        "src/swop/herenow-phone.ts",
        `
        function say(value) { locale.label(status, value); }
        say("Phone status");
        locale.label(button, "Phone action");
        locale.text("Phone text");
    `
    );
    write("src/settings/transfer-ui.ts", 'notice("New settings notice");');
    write(
        "index.html",
        '<script>bootStatus("Early startup status"); bootText("Early restart action"); console.log("Boot diagnostic");</script>'
    );
    const fixtureKeys = collectSourceKeys(fixture);
    assert(fixtureKeys.keys.has("Early startup status"));
    assert(fixtureKeys.keys.has("Early restart action"));
    assert(!fixtureKeys.keys.has("Boot diagnostic"));
    for (const key of [
        "New static message %1",
        "Enabled status",
        "Disabled status",
        "New setting label",
        "New action caption",
        "Native editor action",
        "New settings title",
        "First choice",
        "Second choice",
        "First prompt",
        "Second prompt",
        "Finite label",
        "New option",
        "Option explanation",
        "New information",
        "Information explanation",
        "New metadata heading",
        "Start PiP",
        "Swap PiP",
        "PiP explanation",
        "Another menu label",
        "Menu explanation",
        "Adapter message",
        "Provider message",
        "New settings notice",
        "Cloud app-owned failure",
        "Phone status",
        "Phone action",
        "Phone text",
        "OTT-play remote input",
        "Discovery initial status",
        "Approve at %1",
        "Discovery failed",
        "Screenshots initially disabled",
        "Screenshots permission active",
        "Screenshot source unavailable",
        "Native screenshots connected",
        "Select browser source",
    ])
        assert(
            fixtureKeys.keys.has(key),
            `New source key must be discovered: ${key}`
        );
    assert(!fixtureKeys.keys.has("Not a translated message"));
    assert(!fixtureKeys.keys.has("Not a screenshot UI message"));
    assert(!fixtureKeys.keys.has("privateId"));
    assert(
        fixtureKeys.dynamic.some(
            (entry) => entry.expression === "externalProvider.title"
        )
    );
    const duplicate = write(
        "duplicate.js",
        'var keyStrings = { "Same": "First", "Same": "Second" };'
    );
    assert.throws(() => readDictionary(duplicate), /duplicate key/);
    const english = { greeting: " %1<br/>%2 ", label: "Label" };
    assert.deepEqual(
        validateDictionary(
            english,
            { greeting: " %2<br>%1 ", label: "Tłumaczenie" },
            "example"
        ),
        []
    );
    for (const translation of [
        { greeting: " %1<br/>%1 ", label: "Label" },
        { greeting: " %1 %2 ", label: "Label" },
        { greeting: "%1<br/>%2", label: "Label" },
        { greeting: " %1<br/>%2 ", label: "" },
        { greeting: " %1<br/>%2 ", label: null },
        { greeting: " %1<br/>%2 " },
        { greeting: " %1<br/>%2 ", label: "Label", stale: "Stale" },
    ])
        assert(
            validateDictionary(english, translation, "broken").length,
            "Broken locale must fail"
        );
    for (const marker of [
        "0010",
        "s 0009 s",
        "─0036─",
        "ZXQ0QXZ",
        "ЗКСК0ККСЗ",
    ]) {
        assert(
            validateDictionary(
                { key: "Open settings" },
                { key: marker + " Ouvrir les paramètres" },
                "broken"
            ).some((error) => error.includes("translation batch marker")),
            marker
        );
    }
    const setup = {
        key: "Use https://example.org:8080/path and Authorization: Bearer; host_ott, OTT-play, ott approve NAME CODE and /playlist.m3u8.",
    };
    for (const token of [
        "https://example.org:8080/path",
        "Authorization: Bearer",
        "host_ott",
        "OTT-play",
        "ott approve NAME CODE",
        "/playlist.m3u8",
    ]) {
        assert(
            validateDictionary(
                setup,
                { key: setup.key.replace(token, "translated") },
                "broken"
            ).some((error) => error.includes("technical literal")),
            token
        );
    }
    const prose = {
        action: "Pause",
        brand: "Plex",
        message: "Open the player settings.",
    };
    const reviewed = [
        {
            key: "brand",
            locales: ["*"],
            reason: "Product name is invariant",
            value: "Plex",
        },
        {
            key: "action",
            locales: ["french"],
            reason: "French uses the same word",
            value: "Pause",
        },
    ];
    const translated = {
        action: "Pause",
        brand: "Plex",
        message: "Ouvrez les paramètres du lecteur.",
    };
    assert.deepEqual(
        validateEnglishFallbacks(prose, translated, "french.js", reviewed),
        []
    );
    assert.equal(
        validateEnglishFallbacks(prose, translated, "polish.js", reviewed)
            .length,
        1,
        "Cognate exceptions apply only to reviewed locales"
    );
    assert.deepEqual(
        validateIdenticalAllowlist(prose, { french: translated }, reviewed),
        []
    );
    for (const message of [
        prose.message,
        " Open  the player settings. ",
        "OPEN THE PLAYER SETTINGS.",
    ]) {
        assert.equal(
            validateEnglishFallbacks(
                prose,
                { ...translated, message },
                "french.js",
                reviewed
            ).length,
            1,
            "English prose cannot pass through whitespace changes"
        );
    }
    assert.equal(
        validateEnglishFallbacks(
            { text: "Open settings.<br>Try again." },
            { text: "Open settings.<BR/>Try again." },
            "french.js",
            []
        ).length,
        1,
        "HTML serialization differences cannot hide untranslated prose"
    );
    assert.deepEqual(
        validateEnglishFallbacks(prose, prose, "english.js", []),
        []
    );
    assert.equal(
        validateEnglishFallbacks(
            { ...prose, brand: "Plex settings" },
            { ...translated, brand: "Plex settings" },
            "french.js",
            reviewed
        ).length,
        1,
        "A brand exception cannot conceal a new English phrase"
    );
    for (const exception of [
        { ...reviewed[1], reason: "" },
        { ...reviewed[1], locales: ["unknown"] },
        { ...reviewed[1], locales: ["english"] },
        { ...reviewed[1], locales: ["*", "french"] },
        { ...reviewed[1], value: "Old spelling" },
        { ...reviewed[1], key: "unknown" },
        { ...reviewed[1], locales: [] },
    ])
        assert(
            validateIdenticalAllowlist(prose, { french: translated }, [
                exception,
            ]).length
        );
    assert(
        validateIdenticalAllowlist(
            prose,
            { french: { ...translated, action: "Interrompre" } },
            [reviewed[1]]
        ).length,
        "Unused exceptions must be removed"
    );
    assert(
        validateIdenticalAllowlist(prose, { french: translated }, [
            reviewed[1],
            reviewed[1],
        ]).length,
        "Duplicate exceptions must fail"
    );
    const { phoneKeys } = require("../scripts/hosted-swop.cjs");
    assert.throws(
        () => phoneKeys("", "say(provider.message);"),
        /literal key/,
        "Phone cannot hide a dynamic vocabulary from catalog coverage"
    );
    assert(!fixtureKeys.keys.has("status"));
    assert(!fixtureKeys.keys.has("button"));
    assert(
        !fixtureKeys.dynamic.some(
            (entry) => entry.file === "src/swop/herenow-phone.ts"
        )
    );

    const alphabets = JSON.parse(
        fs.readFileSync(
            path.join(root, "tests/fixtures/locale-alphabets.json"),
            "utf8"
        )
    );
    assert.equal(Object.keys(languageAssets).length, 88);
    assert.deepEqual(
        Object.keys(languageAssets).sort(),
        Object.keys(alphabets.locales).sort(),
        "Every persisted language identifier retains its complete keyboard alphabet"
    );
    assert.equal(languageAssetPath("_eng"), "/locales/english.js");
    assert.equal(languageAssetPath("_rus"), "/locales/russian.js");
    for (const [code, file] of Object.entries(languageAssets)) {
        assert.equal(languageAssetPath(code), file);
        assert.equal(
            readDictionary(path.join(root, file)).alhabet,
            alphabets.locales[code].alphabet,
            "Saved language preference loads the matching alphabet: " + code
        );
    }
    for (const code of [
        "",
        "unknown",
        "_xyz",
        "constructor",
        "toString",
        "__proto__",
        "../../x",
    ])
        assert.equal(languageAssetPath(code), "/locales/english.js");

    const scripts = [];
    const loader = { exports: {} };
    const browser = {
        __cv: "test-version",
        __host: "https://player.example/base",
    };
    vm.runInNewContext(
        ts.transpileModule(
            fs.readFileSync(
                path.join(root, "src/localization/loader.ts"),
                "utf8"
            ),
            {
                compilerOptions: {
                    module: ts.ModuleKind.CommonJS,
                    target: ts.ScriptTarget.ES5,
                },
            }
        ).outputText,
        {
            document: {
                body: { appendChild: (script) => scripts.push(script) },
                createElement: () => ({ crossOrigin: "" }),
            },
            exports: loader.exports,
            require: (specifier) => {
                if (specifier === "./assets") return { languageAssetPath };
                if (specifier === "./index") return { setTranslations() {} };
                throw new Error(
                    "Unexpected language loader dependency: " + specifier
                );
            },
            window: browser,
        },
        { timeout: 1000 }
    );
    for (const code of [...Object.keys(languageAssets), "unknown"])
        loader.exports.loadLanguage(code, () => {});
    assert.deepEqual(
        scripts.map((script) => script.src),
        [...Object.values(languageAssets), "/locales/english.js"].map(
            (file) => "https://player.example/base" + file + "?test-version"
        ),
        "Module loader uses renamed assets without changing host or version handling"
    );
    delete browser.__host;
    delete browser.__cv;
    loader.exports.loadLanguage("_rus", () => {});
    assert.equal(scripts.at(-1).src, "/locales/russian.js?local");

    const runtime = { exports: {}, window: {} };
    const localModules = {};
    function localizationModule(name) {
        if (!localModules[name]) {
            const module = {
                exports: {},
                require: localizationModule,
                window: runtime.window,
            };
            localModules[name] = module.exports;
            vm.runInNewContext(
                ts.transpileModule(
                    fs.readFileSync(
                        path.join(root, "src/localization", name + ".ts"),
                        "utf8"
                    ),
                    {
                        compilerOptions: {
                            module: ts.ModuleKind.CommonJS,
                            target: ts.ScriptTarget.ES5,
                        },
                    }
                ).outputText,
                module
            );
        }
        return localModules[name];
    }
    runtime.require = localizationModule;
    const localeAssets = localizationModule("./assets");
    vm.runInNewContext(
        ts.transpileModule(
            fs.readFileSync(
                path.join(root, "src/localization/index.ts"),
                "utf8"
            ),
            {
                compilerOptions: {
                    module: ts.ModuleKind.CommonJS,
                    target: ts.ScriptTarget.ES5,
                },
            }
        ).outputText,
        runtime
    );
    const translate = runtime.exports.translate;
    runtime.window.keyStrings = readDictionary(
        path.join(root, "locales/russian.js")
    );
    assert.equal(
        translate(
            "Reminder: %1 — %2 in %3 min",
            "Канал $& %2",
            "Новости $$ %3",
            5
        ),
        "Напоминание: Канал $& %2 — Новости $$ %3 через 5 мин",
        "EPG metadata must remain literal when substituted into translated reminders"
    );
    assert.equal(translate("%1 / %10 / %2", "one", "two"), "one / %10 / two");
    assert.equal(
        translate("%2 %1 %2", "first", "second"),
        "second first second"
    );
    for (const key of ["constructor", "toString", "__proto__"])
        assert.equal(
            translate(key, "argument"),
            key,
            "Unknown keys cannot resolve prototype members"
        );

    // A failed language download must leave the current Russian UI and saved
    // preference intact, so a transient network error cannot force English.
    const selectionSource = ts.createSourceFile(
        "src/index.ts",
        fs.readFileSync(path.join(root, "src/index.ts"), "utf8"),
        ts.ScriptTarget.Latest,
        true
    );
    const loadInterface = selectionSource.statements.find(
        (node) =>
            ts.isFunctionDeclaration(node) &&
            node.name.text === "loadInterfaceLanguage"
    );
    const selectLang = selectionSource.statements.find(
        (node) =>
            ts.isFunctionDeclaration(node) && node.name.text === "selectLang"
    );
    let savedLanguage = "_rus",
        savedMode = "";
    let languageRequest;
    let resumed = 0;
    const messages = [];
    const timers = new Map();
    let timerId = 0;
    const selection = {
        _: translate,
        applyLanguageMetadata() {},
        checkTauriUpdatesAfterLanguage() {},
        clearTimeout: (id) => timers.delete(id),
        document: { getElementById: () => null },
        duneAddSettings() {},
        getScriptDOM: (url, success, error) => {
            languageRequest = { error, success, url };
        },
        hostUrl: "",
        infoBox: (message) => messages.push(message),
        keys: { ENTER: 13, EXIT: 27, RETURN: 8 },
        languageAssetPath,
        languageLocaleTag: localeAssets.languageLocaleTag,
        languageNames: localeAssets.languageNames,
        metadataText: (value) => String(value).replace(/</g, "&lt;"),
        normalizeSearchText: runtime.exports.normalizeSearchText,
        PLAYER_VERSION: "test",
        renderButtonHint: () => "",
        setTimeout: (callback, delay) => {
            assert.equal(delay, 10000);
            timers.set(++timerId, callback);
            return timerId;
        },
        showPage() {},
        stbGetItem: (key) =>
            key === "ottplaylangmode" ? savedMode : savedLanguage,
        stbSetItem: (key, value) => {
            if (key === "ottplaylangmode") savedMode = value;
            else savedLanguage = value;
        },
        strRETURN: "BACK",
        window: {
            keyStrings: runtime.window.keyStrings,
            optionsList: () => {
                resumed++;
            },
        },
    };
    vm.createContext(selection);
    vm.runInContext(
        ts.transpileModule(
            loadInterface.getText(selectionSource) +
                "\n" +
                selectLang.getText(selectionSource),
            {}
        ).outputText,
        selection
    );
    selection.selectLang();
    selection.selIndex = 2;
    selection.listKeyHandlerFn(13);
    assert.match(languageRequest.url, /locales\/english\.js/);
    assert.equal(savedLanguage, "_rus");
    assert.equal(selection.window.keyStrings, runtime.window.keyStrings);
    languageRequest.error();
    assert.deepEqual(messages, [translate("Failed to load!")]);
    assert.equal(savedLanguage, "_rus");
    assert.equal(resumed, 0);
    selection.listKeyHandlerFn(13);
    selection.window.keyStrings = { lang: "fixture" };
    languageRequest.success();
    assert.equal(savedLanguage, "_eng");
    assert.equal(resumed, 1);
    savedLanguage = "_rus";
    languageRequest = null;
    selection.selectLang(true);
    selection.listKeyHandlerFn(13);
    assert.match(languageRequest.url, /locales\/russian\.js/);
    assert.equal(
        resumed,
        1,
        "Retrying the saved language waits for its dictionary"
    );
    selection.window.keyStrings = { lang: "fixture" };
    languageRequest.success();
    assert.equal(resumed, 2);

    // A cancelled or stalled script can finish late, even while a newer
    // request is pending. Only the current request may persist or resume.
    savedLanguage = "_rus";
    selection.window.keyStrings = runtime.window.keyStrings;
    selection.selectLang();
    selection.selIndex = 2;
    selection.listKeyHandlerFn(13);
    const cancelledLanguage = languageRequest;
    selection.selIndex = 4;
    selection.listKeyHandlerFn(13);
    assert.equal(
        languageRequest,
        cancelledLanguage,
        "Only one active choice loads"
    );
    selection.listKeyHandlerFn(8);
    const afterCancel = resumed;
    assert.equal(timers.size, 0, "Back releases its timeout");
    selection.selectLang();
    selection.selIndex = 4;
    selection.listKeyHandlerFn(13);
    const stalledLanguage = languageRequest;
    const owner = selection.window.__ottLanguagePending;
    assert.notEqual(
        stalledLanguage,
        cancelledLanguage,
        "Back allows immediate retry"
    );
    selection.window.keyStrings = { stale: "cancelled" };
    cancelledLanguage.success();
    assert.equal(selection.window.keyStrings, runtime.window.keyStrings);
    assert.equal(selection.window.__ottLanguagePending, owner);
    assert.equal(savedLanguage, "_rus");
    assert.equal(resumed, afterCancel);
    const timeout = [...timers.values()][0];
    timeout();
    assert.equal(selection.window.__ottLanguagePending, null);
    assert.equal(timers.size, 0);
    assert.equal(savedLanguage, "_rus");
    assert.equal(messages.at(-1), translate("Failed to load!"));
    selection.selIndex = 2;
    selection.listKeyHandlerFn(13);
    const newestLanguage = languageRequest;
    assert.notEqual(
        newestLanguage,
        stalledLanguage,
        "A timed-out choice is retryable"
    );
    selection.window.keyStrings = { stale: "timed out" };
    stalledLanguage.success();
    assert.equal(selection.window.keyStrings, runtime.window.keyStrings);
    assert(
        selection.window.__ottLanguagePending,
        "Late load keeps newer owner"
    );
    const englishDictionary = {
        "Failed to load!": "Failed to load!",
        lang: "English",
    };
    selection.window.keyStrings = englishDictionary;
    newestLanguage.success();
    assert.equal(savedLanguage, "_eng");
    assert.equal(resumed, afterCancel + 1);
    assert.equal(timers.size, 0);
    selection.window.keyStrings = { stale: "after commit" };
    cancelledLanguage.success();
    stalledLanguage.error();
    assert.equal(selection.window.keyStrings, englishDictionary);
    assert.equal(savedLanguage, "_eng");
    assert.equal(resumed, afterCancel + 1);

    const startupFunction = selectionSource.statements.find(
        (node) =>
            ts.isFunctionDeclaration(node) &&
            node.name.text === "loadStartupLanguage"
    );
    function startupLanguage(options = {}) {
        let saved = options.saved || "",
            mode = options.mode || "";
        const deferred = [],
            deadlines = [];
        const writes = [],
            requests = [],
            picker = [];
        let providers = 0,
            updates = 0,
            hidden = 0,
            generation = 0,
            settingsLists = 0;
        const dictionary = { lang: "fixture" };
        const window = {
            __ottBootDictionary: dictionary,
            __ottStandby: {
                current: (expected) => expected === generation,
                generation: () => generation,
            },
            clearBootHide: () => hidden++,
            keyStrings: dictionary,
            optionsList: () => settingsLists++,
        };
        if (options.boot)
            window.__ottBootLanguage = {
                ...options.boot,
                dictionary: options.changedDictionary ? {} : dictionary,
            };
        const launch = { style: {} };
        const context = {
            applyLanguageMetadata(code) {
                window.__ottInterfaceLanguage = code;
            },
            checkTauriUpdatesAfterLanguage: () => updates++,
            clearTimeout: () => {},
            console: { log() {} },
            document: { getElementById: () => launch },
            getScriptDOM: (url, success, error) =>
                requests.push({ error, success, url }),
            hostUrl: "https://player.example",
            languageAssetPath,
            languageNames: Object.fromEntries(
                Object.keys(languageAssets).map((code) => [code, code])
            ),
            loadProv: () => providers++,
            PLAYER_VERSION: "test",
            selectLang: (force, startup) => picker.push([force, startup]),
            setTimeout: (callback, delay) => {
                if (delay === 0) deferred.push(callback);
                else {
                    assert.equal(delay, 10000);
                    deadlines.push(callback);
                }
            },
            stbGetItem: (key) => (key === "ottplaylangmode" ? mode : saved),
            stbSetItem: (key, value) => {
                writes.push({ key, value });
                if (key === "ottplaylangmode") mode = value;
                else saved = value;
            },
            window,
        };
        if (options.existingProvider) context.duneAddSettings = () => {};
        vm.runInNewContext(
            ts.transpileModule(
                loadInterface.getText(selectionSource) +
                    "\n" +
                    startupFunction.getText(selectionSource),
                {}
            ).outputText,
            context
        );
        const proceeded = context.loadStartupLanguage();
        return {
            deadlines,
            deferred,
            launch,
            load: (code, done) => context.loadInterfaceLanguage(code, done),
            picker,
            proceeded,
            requests,
            restart: () => context.loadStartupLanguage(),
            settingsLists: () => settingsLists,
            snapshot: () => ({ hidden, providers, saved, updates }),
            supersede: () => generation++,
            window,
            writes,
        };
    }
    const auto = startupLanguage({ boot: { automatic: true, code: "_rus" } });
    assert.equal(auto.proceeded, true);
    assert.deepEqual(auto.writes, [
        { key: "ottplaylang", value: "_rus" },
        { key: "ottplaylangmode", value: "system" },
    ]);
    assert.deepEqual(auto.requests, [], "Reuse the verified boot dictionary");
    assert.equal(auto.snapshot().providers, 0, "Native shims initialize first");
    assert.equal(auto.deferred.length, 1);
    auto.deferred[0]();
    assert.deepEqual(auto.snapshot(), {
        hidden: 0,
        providers: 1,
        saved: "_rus",
        updates: 1,
    });
    assert.equal(
        auto.window.__ottBootLanguage,
        null,
        "Consume the boot result"
    );
    for (const options of [
        {}, // Unsupported language, failed download or timeout: no boot result.
        { existingProvider: true }, // Same-page wake must retain startup semantics.
        { boot: { automatic: false, code: "_rus" } }, // Saved preference cleared.
        { boot: { automatic: true, code: "constructor" } },
        { boot: { automatic: true, code: "_rus" }, changedDictionary: true },
    ]) {
        const result = startupLanguage(options);
        assert.equal(result.proceeded, false);
        assert.deepEqual(result.writes, []);
        assert.deepEqual(result.requests, []);
        assert.deepEqual(result.picker, [[undefined, true]]);
        assert.equal(result.launch.style.display, "none");
        assert.equal(result.snapshot().providers, 0);
    }
    const savedBoot = startupLanguage({
        boot: { automatic: false, code: "_rus" },
        saved: "_rus",
    });
    assert.deepEqual(savedBoot.writes, []);
    assert.deepEqual(savedBoot.requests, []);
    assert.equal(savedBoot.snapshot().providers, 0);
    savedBoot.deferred[0]();
    assert.equal(savedBoot.snapshot().providers, 1);
    // Same-page wake must never turn startup into the Settings language action.
    for (const mode of ["manual", "system"]) {
        const replay = startupLanguage({
            boot: { automatic: mode === "system", code: "_eng" },
            existingProvider: true,
            mode,
            saved: "_eng",
        });
        replay.deferred.shift()();
        for (let cycle = 0; cycle < 2; cycle++) {
            replay.supersede();
            assert.equal(replay.restart(), true);
            assert.equal(
                replay.requests.length,
                0,
                "Reuse the verified active dictionary"
            );
            replay.deferred.shift()();
        }
        assert.equal(replay.snapshot().providers, 3);
        assert.equal(replay.settingsLists(), 0);
        assert.deepEqual(replay.picker, []);
    }
    const interruptedPicker = startupLanguage({
        boot: { automatic: false, code: "_eng" },
        saved: "_eng",
    });
    interruptedPicker.deferred.shift()();
    const acceptedDictionary = interruptedPicker.window.keyStrings;
    let pickerCompletions = 0;
    interruptedPicker.load("_fra", () => pickerCompletions++);
    interruptedPicker.supersede();
    interruptedPicker.restart();
    interruptedPicker.deferred.shift()();
    interruptedPicker.window.keyStrings = { lang: "French" };
    interruptedPicker.requests[0].success();
    assert.equal(
        pickerCompletions,
        0,
        "Old picker cannot commit after cached startup reuse"
    );
    assert.equal(interruptedPicker.window.keyStrings, acceptedDictionary);
    assert.equal(interruptedPicker.window.__ottInterfaceLanguage, "_eng");
    assert.equal(interruptedPicker.snapshot().saved, "_eng");
    assert.equal(interruptedPicker.snapshot().providers, 2);
    const staleReady = startupLanguage({
        boot: { automatic: false, code: "_eng" },
        saved: "_eng",
    });
    staleReady.supersede();
    staleReady.restart();
    staleReady.deferred.shift()();
    assert.equal(
        staleReady.snapshot().providers,
        0,
        "Previous bootstrap ready is fenced"
    );
    staleReady.deferred.shift()();
    assert.equal(staleReady.snapshot().providers, 1);
    for (const success of [false, true]) {
        const staleDownload = startupLanguage({ saved: "_eng" });
        staleDownload.supersede();
        if (success) staleDownload.window.keyStrings = { lang: "English" };
        staleDownload.requests[0][success ? "success" : "error"]();
        assert.equal(staleDownload.snapshot().providers, 0);
        assert.deepEqual(
            staleDownload.picker,
            [],
            "Stale locale failure must not reopen the picker"
        );
    }
    const changedPreference = startupLanguage({
        boot: { automatic: true, code: "_rus" },
        saved: "_fra",
    });
    assert.deepEqual(changedPreference.writes, []);
    assert.equal(changedPreference.snapshot().providers, 0);
    assert.match(changedPreference.requests[0].url, /\/locales\/french\.js\?/);
    changedPreference.window.keyStrings = { lang: "French" };
    changedPreference.requests[0].success();
    assert.equal(changedPreference.snapshot().providers, 1);
    assert.equal(changedPreference.snapshot().saved, "_fra");
    for (const existingProvider of [false, true]) {
        const failedSaved = startupLanguage({
            existingProvider,
            saved: "_rus",
        });
        failedSaved.requests[0].error();
        assert.deepEqual(failedSaved.picker, [[true, true]]);
        assert.deepEqual(failedSaved.writes, []);
        assert.equal(failedSaved.snapshot().saved, "_rus");
    }

    // A persisted system mode follows a changed OS preference, while legacy
    // saved choices (no mode record) remain explicit.
    const following = startupLanguage({
        boot: { automatic: true, code: "_fra" },
        mode: "system",
        saved: "_rus",
    });
    assert.equal(following.snapshot().saved, "_fra");
    assert.deepEqual(following.requests, []);
    following.deferred[0]();
    assert.equal(following.snapshot().providers, 1);
    const unsupportedSystem = startupLanguage({
        mode: "system",
        saved: "_rus",
    });
    assert.deepEqual(unsupportedSystem.picker, [[undefined, true]]);
    assert.equal(
        unsupportedSystem.snapshot().saved,
        "_rus",
        "Keep the last successful language without treating it as a system match"
    );
    // After an unsupported system preference or failed early download, the
    // last persisted language is not an active dictionary. Both manual recovery
    // and retrying System language must load it before persisting or resuming.
    for (const choice of ["manual", "system"]) {
        const stored = { ottplaylang: "_rus", ottplaylangmode: "system" };
        const requests = [];
        const emptyDictionary = {};
        let providers = 0,
            settingsLists = 0;
        const host = {
            __ottDetectLanguage: () => (choice === "system" ? "_rus" : ""),
            keyStrings: emptyDictionary,
            optionsList: () => settingsLists++,
        };
        const recovery = {
            _: (key) => host.keyStrings[key] || key,
            applyLanguageMetadata: (code) => {
                host.__ottInterfaceLanguage = code;
            },
            checkTauriUpdatesAfterLanguage() {},
            clearTimeout() {},
            console: { log() {} },
            document: { getElementById: () => null },
            duneAddSettings() {},
            getScriptDOM: (url, success, error) =>
                requests.push({ error, success, url }),
            hostUrl: "",
            infoBox() {},
            keys: { ENTER: 13, EXIT: 27, RED: 403, RETURN: 8 },
            languageAssetPath,
            languageLocaleTag: localeAssets.languageLocaleTag,
            languageNames: localeAssets.languageNames,
            loadProv: () => providers++,
            metadataText: String,
            normalizeSearchText: (value) => value.toLowerCase(),
            PLAYER_VERSION: "test",
            renderButtonHint: () => "",
            setTimeout: () => 1,
            showPage() {},
            stbGetItem: (key) => stored[key],
            stbSetItem: (key, value) => {
                stored[key] = value;
            },
            strRETURN: "BACK",
            window: host,
        };
        vm.createContext(recovery);
        vm.runInContext(
            ts.transpileModule(
                [loadInterface, selectLang, startupFunction]
                    .map((node) => node.getText(selectionSource))
                    .join("\n"),
                {}
            ).outputText,
            recovery
        );
        assert.equal(recovery.loadStartupLanguage(), false);
        recovery.selIndex =
            choice === "system"
                ? 0
                : recovery.listDataArray.indexOf(
                      localeAssets.languageNames._rus
                  );
        recovery.listKeyHandlerFn(13);
        assert.equal(
            requests.length,
            1,
            choice + " recovery needs a dictionary"
        );
        assert.match(requests[0].url, /\/locales\/russian\.js\?/);
        assert.equal(providers, 0);
        assert.equal(stored.ottplaylangmode, "system");
        requests[0].error();
        assert.equal(providers, 0);
        assert.equal(host.keyStrings, emptyDictionary);
        assert.equal(host.__ottInterfaceLanguage, undefined);
        assert.equal(stored.ottplaylangmode, "system");
        recovery.listKeyHandlerFn(13);
        assert.equal(requests.length, 2);
        host.keyStrings = {
            "Choose language": "Выберите язык",
            lang: "Russian",
        };
        requests[1].success();
        assert.equal(providers, 1);
        assert.equal(host.__ottInterfaceLanguage, "_rus");
        assert.equal(stored.ottplaylang, "_rus");
        assert.equal(stored.ottplaylangmode, choice);
        assert.equal(recovery._("Choose language"), "Выберите язык");
        recovery.selectLang();
        recovery.listKeyHandlerFn(13);
        assert.equal(
            requests.length,
            2,
            "A successfully active language is reused"
        );
        assert.equal(
            providers,
            1,
            "Manual language selection returns to Settings"
        );
        assert.equal(settingsLists, 1);
    }
    const stalledSaved = startupLanguage({ saved: "_rus" });
    assert.equal(stalledSaved.deadlines.length, 1);
    stalledSaved.deadlines[0]();
    assert.deepEqual(stalledSaved.picker, [[true, true]]);
    const retainedDictionary = stalledSaved.window.keyStrings;
    stalledSaved.window.keyStrings = { lang: "late" };
    stalledSaved.requests[0].success();
    assert.equal(stalledSaved.window.keyStrings, retainedDictionary);
    assert.equal(stalledSaved.snapshot().providers, 0);

    // Native transports must be installed before either automatic startup or a
    // first-run manual choice. Exercise the actual onStbReady + picker functions.
    const stbReady = selectionSource.statements.find(
        (node) =>
            ts.isFunctionDeclaration(node) && node.name.text === "onStbReady"
    );
    for (const mode of ["auto", "unsupported", "preload-failed"]) {
        const events = [],
            queue = [],
            requests = [],
            startup = [];
        let saved = "",
            preference = "";
        const noop = () => {};
        const dictionary = { lang: "Russian" };
        const host = {
            __ottCommandServer: { configure: noop },
            __ottControlDiscovery: { start: noop },
            __ottKiosk: { init: noop },
            __ottLocalHttpRemote: { init: noop },
            __ottRemoteDiagnostics: {},
            __ottStandby: {
                blocked: () => false,
                current: (generation) => generation === 0,
                generation: () => 0,
                ready: (callback) => startup.push(callback),
            },
            Capacitor: {},
            clearBootHide: noop,
            keyStrings: dictionary,
        };
        if (mode === "auto")
            host.__ottBootLanguage = {
                automatic: true,
                code: "_rus",
                dictionary,
            };
        const context = {
            _: (value) => value,
            applyLanguageMetadata: noop,
            checkTauriUpdatesAfterLanguage: noop,
            clearTimeout: noop,
            console: { log: noop },
            document: { getElementById: () => null },
            getScriptDOM: (url, success, error) =>
                requests.push({ error, success, url }),
            hostUrl: "",
            infoBox: noop,
            keys: { ENTER: 13, EXIT: 27, RED: 403, RETURN: 8 },
            languageAssetPath,
            languageLocaleTag: localeAssets.languageLocaleTag,
            languageNames: localeAssets.languageNames,
            loadProv: () => events.push("provider"),
            metadataText: String,
            normalizeSearchText: selection.normalizeSearchText,
            PLAYER_VERSION: "test",
            popupActions: [],
            popupArray: [],
            popupDetail: [],
            renderButtonHint: () => "",
            savedPopup: { popupActions: [], popupArray: [], popupDetail: [] },
            setTimeout: (callback, delay) => {
                queue.push({ callback, delay });
                return queue.length;
            },
            settings: {},
            setupCapacitorCompanionShim: () => events.push("capacitorHTTP"),
            setupStalkerPortalShim: () => events.push("stalkerHTTP"),
            showPage: () => events.push("picker"),
            startupError: (_el, _phase, error) => {
                throw error;
            },
            stbGetItem: (key) =>
                key === "ottplaylangmode" ? preference : saved,
            stbSetItem: (key, value) => {
                if (key === "ottplaylangmode") preference = value;
                else saved = value;
            },
            strRETURN: "BACK",
            TMDb: { prepare: () => events.push("tmdb") },
            version: "test",
            window: host,
        };
        for (const name of [
            "loadSettings",
            "installSettingsFacade",
            "installLocalMedia",
            "initUIReferences",
            "setTimezone",
            "setFontSize",
            "setListPos",
            "setColor",
            "setEditor",
            "setPipPosBuf",
            "setSleepTimeout",
            "closeList",
        ])
            context[name] = noop;
        vm.createContext(context);
        vm.runInContext(
            ts.transpileModule(
                [loadInterface, selectLang, startupFunction, stbReady]
                    .map((node) => node.getText(selectionSource))
                    .join("\n"),
                {}
            ).outputText,
            context
        );
        context.onStbReady();
        assert.equal(startup.length, 1, "Startup waits for the native probe");
        assert.deepEqual(events, ["capacitorHTTP", "stalkerHTTP"]);
        assert.equal(requests.length, 0, "No language fetch before readiness");
        startup[0]();
        if (mode === "auto")
            queue
                .filter((timer) => timer.delay === 0)
                .forEach((timer) => timer.callback());
        else {
            context.selIndex = 2;
            context.listKeyHandlerFn(13);
            host.keyStrings = { lang: "English" };
            requests[0].success();
        }
        assert(
            events.indexOf("capacitorHTTP") >= 0 &&
                events.indexOf("capacitorHTTP") < events.indexOf("provider"),
            mode
        );
        assert(
            events.indexOf("stalkerHTTP") >= 0 &&
                events.indexOf("stalkerHTTP") < events.indexOf("provider"),
            mode
        );
        assert.equal(events.filter((event) => event === "provider").length, 1);
    }

    // Search uses the same remote/native editor, filters without saving a
    // language, and escapes the user's query when displaying the search row.
    savedMode = "";
    selection.window.showEditKey = () => {};
    selection.selectLang();
    selection.selIndex = 1;
    selection.listKeyHandlerFn(13);
    assert.equal(selection.window.editCaption, translate("Search languages"));
    selection.window.editvar = "русс";
    selection.window.setEdit();
    assert.deepEqual(Array.from(selection.listDataArray).slice(2), [
        "Russian - Русский",
    ]);
    assert.equal(savedLanguage, "_eng");
    selection.selIndex = 1;
    selection.listKeyHandlerFn(13);
    selection.window.editvar = "<missing>";
    selection.window.setEdit();
    assert.equal(selection.listDataArray[2], translate("Not found"));
    assert(
        !selection
            .getListItemFn(selection.listDataArray[1])
            .includes("<missing>")
    );
    selection.window.__ottDetectLanguage = () => "_rus";
    selection.selectLang();
    selection.selIndex = 0;
    selection.listKeyHandlerFn(13);
    selection.window.keyStrings = { lang: "Russian" };
    languageRequest.success();
    assert.equal(savedMode, "system");
    assert.equal(savedLanguage, "_rus");
    selection.selectLang();
    selection.selIndex = 2;
    selection.listKeyHandlerFn(13);
    selection.window.keyStrings = { lang: "English" };
    languageRequest.success();
    assert.equal(savedMode, "manual");
    assert.equal(savedLanguage, "_eng");

    // A rejected system-language choice and stale editor callbacks must not
    // change the persisted policy or a later screen's list.
    selection.window.__ottDetectLanguage = () => "";
    selection.selectLang();
    selection.selIndex = 0;
    selection.listKeyHandlerFn(13);
    assert.equal(savedMode, "manual");
    assert.equal(savedLanguage, "_eng");
    selection.selIndex = 1;
    selection.listKeyHandlerFn(13);
    const closedSearch = selection.window.setEdit;
    selection.listKeyHandlerFn(8);
    selection.listDataArray = ["Later screen"];
    selection.window.editvar = "rus";
    closedSearch();
    assert.deepEqual(Array.from(selection.listDataArray), ["Later screen"]);
    selection.selectLang();
    selection.selIndex = 1;
    selection.listKeyHandlerFn(13);
    const replacedSearch = selection.window.setEdit;
    selection.selectLang();
    const laterList = Array.from(selection.listDataArray);
    replacedSearch();
    assert.deepEqual(Array.from(selection.listDataArray), laterList);

    const startupLocales = JSON.parse(
        fs.readFileSync(
            path.join(root, "tests/fixtures/startup-locales.json"),
            "utf8"
        )
    );
    const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
    const bootMatcher = html.slice(
        html.indexOf("function detectBootLanguage()"),
        html.indexOf("window.__ottDetectLanguage =")
    );
    assert.deepEqual(
        Object.keys(localeAssets.languageMetadata).sort(),
        Object.keys(languageAssets).sort()
    );
    const preferences = Object.keys(startupLocales.languages).map((tag) => [
        tag,
    ]);
    for (const tag of Object.keys(startupLocales.regionalScripts))
        preferences.push([tag], [tag, "ru-RU"]);
    preferences.push(
        ["zh-Hant", "en"],
        ["sr-Latn", "fr"],
        ["pa-Arab"],
        ["iw"],
        ["no"],
        ["nb"],
        ["kmr"],
        ["zh-cmn-Hant"],
        [null, 42, "RU_ru"],
        ["ru-RU-u-nu-latn"]
    );
    for (const tags of preferences) {
        const context = {
            navigator: {},
            window: { __ottPreferredLanguages: tags },
        };
        vm.runInNewContext(bootMatcher, context);
        assert.equal(
            localeAssets.resolveLanguagePreferences(tags),
            context.detectBootLanguage(),
            JSON.stringify(tags)
        );
    }
    assert.equal(localeAssets.languageDirection("_ara"), "rtl");
    assert.equal(localeAssets.languageDirection("_kur"), "ltr");
    assert.equal(localeAssets.languageLocaleTag("constructor"), "en");
    assert.equal(localeAssets.languageLocaleTag("_nor"), "nb");

    const tmdbVariable = selectionSource.statements.find(
        (node) =>
            ts.isVariableStatement(node) &&
            node.declarationList.declarations.some(
                (decl) => decl.name.getText(selectionSource) === "TMDb"
            )
    );
    const tmdbRequests = [],
        tmdbMessages = [];
    const tmdbDom = {
        hide: () => tmdbDom,
        html: (value) => {
            tmdbMessages.push(value);
            return tmdbDom;
        },
        show: () => tmdbDom,
    };
    const jq = () => tmdbDom;
    jq.ajax = (request) => tmdbRequests.push(request);
    const tmdbContext = {
        console: { log() {} },
        hasTmdbService: () => true,
        languageLocaleTag: localeAssets.languageLocaleTag,
        metadataText: String,
        stbGetItem: () => "_eng",
        window: {
            _: (value) =>
                value === "Failed to load!" ? "Не удалось загрузить!" : value,
            $: jq,
        },
    };
    vm.runInNewContext(
        ts.transpileModule(tmdbVariable.getText(selectionSource), {})
            .outputText,
        tmdbContext
    );
    for (const code of [
        ...Object.keys(localeAssets.languageLocales),
        "unknown",
    ]) {
        tmdbContext.window.__ottInterfaceLanguage = code;
        tmdbContext.TMDb.get("movie", 42);
        tmdbContext.TMDb.search("Same title");
        assert.equal(
            tmdbRequests.at(-2).data.language,
            localeAssets.languageLocaleTag(code)
        );
        assert.equal(
            tmdbRequests.at(-1).data.language,
            localeAssets.languageLocaleTag(code)
        );
    }
    tmdbRequests.at(-2).error({ status: 503 });
    tmdbRequests.at(-1).error({ status: 503 });
    assert(
        tmdbMessages
            .slice(-2)
            .every((message) => message.includes("Не удалось загрузить!"))
    );

    // Late responses in the previous UI language cannot repaint a dialog,
    // populate a cache, or start another search after the language changes.
    const oldGet = tmdbRequests.at(-2),
        oldSearch = tmdbRequests.at(-1);
    const priorMessageCount = tmdbMessages.length;
    const priorRequestCount = tmdbRequests.length;
    tmdbContext.window.__ottInterfaceLanguage = "_rus";
    oldGet.success({ title: "Stale English title" });
    oldGet.error({ status: 503 });
    oldSearch.success({
        results: [
            { id: 42, media_type: "movie", title: "Stale English title" },
        ],
    });
    oldSearch.error({ status: 503 });
    assert.equal(tmdbMessages.length, priorMessageCount);
    assert.equal(tmdbRequests.length, priorRequestCount);
    assert.equal(tmdbContext.TMDb.data, null);
    assert.deepEqual(Array.from(tmdbContext.TMDb.results), []);

    const reference = readDictionary(
        path.join(root, languageAssetPath("_eng"))
    );
    for (const key of [
        "Number of rows in lists",
        "Next keyboard page",
        "Call PiP",
        "PiP exchange",
        "Player and device info",
        "Filter",
        "Folders",
        "Sign in with Plex",
        "Save and open library",
        "VPortal profiles",
        "Not configured",
        "Could not save provider settings.",
        "Remote text entry",
        "Find command server",
        "Remote screenshots",
        "Select screenshot source in browser",
        "Screenshots are available while remote control is connected.",
        "Screen sharing could not start.",
        "Cancel pairing",
        "Enter the command server IP or address.",
        "OttPlay FOSS %1 is available. Download and install now?",
        "EPG diagnostics could not load. Open it again to retry.",
        "ERROR: Category #%1 does not exist!<br>Please select another category.",
    ])
        assert(Object.hasOwn(reference, key), `Audited UI key missing: ${key}`);
    if (process.argv.includes("--runtime-only")) {
        console.log(
            "PASS localization runtime: loader ownership/deadlines, system/manual preferences, native initialization, remote language search and all88 metadata parity"
        );
    } else {
        const result = audit({
            englishOnly: process.argv.includes("--english-only"),
        });
        assert.deepEqual(result.errors, [], result.errors.join("\n"));
        assert.equal(result.localeCount, 88);
        assert.equal(result.keyCount, 904);
        console.log(
            `PASS localization: ${result.keyCount} canonical keys, ${result.sourceKeyCount} source-derived keys, ${result.localeCount} locale assets; missing/duplicate keys, placeholders, HTML, whitespace and selector coverage`
        );
    }
} finally {
    fs.rmSync(fixture, { force: true, recursive: true });
}
