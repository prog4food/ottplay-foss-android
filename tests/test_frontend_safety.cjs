const { cloudSource } = require("./helpers/cloud-source-fixture.cjs");
const { localizationRuntime } = require("./helpers/localization-runtime.cjs");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const acorn = require("acorn");
const {
    attachSourceAliases,
    classicName,
} = require("./helpers/english-source-fixture.cjs");
const root = path.resolve(__dirname, "..");
const ts = require(path.join(root, "node_modules/typescript"));
const asts = {};
const bundleIndex = process.argv.indexOf("--bundle");
const bundleAst =
    bundleIndex >= 0
        ? ts.createSourceFile(
              "bundle.js",
              fs.readFileSync(
                  path.resolve(process.argv[bundleIndex + 1]),
                  "utf8"
              ),
              ts.ScriptTarget.Latest,
              true
          )
        : null;
const { JSDOM } = require(path.join(root, "node_modules/jsdom"));
const localizationCode = localizationRuntime(
    bundleIndex >= 0
        ? path.relative(root, path.resolve(process.argv[bundleIndex + 1]))
        : undefined
);
function ast(file) {
    return (
        asts[file] ||
        (asts[file] = ts.createSourceFile(
            file,
            fs.readFileSync(path.join(root, file), "utf8"),
            ts.ScriptTarget.Latest,
            true
        ))
    );
}
function js(text) {
    return ts.transpileModule(text.replace(/^export /gm, ""), {
        compilerOptions: {
            module: ts.ModuleKind.None,
            target: ts.ScriptTarget.ES5,
        },
    }).outputText;
}
function func(file, name) {
    if (file.startsWith("src/") && bundleAst) name = classicName(name);
    const a = (file.startsWith("src/") && bundleAst) || ast(file),
        n = a.statements.find(
            (n) => ts.isFunctionDeclaration(n) && n.name?.text === name
        );
    if (!n) throw Error(name);
    return js(n.getText(a));
}
function variable(file, name) {
    const a = ast(file);
    for (const n of a.statements)
        if (ts.isVariableStatement(n))
            for (const d of n.declarationList.declarations)
                if (d.name.getText(a) === name)
                    return js("var " + d.getText(a) + ";");
    throw Error(name);
}
function fixture() {
    const d = new JSDOM(
        '<div id="listAbout" style="display:none"></div><div id="dialogbox" style="display:none"></div><div id="listEdit"></div><div id="listIn"></div><div id="listCaption"></div><div id="listDetail"></div><div id="listPodval"></div>',
        { runScripts: "dangerously", url: "https://localhost/index.html" }
    );
    const w = d.window;
    require("./helpers/shared-core-runtime.cjs")(d.getInternalVMContext());
    if (bundleAst) attachSourceAliases(w);
    w.console.warn = () => {};
    w.eval(
        fs.readFileSync(
            path.join(
                root,
                process.env.OTTPLAY_TEST_JQUERY || "js/jquery-1.11.1.min.js"
            ),
            "utf8"
        )
    );
    w.$.expr.filters.visible = (e) => e.style.display !== "none";
    w.eval(localizationCode);
    if (bundleAst) {
        w.eval(
            bundleAst.statements
                .filter(
                    (n) =>
                        ts.isFunctionDeclaration(n) &&
                        /^__ottReadImport/.test(n.name?.text || "")
                )
                .map((n) => n.getText(bundleAst))
                .join("\n")
        );
    }
    Object.assign(w, {
        _: (x) => x,
        bodyColor: "#fff",
        curColor: "gold",
        curColorB: "#668",
        host: "https://localhost",
        keys: {
            ENTER: 13,
            EXIT: 27,
            FF: 70,
            INFO: 73,
            N2: 50,
            NEXT: 78,
            RETURN: 8,
            RIGHT: 39,
        },
        listCaptionElement: w.document.getElementById("listCaption"),
        listDetail: w.document.getElementById("listDetail"),
        listFooterElement: w.document.getElementById("listPodval"),
        nativeListInertia: null,
        renderButtonHint: (key, s, label) =>
            '<span data-key="' + key + '">' + label + "</span>",
        restoreListPanelState() {},
        saveListPanelState() {},
        scrollUp() {},
        settingsRecoveryRequired: () => false,
        showPage() {},
        stbEventToKeyCode: (e) => e.keyCode,
        stbGetItem: () => null,
        strFF: "FF",
        strInfo: "Info",
        strNEXT: "Next",
        strRETURN: "Return",
        strRIGHT: "Right",
        ui_state: { ld: "Synthetic programme description" },
    });
    for (const name of [
        "strENTER",
        "strEXIT",
        "strSTOP",
        "strPLAY",
        "strPAUSE",
        "strPREV",
        "strRW",
        "strUP",
        "strDOWN",
        "strLEFT",
        "strTools",
        "strEPG",
        "strAudio",
        "strLANG",
        "strSubt",
        "strAspect",
        "strZoom",
        "strPip",
        "strFAV",
        "strMENU",
    ])
        w[name] = name;
    w.eval(
        [
            "metadataText",
            "metadataImageUrl",
            "metadataCssUrl",
            "metadataHtml",
            "hasTmdbService",
        ]
            .map((n) => func("src/utils/helpers.ts", n))
            .join("\n")
    );
    w.eval(func("src/ui/index.ts", "localizedTextHtml"));
    w.eval(func("src/storage/recovery-ui.ts", "showSettingsRecovery"));
    w.setTimeout = () => 1;
    w.clearTimeout = () => {};
    w.requestAnimationFrame = () => {};
    w.eval(func("src/storage/index.ts", "isPortableSettingsKey"));
    return w;
}

