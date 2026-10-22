const assert = require("node:assert/strict");
const test = require("node:test");
const {
    fixture: createFixture,
    integrationFixture,
} = require("./helpers/provider-driver-fixture.cjs");
function fixture(initial) {
    const f = createFixture(initial);
    f.host.setTimeout = setTimeout;
    f.host.clearTimeout = clearTimeout;
    return f;
}

test("restored local folder leaves the boot splash before its catalog resolves", async () => {
    const f = integrationFixture("offline");
    let resolveCatalog;
    let bootReleased = 0;
    f.host.clearBootHide = () => bootReleased++;
    f.host.__ottLocalMedia = {
        list: () =>
            new Promise((resolve) => {
                resolveCatalog = resolve;
            }),
    };
    f.host.loadProv();
    assert.equal(bootReleased, 1);
    assert.equal(f.panels["#launch"].visible, false);
    assert.equal(f.panels["#dialogbox"].visible, true);
    assert.match(f.panels["#dialogbox"].html, /ott-spinner/);
    assert.equal(f.completed, 0);
    assert.equal(f.host.commandChannelsReady, false);
    resolveCatalog({
        items: [{ id: "saved", name: "Saved.mp4", url: "blob:saved" }],
    });
    await Promise.resolve();
    assert.equal(f.completed, 1);
    assert.equal(f.panels["#dialogbox"].visible, false);
    assert.equal(f.host.commandChannelsReady, true);
});

test("local startup loading retires cleanly when another provider wins", async () => {
    const f = integrationFixture("offline");
    let resolveCatalog;
    f.host.clearBootHide = () => {};
    f.host.__ottLocalMedia = {
        list: () =>
            new Promise((resolve) => {
                resolveCatalog = resolve;
            }),
        open: () => assert.fail("retired catalog reopened local media"),
        resume: () => assert.fail("retired catalog reopened local recovery"),
    };
    f.host.loadProv();
    f.host.loadProv("demo");
    const completed = f.completed;
    resolveCatalog({
        items: [],
        sources: [{ access: "permission-required", id: "old" }],
    });
    await Promise.resolve();
    assert.equal(f.completed, completed);
    assert.equal(f.host.__ottActiveProviderDriver.id, "demo");
    assert.equal(f.panels["#dialogbox"].visible, false);
});

test("stalled local catalog opens recovery after a minute and ignores late completion", async () => {
    const f = integrationFixture("offline");
    let resolveCatalog;
    const recovery = [];
    f.host.clearBootHide = () => {};
    f.host.__ottLocalMedia = {
        list: () =>
            new Promise((resolve) => {
                resolveCatalog = resolve;
            }),
        resume: (skipScan) => recovery.push(skipScan),
    };
    f.host.loadProv();
    f.advanceTimers(59999);
    assert.equal(f.completed, 0);
    assert.deepEqual(recovery, []);
    f.advanceTimers(1);
    assert.equal(f.completed, 1);
    assert.deepEqual(recovery, [true]);
    assert.equal(f.panels["#dialogbox"].visible, false);
    resolveCatalog({
        items: [{ id: "late", name: "Late.mp4", url: "blob:late" }],
    });
    await Promise.resolve();
    assert.equal(f.completed, 1);
    assert.deepEqual(recovery, [true]);
    assert.equal(f.host.__ottActiveProviderDriver.stream("local-late"), "");
});

test("offline provider resolves stable IDs to fresh URLs after reload, without network", async () => {
    const f = fixture();
    let url = "blob:first-session";
    f.host.__ottLocalMedia = {
        list: async () => ({
            items: [{ id: "abc", name: "Tom and Jerry.mp4", url }],
        }),
    };
    const first = f.mount("offline");
    const load = (driver) => new Promise((resolve) => driver.load(resolve));
    let catalog = await load(first);
    assert.deepEqual(Array.from(catalog.ids), ["local-abc"]);
    assert.equal(first.stream("local-abc"), url);
    assert.equal(
        catalog.channels["local-abc"].channel_name,
        "Tom and Jerry.mp4"
    );
    url = "blob:second-session";
    const second = f.mount("offline");
    catalog = await load(second);
    assert.deepEqual(Array.from(catalog.ids), ["local-abc"]);
    assert.equal(second.stream("local-abc"), url);
    assert.equal(first.stream("local-abc"), "");
    assert.equal(f.requests.length, 0);
});

test("unchanged native polling cannot keep a stalled scan alive forever", async () => {
    const f = integrationFixture("offline");
    let progress;
    const recovery = [];
    f.host.__ottLocalMedia = {
        list: (callback) => {
            progress = callback;
            return new Promise(() => {});
        },
        resume: (skipScan) => recovery.push(skipScan),
    };
    f.host.loadProv();
    const stalled = { items: [], scanned: 10, scanning: true };
    progress(stalled);
    f.advanceTimers(30000);
    progress(stalled);
    f.advanceTimers(30000);
    assert.deepEqual(recovery, [true]);
    assert.equal(f.completed, 1);
});

