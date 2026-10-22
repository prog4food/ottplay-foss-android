"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const fixture = require("./helpers/stalker-driver-fixture.cjs");
const clone = (value) => JSON.parse(JSON.stringify(value));
let groups = 0;
function test(label, action) {
    action();
    groups++;
    console.log("PASS Stalker driver: " + label);
}
function catalog(id = 42, name = "News") {
    return {
        result: [
            {
                archive: 24,
                id,
                logo: "/logo.png",
                name,
                url: "https://live.test/" + id,
            },
        ],
    };
}
function loaded(options) {
    const f = fixture(options);
    let result;
    f.driver.load((value) => {
        result = value;
    });
    f.requests[0].done({ result: {} });
    f.requests[1].done(catalog());
    f.catalog = result;
    return f;
}

test("19 captured JSON session/catalog/guide contracts", () => {
    const captured = require("./fixtures/stalker/legacy.json").cases;
    assert.equal(captured.length, 19);
    for (const [index, contract] of captured.entries()) {
        const f = fixture({ config: contract.input.config });
        let callbacks = 0,
            value,
            epg;
        const errors = [];
        f.driver.load((result, error) => {
            callbacks++;
            value = result;
            if (error)
                errors.push(
                    error === "stalker-connect"
                        ? "Failed to connect to Stalker portal"
                        : "Failed to load channels from Stalker portal"
                );
        });
        for (let i = 0; i < f.requests.length; i++) {
            assert(i < 15, "bounded protocol exchange");
            f.requests[i].done(contract.input.responses[i]);
        }
        if (contract.input.guide && value.ids.length) {
            f.driver.guide(value.ids[0], (data) => {
                epg = { data, id: value.ids[0] };
            });
            f.requests.at(-1).done(contract.input.responses.at(-1));
        }
        assert(
            f.requests.every(
                (r) => r.settings.contentType === "application/json"
            )
        );
        const actual = clone({
            callbacks,
            calls: f.requests.map(({ settings }) => ({
                data: JSON.parse(settings.data),
                method: settings.type,
                timeout: settings.timeout,
                url: settings.url,
            })),
            errors,
        });
        assert.deepEqual(
            actual,
            {
                callbacks: contract.expected.callbacks,
                calls: contract.expected.calls,
                errors: contract.expected.errors,
            },
            "protocol contract " + index
        );
        assert.equal(new Set(value.ids).size, value.ids.length);
        for (const id of value.ids) {
            const channel = value.channels[id];
            assert(channel.itemId.startsWith("stalker:channel:"));
            assert(value.groups[channel.category.name].includes(id));
            assert(channel.groupId.startsWith("stalker:category:"));
        }
        if (epg && contract.expected.epg)
            assert.deepEqual(clone(epg.data), contract.expected.epg.data);
    }
});

test("14 captured archive edge contracts call the shipped core", () => {
    const rows = require("./fixtures/archive/providers.json").fixtures.filter(
        (row) => row.provider === "stalker"
    );
    assert.equal(rows.length, 14);
    for (const row of rows) {
        // These fixtures begin at the catalog edge: parsing has separate captured tests above.
        const f = loaded({
            catalog: {
                channels: { 42: row.channel },
                groupOrder: [],
                groups: {},
                ids: [42],
            },
            dune: row.dune,
            now: row.now,
        });
        assert.equal(f.driver.archive(42, row.start, row.end), row.expected);
        assert.equal(f.driver.archive("missing", row.start, row.end), "");
    }
});

test("owned catalogs cannot be mutated through legacy snapshots", () => {
    const f = loaded();
    assert.equal(f.driver.stream(42), "https://live.test/42");
    assert.equal(f.driver.logo(42), "https://portal.test/logo.png");
    f.catalog.channels[42].url = "corrupted";
    f.catalog.channels[42].category.name = "corrupted";
    f.catalog.ids.length = 0;
    f.catalog.groups.Other.length = 0;
    assert.equal(f.driver.stream(42), "https://live.test/42");
    assert.equal(f.driver.capabilities.media, false);
});

test("catalog replacement cancels old catalog and guide even after abort", () => {
    const f = loaded();
    let guide = 0,
        stale = 0,
        current = 0;
    f.driver.guide(42, () => guide++);
    const oldGuide = f.requests.at(-1);
    f.driver.load(() => stale++);
    const oldLoad = f.requests.at(-1);
    assert.equal(oldGuide.aborts, 1);
    f.driver.load(() => current++);
    assert.equal(oldLoad.aborts, 1);
    oldGuide.done({ result: [] });
    oldLoad.done({ result: {} });
    assert.equal(guide, 0);
    assert.equal(stale, 0);
    assert.equal(f.driver.stream(42), "");
    f.requests.at(-1).done({ result: {} });
    f.requests.at(-1).done(catalog(7));
    assert.equal(current, 1);
    assert.equal(f.driver.stream(7), "https://live.test/7");
});