let count = 0;
function test(name, run) {
    run();
    count++;
    console.log("PASS frontend safety: " + name);
}
const hostile =
    '<img src="missing" onerror="window.__executed=true"><script>window.__executed=true</script>';

test("cloud bundle extraction selects exact closures and rejects missing dependencies", () => {
    const code = [
        'var STORAGE_FALLBACK_KEYS = "ottplayStorageFallback";',
        "function isStorageMetadataKey(key) { return key === STORAGE_FALLBACK_KEYS; }",
        "function isPortableSettingsKey(key) { return !isStorageMetadataKey(key); }",
        "function metadataText(value) { return value; }",
        "function settingsFailure() {}",
        "function commitSettingsWrites() {}",
        "var unrelated = 1, cloudSettingsTransfer = { send: function(){}, load: function(){} };",
        "function cloudSendSettings() { cloudSettingsTransfer.send(); }",
        "function cloudLoadSettings() { cloudSettingsTransfer.load(); }",
        "(function(){window.unrelatedBefore = true;})(), (function(){window.__ottSourceIdentity = {};})(), (function(){window.__ottCloudSettingsCodec = {};})(), (function(){window.unrelatedAfter = true;})();",
    ].join("\n");
    const parse = (value) =>
        ts.createSourceFile("artifact.js", value, ts.ScriptTarget.Latest, true);
    const extracted = cloudSource(parse(code));
    acorn.parse(extracted, { ecmaVersion: 5 });
    assert.equal(extracted.includes("unrelated"), false);
    for (const name of [
        "STORAGE_FALLBACK_KEYS",
        "isStorageMetadataKey",
        "isPortableSettingsKey",
        "metadataText",
        "settingsFailure",
        "commitSettingsWrites",
        "cloudSettingsTransfer",
        "cloudSendSettings",
        "cloudLoadSettings",
        "__ottSourceIdentity",
        "__ottCloudSettingsCodec",
    ]) {
        const artifact = bundleAst ? bundleAst.text : code;
        assert.throws(
            () =>
                cloudSource(parse(artifact.replaceAll(name, name + "Missing"))),
            /Expected (?:one bundled cloud dependency|one storage policy function|storage metadata namespace)/,
            name + " must come from the supplied artifact"
        );
    }
});