test("offline catalog completion cannot publish after a provider switch", async () => {
    const f = fixture();
    let deliver;
    f.host.__ottLocalMedia = {
        list: () =>
            new Promise((resolve) => {
                deliver = resolve;
            }),
    };
    const driver = f.mount("offline");
    let published = false;
    driver.load(() => {
        published = true;
    });
    f.mount("demo");
    deliver({ items: [{ id: "late", name: "Late.mp4", url: "blob:late" }] });
    await Promise.resolve();
    assert.equal(published, false);
    assert.equal(driver.stream("local-late"), "");
});

test("offline storage failure settles the catalog with an actionable error", async () => {
    const f = fixture();
    const recovery = [];
    f.host.__ottLocalMedia = {
        list: async () => {
            throw new Error("Storage unavailable");
        },
        resume: (skipScan) => recovery.push(skipScan),
    };
    const driver = f.mount("offline");
    const result = await new Promise((resolve) =>
        driver.load((catalog, error) => resolve({ catalog, error }))
    );
    assert.equal(result.error, "Storage unavailable");
    assert.equal(result.catalog.ids.length, 0);
    assert.deepEqual(recovery, [true]);
});

test("empty offline provider opens import after settling the catalog", async () => {
    const f = fixture();
    const events = [];
    f.host.__ottLocalMedia = {
        list: async () => ({ items: [] }),
        open: () => events.push("import"),
    };
    f.mount("offline").load(() => events.push("settled"));
    await Promise.resolve();
    assert.deepEqual(events, ["settled", "import"]);
});

test("empty catalog callback cannot reopen import after provider replacement", async () => {
    const f = fixture();
    let opened = false;
    f.host.__ottLocalMedia = {
        list: async () => ({ items: [] }),
        open: () => {
            opened = true;
        },
    };
    f.mount("offline").load(() => f.mount("demo"));
    await Promise.resolve();
    assert.equal(opened, false);
});

test("unavailable source entries never become playable channels", async () => {
    const f = fixture();
    f.host.__ottLocalMedia = {
        list: async () => ({
            items: [
                {
                    available: false,
                    id: "missing",
                    name: "Missing.mp4",
                    url: "",
                },
                {
                    available: false,
                    id: "denied",
                    name: "Denied.mp4",
                    url: "blob:stale",
                },
                {
                    available: true,
                    id: "ready",
                    name: "Ready.mp4",
                    url: "blob:ready",
                },
            ],
        }),
    };
    const driver = f.mount("offline");
    const catalog = await new Promise((resolve) => driver.load(resolve));
    assert.deepEqual(Array.from(catalog.ids), ["local-ready"]);
    assert.equal(driver.stream("local-denied"), "");
});

// Exercise the real startup callback: a temporarily inaccessible local folder
// must not replace the last selected file with a nonexistent first channel.
function startupFixture(provider) {
    const fs = require("node:fs");
    const vm = require("node:vm");
    const ts = require("typescript");
    const filename = require("node:path").join(
        __dirname,
        "../src/channels/index.ts"
    );
    const ast = ts.createSourceFile(
        filename,
        fs.readFileSync(filename, "utf8"),
        ts.ScriptTarget.Latest,
        true
    );
    const fn = ast.statements.find(
        (node) =>
            ts.isFunctionDeclaration(node) &&
            node.name?.text === "onChannelsLoaded"
    );
    const source = ts.transpileModule(fn.getText(ast).replace(/^export /, ""), {
        compilerOptions: {
            module: ts.ModuleKind.None,
            target: ts.ScriptTarget.ES5,
        },
    }).outputText;
    const saved = {
        catIndex: 0,
        channelId: "local-source:fourth.mp4",
        primaryIndex: 3,
    };
    const plays = [];
    let writes = 0;
    const host = {
        __ottActiveProviderDriver: { capabilities: {}, id: provider },
        __ottChannels: { mount() {} },
        __ottClassicPlayback: {
            hydrate() {
                host.primaryIndex = saved.primaryIndex;
                host.catIndex = saved.catIndex;
            },
        },
        $: () => ({ hide() {} }),
        catIndex: saved.catIndex,
        cList: [],
        clearBootHide() {},
        console: {
            error(error) {
                throw error;
            },
            log() {},
        },
        document: { getElementById: () => null },
        loadEpgTimers() {},
        loadFavoritesLists() {},
        playChannel(category, index) {
            plays.push([category, index]);
        },
        popupActions: [() => {}],
        popupList() {},
        primaryIndex: saved.primaryIndex,
        restoreContinueWatch: () => false,
        setCurrent(category, index) {
            writes++;
            saved.catIndex = category;
            saved.primaryIndex = index;
            delete saved.channelId;
        },
        sFavorites: false,
    };
    host.window = host;
    vm.createContext(host);
    vm.runInContext(source, host);
    return { host, plays, saved, writes: () => writes };
}

