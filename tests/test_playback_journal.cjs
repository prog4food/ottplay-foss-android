const assert = require("node:assert/strict");
const vm = require("node:vm");
const loadPrivate = require("./helpers/private-runtime.cjs");
const sharedCore = require("./helpers/shared-core-runtime.cjs");
const plain = (v) => JSON.parse(JSON.stringify(v));

function fixture(initial = {}, options = {}) {
    const values = new Map(
        Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)])
    );
    const writes = [];
    let active = true;
    let fail = false;
    const w = { window: null };
    w.window = w;
    vm.createContext(w);
    loadPrivate(w, "src/playback/journal.ts");
    const journal = w.__ottPlaybackJournal.create({
        channelReferences: options.channelReferences,
        get: (key) => values.get(key),
        isCurrent: () => active,
        now: () => 1700000100000,
        set: (key, value) => {
            if (fail) throw new Error("quota");
            writes.push(key);
            values.set(key, value);
        },
        sourceId: "fixture",
    });
    return {
        fail: () => {
            fail = true;
        },
        journal,
        retire: () => {
            active = false;
        },
        values,
        writes,
    };
}

// First read imports without touching any version-1 bytes. IDs survive reordered views.
{
    const f = fixture({
        catsArray: ["News", "Cinema"],
        continueWatch: {
            catIndex: 1,
            channelId: 41,
            mode: "archive",
            playTime: 25,
            playType: 1700000000,
            updatedAt: 1700000000123,
            v: 1,
        },
        medHistory: [
            { request: { opaque: "preserve" }, stream_url: "rotating-url" },
        ],
        prevArr: [
            { c: 1, ci: 41, e: "Programme", i: 3, t: 1700000000 },
            { ci: "42" },
            { ci: null },
            { ci: 99, t: "bad" },
        ],
    });
    const old = new Map(f.values);
    const document = plain(f.journal.read().document);
    assert.deepEqual(document.bookmark, {
        archiveStart: 1700000000,
        channelId: "41",
        groupId: "Cinema",
        kind: "archive",
        position: 25,
    });
    assert.equal(document.updatedAt, 1700000000123);
    assert.equal(document.history.length, 2);
    assert.equal(document.history[0].groupId, "Cinema");
    assert.equal(document.history[0].label, "Programme");
    assert.deepEqual(f.writes, []);
    assert.equal(f.journal.update({ history: document.history }), true);
    assert.deepEqual(f.writes, ["playbackJournal"]);
    for (const [key, value] of old)
        assert.equal(
            f.values.get(key),
            value,
            "rollback bytes remain intact: " + key
        );
    const saved = JSON.parse(f.values.get("playbackJournal"));
    assert.equal(saved.version, 2);
    assert.equal(
        saved.updatedAt,
        document.updatedAt,
        "history-only write cannot refresh expired bookmark"
    );
    assert.equal(saved.history[0].ci, undefined);
    assert.equal(saved.history[0].c, undefined);
    document.history[0].channelId = "mutated";
    assert.equal(f.journal.read().document.history[0].channelId, "41");
}

// Canonical data wins over stale mirrors, including explicit empty history.
{
    const f = fixture({
        continueWatch: { channelId: 123, mode: "live", v: 1 },
        prevArr: [{ ci: 123 }],
    });
    assert.equal(
        f.journal.update({
            bookmark: { channelId: "42", kind: "live" },
            history: [],
        }),
        true
    );
    f.values.set("prevArr", JSON.stringify([{ ci: 999 }]));
    assert.deepEqual(plain(f.journal.read().document.history), []);
    assert.equal(f.journal.read().document.bookmark.channelId, "42");
    assert.equal(f.journal.read().document.bookmark.kind, "live");
}

for (const raw of [
    "{broken",
    "null",
    JSON.stringify({ version: 3 }),
    JSON.stringify({
        history: [],
        sourceId: "another",
        updatedAt: 0,
        version: 2,
    }),
]) {
    const f = fixture({ prevArr: [{ ci: 123 }] });
    f.values.set("playbackJournal", raw);
    assert.equal(f.journal.read().writable, false);
    assert.equal(
        f.journal.update({ bookmark: { channelId: "1", kind: "live" } }),
        false
    );
    assert.equal(f.values.get("playbackJournal"), raw);
    assert.deepEqual(f.writes, []);
}