test("provider disposal and credentials changes retire requests and URLs", () => {
    for (const mode of ["save", "replace", "dispose"]) {
        const f = loaded();
        let callbacks = 0;
        f.driver.guide(42, () => callbacks++);
        const request = f.requests.at(-1);
        if (mode === "save")
            f.driver.saveCredentials({
                password: "ignored",
                server: "https://other.test",
                username: "other-mac",
            });
        if (mode === "replace") f.registry.activate("stalker");
        if (mode === "dispose") f.driver.dispose();
        assert.equal(request.aborts, 1);
        request.done({ result: [] });
        request.fail();
        assert.equal(callbacks, 0);
        assert.equal(f.driver.stream(42), "");
        assert.equal(f.driver.logo(42), "");
        assert.equal(f.driver.archive(42, 1, 2), "");
        if (mode === "save")
            assert.deepEqual(
                JSON.parse(f.saved.get("stalker_data")).portals[0],
                {
                    mac: "other-mac",
                    name: "",
                    portal: "https://other.test",
                }
            );
    }
});

test("external account replacement cannot reuse catalog or publish old requests", () => {
    const f = loaded();
    let count = 0;
    f.driver.guide(42, () => count++);
    const request = f.requests.at(-1);
    f.saved.set(
        "stalker_data",
        JSON.stringify({ mac: "different", portal: "https://portal.test/" })
    );
    request.done({ result: [] });
    assert.equal(count, 0);
    assert.equal(f.driver.stream(42), "");
    f.driver.guide(42, (value) => {
        count++;
        assert.equal(value, null);
    });
    assert.equal(count, 1);
});

test("synchronous and duplicate transport completions settle once", () => {
    const f = fixture({ synchronous: [{ result: {} }, catalog()] });
    let calls = 0;
    f.driver.load(() => calls++);
    assert.equal(calls, 1);
    assert.equal(f.driver.stream(42), "https://live.test/42");
    f.requests[0].done({ result: null });
    f.requests[1].done(catalog(7));
    f.requests[1].fail();
    f.driver.dispose();
    assert.equal(calls, 1);
    assert(f.requests.every((r) => r.aborts === 0));
});

test("abort reentry and progress reentry leave the newest operation in control", () => {
    const f = fixture();
    let old = 0,
        outer = 0,
        inner = 0;
    f.driver.load(() => old++);
    f.requests[0].onAbort = () => f.driver.load(() => inner++);
    f.driver.load(() => outer++);
    f.requests.at(-1).done({ result: {} });
    f.requests.at(-1).done(catalog(9));
    assert.deepEqual([old, outer, inner], [0, 0, 1]);
    assert.equal(f.driver.stream(9), "https://live.test/9");
    const g = fixture();
    let first = true;
    g.ports.progress = () => {
        if (first) {
            first = false;
            g.driver.load(() => inner++);
        }
    };
    g.driver.load(() => outer++);
    assert.equal(g.requests.length, 1);
    g.requests[0].done({ result: {} });
    g.requests[1].done(catalog());
    assert.deepEqual([outer, inner], [0, 2]);
});

test("missing or malformed configuration opens settings without network", () => {
    for (const value of [
        null,
        "not-json",
        "null",
        "[]",
        JSON.stringify({ mac: "x" }),
        JSON.stringify({ portal: "https://p.test" }),
    ]) {
        const f = fixture();
        f.saved.set("stalker_data", value);
        let outcome;
        f.driver.load((catalog, error) => {
            outcome = [catalog, error];
        });
        assert.deepEqual(outcome, [null, "credentials"]);
        assert.equal(f.requests.length, 0);
    }
    const f = fixture();
    f.ports.validateUrl = () => false;
    f.driver.load((catalog, error) =>
        assert.deepEqual([catalog, error], [null, "credentials"])
    );
    assert.equal(f.requests.length, 0);
});

test("driver factory only receives injected ports", () => {
    const source = fs.readFileSync(
        path.join(__dirname, "../src/provider/stalker-driver.ts"),
        "utf8"
    );
    const factory = source.slice(
        source.indexOf("function createStalkerProviderDriver"),
        source.indexOf("/** Retained menu projection")
    );
    assert(
        !/\b(window|document|localStorage|stalkerApiCall|getChanelsArray|chanels|stbGetItem|stbSetItem|setTimeout)\b/.test(
            factory
        )
    );
});

function settingsFixture() {
    const f = loaded();
    const host = f.host;
    let reloads = 0;
    Object.assign(host, {
        $: () => ({ hide() {} }),
        keys: { ENTER: 13, RETURN: 27, YELLOW: 405 },
        listCaption: {},
        listDetail: {},
        listFooter: {},
        loadChannels: () => reloads++,
        popupActions: [],
        popupArray: [],
        popupDetail: [],
        popupList() {},
        renderButtonHint: () => "",
        showEditKey() {},
        showPage() {},
        strRETURN: "Return",
        toggleProviderSettingsVisibility() {},
    });
    const ui = host.__ottStalkerDriver.mountSettings(host, f.driver, f.owner);
    ui.mount(0);
    return {
        ...f,
        get reloads() {
            return reloads;
        },
        ui,
    };
}