test("permission-blocked local startup preserves selection and resumes it after recovery", () => {
    const f = startupFixture("offline");
    f.host.onChannelsLoaded();
    assert.equal(f.writes(), 0);
    assert.equal(f.saved.channelId, "local-source:fourth.mp4");
    assert.equal(f.saved.primaryIndex, 3);
    assert.deepEqual(f.plays, []);
    f.host.cList = ["first", "second", "third", f.saved.channelId];
    f.host.onChannelsLoaded();
    assert.deepEqual(f.plays, [[0, 3]]);
    assert.equal(f.writes(), 0);
});

test("empty non-local provider retains its existing selection-reset behavior", () => {
    const f = startupFixture("m3u");
    f.host.onChannelsLoaded();
    assert.equal(f.writes(), 1);
    assert.equal(f.saved.primaryIndex, 0);
});

test("permission-blocked source opens playback recovery instead of settings", async () => {
    const f = fixture();
    const events = [];
    f.host.__ottLocalMedia = {
        list: async () => ({
            items: [],
            sources: [{ access: "permission-required", id: "source" }],
        }),
        open: () => events.push("settings"),
        resume: () => events.push("resume"),
    };
    f.mount("offline").load(() => events.push("settled"));
    await Promise.resolve();
    assert.deepEqual(events, ["settled", "resume"]);
});

test("local scan starts one playable batch and appends without replacing playing row", async () => {
    const f = integrationFixture("offline");
    let progress, finish;
    const batches = [];
    f.host.__ottChannels = {
        append: (ids) => batches.push(Array.from(ids)),
        reset() {},
    };
    f.host.clearBootHide = () => {};
    f.host.__ottLocalMedia = {
        list: (callback) => {
            progress = callback;
            return new Promise((resolve) => {
                finish = resolve;
            });
        },
    };
    f.host.loadProv();
    const first = { id: "first", name: "First.mp4", url: "blob:first" };
    const second = { id: "second", name: "Second.mp4", url: "blob:second" };
    progress({ items: [first] });
    assert.equal(f.completed, 1);
    const playing = f.host.channels["local-first"];
    f.advanceTimers(59000);
    progress({ items: [first, second] });
    f.advanceTimers(59000);
    assert.equal(f.completed, 1);
    assert.strictEqual(f.host.channels["local-first"], playing);
    assert.deepEqual(batches, [["local-second"]]);
    finish({ items: [first, second] });
    await Promise.resolve();
    assert.equal(f.completed, 1);
    assert.deepEqual(Array.from(f.host.cList), ["local-first", "local-second"]);
});

test("scan waits for saved stable selection instead of playing first different video", async () => {
    const f = integrationFixture("offline");
    let progress, finish, preferred;
    f.host.__ottSourceIdentity = { current: () => "saved-source" };
    f.saved.set(
        "offlinechannelLibrary:saved-source",
        JSON.stringify({ selected: { itemId: "channel:local-saved" } })
    );
    f.host.clearBootHide = () => {};
    f.host.__ottLocalMedia = {
        list: (callback, preferredId) => {
            preferred = preferredId;
            progress = callback;
            return new Promise((resolve) => {
                finish = resolve;
            });
        },
    };
    f.host.loadProv();
    assert.equal(preferred, "saved");
    const first = { id: "first", name: "First.mp4", url: "blob:first" };
    const saved = { id: "saved", name: "Saved.mp4", url: "blob:saved" };
    progress({ items: [first] });
    assert.equal(f.completed, 0);
    progress({ items: [first, saved] });
    assert.equal(f.completed, 1);
    finish({ items: [first, saved] });
    await Promise.resolve();
    assert.equal(f.completed, 1);
});

test("confirmed missing saved file starts first batch while the catalog remains pending", async () => {
    const f = integrationFixture("offline");
    let progress, finish;
    f.host.__ottSourceIdentity = { current: () => "saved-source" };
    f.saved.set(
        "offlinechannelLibrary:saved-source",
        JSON.stringify({ selected: { itemId: "channel:local-gone" } })
    );
    f.host.clearBootHide = () => {};
    f.host.__ottLocalMedia = {
        list: (callback) => {
            progress = callback;
            return new Promise((resolve) => {
                finish = resolve;
            });
        },
    };
    f.host.loadProv();
    const first = { id: "first", name: "First.mp4", url: "blob:first" };
    progress({
        items: [first],
        preferred: { id: "different", state: "missing" },
        scanning: true,
    });
    assert.equal(
        f.completed,
        0,
        "another request's missing result cannot release this selection"
    );
    progress({
        items: [first],
        preferred: { id: "gone", state: "pending" },
        scanning: true,
    });
    assert.equal(
        f.completed,
        0,
        "pending lookup still protects a valid later saved file"
    );
    progress({
        items: [first],
        preferred: { id: "gone", state: "missing" },
        scanning: true,
    });
    assert.equal(
        f.completed,
        1,
        "first playable batch starts without awaiting scan completion"
    );
    assert.equal(f.host.__ottCatalogSelectedId, "local-first");
    const selected = f.host.channels["local-first"];
    const second = { id: "second", name: "Second.mp4", url: "blob:second" };
    progress({
        items: [first, second],
        preferred: { id: "gone", state: "missing" },
        scanning: true,
    });
    assert.equal(f.completed, 1);
    assert.strictEqual(
        f.host.channels["local-first"],
        selected,
        "background append preserves playing row"
    );
    finish({
        items: [first, second],
        preferred: { id: "gone", state: "missing" },
    });
    await Promise.resolve();
    assert.equal(f.completed, 1);
});

