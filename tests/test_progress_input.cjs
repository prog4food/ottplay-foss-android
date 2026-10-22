const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const acorn = require("acorn");
const { JSDOM } = require("jsdom");
const { classicName } = require("./helpers/english-source-fixture.cjs");
const root = path.resolve(__dirname, "..");
const bundle = process.argv[2];
const runtimeName = (name) => (bundle ? classicName(name) : name);
const source = fs.readFileSync(
    bundle || path.join(root, "src/ui/index.ts"),
    "utf8"
);
const ast = ts.createSourceFile(
    bundle || "ui.ts",
    source,
    ts.ScriptTarget.Latest,
    true
);
const names = [
    "uiInit",
    "initBackgroundIntervals",
    "usesLgPointerInput",
    "virtualTimeshiftProg",
    "_t2",
    "formatClockTime",
].map(runtimeName);
const functions = ast.statements.filter(
    (n) => ts.isFunctionDeclaration(n) && names.includes(n.name.text)
);
assert.equal(functions.length, names.length, "extract actual UI functions");
const code = ts
    .transpileModule(functions.map((n) => n.getText(ast)).join("\n"), {
        compilerOptions: {
            module: ts.ModuleKind.ES2015,
            target: ts.ScriptTarget.ES5,
        },
    })
    .outputText.replace(/^export /gm, "");
