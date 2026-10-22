const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { localizationRuntime } = require("./localization-runtime.cjs");
const privateRuntime = require("./private-runtime.cjs");
const {
    sourceNames,
    attachSourceAliases,
} = require("./english-source-fixture.cjs");
const root = path.resolve(__dirname, "../..");
const functionNames = sourceNames("src/channels/index.ts", [
    "usesNativeXmltv",
    "channelXmltvUrls",
    "epgTimezoneHours",
    "epgArchiveHours",
    "applyChannelTvgShift",
    "fetchChannelGuide",
    "getChannelEpgCached",
    "getCachedChannelEpg",
    "getEpgFromCache",
    "getCurProgData",
    "setCurProg",
    "invalidateEpgCache",
    "loadEpgTimers",
    "startEpgTimer",
    "setEpgTimer",
    "publishGuideReminders",
    "loadEpgListData",
    "epgList",
    "epgListAlpha",
    "recordsList",
    "openSelectedChannelRecordings",
    "bucketsKeyHandler",
    "renderGuideView",
    "renderCategoryRecordings",
    "formatEpgTime",
    "renderEpgHTML",
    "renderEpgFooter",
    "itemEPG",
    "detailEPG",
    "epgKeyHandler",
    "selectEpg",
    "searchEpgByTitle",
]);
const source =
    fs.readFileSync(path.join(root, "src/channels/index.ts"), "utf8") +
    "\n" +
    fs.readFileSync(path.join(root, "src/channels/render-helpers.ts"), "utf8");
