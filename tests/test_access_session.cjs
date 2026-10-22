const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const acorn = require("acorn");
const { JSDOM } = require("jsdom");
const root = path.resolve(__dirname, "..");
let passed = 0;
const cases = [];
function check(name, run) {
    cases.push(async () => {
        await run();
        passed++;
        console.log("OK: " + name);
    });
}
function compile(text) {
    const code = ts
        .transpileModule(text.replace(/^export /gm, ""), {
            compilerOptions: {
                module: ts.ModuleKind.None,
                target: ts.ScriptTarget.ES5,
            },
        })
        .outputText.replace(/^export /gm, "");
    acorn.parse(code, { ecmaVersion: 5 });
    return code;
}
function functions(file, names) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    return compile(
        ast.statements
            .filter(
                (node) =>
                    (ts.isFunctionDeclaration(node) &&
                        names.includes(node.name?.text)) ||
                    (ts.isExpressionStatement(node) &&
                        ts.isBinaryExpression(node.expression) &&
                        names.includes(node.expression.left.getText(ast)))
            )
            .map((node) => node.getText(ast))
            .join("\n")
    );
}
const domainCode = compile(
    fs.readFileSync(path.join(root, "src/access/session.ts"), "utf8")
);
function domain() {
    const context = vm.createContext({ window: {} });
    vm.runInContext(domainCode, context);
    let source = "one",
        now = 0,
        next = 0,
        onCancel = null;
    const jobs = new Map(),
        all = [];
    const session = context.window.__ottAccessSession.create({
        cancel(id) {
            jobs.delete(id);
            if (onCancel) onCancel();
        },
        context: () => source,
        now: () => now,
        schedule(fn, delay) {
            jobs.set(++next, { delay, fn });
            all.push(fn);
            return next;
        },
    });
    return {
        all,
        cancelHook(value) {
            onCancel = value;
        },
        jobs,
        now(value) {
            now = value;
        },
        session,
        source(value) {
            source = value;
        },
    };
}
function fixture() {
    const dom = new JSDOM(
        '<div id="dialogbox" style="display:none"></div><div id="list_window"></div>',
        { runScripts: "outside-only" }
    );
    const w = dom.window,
        jobs = new Map(),
        notices = [],
        progress = [],
        events = [];
    let next = 0,
        now = 0;
    w.eval(fs.readFileSync(path.join(root, "js/jquery-1.11.1.min.js"), "utf8"));
    w.$.expr.filters.visible = (element) => element.style.display !== "none";
    Object.assign(w, {
        _: (text) => text,
        channels: { 11: { itemId: "one" }, 22: { itemId: "two" } },
        clearTimeout(id) {
            jobs.delete(id);
        },
        keys: {
            DOWN: 40,
            ENTER: 13,
            EXIT: 27,
            LEFT: 37,
            RETURN: 8,
            RIGHT: 39,
            UP: 38,
            ...Object.fromEntries(
                Array.from({ length: 10 }, (_, d) => ["N" + d, 100 + d * 3])
            ),
        },
        p_pref: "source-a",
        parentalArray: [11],
        parentPIN: "2468",
        providerGetItem: () => null,
        providerSetItem() {},
        setTimeout(fn, delay) {
            jobs.set(++next, { delay, fn });
            return next;
        },
        showPage() {},
        showShift(text) {
            (text === "Loading. Please wait..." ? progress : notices).push(
                text
            );
        },
        sPSchannels: 1,
        sPSoptions: 1,
        sPSprovs: 1,
    });
    w.Date.now = () => now;
    require("./helpers/screen-runtime.cjs")(w);
    require("./helpers/access-runtime.cjs")(w);
    w.eval(
        functions("src/channels/index.ts", [
            "_enterPinCode",
            "enterPinCode",
            "setParentAccess",
            "enterPinAndSetAccess",
            "hasParentalLock",
            "ifParentalAccess",
            "ifParentalAccessChId",
        ])
    );
    w._doKey = (code) =>
        w.__ottClassicScreenPort.dispatch(code, null, () => {});
    const settlePin = require("./helpers/protected-pin-fixture.cjs")(
        w,
        "2468",
        () => {
            for (const [id, job] of [...jobs]) {
                if (job.delay !== 0) continue;
                jobs.delete(id);
                job.fn();
            }
        }
    );
    return {
        async answer(value = "2468") {
            for (const digit of value) w._doKey(w.keys["N" + digit]);
            await settlePin();
        },
        dom,
        events,
        flushDeferred() {
            for (const [id, job] of [...jobs]) {
                if (job.delay !== 0) continue;
                jobs.delete(id);
                job.fn();
            }
        },
        jobs,
        notices,
        now(value) {
            now = value;
        },
        progress,
        request() {
            w.enterPinAndSetAccess(() => events.push("accepted"));
            return w.dialogBoxKeyHandler;
        },
        w,
    };
}
function ui(name, run) {
    check(name, async () => {
        const f = fixture();
        try {
            await run(f);
        } finally {
            f.dom.window.close();
        }
    });
}
check(
    "renewed grant owns exactly one hour; escaped old expiry cannot revoke it",
    () => {
        const f = domain();
        assert.equal(f.session.grant(true), true);
        f.now(1800000);
        assert.equal(f.session.grant(true), true);
        assert.equal(f.jobs.size, 1);
        f.all[0]();
        assert.equal(f.session.allowed(), true);
        f.now(5399999);
        assert.equal(f.session.allowed(), true);
        f.now(5400000);
        assert.equal(f.session.allowed(), false);
    }
);
check(
    "source transition revokes authorization and an old challenge permanently",
    () => {
        const f = domain();
        f.session.grant(true);
        const old = f.session.begin();
        f.source("two");
        assert.equal(old.complete(), false);
        assert.equal(f.session.allowed(), false);
        assert.equal(f.jobs.size, 0);
        f.source("one");
        assert.equal(old.active(), false);
    }
);
check(
    "only the newest challenge may complete and its completion is one-shot",
    () => {
        const f = domain(),
            old = f.session.begin(),
            current = f.session.begin();
        old.cancel();
        assert.equal(old.complete(), false);
        assert.equal(current.complete(), true);
        assert.equal(current.complete(), false);
    }
);
check(
    "expiry cleanup reentry cannot let the outer grant replace a newer request",
    () => {
        const f = domain();
        f.session.grant(true);
        let ticket;
        f.cancelHook(() => {
            f.cancelHook(null);
            f.source("two");
            ticket = f.session.begin();
        });
        assert.equal(f.session.grant(true), false);
        assert.equal(f.session.allowed(), false);
        assert.equal(ticket.complete(), true);
        assert.equal(f.jobs.size, 0);
    }
);
ui(
    "real public PIN entry authorizes once and repeated escaped input is inert",
    async (f) => {
        const old = f.request();
        await f.answer();
        old(f.w.keys.N2);
        assert.deepEqual(f.events, ["accepted"]);
        assert.deepEqual(f.progress, ["Loading. Please wait..."]);
        assert.equal(f.w.parentAccess, true);
        assert.equal(f.w.dialogBoxKeyHandler, null);
        assert.equal(f.jobs.size, 1);
    }
);
ui(
    "wrong PIN and cancel do not grant or replay; disabled PIN bypasses policies",
    async (f) => {
        f.request();
        await f.answer("0000");
        assert.equal(f.w.parentAccess, false);
        assert.equal(f.notices.length, 1);
        f.request();
        f.w._doKey(f.w.keys.RETURN);
        assert.equal(f.notices.length, 1);
        assert.deepEqual(f.events, []);
        f.w.parentPIN = "*";
        for (const scope of ["channels", "settings", "providers", "control"])
            assert.equal(f.w.__ottParental.needs(scope), false);
    }
);
for (const outcome of ["accepted", "cancelled", "denied"])
    ui(
        "optional PIN rejection settles only " + outcome + " once",
        async (f) => {
            f.w.enterPinAndSetAccess(
                () => f.events.push("accepted"),
                () => f.events.push("rejected")
            );
            const stale = f.w.dialogBoxKeyHandler;
            if (outcome === "cancelled") f.w._doKey(f.w.keys.RETURN);
            else await f.answer(outcome === "accepted" ? "2468" : "0000");
            for (const digit of "2468") stale(f.w.keys["N" + digit]);
            f.flushDeferred();
            assert.deepEqual(f.events, [
                outcome === "accepted" ? outcome : "rejected",
            ]);
            assert.equal(f.w.parentAccess, outcome === "accepted");
            assert.equal(f.notices.length, outcome === "denied" ? 1 : 0);
        }
    );
