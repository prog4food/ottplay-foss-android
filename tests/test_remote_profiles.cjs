"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const acorn = require("acorn");
const m3uFixture = require("./helpers/m3u-driver-fixture.cjs");
const clone = (value) => JSON.parse(JSON.stringify(value));
const portal = "portal::[key:PRIVATE_FIXTURE]https://portal.test/api/v1/";
const code = ts.transpileModule(
    fs.readFileSync("src/commands/remote-profiles.ts", "utf8"),
    {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES5,
        },
    }
).outputText;
acorn.parse(code, { ecmaVersion: 5 });
let passed = 0;
function fixture(options = {}) {
    const config = {
        active: 0,
        M3Us: Array.from({ length: 15 }, (_, index) => ({
            medSourceId: "identity-" + index,
            medUrl: index === 0 || index === 14 ? portal : "",
            name: "Profile " + (index + 1),
            rechours: String(index * 24),
            www: "https://playlist.test/" + index + "?key=PRIVATE_PLAYLIST",
        })),
    };
    if (options.change) options.change(config);
    const f = m3uFixture({ ...options, config });
    f.driver = f.start();
    let writes = 0;
    const set = f.host.stbSetItem;
    f.host.stbSetItem = (key, value) => {
        writes++;
        return set(key, value);
    };
    f.host.URL = URL;
    f.host.exports = {};
    f.host.require = (name) => {
        if (name === "../provider")
            return {
                checkProviderUrl: (value) => f.host.checkProviderUrl(value),
                isProviderAllowed: () => f.allowed !== false,
            };
        throw new Error("Unexpected dependency: " + name);
    };
    vm.runInContext(code, f.host);
    return Object.assign(f, {
        invoke(action, params = {}) {
            let result,
                replies = 0;
            assert.equal(
                f.host.exports.handleRemoteProfiles(
                    { action, params },
                    (value) => {
                        replies++;
                        result = clone(value);
                    }
                ),
                true
            );
            assert.equal(replies, 1);
            for (const secret of [
                "PRIVATE",
                "portal.test",
                "playlist.test",
                "medSourceId",
            ])
                assert(
                    !JSON.stringify(result).includes(secret),
                    "receipt excludes " + secret
                );
            return result;
        },
        writes: () => writes,
    });
}
function test(name, callback, options) {
    const f = fixture(options);
    try {
        callback(f);
        passed++;
        console.log("PASS remote profiles: " + name);
    } finally {
        f.dom.window.close();
    }
}
function unchangedRejection(f, action, params) {
    const before = [...f.saved],
        requests = f.requests.length,
        reloads = f.reloads,
        writes = f.writes();
    assert.equal(f.invoke(action, params).status, "rejected");
    assert.deepEqual([...f.saved], before);
    assert.equal(f.writes(), writes);
    assert.equal(f.requests.length, requests);
    assert.equal(f.reloads, reloads);
}

test("ordered metadata has exactly one active slot and no configuration secrets", (f) => {
    const result = f.invoke("profiles");
    assert.equal(result.status, "ok");
    assert.equal(result.data.provider, "m3u");
    assert.deepEqual(
        result.data.profiles.map((row) => row.number),
        Array.from({ length: 15 }, (_, i) => i + 1)
    );
    assert.equal(result.data.profiles.filter((row) => row.active).length, 1);
    assert.deepEqual(result.data.profiles[0], {
        active: true,
        history_hours: 0,
        name: "Profile 1",
        number: 1,
        playlist_configured: true,
    });
    assert.equal(f.writes(), 0);
    assert.equal(f.reloads, 0);
    assert.equal(f.requests.length, 0);
    let replied = false;
    assert.equal(
        f.host.exports.handleRemoteProfiles({ action: "other" }, () => {
            replied = true;
        }),
        false
    );
    assert.equal(replied, false);
});

test(
    "legacy invalid hours are null and names are bounded clean UTF-8 metadata",
    (f) => {
        const rows = f.invoke("profiles").data.profiles;
        for (let index = 0; index < 7; index++)
            assert.equal(rows[index].history_hours, null);
        assert.equal(Buffer.byteLength(rows[0].name), 256);
        assert(!/[\x00-\x1f\x7f]/.test(rows[0].name));
        assert.equal(
            f.invoke("profile_settings", {
                number: 5,
                settings: { history_hours: 1000 },
            }).status,
            "ok"
        );
        assert.equal(f.driver.configuration().M3Us[4].rechours, 1000);
    },
    {
        change: (config) => {
            config.M3Us[0].name = "\u0000я\n".repeat(500);
            ["invalid", "-1", "8761", "1.5", "1e3", "0x10", "24x"].forEach(
                (value, index) => {
                    config.M3Us[index].rechours = value;
                }
            );
        },
    }
);