const ast = ts.createSourceFile(
    "channels.ts",
    source,
    ts.ScriptTarget.Latest,
    true
);
const nodes = ast.statements.filter(
    (n) => ts.isFunctionDeclaration(n) && functionNames.includes(n.name?.text)
);
assert.equal(nodes.length, functionNames.length);
const code = ts.transpileModule(
    nodes.map((n) => n.getText(ast).replace(/^export\s+/, "")).join("\n"),
    {
        compilerOptions: {
            module: ts.ModuleKind.None,
            target: ts.ScriptTarget.ES5,
        },
    }
).outputText;
module.exports = function guideFixture(options = {}) {
    const independent = options.independentClock === true;
    const minimumDelay = Math.max(0, Number(options.minimumDelay) || 0);
    let seconds = options.now || 10000,
        timerId = 0,
        epochMs = seconds * 1000,
        elapsedMs = 0;
    const timers = new Map(),
        requests = [],
        prompts = [],
        calls = [],
        saved = new Map(Object.entries(options.saved || {})),
        elements = {};
    const channel = {
        channel_name: "Station A",
        epg: "route-a",
        itemId: "station:a",
        rec: 48,
    };
    const channelB = {
        channel_name: "Station B",
        epg: "route-b",
        itemId: "station:b",
        rec: 48,
    };
    function query(selector) {
        const el = elements[selector] || (elements[selector] = {});
        const chain = {
            hide() {
                el.visible = false;
                return chain;
            },
            html(value) {
                el.html = value;
                return chain;
            },
            is() {
                return !!el.visible;
            },
            show() {
                el.visible = true;
                return chain;
            },
            text(value) {
                el.text = value;
                return chain;
            },
        };
        return chain;
    }
    const host = vm.createContext({
        _: (x) => x,
        __ottClassicPlayback: {
            guard(callback) {
                const source = host.p_pref;
                return () => {
                    if (source === host.p_pref) callback();
                };
            },
        },
        $: query,
        catIndex: 0,
        cats: { All: [1, 2], Group: [1] },
        catsArray: ["All", "Group"],
        channels: { 1: channel, 2: channelB },
        clearTimeout(id) {
            timers.delete(id);
        },
        closeList() {
            calls.push(["close"]);
            host.__ottClassicGuideScreen.close();
        },
        confirmBox(text, yes, no) {
            const handler = () => {};
            host.dialogBoxKeyHandler = handler;
            prompts.push({ handler, no, text, yes });
        },
        console,
        curEpgData: null,
        curList: [1, 2],
        Date: class extends Date {
            constructor(...args) {
                if (independent && args.length === 0) super(epochMs);
                else super(...args);
            }
            static now() {
                return independent ? epochMs : seconds * 1000;
            }
        },
        document: {
            getElementById(id) {
                return (
                    elements[id] ||
                    (elements[id] = { innerHTML: "", style: {} })
                );
            },
        },
        epg: {},
        epg_ch_id: null,
        epgCacheByChannel: {},
        epgCacheCapacity: 10,
        epgListMode: 0,
        epgTimers: [],
        getChannelEpg(id, complete) {
            const request = { aborts: 0, complete, id };
            requests.push(request);
            return () => {
                request.aborts++;
                if (request.onCancel) request.onCancel();
            };
        },
        ifParentalAccessChId(id, accept) {
            if (options.pin) {
                calls.push(["pin", id]);
                prompts.push({ pin: true, yes: accept });
                return true;
            }
            return false;
        },
        infoBox(text) {
            calls.push(["info", text]);
        },
        jQuery: query,
        keys: {
            ENTER: 13,
            EXIT: 8,
            PAUSE: 19,
            PLAY: 415,
            PRECH: 18,
            RED: 403,
            RETURN: 27,
        },
        listArray: [],
        listCatIndex: 0,
        listChannel: 0,
        listEpgArray: [],
        metadataCssUrl: (value) => String(value || ""),
        metadataHtml: (value) => String(value || ""),
        metadataText(value) {
            return String(value ?? "")
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;");
        },
        p_pref: "provider-a",
        playArchive(start) {
            calls.push(["archive", start]);
        },
        playChannel(c, i) {
            calls.push(["play", host.cats[host.catsArray[c]][i]]);
        },
        playTime: 0,
        playType: 0,
        primaryIndex: 0,
        providerGetItem(key) {
            return saved.has(host.p_pref + ":" + key)
                ? saved.get(host.p_pref + ":" + key)
                : null;
        },
        providerScopedStorageKeys: [],
        providerSetItem(key, value) {
            saved.set(host.p_pref + ":" + key, value);
        },
        renderButtonHint: () => "",
        sEpgRemindMinutes: 1,
        selIndex: 0,
        setCurrent(c, i, archive) {
            calls.push(["select", host.cats[host.catsArray[c]][i], archive]);
        },
        setTimeout(fn, ms) {
            const id = ++timerId;
            const delay = Math.max(minimumDelay, Number(ms) || 0);
            timers.set(
                id,
                independent
                    ? { delay, due: elapsedMs + delay, fn, interval: false }
                    : {
                          at: seconds + delay / 1000,
                          fn,
                      }
            );
            return id;
        },
        settings: { epgRemindMinutes: 1 },
        showPage() {
            calls.push(["page", host.epg_ch_id]);
        },
        showProgramInfo(text) {
            calls.push(["description", text]);
        },
        showShift(text) {
            calls.push(["shift", text]);
        },
        sNextCount: 1,
        stbGetItem(key) {
            return saved.has(key) ? saved.get(key) : null;
        },
        stbSetItem(key, value) {
            saved.set(key, value);
        },
    });
    host.window = host;
    host.epgCache = host.epg;
    if (independent) {
        host.setInterval = function (fn, ms) {
            const id = ++timerId;
            const delay = Math.max(1, Number(ms) || 0);
            timers.set(id, {
                delay,
                due: elapsedMs + delay,
                fn,
                interval: true,
            });
            return id;
        };
        host.clearInterval = function (id) {
            timers.delete(id);
        };
    }
    host.epgCacheByChannel = host.epg;
    vm.runInContext(
        fs.readFileSync(path.join(root, "vendor/ottplay-core.js"), "utf8"),
        host
    );
    if (!host.__ottSourceIdentity)
        privateRuntime(host, "src/provider/source-identity.ts");
    for (const name of [
        "service",
        "reminders",
        "screen",
        "classic-service",
        "classic-screen",
        "classic-reminders",
    ])
        privateRuntime(host, "src/guide/" + name + ".ts");
    vm.runInContext(localizationRuntime(), host);
    vm.runInContext(code, host);
    attachSourceAliases(host);
    function dueIndependent(limit) {
        return [...timers]
            .filter(([, timer]) => timer.due <= limit)
            .sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
    }
    function fireIndependent(entry) {
        const timer = entry[1];
        if (timer.interval) timer.due += timer.delay;
        else timers.delete(entry[0]);
        timer.fn();
    }
    function advanceElapsed(ms) {
        if (!independent) throw Error("independent clock required");
        const target = elapsedMs + ms;
        const started = elapsedMs;
        const startedEpoch = epochMs;
        let count = 0;
        while (true) {
            const due = dueIndependent(target);
            if (!due) break;
            assert(++count < 250, "timer loop converges");
            elapsedMs = due[1].due;
            epochMs = startedEpoch + (elapsedMs - started);
            fireIndependent(due);
        }
        elapsedMs = target;
        epochMs = startedEpoch + ms;
    }
    function tick(next = seconds) {
        if (independent) {
            let count = 0;
            while (dueIndependent(elapsedMs)) {
                assert(++count < 250, "timer loop converges");
                fireIndependent(dueIndependent(elapsedMs));
            }
            return;
        }
        let count = 0;
        while (true) {
            const due = [...timers]
                .filter(([, t]) => t.at <= next)
                .sort((a, b) => a[1].at - b[1].at)[0];
            if (!due) break;
            assert(++count < 250, "timer loop converges");
            seconds = due[1].at;
            timers.delete(due[0]);
            due[1].fn();
        }
        seconds = next;
    }
    function complete(rows, index = requests.length - 1) {
        requests[index].complete(requests[index].id, rows);
        tick();
    }
    function row(
        start = seconds - 10,
        end = seconds + 100,
        title = "Programme",
        id
    ) {
        return {
            descr: "Description",
            name: title,
            time: start,
            time_to: end,
            ...(id === undefined ? {} : { id }),
        };
    }
    return {
        advanceElapsed,
        calls,
        complete,
        elapsed: () => elapsedMs,
        elements,
        epoch: () => epochMs / 1000,
        host,
        now: () => seconds,
        prompts,
        requests,
        row,
        saved,
        setEpoch(value) {
            if (!independent) throw Error("independent clock required");
            epochMs = value * 1000;
        },
        tick,
        timers,
    };
};

module.exports.install = function (host) {
    for (const [key, value] of Object.entries({
        curEpgData: null,
        epg: {},
        epg_ch_id: null,
        epgListMode: 0,
        epgTimers: [],
        listEpgArray: [],
        sNextCount: 1,
    }))
        if (host[key] === undefined) host[key] = value;
    host.epgCache = host.epg;
    host.epgCacheByChannel = host.epg;
    if (!host.__ottSourceIdentity)
        privateRuntime(host, "src/provider/source-identity.ts");
    for (const name of [
        "service",
        "reminders",
        "screen",
        "classic-service",
        "classic-screen",
        "classic-reminders",
    ])
        privateRuntime(host, "src/guide/" + name + ".ts");
    vm.runInContext(code, host);
    attachSourceAliases(host);
};