// Optional source-local metadata survives both journal paths without retaining
// stream addresses or references to caller-owned objects.
{
    const f = fixture();
    const hint = {
        group: "News",
        guideId: "news.two",
        name: "Two",
        routeId: "1234567",
        url: "https://stream.test/live?token=private-fixture",
    };
    const expected = {
        group: "News",
        guideId: "news.two",
        name: "Two",
        routeId: "1234567",
    };
    assert.equal(
        f.journal.update({
            bookmark: { channelHint: hint, channelId: "22", kind: "live" },
            history: [
                {
                    archiveStart: 1700000000,
                    channelHint: hint,
                    channelId: "22",
                    kind: "archive",
                },
            ],
        }),
        true
    );
    hint.name = "caller mutation";
    const read = f.journal.read().document;
    assert.deepEqual(plain(read.bookmark.channelHint), expected);
    assert.deepEqual(plain(read.history[0].channelHint), expected);
    assert(!f.values.get("playbackJournal").includes("private-fixture"));
    read.bookmark.channelHint.name = "read mutation";
    read.history[0].channelHint.name = "history mutation";
    assert.deepEqual(
        plain(f.journal.read().document.bookmark.channelHint),
        expected
    );
    assert.deepEqual(
        plain(f.journal.read().document.history[0].channelHint),
        expected
    );
    assert.equal(f.journal.update({ history: [] }), true);
    assert.deepEqual(
        plain(f.journal.read().document.bookmark.channelHint),
        expected,
        "history-only writes preserve the bookmark hint"
    );
}
for (const channelHint of [
    { group: "", guideId: "guide-only", name: "" },
    { group: "", guideId: "", name: "Name only" },
    { group: "", guideId: "guide", name: "", routeId: "0" },
]) {
    const f = fixture({
        playbackJournal: {
            bookmark: { channelHint, channelId: "22", kind: "live" },
            history: [{ channelHint, channelId: "22", kind: "live" }],
            sourceId: "fixture",
            updatedAt: 0,
            version: 2,
        },
    });
    const read = f.journal.read();
    assert.equal(read.writable, true);
    assert.deepEqual(plain(read.document.bookmark.channelHint), channelHint);
    assert.deepEqual(plain(read.document.history[0].channelHint), channelHint);
    assert.equal(f.journal.update({ bookmark: read.document.bookmark }), true);
    assert.deepEqual(
        plain(f.journal.read().document.history[0].channelHint),
        channelHint,
        "bookmark-only writes preserve history hints"
    );
}
for (const channelHint of [
    null,
    [],
    {},
    { group: "", guideId: "guide" },
    { guideId: "guide", name: "Name" },
    { group: "News", guideId: 12, name: "Name" },
    { group: [], guideId: "guide", name: "Name" },
    { group: "News", guideId: "guide", name: false },
    { group: "News", guideId: "", name: "" },
    { group: "News", guideId: " \t", name: "\n" },
    { group: "News", guideId: "", name: "", routeId: "1234567" },
]) {
    const row = { channelHint, channelId: "22", kind: "live" };
    const f = fixture({
        playbackJournal: {
            bookmark: row,
            history: [row],
            sourceId: "fixture",
            updatedAt: 0,
            version: 2,
        },
    });
    const read = f.journal.read();
    assert.equal(read.writable, true);
    assert.deepEqual(plain(read.document.bookmark), {
        channelId: "22",
        kind: "live",
    });
    assert.equal(read.document.history.length, 1);
    assert.equal(read.document.history[0].channelHint, undefined);
    assert.equal(f.journal.update({ bookmark: row, history: [row] }), true);
    assert(!f.values.get("playbackJournal").includes("channelHint"));
}
for (const routeId of [null, false, 12, {}, [], "", " \t\n"]) {
    const expected = { group: "News", guideId: "two", name: "Two" };
    const row = {
        channelHint: { ...expected, routeId },
        channelId: "22",
        kind: "live",
    };
    const f = fixture({
        playbackJournal: {
            bookmark: row,
            history: [row],
            sourceId: "fixture",
            updatedAt: 0,
            version: 2,
        },
    });
    const document = f.journal.read().document;
    assert.deepEqual(plain(document.bookmark.channelHint), expected);
    assert.deepEqual(plain(document.history[0].channelHint), expected);
    assert.equal(f.journal.update({ bookmark: row, history: [row] }), true);
    assert(!f.values.get("playbackJournal").includes("routeId"));
    assert.deepEqual(
        plain(f.journal.read().document.bookmark.channelHint),
        expected,
        "invalid optional route never discards usable station metadata"
    );
}