test("invalid parameters and mixed invalid patches never persist partially", (f) => {
    for (const number of [0, 16, -1, 1.5, "1", null, NaN, Infinity]) {
        unchangedRejection(f, "profile", { number });
        unchangedRejection(f, "profile_settings", {
            number,
            settings: { name: "New" },
        });
    }
    for (const params of [null, [], "x", { extra: true }])
        unchangedRejection(f, "profiles", params);
    for (const settings of [
        null,
        [],
        {},
        { unknown: "value" },
        { active: 1 },
        { medSourceId: "x" },
        { history_hours: "24", name: "Good" },
        { history_hours: -1, name: "Good" },
        { history_hours: 8761, name: "Good" },
        { history_hours: 1.5, name: "Good" },
        { history_hours: NaN, name: "Good" },
        { history_hours: Infinity, name: "Good" },
        { name: "я".repeat(129) },
        { name: "bad\nname" },
        { name: "\ud800" },
        {
            name: "Good",
            playlist: "portal::[key:PRIVATE]https://portal.test/api",
        },
        { name: "Good", playlist: "file:///secret" },
        { name: "Good", playlist: "https:playlist.test/path" },
        { name: "Good", playlist: "http:/playlist.test/path" },
        { name: "Good", playlist: "javascript:bad" },
        { name: "Good", playlist: "https://user:PRIVATE@playlist.test/" },
        { name: "Good", playlist: "https://playlist.test/" + "я".repeat(4096) },
        { name: "Good", playlist: "https://playlist.test/bad\\url" },
        { name: "Good", vportal: "https://portal.test/api" },
        {
            name: "Good",
            vportal: "portal::[key:PRIVATE]https://user:pass@portal.test/",
        },
    ])
        unchangedRejection(f, "profile_settings", { number: 2, settings });
    unchangedRejection(f, "profile", { ignored: true, number: 2 });
    unchangedRejection(f, "profile_settings", {
        ignored: true,
        number: 2,
        settings: { name: "Good" },
    });
});

test("parental and platform policy prevent writes without changing provider", (f) => {
    f.host.__ottParental = { needs: () => true };
    unchangedRejection(f, "profile", { number: 2 });
    unchangedRejection(f, "profile_settings", {
        number: 2,
        settings: { name: "Good" },
    });
    assert.equal(f.invoke("profiles").status, "ok");
    // Explicitly shadow the VM global: deleting the outer context property can
    // expose the original adapter again on Node 22 instead of removing it.
    f.host.__ottParental = undefined;
    assert.equal(vm.runInContext("window.__ottParental", f.host), undefined);
    f.host.sPSoptions = true;
    f.host.parentPIN = "1234";
    f.host.parentAccess = false;
    unchangedRejection(f, "profile", { number: 2 });
    f.host.parentAccess = true;
    f.allowed = false;
    unchangedRejection(f, "profile_settings", {
        number: 2,
        settings: { name: "Good" },
    });
    f.allowed = true;
    f.host.checkProviderUrl = () => false;
    unchangedRejection(f, "profile", { number: 2 });
    unchangedRejection(f, "profile_settings", {
        number: 2,
        settings: { playlist: "http://playlist.test/" },
    });
    unchangedRejection(f, "profile_settings", {
        number: 2,
        settings: { vportal: portal },
    });
    f.host.__ottActiveProviderDriver = { id: "xtream" };
    unchangedRejection(f, "profile", { number: 2 });
});

test("real parental policies distinguish settings and providers from channels", (f) => {
    const policy = (settings, providers, channels) => {
        f.host.parentPIN = "1234";
        f.host.settings = {
            psChannels: channels,
            psOptions: settings,
            requirePinForProviderSelection: providers,
        };
        f.host.parentAccess = false;
    };
    for (const selected of [
        [1, 0, 0],
        [0, 1, 0],
    ]) {
        policy(...selected);
        unchangedRejection(f, "profile", { number: 2 });
        unchangedRejection(f, "profile_settings", {
            number: 2,
            settings: { name: "Good" },
        });
        assert.equal(f.invoke("profiles").status, "ok");
    }
    policy(0, 0, 1);
    assert.equal(f.host.__ottParental.needs("channels"), true);
    assert.equal(f.host.__ottParental.needs("settings"), false);
    assert.equal(
        f.invoke("profile_settings", {
            number: 2,
            settings: { name: "Good" },
        }).status,
        "ok"
    );
    assert.equal(f.invoke("profile", { number: 2 }).status, "ok");
});

test(
    "fixed-slot player URLs disallow another slot's selection or editing",
    (f) => {
        assert.equal(f.driver.fixedSlot(), 2);
        unchangedRejection(f, "profile", { number: 1 });
        unchangedRejection(f, "profile_settings", {
            number: 1,
            settings: { name: "Good" },
        });
        assert.equal(
            f.invoke("profile_settings", {
                number: 3,
                settings: { name: "Fixed" },
            }).status,
            "ok"
        );
        assert.equal(f.reloads, 0);
    },
    { dune: true, href: "https://player.test/?n=3" }
);