test("portal/MAC editor preserves UI, normalization and canonical persistence", () => {
    const f = settingsFixture(),
        w = f.host;
    assert.equal(w.popupArray[0], "Stalker portal settings: 1 - portal.test");
    w.popupActions[0]();
    assert.equal(w.listCaption.innerHTML, "Select Stalker portal");
    assert.equal(w.listArray.length, 15);
    w.listKeyHandler(w.keys.ENTER);
    assert.equal(w.listCaption.innerHTML, "Stalker Portal Provider");
    assert.deepEqual(clone(w.listArray), [
        "Portal URL: https://portal.test/",
        "MAC address: 00:1a:79:01:02:03",
        "Profile name: ",
        "",
        "Save and load channels",
    ]);
    w.listKeyHandler(w.keys.ENTER);
    w.editvar = " https://other.test/path/// ";
    w.setEdit();
    w.selIndex = 1;
    w.listKeyHandler(w.keys.ENTER);
    w.editvar = " 00:1a:2b:3c:4d:5e ";
    w.setEdit();
    assert.equal(f.driver.credentials().server, "https://portal.test/");
    w.selIndex = 4;
    const save = w.listKeyHandler;
    save(w.keys.ENTER);
    save(w.keys.ENTER);
    assert.equal(f.reloads, 1);
    assert.deepEqual(JSON.parse(f.saved.get("stalker_data")).portals[0], {
        mac: "00:1A:2B:3C:4D:5E",
        name: "",
        portal: "https://other.test/path",
    });
    assert.equal(w.popupArray[0], "Stalker portal settings: 1 - other.test");
});

test("editor cancellation, replacement and duplicate callbacks cannot write", () => {
    for (const mode of ["cancel", "editor", "owner"]) {
        const f = settingsFixture(),
            w = f.host;
        const original = f.saved.get("stalker_data");
        f.ui.edit();
        w.listKeyHandler(w.keys.ENTER);
        w.listKeyHandler(w.keys.ENTER);
        const complete = w.setEdit;
        const oldKeys = w.listKeyHandler;
        if (mode === "cancel") w.listKeyHandler(w.keys.RETURN);
        if (mode === "editor") f.ui.edit();
        if (mode === "owner") f.registry.activate("stalker");
        const display = clone(w.listArray);
        w.editvar = "https://stale.test";
        complete();
        w.selIndex = 4;
        oldKeys(w.keys.ENTER);
        assert.equal(f.saved.get("stalker_data"), original);
        assert.deepEqual(clone(w.listArray), display);
        assert.equal(f.reloads, 0);
    }
    const f = settingsFixture(),
        w = f.host;
    f.ui.edit();
    w.listKeyHandler(w.keys.ENTER);
    w.listKeyHandler(w.keys.ENTER);
    const first = w.setEdit;
    w.editvar = "https://first.test";
    first();
    w.editvar = "https://duplicate.test";
    first();
    assert.equal(w.listArray[0], "Portal URL: https://first.test");
    w.selIndex = 1;
    w.listKeyHandler(w.keys.ENTER);
    first();
    assert.equal(w.listArray[0], "Portal URL: https://first.test");
});

test("fifteen profiles migrate the singleton and survive restart without credentials loss", () => {
    const f = fixture();
    const original = f.saved.get("stalker_data");
    const config = f.driver.configuration();
    assert.equal(config.active, 0);
    assert.equal(config.portals.length, 15);
    assert.equal(
        f.saved.get("stalker_data"),
        original,
        "reading does not rewrite legacy settings"
    );
    for (let index = 1; index < 15; index++)
        config.portals[index] = {
            mac: "02:00:00:00:00:" + String(index).padStart(2, "0"),
            name: "Portal " + (index + 1),
            portal: "https://portal" + index + ".test/c/",
        };
    config.active = 14;
    assert.equal(f.driver.saveConfiguration(config), true);
    const restarted = fixture({
        config: JSON.parse(f.saved.get("stalker_data")),
    });
    assert.equal(restarted.driver.configuration().active, 14);
    assert.equal(
        restarted.driver.credentials().server,
        "https://portal14.test/c/"
    );
    restarted.driver.saveCredentials({
        password: "",
        server: "https://updated.test/c/",
        username: "02:00:00:00:01:14",
    });
    const saved = restarted.driver.configuration();
    assert.deepEqual(clone(saved.portals[0]), {
        mac: "00:1a:79:01:02:03",
        name: "",
        portal: "https://portal.test/",
    });
    assert.equal(saved.portals[14].name, "Portal 15");
    assert.equal(saved.portals[13].portal, "https://portal13.test/c/");
    saved.active = 0;
    restarted.driver.saveConfiguration(saved);
    assert.equal(restarted.driver.credentials().server, "https://portal.test/");
    saved.portals[0].portal = "https://uncommitted.test";
    assert.equal(
        restarted.driver.credentials().server,
        "https://portal.test/",
        "snapshots are isolated"
    );
});

test("malformed profile arrays stay bounded and credentials remain strings", () => {
    for (const active of [-1, 15, 1.5, "bad"]) {
        const f = fixture({
            config: {
                active,
                portals: [null, "wrong", { mac: 12, name: [], portal: {} }],
            },
        });
        const config = f.driver.configuration();
        assert.equal(config.active, 0);
        assert.equal(config.portals.length, 15);
        assert(
            config.portals.every((slot) =>
                Object.values(slot).every((value) => value === "")
            )
        );
    }
});