// Failure and cancellation leave previous complete envelope in place.
for (const fault of ["fail", "retire"]) {
    const f = fixture();
    assert.equal(
        f.journal.update({
            bookmark: { channelId: "first", kind: "vod", position: 31 },
        }),
        true
    );
    const saved = f.values.get("playbackJournal");
    f[fault]();
    assert.equal(
        f.journal.update({
            bookmark: {
                archiveStart: 123,
                channelId: "second",
                kind: "archive",
            },
        }),
        false
    );
    assert.equal(f.values.get("playbackJournal"), saved);
}
{
    const f = fixture({
        continueWatch: {
            channelId: 1,
            mode: "vod",
            playType: -99999999999,
            v: 1,
        },
    });
    assert.equal(
        f.journal.read().document.bookmark,
        null,
        "ambiguous legacy media mode is not assigned a fabricated media identity"
    );
    assert.equal(
        f.journal.update({ bookmark: { channelId: "", kind: "live" } }),
        false
    );
    assert.equal(
        f.journal.update({
            bookmark: { archiveStart: NaN, channelId: "1", kind: "archive" },
        }),
        false
    );
}

// Real adapter/state integration: new state checkpoints record the entered mode,
// restoration maps stable identities, and old stopped work cannot undo a reset.
{
    const storage = new Map();
    const w = {
        catIndex: 0,
        cats: { Cinema: [33], News: [11, 22] },
        catsArray: ["News", "Cinema"],
        channels: { 11: { rec: 24 }, 22: { rec: 24 }, 33: { rec: 24 } },
        clearTimeout() {},
        curList: [11, 22],
        medHistory: [],
        p_pref: "fixture",
        playTime: 0,
        playType: 0,
        prevArr: [],
        primaryIndex: 0,
        providerGetItem: (key) => storage.get(key) ?? null,
        providerSetItem: (key, value) => storage.set(key, value),
        setTimeout() {
            return 1;
        },
        settings: { prevCount: 2 },
        stbGetLen: () => 600,
        stbGetPosTime: () => 0,
    };
    w.window = w;
    vm.createContext(w);
    sharedCore(w);
    const api = w.__ottClassicPlayback;
    api.command({
        archiveStart: 1700000000,
        channelId: 11,
        position: 25,
        type: "archive",
    });
    assert.equal(
        JSON.parse(storage.get("playbackJournal")).bookmark.kind,
        "archive"
    );
    api.select(0, 1);
    api.command({ channelId: 22, type: "live" });
    const saved = JSON.parse(storage.get("playbackJournal"));
    assert.equal(saved.bookmark.channelId, "22");
    assert.equal(
        saved.bookmark.kind,
        "live",
        "incoming channel never inherits outgoing archive mode"
    );
    assert.equal(saved.bookmark.archiveStart, undefined);
    w.cats = { Cinema: [33], News: [22, 11] };
    w.catsArray = ["Cinema", "News"];
    w.catIndex = 0;
    w.primaryIndex = 0;
    w.curList = w.cats.Cinema;
    api.hydrate();
    assert.equal(w.catIndex, 1);
    assert.equal(w.primaryIndex, 0);
    assert.equal(w.prevArr[0].ci, 11);
    assert.equal(w.prevArr[0].c, 1);
    assert.equal(w.prevArr[0].i, 1);
    api.suspendPersistence();
    storage.clear();
    api.command({ type: "stop" });
    api.select(0, 0); // A closing classic view can still attempt to save selection.
    assert.equal(
        storage.size,
        0,
        "no legacy mirror can resurrect cleared history on next import"
    );
    api.hydrate();
    api.command({ channelId: 22, type: "live" });
    assert.equal(
        JSON.parse(storage.get("playbackJournal")).bookmark.kind,
        "live"
    );
    storage.set("playbackJournal", JSON.stringify({ version: 3 }));
    storage.set("prevArr", JSON.stringify([{ ci: 999 }]));
    w.prevArr = [{ ci: 999 }];
    api.hydrate();
    assert.deepEqual(
        plain(w.prevArr),
        [],
        "unreadable canonical data cannot reactivate stale mirrors"
    );
    api.select(0, 0);
    assert.equal(storage.get("prevArr"), JSON.stringify([{ ci: 999 }]));
    assert.equal(
        storage.get("playbackJournal"),
        JSON.stringify({ version: 3 })
    );
    // The empty OTTCLUB prefix keeps its original keys, while the managed
    // source acquires an explicit ID. Only this known anonymous source imports.
    storage.clear();
    w.p_pref = "";
    w.__ottActiveProviderDriver = { id: "ottclub" };
    const club = JSON.stringify({
        bookmark: { channelId: "22", kind: "live" },
        history: [{ channelId: "11", kind: "live", label: "Preserved" }],
        sourceId: "classic",
        updatedAt: 1700000000000,
        version: 2,
    });
    storage.set("playbackJournal", club);
    api.hydrate();
    assert.equal(
        storage.get("playbackJournal"),
        club,
        "Reading leaves legacy envelope bytes intact"
    );
    assert.equal(w.prevArr[0].ci, 11);
    api.command({ channelId: 22, type: "live" });
    const normalizedClub = JSON.parse(storage.get("playbackJournal"));
    assert.equal(normalizedClub.sourceId, "ottclub");
    assert.equal(normalizedClub.history[0].label, "Preserved");
    w.__ottActiveProviderDriver = { id: "another" };
    api.hydrate();
    assert.deepEqual(
        plain(w.prevArr),
        [],
        "Other unprefixed sources cannot import OTTCLUB history"
    );
    assert.equal(api.canMigrateJournal(), false);
    w.__ottActiveProviderDriver = { id: "ottclub" };
    storage.set(
        "playbackJournal",
        JSON.stringify({ ...normalizedClub, sourceId: "another" })
    );
    api.hydrate();
    assert.equal(
        api.canMigrateJournal(),
        false,
        "OTTCLUB alias accepts classic only"
    );
}

