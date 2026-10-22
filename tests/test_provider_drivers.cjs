"use strict";
const assert = require("node:assert/strict");
const {
    fixture,
    integrationFixture,
} = require("./helpers/provider-driver-fixture.cjs");
const captured = require("./fixtures/xtream/legacy.json");
const clone = (value) => JSON.parse(JSON.stringify(value));
const config = {
    password: "x?&",
    server: "https://xc.test/folder",
    username: "a/b",
};
const stored = (value = config) => ({
    xtreamxtream_data: JSON.stringify(value),
});
let assertions = 0;
function test(name, run) {
    run();
    assertions++;
    console.log("PASS provider drivers: " + name);
}

test("registry only resolves explicit drivers and does not accept prototype names", () => {
    const f = fixture();
    const registry = f.host.__ottProviderDrivers.registry;
    assert.deepEqual(
        Array.from(registry.ids()),
        Array.from(f.host.__ottProviderDriverProfiles, (profile) => profile.id)
    );
    assert.equal(registry.ids().length, 51);
    assert.equal(registry.has("constructor"), false);
    assert.equal(registry.has("m3u"), true);
    assert.throws(() => registry.register("demo", () => {}), /Duplicate/);
    assert.throws(() => registry.create("unknown", {}, {}), /Unsupported/);
});

test("factory reentry cannot publish an instance after a newer selection", () => {
    const f = fixture(stored());
    let entered = false;
    f.host._ = (value) => {
        if (!entered && value === "Demo — moving test pattern") {
            entered = true;
            f.mount("xtream");
        }
        return value;
    };
    const retired = f.mount("demo");
    assert(entered);
    assert.equal(f.host.__ottActiveProviderDriver.id, "xtream");
    assert.equal(f.host.p_pref, "xtream");
    assert.equal(retired.stream(900000001), "");
    f.host.providerSetItem("marker", "new");
    assert.equal(f.saved.get("xtreammarker"), "new");
    assert.equal(f.saved.has("demomarker"), false);
});

test("KB retains Cyrillic adult category classification", () => {
    const f = fixture();
    f.mount("kb-team");
    assert(f.host.parental.test("ХХХ"));
    assert(f.host.parental.test("Adults"));
    assert(!f.host.parental.test("News"));
});

test("persisted preferences use the active provider namespace and owned storage", () => {
    const f = fixture(stored());
    f.host.ottpStorage = { get: f.host.stbGetItem, set: f.host.stbSetItem };
    f.host.stbGetPersistedItem = (key) => f.saved.get(key) ?? null;
    f.mount("demo");
    f.host.providerSetItem("aspect-proof", "fill");
    const previous = f.host.providerGetPersistedItem;
    assert.equal(previous("aspect-proof"), "fill");
    f.mount("xtream");
    assert.equal(
        previous("aspect-proof"),
        null,
        "Retired source is unreadable"
    );
    assert.equal(f.host.providerGetPersistedItem("aspect-proof"), null);
    f.host.providerSetItem("aspect-proof", "fit");
    assert.equal(f.host.providerGetPersistedItem("aspect-proof"), "fit");
    f.host.stbGetItem = () => "unowned";
    assert.equal(f.host.providerGetPersistedItem("aspect-proof"), null);
});

for (const [index, row] of captured.cases.entries())
    test("Xtream captured catalog " + index, () => {
        const f = fixture(stored(row.input.config || config));
        f.mount("xtream");
        let callbacks = 0;
        f.host.getChanelsArray(() => callbacks++);
        assert.equal(f.host.$.ajax, f.ajax);
        f.requests[0].resolve(row.input.account);
        assert.deepEqual(
            clone({ callbacks, calls: f.calls, errors: f.errors }),
            {
                callbacks: row.expected.callbacks,
                calls: row.expected.calls,
                errors: row.expected.errors,
            }
        );
        assert.equal(new Set(f.host.cList).size, f.host.cList.length);
        for (const id of f.host.cList) {
            const channel = f.host.chanels[id];
            assert(channel.itemId.startsWith("xtream:stream:"));
            assert.equal(
                channel.epg,
                channel.itemId.slice("xtream:stream:".length)
            );
            assert(f.host.cats[channel.category.name].includes(id));
            assert(channel.groupId.startsWith("xtream:category:"));
        }
        assert.equal(
            typeof f.host.getMediaArray,
            "function",
            "standalone Xtream exposes the lazy media library without delaying live startup"
        );
    });