ui(
    "a replaced PIN rejects only after the replacement owns the foreground",
    async (f) => {
        const port = f.w.__ottClassicScreenPort;
        let replacement;
        f.w.enterPinAndSetAccess(
            () => f.events.push("accepted"),
            () => {
                assert.equal(port.screens.current(), replacement.owner);
                assert.equal(replacement.owner.foreground(), true);
                f.events.push("rejected");
            }
        );
        const old = f.w.dialogBoxKeyHandler;
        replacement = port.setOwnedCallback("dialog", () =>
            f.events.push("new")
        );
        assert.deepEqual(
            f.events,
            [],
            "old cleanup cannot reenter a replacement"
        );
        f.flushDeferred();
        for (const digit of "2468") old(f.w.keys["N" + digit]);
        assert.deepEqual(f.events, ["rejected"]);
        replacement(f.w.keys.ENTER);
        assert.deepEqual(f.events, ["rejected", "new"]);
        assert.equal(f.w.parentAccess, false);
    }
);
for (const change of ["source", "pin", "policy", "storage"])
    ui(
        "optional rejection cannot grant a stale " + change + " challenge",
        async (f) => {
            f.w.enterPinAndSetAccess(
                () => f.events.push("accepted"),
                () => f.events.push("rejected")
            );
            const old = f.w.dialogBoxKeyHandler;
            await f.answer("24");
            if (change === "source") f.w.p_pref = "source-b";
            if (change === "pin") f.w.parentPIN = "9999";
            if (change === "policy") f.w.sPSoptions = 0;
            if (change === "storage") f.w.providerGetItem = () => null;
            await f.answer("68");
            f.flushDeferred();
            old(f.w.keys.N8);
            assert.deepEqual(f.events, ["rejected"]);
            assert.equal(f.w.parentAccess, false);
        }
    );