test("switching duplicate accounts still retires the old profile's catalog and guide", () => {
    const f = loaded();
    const config = f.driver.configuration();
    config.portals[1] = clone(config.portals[0]);
    assert(f.driver.saveConfiguration(config));
    let guides = 0;
    f.driver.guide(42, () => guides++);
    const request = f.requests.at(-1);
    config.active = 1;
    assert(f.driver.saveConfiguration(config));
    assert.equal(request.aborts, 1);
    request.done({ result: [] });
    assert.equal(guides, 0);
    assert.equal(f.driver.stream(42), "");
    assert.equal(f.driver.logo(42), "");
    assert.equal(f.driver.archive(42, 1, 2), "");
    let catalogs = 0;
    f.driver.load(() => catalogs++);
    f.requests.at(-1).done({ result: {} });
    f.requests.at(-1).done(catalog(7));
    assert.equal(catalogs, 1);
    assert.equal(f.driver.stream(7), "https://live.test/7");
});

test("inactive profile and name edits preserve the active session; abort reentry wins", () => {
    const f = loaded();
    const config = f.driver.configuration();
    config.portals[0].name = "News";
    config.portals[1] = {
        mac: "02:00:00:00:00:02",
        name: "Other",
        portal: "https://other.test/",
    };
    let guides = 0;
    f.driver.guide(42, () => guides++);
    const pending = f.requests.at(-1);
    assert(f.driver.saveConfiguration(config));
    assert.equal(pending.aborts, 0);
    assert.equal(f.driver.stream(42), "https://live.test/42");
    pending.done({ result: [] });
    assert.equal(guides, 1);
    f.driver.guide(42, () => guides++);
    f.requests.at(-1).onAbort = () =>
        f.driver.saveCredentials({
            password: "",
            server: "https://newest.test/",
            username: "02:00:00:00:00:03",
        });
    config.active = 1;
    assert.equal(f.driver.saveConfiguration(config), false);
    assert.equal(f.driver.credentials().server, "https://newest.test/");
    assert.equal(f.driver.configuration().active, 0);
});

test("a credentials draft from another profile cannot overwrite the selected one", () => {
    const f = fixture();
    const draft = f.driver.credentials();
    const config = f.driver.configuration();
    config.active = 1;
    config.portals[1] = {
        mac: "02:00:00:00:00:02",
        name: "Second",
        portal: "https://second.test/",
    };
    f.driver.saveConfiguration(config);
    draft.server = "https://stale.test/";
    assert.equal(f.driver.saveCredentials(draft), false);
    assert.equal(f.driver.credentials().server, "https://second.test/");
});

test("profile UI configures an empty slot, switches saved slots and rejects stale editors", () => {
    const f = settingsFixture(),
        w = f.host;
    f.ui.edit();
    w.selIndex = 1;
    w.listKeyHandler(w.keys.ENTER);
    for (const [index, value] of [
        [0, " https://second.test/c/// "],
        [1, " 02:ab:00:00:00:02 "],
        [2, "<b>Second & portal</b>"],
    ]) {
        w.selIndex = index;
        w.listKeyHandler(w.keys.ENTER);
        w.editvar = value;
        w.setEdit();
    }
    assert.equal(
        f.driver.configuration().active,
        0,
        "draft does not switch playback"
    );
    assert.equal(
        w.listArray[2],
        "Profile name: &lt;b&gt;Second &amp; portal&lt;/b&gt;"
    );
    w.selIndex = 4;
    w.listKeyHandler(w.keys.ENTER);
    assert.equal(f.reloads, 1);
    assert.equal(f.driver.configuration().active, 1);
    assert.equal(f.driver.credentials().username, "02:AB:00:00:00:02");
    f.ui.edit();
    assert.equal(w.selIndex, 1);
    assert.match(w.getListItem(w.listArray[1], 1), /2: ✓ &lt;b&gt;/);
    w.selIndex = 0;
    w.listKeyHandler(w.keys.ENTER);
    assert.equal(f.reloads, 2);
    assert.equal(f.driver.configuration().active, 0);
    f.ui.edit();
    w.selIndex = 1;
    w.listKeyHandler(w.keys.YELLOW);
    assert.equal(w.listCaption.innerHTML, "Stalker Portal Provider");
    assert.equal(f.driver.configuration().active, 0);
    w.listKeyHandler(w.keys.ENTER);
    const complete = w.setEdit,
        oldKeys = w.listKeyHandler;
    const external = f.driver.configuration();
    external.portals[2].name = "External change";
    f.driver.saveConfiguration(external);
    w.editvar = "https://stale.test/";
    complete();
    w.selIndex = 4;
    assert.equal(oldKeys(w.keys.ENTER), false);
    assert.equal(
        f.driver.configuration().portals[1].portal,
        "https://second.test/c"
    );
    assert.equal(f.reloads, 2);
});