for (const [index, row] of captured.guide.entries())
    test("Xtream captured short guide " + index, () => {
        const f = fixture(stored({ ...config, server: "https://xc.test" }));
        f.mount("xtream");
        f.host.getChanelsArray(() => {});
        f.requests[0].resolve({
            live_streams: [{ name: "Guide channel", stream_id: "42" }],
        });
        const id = f.host.cList[0];
        let result;
        f.host.getEPGchanel(id, (_id, data) => {
            result = { data, id: "channel" };
        });
        f.requests[1].resolve(row.input);
        assert.deepEqual(
            clone({ calls: f.calls.slice(1), output: result }),
            row.expected
        );
    });

test("instance replacement aborts old catalog/guide and delayed responses cannot revive them", () => {
    const f = fixture(stored());
    const old = f.mount("xtream");
    let completions = 0;
    old.load(() => completions++);
    f.mount("demo");
    assert.equal(f.requests[0].aborts, 1);
    f.host.getChanelsArray(() => completions++);
    f.requests[0].resolve({
        live_streams: [{ name: "Obsolete", stream_id: 1 }],
    });
    assert.equal(completions, 1);
    assert.deepEqual(Array.from(f.host.cList), [900000001, 900000002]);
    assert.equal(old.stream(1), "");
    const current = f.mount("xtream");
    current.load(() => completions++);
    f.requests[1].resolve({
        live_streams: [{ name: "Current", stream_id: 42 }],
    });
    const channel = 42;
    current.guide(channel, () => completions++);
    f.mount("demo");
    assert.equal(f.requests[2].aborts, 1);
    f.requests[2].resolve({ epg_listings: [] });
    assert.equal(completions, 2);
});

test("catalog reload, credential save and dispose retire pending requests", () => {
    const f = fixture(stored());
    const driver = f.mount("xtream");
    let count = 0;
    driver.load(() => count++);
    driver.load(() => count++);
    assert.equal(f.requests[0].aborts, 1);
    f.requests[0].resolve({ live_streams: [] });
    assert.equal(count, 0);
    driver.saveCredentials({ ...config, username: "new" });
    assert.equal(f.requests[1].aborts, 1);
    f.requests[1].resolve({ live_streams: [] });
    driver.load(() => count++);
    assert(f.requests[2].settings.url.includes("username=new"));
    driver.dispose();
    f.requests[2].resolve({ live_streams: [] });
    assert.equal(count, 0);
});

test("demo scopes storage and exposes identical playable catalog without transport", () => {
    const f = fixture({ m3um3uArr: "private playlist" });
    const driver = f.mount("demo");
    f.host.providerSetItem("primaryIndex", "1");
    assert.equal(f.saved.get("demoprimaryIndex"), "1");
    assert.equal(f.saved.get("m3um3uArr"), "private playlist");
    f.host.getChanelsArray(() => {});
    f.host.getChanelsArray(() => {});
    assert.deepEqual(Array.from(f.host.cList), [900000001, 900000002]);
    assert.equal(
        driver.stream(900000001),
        "https://liminal-sketch-vv8r.here.now/demo/pattern.mp4"
    );
    assert.equal(
        driver.stream(900000002),
        "https://liminal-sketch-vv8r.here.now/demo/pattern.m3u8"
    );
    assert.deepEqual(f.requests, []);
    assert.equal(f.host.$.ajax, f.ajax);
});

test("credentials editor masks, trims and saves only at explicit save; cancel is inert", () => {
    const f = fixture(stored());
    f.mount("xtream");
    f.host.popupActions = [f.host.noProvParam, () => {}];
    f.host.popupArray = ["", ""];
    f.host.popupDetail = ["", ""];
    f.host.duneAddSettings(1);
    assert.equal(f.host.popupArray[1], "Xtream Codes settings: xc.test (a/b)");
    const edit = f.host.popupActions[1];
    edit();
    assert.equal(f.host.listArray[2], "Password: ********");
    f.host.selIndex = 2;
    f.host.listKeyHandler(f.host.keys.ENTER);
    assert.equal(f.edits[0].password, true);
    f.host.editvar = "  different password  ";
    f.host.setEdit();
    f.host.listKeyHandler(f.host.keys.RETURN);
    assert.equal(
        JSON.parse(f.saved.get("xtreamxtream_data")).password,
        config.password
    );
    edit();
    f.host.selIndex = 0;
    f.host.listKeyHandler(f.host.keys.ENTER);
    f.host.editvar = " https://changed.test ";
    f.host.setEdit();
    f.host.selIndex = 4;
    f.host.listKeyHandler(f.host.keys.ENTER);
    assert.equal(
        JSON.parse(f.saved.get("xtreamxtream_data")).server,
        "https://changed.test"
    );
    assert.equal(
        f.host.popupArray[1],
        "Xtream Codes settings: changed.test (a/b)"
    );
    assert.equal(f.reloads, 1);
    edit();
    f.host.selIndex = 1;
    f.host.listKeyHandler(f.host.keys.ENTER);
    const retiredEdit = f.host.setEdit;
    const retiredKey = f.host.listKeyHandler;
    f.mount("demo");
    f.host.editvar = "stale";
    retiredEdit();
    f.host.selIndex = 4;
    retiredKey(f.host.keys.ENTER);
    assert.equal(
        JSON.parse(f.saved.get("xtreamxtream_data")).username,
        config.username
    );
    assert.equal(f.reloads, 1);
});