console.log(
    "PASS playback journal: versioned envelope, legacy import, rollback, isolation, canonical restore and reset lifetime"
);

// Fresh realms model restarts: numeric M3U URL hashes can change independently
// from station metadata, while the real library and playback adapters share storage.
// A deterministic fixture hash keeps assertions independent of the hash codec;
// the production Murmur implementation has its own vectors and browser coverage.
function playlistRouteHash(value, seed) {
    let result = seed;
    for (let index = 0; index < value.length; index++)
        result = (result * 31 + value.charCodeAt(index)) >>> 0;
    return result;
}
function playlistRestart(
    storage,
    rows,
    playlist = "https://playlist.test/list.m3u"
) {
    const w = {
        _: (value) => value,
        catIndex: Number(storage.get("catIndex") || 0),
        cats: {},
        catsArray: [],
        channels: {},
        cList: rows.map((row) => row.id),
        clearTimeout() {},
        curList: [],
        favoritesArray: [],
        m3uArr: { active: 0, M3Us: [{ www: playlist }] },
        murmurhash3_32_gc: playlistRouteHash,
        p_pref: "m3u",
        playTime: 0,
        playType: 0,
        prevArr: [],
        primaryIndex: Number(storage.get("primaryIndex") || 0),
        providerGetItem: (key) => storage.get(key) ?? null,
        providerSetItem: (key, value) => storage.set(key, value),
        setTimeout: () => 1,
        settings: { prevCount: 2 },
        sFavorites: false,
    };
    for (const row of rows)
        w.channels[row.id] = {
            category: { name: row.group ?? "News" },
            channel_name: row.name,
            epg: row.guideId ?? row.name.toLowerCase(),
            url: row.url || "https://stream.test/" + row.id + "?token=fixture",
        };
    w.window = w;
    vm.createContext(w);
    sharedCore(w);
    w.__ottChannels.mount(w);
    w.__ottClassicPlayback.hydrate();
    return w;
}

