const {
    attachSourceAliases,
    sourceNames,
} = require("./helpers/english-source-fixture.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { JSDOM } = require("jsdom");
const { localizationRuntime } = require("./helpers/localization-runtime.cjs");

const root = path.resolve(__dirname, "..");
const bundle = process.argv.includes("--bundle");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
function functions(file, names) {
    names = sourceNames(file, names);
    const ast = ts.createSourceFile(
        file,
        read(file),
        ts.ScriptTarget.Latest,
        true
    );
    const selected = new Map();
    function include(name) {
        if (selected.has(name)) return;
        const declarations = ast.statements.flatMap((node) => {
            if (ts.isFunctionDeclaration(node) && node.name?.text === name)
                return [node];
            if (ts.isVariableStatement(node))
                return [...node.declarationList.declarations].filter(
                    (item) => item.name.getText(ast) === name
                );
            return [];
        });
        assert.equal(
            declarations.length,
            1,
            `${file}: actual ${name} declaration`
        );
        const declaration = declarations[0];
        selected.set(
            name,
            ts.isVariableDeclaration(declaration)
                ? "var " + declaration.getText(ast) + ";"
                : declaration.getText(ast)
        );
        function visit(node) {
            if (ts.isIdentifier(node) && /^__ottReadImport\d+$/.test(node.text))
                include(node.text);
            ts.forEachChild(node, visit);
        }
        visit(declaration);
    }
    names.forEach(include);
    const text = [...selected.values()].join("\n");
    return bundle
        ? text
        : ts
              .transpileModule(text, {
                  compilerOptions: {
                      module: ts.ModuleKind.ES2015,
                      target: ts.ScriptTarget.ES5,
                  },
              })
              .outputText.replace(/^export /gm, "");
}
const bundleAliases = bundle
    ? functions("dist/player.js", [
          "legacyPlayerBindings",
          "installEnglishPlayerAliases",
      ])
    : "";
const modules = {
    "src/channels/index.ts": [
        "onChanelsLoaded",
        "restoreContinueWatch",
        "setCurrent",
        "hasParentalLock",
        "ifParentalAccess",
        "ifParentalAccessChId",
        "_enterPinCode",
        "enterPinCode",
        "enterPinAndSetAccess",
        "setParentAccess",
    ],
    "src/core/index.ts": ["stbEventToKeyCode"],
    "src/index.ts": ["_playChannel"],
    "src/key-handler/index.ts": [
        "cancelNativeListInertia",
        "dispatchKey",
        "keyHandler",
    ],
    "src/localization/index.ts": ["translate"],
    "src/ui/index.ts": ["confirmBox", "localizedTextHtml"],
    "src/utils/helpers.ts": [
        "metadataText",
        "metadataHtml",
        "metadataImageUrl",
    ],
};
const code = bundle
    ? functions("dist/player.js", Object.values(modules).flat())
    : Object.entries(modules)
          .map(([file, names]) => functions(file, names))
          .join("\n");

function fixture({
    protectedChannel = true,
    archive = false,
    enabled = true,
    authorized = false,
} = {}) {
    const dom = new JSDOM(
        '<div id="dialogbox">Loading</div><div id="launch">Starting</div><div id="buffering"></div>',
        {
            runScripts: "dangerously",
            url: "https://example.invalid/",
        }
    );
    const w = dom.window;
    require("./helpers/shared-core-runtime.cjs")(dom.getInternalVMContext());
    const played = [],
        stopped = [],
        archives = [],
        seeks = [],
        notices = [],
        errors = [],
        timers = [];
    const stored = new Map([
        ["catsArray", ["Test channels"]],
        ["cats", { "Test channels": [101, 202] }],
        ["parentalArray", protectedChannel ? [202] : []],
    ]);
    if (archive)
        stored.set("continueWatch", {
            catIndex: 1,
            channelId: 202,
            mode: "archive",
            playTime: 25,
            playType: 1700000000,
            updatedAt: Date.now(),
            v: 1,
        });
    w.eval(read("js/jquery-1.11.1.min.js"));
    if (bundle) {
        w.eval(bundleAliases);
        w.installEnglishPlayerAliases(w);
    } else attachSourceAliases(w);
    w.$.expr.filters.visible = (element) => element.style.display !== "none";
    let prompts = 0;
    const html = w.$.fn.html;
    w.$.fn.html = function (value) {
        if (typeof value === "string" && value.includes('id="pin"')) prompts++;
        return html.apply(this, arguments);
    };
    Object.assign(w, {
        _prog100: null,
        btnDiv: () => "",
        catIndex: 1,
        cats: {},
        catsArray: [],
        channels: {
            101: { category: { name: "Test channels" } },
            202: { category: { name: "Test channels" } },
        },
        checkMedia() {},
        cList: [101, 202],
        clearBootHide() {},
        clearTimeout(id) {
            if (timers[id - 1]) timers[id - 1].cancelled = true;
        },
        console: { error: (error) => errors.push(String(error)), log() {} },
        curList: [],
        getChannelUrl: (id) => `https://example.invalid/channel/${id}`,
        isListVisible: true,
        keys: {
            DOWN: 40,
            ENTER: 13,
            LEFT: 37,
            RETURN: 8,
            RIGHT: 39,
            UP: 38,
            ...Object.fromEntries(
                Array.from({ length: 10 }, (_, digit) => [
                    `N${digit}`,
                    48 + digit,
                ])
            ),
        },
        loadEpgTimers() {},
        loadFavoritesLists() {},
        medHistory: [],
        nativeListInertia: null,
        p_pref: "test-provider",
        // Synthetic fixture secret only; no persisted/user settings are accessed.
        parentPIN: "2468",
        playArchive: (time) => {
            archives.push(time);
            w.playType = Math.floor(time);
        },
        playTime: 0,
        playType: 0,
        prevArr: [],
        primaryIndex: 1,
        providerGetItem: (key) =>
            stored.has(key)
                ? typeof stored.get(key) === "string"
                    ? stored.get(key)
                    : JSON.stringify(stored.get(key))
                : null,
        providerGetJson: (key, fallback) =>
            stored.has(key)
                ? JSON.parse(JSON.stringify(stored.get(key)))
                : fallback,
        providerSetItem: (key, value) => stored.set(key, value),
        setPlayer() {},
        setTimeout: (callback, delay) => {
            timers.push({ callback, delay });
            return timers.length;
        },
        settings: { prevCount: 1, psChannels: enabled },
        sFavorites: 0,
        showShift: (text) => {
            if (text !== "Loading. Please wait...") notices.push(text);
        },
        sInfoSwitch: false,
        sStopPlay: true,
        stbPlay: (url) => played.push(url),
        stbSetPosTime: (time) => seeks.push(time),
        stbStop: () => stopped.push(true),
        strENTER: "OK",
        strRETURN: "Back",
        translations: {},
        updateChanelInfo() {},
        useGraphicIcons: false,
    });
    w.eval(localizationRuntime(bundle ? "dist/player.js" : undefined));
    w.eval(code);
    if (!process.argv.includes("--bundle")) attachSourceAliases(w);
    w._ = w.translate;
    assert.equal(
        w.translate("Fixture %1", "ready"),
        "Fixture ready",
        "actual translation dependency is initialized"
    );
    // Resolve real linker readers before production catch/fallback paths can
    // disguise an incomplete extraction as an unexpected live-channel restore.
    for (const name of Object.getOwnPropertyNames(w)) {
        if (/^__ottReadImport\d+$/.test(name)) {
            assert.doesNotThrow(
                () => w[name](),
                `classic import reader ${name} resolves in the fixture`
            );
            assert.notEqual(
                w[name](),
                undefined,
                `classic import reader ${name} has its production dependency`
            );
        }
    }
    w.playChannel = w._playChannel;
    w._doKey = w.dispatchKey;
    const start = () => {
        w.onChanelsLoaded();
        assert.deepEqual(
            errors,
            [],
            "startup must not silently swallow fixture errors"
        );
        assert.equal(
            w.$("#launch").is(":visible"),
            false,
            "launch overlay cleaned up"
        );
        assert.equal(
            w.$("#buffering").is(":visible"),
            false,
            "buffering overlay cleaned up"
        );
    };
    const settlePin = require("./helpers/protected-pin-fixture.cjs")(
        w,
        "2468",
        () => {
            for (const timer of timers) {
                if (timer.delay !== 0 || timer.cancelled) continue;
                timer.cancelled = true;
                timer.callback();
            }
        }
    );
    // Grant only after the fixture has installed its protected credential.
    w.parentAccess = authorized;
    const enter = async (pin) => {
        for (const digit of pin)
            w.document.querySelector(`#k${digit} .btn`).click();
        await settlePin();
    };
    return {
        archives,
        close: () => dom.window.close(),
        enter,
        errors,
        notices,
        played,
        prompts: () => prompts,
        runResume: () => {
            const pending = timers.filter(
                (timer) => timer.delay === 10000 && !timer.cancelled
            );
            assert.equal(pending.length, 1, "Resume has one ten-second timer");
            pending[0].callback();
        },
        runSeek: () => {
            const pending = timers.filter((timer) => timer.delay === 500);
            assert.equal(
                pending.length,
                1,
                "successful archive resume schedules one seek"
            );
            pending[0].callback();
        },
        seeks,
        start,
        stopped,
        w,
    };
}

(async () => {
    for (const answer of ["correct", "wrong", "cancel"]) {
        const f = fixture();
        try {
            f.start();
            assert.equal(
                f.prompts(),
                1,
                `${answer}: protected startup opens one PIN prompt`
            );
            assert.deepEqual(
                f.played,
                [],
                `${answer}: no playback before authorization`
            );
            assert.deepEqual(
                f.stopped,
                [],
                `${answer}: blocked restore does not begin channel transition`
            );
            assert.equal(
                f.w.$("#dialogbox").is(":visible"),
                true,
                `${answer}: PIN remains visible after complete startup cleanup`
            );
            if (answer === "correct") {
                await f.enter("24");
                assert.deepEqual(
                    f.played,
                    [],
                    "partial PIN cannot start playback"
                );
                await f.enter("68");
                assert.deepEqual(
                    f.played,
                    ["https://example.invalid/channel/202"],
                    "correct PIN resumes the selected protected channel once"
                );
                assert.equal(f.w.primaryIndex, 1);
                assert.equal(f.w.catIndex, 1);
                assert.equal(f.w.parentAccess, true);
                assert.equal(
                    f.prompts(),
                    1,
                    "resume does not ask again after authorization"
                );
            } else if (answer === "wrong") {
                await f.enter("1357");
                assert.deepEqual(f.played, [], "wrong PIN never plays");
                assert.equal(f.w.parentAccess, false);
                assert.equal(f.notices.length, 1, "wrong PIN explained");
            } else {
                f.w._doKey(f.w.keys.RETURN);
                assert.deepEqual(f.played, [], "cancel never plays");
                assert.equal(f.w.parentAccess, false);
            }
            assert.equal(
                f.w.$("#dialogbox").is(":visible"),
                false,
                `${answer}: completed or cancelled prompt closes`
            );
            assert.deepEqual(
                f.errors,
                [],
                `${answer}: no caught runtime errors`
            );
        } finally {
            f.close();
        }
    }
    for (const favorites of [0, 1]) {
        const f = fixture({ protectedChannel: false });
        try {
            const opened = [];
            const notices = [];
            f.w.sFavorites = favorites;
            f.w.favoritesArray = [];
            f.w.__ottActiveProviderDriver = {
                capabilities: { mediaPlaylist: true },
                id: "vportal",
            };
            f.w.__ottMissingCatalogSelection = true;
            f.w.channelsList = (category, index) => {
                opened.push({ category, index });
                assert.equal(f.w.$("#launch").is(":visible"), false);
                assert.equal(f.w.$("#buffering").is(":visible"), false);
                assert.equal(
                    f.w.__ottChannels.group(category),
                    "system:all",
                    "missing saved media opens All even when Favorites is first"
                );
                assert.deepEqual(
                    Array.from(f.w.cats[f.w.catsArray[category]]),
                    [101, 202],
                    "recovery exposes the available files"
                );
            };
            f.w.infoBox = (message) => notices.push(message);
            f.start();
            assert.deepEqual(opened, [
                { category: favorites ? 1 : 0, index: 0 },
            ]);
            assert.deepEqual(
                f.played,
                [],
                "missing media never starts a replacement file silently"
            );
            assert.deepEqual(notices, [f.w._("Channel is not available!!!")]);
            assert.equal(f.prompts(), 0);
        } finally {
            f.close();
        }
    }
    for (const options of [
        { protectedChannel: false },
        { enabled: false },
        { authorized: true },
    ]) {
        const f = fixture(options);
        try {
            f.start();
            assert.equal(f.prompts(), 0, "unblocked startup does not prompt");
            assert.deepEqual(
                f.played,
                ["https://example.invalid/channel/202"],
                "normal startup preserves selected live channel"
            );
            assert.equal(
                f.w.$("#dialogbox").is(":visible"),
                false,
                "old loading dialog is removed"
            );
        } finally {
            f.close();
        }
    }
    for (const answer of ["correct", "wrong", "cancel"]) {
        const f = fixture({ archive: true });
        try {
            f.start();
            assert.equal(
                f.prompts(),
                0,
                `${answer}: archive choice is offered before requesting access`
            );
            assert.equal(
                f.w.$("#dialogbox").is(":visible"),
                true,
                `${answer}: archive choice remains visible`
            );
            assert.deepEqual(
                f.archives,
                [],
                `${answer}: no archive before confirmation`
            );
            f.w._doKey(f.w.keys.ENTER);
            assert.equal(
                f.prompts(),
                1,
                `${answer}: protected archive asks for PIN after Yes`
            );
            assert.equal(
                f.w.$("#dialogbox").is(":visible"),
                true,
                `${answer}: archive PIN remains visible`
            );
            assert.deepEqual(
                f.archives,
                [],
                `${answer}: Yes does not bypass parental protection`
            );
            assert.deepEqual(
                f.played,
                [],
                `${answer}: no premature live fallback`
            );
            if (answer === "correct") {
                await f.enter("2468");
                assert.deepEqual(
                    f.archives,
                    [1700000000],
                    "correct PIN resumes the intended protected archive once"
                );
                assert.equal(
                    f.w.curList[f.w.primaryIndex],
                    202,
                    "archive resumes on the bookmarked channel"
                );
                assert.equal(
                    f.prompts(),
                    1,
                    "archive resume does not duplicate PIN dialog"
                );
                f.runSeek();
                assert.deepEqual(
                    f.seeks,
                    [25],
                    "authorized archive restores the saved position"
                );
            } else if (answer === "wrong") {
                await f.enter("1357");
                assert.deepEqual(
                    f.archives,
                    [],
                    "wrong PIN never starts protected archive"
                );
                assert.equal(f.notices.length, 1);
            } else {
                f.w._doKey(f.w.keys.RETURN);
                assert.deepEqual(
                    f.archives,
                    [],
                    "cancel never starts protected archive"
                );
            }
            assert.deepEqual(
                f.played,
                [],
                `${answer}: protected archive path never starts live unexpectedly`
            );
            assert.deepEqual(
                f.errors,
                [],
                `${answer}: archive path has no caught runtime errors`
            );
        } finally {
            f.close();
        }
    }
    for (const change of ["provider", "playlist", "channel"]) {
        const f = fixture({ archive: true });
        try {
            f.start();
            f.w._doKey(f.w.keys.ENTER);
            assert.equal(
                f.prompts(),
                1,
                `${change}: PIN is pending before context changes`
            );
            if (change === "provider") f.w.p_pref = "other-test-provider";
            else if (change === "playlist")
                f.w.cats[f.w.catsArray[1]] = [101, 303];
            else
                f.w.channels[202] = {
                    category: { name: "Replacement channel" },
                };
            await f.enter("2468");
            assert.deepEqual(
                f.archives,
                [],
                `${change}: old PIN callback cannot resume a changed playback context`
            );
            assert.deepEqual(
                f.played,
                [],
                `${change}: stale callback cannot silently start live instead`
            );
        } finally {
            f.close();
        }
    }
    {
        const f = fixture({ archive: true });
        try {
            f.start();
            f.w.p_pref = "other-test-provider";
            f.w._doKey(f.w.keys.ENTER);
            assert.equal(
                f.prompts(),
                0,
                "stale archive confirmation must not open a PIN for another provider"
            );
            assert.deepEqual(f.archives, []);
            assert.deepEqual(f.played, []);
        } finally {
            f.close();
        }
    }
    {
        const f = fixture({ archive: true });
        try {
            f.start();
            f.w._doKey(f.w.keys.ENTER);
            f.w.cats[f.w.catsArray[1]].reverse();
            await f.enter("2468");
            assert.deepEqual(
                f.archives,
                [1700000000],
                "same-list reorder still resumes the authorized bookmark"
            );
            assert.equal(
                f.w.primaryIndex,
                0,
                "resume resolves the moved channel by ID"
            );
            assert.equal(f.w.curList[f.w.primaryIndex], 202);
            f.runSeek();
            assert.deepEqual(f.seeks, [25]);
        } finally {
            f.close();
        }
    }
    {
        const f = fixture({ archive: true });
        try {
            f.start();
            f.w._doKey(f.w.keys.ENTER);
            await f.enter("2468");
            assert.deepEqual(f.archives, [1700000000]);
            f.w.primaryIndex = 0;
            f.runSeek();
            assert.deepEqual(
                f.seeks,
                [],
                "delayed archive seek must not alter a newly selected channel"
            );
        } finally {
            f.close();
        }
    }
    {
        const f = fixture({ archive: true });
        try {
            f.start();
            f.w._doKey(f.w.keys.RETURN);
            assert.equal(
                f.prompts(),
                1,
                "declining archive still requires PIN for protected live channel"
            );
            assert.equal(
                f.w.$("#dialogbox").is(":visible"),
                true,
                "live fallback PIN is visible"
            );
            assert.deepEqual(
                f.played,
                [],
                "archive No cannot bypass live protection"
            );
            assert.deepEqual(f.archives, []);
            await f.enter("2468");
            assert.deepEqual(
                f.played,
                ["https://example.invalid/channel/202"],
                "authorized fallback resumes the bookmarked live channel"
            );
            assert.deepEqual(f.archives, []);
        } finally {
            f.close();
        }
    }
    {
        const f = fixture({ archive: true, protectedChannel: false });
        try {
            f.start();
            assert.equal(
                f.w.$("#dialogbox").is(":visible"),
                true,
                "archive resume confirmation survives startup cleanup"
            );
            assert.match(
                f.w.document.getElementById("dialogbox").textContent,
                /Resume from archive/
            );
            assert.deepEqual(
                f.played,
                [],
                "archive confirmation blocks live fallback until choice"
            );
            assert.deepEqual(
                f.archives,
                [],
                "archive does not start before confirmation"
            );
            f.w._doKey(f.w.keys.ENTER);
            assert.deepEqual(
                f.archives,
                [1700000000],
                "archive confirmation retains its callback"
            );
            f.runSeek();
            assert.deepEqual(
                f.seeks,
                [25],
                "normal unprotected archive retains the saved position"
            );
            assert.deepEqual(f.played, []);
        } finally {
            f.close();
        }
    }
    for (const protectedChannel of [false, true]) {
        const f = fixture({ archive: true, protectedChannel });
        try {
            f.start();
            assert.deepEqual(
                f.archives,
                [],
                "Archive waits while the question is open"
            );
            f.runResume();
            if (protectedChannel) {
                assert.deepEqual(
                    f.archives,
                    [],
                    "Timeout must still require the PIN"
                );
                assert.equal(f.prompts(), 1);
                await f.enter("2468");
            }
            assert.deepEqual(f.archives, [1700000000]);
            f.runSeek();
            assert.deepEqual(
                f.seeks,
                [25],
                "Timeout restores the saved archive position"
            );
            assert.deepEqual(f.played, []);
            assert.equal(f.w.$("#dialogbox").is(":visible"), false);
        } finally {
            f.close();
        }
    }
    // An explicit playback choice owns the screen even while the old prompt is open.
    for (const answer of ["timeout", "yes", "no"]) {
        const f = fixture({ archive: true, protectedChannel: false });
        try {
            f.start();
            f.w.__ottClassicPlayback.command({
                channelId: "78777",
                item: { stream_url: "https://example.invalid/plex-film.mp4" },
                sourceId: "plex-synthetic",
                type: "vod",
            });
            if (answer === "timeout") f.runResume();
            else
                f.w._doKey(answer === "yes" ? f.w.keys.ENTER : f.w.keys.RETURN);
            assert.deepEqual(
                f.archives,
                [],
                `${answer}: stale archive cannot replace Plex`
            );
            assert.deepEqual(
                f.played,
                [],
                `${answer}: stale fallback cannot replace Plex`
            );
            assert.equal(
                f.w.__ottClassicPlayback.snapshot().target.channelId,
                "78777"
            );
            assert.equal(f.w.$("#dialogbox").is(":visible"), false);
        } finally {
            f.close();
        }
    }
    {
        const f = fixture({ archive: true, protectedChannel: false });
        try {
            f.start();
            f.w.playChannel(1, 0);
            f.runResume();
            assert.deepEqual(f.archives, []);
            assert.deepEqual(f.played, ["https://example.invalid/channel/101"]);
        } finally {
            f.close();
        }
    }
    {
        const f = fixture({ archive: true });
        try {
            f.start();
            f.w._doKey(f.w.keys.ENTER);
            f.w.__ottClassicPlayback.command({ channelId: 101, type: "live" });
            await f.enter("2468");
            assert.deepEqual(
                f.archives,
                [],
                "A pending PIN cannot resurrect the old restore"
            );
            assert.deepEqual(f.played, []);
        } finally {
            f.close();
        }
    }

    // Stopping the same archive revokes its pending restoration without changing IDs.
    {
        const f = fixture({ archive: true, protectedChannel: false });
        try {
            f.start();
            f.w._doKey(f.w.keys.ENTER);
            assert.deepEqual(f.archives, [1700000000]);
            f.w.__ottClassicPlayback.cancel();
            f.runSeek();
            assert.deepEqual(
                f.seeks,
                [],
                "stopped archive must not restore a delayed position"
            );
        } finally {
            f.close();
        }
    }
    console.log(
        `PASS parental startup (${bundle ? "classic bundle" : "source"}): visible one-shot PIN, guarded live/archive resume, cancel/wrong PIN, normal startup, and archive confirmation`
    );
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