test("missing credentials and blocked URL open settings without network or completion", () => {
    for (const initial of [{}, stored()]) {
        const f = fixture(initial);
        f.host.checkProviderUrl = () => false;
        f.mount("xtream");
        let count = 0;
        f.host.getChanelsArray(() => count++);
        assert.equal(f.host.listCaption.innerHTML, "Xtream Codes Provider");
        assert.equal(count, 0);
        assert.equal(f.requests.length, 0);
    }
});

test("actual loadProv/loadChannels use instance paths without script evaluation or ajax scope patching", () => {
    const f = integrationFixture("xtream");
    f.host.loadProv();
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.scripts, []);
    assert.equal(f.ajaxWrites, 0);
    assert.equal(f.host.commandChannelsReady, false);
    f.requests[0].resolve({ live_streams: [{ name: "Live", stream_id: 7 }] });
    assert.equal(f.completed, 1);
    assert.equal(f.host.commandChannelsReady, true);
    assert.equal(
        f.host.getChannelUrl(f.host.cList[0]),
        "https://xc.test/folder/live/a%2Fb/x%3F%26/7.m3u8"
    );
    const oldLoad = f.host.getChanelsArray;
    f.host.loadChannels();
    assert.equal(f.requests.length, 2);
    f.host.loadProv("demo");
    assert.equal(f.requests[1].aborts, 1);
    assert.equal(f.completed, 2);
    assert.equal(f.host.commandChannelsReady, true);
    const snapshot = clone(f.host.chanels);
    f.requests[1].resolve({ live_streams: [{ name: "Stale", stream_id: 8 }] });
    oldLoad(() => {
        throw new Error("retired loader completed");
    });
    assert.deepEqual(clone(f.host.chanels), snapshot);
    assert.equal(f.completed, 2);
    assert.equal(f.ajaxWrites, 0);
    assert.deepEqual(f.scripts, []);
    // The final built-in playlist source also resolves through an owned instance.
    f.saved.set("ottplayprov", "m3u");
    f.host.loadProv("m3u");
    assert.equal(f.host.__ottActiveProviderDriver.id, "m3u");
    assert.deepEqual(f.scripts, []);
});

test("managed M3U loading stays visible through slow direct/proxy stages and closes on success or failure", () => {
    const f = integrationFixture("m3u", {
        m3um3uArr: JSON.stringify({
            active: 0,
            M3Us: [{ www: "https://playlist.test/list.m3u" }],
        }),
    });
    const body = "#EXTM3U\n#EXTINF:-1,One\nhttps://stream.test/one\n";
    f.host.loadProv();
    f.advanceTimers(5000);
    assert.equal(f.panels["#launch"].visible, true);
    f.requests[0].reject();
    const pending = f.requests[1];
    assert(pending.settings.url.endsWith("/m3u/cp.php"));
    f.advanceTimers(30000);
    assert.equal(f.panels["#launch"].visible, true);
    assert.equal(f.completed, 0);
    pending.resolve(body);
    assert.equal(f.panels["#launch"].visible, false);
    assert.equal(f.completed, 1);
    f.host.loadChannels();
    assert.equal(f.panels["#dialogbox"].visible, true);
    f.requests.at(-1).reject();
    f.advanceTimers(30000);
    assert.equal(f.panels["#dialogbox"].visible, true);
    f.requests.at(-1).reject();
    assert.equal(f.panels["#dialogbox"].visible, false);
    assert.equal(f.completed, 2);
    assert.equal(f.errors.length, 1);
});