test("injected hash reentry cannot publish the displaced catalog", () => {
    const f = fixture();
    let old = 0,
        current = 0;
    const hash = f.ports.hash;
    f.ports.hash = (value) => {
        f.driver.load(() => current++);
        return hash(value);
    };
    f.driver.load(() => old++);
    f.requests[0].done({ result: {} });
    f.requests[1].done({
        result: [{ name: "Hashed", url: "https://stream.test/hashed" }],
    });
    assert.equal(old, 0);
    f.requests[2].done({ result: {} });
    f.requests[3].done(catalog());
    assert.equal(current, 1);
});

const { integrationFixture } = require("./helpers/provider-driver-fixture.cjs");
function startup(settings = {}) {
    return integrationFixture("stalker", {
        stalkerstalker_data: JSON.stringify({
            mac: "00:1A:2B:3C:4D:5E",
            portal: "https://portal.test/",
        }),
        ...settings,
    });
}

test("actual loadProv/loadChannels startup binds a private instance without scripts or ajax mutation", () => {
    const f = startup();
    f.host.loadProv();
    assert.equal(f.host.__ottActiveProviderDriver.id, "stalker");
    assert.equal(f.requests.length, 1);
    f.requests[0].resolve({ result: {} });
    f.requests[1].resolve(catalog());
    assert.equal(f.completed, 1);
    assert.deepEqual(Array.from(f.host.cList), [42]);
    assert.equal(f.host.getChannelUrl(42), "https://live.test/42");
    assert.equal(f.host.getChannelPicon(42), "https://portal.test/logo.png");
    let guide;
    f.host.getChannelEpg(42, (id, rows) => {
        guide = { id, rows };
    });
    assert.equal(f.requests[2].settings.timeout, 10000);
    f.requests[2].resolve({
        result: [{ end: 20, name: "Programme", start: 10 }],
    });
    assert.equal(guide.id, 42);
    assert.equal(guide.rows[0].name, "Programme");
    assert.deepEqual(f.scripts, []);
    assert.equal(f.ajaxWrites, 0);
    assert.equal(f.host.getMediaArray, null);
    f.host.providerSetItem("continueWatch", "bookmark");
    assert.equal(f.saved.get("stalkercontinueWatch"), "bookmark");
});

test("actual startup reports protocol failures and opens the preserved editor for missing credentials", () => {
    for (const channels of [false, true]) {
        const f = startup();
        f.host.loadProv();
        f.requests[0].resolve({ result: channels ? {} : null });
        f.requests[1].resolve({ result: null });
        assert.equal(f.completed, 1);
        assert.deepEqual(f.errors, [
            channels
                ? "Failed to load channels from Stalker portal"
                : "Failed to connect to Stalker portal",
        ]);
    }
    const f = startup({ stalkerstalker_data: "{}" });
    f.host.loadProv();
    assert.equal(f.requests.length, 0);
    assert.equal(f.completed, 0);
    assert.equal(f.host.listCaption.innerHTML, "Select Stalker portal");
    assert.equal(f.host.listArray.length, 15);
    f.host.listKeyHandler(f.host.keys.ENTER);
    assert.equal(f.host.listArray.length, 5);
    assert.equal(f.host.listArray[0], "Portal URL: ");
});

test("host startup restores the selected profile and keeps legacy settings scoped", () => {
    const initial = fixture().driver.configuration();
    initial.active = 14;
    initial.portals[14] = {
        mac: "02:00:00:00:00:14",
        name: "Last",
        portal: "https://last.test/",
    };
    const f = startup({
        stalkerfavoritesArray: "original",
        stalkerstalker_data: JSON.stringify(initial),
    });
    f.host.providerScopedStorageKeys = [
        "favoritesArray",
        "prevArr",
        "continueWatch",
    ];
    require("./helpers/private-runtime.cjs")(
        f.host,
        "src/provider/source-identity.ts"
    );
    f.host.loadProv();
    const driver = f.host.__ottActiveProviderDriver;
    assert.match(f.requests[0].settings.url, /last\.test/);
    assert.equal(f.host.providerGetItem("favoritesArray"), null);
    f.host.providerSetItem("favoritesArray", "last-favorites");
    f.host.providerSetItem("continueWatch", "last-bookmark");
    assert.equal(f.saved.get("stalkerfavoritesArray14"), "last-favorites");
    assert.equal(f.saved.get("stalkercontinueWatch14"), "last-bookmark");
    assert.equal(driver.storageKey("stalker_data"), "stalkerstalker_data");
    const identity = f.host.__ottSourceIdentity.current(f.host);
    assert.match(identity, /^stalker:14@/);
    const next = driver.configuration();
    next.active = 0;
    driver.saveConfiguration(next);
    f.host.loadChannels();
    assert.equal(f.host.providerGetItem("favoritesArray"), "original");
    assert.equal(f.host.providerGetItem("continueWatch"), null);
    assert.match(f.host.__ottSourceIdentity.current(f.host), /^stalker@/);
    next.active = 14;
    driver.saveConfiguration(next);
    f.host.loadChannels();
    assert.equal(f.host.providerGetItem("favoritesArray"), "last-favorites");
    assert.equal(f.host.__ottSourceIdentity.current(f.host), identity);
});

