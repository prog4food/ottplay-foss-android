const assert = require("node:assert/strict");
const vm = require("node:vm");
const runtime = require("./helpers/private-runtime.cjs");
const context = vm.createContext({ window: {} });
runtime(context, "src/channels/library.ts");
runtime(context, "src/provider/source-identity.ts");
const create = context.window.__ottChannelLibrary.create;
const saved = new Map();
let source = "provider@account-a";
let broken = false;
const rows = [
    {
        groupId: "genre:7",
        groupLabel: "News",
        id: 11,
        itemId: "stream:10",
        label: "News",
        locked: true,
    },
    {
        groupId: "genre:7",
        groupLabel: "News",
        id: 12,
        itemId: "stream:20",
        label: "Sport",
    },
    {
        groupId: "genre:9",
        groupLabel: "Movies",
        id: 13,
        itemId: "stream:30",
        label: "Film",
    },
];
function library(catalog = rows, legacySelection) {
    const owner = source;
    return create(
        {
            current: () => source === owner,
            get: (k) => saved.get(k) ?? null,
            legacySelection,
            set: (k, v) => {
                if (broken) throw Error("storage full");
                saved.set(k, v);
            },
            sourceId: owner,
        },
        catalog
    );
}
const plain = (x) => JSON.parse(JSON.stringify(x));
let a = library();
assert.deepEqual(
    plain(a.snapshot().locks),
    [11],
    "provider adult protection initializes once"
);
assert(a.setPreference("audio", 11, 2));
assert(a.select("genre:7", 12));
const custom = a.createGroup("Weekend", "genre:7");
assert(custom);
assert.equal(
    a.createGroup("Weekend"),
    null,
    "labels must remain unambiguous for renderer"
);
assert(a.renameGroup(custom, "Evening"));
assert(a.changeMember(custom, 11, "remove"));
assert(a.changeMember(custom, 13, "add"));
assert(a.changeMember(custom, 13, "move", -1));
assert.deepEqual(
    plain(a.snapshot().groups.find((g) => g.id === custom).members),
    [13, 12]
);
const renamed = rows
    .slice()
    .reverse()
    .map((row) => ({
        ...row,
        groupLabel: row.groupId === "genre:7" ? "Actualités" : "Cinéma",
        label: "Renamed " + row.label,
    }));
a = library(renamed);
assert.equal(a.preference("audio", 11), 2);
assert.deepEqual(plain(a.snapshot().selected), {
    groupId: "genre:7",
    itemId: "stream:20",
});
assert.equal(
    a.snapshot().groups.find((g) => g.id === "genre:7").label,
    "Actualités"
);
assert.equal(a.snapshot().groups.find((g) => g.id === custom).label, "Evening");
assert.deepEqual(
    plain(a.snapshot().groups.find((g) => g.id === custom).members),
    [13, 12]
);
let missing = library(renamed.filter((row) => row.id !== 12));
assert.deepEqual(
    plain(missing.snapshot().groups.find((g) => g.id === custom).members),
    [13]
);
assert(missing.setPreference("zoom", 13, 2));
a = library(rows);
assert.deepEqual(
    plain(a.snapshot().groups.find((g) => g.id === custom).members),
    [13, 12],
    "missing records return without erasing user data"
);
const snapshot = plain(a.snapshot());
broken = true;
assert.equal(a.renameGroup(custom, "Lost"), false);
assert.deepEqual(
    plain(a.snapshot()),
    snapshot,
    "failed commit leaves current model intact"
);
broken = false;
source = "provider@account-b";
assert.equal(a.lock(11, false), false, "retired source cannot write");
let b = library();
assert.equal(
    b.preference("audio", 11),
    undefined,
    "same numeric ID in another account is isolated"
);
assert.equal(
    b.snapshot().groups.some((g) => g.id === custom),
    false
);
const bkey = "channelLibrary:" + source;
saved.set(bkey, '{"version":999}');
b = library();
assert.equal(b.createGroup("Do not overwrite"), null);
assert.equal(saved.get(bkey), '{"version":999}');
// Migration is one-time, leaves prior keys intact, and resolves only known runtime identities.
saved.clear();
saved.set("catsArray", JSON.stringify(["News", "Movies"]));
saved.set("cats", JSON.stringify({ Movies: [13], News: [11, 12] }));
a = library(rows, {
    category: 1,
    favorites: null,
    index: 1,
    virtualLabels: ["All", "Favorites"],
});
assert.deepEqual(
    plain(a.snapshot().selected),
    { groupId: "genre:7", itemId: "stream:20" },
    "hydrated legacy positions include virtual All even when storage did not"
);
saved.set("catIndex", "0");
saved.set("primaryIndex", "0");
a = library(rows, {
    category: 1,
    favorites: [13],
    index: 1,
    virtualLabels: ["All", "Favorites"],
});
assert.deepEqual(
    plain(a.snapshot().selected),
    { groupId: "system:favorites", itemId: "stream:30" },
    "persisted selection takes precedence and resolves Favorites by identity"
);
saved.clear();
source = "m3u:0@one";
saved.set("catsArray", JSON.stringify(["All", "Custom"]));
saved.set("cats", JSON.stringify({ All: [11, 12, 13], Custom: [12, 999] }));
saved.set("aAspects", JSON.stringify({ "-1media": 2, 11: 1 }));
saved.set("parentalArray", JSON.stringify([12]));
a = library();
assert.equal(a.preference("aspect", 11), 1);
assert.equal(a.preference("aspect", null), 2);
assert.deepEqual(plain(a.snapshot().locks), [12]);
assert(a.setPreference("zoom", 11, 3));
source = "m3u:0@two";
b = library();
assert.equal(b.preference("aspect", 11), undefined);
assert.equal(
    b.snapshot().groups.some((g) => g.label === "Custom"),
    false
);
source = "m3u:0@one";
a = library();
assert.equal(a.preference("zoom", 11), 3);

