"use strict";
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const privateRuntime = require("./private-runtime.cjs");
function fixture(initial = {}) {
    const saved = new Map(Object.entries(initial));
    const calls = [],
        requests = [],
        errors = [],
        edits = [];
    let reloads = 0;
    const host = {
        _: (value) => value,
        // Explicit publication port; GuideService itself is covered by guide integration.
        __ottClassicGuide: {
            invalidateChannel(id) {
                calls.push(["guide-invalidated", id]);
            },
            seed(id, rows) {
                if (!host.epg) host.epg = {};
                host.epg[id] = JSON.parse(JSON.stringify(rows));
            },
        },
        alert: (message) => errors.push(message),
        browserName: () => "browser",
        btnDiv: () => "",
        cats: {},
        catsArray: [],
        chanels: {},
        checkProviderUrl: () => true,
        cList: [],
        host: "https://relay.test",
        keys: { ENTER: 13, RETURN: 27 },
        launch_id: "#launch",
        listCaption: {},
        listDetail: {},
        listPodval: {},
        loadChannels: () => reloads++,
        noProvParam() {},
        popupActions: [],
        popupArray: [],
        popupDetail: [],
        popupList: (index) => calls.push(["popup", index]),
        showEditKey: (key, password) => edits.push({ key, password }),
        showPage() {},
        stbDelItem: (key) => saved.delete(key),
        stbGetItem: (key) => (saved.has(key) ? saved.get(key) : null),
        stbSetItem: (key, value) => saved.set(key, String(value)),
        strRETURN: "Return",
    };
    const jquery = () => ({ append() {}, hide() {} });
    const ajax = (settings) => {
        let done, fail;
        const request = {
            abort() {
                this.aborts++;
                if (fail) fail();
            },
            aborts: 0,
            done(callback) {
                done = callback;
                return this;
            },
            fail(callback) {
                fail = callback;
                return this;
            },
            reject(...args) {
                fail(...args);
            },
            // Intentionally uncooperative: callbacks can still arrive after abort.
            resolve(value) {
                done(value);
            },
            settings,
        };
        requests.push(request);
        calls.push(settings.url);
        return request;
    };
    jquery.ajax = ajax;
    host.$ = jquery;
    host.window = host;
    vm.createContext(host);
    vm.runInContext(
        ts
            .transpileModule(
                fs.readFileSync(
                    path.join(__dirname, "../../src/settings/store.ts"),
                    "utf8"
                ),
                {
                    compilerOptions: {
                        module: ts.ModuleKind.ES2015,
                        target: ts.ScriptTarget.ES5,
                    },
                }
            )
            .outputText.replace(/^export /gm, ""),
        host
    );
    require("./shared-core-runtime.cjs")(host, { vendorOnly: true });
    privateRuntime(host, "src/provider/runtime.ts");
    privateRuntime(host, "src/provider/driver-profiles.ts");
    privateRuntime(host, "src/provider/channel-catalog.ts");
    require("./access-runtime.cjs")(host);
    privateRuntime(host, "src/provider/stalker-driver.ts");
    privateRuntime(host, "src/provider/catalog-drivers.ts");
    privateRuntime(host, "src/provider/catalog-xml.ts");
    privateRuntime(host, "src/provider/media-catalog.ts");
    privateRuntime(host, "src/provider/playlist-drivers.ts");
    privateRuntime(host, "src/provider/edem-driver.ts");
    privateRuntime(host, "src/provider/m3u-settings.ts");
    privateRuntime(host, "src/provider/m3u-driver.ts");
    privateRuntime(host, "src/provider/vportal-driver.ts");
    privateRuntime(host, "src/plugins/plex.ts");
    privateRuntime(host, "src/plugins/plex-auth.ts");
    privateRuntime(host, "src/provider/plex-driver.ts");
    privateRuntime(host, "src/provider/drivers.ts");
    privateRuntime(host, "src/provider/xtream-media.ts");
    // The checked-in identity codec is shared with existing channel bookmarks.
    const encoding = fs.readFileSync(
        path.join(__dirname, "../../src/utils/encoding.ts"),
        "utf8"
    );
    vm.runInContext(
        ts
            .transpileModule(encoding, {
                compilerOptions: {
                    module: ts.ModuleKind.ES2015,
                    target: ts.ScriptTarget.ES5,
                },
            })
            .outputText.replace(/^export /gm, ""),
        host
    );
    require("./english-source-fixture.cjs").attachSourceAliases(host);
    const lifetime = host.__ottProviderRuntime.createRegistry();
    function mount(id) {
        return host.__ottProviderDrivers.mount(host, id, lifetime.activate(id));
    }
    return {
        ajax,
        calls,
        edits,
        errors,
        host,
        lifetime,
        mount,
        get reloads() {
            return reloads;
        },
        requests,
        saved,
    };
}
function integrationFixture(id, initial = {}) {
    const f = fixture({
        ottplayprov: id,
        xtreamxtream_data: JSON.stringify({
            password: "x?&",
            server: "https://xc.test/folder",
            username: "a/b",
        }),
        ...initial,
    });
    const w = f.host;
    const scripts = [],
        timers = new Map();
    const panels = Object.create(null);
    const deadlines = new Map();
    let now = 0;
    let nextTimer = 0,
        completed = 0,
        ajaxWrites = 0;
    let ajax = w.$.ajax;
    Object.defineProperty(w.$, "ajax", {
        get: () => ajax,
        set(value) {
            ajaxWrites++;
            ajax = value;
        },
    });
    const jquery = w.$;
    const hostQuery = (selector) => {
        const panel =
            panels[selector] ||
            (panels[selector] = {
                visible: selector === "#launch",
            });
        const chain = {
            append() {
                return chain;
            },
            attr() {
                return chain;
            },
            css() {
                return chain;
            },
            hide() {
                selector.split(",").forEach((name) => {
                    const target = panels[name] || (panels[name] = {});
                    target.visible = false;
                });
                return chain;
            },
            html(value) {
                panel.html = value;
                return chain;
            },
            is: () => panel.visible,
            on() {
                return chain;
            },
            show() {
                panel.visible = true;
                return chain;
            },
        };
        return chain;
    };
    Object.defineProperty(hostQuery, "ajax", {
        get: () => jquery.ajax,
        set(value) {
            jquery.ajax = value;
        },
    });
    w.$ = hostQuery;
    Object.assign(w, {
        __av: "test",
        __cv: "test",
        beginPortChannelIdMigration() {},
        cancelMediaLoad() {},
        cancelPortChannelIdMigration() {},
        clearTimeout: (id) => timers.delete(id),
        closeList() {},
        console: {
            error: (error) => {
                throw error;
            },
            log() {},
            warn() {},
        },
        delOption() {},
        document: {
            createTextNode: (value) => value,
            getElementById: () => null,
        },
        edit_dealer() {},
        epgCash: 0,
        finishPortChannelIdMigration() {},
        firstRun: () => {
            throw new Error("unexpected firstRun");
        },
        getDefaultPlayerMode: () => 0,
        getScriptDOM: (url, ready) => scripts.push({ ready, url }),
        host: "https://player.test",
        invalidateEpgCache() {},
        location: { href: "https://player.test/index.html", search: "" },
        normalizePlayerMode: (value) => value,
        onChanelsLoaded: () => completed++,
        optIndexOf: () => -1,
        optionsArr: [],
        optionsList() {},
        providerGetJson: (key, fallback) => {
            const value = w.providerGetItem(key);
            return value === null ? fallback : JSON.parse(value);
        },
        providerGetNum: (key, fallback) => {
            const value = w.providerGetItem(key);
            return value === null ? fallback : Number(value);
        },
        restoreDemoMute() {},
        savedPopup: {
            popupActions: [w.noProvParam, () => {}, w.optionsList],
            popupArray: ["", "", "Settings"],
            popupDetail: ["", "", "Settings"],
            ver: "test",
        },
        selectProvaider() {},
        setPlayerMode() {},
        setTimeout: (callback, delay = 0) => {
            const id = ++nextTimer;
            timers.set(id, callback);
            deadlines.set(id, now + delay);
            return id;
        },
        stbIsPlaying: () => false,
    });
    w.storage = {
        del: (key) => f.saved.delete(key),
        get: (key) => f.saved.get(key) ?? null,
        set: (key, value) => f.saved.set(key, String(value)),
        setI: (key, value) => f.saved.set(key, String(value)),
    };
    vm.runInContext(
        require("./settings-source-fixture.cjs").settingsSource(),
        w
    );
    const file = path.join(__dirname, "../../src/provider/index.ts");
    const source = ts.createSourceFile(
        file,
        fs.readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true
    );
    const names = [
        "loadProv",
        "loadChannels",
        "syncFromWindow",
        "isProviderAllowed",
        "isPlayDistribution",
        "checkProviderUrl",
    ];
    const functions = source.statements
        .filter(
            (node) =>
                ts.isFunctionDeclaration(node) &&
                names.includes(node.name?.text)
        )
        .map((node) => node.getText(source).replace(/^export /, ""));
    functions.unshift(
        'var providerDistribution = "full", providerIds = window.__ottProviderDrivers.registry.ids().concat(["m3u"]);'
    );
    vm.runInContext(
        ts.transpileModule(functions.join("\n"), {
            compilerOptions: {
                module: ts.ModuleKind.None,
                target: ts.ScriptTarget.ES5,
            },
        }).outputText,
        w
    );
    require("./english-source-fixture.cjs").attachSourceAliases(w);
    return {
        ...f,
        advanceTimers(milliseconds) {
            const until = now + milliseconds;
            for (;;) {
                const next = [...timers.keys()].sort(
                    (a, b) => deadlines.get(a) - deadlines.get(b)
                )[0];
                if (next === undefined || deadlines.get(next) > until) break;
                now = deadlines.get(next);
                const callback = timers.get(next);
                timers.delete(next);
                deadlines.delete(next);
                callback();
            }
            now = until;
        },
        get ajaxWrites() {
            return ajaxWrites;
        },
        get completed() {
            return completed;
        },
        panels,
        scripts,
        timers,
    };
}

module.exports = { fixture, integrationFixture };