test("progress callback cancels background enumeration after provider replacement", async () => {
    const f = fixture();
    let progress, finish;
    f.host.__ottLocalMedia = {
        list: (callback) => {
            progress = callback;
            return new Promise((resolve) => {
                finish = resolve;
            });
        },
    };
    f.mount("offline").load(() => {});
    f.mount("demo");
    assert.equal(progress({ items: [] }), false);
    finish({ cancelled: true, items: [] });
    await Promise.resolve();
});

test("legacy selected index starts once that row arrives without waiting for full scan", async () => {
    const f = integrationFixture("offline", { offlineprimaryIndex: "1" });
    let progress, finish;
    f.host.clearBootHide = () => {};
    f.host.__ottLocalMedia = {
        list: (callback) => {
            progress = callback;
            return new Promise((resolve) => {
                finish = resolve;
            });
        },
    };
    f.host.loadProv();
    const first = { id: "first", name: "First.mp4", url: "blob:first" };
    const selected = {
        id: "selected",
        name: "Selected.mp4",
        url: "blob:selected",
    };
    progress({ items: [first] });
    assert.equal(f.completed, 0);
    progress({ items: [first, selected] });
    assert.equal(f.completed, 1);
    assert.equal(f.host.primaryIndex, 1);
    assert.equal(f.host.cList[f.host.primaryIndex], "local-selected");
    finish({ items: [first, selected] });
    await Promise.resolve();
    assert.equal(f.completed, 1);
});

test("invalid or out-of-range legacy selection waits for final catalog", async () => {
    for (const value of ["-1", "1.5", "invalid", "99999"]) {
        const f = integrationFixture("offline", { offlineprimaryIndex: value });
        let progress, finish;
        f.host.clearBootHide = () => {};
        f.host.__ottLocalMedia = {
            list: (callback) => {
                progress = callback;
                return new Promise((resolve) => {
                    finish = resolve;
                });
            },
        };
        f.host.loadProv();
        const catalog = {
            items: [{ id: "first", name: "First.mp4", url: "blob:first" }],
        };
        progress(catalog);
        assert.equal(f.completed, 0, value);
        finish(catalog);
        await Promise.resolve();
        assert.equal(f.completed, 1, value);
    }
});

test("missing legacy index allows the first playable batch", async () => {
    const f = fixture();
    const get = f.host.stbGetItem;
    f.host.stbGetItem = (key) =>
        key === "offlineprimaryIndex" ? undefined : get(key);
    let progress,
        finish,
        completed = 0;
    f.host.__ottLocalMedia = {
        list: (callback) => {
            progress = callback;
            return new Promise((resolve) => {
                finish = resolve;
            });
        },
    };
    f.mount("offline").load(() => completed++);
    const catalog = {
        items: [{ id: "first", name: "First.mp4", url: "blob:first" }],
    };
    progress(catalog);
    assert.equal(completed, 1);
    finish(catalog);
    await Promise.resolve();
});

