const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const acorn = require("acorn");
const root = path.resolve(__dirname, "..");
const clone = (value) => JSON.parse(JSON.stringify(value));
const source = "provider@account:slot";
function run(host, file) {
    const code = ts.transpileModule(
        fs
            .readFileSync(path.join(root, file), "utf8")
            .replace(/^export /gm, ""),
        {
            compilerOptions: {
                module: ts.ModuleKind.None,
                target: ts.ScriptTarget.ES5,
            },
        }
    ).outputText;
    acorn.parse(code, { ecmaVersion: 5 });
    vm.runInContext(code, host, { filename: file });
}
const host = { window: {} };
vm.createContext(host);
run(host, "src/settings/library-backup.ts");
run(host, "src/channels/channel-references.ts");
const codec = host.window.__ottLibraryBackup;
const referenceFactory = host.window.__ottChannelReferences.create;
function document() {
    return {
        channels: {
            groups: [
                {
                    id: "custom:2",
                    inheritsMembers: false,
                    known: ["channel:a"],
                    label: "My channels",
                    members: ["channel:a", "missing:stable"],
                },
            ],
            hidden: ["provider:unused"],
            locks: ["channel:a"],
            nextGroup: 3,
            preferences: { audio: { "channel:a": 2, "missing:stable": 3 } },
            selected: { groupId: "custom:2", itemId: "missing:stable" },
            sourceId: source,
            unlocks: ["channel:b"],
            version: 1,
        },
        favorites: {
            lists: {
                active: "Main",
                lists: {
                    Main: [
                        { itemId: "channel:a" },
                        { itemId: "missing:stable" },
                        { legacyId: 99, origin: "raw" },
                        { ambiguous: true, legacyId: 7, origin: "raw" },
                    ],
                    Other: [{ itemId: "channel:b" }],
                },
                order: ["Main", "Other"],
                v: 1,
            },
            sourceId: source,
            version: 2,
        },
        sourceId: source,
    };
}
const results = [];
function check(name, fn) {
    try {
        fn();
        results.push({ name, status: "PASS" });
    } catch (error) {
        results.push({ error: error.stack, name, status: "FAIL" });
    }
}
check("strict documents preserve missing stable and raw references", () => {
    assert.equal(codec.validate(document(), source), true);
    assert.equal(
        codec.validate(
            { channels: null, favorites: null, sourceId: source },
            source
        ),
        true
    );
    assert.equal(codec.validate(document(), "another-account"), false);
});
check(
    "default-list provenance is optional, validated and retained by legacy restore",
    () => {
        const d = document();
        d.favorites.lists = {
            active: "Favorites",
            lists: { Favorites: [] },
            order: ["Favorites"],
            v: 1,
        };
        d.favorites.defaultList = "Favorites";
        assert.equal(codec.validate(d, source), true);
        const restored = codec.legacy(
            source,
            [],
            [],
            {},
            {},
            d,
            referenceFactory
        );
        assert.equal(restored.favorites.defaultList, "Favorites");
        for (const marker of [true, "Unknown", "Main"]) {
            d.favorites.defaultList = marker;
            assert.equal(codec.validate(d, source), false);
        }
        d.favorites.defaultList = "Favorites";
        delete d.favorites.lists.lists.Favorites;
        assert.equal(codec.validate(d, source), false);
    }
);
check(
    "schema rejects unsupported fields, versions, nonfinite values and prototype map keys",
    () => {
        const mutations = [
            (d) => {
                d.settings = {};
            },
            (d) => {
                d.channels.version = 2;
            },
            (d) => {
                d.favorites.version = 1;
            },
            (d) => {
                d.favorites.sourceId = "other";
            },
            (d) => {
                delete d.channels.unlocks;
            },
            (d) => {
                d.channels.nextGroup = 1.5;
            },
            (d) => {
                d.channels.preferences.audio["channel:a"] = Infinity;
            },
            (d) => {
                d.channels.preferences.extra = {};
            },
            (d) => {
                d.channels.preferences.audio = JSON.parse('{"__proto__":2}');
            },
            (d) => {
                d.favorites.lists.lists = JSON.parse(
                    '{"Main":[],"constructor":[]}'
                );
            },
            (d) => {
                d.favorites.lists.lists.Main[0].itemId = "";
            },
            (d) => {
                d.favorites.lists.lists.Main[0].url = "https://invalid/";
            },
            (d) => {
                d.favorites.lists.lists.Main[2].legacyId = NaN;
            },
            (d) => {
                d.favorites.lists.lists.Main[2].origin = "guessed";
            },
            (d) => {
                d.favorites.lists.lists.Main[2].ambiguous = undefined;
            },
            (d) => {
                d.channels.groups.push(clone(d.channels.groups[0]));
            },
            (d) => {
                d.channels.hidden = ["x", "x"];
            },
            (d) => {
                d.channels.unlocks.push("channel:a");
            },
            (d) => {
                d.favorites.lists.active = "Absent";
            },
            (d) => {
                d.favorites.lists.order.push("Absent");
            },
            (d) => {
                d.channels.groups = new Array(1);
            },
            (d) => {
                d.channels.locks.extra = "not JSON";
            },
        ];
        mutations.forEach((mutate, index) => {
            const d = document();
            mutate(d);
            assert.equal(codec.validate(d, source), false, "mutation " + index);
        });
    }
);
check(
    "v1 restore uses raw provenance, preserves other collections and unlocks all other known channels",
    () => {
        const current = document(),
            before = clone(current);
        const catalog = {
            7: { itemId: "channel:collision" },
            21: { itemId: "channel:a", legacyChannelId: 7 },
            30: { itemId: "channel:b", legacyChannelId: 9 },
            31: { itemId: "channel:c" },
        };
        const restored = clone(
            codec.legacy(
                source,
                [7, 9, 40, 9],
                [7, 9, 40],
                catalog,
                { 9: 30 },
                current,
                referenceFactory
            )
        );
        assert.equal(codec.validate(restored, source), true);
        assert.deepEqual(restored.channels.locks, [
            "ambiguous:7",
            "channel:b",
            "unresolved:40",
        ]);
        assert.deepEqual(restored.channels.unlocks, [
            "channel:collision",
            "channel:a",
            "channel:c",
        ]);
        assert.deepEqual(restored.channels.groups, before.channels.groups);
        assert.deepEqual(
            restored.channels.preferences,
            before.channels.preferences
        );
        assert.deepEqual(restored.favorites.lists.lists.Main, [
            { ambiguous: true, legacyId: 7, origin: "raw" },
            { itemId: "channel:b" },
            { legacyId: 40, origin: "raw" },
        ]);
        assert.deepEqual(
            restored.favorites.lists.lists.Other,
            before.favorites.lists.lists.Other
        );
        assert.deepEqual(current, before);
    }
);
check(
    "v1 empty replacement clears current locks and active favorites without dropping other lists",
    () => {
        const restored = clone(
            codec.legacy(
                source,
                [],
                [],
                { 11: { itemId: "channel:a" } },
                {},
                document(),
                referenceFactory
            )
        );
        assert.deepEqual(restored.channels.locks, []);
        assert.deepEqual(restored.channels.unlocks, ["channel:a"]);
        assert.deepEqual(restored.favorites.lists.lists.Main, []);
        assert.deepEqual(restored.favorites.lists.lists.Other, [
            { itemId: "channel:b" },
        ]);
        assert.throws(() =>
            codec.legacy(
                source,
                [],
                [Infinity],
                {},
                {},
                document(),
                referenceFactory
            )
        );
    }
);
check("v1 can create canonical owner documents before first mount", () => {
    const restored = clone(
        codec.legacy(
            source,
            [11],
            [11],
            { 11: { itemId: "channel:a" } },
            {},
            { channels: null, favorites: null, sourceId: source },
            referenceFactory
        )
    );
    assert.deepEqual(restored.channels.locks, ["channel:a"]);
    assert.deepEqual(restored.favorites.lists.lists.Favorites, [
        { itemId: "channel:a" },
    ]);
});
function libraryFixture(seed) {
    const host = { window: {} };
    vm.createContext(host);
    run(host, "src/channels/library.ts");
    run(host, "src/channels/classic-library.ts");
    let active = true,
        writes = 0;
    const library = host.window.__ottChannelLibrary.create(
        {
            current: () => active,
            get: (key) => (key === "channelLibrary:" + source ? seed : null),
            set: () => {
                writes++;
            },
            sourceId: source,
        },
        [
            {
                groupId: "g",
                groupLabel: "Group",
                id: 11,
                itemId: "channel:a",
                label: "A",
            },
        ]
    );
    return {
        host,
        library,
        retire: () => {
            active = false;
        },
        writes: () => writes,
    };
}
check(
    "channel export is detached, retains invisible state and does not persist",
    () => {
        const f = libraryFixture(JSON.stringify(document().channels));
        assert.equal(f.host.window.__ottChannels.document(), null);
        const expected = document().channels;
        Object.assign(expected.preferences, {
            aspect: {},
            subtitle: {},
            zoom: {},
        });
        const exported = f.library.document();
        assert.deepEqual(clone(exported), expected);
        f.host.channelLibraryInstance = f.library;
        assert.deepEqual(
            clone(f.host.window.__ottChannels.document()),
            expected
        );
        exported.groups[0].members.push("changed");
        exported.preferences.audio["channel:a"] = 99;
        assert.deepEqual(clone(f.library.document()), expected);
        assert.equal(f.writes(), 0);
        f.retire();
        assert.throws(() => f.library.document());
    }
);
check(
    "channel export refuses unrecognized storage instead of exporting an empty replacement",
    () => {
        assert.throws(() =>
            libraryFixture('{"version":99}').library.document()
        );
    }
);
function favoritesFixture(seed = JSON.stringify(document().favorites)) {
    let selectedSource = source,
        writes = 0;
    const saved = new Map([["favoritesLibrary:" + source, seed]]);
    const host = {
        __ottSourceIdentity: { current: () => selectedSource },
        channels: { 11: { itemId: "channel:a" }, 22: { itemId: "channel:b" } },
        providerGetItem: (key) => saved.get(key) ?? null,
        providerGetJson: (key, fallback) =>
            saved.has(key) ? JSON.parse(saved.get(key)) : fallback,
        providerSetItem: (key, value) => {
            writes++;
            saved.set(key, value);
        },
    };
    host.window = host;
    vm.createContext(host);
    require("./helpers/shared-core-runtime.cjs")(host);
    // The helper installs the application source port; replace it with this scoped fixture port.
    host.__ottSourceIdentity = { current: () => selectedSource };
    run(host, "src/channels/favorites-lists.ts");
    return {
        host,
        replace: () => {
            selectedSource = "new-account";
        },
        writes: () => writes,
    };
}
check(
    "favorites export preserves invisible references, pending view mutations and other lists without writes",
    () => {
        const f = favoritesFixture();
        assert.equal(f.host.__ottFavoritesLibrary.document(), null);
        f.host.loadFavoritesLists();
        const count = f.writes();
        f.host.favoritesArray.push(22);
        const exported = f.host.__ottFavoritesLibrary.document();
        const original = document().favorites.lists.lists.Main;
        assert.deepEqual(
            clone(exported.lists.lists.Main),
            [original[0], { itemId: "channel:b" }].concat(original.slice(1))
        );
        assert.deepEqual(clone(exported.lists.lists.Other), [
            { itemId: "channel:b" },
        ]);
        exported.lists.lists.Main[0].itemId = "changed";
        assert.equal(
            f.host.__ottFavoritesLibrary.document().lists.lists.Main[0].itemId,
            "channel:a"
        );
        assert.equal(f.writes(), count);
    }
);
check(
    "favorites reset retires pending UI changes and saving without writes",
    () => {
        const f = favoritesFixture();
        f.host.loadFavoritesLists();
        const count = f.writes();
        f.host.__ottFavoritesLibrary.reset();
        assert.equal(f.host.__ottFavoritesLibrary.document(), null);
        assert.equal(f.host.saveFavoritesLists(), false);
        assert.equal(f.writes(), count);
    }
);
check(
    "favorites refuses corrupt storage and source replacement including synchronous capture reentry",
    () => {
        const corrupt = favoritesFixture('{"version":99}');
        corrupt.host.loadFavoritesLists();
        assert.throws(() => corrupt.host.__ottFavoritesLibrary.document());
        const f = favoritesFixture();
        f.host.loadFavoritesLists();
        f.replace();
        assert.throws(() => f.host.__ottFavoritesLibrary.document());
        const reentrant = favoritesFixture();
        reentrant.host.loadFavoritesLists();
        const channels = reentrant.host.channels;
        Object.defineProperty(reentrant.host, "channels", {
            get() {
                reentrant.replace();
                return channels;
            },
        });
        assert.throws(() => reentrant.host.__ottFavoritesLibrary.document());
    }
);
check(
    "shuffle baselines are optional, strict and survive channel export/import",
    () => {
        const d = document();
        d.channels.groups[0].shuffleBefore = ["missing:stable", "channel:a"];
        d.favorites.shuffleBefore = {
            Main: clone(d.favorites.lists.lists.Main),
        };
        assert.equal(codec.validate(d, source), true);
        const first = libraryFixture(
            JSON.stringify(d.channels)
        ).library.document();
        const second = libraryFixture(JSON.stringify(first)).library.document();
        assert.deepEqual(
            clone(second.groups[0].shuffleBefore),
            d.channels.groups[0].shuffleBefore
        );
        assert.equal(
            codec.validate({ ...d, channels: clone(second) }, source),
            true
        );
        const invalid = [
            (x) => {
                x.channels.groups[0].shuffleBefore = ["same", "same"];
            },
            (x) => {
                x.channels.groups[0].shuffleBefore = [4];
            },
            (x) => {
                x.favorites.shuffleBefore = { Missing: [] };
            },
            (x) => {
                x.favorites.shuffleBefore.Main = [
                    { itemId: "a", url: "https://invalid/" },
                ];
            },
            (x) => {
                x.favorites.shuffleBefore.Main = [
                    { legacyId: 1, origin: "guessed" },
                ];
            },
            (x) => {
                x.favorites.shuffleBefore.Main = new Array(1);
            },
            (x) => {
                x.favorites.shuffleBefore = JSON.parse('{"__proto__":[]}');
            },
            (x) => {
                x.favorites.shuffleBefore.Main = new Array(50001).fill({
                    itemId: "a",
                });
            },
        ];
        invalid.forEach((mutate, i) => {
            const x = clone(d);
            mutate(x);
            assert.equal(
                codec.validate(x, source),
                false,
                "shuffle mutation " + i
            );
        });
    }
);
check(
    "actual favorites shuffle export/import restores original order and missing references",
    () => {
        const f = favoritesFixture();
        f.host.loadFavoritesLists();
        f.host.favoritesArray.push(22);
        f.host.saveFavoritesLists();
        const baseline = clone(f.host.__ottFavoritesLibrary.document());
        vm.runInContext("Math.random = function () { return 0; }", f.host);
        assert.equal(f.host.shuffleFavoritesList(), true);
        const exported = clone(f.host.__ottFavoritesLibrary.document());
        assert.equal(
            codec.validate(
                { channels: null, favorites: exported, sourceId: source },
                source
            ),
            true
        );
        const restored = favoritesFixture(JSON.stringify(exported));
        restored.host.loadFavoritesLists();
        assert.equal(restored.host.shuffleFavoritesList(true), true);
        assert.deepEqual(
            clone(restored.host.__ottFavoritesLibrary.document()),
            baseline
        );
        assert.deepEqual(Array.from(restored.host.favoritesArray), [11, 22]);
    }
);
check(
    "legacy active favorites replacement clears only its shuffle baseline",
    () => {
        const d = document();
        d.favorites.shuffleBefore = {
            Main: clone(d.favorites.lists.lists.Main),
            Other: clone(d.favorites.lists.lists.Other),
        };
        const restored = clone(
            codec.legacy(source, [], [], {}, {}, d, referenceFactory)
        );
        assert.deepEqual(restored.favorites.shuffleBefore, {
            Other: d.favorites.shuffleBefore.Other,
        });
        assert.equal(codec.validate(restored, source), true);
    }
);
console.log(JSON.stringify({ results }, null, 2));
if (results.some((result) => result.status === "FAIL")) process.exitCode = 1;