test("all managed provider kinds settle loader only on a terminal catalog result", () => {
    const profiles = fixture().host.__ottProviderDriverProfiles;
    const representatives = new Map(
        profiles.map((profile) => [profile.kind, profile.id])
    );
    assert.equal(representatives.size, 13);
    for (const [kind, id] of representatives) {
        const f = integrationFixture(id);
        const loadingPanel = ["plex", "vportal", "offline"].includes(kind)
            ? "#dialogbox"
            : "#launch";
        f.host.infoBox = () => {};
        let settingsOpened = 0;
        f.host.showPage = () => {
            assert.equal(f.panels["#launch"].visible, false, kind);
            settingsOpened++;
        };
        const driver = f.mount(id);
        let deliver;
        driver.load = (callback) => {
            deliver = callback;
        };
        f.host.loadChannels();
        f.advanceTimers(30000);
        assert.equal(f.panels[loadingPanel].visible, true, kind);
        deliver(
            { channels: {}, groupOrder: [], groups: {}, ids: [] },
            undefined,
            true
        );
        assert.equal(
            f.panels[loadingPanel].visible,
            true,
            kind + ": partial catalog"
        );
        assert.equal(f.completed, 0, kind);
        deliver(undefined, "network");
        assert.equal(f.panels[loadingPanel].visible, false, kind);
        assert.equal(f.panels["#launch"].visible, false, kind);
        if (kind === "plex" || kind === "vportal") {
            assert.equal(driver.libraryReady(), false);
            assert.equal(f.completed, 0, "failed library must not open TV");
            assert.equal(settingsOpened, 1, "failed library opens settings");
            assert.equal(f.errors.length, 1, "failed library reports error");
        } else {
            assert.equal(f.completed, 1, kind);
        }
    }
});

test("missing credentials settle before opening settings and cleanup preserves the new dialog", () => {
    for (const id of ["m3u", "xtream", "stalker"]) {
        const f = integrationFixture(id, { xtreamxtream_data: "{}" });
        let opened = 0;
        f.host.showPage = () => {
            assert.equal(f.panels["#launch"].visible, false, id);
            opened++;
            f.host.$("#dialogbox").html("settings").show();
        };
        f.host.loadProv();
        assert.equal(f.completed, 0, id);
        assert.equal(f.requests.length, 0, id);
        assert(opened > 0, id);
        f.advanceTimers(30000);
        f.host.__ottProviderRuntime.classic.dispose();
        assert.equal(f.panels["#dialogbox"].visible, true, id);
    }
});

test("catalog cancel and provider replacement cannot dismiss a newer playback prompt", () => {
    const f = integrationFixture("xtream");
    f.host.loadProv();
    f.host.__ottProviderRuntime.classic.dispose();
    assert.equal(f.panels["#launch"].visible, false);
    assert.equal(f.requests[0].aborts, 1);
    f.host.loadProv();
    const old = f.requests.at(-1);
    assert.equal(f.panels["#dialogbox"].visible, true);
    const loaded = f.host.onChannelsLoaded;
    f.host.onChannelsLoaded = () => {
        loaded();
        f.host.$("#dialogbox").html("playback prompt").show();
    };
    f.host.loadProv("demo");
    assert.equal(old.aborts, 1);
    assert.equal(f.panels["#dialogbox"].visible, true);
    old.resolve({ live_streams: [] });
    f.advanceTimers(30000);
    f.host.__ottProviderRuntime.classic.dispose();
    assert.equal(f.panels["#dialogbox"].visible, true);
    assert.equal(f.panels["#dialogbox"].html, "playback prompt");
});

test("repeated catalog reloads replace the spinner after both pending and completed loads", () => {
    const f = integrationFixture("xtream");
    const channels = { live_streams: [{ name: "Live", stream_id: 7 }] };
    f.host.loadProv();
    f.requests[0].resolve(channels);
    f.host.loadChannels();
    const pending = f.requests.at(-1);
    assert.equal(f.panels["#dialogbox"].visible, true);
    f.host.loadChannels();
    assert.equal(pending.aborts, 1);
    assert.equal(f.panels["#dialogbox"].visible, true);
    pending.resolve(channels);
    f.advanceTimers(30000);
    assert.equal(f.panels["#dialogbox"].visible, true);
    f.requests.at(-1).resolve(channels);
    assert.equal(f.panels["#dialogbox"].visible, false);
    f.host.loadChannels();
    assert.equal(f.panels["#dialogbox"].visible, true);
    f.requests.at(-1).resolve(channels);
    assert.equal(f.panels["#dialogbox"].visible, false);
    assert.equal(f.completed, 3);
});

