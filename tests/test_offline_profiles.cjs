const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const code = require("./helpers/offline-profile-source.cjs")();
require("acorn").parse(code, { ecmaVersion: 5 });
const clone = (v) => JSON.parse(JSON.stringify(v));
function fixture(initial) {
    const data = new Map(initial);
    let catalog = {
        items: [
            {
                id: "PRIVATE-ITEM",
                name: "sub/movie.mp4",
                sourceId: "PRIVATE-SOURCE",
                url: "blob:PRIVATE",
            },
        ],
        sources: [{ id: "PRIVATE-SOURCE", kind: "folder", name: "Cartoons" }],
    };
    const host = {
        __ottActiveProviderDriver: { id: "offline" },
        crypto: webcrypto,
        curList: ["local-PRIVATE-ITEM"],
        loadChannels: () => {
            f.reloads++;
        },
        primaryIndex: 0,
        stbDelItem: (k) => data.delete(k),
        stbGetItem: (k) => data.get(k) ?? null,
        stbSetItem: (k, v) => data.set(k, v),
        Uint8Array,
    };
    vm.createContext(host);
    vm.runInContext(code, host);
    const media = {
        libraryIdentity: () => "browser:",
        snapshot: async () => catalog,
    };
    const api = host.installOfflineProfiles(host, media);
    const f = {
        api,
        call: async (action, params = {}) =>
            clone(await api.request({ action, params })),
        catalog: () => catalog,
        data,
        host,
        media,
        reloads: 0,
        setCatalog: (v) => {
            catalog = v;
        },
    };
    return f;
}
async function saved(f, number = 1) {
    assert.equal(
        (await f.call("profile_save", { name: "Family", number })).status,
        "ok"
    );
    return (await f.call("profile_export", { number })).data.profile;
}
test("save/export/load and same-device reimport retain sources and exact selected file without media or grants", async () => {
    const f = fixture(),
        profile = await saved(f);
    const bytes = JSON.stringify(profile);
    assert(!/PRIVATE|blob:|handle|bookmark|url/.test(bytes));
    assert.deepEqual(profile.selected, {
        name: "sub/movie.mp4",
        source_key: "s0",
    });
    assert.equal(
        (await f.call("profile_import", { number: 2, profile })).data
            .binding_required,
        false
    );
    assert.equal((await f.call("profile", { number: 2 })).status, "ok");
    assert.equal(f.reloads, 1);
    assert.equal(f.api.namespace(), "offline:1");
    assert.equal(f.api.selection(), "local-PRIVATE-ITEM");
    const reopened = fixture(f.data);
    assert.equal(reopened.api.selection(), "local-PRIVATE-ITEM");
    assert.equal(reopened.api.filter(reopened.catalog()).items.length, 1);
});
test("foreign import never trusts coincident source IDs or names and explicit local binding restores selection", async () => {
    const profile = await saved(fixture()),
        f = fixture();
    const imported = await f.call("profile_import", { number: 3, profile });
    assert.equal(imported.data.binding_required, true);
    await f.call("profile", { number: 3 });
    assert.equal(f.api.filter(f.catalog()).items.length, 0);
    assert.equal(f.api.selection(), "");
    f.api.bind(f.catalog());
    assert.equal(f.api.selection(), "local-PRIVATE-ITEM");
    assert.equal(f.api.filter(f.catalog()).items.length, 1);
});
test("changed descriptors cannot reuse another local binding ID", async () => {
    const f = fixture(),
        profile = await saved(f);
    profile.selected.name = "another.mp4";
    const receipt = await f.call("profile_import", { number: 2, profile });
    assert.equal(receipt.data.binding_required, true);
});
test("profile source subset survives extra connected folders and save into another slot", async () => {
    const f = fixture();
    await saved(f);
    await f.call("profile", { number: 1 });
    f.catalog().sources.push({ id: "OTHER", kind: "folder", name: "Other" });
    f.catalog().items.push({
        id: "OTHER-ITEM",
        name: "other.mp4",
        sourceId: "OTHER",
        url: "blob:other",
    });
    assert.equal(f.api.filter(f.catalog()).items.length, 1);
    const second = await saved(f, 2);
    assert.equal(second.sources.length, 1);
});
test("profile reads are allowed in kiosk but saves/exports/import/load/bind are denied", async () => {
    const f = fixture(),
        profile = await saved(f);
    f.host.__ottKiosk = { enabled: () => true };
    assert.equal((await f.call("profiles")).status, "ok");
    assert.deepEqual(clone(f.api.capabilities().operations), ["list"]);
    for (const [action, params] of [
        ["profile", { number: 1 }],
        ["profile_save", { number: 1 }],
        ["profile_export", { number: 1 }],
        ["profile_import", { number: 2, profile }],
    ])
        assert.equal((await f.call(action, params)).status, "rejected");
    assert.throws(() => f.api.bind(f.catalog()));
});
test("delayed save cannot publish after provider, policy, endpoint or profile change", async () => {
    for (const change of [
        (f) => {
            f.host.__ottActiveProviderDriver = { id: "offline" };
        },
        (f) => {
            f.host.__ottKiosk = { enabled: () => true };
        },
        (f) => {
            f.media.libraryIdentity = () => "other";
        },
        (f) => {
            f.data.set("offlineProfiles", "changed");
        },
    ]) {
        const f = fixture();
        let release;
        f.media.snapshot = () =>
            new Promise((resolve) => {
                release = resolve;
            });
        const result = f.call("profile_save", { number: 1 });
        await Promise.resolve();
        assert.equal(
            (await f.call("profile_save", { number: 2 })).status,
            "rejected"
        );
        change(f);
        release(f.catalog());
        assert.equal((await result).status, "rejected");
        assert(!f.data.has("offlineProfileBindings"));
    }
});
test("foreign binding fails closed for duplicate folder labels or missing selected file", async () => {
    const profile = await saved(fixture()),
        f = fixture();
    await f.call("profile_import", { number: 1, profile });
    await f.call("profile", { number: 1 });
    f.catalog().sources.push({
        id: "SECOND",
        kind: "folder",
        name: "Cartoons",
    });
    assert.throws(() => f.api.bind(f.catalog()), /exactly one/);
    f.catalog().sources.pop();
    f.catalog().items = [];
    assert.throws(() => f.api.bind(f.catalog()), /missing or ambiguous/);
});
test("strict portable schema rejects paths, arbitrary fields, authority, oversized documents and invalid slots", async () => {
    const f = fixture(),
        original = await saved(f);
    for (const mutate of [
        (p) => {
            p.bookmark = "secret";
        },
        (p) => {
            p.sources[0].handle = {};
        },
        (p) => {
            p.sources[0].name = "/private/video";
        },
        (p) => {
            p.selected.name = "C:\\private\\movie.mp4";
        },
        (p) => {
            p.selected.name = "../movie.mp4";
        },
        (p) => {
            p.selected.name = "file:movie.mp4";
        },
        (p) => {
            p.selected.source_key = "s99";
        },
        (p) => {
            p.name = "й".repeat(129);
        },
        (p) => {
            p.sources = Array.from({ length: 32 }, (_, i) => ({
                key: `s${i}`,
                kind: "folder",
                name: "я".repeat(255),
            }));
        },
    ]) {
        const profile = clone(original);
        mutate(profile);
        assert.equal(
            (await f.call("profile_import", { number: 2, profile })).status,
            "rejected"
        );
    }
    for (const number of [0, 16, 1.5, null, "1", NaN])
        assert.equal((await f.call("profile", { number })).status, "rejected");
    assert.equal(f.api.read().profiles.filter(Boolean).length, 1);
});
test("storage write failure never reports saved or reloads", async () => {
    const f = fixture();
    f.host.stbSetItem = () => {};
    assert.equal(
        (await f.call("profile_save", { number: 1 })).status,
        "rejected"
    );
    assert.equal(f.reloads, 0);
});