ui(
    "replacement during PIN completion rejects the old grant and preserves the new challenge",
    async (f) => {
        const port = f.w.__ottClassicScreenPort;
        f.w.enterPinAndSetAccess(
            () => f.events.push("old accepted"),
            () => f.events.push("old rejected")
        );
        port.screens.current().own(() => {
            f.w.enterPinAndSetAccess(() => f.events.push("new accepted"));
        });
        await f.answer();
        f.flushDeferred();
        assert.deepEqual(f.events, ["old rejected"]);
        assert.equal(f.w.parentAccess, false);
        await f.answer();
        assert.deepEqual(f.events, ["old rejected", "new accepted"]);
        assert.equal(f.w.parentAccess, true);
    }
);
for (const change of ["source", "pin", "policy", "storage"])
    ui(
        change + " change during PIN rejects old completion and authorization",
        async (f) => {
            f.request();
            await f.answer("24");
            if (change === "source") f.w.p_pref = "source-b";
            if (change === "pin") f.w.parentPIN = "9999";
            if (change === "policy") f.w.sPSoptions = 0;
            if (change === "storage") f.w.providerGetItem = () => null;
            await f.answer("68");
            assert.equal(f.w.parentAccess, false);
            assert.deepEqual(f.events, []);
            assert.equal(f.w.dialogBoxKeyHandler, null);
        }
    );
for (const field of [
    "parentPin",
    "psChannels",
    "psOptions",
    "requirePinForProviderSelection",
])
    ui(
        "actual SettingsStore " +
            field +
            " ABA retires its challenge and grant",
        async (f) => {
            f.w.eval(
                compile(
                    fs.readFileSync(
                        path.join(root, "src/settings/store.ts"),
                        "utf8"
                    )
                )
            );
            const defaults = {
                fontSize: 1,
                parentPin: "2468",
                psChannels: 1,
                psOptions: 1,
                requirePinForProviderSelection: 1,
            };
            const store = f.w.createSettingsStore(
                Object.entries(defaults).map(([id, value]) => ({
                    defaultValue: value,
                    effects: [],
                    id,
                    key: id,
                    scope: "application",
                    validate: () => true,
                })),
                {
                    context: () => "one",
                    effect() {},
                    storage: () => ({
                        read: () => null,
                        remove() {},
                        write() {},
                    }),
                }
            );
            f.w.settingsStore = store;
            f.w.setParentAccess(true, () => {});
            f.request();
            store.observe(field, field === "parentPin" ? "9999" : 0);
            store.observe(field, defaults[field]);
            await f.answer();
            assert.equal(f.w.parentAccess, false);
            assert.deepEqual(f.events, []);
            f.request();
            store.observe("fontSize", 3);
            await f.answer();
            assert.equal(
                f.w.parentAccess,
                true,
                "unrelated settings do not revoke the challenge"
            );
            assert.deepEqual(f.events, ["accepted"]);
        }
    );