test("startup scan counter updates one bounded node without exposing source paths", async () => {
    const f = integrationFixture("offline", { offlineprimaryIndex: "1" });
    let progress, finish;
    const nodes = [];
    const panel = {
        appendChild: (node) => nodes.push(node),
        querySelector: (selector) =>
            selector === ".ott-spinner" ? {} : nodes[0],
    };
    f.host.document.getElementById = (id) =>
        id === "dialogbox" ? panel : null;
    f.host.document.createElement = () => ({
        attrs: {},
        setAttribute(name, value) {
            this.attrs[name] = value;
        },
    });
    f.host.__ottLocalMedia = {
        list: (callback) => {
            progress = callback;
            return new Promise((resolve) => {
                finish = resolve;
            });
        },
    };
    f.host.loadProv();
    const first = {
        id: "private/path",
        name: "Private name.mp4",
        url: "blob:first",
    };
    progress({ items: [], scanned: 64 });
    progress({ items: [first], scanned: 128 });
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].textContent, "Local videos: 1");
    assert.deepEqual(nodes[0].attrs, {
        "data-local-items": "1",
        "data-local-phase": "files",
        "data-local-scanned": "128",
        "data-local-waiting": "legacy-index",
    });
    assert(!JSON.stringify(nodes[0]).includes("private/path"));
    progress({ items: [first], scanned: 150, total: 10000 });
    assert.equal(nodes[0].textContent, "Local videos: 1");
    finish({ items: [first], scanned: 128 });
    await Promise.resolve();
});
test("saved offline profile selection overrides a different playback cursor", () => {
    const f = startupFixture("offline");
    f.host.cList = [
        "local-first",
        "local-saved",
        "local-third",
        "local-fourth",
    ];
    f.host.__ottOfflineProfiles = { selection: () => "local-saved" };
    f.host.setCurrent = (category, index) => {
        f.host.catIndex = category;
        f.host.primaryIndex = index;
    };
    f.host.onChannelsLoaded();
    assert.deepEqual(f.plays, [[0, 1]]);
});

test("missing saved offline selection opens recovery after startup cleanup without playing another file", () => {
    for (const selected of ["", "local-missing"]) {
        const f = startupFixture("offline");
        const events = [];
        f.host.cList = ["local-other"];
        f.host.isListVisible = true;
        f.host.__ottOfflineProfiles = { selection: () => selected };
        f.host.$ = (selector) => ({ hide: () => events.push(selector) });
        f.host.clearBootHide = () => events.push("boot-cleared");
        f.host.__ottLocalMedia = {
            resume: (skipScan) => {
                assert.equal(skipScan, true);
                assert.equal(f.host.isListVisible, false);
                events.push("recovery");
                f.host.isListVisible = true;
            },
        };
        f.host.onChannelsLoaded();
        assert.deepEqual(events, [
            "#dialogbox",
            "#launch",
            "#buffering",
            "boot-cleared",
            "recovery",
        ]);
        assert.equal(f.host.isListVisible, true);
        assert.equal(f.writes(), 0);
        assert.deepEqual(f.plays, []);
    }
});

test("confirmed local fallback bypasses stale profile selection and restored index", () => {
    const f = startupFixture("offline");
    f.host.__ottActiveProviderDriver.capabilities.mediaPlaylist = true;
    f.host.cList = ["local-first"];
    f.host.catsArray = ["all"];
    f.host.cats = { all: ["local-first"] };
    const setCurrent = f.host.setCurrent;
    f.host.setCurrent = (category, index) => {
        setCurrent(category, index);
        f.host.catIndex = category;
        f.host.primaryIndex = index;
    };
    f.host.__ottCatalogSelectedId = "local-first";
    f.host.__ottMissingCatalogSelection = true;
    f.host.__ottOfflineProfiles = { selection: () => "local-gone" };
    f.host.onChannelsLoaded();
    assert.deepEqual(f.plays, [[0, 0]]);
    assert.equal(f.saved.primaryIndex, 0);
});

test("offline catalog cannot publish sources for a replaced profile", async () => {
    const f = fixture();
    let deliver,
        profile = { active: 0 };
    f.host.__ottOfflineProfiles = {
        filter: (catalog) => catalog,
        read: () => profile,
    };
    f.host.__ottLocalMedia = {
        list: () =>
            new Promise((resolve) => {
                deliver = resolve;
            }),
    };
    let result;
    f.mount("offline").load((catalog, error) => {
        result = { catalog, error };
    });
    profile = { active: 1 };
    deliver({ items: [{ id: "stale", name: "Stale.mp4", url: "blob:stale" }] });
    await Promise.resolve();
    assert.equal(result.catalog.ids.length, 0);
    assert.match(result.error, /profile changed/);
});

test("malformed saved profiles settle local catalog loading instead of hanging", async () => {
    for (const phase of ["before", "filter"]) {
        const f = fixture();
        let replies = 0,
            result;
        f.host.__ottLocalMedia = { list: async () => ({ items: [] }) };
        f.host.__ottOfflineProfiles = {
            filter: () => {
                throw new Error("corrupt binding");
            },
            read: () => {
                if (phase === "before") throw new Error("corrupt profile");
                return {};
            },
        };
        f.mount("offline").load((catalog, error) => {
            replies++;
            result = { catalog, error };
        });
        await Promise.resolve();
        assert.equal(replies, 1);
        assert.equal(result.catalog.ids.length, 0);
        assert.match(result.error, /profile configuration is unavailable/);
    }
});