test("initial storage failure releases operation lock and does not leak backend details", async () => {
    const f = fixture(),
        read = f.host.stbGetItem;
    f.host.stbGetItem = () => {
        throw new Error("PRIVATE_BOOKMARK");
    };
    const failed = await f.call("profiles");
    assert.equal(failed.status, "rejected");
    assert(!JSON.stringify(failed).includes("PRIVATE_BOOKMARK"));
    f.host.stbGetItem = read;
    assert.equal((await f.call("profiles")).status, "ok");
});

test("missing selected media cannot silently replace saved selection with null", async () => {
    const f = fixture();
    await saved(f);
    f.catalog().items = [];
    const before = f.data.get("offlineProfiles");
    assert.equal(
        (await f.call("profile_save", { number: 1 })).status,
        "rejected"
    );
    assert.equal(f.data.get("offlineProfiles"), before);
});

test("reentrant storage publication cannot reload a replacement provider", async () => {
    const f = fixture();
    await saved(f);
    const write = f.host.stbSetItem;
    f.host.stbSetItem = (key, value) => {
        write(key, value);
        if (key === "offlineProfiles")
            f.host.__ottActiveProviderDriver = { id: "m3u" };
    };
    assert.equal((await f.call("profile", { number: 1 })).status, "rejected");
    assert.equal(f.reloads, 0);
});