test("unmanaged dealer scripts retain the bounded compatibility fallback", () => {
    const f = integrationFixture("demo");
    f.mount("demo");
    f.host.__ottActiveProviderDriver = null;
    f.host.getChannelsArray = () => {};
    f.host.loadChannels();
    f.advanceTimers(2999);
    assert.equal(f.panels["#launch"].visible, true);
    f.advanceTimers(1);
    assert.equal(f.panels["#launch"].visible, false);
    assert.equal(f.completed, 0);
});

test("driver-owned channels cannot be changed by classic view normalization", () => {
    const f = fixture(stored());
    const driver = f.mount("xtream");
    f.host.getChanelsArray(() => {});
    f.requests[0].resolve({ live_streams: [{ name: "Live", stream_id: 7 }] });
    const id = f.host.cList[0];
    const original = driver.stream(id);
    f.host.chanels[id].url = "https://mutated.test";
    f.host.chanels[id].epg = "other";
    f.host.chanels[id].category.name = "Modified";
    assert.equal(driver.stream(id), original);
    driver.guide(id, () => {});
    assert(f.requests[1].settings.url.includes("stream_id=7"));
});

test("failed reload and replaced credentials cannot resurrect a previous account catalog", () => {
    for (const changeAccount of [false, true]) {
        const f = fixture(stored());
        const driver = f.mount("xtream");
        f.host.getChanelsArray(() => {});
        f.requests[0].resolve({
            live_streams: [{ name: "Old account", stream_id: 42 }],
        });
        const oldId = f.host.cList[0];
        if (changeAccount)
            driver.saveCredentials({
                password: "secret",
                server: "https://new.test",
                username: "new",
            });
        f.host.cList = [];
        f.host.chanels = {};
        f.host.getChanelsArray(() => {});
        f.requests[1].reject();
        assert.deepEqual(Array.from(f.host.cList), []);
        assert.deepEqual(clone(f.host.chanels), {});
        assert.equal(driver.stream(oldId), "");
        assert.deepEqual(f.errors, ["Failed to connect to Xtream API server"]);
        f.requests[1].resolve({
            live_streams: [{ name: "Late", stream_id: 10 }],
        });
        assert.deepEqual(Array.from(f.host.cList), []);
    }
});

test("all33 operator instances preserve660 transport contracts with provider-owned channel identities", () => {
    const baseline = require("./fixtures/operator/sessions-before-core.json");
    const audit = fixture().host.__ottProviderDriverProfiles.filter(
        (profile) => profile.kind === "operator"
    );
    assert.equal(audit.length, 33);
    let compared = 0;
    for (const row of baseline.cases) {
        for (const outcome of row.outcomes) {
            for (const file of outcome.providers) {
                const id = file.slice(
                    "providers/".length,
                    -"/provider.js".length
                );
                const profile = audit.find((item) => item.id === id);
                assert(
                    profile,
                    "every captured generic profile is registered: " + id
                );
                const config = row.input.config || {
                    m3u: "https://operator.test/fallback.m3u",
                    pass: "x?&",
                    server: "https://operator.test/base",
                    user: "a/b",
                };
                const f = fixture({
                    [profile.prefix + "cfg"]: JSON.stringify(config),
                });
                const driver = f.mount(id);
                let callbacks = 0,
                    failure = null;
                try {
                    f.host.getChannelsArray(() => callbacks++);
                    for (let index = 0; index < f.requests.length; index++) {
                        const request = f.requests[index],
                            settings = request.settings;
                        if (settings.dataType === "json") {
                            if (row.input.apiFailed) request.reject();
                            else request.resolve(row.input.account);
                        } else if (
                            settings.method === "post"
                                ? row.input.proxyFailed
                                : row.input.playlistFailed
                        )
                            request.reject();
                        else
                            request.resolve(
                                row.input.playlist ||
                                    '#EXTM3U\n#EXTINF:-1 tvg-id="m" group-title="Playlist",Fallback\nhttps://stream.test/m\n'
                            );
                    }
                } catch (error) {
                    failure = { message: error.message, name: error.name };
                }
                const result = clone({
                    callbacks,
                    calls: f.requests.map(({ settings }) => ({
                        data: settings.data || null,
                        dataType: settings.dataType || null,
                        method: settings.method || settings.type || "GET",
                        timeout: settings.timeout,
                        url: settings.url,
                    })),
                    channels: f.host.channels,
                    config: driver.configuration(),
                    errors: f.errors,
                    failure,
                    groupOrder: f.host.catsArray,
                    groups: f.host.cats,
                    ids: f.host.cList,
                });
                const numericLabel =
                    row.name ===
                    "truthy numeric names and categories use JS coercion";
                for (const field of [
                    "callbacks",
                    "calls",
                    "config",
                    "errors",
                    "failure",
                ])
                    assert.deepEqual(
                        result[field],
                        numericLabel && field === "failure"
                            ? null
                            : numericLabel && field === "callbacks"
                              ? 1
                              : outcome.expected[field],
                        id + ": " + row.name + " " + field
                    );
                assert.equal(new Set(result.ids).size, result.ids.length);
                const apiCatalog = result.ids.some(
                    (key) => result.channels[key].itemId
                );
                if (
                    !apiCatalog &&
                    !(row.input.account && row.input.account.live_streams)
                ) {
                    for (const field of [
                        "channels",
                        "ids",
                        "groups",
                        "groupOrder",
                    ])
                        assert.deepEqual(
                            result[field],
                            outcome.expected[field],
                            id + " playlist " + field
                        );
                }
                for (const key of result.ids) {
                    const channel = result.channels[key];
                    assert(result.groups[channel.category.name].includes(key));
                    if (!apiCatalog) continue;
                    assert.equal(
                        channel.itemId,
                        "xtream:stream:" + channel.epg
                    );
                    assert(channel.groupId.startsWith("xtream:category:"));
                    assert.equal(typeof channel.channel_name, "string");
                }
                assert.equal(f.host.$.ajax, f.ajax);
                compared++;
            }
        }
    }
    assert.equal(compared, 660);
});