const originalStations = [
    { id: 11, name: "One" },
    { id: 22, name: "Two" },
    { id: 33, name: "Three" },
];
const rotatedStations = [
    { id: 303, name: "Three" },
    { id: 101, name: "One" },
    { id: 202, name: "Two" },
];
for (const kind of ["live", "archive"]) {
    const storage = new Map();
    const original = playlistRestart(storage, originalStations);
    const api = original.__ottClassicPlayback;
    api.command({ channelId: 11, type: "live" });
    api.select(0, 1);
    api.command({
        archiveStart: 1700000000,
        channelId: 22,
        position: kind === "archive" ? 37 : 0,
        type: kind,
    });
    const key = "playbackJournal:" + api.sourceId();
    const before = JSON.parse(storage.get(key));
    assert.deepEqual(before.bookmark.channelHint, {
        group: "News",
        guideId: "two",
        name: "Two",
        routeId: String(playlistRouteHash("https://stream.test/22", 10)),
    });
    assert(!storage.get(key).includes("token=fixture"));
    const restarted = playlistRestart(storage, rotatedStations);
    const bookmark = restarted.__ottClassicPlayback.bookmark();
    assert.equal(bookmark.channelId, 202, kind + ": rotating URL/reorder");
    assert.equal(bookmark.mode, kind);
    if (kind === "live") {
        assert.equal(restarted.primaryIndex, 2);
        assert.equal(restarted.curList[restarted.primaryIndex], 202);
    } else {
        assert.equal(bookmark.playType, 1700000000);
        assert.equal(bookmark.playTime, 37);
    }
    assert.equal(restarted.prevArr[0].ci, 101, "history follows metadata too");
    // A normal selection writes current numeric compatibility state. Reopening
    // one more realm must retain the descriptor rather than lose it on update.
    restarted.__ottClassicPlayback.select(0, 2);
    restarted.__ottClassicPlayback.command({ channelId: 202, type: "live" });
    assert.equal(
        playlistRestart(
            storage,
            originalStations
        ).__ottClassicPlayback.bookmark().channelId,
        22
    );
    const otherSource = playlistRestart(
        storage,
        rotatedStations,
        "https://playlist.test/another.m3u"
    );
    assert.notEqual(
        otherSource.__ottClassicPlayback.sourceId(),
        api.sourceId()
    );
    assert.equal(
        otherSource.__ottClassicPlayback.bookmark(),
        null,
        "same station metadata cannot import a different source's bookmark"
    );
}

for (const scenario of [
    {
        expected: 202,
        name: "unique guide ID survives station rename",
        rows: [
            { id: 101, name: "One" },
            { guideId: "two", id: 202, name: "Two renamed" },
        ],
    },
    {
        expected: 202,
        name: "duplicate guide IDs are narrowed by station name and group",
        rows: [
            { guideId: "two", id: 101, name: "One" },
            { guideId: "two", id: 202, name: "Two" },
        ],
    },
    {
        expected: null,
        name: "ambiguous metadata never chooses the first candidate",
        rows: [
            { guideId: "two", id: 101, name: "Two" },
            { guideId: "two", id: 202, name: "Two" },
        ],
    },
    {
        expected: 202,
        name: "missing guide ID uses unique exact name and group",
        rows: [
            { guideId: "", id: 101, name: "One" },
            { guideId: "", id: 202, name: "Two" },
        ],
    },
    {
        expected: null,
        name: "name alone cannot override a changed provider group",
        rows: [
            { guideId: "", id: 101, name: "One" },
            { group: "Other", guideId: "", id: 202, name: "Two" },
        ],
    },
]) {
    const storage = new Map();
    const original = playlistRestart(storage, originalStations);
    original.__ottClassicPlayback.select(0, 1);
    original.__ottClassicPlayback.command({ channelId: 22, type: "live" });
    const bookmark = playlistRestart(
        storage,
        scenario.rows
    ).__ottClassicPlayback.bookmark();
    assert.equal(
        bookmark && bookmark.channelId,
        scenario.expected,
        scenario.name
    );
}

{
    const storage = new Map();
    const original = playlistRestart(storage, originalStations);
    original.__ottClassicPlayback.select(0, 1);
    original.__ottClassicPlayback.command({ channelId: 22, type: "live" });
    const key = "playbackJournal:" + original.__ottClassicPlayback.sourceId();
    const legacy = JSON.parse(storage.get(key));
    delete legacy.bookmark.channelHint;
    legacy.history.forEach((row) => delete row.channelHint);
    storage.set(key, JSON.stringify(legacy));
    const restored = playlistRestart(storage, originalStations);
    assert.equal(restored.curList[restored.primaryIndex], 22);
    assert.equal(restored.__ottClassicPlayback.bookmark().channelId, 22);
    assert.equal(
        storage.get(key),
        JSON.stringify(legacy),
        "read keeps old bytes"
    );
}