test("identical saves reuse binding, changed saves evict only unreferenced history", async () => {
    const f = fixture();
    const first = await saved(f);
    assert.equal((await saved(f)).binding_id, first.binding_id);
    for (let index = 0; index < 135; index++) {
        f.catalog().items[0].name = `episode-${index}.mp4`;
        assert.equal(
            (await f.call("profile_save", { number: 2 })).status,
            "ok"
        );
    }
    assert.equal(
        Object.keys(JSON.parse(f.data.get("offlineProfileBindings"))).length,
        128
    );
    await f.call("profile", { number: 1 });
    assert.equal(f.api.selection(), "local-PRIVATE-ITEM");
});

test("profile load restores its private server/local library context", async () => {
    const f = fixture();
    f.data.set("localMediaEndpoint", "https://server.invalid/private-token");
    f.media.libraryIdentity = () =>
        "browser:" + (f.data.get("localMediaEndpoint") || "");
    f.media.libraryWrite = (value) => ({
        key: "localMediaEndpoint",
        value: value.slice(8),
    });
    const profile = await saved(f);
    assert(!JSON.stringify(profile).includes("private-token"));
    f.data.set("localMediaEndpoint", "");
    assert.equal((await f.call("profile", { number: 1 })).status, "ok");
    assert.equal(
        f.media.libraryIdentity(),
        "browser:https://server.invalid/private-token"
    );
    assert.equal(f.api.selection(), "local-PRIVATE-ITEM");
});

test("binding gesture cannot authorize a different profile or library after pending list", async () => {
    for (const drift of [
        (f) => {
            const store = f.api.read();
            store.active = 1;
            f.data.set("offlineProfiles", JSON.stringify(store));
        },
        (f) => {
            f.media.libraryIdentity = () => "other";
        },
    ]) {
        const profile = await saved(fixture()),
            f = fixture();
        await f.call("profile_import", { number: 1, profile });
        await f.call("profile_import", { number: 2, profile });
        await f.call("profile", { number: 1 });
        let release;
        f.media.snapshot = () =>
            new Promise((resolve) => {
                release = resolve;
            });
        const pending = f.api.bindCurrent();
        drift(f);
        release(f.catalog());
        await assert.rejects(pending, /changed while reading/);
        assert(!f.data.has("offlineProfileBindings"));
    }
});

