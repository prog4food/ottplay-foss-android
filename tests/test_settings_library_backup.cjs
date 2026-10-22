const assert = require("node:assert/strict");
const fs = require("node:fs");
const { localizationRuntime } = require("./helpers/localization-runtime.cjs");
const vm = require("node:vm");
const ts = require("typescript");
const { settingsSource } = require("./helpers/settings-source-fixture.cjs");
const { compatibilitySource } = require("./helpers/english-source-fixture.cjs");
const plain = (value) => JSON.parse(JSON.stringify(value));
let count = 0;
function check(name, run) {
    run();
    count++;
    console.log("OK: " + name);
}
function fixture() {
    const data = new Map();
    let fail,
        hook,
        confirm,
        result,
        restarts = 0;
    const w = {
        _: (value) => value,
        catIndex: 0,
        channels: {
            10: {
                category: { name: "News" },
                itemId: "stream:A",
                legacyChannelId: 100,
            },
            20: {
                category: { name: "News" },
                itemId: "stream:B",
                legacyChannelId: 200,
            },
        },
        cList: [10, 20],
        confirmBox: (_message, yes) => {
            confirm = yes;
        },
        console,
        favoritesArray: [],
        m3uArr: { active: 0, M3Us: [{ www: "https://one.invalid/list" }] },
        p_pref: "m3u",
        primaryIndex: 0,
        restart: () => restarts++,
    };
    w.window = w;
    const read = (key) => data.get(key) ?? null;
    const write = (key, value) => {
        if (fail === key) return;
        data.set(key, String(value));
        if (hook) hook(key);
    };
    w.storage = {
        del: (key) => data.delete(key),
        get: read,
        set: write,
        setI: write,
    };
    w.providerGetItem = (key) => read("p:" + key);
    w.providerSetItem = (key, value) => write("p:" + key, value);
    w.providerDelItem = (key) => data.delete("p:" + key);
    w.providerGetJson = (key, fallback) =>
        JSON.parse(w.providerGetItem(key) || "null") || fallback;
    vm.createContext(w);
    require("./helpers/shared-core-runtime.cjs")(w);
    vm.runInContext(compatibilitySource + settingsSource(), w);
    vm.runInContext(
        ts.transpileModule(
            fs
                .readFileSync(
                    require.resolve("../src/channels/favorites-lists.ts"),
                    "utf8"
                )
                .replace(/^export /gm, ""),
            {
                compilerOptions: {
                    module: ts.ModuleKind.None,
                    target: ts.ScriptTarget.ES5,
                },
            }
        ).outputText,
        w
    );
    const source = w.__ottSourceIdentity.current(w);
    const channelKey = "p:channelLibrary:" + source,
        favoriteKey = "p:favoritesLibrary:" + source;
    const f = {
        accept() {
            if (confirm) confirm();
            return result;
        },
        channelKey,
        confirm() {
            return confirm;
        },
        data,
        export() {
            return JSON.parse(w.exportSettings());
        },
        fail(key) {
            fail = key;
        },
        favoriteKey,
        hook(fn) {
            hook = fn;
        },
        import(env) {
            result = undefined;
            confirm = undefined;
            w.importSettings(JSON.stringify(env), (ok) => {
                result = ok;
            });
        },
        mount() {
            w.loadFavoritesLists();
            w.__ottChannels.mount(w);
        },
        restarts() {
            return restarts;
        },
        result() {
            return result;
        },
        source,
        w,
    };
    return f;
}
check(
    "v2 round-trips full owner documents and preserves invisible references",
    () => {
        const f = fixture(),
            w = f.w;
        f.data.set("p:favoritesArray", "[100]");
        f.mount();
        w.__ottChannels.change("lock", 20, true);
        w.__ottChannels.change("create", "Custom", [10]);
        w.__ottChannels.setPreference("aAudios", 10, 2);
        const exported = f.export();
        assert.equal(exported.version, 2);
        assert.deepEqual(exported.tv.channels.locks, ["stream:B"]);
        assert.equal(exported.tv.channels.preferences.audio["stream:A"], 2);
        exported.tv.favorites.lists.lists[
            exported.tv.favorites.lists.active
        ].push({ itemId: "stream:missing" });
        exported.tv.channels.hidden.push("stream:missing");
        exported.tv.channels.groups[0].members.push("stream:missing");
        const oldBytes = f.data.get("p:favoritesArray");
        f.import(exported);
        assert.equal(f.result(), undefined);
        assert.equal(f.accept(), true);
        assert.equal(f.restarts(), 1);
        assert.deepEqual(
            JSON.parse(f.data.get(f.favoriteKey)),
            exported.tv.favorites
        );
        assert.deepEqual(
            JSON.parse(f.data.get(f.channelKey)),
            exported.tv.channels
        );
        assert.equal(
            f.data.get("p:favoritesArray"),
            oldBytes,
            "rollback bytes stay untouched"
        );
        f.mount();
        assert.deepEqual(plain(w.favoritesArray), [10]);
        exported.tv.channels.groups[0].inheritsMembers = false;
        exported.tv.channels.groups[0].known = [];
        assert.deepEqual(f.export().tv, exported.tv);
        w.channels[30] = {
            category: { name: "News" },
            itemId: "stream:missing",
        };
        w.cList.push(30);
        f.mount();
        assert.deepEqual(plain(w.favoritesArray), [10, 30]);
    }
);
check(
    "v2 backup round-trips shuffled favorites and channels with reset still available",
    () => {
        const f = fixture();
        f.data.set("p:favoritesArray", "[100,200]");
        f.mount();
        vm.runInContext("Math.random = function () { return 0; }", f.w);
        assert.equal(f.w.shuffleFavoritesList(), true);
        assert.equal(f.w.__ottChannels.change("shuffle", "system:all"), true);
        const exported = f.export();
        assert.deepEqual(exported.tv.favorites.shuffleBefore.Favorites, [
            { itemId: "stream:A" },
            { itemId: "stream:B" },
        ]);
        assert.deepEqual(
            exported.tv.channels.groups.find(
                (group) => group.id === "system:all"
            ).shuffleBefore,
            ["stream:A", "stream:B"]
        );
        f.import(exported);
        assert.equal(f.accept(), true);
        assert.deepEqual(
            JSON.parse(f.data.get(f.favoriteKey)),
            exported.tv.favorites
        );
        assert.deepEqual(
            JSON.parse(f.data.get(f.channelKey)),
            exported.tv.channels
        );
        f.mount();
        assert.equal(f.w.shuffleFavoritesList(true), true);
        assert.equal(
            f.w.__ottChannels.change("resetShuffle", "system:all"),
            true
        );
        assert.deepEqual(Array.from(f.w.favoritesArray), [10, 20]);
        assert.deepEqual(Array.from(f.w.cats.All), [10, 20]);
    }
);
check(
    "v1 replaces canonical active favorites and locks despite existing migration claims",
    () => {
        const f = fixture();
        f.mount();
        f.w.__ottChannels.change("lock", 10, true);
        f.data.set("p:favoritesLibrarySource", f.source);
        f.data.set("p:channelLibrarySource", f.source);
        f.import({
            favoritesArray: [200, 999],
            parentalArray: [200],
            settings: { fontSize: 3 },
            version: 1,
        });
        assert.equal(f.accept(), true);
        f.mount();
        assert.deepEqual(plain(f.w.favoritesArray), [20]);
        assert.deepEqual(plain(f.w.parentalArray), [20]);
        const exported = f.export();
        assert.deepEqual(exported.tv.channels.unlocks, ["stream:A"]);
        assert.deepEqual(
            exported.tv.favorites.lists.lists[
                exported.tv.favorites.lists.active
            ],
            [{ itemId: "stream:B" }, { legacyId: 999, origin: "raw" }]
        );
    }
);
check(
    "same-prefix account replacement and accessor replacement cancel confirmation without writes",
    () => {
        for (const replace of [
            (f) => {
                f.w.m3uArr.M3Us[0].www = "https://two.invalid/list";
            },
            (f) => {
                f.w.providerSetItem = () => {
                    throw new Error("replacement");
                };
            },
        ]) {
            const f = fixture();
            f.mount();
            const env = f.export(),
                before = [...f.data];
            f.import(env);
            replace(f);
            assert.equal(f.accept(), false);
            assert.deepEqual([...f.data], before);
            assert.equal(f.restarts(), 0);
        }
    }
);
check(
    "invalid or foreign documents and future local schemas cannot be overwritten",
    () => {
        for (const mutate of [
            (e) => {
                e.tv.sourceId = "another";
            },
            (e) => {
                e.settings = [];
            },
            (e) => {
                e.tv.channels.version = 2;
            },
            (e) => {
                e.tv.favorites.lists.active = "missing";
            },
            (e) => {
                e.settings.fontSize = -1;
            },
            (e) => {
                e.tv.channels.preferences.audio = { constructor: 2 };
            },
        ]) {
            const f = fixture();
            f.mount();
            const e = f.export();
            mutate(e);
            const before = [...f.data];
            f.import(e);
            assert.equal(f.result(), false);
            assert.equal(f.confirm(), undefined);
            assert.deepEqual([...f.data], before);
        }
        const f = fixture();
        f.mount();
        const e = f.export();
        f.data.set(f.channelKey, JSON.stringify({ version: 99 }));
        f.w.__ottChannels.reset();
        assert.throws(() => f.export());
        f.import(e);
        assert.equal(f.result(), false);
    }
);
check(
    "every partial write failure rolls back canonical documents and settings without publication",
    () => {
        for (const failed of ["channels", "favorites", "settings"]) {
            const f = fixture();
            f.mount();
            const e = f.export();
            e.tv.channels.locks = ["stream:B"];
            e.tv.favorites.lists.lists[e.tv.favorites.lists.active] = [
                { itemId: "stream:B" },
            ];
            e.settings.fontSize = 3;
            f.fail(
                failed === "channels"
                    ? f.channelKey
                    : failed === "favorites"
                      ? f.favoriteKey
                      : "sFont"
            );
            const before = [...f.data];
            f.import(e);
            assert.equal(f.accept(), false);
            assert.deepEqual([...f.data], before);
            assert.equal(f.restarts(), 0);
            assert.deepEqual(plain(f.w.parentalArray), []);
        }
    }
);
check("an intervening library edit rejects the stale confirmation", () => {
    const f = fixture();
    f.mount();
    const e = f.export();
    f.import(e);
    f.w.__ottChannels.change("lock", 10, true);
    const before = [...f.data];
    assert.equal(f.accept(), false);
    assert.deepEqual([...f.data], before);
});
check(
    "source replacement during a write stops the batch without touching replacement storage",
    () => {
        const f = fixture();
        f.mount();
        const e = f.export();
        e.tv.channels.locks = ["stream:B"];
        let writes = 0;
        f.hook(() => {
            writes++;
            f.w.m3uArr.M3Us[0].www = "https://two.invalid/list";
        });
        f.import(e);
        assert.equal(f.accept(), false);
        assert.equal(writes, 1);
        assert.equal(f.restarts(), 0);
    }
);
check(
    "post-commit effects cannot restart a replacement account or report success",
    () => {
        for (const boundary of [
            "channels",
            "favorites",
            "remote",
            "reload",
            "notice",
        ]) {
            const f = fixture();
            f.mount();
            const e = f.export();
            const replace = () => {
                f.w.m3uArr.M3Us[0].www = "https://replacement.invalid/list";
            };
            if (boundary === "channels") f.w.__ottChannels.reset = replace;
            if (boundary === "favorites")
                f.w.__ottFavoritesLibrary.reset = replace;
            if (boundary === "remote")
                f.w.__ottCommandServer = { configure: replace };
            if (boundary === "reload") f.w.loadSettings = replace;
            if (boundary === "notice") f.w.showShift = replace;
            f.import(e);
            assert.equal(f.accept(), false, boundary);
            assert.equal(f.restarts(), 0, boundary);
        }
    }
);
check(
    "rollback cannot revert an independent write to an unattempted key",
    () => {
        const f = fixture();
        f.mount();
        const e = f.export();
        e.tv.channels.locks = ["stream:B"];
        e.tv.favorites.lists.lists[e.tv.favorites.lists.active] = [
            { itemId: "stream:B" },
        ];
        const independent = JSON.stringify(e.tv.favorites),
            before = f.data.get(f.channelKey);
        f.hook((key) => {
            if (key === f.channelKey) {
                f.hook(null);
                f.data.set(f.favoriteKey, independent);
                throw new Error(
                    "write failed after another owner updated favorites"
                );
            }
        });
        f.import(e);
        assert.equal(f.accept(), false);
        assert.equal(f.data.get(f.channelKey), before);
        assert.equal(f.data.get(f.favoriteKey), independent);
        assert.equal(f.restarts(), 0);
    }
);
check(
    "import success and save failure use the selected Russian language",
    () => {
        for (const fail of [false, true]) {
            const f = fixture();
            f.mount();
            const notices = [];
            f.w.showShift = (message) => notices.push(message);
            vm.runInContext(localizationRuntime(), f.w);
            vm.runInContext(
                fs.readFileSync(
                    require.resolve("../locales/russian.js"),
                    "utf8"
                ),
                f.w
            );
            const e = f.export();
            e.settings.fontSize = 3;
            if (fail) f.fail("sFont");
            f.import(e);
            assert.equal(f.accept(), !fail);
            assert.deepEqual(notices, [
                fail
                    ? "Не удалось сохранить настройки"
                    : "Настройки импортированы",
            ]);
        }
    }
);
check(
    "backup restore preserves generated default-list provenance without inventing it for custom names",
    () => {
        const f = fixture();
        f.mount();
        const saved = f.export();
        assert.equal(saved.tv.favorites.defaultList, "Favorites");
        assert(f.w.renameFavoritesList("Favorites", "Custom"));
        assert(f.w.saveFavoritesLists());
        f.import(saved);
        assert.equal(f.accept(), true);
        f.mount();
        assert.equal(f.export().tv.favorites.defaultList, "Favorites");
        delete saved.tv.favorites.defaultList;
        f.import(saved);
        assert.equal(f.accept(), true);
        f.mount();
        assert.equal(f.export().tv.favorites.defaultList, undefined);
    }
);
check(
    "JSON settings export/import round-trips offline descriptions without local bindings",
    () => {
        const f = fixture();
        f.mount();
        const profilesCode = require("./helpers/offline-profile-source.cjs")(
            false
        );
        f.w.stbGetItem = f.w.storage.get;
        f.w.stbSetItem = f.w.storage.set;
        f.w.stbDelItem = f.w.storage.del;
        vm.runInContext(profilesCode, f.w);
        f.w.installOfflineProfiles(f.w, { libraryIdentity: () => "browser:" });
        const store = {
            active: -1,
            profiles: Array(15).fill(null),
            version: 1,
        };
        f.data.set("offlineProfiles", JSON.stringify(store));
        f.data.set("offlineProfileBindings", "PRIVATE_BOOKMARK");
        const exported = f.export();
        assert.deepEqual(exported.offline_profiles, store);
        assert(!JSON.stringify(exported).includes("PRIVATE_BOOKMARK"));
        f.import(exported);
        assert.equal(f.accept(), true);
        assert.equal(f.data.get("offlineProfileBindings"), "PRIVATE_BOOKMARK");
        const malformed = f.export();
        malformed.offline_profiles.bookmark = "FOREIGN";
        f.import(malformed);
        assert.equal(f.accept(), false);
        assert.equal(f.data.get("offlineProfileBindings"), "PRIVATE_BOOKMARK");
    }
);
function offlineTransition() {
    const f = fixture(),
        w = f.w;
    w.p_pref = "offline";
    w.__ottActiveProviderDriver = { id: "offline" };
    w.stbGetItem = w.storage.get;
    w.stbSetItem = w.storage.set;
    w.stbDelItem = w.storage.del;
    vm.runInContext(require("./helpers/offline-profile-source.cjs")(false), w);
    w.installOfflineProfiles(w, { libraryIdentity: () => "browser:" });
    const store = { active: 1, profiles: Array(15).fill(null), version: 1 };
    for (const index of [0, 1, 2])
        store.profiles[index] = {
            binding_id: "11111111-1111-4111-8111-11111111111" + index,
            name: "Profile " + (index + 1),
            provider: "offline",
            selected: null,
            sources: [{ key: "s0", kind: "folder", name: "Cartoons" }],
            version: 1,
        };
    f.data.set("offlineProfiles", JSON.stringify(store));
    f.data.set("offlineProfileBindings", "PRIVATE_LOCAL_BINDINGS");
    f.mount();
    const exported = f.export();
    exported.tv.channels.locks = ["stream:B"];
    exported.settings.fontSize = 3;
    store.active = 0;
    f.data.set("offlineProfiles", JSON.stringify(store));
    f.mount();
    return { exported, f, store };
}
check(
    "JSON offline import changes slot and writes library documents to the imported namespace",
    () => {
        const { f, exported } = offlineTransition();
        const oldChannels = f.data.get("p:channelLibrary:offline:0"),
            oldFavorites = f.data.get("p:favoritesLibrary:offline:0");
        assert.equal(f.w.__ottSourceIdentity.current(f.w), "offline:0");
        assert.equal(exported.tv.sourceId, "offline:1");
        f.import(exported);
        assert.equal(f.result(), undefined);
        assert.equal(f.accept(), true);
        assert.equal(f.restarts(), 1);
        assert.equal(f.w.__ottSourceIdentity.current(f.w), "offline:1");
        assert.equal(
            f.data.get("offlineProfiles"),
            JSON.stringify(exported.offline_profiles)
        );
        assert.deepEqual(
            JSON.parse(f.data.get("p:channelLibrary:offline:1")),
            exported.tv.channels
        );
        assert.deepEqual(
            JSON.parse(f.data.get("p:favoritesLibrary:offline:1")),
            exported.tv.favorites
        );
        assert.equal(f.data.get("p:channelLibrary:offline:0"), oldChannels);
        assert.equal(f.data.get("p:favoritesLibrary:offline:0"), oldFavorites);
        assert.equal(
            f.data.get("offlineProfileBindings"),
            "PRIVATE_LOCAL_BINDINGS"
        );
    }
);
check(
    "offline import rejects a TV document that does not belong to its imported slot",
    () => {
        const { f, exported } = offlineTransition();
        const before = [...f.data];
        exported.tv.sourceId = "offline:0";
        f.import(exported);
        assert.equal(f.result(), false);
        assert.equal(f.confirm(), undefined);
        assert.deepEqual([...f.data], before);
    }
);
check(
    "offline slot transition rolls back every failed write without changing private bindings",
    () => {
        for (const key of [
            "offlineProfiles",
            "p:channelLibrary:offline:1",
            "p:favoritesLibrary:offline:1",
            "sFont",
        ]) {
            const { f, exported } = offlineTransition();
            // Ensure even the favorites write changes bytes rather than being a no-op.
            exported.tv.favorites.lists.lists[
                exported.tv.favorites.lists.active
            ] = [{ itemId: "stream:B" }];
            f.fail(key);
            const before = [...f.data].sort();
            f.import(exported);
            assert.equal(f.accept(), false, key);
            assert.deepEqual([...f.data].sort(), before, key);
            assert.equal(f.restarts(), 0, key);
        }
    }
);
check(
    "offline transition cannot adopt changed confirmation, storage, driver or post-write bytes",
    () => {
        for (const boundary of [
            "confirmation",
            "storage",
            "driver",
            "profile-write",
            "notice",
        ]) {
            const { f, exported, store } = offlineTransition();
            f.import(exported);
            const replacement = () => {
                store.active = 2;
                f.data.set("offlineProfiles", JSON.stringify(store));
            };
            if (boundary === "confirmation") replacement();
            if (boundary === "storage") f.w.stbSetItem = () => {};
            if (boundary === "driver")
                f.w.__ottActiveProviderDriver = { id: "offline" };
            if (boundary === "profile-write")
                f.hook((key) => {
                    if (key === "offlineProfiles") replacement();
                });
            if (boundary === "notice") f.w.showShift = replacement;
            const before = [...f.data];
            assert.equal(f.accept(), false, boundary);
            assert.equal(f.restarts(), 0, boundary);
            if (["confirmation", "storage", "driver"].includes(boundary))
                assert.deepEqual([...f.data], before, boundary);
            if (["profile-write", "notice"].includes(boundary))
                assert.equal(
                    f.data.get("offlineProfiles"),
                    JSON.stringify(store),
                    boundary
                );
            assert.equal(
                f.data.get("offlineProfileBindings"),
                "PRIVATE_LOCAL_BINDINGS",
                boundary
            );
        }
    }
);
check(
    "offline import cannot publish effects after a later write restores exact prior profile bytes",
    () => {
        for (const key of [
            "p:channelLibrary:offline:1",
            "p:favoritesLibrary:offline:1",
            "sFont",
        ]) {
            const { f, exported } = offlineTransition();
            const before = f.data.get("offlineProfiles"),
                originalFont = f.w.settings.fontSize;
            let effects = 0,
                replaced = false;
            f.w.setFontSize = () => effects++;
            f.hook((writtenKey) => {
                if (writtenKey !== key) return;
                assert.equal(
                    f.data.get("offlineProfiles"),
                    JSON.stringify(exported.offline_profiles)
                );
                f.data.set("offlineProfiles", before);
                replaced = true;
            });
            f.import(exported);
            assert.equal(f.accept(), false, key);
            assert(replaced, key);
            assert.equal(f.data.get("offlineProfiles"), before, key);
            assert.equal(
                f.w.__ottSourceIdentity.current(f.w),
                "offline:0",
                key
            );
            assert.equal(f.w.settings.fontSize, originalFont, key);
            assert.equal(effects, 0, key);
            assert.equal(f.restarts(), 0, key);
            assert.equal(
                f.data.get("offlineProfileBindings"),
                "PRIVATE_LOCAL_BINDINGS",
                key
            );
        }
    }
);
console.log("OK: " + count + " settings/library backup integration groups");