test("inactive TV patch preserves other slots and legacy data without loading media", (f) => {
    const before = clone(f.driver.configuration());
    const result = f.invoke("profile_settings", {
        number: 15,
        settings: {
            history_hours: 8760,
            name: "Cinema",
            playlist: "https://new.test/list",
        },
    });
    assert.equal(result.status, "ok");
    assert.equal(result.data.saved, true);
    assert.equal(result.data.reloaded, false);
    assert.equal(result.data.profile.active, false);
    const after = clone(f.driver.configuration());
    assert.equal(after.active, 0);
    assert.deepEqual(after.M3Us.slice(0, 14), before.M3Us.slice(0, 14));
    assert.equal(after.M3Us[14].medSourceId, before.M3Us[14].medSourceId);
    assert.equal(after.M3Us[14].medUrl, before.M3Us[14].medUrl);
    assert.equal(after.M3Us[14].www, "https://new.test/list");
    assert.equal(after.M3Us[14].rechours, 8760);
    assert.equal(f.writes(), 1);
    assert.equal(f.reloads, 0);
    assert.equal(f.host.providerMediaClient, null);
    assert.equal(f.requests.length, 0);
});

test("active name update does not reload or rotate source and identical patches are no-ops", (f) => {
    const original = clone(f.driver.configuration().M3Us[0]),
        client = f.host.providerMediaClient;
    assert.equal(
        f.invoke("profile_settings", {
            number: 1,
            settings: { name: "я".repeat(128) },
        }).status,
        "ok"
    );
    const after = clone(f.driver.configuration().M3Us[0]);
    assert.deepEqual({ ...after, name: original.name }, original);
    assert.equal(f.reloads, 0);
    assert.equal(f.host.providerMediaClient, client);
    assert.equal(f.writes(), 1);
    assert.equal(
        f.invoke("profile_settings", {
            number: 1,
            settings: {
                history_hours: 0,
                name: "я".repeat(128),
            },
        }).status,
        "ok"
    );
    assert.equal(f.invoke("profile", { number: 1 }).status, "ok");
    assert.equal(f.writes(), 1);
    assert.equal(f.reloads, 0);
});

test("active playlist/archive patch reloads once without starting retired media", (f) => {
    const before = clone(f.driver.configuration());
    const result = f.invoke("profile_settings", {
        number: 1,
        settings: {
            history_hours: 72,
            name: "New",
            playlist: "https://new.test/list",
        },
    });
    assert.equal(result.status, "ok");
    assert.equal(result.data.reloaded, true);
    assert.equal(f.reloads, 1);
    assert.equal(f.writes(), 1);
    assert.equal(f.host.providerMediaClient, null);
    assert.equal(f.requests.length, 0);
    assert.equal(
        f.driver.configuration().M3Us[0].medUrl,
        before.M3Us[0].medUrl
    );
    assert.deepEqual(
        clone(f.driver.configuration().M3Us.slice(1)),
        before.M3Us.slice(1)
    );
});

test("M3U rejects retired VPortal edits atomically, including clearing the link", (f) => {
    for (const vportal of [portal, ""]) {
        unchangedRejection(f, "profile_settings", {
            number: 1,
            settings: { name: "Must not save", vportal },
        });
    }
    assert.equal(f.host.providerMediaClient, null);
});

test(
    "legacy VPortal links do not block TV selection or create identities",
    (f) => {
        const before = clone(f.driver.configuration());
        const checked = [];
        f.host.checkProviderUrl = (url) => {
            checked.push(url);
            return url.startsWith("https://playlist.test/");
        };
        const result = f.invoke("profile", { number: 15 });
        assert.equal(result.status, "ok");
        assert.equal(result.data.profile.number, 15);
        assert.equal(result.data.profile.active, true);
        assert.equal(result.data.dispatched, true);
        assert.equal(f.reloads, 1);
        assert.equal(f.writes(), 1);
        const after = clone(f.driver.configuration());
        assert.deepEqual(after.M3Us, before.M3Us);
        assert.equal(after.M3Us[14].medSourceId, undefined);
        assert.deepEqual(checked, [before.M3Us[14].www]);
        assert.equal(f.host.providerMediaClient, null);
        assert.equal(f.requests.length, 0);
    },
    {
        change: (config) => {
            delete config.M3Us[14].medSourceId;
        },
    }
);