test("endpoint/profile batch rolls back rejected writes and preserves foreign endpoint changes", async () => {
    for (const mode of [
        "endpoint-reject",
        "profile-reject",
        "profile-throw-after",
        "foreign-endpoint",
        "foreign-driver",
    ]) {
        const f = fixture();
        f.data.set("localMediaEndpoint", "https://server.invalid/private");
        f.media.libraryIdentity = () =>
            "browser:" + (f.data.get("localMediaEndpoint") || "");
        f.media.libraryWrite = (identity) => ({
            key: "localMediaEndpoint",
            value: identity.slice(8),
        });
        await saved(f);
        f.data.set("localMediaEndpoint", "");
        const before = f.data.get("offlineProfiles"),
            write = f.host.stbSetItem;
        let once = false;
        f.host.stbSetItem = (key, value) => {
            if (mode === "endpoint-reject" && key === "localMediaEndpoint")
                return;
            if (mode === "profile-reject" && key === "offlineProfiles") return;
            write(key, value);
            if (!once && key === "offlineProfiles") {
                once = true;
                if (mode === "profile-throw-after")
                    throw new Error("storage rejected after write");
                if (mode === "foreign-endpoint")
                    write(
                        "localMediaEndpoint",
                        "https://external.invalid/other"
                    );
                if (mode === "foreign-driver")
                    f.host.__ottActiveProviderDriver = { id: "m3u" };
            }
        };
        assert.equal(
            (await f.call("profile", { number: 1 })).status,
            "rejected",
            mode
        );
        assert.equal(f.reloads, 0);
        if (mode === "foreign-endpoint")
            assert.equal(
                f.data.get("localMediaEndpoint"),
                "https://external.invalid/other"
            );
        else if (mode !== "foreign-driver")
            assert.equal(f.data.get("localMediaEndpoint"), "");
        if (mode !== "foreign-driver")
            assert.equal(f.data.get("offlineProfiles"), before);
    }
});

test("binding imported identities also bounds unreferenced history", async () => {
    const profile = await saved(fixture()),
        f = fixture();
    for (let index = 0; index < 132; index++) {
        profile.binding_id = require("node:crypto").randomUUID();
        const slot = (index % 2) + 1;
        await f.call("profile_import", {
            number: slot,
            profile: clone(profile),
        });
        await f.call("profile", { number: slot });
        f.api.bind(f.catalog());
    }
    assert.equal(
        Object.keys(JSON.parse(f.data.get("offlineProfileBindings"))).length,
        128
    );
});

test("local endpoint preparation cannot overwrite a newer profile draft", async () => {
    const f = fixture();
    f.data.set("localMediaEndpoint", "https://original.invalid/library");
    f.media.libraryIdentity = () =>
        "browser:" + (f.data.get("localMediaEndpoint") || "");
    await saved(f);
    f.data.set("localMediaEndpoint", "");
    const changed = f.api.read();
    changed.profiles[0].name = "Newer name";
    f.media.libraryWrite = (identity) => {
        f.data.set("offlineProfiles", JSON.stringify(changed));
        return { key: "localMediaEndpoint", value: identity.slice(8) };
    };
    assert.equal((await f.call("profile", { number: 1 })).status, "rejected");
    assert.equal(f.api.read().profiles[0].name, "Newer name");
    assert.equal(f.data.get("localMediaEndpoint"), "");
    assert.equal(f.reloads, 0);
});

test("profile loader cannot report success for a reentrantly replaced provider", async () => {
    const f = fixture();
    await saved(f);
    f.host.loadChannels = () => {
        f.host.__ottActiveProviderDriver = { id: "m3u" };
    };
    assert.equal((await f.call("profile", { number: 1 })).status, "rejected");
});

test("saving an unbound imported profile never turns description placeholders into grants", async () => {
    const profile = await saved(fixture()),
        f = fixture();
    profile.selected = null;
    f.host.curList = [];
    await f.call("profile_import", { number: 1, profile });
    await f.call("profile", { number: 1 });
    assert.equal(
        (await f.call("profile_save", { number: 2 })).status,
        "rejected"
    );
    assert.equal(f.api.read().profiles[1], null);
    assert.equal(f.data.has("offlineProfileBindings"), false);
});

test("save and bind reject partial or cancelled catalogs without launching another scan", async () => {
    for (const state of [{ scanning: true }, { cancelled: true }]) {
        const f = fixture();
        f.media.list = () => {
            throw new Error("Profile request must not restart enumeration");
        };
        Object.assign(f.catalog(), state);
        const result = await f.call("profile_save", { number: 1 });
        assert.equal(result.status, "rejected");
        assert.match(result.data.error, /scan to finish/);
        assert.equal(f.data.has("offlineProfiles"), false);
        await assert.rejects(f.api.bindCurrent(), /scan to finish/);
    }
});