test("operator API profiles retain duplicate titles and renamed channel references", () => {
    const profiles = fixture().host.__ottProviderDriverProfiles.filter(
        (profile) =>
            profile.kind === "operator" || profile.kind === "xtream-fallback"
    );
    for (const profile of profiles) {
        const f = fixture({
            [profile.prefix + "cfg"]: JSON.stringify({
                m3u: "",
                pass: "secret",
                server: "https://operator.test",
                user: "viewer",
            }),
        });
        f.mount(profile.id);
        f.host.getChannelsArray(() => {});
        f.requests[0].resolve({
            categories: [{ category_id: 7, category_name: "News" }],
            live_streams: [
                { category_id: 7, name: "News", stream_id: 11 },
                { category_id: 7, name: "News", stream_id: 22 },
            ],
        });
        assert.deepEqual(Array.from(f.host.cList), [11, 22], profile.id);
        const first = clone(f.host.channels[11]);
        f.host.getChannelsArray(() => {});
        f.requests[1].resolve({
            categories: [{ category_id: 7, category_name: "Actualités" }],
            live_streams: [
                { category_id: 7, name: "Renamed", stream_id: 22 },
                { category_id: 7, name: "Новости", stream_id: 11 },
            ],
        });
        assert.deepEqual(Array.from(f.host.cList), [22, 11]);
        assert.equal(f.host.channels[11].itemId, first.itemId);
        assert.equal(f.host.channels[11].groupId, first.groupId);
        assert.equal(f.host.channels[11].url, first.url);
    }
});

test("generic cancellation rejects stale success/failure at API, direct playlist and proxy stages", () => {
    for (const stage of [0, 1, 2]) {
        const f = fixture({
            d_maxtvcfg: JSON.stringify({
                m3u: "",
                pass: "secret",
                server: "https://operator.test",
                user: "viewer",
            }),
        });
        f.mount("d/maxtv");
        let completed = 0;
        f.host.getChannelsArray(() => completed++);
        for (let index = 0; index < stage; index++) f.requests[index].reject();
        const retired = f.requests[stage];
        const count = f.requests.length;
        f.mount("demo");
        f.host.getChannelsArray(() => completed++);
        assert.equal(retired.aborts, 1);
        retired.reject();
        retired.resolve(
            stage
                ? "#EXTM3U\n#EXTINF:-1,Stale\nhttps://old.test/live\n"
                : { live_streams: [{ name: "Stale", stream_id: 1 }] }
        );
        assert.equal(
            f.requests.length,
            count,
            "retired failure cannot launch next fallback stage"
        );
        assert.equal(completed, 1);
        assert.deepEqual(Array.from(f.host.cList), [900000001, 900000002]);
        assert.deepEqual(f.errors, []);
    }
});