test("progressive profiles prefer the saved file and filter every appended batch", async () => {
    const f = integrationFixture("offline");
    let progress, finish, preferred;
    const added = [];
    f.host.__ottChannels = { append: (ids) => added.push(...ids), reset() {} };
    f.host.clearBootHide = () => {};
    f.host.__ottSourceIdentity = { current: () => "old-cursor" };
    f.saved.set(
        "offlinechannelLibrary:old-cursor",
        JSON.stringify({ selected: { itemId: "channel:local-other" } })
    );
    f.host.__ottOfflineProfiles = {
        filter: (catalog) => ({
            ...catalog,
            items: catalog.items.filter((item) => item.sourceId === "allowed"),
        }),
        read: () => ({ active: 1 }),
        selection: () => "local-saved",
    };
    f.host.__ottLocalMedia = {
        list: (cb, id) => {
            progress = cb;
            preferred = id;
            return new Promise((resolve) => {
                finish = resolve;
            });
        },
    };
    f.host.loadProv();
    assert.equal(
        preferred,
        "saved",
        "profile selection takes precedence over channel history"
    );
    const other = {
        id: "other",
        name: "Other.mp4",
        sourceId: "foreign",
        url: "blob:other",
    };
    const first = {
        id: "first",
        name: "First.mp4",
        sourceId: "allowed",
        url: "blob:first",
    };
    const saved = {
        id: "saved",
        name: "Saved.mp4",
        sourceId: "allowed",
        url: "blob:saved",
    };
    progress({ items: [other, first], scanning: true });
    assert.equal(
        f.completed,
        0,
        "first available file must not override saved profile selection"
    );
    progress({ items: [other, first, saved], scanning: true });
    assert.equal(f.completed, 1);
    assert.equal(f.host.channels["local-other"], undefined);
    const later = {
        id: "later",
        name: "Later.mp4",
        sourceId: "allowed",
        url: "blob:later",
    };
    finish({ items: [other, first, saved, later], scanning: false });
    await Promise.resolve();
    assert.equal(f.completed, 1);
    assert.deepEqual(added, ["local-later"]);
    assert.equal(f.host.channels["local-other"], undefined);
});

test("progressive profile ownership rejects late batches after binding replacement", async () => {
    const f = integrationFixture("offline");
    let progress,
        finish,
        sameBinding = true;
    f.host.clearBootHide = () => {};
    f.host.__ottChannels = {
        append: () => assert.fail("stale profile appended"),
        reset() {},
    };
    f.host.__ottOfflineProfiles = {
        catalogGuard: () => () => sameBinding,
        filter: (catalog) => catalog,
        read: () => ({ active: 1 }),
        selection: () => "local-saved",
    };
    f.host.__ottLocalMedia = {
        list: (cb) => {
            progress = cb;
            return new Promise((resolve) => {
                finish = resolve;
            });
        },
    };
    f.host.loadProv();
    const saved = { id: "saved", name: "Saved.mp4", url: "blob:saved" };
    progress({ items: [saved], scanning: true });
    assert.equal(f.completed, 1);
    sameBinding = false;
    assert.equal(
        progress({
            items: [
                saved,
                { id: "stale", name: "Stale.mp4", url: "blob:stale" },
            ],
            scanning: true,
        }),
        false
    );
    finish({ items: [saved], scanning: false });
    await Promise.resolve();
    assert.equal(f.host.channels["local-stale"], undefined);
    assert.equal(f.completed, 1);
});

test("cancelled current scan settles startup and incomplete profile batches never authorize playback", async () => {
    for (const unbound of [false, true]) {
        const f = fixture();
        let progress, finish;
        if (unbound)
            f.host.__ottOfflineProfiles = {
                filter: (catalog) => ({ ...catalog, items: [] }),
                read: () => ({}),
                selection: () => "",
            };
        f.host.__ottLocalMedia = {
            list: (cb) => {
                progress = cb;
                return new Promise((resolve) => {
                    finish = resolve;
                });
            },
        };
        const results = [];
        f.mount("offline").load((catalog, error) =>
            results.push({ catalog, error })
        );
        if (unbound) {
            progress({
                items: [
                    { id: "foreign", name: "Foreign.mp4", url: "blob:foreign" },
                ],
                scanning: true,
            });
            assert.equal(results.length, 0);
        }
        finish({ cancelled: true, items: [] });
        await Promise.resolve();
        assert.equal(results.length, 1);
        assert.match(results[0].error, /cancelled/);
        assert.equal(results[0].catalog.ids.length, 0);
    }
});

test("synchronously throwing local catalog settles startup once", () => {
    const f = fixture();
    let replies = 0;
    f.host.__ottLocalMedia = {
        list() {
            throw new Error("Unavailable source");
        },
    };
    f.mount("offline").load((catalog, error) => {
        replies++;
        assert.equal(catalog.ids.length, 0);
        assert.match(error, /could not be read/);
    });
    assert.equal(replies, 1);
});