for (const kind of ["live", "archive"]) {
    const storage = new Map();
    const original = playlistRestart(storage, [
        {
            guideId: "shared-guide",
            id: 11,
            name: "Same station",
            url: "https://stream.test/variant-a?q=old#first",
        },
        {
            guideId: "shared-guide",
            id: 22,
            name: "Same station",
            url: "https://stream.test/variant-b?q=old#first",
        },
    ]);
    original.__ottClassicPlayback.select(0, 1);
    original.__ottClassicPlayback.command({
        archiveStart: 1700000000,
        channelId: 22,
        position: kind === "archive" ? 37 : 0,
        type: kind,
    });
    const key = "playbackJournal:" + original.__ottClassicPlayback.sourceId();
    const saved = JSON.parse(storage.get(key));
    assert.deepEqual(saved.bookmark.channelHint, {
        group: "News",
        guideId: "shared-guide",
        name: "Same station",
        routeId: String(playlistRouteHash("https://stream.test/variant-b", 10)),
    });
    const rotated = [
        {
            guideId: "shared-guide",
            id: 202,
            name: "Same station",
            url: "https://stream.test/variant-a?q=new#second",
        },
        {
            guideId: "shared-guide",
            id: 101,
            name: "Same station",
            url: "https://stream.test/variant-b?q=new#second",
        },
    ];
    const restarted = playlistRestart(storage, rotated);
    const bookmark = restarted.__ottClassicPlayback.bookmark();
    assert.equal(
        bookmark.channelId,
        101,
        kind + ": distinct stable route wins"
    );
    assert.equal(bookmark.mode, kind);
    if (kind === "live")
        assert.equal(restarted.curList[restarted.primaryIndex], 101);
    else {
        assert.equal(bookmark.playType, 1700000000);
        assert.equal(bookmark.playTime, 37);
    }
    const encoded = plain(saved);
    encoded.bookmark.channelId =
        "channel-ref:" + JSON.stringify({ legacyId: 22, origin: "canonical" });
    storage.set(key, JSON.stringify(encoded));
    assert.equal(
        playlistRestart(storage, rotated).__ottClassicPlayback.bookmark()
            .channelId,
        101,
        "unresolved encoded references can use a valid route descriptor"
    );
    encoded.bookmark.channelId =
        "channel-ref:" +
        JSON.stringify({ ambiguous: true, legacyId: 22, origin: "raw" });
    storage.set(key, JSON.stringify(encoded));
    assert.equal(
        playlistRestart(storage, rotated).__ottClassicPlayback.bookmark(),
        null,
        "metadata cannot bypass an explicitly ambiguous imported reference"
    );
    const withoutRoute = plain(saved);
    delete withoutRoute.bookmark.channelHint.routeId;
    storage.set(key, JSON.stringify(withoutRoute));
    assert.equal(
        playlistRestart(storage, rotated).__ottClassicPlayback.bookmark(),
        null,
        "old metadata-only hints cannot guess among variants"
    );
    storage.set(key, JSON.stringify(saved));
    rotated[0].url = "https://stream.test/variant-b?q=other#another";
    assert.equal(
        playlistRestart(storage, rotated).__ottClassicPlayback.bookmark(),
        null,
        "same metadata and static route remain ambiguous despite different queries"
    );
    rotated[0].name = "Different metadata";
    rotated[1].name = "Different metadata";
    assert.equal(
        playlistRestart(storage, rotated).__ottClassicPlayback.bookmark(),
        null,
        "matching routes cannot override failed metadata matching"
    );
}

console.log(
    "PASS playback journal: M3U URL rotation, reordered restart, history/archive metadata, ambiguity and source isolation"
);

// The reference marker is committed inside the envelope/readback transaction.
{
    const f = fixture({}, { channelReferences: 1 });
    assert.equal(
        f.journal.update({ bookmark: { channelId: "7", kind: "live" } }),
        true
    );
    assert.equal(
        JSON.parse(f.values.get("playbackJournal")).channelReferences,
        1
    );
    f.fail();
    assert.equal(
        f.journal.update({ bookmark: { channelId: "8", kind: "live" } }),
        false
    );
    assert.equal(f.journal.read().document.bookmark.channelId, "7");
}
