const {
    attachSourceAliases,
    sourceNames,
} = require("./helpers/english-source-fixture.cjs");
/* Actual provider load, storage and favorites code: only proven channel identities migrate. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { localizationRuntime } = require("./helpers/localization-runtime.cjs");
const { settingsSource } = require("./helpers/settings-source-fixture.cjs");
const root = path.join(__dirname, "..");
function source(file, names) {
    names = sourceNames(file, names);
    const text = fs.readFileSync(path.join(root, file), "utf8");
    if (!names) return text.replace(/^export\s+/gm, "");
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const found = ast.statements.filter(
        (node) =>
            ts.isFunctionDeclaration(node) &&
            node.body &&
            names.includes(node.name.text)
    );
    assert.equal(found.length, names.length);
    return found
        .map((node) => node.getText(ast).replace(/^export\s+/, ""))
        .join("\n");
}
const saved = new Map();
const writes = [];
const clearedTimers = [];
let nextTimer = 1;
let loaded;
const c = {
    _: (text) => text,
    $() {
        return {
            append() {
                return this;
            },
            hide() {
                return this;
            },
            is: () => true,
        };
    },
    channels: {},
    clearTimeout: (id) => clearedTimers.push(id),
    console: { error() {}, log() {}, warn() {} },
    epgTimers: [],
    getChanelsArray: (done) => {
        loaded = done;
    },
    getDefaultPlayerMode: () => 0,
    invalidateEpgCache() {},
    launch_id: "#launch",
    localStorage: {
        getItem: (key) => (saved.has(key) ? saved.get(key) : null),
        removeItem: (key) => saved.delete(key),
        setItem: (key, value) => {
            saved.set(key, String(value));
            writes.push(key);
        },
    },
    normalizePlayerMode: (mode) => mode,
    onChanelsLoaded() {
        c.loadFavoritesLists();
        c.cats = { All: c.cList };
        c.catsArray = ["All"];
        c.loadEpgTimers();
    },
    setPlayerMode() {},
    setTimeout: () => nextTimer++,
    settings: { epgRemindMinutes: 0 },
};
c.window = c;
vm.createContext(c);
require("./helpers/shared-core-runtime.cjs")(c);
vm.runInContext(
    ts.transpileModule(
        [
            source("src/utils/lzstring.ts"),
            source("src/storage/index.ts"),
            source("src/channels/favorites-lists.ts"),
            source("src/channels/index.ts", [
                "beginPortChannelIdMigration",
                "cancelPortChannelIdMigration",
                "finishPortChannelIdMigration",
                "loadEpgTimers",
                "startEpgTimer",
            ]),
            source("src/provider/index.ts", ["loadChannels"]),
        ].join("\n"),
        {
            compilerOptions: {
                module: ts.ModuleKind.None,
                target: ts.ScriptTarget.ES5,
            },
        }
    ).outputText,
    c
);
vm.runInContext(settingsSource(), c);
c.settings.epgRemindMinutes = 0;
attachSourceAliases(c);
require("./helpers/guide-runtime-fixture.cjs").install(c);
c.setProviderPrefix("current:");
const put = (key, value) => c.providerSetItem(key, JSON.stringify(value));
const read = (key) => JSON.parse(c.providerGetItem(key));
const ids = [100, "104", 101, 102, 103, 999];
const expected = [200, "201", 101, 102, 103, 999];
put("favoritesArray", ids);
put("favoritesLists", {
    active: "Main",
    extra: "keep",
    lists: { Large: Array(100).fill(100), Main: ids },
    order: ["Main", "Large"],
    v: 1,
});
put("cats", { Custom: ids });
put("parentalArray", ids);
put("prevArr", [{ c: 100, ci: 100, extra: "keep", i: 2 }, { ci: 999 }]);
put("continueWatch", {
    catIndex: 100,
    channelId: 100,
    channelIndex: 2,
    mode: "archive",
});
put("aAspects", { "-1media": 2, 100: 4, 105: 5, 201: 6 });
put("aAudios", { 100: 3 });
put("aSubs", { 100: 1 });
c.providerSetItem("aZooms", "{malformed");
put("epgTimers", [
    {
        c: 100,
        ci: 100,
        i: 2,
        n: "Program",
        t: Date.now() / 1000 + 600,
        te: Date.now() / 1000 + 1200,
    },
]);
saved.set("foreign:favoritesArray", "[100]");
saved.set("epgTimers", '[{"ci":100,"t":9999999999,"n":"Other provider"}]');
const foreignTimers = saved.get("epgTimers");
assert(saved.get("current:favoritesLists").startsWith("\x01LZ\x01"));
function load() {
    c.loadChannels();
    c.__ottRecordPortHash(100, 200);
    c.__ottRecordPortHash(101, 201);
    c.__ottRecordPortHash(101, 202); // Ambiguous source is never guessed.
    c.__ottRecordPortHash(102, 202); // Source is already a loaded canonical ID.
    c.__ottRecordPortHash(103, 404); // Target is not loaded.
    c.__ottRecordPortHash(104, 201);
    c.__ottRecordPortHash(105, 201); // Existing target preference wins.
    c.channels = { 102: {}, 200: {}, 201: {}, 202: {} };
    c.cList = [200, 201, 202, 102];
    loaded();
    assert.equal(c.__ottRecordPortHash, undefined);
}
load();
assert.deepEqual(
    read("favoritesArray"),
    ids,
    "Raw favorites remain rollback bytes"
);
assert.deepEqual(
    Array.from(c.favoritesArray),
    [200, 201],
    "Only uniquely resolved stable favorites are projected"
);
assert.deepEqual(read("favoritesLists").lists.Main, ids);
assert(read("favoritesLists").lists.Large.every((id) => id === 100));
const favoriteEnvelope = read(
    "favoritesLibrary:" + c.__ottSourceIdentity.current(c)
);
assert.equal(favoriteEnvelope.version, 2);
assert.deepEqual(favoriteEnvelope.lists.lists.Main.slice(0, 2), [
    { itemId: "channel:200" },
    { itemId: "channel:201" },
]);
assert.equal(favoriteEnvelope.lists.lists.Main[2].ambiguous, true);
assert.equal(favoriteEnvelope.lists.lists.Main[3].ambiguous, true);
assert.deepEqual(
    favoriteEnvelope.lists.lists.Main.slice(4).map((ref) => ref.legacyId),
    [103, 999]
);
assert.equal(read("favoritesLists").extra, "keep");
assert.deepEqual(read("cats").Custom, expected);
assert.deepEqual(read("parentalArray"), expected);
assert.equal(c.prevArr[0].ci, 200);
assert.equal(c.prevArr[0].c, 100, "Category indices are not channel IDs");
assert.equal(read("continueWatch").channelId, 200);
assert.deepEqual(read("aAspects"), { "-1media": 2, 105: 5, 200: 4, 201: 6 });
assert.equal(c.aAudios[200], 3);
assert.equal(c.aSubs[200], 1);
assert.equal(c.providerGetItem("aZooms"), "{malformed");
assert.equal(
    c.epgTimers[0].ci,
    200,
    "Timers read migrated provider storage before global fallback"
);
assert.equal(saved.get("foreign:favoritesArray"), "[100]");
assert.equal(saved.get("epgTimers"), foreignTimers);
const oldTimer = nextTimer - 1;
writes.length = 0;
load();
assert(
    !writes.some((key) => key.startsWith("current:")),
    "Incremental reload must not rewrite unchanged records"
);
assert(
    clearedTimers.includes(oldTimer),
    "Reload must cancel the previously scheduled provider timer"
);

put("playbackJournal", {
    bookmark: { archiveStart: 123, channelId: "100", kind: "archive" },
    history: [
        { channelId: "100", kind: "live" },
        { channelId: "100", kind: "vod" },
    ],
    sourceId: "classic",
    updatedAt: 1000,
    version: 2,
});
load();
assert.equal(read("playbackJournal").bookmark.channelId, "200");
assert.equal(read("playbackJournal").history[0].channelId, "200");
assert.equal(
    read("playbackJournal").history[1].channelId,
    "100",
    "media identities are not channel hashes"
);
for (const envelope of [
    {
        bookmark: { channelId: "100" },
        history: [],
        sourceId: "classic",
        updatedAt: 1000,
        version: 3,
    },
    {
        bookmark: { channelId: "100" },
        history: [],
        sourceId: "other",
        updatedAt: 1000,
        version: 2,
    },
    {
        bookmark: { channelId: "100" },
        history: null,
        sourceId: "classic",
        updatedAt: 1000,
        version: 2,
    },
]) {
    put("playbackJournal", envelope);
    const before = c.providerGetItem("playbackJournal");
    load();
    assert.equal(
        c.providerGetItem("playbackJournal"),
        before,
        "migration retains unreadable envelopes byte-for-byte"
    );
}
c.providerDelItem("playbackJournal");

// A provider switch after collection must not write through stale storage functions.
put("favoritesArray", [100]);
const oldGet = c.providerGetItem;
const migration = c.beginPortChannelIdMigration();
c.__ottRecordPortHash(100, 200);
c.providerGetItem = () => "[100]";
c.finishPortChannelIdMigration(migration);
c.providerGetItem = oldGet;
assert.deepEqual(read("favoritesArray"), [100]);
// A completed request from an older load cannot release queued channel commands.
let completedLoads = 0;
const played = [];
c.onChannelsLoaded = () => {
    completedLoads++;
    c.channels = { ready: { channel_name: "Ready" } };
    c.cList = c.curList = ["ready"];
    c.catsArray = ["Current"];
    c.cats = { Current: ["ready"] };
};
c.playChannel = (category, channel) => played.push([category, channel]);
c.exports = {};
const commandLocale = { window: c };
vm.createContext(commandLocale);
vm.runInContext(localizationRuntime(), commandLocale);
c.require = (name) =>
    name === "../shared/wire-contracts"
        ? require("./load-wire.cjs")()
        : name === "../localization"
          ? commandLocale
          : {};
c.document = { getElementById: () => null };
vm.runInContext(
    ts.transpileModule(
        fs.readFileSync(path.join(root, "src/commands/index.ts"), "utf8"),
        {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES5,
            },
        }
    ).outputText,
    c
);
const command = { channel_number: 1, command: "channel_by_number" };
c.loadChannels();
const olderLoad = loaded;
c.loadChannels();
const currentLoad = loaded;
assert.equal(c.commandChannelsReady, false);
olderLoad();
assert.equal(completedLoads, 0, "stale completion cannot run current startup");
assert.equal(c.commandChannelsReady, false);
assert.equal(c.exports.handleCommand(command), "deferred");
assert.deepEqual(played, []);
currentLoad();
assert.equal(completedLoads, 1);
assert.equal(c.commandChannelsReady, true);
assert.equal(c.exports.handleCommand(command), "accepted");
assert.deepEqual(played, [[0, 0]]);
olderLoad();
assert.equal(completedLoads, 1);

// A provider startup callback can itself start another asynchronous channel load.
c.onChannelsLoaded = () => c.loadChannels();
c.loadChannels();
loaded();
assert.equal(
    c.commandChannelsReady,
    false,
    "nested load remains unready after its parent returns"
);
assert.equal(c.exports.handleCommand(command), "deferred");
c.onChannelsLoaded = () => {};
loaded();
assert.equal(c.commandChannelsReady, true);
console.log(
    "PASS channel ID migration: actual load/storage/favorites, collision safety, provider isolation and reload"
);