// New adult entries inherit provider protection; explicit unlocks survive refresh.
saved.clear();
source = "provider@parental";
a = library([rows[1]]);
assert(a.persist());
a = library(rows);
assert.deepEqual(plain(a.snapshot().locks), [11]);
assert(a.lock(11, false));
a = library(rows);
assert.deepEqual(plain(a.snapshot().locks), []);
assert(a.lock(11, true));
a = library(rows);
assert.deepEqual(plain(a.snapshot().locks), [11]);
// Renaming a provider group must not freeze its catalog membership or order.
saved.clear();
source = "provider@refresh";
a = library();
assert(a.renameGroup("genre:7", "My news"));
const fresh = [
    rows[1],
    rows[0],
    {
        groupId: "genre:7",
        groupLabel: "News",
        id: 14,
        itemId: "stream:40",
        label: "New",
    },
    rows[2],
];
a = library(fresh);
assert.deepEqual(
    plain(a.snapshot().groups.find((g) => g.id === "genre:7").members),
    [12, 11, 14]
);
assert(a.changeMember("genre:7", 11, "remove"));
a = library(
    fresh.concat({
        groupId: "genre:7",
        groupLabel: "News",
        id: 15,
        itemId: "stream:50",
        label: "Latest",
    })
);
assert.deepEqual(
    plain(a.snapshot().groups.find((g) => g.id === "genre:7").members),
    [12, 14, 15]
);
assert.equal(
    a.snapshot().groups.find((g) => g.id === "genre:7").label,
    "My news"
);
const inaccessible = create(
    {
        current: () => true,
        get: () => {
            throw Error("storage unavailable");
        },
        legacySource: "failed",
        set: () => {
            throw Error("unexpected write");
        },
        sourceId: "failed",
    },
    rows
);
assert.equal(inaccessible.snapshot().all.length, 3);
assert.equal(inaccessible.select("genre:7", 11), false);
{
    let active = true;
    let interrupt = false;
    const writes = [];
    const guarded = create(
        {
            current: () => active,
            get: () => {
                if (interrupt) active = false;
                return null;
            },
            set: (key) => writes.push(key),
            sourceId: "old",
        },
        rows
    );
    interrupt = true;
    assert.equal(guarded.lock(12, true), false);
    assert.deepEqual(
        writes,
        [],
        "replacement during storage read cannot write to the new source"
    );
}
saved.clear();
saved.set("parentalArray", "[90]");
saved.set("aAudios", '{"90":2}');
a = library([rows[0]]);
assert(a.persist());
a = library([rows[0], { ...rows[1], legacyId: 90 }]);
assert.deepEqual(plain(a.snapshot().locks), [12]);
assert.equal(
    a.preference("audio", 12),
    2,
    "a returning old numeric alias resolves to its provider item ID"
);
const sourceId = context.window.__ottSourceIdentity;
{
    const document = {
        groups: [
            {
                id: "edited",
                known: ["__proto__", "removed"],
                label: "Edited",
                members: ["constructor", "unresolved:99", "absent"],
            },
            {
                id: "inherited",
                inheritsMembers: true,
                known: ["old"],
                label: "",
                members: ["old"],
            },
            { id: "hidden", label: "Hidden", members: ["constructor"] },
        ],
        hidden: ["hidden", "__proto__"],
        locks: [],
        nextGroup: 1,
        preferences: {},
        selected: null,
        sourceId: "membership",
        unlocks: [],
        version: 1,
    };
    const catalog = [
        [1, "edited", "__proto__"],
        [2, "edited", "constructor"],
        [3, "edited", "new"],
        [4, "edited", "removed"],
        [99, "edited", "returned"],
        [5, "inherited", "fresh"],
        [6, "hidden", "invisible"],
        [7, "__proto__", "also-invisible"],
    ].map(([id, groupId, itemId]) => ({
        groupId,
        groupLabel: groupId,
        id,
        itemId,
        label: itemId,
    }));
    const edited = create(
        {
            current: () => true,
            get: (key) =>
                key === "channelLibrary:membership"
                    ? JSON.stringify(document)
                    : null,
            set: () => assert.fail("snapshot must not persist"),
            sourceId: "membership",
        },
        catalog
    );
    assert.deepEqual(
        plain(edited.snapshot().groups),
        [
            { id: "edited", label: "Edited", members: [2, 99, 3, 99] },
            { id: "inherited", label: "inherited", members: [5] },
        ],
        "membership reconciliation preserves stored order, unresolved aliases, hidden groups and provider additions without reintroducing removed members"
    );
    assert.deepEqual(
        plain(edited.document()).groups[0].members,
        ["constructor", "unresolved:99", "absent"],
        "resolving a projection does not replace stored user membership"
    );
}
{
    const host = vm.createContext({ window: {} });
    runtime(host, "src/channels/classic-library.ts");
    let reads = 0;
    const selection = { groupId: "selected", itemId: "channel:2" };
    const fakeLibrary = {
        active: () => true,
        itemId: (id) => {
            reads++;
            return "channel:" + id;
        },
        persist: () => true,
        snapshot: () => ({
            all: [1, 2, 3],
            groups: [
                { id: "selected", label: "Selected", members: [1, 2, 3, 2] },
            ],
            locks: [],
            selected: selection,
        }),
    };
    Object.assign(host.window, {
        _: (label) => label,
        __ottChannelLibrary: { create: () => fakeLibrary },
        __ottSourceIdentity: { current: () => "selected" },
    });
    host.window.__ottChannels.mount(host.window);
    assert.equal(host.window.catIndex, 1);
    assert.equal(
        host.window.primaryIndex,
        1,
        "the first matching position wins"
    );
    assert.equal(
        reads,
        2,
        "selection stops reading item identities once found"
    );
    selection.itemId = "channel:missing";
    host.window.__ottChannels.refresh();
    assert.equal(
        host.window.primaryIndex,
        0,
        "missing selection uses first position"
    );
    assert.equal(reads, 6, "an absent selection visits every member once");
}
{
    const saved = new Map();
    const names = ["constructor", "__proto__", "", "10", "2", "constructor"];
    const catalog = names.map((groupId, index) => ({
        groupId,
        groupLabel: "Group " + groupId,
        id: index + 1,
        itemId: "channel:" + index,
        label: "Channel " + index,
    }));
    catalog.push({ ...catalog[0], groupId: "ignored duplicate" });
    const indexed = create(
        {
            current: () => true,
            get: (key) => saved.get(key) ?? null,
            set: (key, value) => saved.set(key, value),
            sourceId: "indexed-groups",
        },
        catalog
    );
    const original = plain(indexed.snapshot());
    assert.deepEqual(
        original.groups.map((group) => group.id),
        names.slice(0, 5),
        "provider groups keep first appearance order and accept object property names"
    );
    assert.deepEqual(original.groups[0].members, [1, 6]);
    assert.deepEqual(original.all, [1, 2, 3, 4, 5, 6, 1]);
    const disposable = indexed.snapshot();
    disposable.all.length = 0;
    disposable.groups[0].label = "Changed view";
    disposable.groups[0].members.push(99);
    disposable.groups.splice(1, 1);
    assert.deepEqual(
        plain(indexed.snapshot()),
        original,
        "view edits cannot mutate provider groups or later snapshots"
    );
    assert(indexed.renameGroup("__proto__", "Renamed"));
    assert(indexed.changeMember("constructor", 1, "remove"));
    assert(indexed.removeGroup("10"));
    const updated = plain(indexed.snapshot());
    assert.deepEqual(
        updated.groups.map((group) => [group.id, group.label, group.members]),
        [
            ["__proto__", "Renamed", [2]],
            ["constructor", "Group constructor", [6]],
            ["", "Group ", [3]],
            ["2", "Group 2", [5]],
        ],
        "edited and hidden groups remain independent of the provider index"
    );
}
const host = {
    __ottActiveProviderDriver: {
        credentials: () => ({
            password: "secret",
            server: "https://one.invalid",
            username: "a",
        }),
    },
    p_pref: "xtream",
};
const first = sourceId.current(host);
assert(!first.includes("secret") && !first.includes("one.invalid"));
host.__ottActiveProviderDriver.credentials = () => ({
    password: "changed",
    server: "https://one.invalid",
    username: "a",
});
assert.equal(
    sourceId.current(host),
    first,
    "password rotation preserves named account"
);
host.__ottActiveProviderDriver.credentials = () => ({
    password: "secret",
    server: "https://one.invalid",
    username: "b",
});
assert.notEqual(sourceId.current(host), first);
const television = sourceId.current(host);
host.__ottActiveProviderDriver.mediaSource = () => "portal-one";
const media = sourceId.media(host);
host.__ottActiveProviderDriver.mediaSource = () => "portal-two";
assert.equal(sourceId.current(host), television);
assert.notEqual(sourceId.media(host), media);
for (let slot = 0; slot < 15; slot++) {
    const h = {
        m3uArr: {
            active: slot,
            M3Us: Array.from({ length: 15 }, () => ({
                www: "https://list.invalid/live.m3u",
            })),
        },
        p_pref: "m3u",
    };
    assert(sourceId.current(h).startsWith("m3u:" + slot + "@"));
}
{
    const names = ["__proto__", "constructor", "toString", "", "unknown"];
    const catalog = names.map((itemId, index) => ({
        groupId: "test",
        groupLabel: "Test",
        id: index + 1,
        itemId,
        label: itemId,
        locked: true,
    }));
    function fromSaved(value, legacy) {
        return create(
            {
                current: () => true,
                get: (key) =>
                    key === "channelLibrary:lock-test" && !legacy
                        ? JSON.stringify(value)
                        : key === "parentalArray" && legacy
                          ? JSON.stringify(value)
                          : null,
                set: () => assert.fail("construction must not persist"),
                sourceId: "lock-test",
            },
            catalog
        );
    }
    const document = {
        groups: [],
        hidden: [],
        locks: ["unknown", "__proto__", "unknown", "constructor"],
        preferences: {},
        sourceId: "lock-test",
        unlocks: ["constructor", "toString", "", "constructor"],
        version: 1,
    };
    assert.deepEqual(plain(fromSaved(document).snapshot().locks), [5, 1]);
    assert.deepEqual(
        plain(fromSaved([1, 5, 1], true).snapshot().locks),
        [1, 5],
        "legacy explicit locks override provider defaults without losing special IDs"
    );
}
{
    let recording = false;
    const reads = [];
    const catalog = [true, false, true, true].map((locked, index) => ({
        groupId: "test",
        groupLabel: "Test",
        id: index + 1,
        get itemId() {
            if (recording) reads.push("item:" + (index + 1));
            return "item:" + (index + 1);
        },
        label: "Channel " + (index + 1),
        get locked() {
            if (recording) reads.push("locked:" + (index + 1));
            return locked;
        },
    }));
    const migrated = create(
        {
            current: () => true,
            get: (key) => {
                if (key === "parentalArray") {
                    recording = true;
                    return "[1]";
                }
                if (key === "aAspects") recording = false;
                return null;
            },
            set: () => assert.fail("construction must not persist"),
            sourceId: "legacy-read-order",
        },
        catalog
    );
    assert.deepEqual(
        reads,
        [
            "locked:1",
            "item:1",
            "locked:2",
            "locked:3",
            "item:3",
            "locked:4",
            "item:4",
            "item:3",
            "item:4",
        ],
        "legacy exclusions must preserve short-circuit reads and map only after filtering"
    );
    assert.deepEqual(plain(migrated.snapshot().locks), [1]);
}
{
    const count = 2000;
    const catalog = Array.from({ length: count }, (_, index) => ({
        groupId: "test",
        groupLabel: "Test",
        id: index + 1,
        itemId: "item:" + index,
        label: "Channel " + index,
    }));
    const document = JSON.stringify({
        groups: [],
        hidden: [],
        locks: catalog.map((row) => row.itemId),
        preferences: {},
        sourceId: "lock-cost",
        unlocks: catalog
            .filter((_, index) => index % 2 === 0)
            .map((row) => row.itemId),
        version: 1,
    });
    vm.runInContext(
        `var lockComparisons = 0, originalLockIndexOf = Array.prototype.indexOf;
        Array.prototype.indexOf = function () {
            var result = originalLockIndexOf.apply(this, arguments);
            lockComparisons += result < 0 ? this.length : result + 1;
            return result;
        };`,
        context
    );
    let result;
    try {
        result = create(
            {
                current: () => true,
                get: (key) =>
                    key === "channelLibrary:lock-cost" ? document : null,
                set: () => assert.fail("construction must not persist"),
                sourceId: "lock-cost",
            },
            catalog
        );
    } finally {
        vm.runInContext(
            "Array.prototype.indexOf = originalLockIndexOf;",
            context
        );
    }
    assert.equal(result.snapshot().locks.length, count / 2);
    assert(
        context.lockComparisons <= count * 10,
        "large lock lists must not require quadratic membership scans"
    );
}
{
    const incremental = library(rows.slice());
    assert(incremental.select("genre:7", 12));
    const before = plain(incremental.snapshot().selected);
    const newRow = {
        groupId: "genre:7",
        groupLabel: "News",
        id: 99,
        itemId: "stream:99",
        label: "Added",
    };
    incremental.append([newRow, newRow]);
    assert.deepEqual(plain(incremental.snapshot().selected), before);
    assert.deepEqual(plain(incremental.snapshot().all), [11, 12, 13, 99]);
    assert.equal(incremental.itemId(99), "stream:99");
}
{
    const host = vm.createContext({ window: {} });
    const storage = new Map();
    for (const file of [
        "src/channels/library.ts",
        "src/provider/source-identity.ts",
        "src/channels/classic-library.ts",
    ])
        runtime(host, file);
    const w = host.window;
    Object.assign(w, {
        _: (label) => label,
        channels: {
            11: { adult: 1, channel_name: "Unlocked file" },
            12: { channel_name: "Selected file" },
            13: { channel_name: "Other file" },
            14: { adult: 1, channel_name: "Late adult file" },
            15: {
                category: { name: "Adults" },
                channel_name: "Late protected category",
            },
        },
        cList: [11, 12, 13],
        p_pref: "append-protection",
        parental: /^Adults$/,
        providerGetItem: (key) => storage.get(key) ?? null,
        providerSetItem: (key, value) => storage.set(key, value),
    });
    const adapter = w.__ottChannels;
    adapter.mount(w);
    assert.deepEqual(plain(w.parentalArray), [11]);
    assert(adapter.change("lock", 11, false));
    assert(adapter.select(0, 12));
    vm.runInContext("Math.random = function () { return 0; };", host);
    assert(adapter.change("shuffle", "system:all"));
    const before = plain(adapter.document());
    assert.deepEqual(plain(w.curList), [12, 13, 11]);

    // On the next progressive load, the explicitly unlocked file also arrives
    // late. Neither its missing first batch nor a repeated row may re-lock it.
    w.cList = [12, 13];
    adapter.mount(w);
    w.cList.push(11, 14, 15);
    adapter.append([11, 14, 15, 14]);
    assert.deepEqual(
        plain(w.parentalArray),
        [14, 15],
        "appended adult metadata and category rules both protect new files"
    );
    assert.deepEqual(plain(adapter.document().unlocks), ["channel:11"]);
    assert.deepEqual(plain(adapter.document().selected), before.selected);
    assert.deepEqual(plain(adapter.document().groups), before.groups);
    assert.deepEqual(plain(w.curList), [12, 13, 11, 14, 15]);
    assert.equal(w.curList[w.primaryIndex], 12);
    assert(adapter.change("resetShuffle", "system:all"));
    assert.deepEqual(plain(w.curList), [11, 12, 13, 14, 15]);
    assert.equal(w.curList[w.primaryIndex], 12);
    assert.deepEqual(plain(w.parentalArray), [14, 15]);
}
{
    source = "shuffle-test";
    const shuffled = library();
    shuffled.select("system:all", 12);
    vm.runInContext("Math.random = function () { return 0; };", context);
    assert(shuffled.shuffleGroup("system:all"));
    assert.deepEqual(plain(shuffled.snapshot().all), [12, 13, 11]);
    assert.equal(shuffled.snapshot().selected.itemId, "stream:20");
    assert.deepEqual(plain(library().snapshot().all), [12, 13, 11]);
    shuffled.append([
        {
            groupId: "genre:7",
            groupLabel: "News",
            id: 14,
            itemId: "stream:40",
            label: "New",
        },
    ]);
    assert.deepEqual(plain(shuffled.snapshot().all), [12, 13, 11, 14]);
    assert.equal(shuffled.shuffleGroup("missing"), false);
    assert.equal(shuffled.resetShuffle("missing"), false);
    assert.equal(shuffled.isShuffled("system:all"), true);
    broken = true;
    const before = plain(shuffled.snapshot());
    assert.equal(shuffled.shuffleGroup("system:all"), false);
    assert.deepEqual(plain(shuffled.snapshot()), before);
    broken = false;
}
{
    saved.clear();
    source = "shuffle-reset-restart";
    const catalog = rows.map((row) => ({ ...row }));
    let shuffled = library(catalog.slice());
    assert.equal(shuffled.resetShuffle("system:all"), false);
    assert.equal(shuffled.isShuffled("system:all"), false);
    assert(shuffled.select("system:all", 12));
    assert(shuffled.shuffleGroup("system:all"));
    const baseline = plain(shuffled.document()).groups.find(
        (group) => group.id === "system:all"
    ).shuffleBefore;
    assert.deepEqual(
        baseline,
        catalog.map((row) => row.itemId)
    );
    assert(shuffled.shuffleGroup("system:all"));
    assert.deepEqual(
        plain(shuffled.document()).groups.find(
            (group) => group.id === "system:all"
        ).shuffleBefore,
        baseline,
        "reshuffling must retain the first original order"
    );
    shuffled = library(catalog.slice());
    assert.equal(shuffled.isShuffled("system:all"), true);
    const selected = plain(shuffled.snapshot().selected);
    assert(shuffled.resetShuffle("system:all"));
    assert.deepEqual(
        plain(shuffled.snapshot().all),
        catalog.map((row) => row.id)
    );
    assert.deepEqual(plain(shuffled.snapshot().selected), selected);
    assert.equal(shuffled.isShuffled("system:all"), false);
    assert.equal(library(catalog.slice()).isShuffled("system:all"), false);
    assert.equal(shuffled.resetShuffle("system:all"), false);
    assert(shuffled.shuffleGroup("system:all"));
    assert(shuffled.changeMember("system:all", 11, "remove"));
    const added = {
        groupId: "genre:7",
        groupLabel: "News",
        id: 140,
        itemId: "stream:140",
        label: "Added while shuffled",
    };
    shuffled.append([added]);
    assert.equal(shuffled.snapshot().all.at(-1), added.id);
    const before = plain(shuffled.snapshot());
    broken = true;
    assert.equal(shuffled.resetShuffle("system:all"), false);
    assert.deepEqual(plain(shuffled.snapshot()), before);
    assert.equal(shuffled.isShuffled("system:all"), true);
    broken = false;
    assert(shuffled.resetShuffle("system:all"));
    assert.deepEqual(
        plain(shuffled.snapshot().all),
        catalog
            .filter((row) => row.id !== 11)
            .map((row) => row.id)
            .concat(140),
        "reset preserves removals and places newly discovered media at the end"
    );
    shuffled = library(catalog.concat(added));
    assert.equal(shuffled.isShuffled("system:all"), false);
    assert.equal(shuffled.snapshot().all.includes(11), false);
    assert.equal(shuffled.snapshot().all.at(-1), 140);
}
function progressiveListFixture(provider = "plex") {
    const storage = new Map();
    const w = {
        _: (label) => label,
        channels: {},
        channelsKeyHandler: () => true,
        cList: Array.from({ length: 30 }, (_, i) => i + 1),
        p_pref: provider,
        providerGetItem: (key) => storage.get(key) ?? null,
        providerSetItem: (key, value) => storage.set(key, value),
    };
    for (const id of w.cList)
        w.channels[id] = {
            category: { name: "Films" },
            channel_name: "Film " + id,
        };
    w.window = w;
    const ctx = vm.createContext(w);
    for (const file of [
        "src/ui/screen-controller.ts",
        "src/ui/input-router.ts",
        "src/ui/classic-screen-port.ts",
        "src/channels/library.ts",
        "src/provider/source-identity.ts",
        "src/channels/classic-library.ts",
    ])
        runtime(ctx, file);
    const rendered = [];
    w.showPage = () => {
        const owner = w.__ottClassicScreenPort.commitList();
        rendered.push({
            focused: w.listArray[w.selIndex],
            owner,
            page: Math.floor(w.selIndex / 25),
            rows: Array.from(w.listDataArray),
        });
    };
    const adapter = w.__ottChannels;
    adapter.mount(w);
    adapter.select(0, 1);
    function open(category = 0, selected = 27) {
        w.listCatIndex = category;
        w.listArray = w.cats[w.catsArray[category]];
        w.listDataArray = w.listArray;
        w.listKeyHandler = w.channelsKeyHandler;
        w.selIndex = selected;
        w.showPage();
        return w.__ottClassicScreenPort.listOwner();
    }
    function append(id = 31, category = "Films") {
        w.channels[id] = {
            category: { name: category },
            channel_name: "Film " + id,
        };
        w.cList.push(id);
        adapter.append([id]);
    }
    return { adapter, append, open, rendered, w };
}
for (const provider of ["offline", "plex", "vportal"]) {
    const f = progressiveListFixture(provider);
    const owner = f.open();
    const rows = f.w.listArray;
    f.append();
    assert.deepEqual(
        Array.from(f.w.listArray),
        f.w.cList,
        provider + ": late rows reach the open list"
    );
    assert.equal(
        f.w.listArray,
        rows,
        "progress does not replace the ScreenPort model"
    );
    assert.equal(f.w.listDataArray, rows);
    assert.equal(f.w.cats.All, rows);
    assert.equal(f.w.curList, rows);
    assert.equal(f.w.__ottClassicScreenPort.listOwner(), owner);
    assert.equal(owner.foreground(), true);
    assert.equal(
        f.w.listArray[f.w.selIndex],
        28,
        "the focused channel stays selected"
    );
    assert.equal(
        f.w.curList[f.w.primaryIndex],
        1,
        "the playing channel is independent of list focus"
    );
    assert.equal(f.rendered.length, 2);
    assert.equal(f.rendered.at(-1).page, 1, "the user stays on the same page");
    f.append(32);
    assert.equal(
        f.rendered.length,
        3,
        "successive batches keep the active array connected"
    );
}
{
    const f = progressiveListFixture();
    assert(
        f.adapter.change("member", {
            action: "move",
            channelId: 1,
            delta: 0,
            groupId: "system:all",
        })
    );
    f.w.cList = f.w.cList.filter((id) => id !== 1);
    f.adapter.mount(f.w);
    f.open(0, 27);
    const focused = f.w.listArray[f.w.selIndex];
    f.append(1);
    assert.equal(
        f.w.listArray[0],
        1,
        "a late saved item resumes its stored order"
    );
    assert.equal(
        f.w.selIndex,
        28,
        "focus follows its ID when an earlier item returns"
    );
    assert.equal(f.w.listArray[f.w.selIndex], focused);
    assert.equal(f.rendered.at(-1).page, 1);
}
for (const kind of ["dialog", "editor", "picker"]) {
    const f = progressiveListFixture();
    const list = f.open();
    const overlay = f.w.__ottClassicScreenPort.openOverlay(kind, () => {});
    f.append();
    assert.equal(
        f.w.__ottScreens.current(),
        overlay,
        kind + ": progress cannot replace the overlay"
    );
    assert.equal(overlay.active(), true);
    assert.equal(list.active(), true);
    assert.equal(f.rendered.length, 1, "a covered list is not rendered");
    assert.equal(f.w.listArray.length, 31, "covered list data stays current");
    overlay.close();
    f.w.showPage();
    assert.equal(f.rendered.at(-1).rows.length, 31);
    assert.equal(f.w.__ottClassicScreenPort.listOwner(), list);
}
for (const view of ["search", "replacement", "closed", "category"]) {
    const f = progressiveListFixture();
    const owner = f.open();
    if (view === "closed") f.w.__ottClassicScreenPort.closeList();
    else {
        if (view === "category") f.w.listArray = f.w.catsArray;
        else f.w.listArray = view === "search" ? [2, 7] : ["Settings"];
        f.w.listDataArray = f.w.listArray;
        f.w.listKeyHandler = () => true;
        if (view !== "replacement") f.w.showPage();
    }
    const rows = f.w.listArray;
    const before = Array.from(rows);
    const count = f.rendered.length;
    f.append();
    assert.equal(
        f.rendered.length,
        count,
        view + ": progress cannot reopen or redraw another view"
    );
    assert.equal(f.w.listArray, rows);
    assert.deepEqual(Array.from(rows), before);
    assert.equal(f.w.cats.All.length, 31);
    if (view === "replacement")
        assert.equal(f.w.__ottClassicScreenPort.listOwner(), owner);
}
{
    const f = progressiveListFixture();
    const owner = f.open(1);
    f.append(31, "Other");
    assert.equal(f.rendered.length, 1, "unaffected category does not redraw");
    assert.equal(f.w.listArray, f.w.cats.Films);
    f.append(32, "Films");
    assert.equal(f.rendered.length, 2);
    assert.equal(f.w.listArray.at(-1), 32);
    assert.equal(f.w.listArray.includes(31), false);
    assert.equal(f.w.__ottClassicScreenPort.listOwner(), owner);
}
{
    const f = progressiveListFixture();
    const old = f.open();
    let replacement;
    f.w._ = (label) => {
        if (label === "All" && !replacement) {
            f.w.listArray = ["Settings opened during publication"];
            f.w.listDataArray = f.w.listArray;
            f.w.listKeyHandler = () => true;
            f.w.showPage();
            replacement = f.w.__ottClassicScreenPort.listOwner();
        }
        return label;
    };
    f.append();
    assert.equal(old.active(), false);
    assert.equal(f.w.__ottClassicScreenPort.listOwner(), replacement);
    assert.deepEqual(Array.from(f.w.listArray), [
        "Settings opened during publication",
    ]);
    assert.equal(
        f.rendered.length,
        2,
        "publication reentry keeps the replacement view untouched"
    );
}
console.log(
    "Channel library: stable identity, catalog/user separation, migration, account isolation, storage failures PASS"
);
{
    const f = progressiveListFixture("offline");
    const list = f.adapter.capture(0);
    f.w.primaryIndex = 7;
    f.w.cats.All.slice = () =>
        assert.fail("scalar footer neighbour must not clone the catalog");
    assert.deepEqual(JSON.parse(JSON.stringify(list.neighbours("8"))), {
        id: 8,
        index: 7,
        length: 30,
        nextId: 9,
    });
    assert.equal(
        list.neighbours(30).nextId,
        1,
        "last known entry wraps without a list copy"
    );
    f.w.channels = {};
    assert.equal(
        list.neighbours(8),
        null,
        "retired catalog cannot supply stale metadata"
    );
}
