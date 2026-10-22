"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { fixture } = require("./helpers/provider-driver-fixture.cjs");
const runtime = require("./helpers/private-runtime.cjs");
const f = fixture();
const core = f.host.OttPlayCore;
const project = f.host.__ottChannelCatalog.project;
const hash = (value) => f.host.xxHash32S(value, true);
const plain = (value) => JSON.parse(JSON.stringify(value));
runtime(f.host, "src/channels/library.ts");
const channelSource = fs.readFileSync(
    path.join(__dirname, "../src/channels/index.ts"),
    "utf8"
);
const channelAst = ts.createSourceFile(
    "channels.ts",
    channelSource,
    ts.ScriptTarget.Latest,
    true
);
const migrationFunctions = [
    "beginPortChannelIdMigration",
    "cancelPortChannelIdMigration",
    "finishPortChannelIdMigration",
];
const migrationSource = channelAst.statements.filter(
    (node) =>
        ts.isFunctionDeclaration(node) &&
        migrationFunctions.includes(node.name.text)
);
assert.equal(migrationSource.length, migrationFunctions.length);
vm.runInContext(
    ts.transpileModule(
        migrationSource
            .map((node) => node.getText(channelAst).replace(/^export\s+/, ""))
            .join("\n"),
        { compilerOptions: { target: ts.ScriptTarget.ES5 } }
    ).outputText,
    f.host
);

function migrate(catalog, legacyId, preprocess = false) {
    const saved = new Map([
        ["cats", JSON.stringify({ Saved: [legacyId] })],
        ["catsArray", JSON.stringify(["Saved"])],
        ["parentalArray", JSON.stringify([legacyId])],
        ["aAudios", JSON.stringify({ [legacyId]: 2 })],
    ]);
    if (preprocess) {
        f.host.providerGetItem = (key) => saved.get(key) ?? null;
        f.host.providerSetItem = (key, value) => saved.set(key, value);
        f.host.channels = catalog.channels;
        const capture = f.host.beginPortChannelIdMigration();
        catalog.ids.forEach((id) => {
            const old = catalog.channels[id].legacyChannelId;
            if (old !== undefined) capture.record(old, id);
        });
        f.host.finishPortChannelIdMigration(capture);
    }
    const rows = catalog.ids.map((id) => {
        const row = catalog.channels[id];
        return {
            groupId: row.groupId,
            groupLabel: row.category.name,
            id,
            itemId: row.itemId,
            label: row.channel_name,
            legacyId: row.legacyChannelId,
        };
    });
    const library = f.host.__ottChannelLibrary.create(
        {
            current: () => true,
            get: (key) => saved.get(key) ?? null,
            set: (key, value) => saved.set(key, value),
            sourceId: "provider@account",
        },
        rows
    );
    return library;
}

const xtream = core.legacyXtreamClient(
    "https://portal.test",
    "viewer",
    "password",
    encodeURIComponent
);
xtream.accept({
    live_streams: [
        { name: "", stream_id: 11 },
        { name: 42, stream_id: 12 },
        { stream_id: 13 },
    ],
});
const xc = project(xtream.channelCatalog(), hash, "xtream");
assert.deepEqual(plain(xc.ids), [11, 12, 13]);
assert.equal(xc.channels[11].channel_name, "11");
assert.equal(xc.channels[11].itemId, "xtream:stream:11");
assert.equal(xc.channels[11].legacyChannelId, hash(""));
assert.equal(xc.channels[12].legacyChannelId, undefined);
assert.equal(xc.channels[13].legacyChannelId, undefined);
const importedXtream = migrate(xc, hash(""));
assert.deepEqual(
    plain(
        importedXtream.snapshot().groups.find((row) => row.label === "Saved")
            .members
    ),
    [11]
);
assert.deepEqual(plain(importedXtream.snapshot().locks), [11]);
assert.equal(importedXtream.preference("audio", 11), 2);

const stalker = new core.LegacyStalkerClient("https://portal.test", "MAC");
stalker.accept({ result: {} });
stalker.accept({
    result: [
        { ch_id: 42, name: "Only ch_id", url: "https://live.test/42" },
        { ch_id: 999, id: "43", name: "Original id" },
        { ch_id: 44, name: "" },
        { ch_id: 45, name: 45 },
        { id: "not-numeric", name: "Invalid old id" },
        { id: "48", name: 48 },
    ],
});
const sc = project(stalker.channelCatalog(), hash, "stalker");
assert.equal(sc.channels[42].itemId, "stalker:channel:42");
assert.equal(sc.channels[42].url, "https://live.test/42");
assert.equal(sc.channels[42].legacyChannelId, hash("Only ch_id"));
assert.equal(sc.channels[43].legacyChannelId, 43);
assert.equal(sc.channels[44].legacyChannelId, undefined);
assert.equal(sc.channels[45].legacyChannelId, undefined);
assert.equal(sc.channels[sc.ids[4]].legacyChannelId, undefined);
assert.equal(sc.channels[48].legacyChannelId, 48);
const importedStalker = migrate(sc, hash("Only ch_id"));
assert.deepEqual(
    plain(
        importedStalker.snapshot().groups.find((row) => row.label === "Saved")
            .members
    ),
    [42]
);
assert.deepEqual(plain(importedStalker.snapshot().locks), [42]);
assert.equal(importedStalker.preference("audio", 42), 2);

