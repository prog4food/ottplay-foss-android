"use strict";
const assert = require("node:assert/strict"),
    { run } = require("./helpers/stalker-fixture.cjs");
const fixture = require("./fixtures/stalker/legacy.json");
for (const [index, row] of fixture.cases.entries())
    assert.deepEqual(
        run(row.input),
        row.expected,
        "Captured base-player Stalker contract " + index
    );
console.log(
    "PASS " +
        fixture.cases.length +
        " captured base-player Stalker catalog/session/EPG contracts"
);
const bestlist = require("./helpers/bestlist-xtream-fixture.cjs"),
    saved = require("./fixtures/stalker/bestlist-xtream.json");
for (const [index, row] of saved.cases.entries())
    assert.deepEqual(
        bestlist.run(row.input),
        row.expected,
        "Captured BEST LiST Xtream contract " + index
    );
console.log(
    "PASS " +
        saved.cases.length +
        " captured BEST LiST Xtream/fallback contracts"
);