test("actual host reload and replacement reject every displaced Stalker stage", () => {
    for (const stage of ["handshake", "retry", "catalog", "guide"]) {
        const f = startup();
        f.host.loadProv();
        if (stage === "retry") f.requests[0].resolve({ result: null });
        if (stage === "catalog" || stage === "guide")
            f.requests[0].resolve({ result: {} });
        let guides = 0;
        if (stage === "guide") {
            f.requests[1].resolve(catalog());
            f.host.getChannelEpg(42, () => guides++);
        }
        const pending = f.requests.at(-1);
        f.host.loadProv("demo");
        assert.equal(pending.aborts, 1);
        const count = f.requests.length;
        const completed = f.completed;
        pending.resolve(catalog(7));
        pending.reject();
        assert.equal(f.requests.length, count);
        assert.equal(f.completed, completed);
        assert.equal(guides, 0);
        assert.equal(f.host.__ottActiveProviderDriver.id, "demo");
        assert.deepEqual(Array.from(f.host.cList), [900000001, 900000002]);
    }
    const f = startup();
    f.host.loadProv();
    f.requests[0].resolve({ result: {} });
    f.requests[1].resolve(catalog());
    f.host.loadChannels();
    f.requests[2].resolve({ result: {} });
    f.requests[3].resolve({ result: null });
    assert.deepEqual(Array.from(f.host.cList), []);
    assert.equal(f.host.getChannelUrl(42), "");
    assert.equal(f.completed, 2);
});

test("teardown reentry keeps the newer managed source selection authoritative", () => {
    for (const newer of ["demo", "stalker", "m3u"]) {
        const f = startup();
        f.host.loadProv();
        const pending = f.requests[0];
        const abort = pending.abort.bind(pending);
        pending.abort = () => {
            abort();
            if (newer !== "demo") f.saved.set("ottplayprov", newer);
            f.host.loadProv(newer);
        };
        f.saved.set("ottplayprov", "xtream");
        f.host.loadProv("xtream");
        assert.equal(pending.aborts, 1);
        assert.equal(f.host.__ottActiveProviderDriver?.id ?? null, newer);
        const requestCount = f.requests.length;
        const command = f.host.__ottCommandChannelLoad;
        pending.resolve(catalog(7));
        pending.reject();
        assert.equal(f.requests.length, requestCount);
        assert.equal(f.host.__ottCommandChannelLoad, command);
        if (newer === "demo") {
            assert.deepEqual(Array.from(f.host.cList), [900000001, 900000002]);
            assert.equal(f.completed, 1);
            assert.equal(f.host.commandChannelsReady, true);
            assert.equal(f.requests.length, 1);
        } else if (newer === "stalker") {
            assert.equal(f.requests.length, 2);
            f.requests[1].resolve({ result: {} });
            f.requests[2].resolve(catalog(9));
            assert.equal(f.completed, 1);
            assert.deepEqual(Array.from(f.host.cList), [9]);
            assert.equal(f.host.commandChannelsReady, true);
        } else {
            assert.equal(f.requests.length, 1);
            assert.equal(f.scripts.length, 0);
            assert.equal(f.completed, 0);
            assert.equal(f.host.commandChannelsReady, false);
        }
    }
});

function classicFixture(
    url = "https://portal.test/stalker_portal/c/",
    options = {}
) {
    const f = fixture({
        config: { mac: "02:00:00:00:00:01", portal: url },
        language: options.language,
    });
    if (options.native) f.ports.m3u = { native: () => true };
    f.driver.load((catalog, error) => {
        f.catalog = catalog;
        f.error = error;
    });
    f.respond = (value) => f.requests.at(-1).done({ js: value });
    f.request = () =>
        options.native
            ? f.requests.at(-1).settings
            : JSON.parse(f.requests.at(-1).settings.data);
    f.action = () => new URL(f.request().url).searchParams.get("action");
    f.authorize = () => {
        assert.equal(f.action(), "handshake");
        f.respond({ token: "demo-token" });
        assert.equal(f.action(), "get_profile");
        assert.equal(f.request().headers.Authorization, "Bearer demo-token");
        assert.match(
            f.request().headers.Cookie,
            /mac=02%3A00%3A00%3A00%3A00%3A01/
        );
        f.respond({ blocked: "0", id: "1", status: "0" });
        assert.equal(f.action(), "get_genres");
        f.respond([{ id: "1", title: "News" }]);
        assert.equal(f.action(), "get_all_channels");
    };
    f.channel = (id, temporary = true) => ({
        cmd: temporary
            ? "ffmpeg http://localhost/ch/" + id
            : "https://media.test/" + id + ".m3u8",
        id: String(id),
        logo: "/logo.png",
        name: "Channel " + id,
        tv_genre_id: "1",
        use_http_tmp_link: temporary ? 1 : 0,
    });
    f.finish = (rows = [f.channel(42)]) =>
        f.respond({ data: rows, total_items: rows.length });
    return f;
}