test("all34 four-field profiles retain cfg namespace, editor, empty guide and media capability", () => {
    const profiles = fixture().host.__ottProviderDriverProfiles.filter(
        (profile) =>
            profile.kind === "operator" || profile.kind === "xtream-fallback"
    );
    for (const profile of profiles) {
        const config = {
            extra: "preserved",
            m3u: "https://playlist.test/old.m3u",
            pass: "secret",
            server: "https://operator.test",
            user: "original",
        };
        const f = fixture({
            [profile.prefix + "cfg"]: JSON.stringify(config),
            foreigncfg: "untouched",
        });
        const driver = f.mount(profile.id);
        f.host.popupActions = [f.host.noProvParam, () => {}];
        f.host.popupArray = ["", ""];
        f.host.popupDetail = ["", ""];
        f.host.duneAddSettings(1);
        assert.equal(f.host.p_pref, profile.prefix);
        assert.equal(
            f.host.popupArray[1],
            profile.title + " settings: operator.test (original)"
        );
        const edit = f.host.popupActions[1];
        edit();
        assert.equal(f.host.listCaption.innerHTML, profile.title);
        assert.equal(f.host.listArray.length, 6);
        assert.equal(f.host.listArray[2], "Password: ********");
        f.host.selIndex = 3;
        f.host.listKeyHandler(f.host.keys.ENTER);
        f.host.editvar = " https://playlist.test/new.m3u ";
        f.host.setEdit();
        f.host.listKeyHandler(f.host.keys.RETURN);
        assert.equal(
            JSON.parse(f.saved.get(profile.prefix + "cfg")).m3u,
            config.m3u
        );
        edit();
        f.host.selIndex = 3;
        f.host.listKeyHandler(f.host.keys.ENTER);
        f.host.editvar = " https://playlist.test/new.m3u ";
        f.host.setEdit();
        f.host.selIndex = 5;
        f.host.listKeyHandler(f.host.keys.ENTER);
        assert.deepEqual(JSON.parse(f.saved.get(profile.prefix + "cfg")), {
            ...config,
            m3u: "https://playlist.test/new.m3u",
        });
        assert.equal(f.saved.get("foreigncfg"), "untouched");
        assert.equal(f.reloads, 1);
        let guide = "not called";
        driver.guide("whatever", (value) => {
            guide = value;
        });
        assert.equal(guide, null);
        assert.equal(f.requests.length, 0);
        assert.equal(f.host.getMediaArray, null);
        assert.equal(driver.capabilities.media, false);
        assert.equal(driver.archive("unknown", 100, 200), "");
    }
});

test("credential save rejects retired editor effects after transport abort switches provider", () => {
    for (const id of ["xtream", "all4you", "bestlist/stalker"]) {
        const key =
            id === "xtream"
                ? "xtreamxtream_data"
                : id.replace("/", "_") + "cfg";
        const original =
            id === "xtream"
                ? config
                : {
                      m3u: "",
                      pass: config.password,
                      server: config.server,
                      user: config.username,
                  };
        const f = fixture({ [key]: JSON.stringify(original) });
        const d = f.mount(id);
        f.host.duneAddSettings(0);
        f.host.popupActions[0]();
        d.load(() => assert.fail("retired catalog callback"));
        const request = f.requests[0];
        const abort = request.abort;
        request.abort = function () {
            f.mount("demo");
            abort.call(this);
        };
        f.host.selIndex = id === "xtream" ? 4 : 5;
        f.host.listKeyHandler(f.host.keys.ENTER);
        assert.equal(f.host.__ottActiveProviderDriver.id, "demo");
        assert.equal(f.reloads, 0);
        assert.deepEqual(JSON.parse(f.saved.get(key)), original);
        request.resolve({ live_streams: [{ name: "Retired", stream_id: 42 }] });
        assert.equal(d.stream(42), "");
    }
});

test("same-instance abort loads observe one complete credential revision", () => {
    for (const id of ["xtream", "all4you", "bestlist/stalker"]) {
        const key =
            id === "xtream"
                ? "xtreamxtream_data"
                : id.replace("/", "_") + "cfg";
        const original =
            id === "xtream"
                ? config
                : {
                      m3u: "",
                      pass: config.password,
                      server: config.server,
                      user: config.username,
                  };
        const f = fixture({ [key]: JSON.stringify(original) });
        const d = f.mount(id);
        d.load(() => assert.fail("cancelled load"));
        const request = f.requests[0],
            abort = request.abort;
        request.abort = function () {
            d.load(() => {});
            abort.call(this);
        };
        assert.equal(
            d.saveCredentials({
                password: "new-secret",
                server: "https://new.test",
                username: "new",
            }),
            false
        );
        assert.equal(f.requests.length, 2);
        assert(f.requests[1].settings.url.includes("xc.test"));
        assert.deepEqual(JSON.parse(f.saved.get(key)), original);
        f.requests[1].resolve({
            live_streams: [{ name: "Current", stream_id: 42 }],
        });
        assert(d.stream(42).includes("xc.test"));
        assert.equal(d.credentials().server, config.server);
    }
});