acorn.parse(code, { ecmaVersion: 5 });
function fixture(options = {}, jqueryFile = "js/jquery-1.11.1.min.js") {
    const dom = new JSDOM(
        '<link href="styles/player.css"><div id="progress_div" style="width:200px;height:10px"></div><div id="progress_span"><span></span></div>',
        { runScripts: "outside-only" }
    );
    const w = dom.window,
        calls = [];
    w.eval(fs.readFileSync(path.join(root, jqueryFile), "utf8"));
    const oldPosition = w.$.fn.position;
    w.$.fn.position = function () {
        return this[0]?.id === "progress_div"
            ? { left: 10, top: 100 }
            : oldPosition.call(this);
    };
    Object.assign(w, {
        _: (s) => s,
        catIndex: 3,
        channels: { 7: { rec: 2 } },
        curList: [7],
        keys: {},
        list_OnClick() {},
        playArchive: (at) => calls.push(["archive", at]),
        playChannel: (category, index) => calls.push(["live", category, index]),
        playTime: 95,
        playType: -1e11,
        primaryIndex: 0,
        replayFromLiveOffset: (delta) => calls.push(["rewind", delta]),
        showShift: (text) => calls.push(["message", text]),
        stbGetLen: () => 3700,
        stbSetPosTime: (at) => calls.push(["seek", at]),
        ...options,
    });
    // Source uses canonical ports; optimized artifacts retain the provider ABI.
    for (const name of ["channels", "replayFromLiveOffset"])
        w[runtimeName(name)] = w[name];
    w.Date.now = () => 1800000;
    w.console.error = (text) => calls.push(["error", text]);
    w.eval(code);
    w.uiInit();
    const element = w.document.getElementById("progress_div");
    const events = w.$._data(element, "events");
    function send(type, x, fallback = false) {
        const event = {
            clientX: x,
            stopPropagation: () => calls.push(["stop"]),
        };
        if (fallback)
            Object.defineProperty(w, "event", {
                configurable: true,
                value: event,
            });
        return events[type][0].handler.call(
            element,
            fallback ? undefined : event
        );
    }
    return {
        calls,
        clock: (at) => w[runtimeName("formatClockTime")](at),
        close: () => w.close(),
        send,
        w,
    };
}
let passed = 0;
function check(name, options, run) {
    const f = fixture(options);
    try {
        run(f);
        passed++;
        console.log("PASS progress: " + name);
    } finally {
        f.close();
    }
}
for (const kind of ["click", "mouseup"]) {
    for (const [x, at, label] of [
        [-100, 0, "00:00"],
        [10, 0, "00:00"],
        [110, 1850, "30:50"],
        [210, 3700, "1:01:40"],
        [310, 5550, "1:32:30"],
    ]) {
        check(kind + " VOD " + x, {}, ({ calls, send }) => {
            if (kind === "mouseup") send("mousedown", 10);
            send(kind, x);
            assert.deepEqual(calls, [
                ["stop"],
                ["message", ">> " + label + " <<"],
                ["seek", at],
            ]);
        });
    }
    for (const mode of [0, 1000]) {
        check(
            kind + " programme " + mode,
            { _prog100: { time: 1000, time_to: 2000 }, playType: mode },
            ({ calls, send, clock }) => {
                if (kind === "mouseup") send("mousedown", 10);
                send(kind, 110);
                assert.deepEqual(
                    calls,
                    mode
                        ? [
                              ["stop"],
                              ["message", ">> " + clock(1500) + " <<"],
                              ["archive", 1500],
                          ]
                        : [["stop"], ["rewind", 300]]
                );
            }
        );
        check(
            kind + " future programme " + mode,
            { _prog100: { time: 1000, time_to: 2000 }, playType: mode },
            ({ calls, send }) => {
                if (kind === "mouseup") send("mousedown", 10);
                send(kind, 210);
                assert.deepEqual(calls, [
                    ["stop"],
                    ["message", mode ? "Live" : "Restart stream"],
                    ["live", 3, 0],
                ]);
            }
        );
        check(
            kind + " virtual programme " + mode,
            { playType: mode },
            ({ w, calls, send, clock }) => {
                if (kind === "mouseup") send("mousedown", 10);
                send(kind, 110);
                assert.equal(w._prog100.time, -1800);
                assert.equal(w._prog100.time_to, 2700);
                assert.deepEqual(
                    calls,
                    mode
                        ? [
                              ["stop"],
                              ["message", ">> " + clock(450) + " <<"],
                              ["archive", 450],
                          ]
                        : [["stop"], ["rewind", 1350]]
                );
            }
        );
    }
}
check(
    "drag admission is cleared before callbacks and click stays independent",
    {},
    ({ calls, send }) => {
        send("mouseup", 110);
        assert.deepEqual(calls, []);
        send("mousedown", 10);
        send("mouseup", 110);
        send("mouseup", 110);
        send("click", 110);
        assert.equal(calls.filter((c) => c[0] === "seek").length, 2);
    }
);
check(
    "missing client coordinate keeps event-specific diagnostics",
    {},
    ({ calls, send }) => {
        send("mousedown");
        send("mouseup", 110);
        send("click");
        send("mousemove");
        send("mousedown", 10);
        send("mouseup");
        send("mouseup", 110);
        assert.deepEqual(
            calls,
            ["mousedown", "click", "mousemove", "mouseup"].map((type) => [
                "error",
                "$progress_div[" + type + "] evt.clientX not exist",
            ])
        );
    }
);
check("old global event fallback", {}, ({ calls, send }) => {
    send("click", 110, true);
    assert.deepEqual(calls, [
        ["stop"],
        ["message", ">> 30:50 <<"],
        ["seek", 1850],
    ]);
});
for (const channels of [{ 7: { rec: 0 } }, {}, null]) {
    check(
        "live without archive is inert",
        { channels, playType: 0 },
        ({ calls, send }) => {
            send("click", 110);
            send("mousedown", 10);
            send("mouseup", 110);
            send("mousemove", 110);
            assert.deepEqual(calls, [["stop"], ["stop"]]);
        }
    );
}
for (const [mode, programme, position] of [
    [-1e11, undefined, 1850],
    [0, { time: 1000, time_to: 2000 }, 1500],
    [1000, { time: 0, time_to: 1000 }, 500],
    [1000, undefined, 95],
    [0, undefined, 0],
]) {
    check(
        "tooltip " + mode + " " + position,
        { _prog100: programme, playType: mode },
        ({ w, calls, send, clock }) => {
            send("mousemove", 110);
            const text = w.document.querySelector(
                "#progress_span span"
            ).textContent;
            assert.equal(text, mode < 0 ? "30:50" : clock(position));
            assert.equal(
                w.document.getElementById("progress_span").style.display,
                "block"
            );
            assert.equal(
                w._prog100,
                programme,
                "tooltip does not create programme state"
            );
            assert.deepEqual(calls, []);
        }
    );
}
function startupFunctions(file, names) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    const tree = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true
    );
    const selected = tree.statements.filter(
        (node) =>
            ts.isFunctionDeclaration(node) && names.includes(node.name.text)
    );
    assert.equal(selected.length, names.length);
    return ts
        .transpileModule(
            selected.map((node) => node.getText(tree)).join("\n"),
            {
                compilerOptions: {
                    module: ts.ModuleKind.ES2015,
                    target: ts.ScriptTarget.ES5,
                },
            }
        )
        .outputText.replace(/^export /gm, "");
}
const restartCode =
    startupFunctions("src/storage/recovery-ui.ts", ["showSettingsRecovery"]) +
    startupFunctions("src/index.ts", ["startPlayer"]) +
    startupFunctions("src/core/index.ts", [
        "stbIsStandby",
        "stbSetStandby",
        "stbToggleStandby",
    ]);