test("save and binding reject partial or cancelled catalogs before granting source access", async () => {
    for (const flags of [{ scanning: true }, { cancelled: true }]) {
        const profile = await saved(fixture());
        const f = fixture();
        await f.call("profile_import", { number: 1, profile });
        await f.call("profile", { number: 1 });
        const before = Array.from(f.data.entries());
        f.setCatalog({ ...f.catalog(), ...flags });
        assert.throws(() => f.api.bind(f.catalog()), /scan to finish/);
        await assert.rejects(f.api.bindCurrent(), /scan to finish/);
        assert.deepEqual(Array.from(f.data.entries()), before);
        assert.equal(f.data.has("offlineProfileBindings"), false);
        const fresh = fixture();
        fresh.host.curList = [];
        fresh.setCatalog({ ...fresh.catalog(), ...flags });
        const result = await fresh.call("profile_save", { number: 1 });
        assert.equal(result.status, "rejected");
        assert.match(result.data.error, /scan to finish/);
        assert.equal(fresh.data.size, 0);
    }
});

test("profile catalog ownership ignores other slots but retains active binding and endpoint guards", async () => {
    const f = fixture();
    const profile = await saved(f);
    await f.call("profile", { number: 1 });
    const guard = f.api.catalogGuard();
    assert.equal(guard(), true);
    assert.equal(
        (await f.call("profile_import", { number: 2, profile })).status,
        "ok"
    );
    assert.equal(
        guard(),
        true,
        "inactive import must not truncate the active scan"
    );
    const before = f.data.get("offlineProfileBindings");
    const bindings = JSON.parse(before);
    bindings["11111111-1111-4111-8111-111111111111"] = clone(
        bindings[profile.binding_id]
    );
    f.data.set("offlineProfileBindings", JSON.stringify(bindings));
    assert.equal(
        guard(),
        true,
        "unrelated binding must not truncate the active scan"
    );
    bindings[profile.binding_id].selected = "OTHER-ITEM";
    f.data.set("offlineProfileBindings", JSON.stringify(bindings));
    assert.equal(guard(), false);
    f.data.set("offlineProfileBindings", before);
    assert.equal(guard(), true);
    f.media.libraryIdentity = () => "browser:https://different.invalid/library";
    assert.equal(guard(), false);
});

test("rejected in-progress save leaves no late write and retries the complete cached source set", async () => {
    const f = fixture();
    let scans = 0;
    f.media.list = () => {
        scans++;
        throw new Error("Unexpected rescan");
    };
    f.catalog().scanning = true;
    const rejected = await f.call("profile_save", { number: 1 });
    assert.equal(rejected.status, "rejected");
    assert.equal(f.data.size, 0);
    f.catalog().sources.push({ id: "SECOND", kind: "folder", name: "Second" });
    f.catalog().scanning = false;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
        f.data.size,
        0,
        "completion of the original scan cannot save a rejected request later"
    );
    assert.equal((await f.call("profile_save", { number: 1 })).status, "ok");
    assert.equal(f.api.read().profiles[0].sources.length, 2);
    assert.equal(scans, 0);
});

test("rejected in-progress binding never grants access after later ambiguous completion", async () => {
    const profile = await saved(fixture());
    const f = fixture();
    await f.call("profile_import", { number: 1, profile });
    await f.call("profile", { number: 1 });
    const before = [...f.data];
    let scans = 0;
    f.media.list = () => {
        scans++;
        throw new Error("Unexpected rescan");
    };
    f.catalog().scanning = true;
    await assert.rejects(f.api.bindCurrent(), /scan to finish/);
    f.catalog().sources.push({
        id: "DUPLICATE",
        kind: "folder",
        name: "Cartoons",
    });
    f.catalog().scanning = false;
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual([...f.data], before);
    await assert.rejects(f.api.bindCurrent(), /exactly one/);
    assert.equal(f.data.has("offlineProfileBindings"), false);
    assert.equal(scans, 0);
});