test("classic portal requests use the selected interface language", () => {
    for (const language of ["ru", "ar", "nb", "fil", undefined]) {
        for (const native of [false, true]) {
            const f = classicFixture(undefined, { language, native });
            assert(
                f
                    .request()
                    .headers.Cookie.includes("stb_lang=" + (language || "en"))
            );
            f.respond({ token: "demo-token" });
            assert(
                f
                    .request()
                    .headers.Cookie.includes("stb_lang=" + (language || "en"))
            );
        }
    }
});

test("classic URL forms use the shared MAG protocol through browser or native transport", () => {
    for (const url of [
        "https://portal.test/c/",
        "https://portal.test/stalker_portal/c/index.html",
        "https://portal.test/stalker_portal",
        "https://portal.test/stalker_portal/server/load.php",
        "https://portal.test/portal.php",
    ]) {
        for (const native of [false, true]) {
            const f = classicFixture(url, { native });
            f.authorize();
            f.finish();
            assert.equal(f.error, undefined);
            assert.equal(f.catalog.channels[42].channel_name, "Channel 42");
            assert.equal(f.catalog.channels[42].category.name, "News");
            assert.equal(
                f.catalog.channels[42].logo,
                "https://portal.test/logo.png"
            );
            assert.equal(f.driver.logo(42), "https://portal.test/logo.png");
            assert.match(f.driver.stream(42), /^ottplay-stalker:/);
            assert.equal(f.driver.archive(42, 1, 2), "");
            if (!native)
                assert(
                    f.requests.every((r) => r.settings.url === "/stalker/api")
                );
        }
    }
});

test("classic catalog pages, temporary links and EPG are projected without leaking session credentials", () => {
    const f = classicFixture();
    f.authorize();
    f.respond(null);
    assert.equal(f.action(), "get_ordered_list");
    f.respond({ data: [f.channel(42)], total_items: 2 });
    assert.equal(new URL(f.request().url).searchParams.get("p"), "2");
    f.respond({ data: [f.channel(43)], total_items: 2 });
    assert.deepEqual(clone(f.catalog.ids), [42, 43]);
    const ref = f.driver.stream(42);
    assert(!ref.includes("demo-token"));
    assert(!ref.includes("02:00"));
    let result;
    f.driver.resolveStream(ref, (value) => (result = value));
    assert.equal(f.action(), "create_link");
    assert.equal(
        new URL(f.request().url).searchParams.get("cmd"),
        "ffmpeg http://localhost/ch/42"
    );
    f.respond({ cmd: "ffmpeg https://media.test/signed.m3u8" });
    assert.equal(result, "https://media.test/signed.m3u8");
    let guide;
    f.driver.guide(42, (value) => (guide = value));
    assert.equal(f.action(), "get_short_epg");
    f.respond([
        {
            name: "Bulletin",
            start_timestamp: "1700000000",
            stop_timestamp: "1700003600",
        },
    ]);
    assert.equal(guide.length, 1);
    assert.equal(guide[0].time, 1700000000);
});

test("classic bulk loading falls back once on unsupported HTTP responses but not auth denial", () => {
    for (const status of [0, 404, 405, 413, 500, 501, 502, 503, 504]) {
        const f = classicFixture();
        f.authorize();
        f.requests.at(-1).fail({ status });
        assert.equal(f.action(), "get_ordered_list");
        assert.equal(new URL(f.request().url).searchParams.get("p"), "1");
        f.finish();
        assert.deepEqual(clone(f.catalog.ids), [42]);
    }
    for (const status of [401, 403]) {
        const f = classicFixture();
        f.authorize();
        const before = f.requests.length;
        f.requests.at(-1).fail({ status });
        assert.equal(f.requests.length, before);
        assert.equal(f.error, "stalker-connect");
    }
});

test("classic HLS preference preserves channel identity and adapts direct and resolved gateway links", () => {
    const f = classicFixture();
    f.authorize();
    const url =
        "https://portal.test/play/live.php?mac=fixture&stream=42&extension=ts&play_token=opaque";
    f.finish([
        { ...f.channel(42, false), cmd: "ffmpeg " + url },
        f.channel(43),
    ]);
    let result;
    f.driver.resolveStream(f.driver.stream(42), (value) => (result = value));
    assert.equal(result, url.replace("extension=ts", "extension=m3u8"));
    f.driver.resolveStream(f.driver.stream(43), (value) => (result = value));
    f.respond({ cmd: "ffmpeg " + url });
    assert.equal(result, url.replace("extension=ts", "extension=m3u8"));
    assert.deepEqual(clone(f.catalog.ids), [42, 43]);
});