ui(
    "canonical SettingsStore policy controls gates and revokes changed grants",
    async (f) => {
        f.w.settings = {
            psChannels: 1,
            psOptions: 1,
            requirePinForProviderSelection: 1,
        };
        f.w.setParentAccess(true, () => {});
        f.w.settings.psChannels = 0;
        assert.equal(f.w.__ottParental.needs("channels"), false);
        assert.equal(f.w.parentAccess, false);
        assert.equal(f.w.__ottParental.needs("settings"), true);
    }
);
ui(
    "PIN config and source changes revoke an existing grant without waiting for timeout",
    async (f) => {
        f.w.setParentAccess(true, () => {});
        assert.equal(f.w.parentAccess, true);
        f.w.parentPIN = "9999";
        assert.equal(f.w.parentAccess, false);
        f.w.setParentAccess(true, () => {});
        f.w.p_pref = "source-b";
        assert.equal(f.w.parentAccess, false);
    }
);
ui(
    "replacing the parent settings list revokes its PIN owner and saved handler",
    async (f) => {
        const port = f.w.__ottClassicScreenPort;
        f.w.listArray = [1];
        f.w.listDataArray = f.w.listArray;
        port.commitList();
        const old = f.request();
        f.w.listArray = [2];
        f.w.listDataArray = f.w.listArray;
        port.commitList();
        for (const digit of "2468") old(f.w.keys["N" + digit]);
        assert.deepEqual(f.events, []);
        assert.equal(f.w.parentAccess, false);
    }
);
ui(
    "replacing PIN screen with another dialog cannot consume or close its handler",
    async (f) => {
        const old = f.request();
        const next = f.w.__ottClassicScreenPort.setOwnedCallback("dialog", () =>
            f.events.push("other")
        );
        for (const digit of "2468") old(f.w.keys["N" + digit]);
        assert.equal(f.w.dialogBoxKeyHandler, next);
        next(13);
        assert.deepEqual(f.events, ["other"]);
    }
);
ui("escaped digit buttons cannot send input to the new screen", async (f) => {
    f.request();
    const button = f.w.document.querySelector("#k2 .btn");
    const old = button.onclick;
    f.w.__ottClassicScreenPort.invalidate();
    f.w.__ottClassicScreenPort.setOwnedCallback("dialog", () =>
        f.events.push("new")
    );
    old();
    button.click();
    assert.deepEqual(f.events, []);
});
ui(
    "dialog disposal reentry cannot grant in a replacement source",
    async (f) => {
        f.request();
        f.w.__ottClassicScreenPort.owner("dialog").own(() => {
            f.w.p_pref = "source-b";
        });
        await f.answer();
        assert.equal(f.w.parentAccess, false);
        assert.deepEqual(f.events, []);
    }
);
ui(
    "selected lock command keeps its captured channel when list focus changes",
    async (f) => {
        const w = f.w;
        w.__ottChannels = {
            change(...args) {
                f.events.push(args);
            },
        };
        w.listArray = [11, 22];
        w.selIndex = 0;
        w.eval(functions("src/index.ts", ["window.parentChannel"]));
        w.parentChannel();
        w.selIndex = 1;
        await f.answer();
        assert.deepEqual(f.events, [["lock", 11, false]]);
    }
);
ui(
    "channel access cannot replay a removed/replaced row with the same numeric ID",
    async (f) => {
        assert.equal(
            f.w.ifParentalAccessChId(11, () => f.events.push("play")),
            true
        );
        f.w.channels[11] = { itemId: "other" };
        await f.answer();
        assert.deepEqual(f.events, []);
    }
);
ui(
    "live command after PIN relocates its original channel after category reordering",
    async (f) => {
        const w = f.w;
        Object.assign(w, {
            cats: { A: [11, 22], B: [22] },
            catsArray: ["A", "B"],
            console: { log() {} },
            playChannel: (c, i) => f.events.push([c, i]),
        });
        w.eval(functions("src/index.ts", ["_playChannel"]));
        w._playChannel(0, 0);
        w.catsArray = ["B", "A"];
        w.cats.A = [22, 11];
        await f.answer();
        assert.deepEqual(f.events, [[1, 1]]);
    }
);
ui(
    "preview's delayed decoder callback is invalidated by a source change",
    async (f) => {
        const w = f.w;
        Object.assign(w, {
            getChannelUrl: (id) => String(id),
            previewChan: null,
            sPSchannels: 0,
            stbPlay: (url) => f.events.push(url),
        });
        w.eval(functions("src/index.ts", ["window.previewChId"]));
        w.previewChId(11);
        const pending = [...f.jobs.values()].find((job) => job.delay === 500);
        assert(pending);
        w.p_pref = "source-b";
        pending.fn();
        assert.deepEqual(f.events, []);
    }
);
ui(
    "provider selection executes once, then its new source has no inherited grant",
    async (f) => {
        const w = f.w,
            stored = { ottplayprov: "a" };
        Object.assign(w, {
            isProviderAllowed: () => true,
            loadProv() {
                f.events.push("loaded");
                w.p_pref = "b";
            },
            providerIds: ["a", "b"],
            stbGetItem: (key) => stored[key],
            stbSetItem: (key, value) => {
                stored[key] = value;
            },
        });
        w.eval(functions("src/provider/index.ts", ["selectProviderByIndex"]));
        assert.equal(w.selectProviderByIndex(1), false);
        await f.answer();
        assert.equal(stored.ottplayprov, "b");
        assert.deepEqual(f.events, ["loaded"]);
        assert.equal(w.parentAccess, false);
    }
);
(async () => {
    for (const run of cases) await run();
    console.log(
        "OK: " +
            passed +
            " owned access/PIN scenarios; compiled private domain is ES5"
    );
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