for (const jqueryFile of [
    "js/jquery-1.11.1.min.js",
    "node_modules/jquery/dist/jquery.min.js",
]) {
    const f = fixture({}, jqueryFile);
    try {
        const { w, calls } = f;
        const timers = new Map();
        let timerId = 0,
            unrelatedClicks = 0,
            infoClicks = 0;
        let mediaTicks = 0,
            guideTicks = 0,
            visibilityEvents = 0;
        w.document.body.insertAdjacentHTML(
            "beforeend",
            '<div id="info1"></div><div id="listAbout"></div><div id="listEdit"></div>' +
                '<div id="listIn"></div><div id="dialogbox"></div>'
        );
        Object.assign(w, {
            __ottDeviceAdapter: {
                create: () => ({ dispose() {}, start() {} }),
            },
            clearInterval: (id) => timers.delete(id),
            getViewportHeightScale: () => 1,
            getViewportWidthScale: () => 1,
            hostUrl: "https://player.invalid",
            isPlayDistribution: () => true,
            onPlayerStart() {},
            PLAYER_VERSION: "fixture",
            setInterval(callback, delay) {
                const id = timerId++;
                timers.set(id, { callback, delay });
                return id;
            },
            settingsRecoveryRequired: () => false,
            showChannelInfo: () => infoClicks++,
            stbInit: () => false,
            stbStop() {},
            storage: { reset() {} },
            updateChannelInfo: () => guideTicks++,
            updateMediaInfo: () => mediaTicks++,
        });
        w.console.log = () => {};
        w.eval(
            "var _standby = false; var coreDeviceEffects = {};" + restartCode
        );
        w.$("#progress_div").on("click.outside", () => unrelatedClicks++);
        const probe = w.$("<div>").on("show hide", () => visibilityEvents++);
        function verify() {
            const oldClicks = unrelatedClicks,
                oldInfo = infoClicks;
            const oldSeeks = calls.filter((call) => call[0] === "seek").length;
            w.$("#progress_div").trigger(w.$.Event("click", { clientX: 110 }));
            w.$("#info1").trigger("click");
            assert.equal(
                calls.filter((call) => call[0] === "seek").length,
                oldSeeks + 1,
                "each click seeks once after restart"
            );
            assert.equal(
                unrelatedClicks,
                oldClicks + 1,
                "unrelated listener survives restart"
            );
            assert.equal(infoClicks, oldInfo + 1, "info click is bound once");
            const beforeVisibility = visibilityEvents;
            probe.show().hide();
            assert.equal(
                visibilityEvents,
                beforeVisibility + 2,
                "show/hide wrapper emits each notification once"
            );
            let listShows = 0,
                listHides = 0;
            w.$("#listIn")
                .on("show.outside", () => listShows++)
                .on("hide.outside", () => listHides++);
            w.$("#listAbout").show().hide();
            w.$("#listEdit").show().hide();
            assert.deepEqual(
                [listShows, listHides],
                [2, 2],
                "each overlay visibility event has one owned listener"
            );
            w.$("#listIn").off(".outside");
            assert.deepEqual(
                [...timers.values()]
                    .map((job) => job.delay)
                    .sort((a, b) => a - b),
                [1000, 30000],
                "one active timer for each background task"
            );
            const beforeMedia = mediaTicks,
                beforeGuide = guideTicks;
            for (const job of timers.values()) job.callback();
            assert.equal(
                mediaTicks,
                beforeMedia + 1,
                "one media refresh per tick"
            );
            w.playType = 0;
            for (const job of timers.values())
                if (job.delay === 30000) job.callback();
            assert.equal(
                guideTicks,
                beforeGuide + 1,
                "one guide refresh per tick"
            );
            w.playType = -1e11;
        }
        w.startPlayer();
        verify();
        for (let restart = 0; restart < 3; restart++) {
            const retiredCallbacks = [...timers.values()].map(
                (job) => job.callback
            );
            if (restart === 1) {
                w.document.getElementById("progress_div").outerHTML =
                    '<div id="progress_div" style="width:200px;height:10px"></div>';
                w.document.getElementById("progress_span").outerHTML =
                    '<div id="progress_span"><span></span></div>';
                w.$("#progress_div").on(
                    "click.outside",
                    () => unrelatedClicks++
                );
            }
            w.stbToggleStandby();
            w.stbToggleStandby();
            const beforeMedia = mediaTicks,
                beforeGuide = guideTicks;
            retiredCallbacks.forEach((callback) => callback());
            assert.deepEqual(
                [mediaTicks, guideTicks],
                [beforeMedia, beforeGuide],
                "callbacks queued before timer replacement are retired"
            );
            verify();
            w.$("#progress_div").trigger(
                w.$.Event("mousemove", { clientX: 110 })
            );
            assert.equal(
                w.document.querySelector("#progress_span span").textContent,
                "30:50",
                "replacement progress and tooltip elements receive current handlers"
            );
        }
        assert.equal(calls.filter((call) => call[0] === "error").length, 0);
        passed++;
        console.log(
            "PASS progress: repeated standby/start lifecycle " + jqueryFile
        );
    } finally {
        f.close();
    }
}
console.log(
    "PASS progress input: " +
        passed +
        " actual uiInit ES5 scenarios" +
        (bundle ? " from " + bundle : "")
);