test("classic direct links skip create_link, cancelled and replaced sessions cannot publish", () => {
    const f = classicFixture();
    f.authorize();
    f.finish([f.channel(42, false), f.channel(43)]);
    const before = f.requests.length;
    let result;
    f.driver.resolveStream(f.driver.stream(42), (value) => (result = value));
    assert.equal(result, "https://media.test/42.m3u8");
    assert.equal(f.requests.length, before);
    result = undefined;
    const cancel = f.driver.resolveStream(
        f.driver.stream(43),
        (value) => (result = value)
    );
    const pending = f.requests.at(-1);
    cancel();
    pending.done({ js: { cmd: "https://media.test/stale" } });
    assert.equal(pending.aborts, 1);
    assert.equal(result, undefined);
    f.driver.resolveStream(f.driver.stream(43), (value) => (result = value));
    const old = f.requests.at(-1);
    f.driver.saveCredentials({
        password: "",
        server: "https://other.test/c/",
        username: "02:00:00:00:00:02",
    });
    old.done({ js: { cmd: "https://media.test/stale" } });
    assert.equal(old.aborts, 1);
    assert.equal(result, undefined);
});

test("classic profile switch cancels links and handshakes even for identical accounts", () => {
    for (const stage of ["handshake", "link"]) {
        const f = classicFixture();
        let links = 0;
        if (stage === "link") {
            f.authorize();
            f.finish();
            f.driver.resolveStream(f.driver.stream(42), () => links++);
        }
        const pending = f.requests.at(-1);
        const config = f.driver.configuration();
        config.portals[1] = clone(config.portals[0]);
        config.active = 1;
        assert(f.driver.saveConfiguration(config));
        assert.equal(pending.aborts, 1);
        const count = f.requests.length;
        pending.done({
            js:
                stage === "link"
                    ? { cmd: "https://media.test/stale" }
                    : { token: "stale" },
        });
        assert.equal(f.requests.length, count);
        assert.equal(links, 0);
        assert.equal(f.driver.stream(42), "");
        f.driver.load(() => {});
        assert.equal(f.action(), "handshake");
        assert.equal(f.request().headers.Authorization, undefined);
    }
});

test("classic startup recovers one empty handshake, preserving saved settings and channel loading", () => {
    for (const empty of [null, {}, []]) {
        const config = JSON.stringify({
            mac: "02:00:00:00:00:01",
            portal: "https://portal.test/c/",
        });
        const f = startup({ stalkerstalker_data: config });
        f.host.URL = URL;
        f.host.loadProv();
        f.requests.at(-1).resolve({ js: empty });
        assert.equal(f.requests.length, 2);
        assert.equal(
            f.completed,
            0,
            "empty handshake must not publish an empty catalog"
        );
        f.requests.at(-1).resolve({ js: { token: "fixture-token" } });
        f.requests
            .at(-1)
            .resolve({ js: { blocked: "0", id: "1", status: "0" } });
        f.requests.at(-1).resolve({ js: [{ id: "1", title: "Demo" }] });
        f.requests.at(-1).resolve({
            js: {
                data: [
                    {
                        cmd: "https://media.test/demo.m3u8",
                        id: "42",
                        name: "Demo channel",
                        tv_genre_id: "1",
                        use_http_tmp_link: 0,
                    },
                ],
                total_items: 1,
            },
        });
        assert.equal(f.completed, 1);
        assert.deepEqual(Array.from(f.host.cList), [42]);
        assert.deepEqual(f.errors, []);
        assert.equal(f.saved.get("stalkerstalker_data"), config);
    }
});

test("classic empty-handshake recovery is bounded and is cancelled with its owner", () => {
    const f = classicFixture();
    f.respond({});
    f.respond({});
    assert.equal(f.requests.length, 2);
    assert.equal(f.error, "stalker-connect");
    const denied = classicFixture();
    denied.respond({ error: "access_denied" });
    assert.equal(denied.requests.length, 1);
    assert.equal(denied.error, "stalker-connect");
    const cancelled = classicFixture();
    cancelled.respond({});
    const retry = cancelled.requests.at(-1);
    cancelled.driver.dispose();
    retry.done({ js: { token: "stale" } });
    assert.equal(retry.aborts, 1);
    assert.equal(cancelled.requests.length, 2);
    assert.equal(cancelled.catalog, undefined);
});

test("classic rejects blocked profiles, repeated pages and link failures", () => {
    const blocked = classicFixture();
    blocked.respond({ token: "t" });
    blocked.respond({ id: "1", status: "1" });
    assert.equal(blocked.error, "stalker-connect");
    assert.equal(blocked.requests.length, 2);
    const repeated = classicFixture();
    repeated.authorize();
    repeated.respond(null);
    repeated.respond({ data: [repeated.channel(42)], total_items: 100 });
    repeated.respond({ data: [repeated.channel(42)], total_items: 100 });
    assert.equal(repeated.error, "stalker-connect");
    const f = classicFixture();
    f.authorize();
    f.finish();
    let result;
    f.driver.resolveStream(f.driver.stream(42), (value) => (result = value));
    f.respond({ error: "link_fault" });
    assert.equal(result, null);
});

test("classic renews an expired token once for playback, never retries denied profiles", () => {
    const f = classicFixture();
    f.authorize();
    f.finish();
    let result;
    f.driver.resolveStream(f.driver.stream(42), (value) => (result = value));
    f.requests.at(-1).fail({ status: 401 });
    f.authorize();
    f.finish();
    assert.equal(f.action(), "create_link");
    f.requests.at(-1).fail({ status: 403 });
    assert.equal(result, null);
});

console.log("PASS " + groups + " Stalker driver scenario groups");