test("standalone VPortal profile operations still delegate to its driver", (f) => {
    const requests = [];
    f.host.__ottActiveProviderDriver = {
        id: "vportal",
        remoteProfiles: (request) => {
            requests.push(clone(request));
            return { data: { provider: "vportal", saved: true }, status: "ok" };
        },
    };
    const params = { number: 1, settings: { name: "Cinema", vportal: portal } };
    const result = f.invoke("profile_settings", params);
    assert.equal(result.status, "ok");
    assert.equal(result.data.provider, "vportal");
    assert.deepEqual(requests, [{ action: "profile_settings", params }]);
    assert.equal(f.writes(), 0);
    assert.equal(f.reloads, 0);
});

test("clearing fields is allowed but empty playlist slots cannot be selected", (f) => {
    const result = f.invoke("profile_settings", {
        number: 1,
        settings: { history_hours: 0, name: "", playlist: "" },
    });
    assert.equal(result.status, "ok");
    assert.equal(result.data.profile.playlist_configured, false);
    assert.equal("vportal_configured" in result.data.profile, false);
    assert.equal(f.reloads, 1);
    assert.equal(f.host.providerMediaClient, null);
    unchangedRejection(f, "profile", { number: 1 });
});

test("missing reload lifecycle rejects relevant mutations before persistence", (f) => {
    delete f.host.loadPlaylist;
    unchangedRejection(f, "profile", { number: 2 });
    unchangedRejection(f, "profile_settings", {
        number: 1,
        settings: { history_hours: 72 },
    });
    assert.equal(
        f.invoke("profile_settings", {
            number: 2,
            settings: { name: "Offline" },
        }).status,
        "ok"
    );
});

test("nested remote saves are rejected while the original transaction completes", (f) => {
    let nested;
    f.driver.subscribe(() => {
        nested = f.invoke("profile_settings", {
            number: 3,
            settings: { name: "Reentrant" },
        });
    });
    assert.equal(
        f.invoke("profile_settings", {
            number: 2,
            settings: { name: "Accepted" },
        }).status,
        "ok"
    );
    assert.equal(nested.status, "rejected");
    assert.equal(f.driver.configuration().M3Us[1].name, "Accepted");
    assert.equal(f.driver.configuration().M3Us[2].name, "Profile 3");
    assert.equal(f.writes(), 1);
});

test("intervening writes and failed or partial saves never receive success", (f) => {
    const original = f.driver.saveConfiguration;
    f.host.checkProviderUrl = () => {
        const value = f.driver.configuration();
        value.M3Us[3].name = "Other editor";
        original(value);
        return true;
    };
    assert.equal(
        f.invoke("profile_settings", {
            number: 2,
            settings: { playlist: "https://new.test/list" },
        }).status,
        "rejected"
    );
    assert.equal(
        f.driver.configuration().M3Us[1].www,
        "https://playlist.test/1?key=PRIVATE_PLAYLIST"
    );
    assert.equal(f.driver.configuration().M3Us[3].name, "Other editor");
    f.host.checkProviderUrl = () => true;
    f.driver.saveConfiguration = () => false;
    unchangedRejection(f, "profile", { number: 2 });
    f.driver.saveConfiguration = (value) => {
        value.M3Us[5].name = "Unexpected editor";
        return original(value);
    };
    assert.equal(f.invoke("profile", { number: 2 }).status, "rejected");
    assert.equal(f.reloads, 0);
});

test("URL policy provider changes and publication reentrancy cannot earn false ACKs", (f) => {
    const driver = f.driver;
    f.host.checkProviderUrl = () => {
        f.host.__ottActiveProviderDriver = { id: "other" };
        return true;
    };
    unchangedRejection(f, "profile_settings", {
        number: 2,
        settings: { playlist: "https://new.test/list" },
    });
    f.host.__ottActiveProviderDriver = driver;
    f.host.checkProviderUrl = () => true;
    let once = false;
    driver.subscribe(() => {
        if (once) return;
        once = true;
        const next = driver.configuration();
        next.M3Us[4].name = "Intervening UI";
        driver.saveConfiguration(next);
    });
    assert.equal(f.invoke("profile", { number: 2 }).status, "rejected");
    assert.equal(driver.configuration().M3Us[4].name, "Intervening UI");
    assert.equal(f.reloads, 0);
});

test("storage errors hide credentials and release the operation lock", (f) => {
    const set = f.host.stbSetItem;
    f.host.stbSetItem = () => {
        throw new Error("PRIVATE_PLAYLIST https://playlist.test/");
    };
    unchangedRejection(f, "profile_settings", {
        number: 2,
        settings: { name: "Good" },
    });
    f.host.stbSetItem = set;
    assert.equal(
        f.invoke("profile_settings", { number: 2, settings: { name: "Good" } })
            .status,
        "ok"
    );
});
console.log(
    "PASS remote profiles: " +
        passed +
        " focused scenarios with the real M3U driver"
);
