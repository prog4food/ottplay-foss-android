const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const ts = require(path.join(root, "node_modules/typescript"));
function runSource(host, file) {
    vm.runInContext(
        ts.transpileModule(
            fs
                .readFileSync(path.join(root, file), "utf8")
                .replace(/^export /gm, ""),
            {
                compilerOptions: {
                    module: ts.ModuleKind.None,
                    target: ts.ScriptTarget.ES5,
                },
            }
        ).outputText,
        host
    );
}
const results = [];
function check(name, run) {
    try {
        run();
        results.push({ name, status: "PASS" });
    } catch (error) {
        results.push({ error: String(error), name, status: "FAIL" });
    }
}
const row = (id, locked = false) => ({
    groupId: "g",
    groupLabel: "News",
    id,
    itemId: "stream:" + id,
    label: "Channel " + id,
    locked,
});
function libraryFixture(seed = []) {
    const host = { window: {} };
    vm.createContext(host);
    runSource(host, "src/channels/library.ts");
    const saved = new Map(seed);
    const ports = {
        current: () => true,
        get: (key) => saved.get(key) ?? null,
        set: (key, value) => saved.set(key, value),
        sourceId: "source",
    };
    return {
        create: (rows) => host.window.__ottChannelLibrary.create(ports, rows),
        saved,
    };
}
check(
    "new protected records are locked after a saved empty-lock catalog",
    () => {
        const f = libraryFixture();
        f.create([row(11)]).persist();
        assert.deepEqual(
            Array.from(f.create([row(11), row(12, true)]).snapshot().locks),
            [12]
        );
    }
);
check(
    "explicit unlock survives refresh while another new adult record is locked",
    () => {
        const f = libraryFixture();
        let a = f.create([row(11, true)]);
        assert(a.lock(11, false));
        assert.deepEqual(
            Array.from(
                f.create([row(11, true), row(12, true)]).snapshot().locks
            ),
            [12]
        );
    }
);
check(
    "legacy manual lock and preference resolve when a missing record returns",
    () => {
        const f = libraryFixture([
            ["parentalArray", "[12]"],
            ["aAspects", '{"12":3}'],
        ]);
        f.create([row(11)]).persist();
        const a = f.create([row(11), row(12)]);
        assert.deepEqual(Array.from(a.snapshot().locks), [12]);
        assert.equal(a.preference("aspect", 12), 3);
    }
);
function favoritesFixture() {
    let source = "a",
        hook = null;
    const envelope = (id, item) =>
        JSON.stringify({
            lists: {
                active: "Main",
                lists: { Main: [item] },
                order: ["Main"],
                v: 1,
            },
            sourceId: id,
            version: 1,
        });
    const saved = new Map([
        ["a:favoritesLibrary:a", envelope("a", 11)],
        ["b:favoritesLibrary:b", envelope("b", 22)],
    ]);
    const host = {
        _: (s) => s,
        channels: {
            11: { itemId: "channel:11" },
            22: { itemId: "channel:22" },
        },
        providerGetItem(key) {
            const value = saved.get(source + ":" + key) ?? null;
            if (hook && key === "favoritesLibrary:a") {
                const fn = hook;
                hook = null;
                fn();
            }
            return value;
        },
        providerGetJson(key, fallback) {
            return (
                JSON.parse(saved.get(source + ":" + key) || "null") || fallback
            );
        },
        providerSetItem(key, value) {
            saved.set(source + ":" + key, value);
        },
    };
    host.window = host;
    vm.createContext(host);
    require(path.join(root, "tests/helpers/shared-core-runtime.cjs"))(host);
    host.__ottSourceIdentity = { current: () => source };
    runSource(host, "src/channels/favorites-lists.ts");
    return {
        host,
        reenter() {
            hook = () => {
                source = "b";
                host.loadFavoritesLists();
            };
        },
        saved,
    };
}
function assertB(f) {
    assert.deepEqual(Array.from(f.host.favoritesArray), [22]);
    assert.deepEqual(
        JSON.parse(f.saved.get("b:favoritesLibrary:b")).lists.lists.Main,
        [{ itemId: "channel:22" }]
    );
}
check("reentrant favorites load cannot erase the replacement source", () => {
    const f = favoritesFixture();
    f.reenter();
    f.host.loadFavoritesLists();
    assertB(f);
});
check(
    "reentrant favorites save cannot overwrite the replacement source",
    () => {
        const f = favoritesFixture();
        f.host.loadFavoritesLists();
        f.host.addFavoritesList("Extra");
        f.reenter();
        assert.equal(f.host.saveFavoritesLists(), false);
        assertB(f);
    }
);
check("unreadable favorites storage does not throw or permit writes", () => {
    const f = favoritesFixture();
    f.host.providerGetItem = () => {
        throw Error("storage blocked");
    };
    assert.doesNotThrow(() => f.host.loadFavoritesLists());
    assert.equal(f.host.saveFavoritesLists(), false);
});
function shuffleFixture() {
    const f = favoritesFixture();
    f.host.channels[33] = { itemId: "channel:33" };
    f.saved.set(
        "a:favoritesLibrary:a",
        JSON.stringify({
            lists: {
                active: "Main",
                lists: {
                    Main: [11, 44, 22, 33].map((id) => ({
                        itemId: "channel:" + id,
                    })),
                },
                order: ["Main"],
                v: 1,
            },
            sourceId: "a",
            version: 2,
        })
    );
    f.host.loadFavoritesLists();
    vm.runInContext("Math.random = function () { return 0; }", f.host);
    return f;
}
const readShuffle = (f) => JSON.parse(f.saved.get("a:favoritesLibrary:a"));
check(
    "favorites shuffle preserves hidden members, first baseline, reload and rename",
    () => {
        const f = shuffleFixture();
        const original = readShuffle(f).lists.lists.Main;
        assert.equal(f.host.shuffleFavoritesList(), true);
        assert.deepEqual(Array.from(f.host.favoritesArray), [22, 33, 11]);
        assert.equal(readShuffle(f).lists.lists.Main.length, 4);
        assert.deepEqual(readShuffle(f).shuffleBefore.Main, original);
        assert.equal(f.host.shuffleFavoritesList(), true);
        assert.deepEqual(readShuffle(f).shuffleBefore.Main, original);
        f.host.loadFavoritesLists();
        assert.equal(f.host.renameFavoritesList("Main", "Renamed"), true);
        assert.equal(f.host.saveFavoritesLists(), true);
        assert.deepEqual(readShuffle(f).shuffleBefore.Renamed, original);
        assert.equal(f.host.shuffleFavoritesList(true), true);
        assert.deepEqual(Array.from(f.host.favoritesArray), [11, 22, 33]);
        assert.deepEqual(readShuffle(f).lists.lists.Renamed, original);
        assert.equal(readShuffle(f).shuffleBefore, undefined);
        assert.equal(f.host.shuffleFavoritesList(true), false);
    }
);
check(
    "favorites reset retains additions and does not resurrect removed visible items",
    () => {
        const f = shuffleFixture();
        assert.equal(f.host.shuffleFavoritesList(), true);
        const view = f.host.activeFavoritesList();
        view.splice(view.indexOf(22), 1);
        f.host.channels[55] = { itemId: "channel:55" };
        view.push(55);
        assert.equal(f.host.saveFavoritesLists(), true);
        assert.equal(f.host.shuffleFavoritesList(true), true);
        assert.deepEqual(Array.from(f.host.favoritesArray), [11, 33, 55]);
        assert.deepEqual(
            readShuffle(f).lists.lists.Main.map((item) => item.itemId),
            ["channel:11", "channel:44", "channel:33", "channel:55"]
        );
    }
);
check(
    "favorites shuffle storage failure is atomic and does not publish a reordered view",
    () => {
        const f = shuffleFixture();
        const before = f.host.favoritesArray;
        const saved = f.saved.get("a:favoritesLibrary:a");
        f.host.providerSetItem = () => {
            throw Error("disk full");
        };
        // Rebind the source owner to this storage implementation before fault injection.
        f.host.loadFavoritesLists();
        assert.equal(f.host.shuffleFavoritesList(), false);
        assert.deepEqual(Array.from(f.host.favoritesArray), Array.from(before));
        assert.equal(f.saved.get("a:favoritesLibrary:a"), saved);
    }
);
check(
    "favorites reset resolves stable IDs after catalog renumbering and forgets deleted lists",
    () => {
        const f = shuffleFixture();
        assert.equal(f.host.shuffleFavoritesList(), true);
        f.host.channels = {
            101: { itemId: "channel:11" },
            102: { itemId: "channel:22" },
            103: { itemId: "channel:33" },
            104: { itemId: "channel:44" },
        };
        f.host.loadFavoritesLists();
        assert.equal(f.host.shuffleFavoritesList(true), true);
        assert.deepEqual(
            Array.from(f.host.favoritesArray),
            [101, 104, 102, 103]
        );
        assert.equal(f.host.shuffleFavoritesList(), true);
        assert.equal(f.host.addFavoritesList("Other"), true);
        assert.equal(f.host.deleteFavoritesList("Main"), true);
        assert.equal(f.host.saveFavoritesLists(), true);
        assert.equal(readShuffle(f).shuffleBefore, undefined);
        assert.equal(f.host.shuffleFavoritesList(true), false);
    }
);
check("favorites shuffle cannot publish over a replacement source", () => {
    const f = shuffleFixture();
    f.reenter();
    assert.equal(f.host.shuffleFavoritesList(), false);
    assertB(f);
    assert.equal(readShuffle(f).shuffleBefore, undefined);
});
console.log(JSON.stringify({ results, root }, null, 2));
if (results.some((result) => result.status === "FAIL")) process.exitCode = 1;