const missingReference = { ...xtream.channelCatalog()[0] };
delete missingReference.legacyReference;
const noGuess = project(
    [missingReference],
    () => {
        throw Error("No explicit reference: do not hash the display label");
    },
    "xtream"
);
assert.equal(noGuess.channels[11].legacyChannelId, undefined);
assert.equal(noGuess.channels[11].itemId, xc.channels[11].itemId);

// Legacy hashes can be ambiguous. Import must not silently choose either stream.
const duplicateClient = core.legacyXtreamClient(
    "https://portal.test",
    "viewer",
    "password",
    encodeURIComponent
);
duplicateClient.accept({
    live_streams: [
        { name: "", stream_id: 21 },
        { name: "", stream_id: 22 },
    ],
});
const duplicates = project(duplicateClient.channelCatalog(), hash, "xtream");
assert.deepEqual(plain(duplicates.ids), [21, 22]);
assert.deepEqual(
    plain(
        migrate(duplicates, hash(""))
            .snapshot()
            .groups.find((row) => row.label === "Saved").members
    ),
    []
);

function referenceCatalog(references) {
    return project(
        references.map(([id, legacyId]) => ({
            groupId: "group",
            groupName: "Group",
            itemId: "stream:" + id,
            legacyReference: { kind: "numeric-id", value: legacyId },
            name: "Channel " + id,
            providerId: String(id),
        })),
        hash,
        "stalker"
    );
}
function assertImport(catalog, oldId, expected, preprocess) {
    const library = migrate(catalog, oldId, preprocess);
    assert.deepEqual(
        plain(
            library.snapshot().groups.find((row) => row.label === "Saved")
                .members
        ),
        expected
    );
    assert.deepEqual(plain(library.snapshot().locks), expected);
    catalog.ids.forEach((id) => {
        assert.equal(
            library.preference("audio", id),
            expected.includes(id) ? 2 : undefined
        );
    });
}
for (const preprocess of [false, true]) {
    // A raw alias can also be a current channel number. Never assign another channel's state.
    assertImport(
        referenceCatalog([
            [21, 7],
            [7, 8],
        ]),
        7,
        [],
        preprocess
    );
    // The old preprocessor may already translate the number before the library sees it.
    assertImport(
        referenceCatalog([
            [21, 9],
            [7, 8],
        ]),
        9,
        [21],
        preprocess
    );
    // An ambiguous alias stays unresolved even when it is also a current channel number.
    assertImport(
        referenceCatalog([
            [21, 7],
            [7, 7],
        ]),
        7,
        [],
        preprocess
    );
    // Matching namespaces are safe in both startup orders.
    assertImport(
        referenceCatalog([
            [21, 21],
            [7, 8],
        ]),
        21,
        [21],
        preprocess
    );
}
const translatedCollision = referenceCatalog([
    [21, 9],
    [7, 21],
]);
assertImport(translatedCollision, 9, [21], false);
// Once 9 became 21, its original namespace is unknowable. Do not translate it again to 7.
assertImport(translatedCollision, 9, [], true);
{
    const names = ["constructor", "__proto__", "", "10", "2", "constructor"];
    const rows = names.map((groupName, index) => ({
        groupId: "group:" + groupName,
        groupName,
        itemId: "channel:" + index,
        name: "Channel " + index,
        providerId: String(index + 1),
    }));
    rows.push({ ...rows[0], groupName: "ignored duplicate" });
    const catalog = project(rows, hash, "fixture");
    assert.deepEqual(plain(catalog.groupOrder), names.slice(0, 5));
    assert.deepEqual(plain(catalog.ids), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(plain(catalog.groups.constructor), [1, 6]);
    assert.deepEqual(plain(catalog.groups.__proto__), [2]);
    assert.deepEqual(
        plain(catalog.ids.map((id) => catalog.channels[id].category.class)),
        [0, 1, 2, 3, 4, 0],
        "category numbers follow first appearance, including object property names"
    );
    assert.equal(catalog.groups["ignored duplicate"], undefined);
}
console.log(
    "PASS catalog migration: explicit references restore groups/locks/preferences; raw and preprocessed namespace collisions remain unresolved"
);