test("channel list keeps hostile titles as text and preserves intentional row layout", () => {
    const w = fixture();
    try {
        const a = ast("src/provider/index.ts");
        let renderer;
        function visit(n) {
            if (
                ts.isVariableDeclaration(n) &&
                n.name.getText(a) === "channelItemFormatter" &&
                n.initializer &&
                ts.isFunctionExpression(n.initializer)
            )
                renderer = n.initializer;
            ts.forEachChild(n, visit);
        }
        visit(a);
        assert(renderer);
        Object.assign(w, {
            $infoBar: w.$("<div>"),
            archWidth: 0,
            boxH: 28,
            channelLogoSize: 0,
            channels: {
                fixture: {
                    channel_name: hostile,
                    name: hostile,
                    time: 1,
                    time_to: Date.now() / 1000 + 30,
                },
                other: { channel_name: "Other channel", name: "Other channel" },
            },
            currentProgramRequestQueue: [],
            getViewportWidthScale: () => 1,
            listArray: [],
            listDataArray: ["fixture", "other"],
            listElement: null,
            listInElement: w.document.getElementById("listIn"),
            listRowHeight: () => 28,
            numWidth: 0,
            observeCurrentProgramme() {},
            packListRowBoxes() {},
            parentalArray: [],
            parentPIN: "*",
            progBarH: 1,
            progMargin: 0,
            progWidth: 0,
            scheduleListDetailUpdate() {},
            selIndex: 0,
            settings: { noSmall: 1, pageSize: 25 },
            showName: true,
            showProgram: true,
            sPSchannels: false,
            updateChannelListRow() {},
        });
        // The renderer delegates roving focus and selected state to this real
        // port; keep it present in the fixture as it is in the classic bundle.
        w.eval(
            js(
                fs.readFileSync(
                    path.join(root, "src/ui/accessibility.ts"),
                    "utf8"
                )
            )
        );
        w.eval(
            js("window.getListItemFn=" + renderer.getText(a) + ";") +
                func("src/ui/index.ts", "showPage")
        );
        w.showPage();
        assert.equal(
            w.document.querySelectorAll("#listIn img,#listIn script").length,
            0
        );
        assert(w.document.getElementById("it0").textContent.includes(hostile));
        assert.equal(
            w.document.getElementById("it0").getAttribute("role"),
            "option"
        );
        assert.equal(w.document.getElementById("it0").tabIndex, 0);
        assert.equal(
            w.document.getElementById("it0").getAttribute("aria-selected"),
            "true"
        );
        assert.equal(
            w.document.getElementById("it1").getAttribute("role"),
            "option"
        );
        assert.equal(
            w.document.getElementById("it1").getAttribute("aria-selected"),
            "false"
        );
        assert.equal(w.document.getElementById("it1").tabIndex, -1);
        w.selIndex = 1;
        w.showPage();
        assert.equal(w.document.getElementById("it0").tabIndex, -1);
        assert.equal(
            w.document.getElementById("it0").getAttribute("aria-selected"),
            "false"
        );
        assert.equal(w.document.getElementById("it1").tabIndex, 0);
        assert.equal(
            w.document.getElementById("it1").getAttribute("aria-selected"),
            "true"
        );
        assert.equal(w.__executed, undefined);
    } finally {
        w.close();
    }
});
test("VOD descriptions and thumbnails preserve formatting while removing active content and unsafe attributes", () => {
    const w = fixture();
    try {
        w.eval(
            func("src/channels/index.ts", "getMediaDescr") +
                func("src/utils/helpers.ts", "getThumbnail")
        );
        w.sThumbnail = 1;
        w.getViewportWidthScale = () => 1;
        w.getViewportHeightScale = () => 1;
        const description =
            "<b>Heading</b><br>Detail <i>italic</i>" +
            hostile +
            '<svg onload="window.__executed=true"></svg><img src="javascript:alert(1)"><a href="javascript:alert(1)">link</a>';
        const target = w.document.getElementById("listDetail");
        target.innerHTML = w.getMediaDescr({ description: () => description });
        assert.equal(target.querySelector("b").textContent, "Heading");
        assert(target.querySelector("br"));
        assert(target.querySelector("i"));
        assert.equal(
            target.querySelectorAll(
                "script,svg,iframe,[onerror],[onload],[href]"
            ).length,
            0
        );
        assert.equal(target.querySelectorAll("img").length, 1);
        assert.equal(w.__executed, undefined);
        target.innerHTML = w.getThumbnail(
            'https://images.invalid/a\'");color:red;" onerror="window.__executed=true'
        );
        assert.equal(target.children.length, 1);
        assert.equal(target.querySelectorAll("[onerror]").length, 0);
        assert.equal(target.firstChild.style.color, "");
        for (const url of [
            "javascript:alert(1)",
            "file:///private",
            "data:text/html,<script>x</script>",
        ])
            assert.equal(w.metadataImageUrl(url), "");
        assert.equal(
            w.metadataImageUrl("https://images.invalid/icon?a=1&b=2"),
            "https://images.invalid/icon?a=1&b=2"
        );
        acorn.parse(func("src/utils/helpers.ts", "metadataHtml"), {
            ecmaVersion: 5,
        });
    } finally {
        w.close();
    }
});
test("EPG list titles are escaped without losing current-programme highlighting", () => {
    const w = fixture();
    try {
        Object.assign(w, {
            channels: { fixture: { rec: true } },
            epg_ch_id: "fixture",
            formatEpgTime: () => "12:00",
        });
        w.eval(
            fs.readFileSync(path.join(root, "vendor/ottplay-core.js"), "utf8")
        );
        const programme = {
            name: hostile,
            programmeId: "guide-row",
            time: Date.now() / 1000 - 2,
            time_to: Date.now() / 1000 + 30,
        };
        w.listEpgArray = [programme];
        w.eval(func("src/channels/index.ts", "itemEPG"));
        w.document.getElementById("listIn").innerHTML = w.itemEPG(programme, 0);
        assert.equal(
            w.document.querySelectorAll("#listIn img,#listIn script").length,
            0
        );
        assert(w.document.querySelector("#listIn span[style]"));
        assert(
            w.document.getElementById("listIn").textContent.includes(hostile)
        );
    } finally {
        w.close();
    }
});
test("buttons help closes with Back and existing RETURN, while native cloud save opens export", () => {
    const w = fixture();
    try {
        w.eval(
            func("src/index.ts", "buttonsInfo") +
                func("src/key-handler/index.ts", "cancelNativeListInertia") +
                func("src/key-handler/index.ts", "keyHandler") +
                cloudSource(bundleAst)
        );
        for (const key of [w.keys.EXIT, w.keys.RETURN]) {
            w.buttonsInfo();
            w.keyHandler({
                keyCode: key,
                preventDefault() {},
                stopPropagation() {},
            });
            assert.equal(
                w.document.getElementById("listAbout").style.display,
                "none"
            );
        }
        let exported = 0;
        w.exportSettingsUI = () => exported++;
        w.Capacitor = {};
        w.cloudSendSettings();
        assert.equal(exported, 1);
        delete w.Capacitor;
        w.__TAURI__ = {};
        w.cloudSendSettings();
        assert.equal(exported, 2);
        delete w.__TAURI__;
        w.host_ott = "fixture.invalid";
        w.host_ott_proto = "https://";
        w.stbGetAllItems = () => ({
            fixture: "value",
            sLocalHttpDeviceCode: "private-device-code-do-not-upload",
            sLocalHttpEnabled: "1",
        });
        let post;
        w.$.ajax = (opts) => {
            post = opts;
        };
        w.cloudSendSettings();
        assert.equal(post.url, "https://fixture.invalid/swop/a.php");
        assert(post.data.d.includes("fixture"));
        assert(!post.data.d.includes("sLocalHttpEnabled"));
        assert(!post.data.d.includes("sLocalHttpDeviceCode"));
        assert(!post.data.d.includes("private-device-code-do-not-upload"));
    } finally {
        w.close();
    }
});
test("cloud restore ignores injected local HTTP consent and credentials", () => {
    const w = fixture();
    try {
        w.eval(cloudSource(bundleAst));
        const stored = new Map([
            ["sLocalHttpEnabled", "1"],
            ["sLocalHttpDeviceCode", "old-local-code"],
            ["ordinary", "old-value"],
        ]);
        let cleared = 0;
        let restarted = 0;
        let post;
        let poll;
        w.host_ott = "fixture.invalid";
        w.host_ott_proto = "https://";
        w.stbClearAllItems = () => {
            cleared++;
            stored.clear();
        };
        w.stbSetItem = (key, value) => stored.set(key, value);
        w.stbGetItem = (key) => stored.get(key) ?? null;
        w.stbDelItem = (key) => stored.delete(key);
        w.stbGetAllItems = () => Object.fromEntries(stored);
        w.restart = () => restarted++;
        w.setTimeout = (callback, delay) => {
            if (delay === 10000) poll = callback;
            return 1;
        };
        w.$.ajax = (options) => {
            post = options;
        };
        w.cloudLoadSettings();
        assert.equal(post.data.c, "get_code");
        post.success({ code: "transfer-code" });
        assert.equal(
            cleared,
            0,
            "requesting a cloud import must not change local consent"
        );
        poll();
        assert.equal(post.data.c, "get");
        assert.equal(post.data.d, "transfer-code");
        post.success({
            data:
                "<properties><comment>OTT-Play Preferences</comment>" +
                '<entry key="ordinary">restored-value</entry>' +
                '<entry key="sLocalHttpEnabled">1</entry>' +
                '<entry key="sLocalHttpDeviceCode">injected-code</entry>' +
                "</properties>",
            status: "success",
        });
        assert.equal(cleared, 0, "restore never clears the storage wholesale");
        assert.equal(restarted, 1);
        assert.equal(stored.get("ordinary"), "restored-value");
        assert.equal(
            stored.has("sLocalHttpEnabled"),
            false,
            "cloud imports cannot enable a local listener"
        );
        assert.equal(
            stored.has("sLocalHttpDeviceCode"),
            false,
            "cloud imports cannot copy another device's code"
        );
    } finally {
        w.close();
    }
});
test("Capacitor hides unavailable TMDb; web and Tauri retain the functional action", () => {
    const w = fixture();
    try {
        w.eval(
            js(
                fs.readFileSync(
                    path.join(root, "src/localization/assets.ts"),
                    "utf8"
                )
            ) +
                variable("src/index.ts", "TMDb") +
                func("src/ui/index.ts", "showProgramInfo")
        );
        let calls = [];
        w.$.ajax = (opts) => calls.push(opts);
        w.Capacitor = {};
        w.showProgramInfo("A programme");
        assert(
            !w.document
                .getElementById("listPodval")
                .textContent.includes("TMDb")
        );
        w.TMDb.search("Blocked");
        assert.equal(calls.length, 0);
        delete w.Capacitor;
        w.__TAURI__ = {};
        w.showProgramInfo("A programme");
        assert(
            w.document.getElementById("listPodval").textContent.includes("TMDb")
        );
        w.aboutKeyHandler(w.keys.N2);
        assert.equal(calls.length, 1);
        assert(calls[0].url.includes("/tmdb/s/search/multi"));
        delete w.__TAURI__;
        w.TMDb.search("Web programme");
        assert.equal(calls.length, 2);
    } finally {
        w.close();
    }
});
const startupFailure = new Error(hostile + ' & "message"');
startupFailure.name = hostile + ' & "name"';
const startupCases = [
    ["Error", startupFailure, startupFailure.name, startupFailure.message],
    ["empty Error", new Error(""), "Error", ""],
    ["empty error shape", { message: "", name: "" }, "", ""],
    ["null", null, "Error", "null"],
    ["undefined", undefined, "Error", "undefined"],
    ["hostile string", hostile, "Error", hostile],
];
for (const entrypoint of ["startPlayer", "onStbReady"]) {
    for (const hasLaunch of [true, false]) {
        for (const [kind, failure, name, message] of startupCases) {
            test(
                entrypoint +
                    " handles thrown " +
                    kind +
                    (hasLaunch ? " as launch text" : " without a launch panel"),
                () => {
                    const w = fixture();
                    try {
                        const launch = w.document.createElement("div");
                        launch.id = "launch";
                        const button = w.document.createElement("button");
                        button.textContent = "Boot progress";
                        launch.appendChild(button);
                        if (hasLaunch) w.document.body.appendChild(launch);
                        let previous, existingBreaks;
                        let reachedFailure = false;
                        const fail = () => {
                            reachedFailure = true;
                            previous = launch.firstChild;
                            existingBreaks =
                                launch.querySelectorAll("br").length;
                            throw failure;
                        };
                        Object.assign(w, {
                            _: (key) =>
                                key === "Player could not start"
                                    ? "Не удалось запустить плеер"
                                    : key,
                            hostUrl: "https://localhost",
                            isPlayDistribution: () => true,
                            loadSettings: fail,
                            onPlayerStart() {},
                            PLAYER_VERSION: "fixture",
                            storage: { reset: fail },
                        });
                        const logged = [];
                        w.console.error = (error) => logged.push(error);
                        w.eval(
                            func("src/index.ts", "startupError") +
                                func("src/index.ts", entrypoint)
                        );
                        assert.doesNotThrow(() => w[entrypoint]());
                        assert.equal(reachedFailure, true);
                        assert.equal(logged.length, 1);
                        assert.equal(logged[0], failure);
                        assert.equal(launch.firstChild, previous);
                        if (hasLaunch) {
                            assert.equal(
                                launch.querySelector("b").textContent,
                                "Не удалось запустить плеер"
                            );
                            assert.equal(
                                launch.querySelectorAll("br").length,
                                existingBreaks + 2
                            );
                            assert.equal(
                                launch.lastChild.textContent,
                                entrypoint + " " + name + ": " + message
                            );
                        } else {
                            assert.equal(
                                w.document.getElementById("launch"),
                                null
                            );
                            assert.equal(launch.childNodes.length, 1);
                        }
                        assert.equal(
                            launch.querySelectorAll("img,script,[onerror]")
                                .length,
                            0
                        );
                        assert.equal(w.__executed, undefined);
                    } finally {
                        w.close();
                    }
                }
            );
        }
    }
}
for (const phase of ["request", "poll"]) {
    test(
        "remote provider " +
            phase +
            " errors display response text without HTML",
        () => {
            const w = fixture();
            try {
                const requests = [],
                    timers = [];
                Object.assign(w, {
                    __test: "",
                    host_ott: "localhost",
                    host_ott_proto: "https://",
                    isPlayDistribution: () => false,
                    listFooter: w.document.getElementById("listPodval"),
                    setTimeout: (callback, delay) =>
                        timers.push({ callback, delay }),
                });
                w.$.ajax = (request) => requests.push(request);
                w.eval(func("src/provider/index.ts", "edit_dealer_remote"));
                w.edit_dealer_remote();
                assert.equal(requests[0].data.c, "get_var");
                if (phase === "poll") {
                    requests[0].success({ code: "fixture-code" });
                    timers.find((timer) => timer.delay === 1e4).callback();
                    assert.equal(requests[1].data.c, "get_val");
                }
                const responseText = hostile + ' & "response"';
                requests[requests.length - 1].error({ responseText });
                const panel = w.document.getElementById("listEdit");
                assert.equal(panel.textContent, "ERROR:" + responseText);
                assert.equal(panel.firstChild.style.color, "red");
                assert.equal(panel.querySelectorAll("br").length, 3);
                assert.equal(
                    panel.querySelectorAll("img,script,[onerror]").length,
                    0
                );
                assert.equal(w.__executed, undefined);
            } finally {
                w.close();
            }
        }
    );
}
test("legacy editor treats captions and field values as text and round-trips saved input", () => {
    const w = fixture();
    try {
        w.eval(
            func("devices/legacy-core.js", "showEditKey2") +
                func("devices/legacy-core.js", "editKey2")
        );
        w.listCaption = w.document.getElementById("listCaption");
        w.saveCPD = () => {};
        w.restoreCPD = () => {};
        w.btnDiv = w.renderButtonHint;
        w.editCaption = hostile + ' & "caption"';
        w.editvar =
            '\"><img src="missing" onerror="window.__executed=true">&quot;&amp;';
        w.showEditKey2();
        const panel = w.document.getElementById("listEdit");
        const input = panel.querySelector("input");
        assert.equal(w.listCaption.textContent, w.editCaption);
        assert(panel.textContent.startsWith(w.editCaption + ":"));
        assert.equal(input.value, w.editvar);
        assert.equal(input.style.color, "gold");
        assert.equal(w.document.activeElement, input);
        assert.equal(
            w.document.querySelectorAll("img,script,[onerror]").length,
            0
        );
        const updated = 'https://example.invalid/?a="<&b=&quot;';
        input.value = updated;
        let saved;
        w.setEdit = () => (saved = w.editvar);
        w.editKey2(w.keys.ENTER);
        assert.equal(saved, updated);
        assert.equal(panel.style.display, "none");
        // CSS values must not escape into attributes or markup either.
        w.curColor = 'red;\" onfocus="window.__executed=true';
        w.showEditKey2();
        assert.equal(panel.querySelectorAll("[onfocus],img,script").length, 0);
        assert.equal(w.__executed, undefined);
    } finally {
        w.close();
    }
});
test("button hint label stripping is bounded on long unmatched tag starts", () => {
    // Isolate the label stage from the HTML sanitizer: a future sanitizer must
    // not make malformed markup trigger quadratic backtracking in this stage.
    const context = vm.createContext({
        _: (value) => value,
        keys: {},
        metadataHtml: (value) => value,
        translate: (value) => value,
        window: {},
    });
    vm.runInContext(
        func("src/utils/helpers.ts", "metadataText") +
            func("src/ui/index.ts", "renderButtonHint"),
        context
    );
    const call =
        (bundleAst ? classicName("renderButtonHint") : "renderButtonHint") +
        '(13, "Enter", description)';
    context.description = "<".repeat(150000);
    const rendered = vm.runInContext(call, context, { timeout: 2000 });
    assert(rendered.includes('aria-label="' + "&lt;".repeat(150000) + '"'));
    context.description = "<b>Play</b><br> / pause";
    assert(
        vm.runInContext(call, context).includes('aria-label=" Play   / pause"')
    );
});
test("real password action selects a secret editor; normal input restores text and controls are keyboard accessible", () => {
    const w = fixture();
    try {
        w.eval(
            func("src/ui/index.ts", "showEditKey2") +
                func("providers/xtream/provider.js", "editXtreamSettings") +
                func("src/ui/index.ts", "renderButtonHint")
        );
        w.xtream = {
            password: "synthetic-secret",
            server: "https://fixture.invalid",
            username: "fixture",
        };
        w.loadXtreamParams = () => {};
        w.showEditKey = w.showEditKey2;
        w.listCaption = w.document.getElementById("listCaption");
        w.listFooter = w.document.getElementById("listPodval");
        attachSourceAliases(w);
        w.editXtreamSettings();
        w.selIndex = 2;
        w.listKeyHandler(w.keys.ENTER);
        let input = w.document.getElementById("editvar");
        assert.equal(input.type, "password");
        assert.equal(input.value, "synthetic-secret");
        assert.equal(input.autocomplete, "off");
        assert.equal(input.getAttribute("aria-label"), "Enter password");
        w.editCaption = "Playlist URL";
        w.editvar = "https://fixture.invalid?a=1&b=2";
        w.showEditKey2();
        input = w.document.getElementById("editvar");
        assert.equal(input.type, "text");
        assert.equal(input.value, w.editvar);
        w.document.getElementById("listPodval").innerHTML = w.renderButtonHint(
            13,
            "▸",
            "<b>Play</b> / pause"
        );
        const control = w.document.querySelector('#listPodval [role="button"]');
        assert.equal(control.tabIndex, 0);
        assert(control.getAttribute("aria-label").includes("Play"));
        let pressed;
        w._doKey = (key) => (pressed = key);
        w.eval(func("src/ui/index.ts", "uiInit"));
        w.uiInit();
        control.focus();
        control.dispatchEvent(
            new w.KeyboardEvent("keydown", {
                bubbles: true,
                cancelable: true,
                keyCode: 13,
            })
        );
        assert.equal(pressed, 13);
    } finally {
        w.close();
    }
});
test("button hints reject executable key values and sanitize every badge while preserving icons", () => {
    const w = fixture();
    try {
        w.eval(func("src/ui/index.ts", "renderButtonHint"));
        for (const key of [
            "13);window.__executed=1;//",
            '13\" onmouseover=\"window.__executed=1',
            "invalid",
        ]) {
            assert.equal(w.renderButtonHint(key, "Enter", "Confirm"), "");
        }
        const legacyIcon = '<span class="fontello">&#xe811;</span>';
        const nativeBundle =
            bundleAst && /\bsystem-icons\b/.test(bundleAst.text);
        const icon = nativeBundle
            ? require("../scripts/play-system-icons.cjs").transformPlaySystemIcons(
                  legacyIcon
              )
            : legacyIcon;
        const footer = w.document.getElementById("listPodval");
        footer.innerHTML = w.renderButtonHint(
            "13",
            icon + hostile,
            "<b>Confirm</b>" + hostile,
            icon + hostile,
            icon + hostile
        );
        assert.equal(
            footer.querySelectorAll("script,[onerror],[onmouseover],svg")
                .length,
            0
        );
        const badges = footer.querySelectorAll(".btn");
        assert.equal(badges.length, 3);
        for (const badge of badges) {
            const preserved = badge.querySelector(
                nativeBundle ? "span.system-icons" : "span.fontello"
            );
            assert(preserved, "Every badge retains its platform icon");
            const expected = w.document.createElement("div");
            expected.innerHTML = icon;
            assert.equal(preserved.textContent, expected.textContent);
        }
        const control = footer.querySelector('[role="button"]');
        assert.equal(control.tabIndex, 0);
        assert(control.getAttribute("aria-label").includes("Confirm"));
        let pressed;
        w._doKey = (key) => (pressed = key);
        w.eval(func("src/ui/index.ts", "uiInit"));
        w.uiInit();
        control.dispatchEvent(
            new w.KeyboardEvent("keydown", {
                bubbles: true,
                cancelable: true,
                keyCode: 32,
            })
        );
        assert.equal(pressed, 13);
        assert.equal(w.__executed, undefined);
    } finally {
        w.close();
    }
});
test("notifications and stream selectors sanitize metadata while preserving fixed legacy icon markup", () => {
    const w = fixture();
    try {
        const info = w.document.createElement("div");
        info.id = "info";
        w.document.body.appendChild(info);
        const style = w.document.createElement("style");
        style.textContent = fs
            .readFileSync(path.join(root, "styles/player.css"), "utf8")
            .match(/#info\s*\{[^}]*\}/)[0];
        w.document.head.appendChild(style);
        assert.equal(w.getComputedStyle(info).display, "none");
        w.channelNumberElement = w.document.createElement("div");
        w.document.body.appendChild(w.channelNumberElement);
        w.closeList = () => {};
        w.eval(
            func("src/ui/index.ts", "showShift") +
                func("src/ui/index.ts", "showSelectBox")
        );
        w.showShift("<b>Notice</b>" + hostile);
        assert.notEqual(w.getComputedStyle(info).display, "none");
        assert(info.querySelector("b"));
        assert.equal(info.querySelectorAll("script,[onerror]").length, 0);
        const legacyIcon = '<span class="fontello">&#xe811;</span>';
        const nativeBundle =
            bundleAst && /\bsystem-icons\b/.test(bundleAst.text);
        const icon = nativeBundle
            ? require("../scripts/play-system-icons.cjs").transformPlaySystemIcons(
                  legacyIcon
              )
            : legacyIcon;
        w.showSelectBox(0, [hostile, icon], () => {}, -1);
        assert.equal(
            w.channelNumberElement.querySelectorAll("script,[onerror]").length,
            0
        );
        assert(
            w.channelNumberElement.querySelector(
                "span.fontello, span.system-icons"
            )
        );
        assert.equal(
            w.channelNumberElement.querySelector(
                "span.fontello, span.system-icons"
            ).textContent,
            new JSDOM(icon).window.document.querySelector("span").textContent
        );
        assert.equal(w.__executed, undefined);
    } finally {
        w.close();
    }
});
test("Play URL policy explains remote HTTP rejection without changing Full or local endpoints", () => {
    const w = fixture();
    try {
        w.eval(
            func("src/provider/index.ts", "isPlayDistribution") +
                func("src/provider/index.ts", "checkProviderUrl")
        );
        w.providerDistribution = "play";
        let messages = [];
        w.alert = (message) => messages.push(message);
        assert.equal(
            w.checkProviderUrl("http://provider.invalid/playlist"),
            false
        );
        assert(messages[0].includes("HTTPS"));
        for (const url of [
            "https://provider.invalid/playlist",
            "http://127.0.0.1:8080/commands",
            "http://localhost/internal",
            "/demo/pattern.mp4",
        ])
            assert.equal(w.checkProviderUrl(url), true);
        w.providerDistribution = "full";
        assert.equal(
            w.checkProviderUrl("http://provider.invalid/playlist"),
            true
        );
    } finally {
        w.close();
    }
});
(async function () {
    const w = fixture();
    try {
        const a = ast("src/index.ts");
        const block = a.statements.find(
            (n) =>
                ts.isIfStatement(n) &&
                n.getText(a).includes("window.stbExit = function") &&
                n.getText(a).includes("stopBackgroundAudio")
        );
        assert(block);
        const calls = [];
        let finishStop;
        w.stbStop = () => calls.push("decoder");
        w.Capacitor = {
            Plugins: {
                App: {
                    exitApp: async () => {
                        calls.push("app-exit");
                        throw Error("fixture unavailable");
                    },
                },
                MobileNativeMedia: {
                    exitApp: async () => calls.push("fallback-exit"),
                    stopBackgroundAudio: () => {
                        calls.push("native-stop");
                        return new Promise((resolve) => (finishStop = resolve));
                    },
                },
            },
        };
        w.eval(js(block.getText(a)));
        w.stbExit();
        assert.deepEqual(calls, ["decoder", "native-stop"]);
        finishStop();
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.deepEqual(calls, [
            "decoder",
            "native-stop",
            "app-exit",
            "fallback-exit",
        ]);
        count++;
        console.log(
            "PASS frontend safety: native exit waits for media stop and handles async App failure"
        );
    } finally {
        w.close();
    }
    console.log("Frontend safety: " + count + " scenarios passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