test("incomplete terminal catalog never starts local playback", async () => {
    const f = fixture();
    let result;
    f.host.__ottLocalMedia = {
        list: async () => ({
            items: [
                { id: "partial", name: "Partial.mp4", url: "blob:partial" },
            ],
            scanning: true,
        }),
    };
    f.mount("offline").load((catalog, error) => {
        result = { catalog, error };
    });
    await Promise.resolve();
    assert.equal(result.catalog.ids.length, 0);
    assert.match(result.error, /incomplete/);
});

test("profile replacement inside a catalog callback stops its old enumeration", () => {
    const f = fixture();
    let progress,
        valid = true,
        replies = 0;
    f.host.__ottOfflineProfiles = {
        catalogGuard: () => () => valid,
        filter: (catalog) => catalog,
        read: () => ({}),
        selection: () => null,
    };
    f.host.__ottLocalMedia = {
        list: (callback) => {
            progress = callback;
            return new Promise(() => {});
        },
    };
    f.mount("offline").load(() => {
        replies++;
        valid = false;
    });
    const row = { id: "first", name: "First.mp4", url: "blob:first" };
    assert.equal(progress({ items: [row], scanning: true }), false);
    assert.equal(progress({ items: [row], scanning: true }), false);
    assert.equal(replies, 1);
});

test("local footer metadata uses immediate directory and supports legacy source labels", async () => {
    const f = fixture();
    f.host.__ottLocalMedia = {
        list: async () => ({
            items: [
                {
                    directory: "Actual child",
                    id: "native",
                    name: "Movie.mp4",
                    sourceId: "root",
                    url: "blob:native",
                },
                {
                    id: "legacy",
                    name: "Old.mp4",
                    sourceId: "root",
                    url: "blob:legacy",
                },
                {
                    id: "relative",
                    name: "Top/Child/Third.mp4",
                    sourceId: "root",
                    url: "blob:relative",
                },
            ],
            sources: [{ id: "root", kind: "folder", name: "Root label" }],
        }),
    };
    const driver = f.mount("offline");
    const catalog = await new Promise((resolve) => driver.load(resolve));
    assert.equal(
        catalog.channels["local-native"].__ottMediaCollection,
        "Actual child"
    );
    assert.equal(
        catalog.channels["local-legacy"].__ottMediaCollection,
        "Root label"
    );
    assert.equal(
        catalog.channels["local-relative"].__ottMediaCollection,
        "Child"
    );
    assert.equal(catalog.channels["local-relative"].channel_name, "Third.mp4");
});

test("import selection is consumed once and preserves explicit profile precedence", async () => {
    for (const explicitProfile of [false, true]) {
        const f = integrationFixture("offline");
        const preferred = [];
        let imported = "local-imported";
        let profileActive = explicitProfile;
        f.host.clearBootHide = () => {};
        f.host.__ottSourceIdentity = { current: () => "saved-source" };
        f.saved.set(
            "offlinechannelLibrary:saved-source",
            JSON.stringify({ selected: { itemId: "channel:local-saved" } })
        );
        f.host.__ottOfflineProfiles = {
            read: () => ({ active: profileActive ? 1 : 0 }),
            selection: () => (profileActive ? "local-profile" : null),
        };
        f.host.__ottLocalMedia = {
            list: (_, id) => {
                preferred.push(id);
                return Promise.resolve({ items: [] });
            },
            takeImportSelection: () => {
                const result = imported;
                imported = "";
                return result;
            },
        };
        f.host.loadProv();
        assert.equal(preferred[0], explicitProfile ? "profile" : "imported");
        assert.equal(
            imported,
            "",
            "the handoff is consumed even with an active profile"
        );
        await Promise.resolve();
        profileActive = false;
        f.host.loadProv();
        assert.equal(
            preferred[1],
            "saved",
            "later loads use normal saved selection"
        );
        await Promise.resolve();
    }
});

function startupDialogFixture() {
    const f = fixture();
    const nodes = [];
    const callbacks = [];
    let closed = 0;
    f.host.keys.EXIT = 8;
    f.host.document = {
        createElement: () => ({ setAttribute() {} }),
        getElementById: () => ({
            appendChild: (node) => nodes.push(node),
            querySelector: (selector) =>
                selector === ".ott-spinner" ? {} : null,
        }),
    };
    f.host.renderButtonHint = (_, __, label) => label;
    f.host.__ottClassicScreenPort = {
        setOwnedCallback: (kind, handler) => {
            assert.equal(kind, "dialog");
            callbacks.push(handler);
            let active = true;
            return {
                owner: {
                    active: () => active,
                    close: () => {
                        active = false;
                        closed++;
                    },
                },
            };
        },
    };
    return { ...f, callbacks, closed: () => closed, nodes };
}