test("projection and playlist decoding reentry cannot publish the previous account", () => {
    for (const id of ["xtream", "all4you", "bestlist/stalker"]) {
        const key =
            id === "xtream"
                ? "xtreamxtream_data"
                : id.replace("/", "_") + "cfg";
        const f = fixture({
            [key]: JSON.stringify(
                id === "xtream"
                    ? config
                    : {
                          m3u: "",
                          pass: config.password,
                          server: config.server,
                          user: config.username,
                      }
            ),
        });
        const d = f.mount(id);
        let completed = 0;
        d.load(() => completed++);
        const project = f.host.__ottChannelCatalog.project;
        f.host.__ottChannelCatalog.project = (...args) => {
            const value = project(...args);
            d.saveCredentials({
                password: "new-secret",
                server: "https://new.test",
                username: "new",
            });
            return value;
        };
        f.requests[0].resolve({
            live_streams: [{ name: "Retired", stream_id: 42 }],
        });
        assert.equal(completed, 0);
        assert.equal(d.stream(42), "");
        assert.equal(d.credentials().username, "new");
    }
    const f = fixture({
        all4youcfg: JSON.stringify({ m3u: "https://list.test/old.m3u" }),
    });
    const d = f.mount("all4you");
    let completed = 0;
    const parse = f.host.OttPlayCore.parseProviderPlaylist;
    let decoded = 0;
    f.host.OttPlayCore.parseProviderPlaylist = (...args) => {
        const value = parse(...args);
        decoded++;
        d.saveCredentials({
            password: "",
            playlist: "https://list.test/new.m3u",
            server: "",
            username: "",
        });
        return value;
    };
    d.load(() => completed++);
    f.requests[0].resolve("#EXTM3U\n#EXTINF:-1,Old\nhttps://stream.test/old\n");
    assert.equal(decoded, 1);
    assert.equal(completed, 0);
    assert.equal(d.stream(42), "");
});

test("recursive editor save is cancelled synchronously and the visible draft remains retryable", () => {
    const f = fixture(stored()),
        d = f.mount("xtream"),
        w = f.host;
    w.duneAddSettings(0);
    const edit = w.popupActions[0];
    edit();
    let entered = false;
    const set = w.stbSetItem;
    w.stbSetItem = (key, value) => {
        set(key, value);
        if (!entered && key === "xtreamxtream_data") {
            entered = true;
            edit();
            w.selIndex = 1;
            w.listKeyHandler(w.keys.ENTER);
            w.editvar = "inner";
            w.setEdit();
            w.selIndex = 4;
            w.listKeyHandler(w.keys.ENTER);
        }
    };
    w.selIndex = 4;
    w.listKeyHandler(w.keys.ENTER);
    assert(entered);
    assert.equal(d.credentials().username, config.username);
    assert.equal(f.reloads, 0);
    w.listKeyHandler(w.keys.ENTER);
    assert.equal(d.credentials().username, "inner");
    assert.equal(f.reloads, 1);
});

test("guide credential reads retire completion on source, account and catalog replacement", () => {
    for (const change of ["source", "save", "load"]) {
        const f = fixture(stored()),
            d = f.mount("xtream");
        d.load(() => {});
        f.requests[0].resolve({
            live_streams: [{ name: "Channel", stream_id: 42 }],
        });
        const read = f.host.stbGetItem;
        let entered = false,
            completed = 0;
        f.host.stbGetItem = (key) => {
            const value = read(key);
            if (!entered && key === "xtreamxtream_data") {
                entered = true;
                if (change === "source") f.mount("demo");
                else if (change === "save")
                    d.saveCredentials({ ...config, username: "new" });
                else d.load(() => {});
            }
            return value;
        };
        d.guide(42, () => completed++);
        assert(entered);
        assert.equal(completed, 0);
        assert.equal(f.requests.length, change === "load" ? 2 : 1);
    }
});

console.log(
    "PASS typed provider instances: " +
        assertions +
        " cases; no network/decoder claim"
);