test("local startup Cancel retires pending work and ignores late completion", async (t) => {
    for (const key of [27, 8]) {
        const f = startupDialogFixture();
        const resumed = [];
        const results = [];
        let complete;
        f.host.__ottLocalMedia = {
            list: () => new Promise((resolve) => (complete = resolve)),
            resume: (skipScan) => resumed.push(skipScan),
        };
        const driver = f.mount("offline");
        t.after(() => driver.dispose());
        driver.load((catalog, error) => results.push({ catalog, error }));
        assert.equal(f.callbacks.length, 1);
        assert.match(f.nodes[0].innerHTML, /Cancel/);
        f.callbacks[0](key);
        assert.equal(results.length, 1);
        assert.equal(results[0].catalog.ids.length, 0);
        assert.deepEqual(resumed, [true]);
        assert.equal(f.closed(), 1);
        complete({
            items: [{ id: "late", name: "Late.mp4", url: "blob:late" }],
        });
        await Promise.resolve();
        f.callbacks[0](key);
        assert.equal(
            results.length,
            1,
            "cancelled startup cannot publish late files"
        );
        assert.equal(f.closed(), 1);
    }
});

test("first local playback closes its startup owner and leaves old Cancel inert", (t) => {
    const f = startupDialogFixture();
    const resumed = [];
    const results = [];
    let progress;
    f.host.__ottLocalMedia = {
        list: (callback) => {
            progress = callback;
            return new Promise(() => {});
        },
        resume: (skipScan) => resumed.push(skipScan),
    };
    const driver = f.mount("offline");
    t.after(() => driver.dispose());
    driver.load((catalog) => results.push(catalog));
    progress({
        items: [{ id: "first", name: "First.mp4", url: "blob:first" }],
    });
    assert.equal(results.length, 1);
    assert.equal(f.closed(), 1);
    f.callbacks[0](f.host.keys.RETURN);
    assert.equal(results.length, 1);
    assert.deepEqual(resumed, []);
});

test("strict kiosk prevents local startup cancellation, including a newly locked session", (t) => {
    for (const initiallyLocked of [true, false]) {
        const f = startupDialogFixture();
        let locked = initiallyLocked;
        let resumed = 0;
        f.host.__ottKiosk = { locked: () => locked };
        f.host.__ottLocalMedia = {
            list: () => new Promise(() => {}),
            resume: () => resumed++,
        };
        const driver = f.mount("offline");
        t.after(() => driver.dispose());
        driver.load(() => assert.fail("locked startup was cancelled"));
        assert.equal(f.callbacks.length, initiallyLocked ? 0 : 1);
        locked = true;
        if (f.callbacks[0]) f.callbacks[0](f.host.keys.RETURN);
        assert.equal(resumed, 0);
    }
});

test("a late-rendered loading panel gains clickable Cancel and retires native work", async (t) => {
    const f = startupDialogFixture();
    let panelReady = false,
        cancel,
        progress,
        finish,
        stopped = 0;
    const panel = {
        appendChild: (node) => {
            if (node.innerHTML) cancel = node;
        },
        querySelector: (selector) =>
            selector === ".ott-spinner" ? {} : cancel || null,
    };
    f.host.document.getElementById = () => (panelReady ? panel : null);
    f.host.__ottLocalMedia = {
        cancelScan: () => stopped++,
        list: (callback) => {
            progress = callback;
            return new Promise((resolve) => (finish = resolve));
        },
        resume() {},
    };
    const driver = f.mount("offline");
    t.after(() => driver.dispose());
    const results = [];
    driver.load((catalog) => results.push(catalog));
    assert.equal(f.callbacks.length, 0);
    panelReady = true;
    progress({ items: [], scanned: 500, scanning: true });
    assert.equal(f.callbacks.length, 1);
    assert.match(cancel.innerHTML, /Cancel/);
    cancel.onclick({ preventDefault() {}, stopPropagation() {} });
    assert.equal(stopped, 1);
    assert.equal(results.length, 1);
    finish({ items: [{ id: "late", name: "Late.mp4", url: "blob:late" }] });
    await Promise.resolve();
    assert.equal(results.length, 1);
});

test("redrawn loading spinner rebinds Cancel after the old owner is retired", (t) => {
    const f = startupDialogFixture();
    const make = f.host.__ottClassicScreenPort.setOwnedCallback;
    const owners = [];
    f.host.__ottClassicScreenPort.setOwnedCallback = (...args) => {
        const result = make(...args);
        owners.push(result.owner);
        return result;
    };
    let progress,
        cancelled = 0;
    f.host.__ottLocalMedia = {
        cancelScan: () => cancelled++,
        list: (callback) => {
            progress = callback;
            return new Promise(() => {});
        },
        resume() {},
    };
    const driver = f.mount("offline");
    t.after(() => driver.dispose());
    driver.load(() => {});
    owners[0].close();
    progress({ items: [], scanned: 20, scanning: true });
    assert.equal(owners.length, 2);
    assert.equal(typeof owners[1].model.cancelOnPower, "function");
    f.callbacks[1](27);
    assert.equal(cancelled, 1);
});
