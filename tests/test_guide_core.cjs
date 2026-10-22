"use strict";
const assert = require("node:assert/strict"),
    { run } = require("./helpers/guide-fixture.cjs");
const fixture = require("./fixtures/guide/legacy.json");
for (const [index, row] of fixture.cases.entries())
    assert.deepEqual(
        run(row.input),
        row.expected,
        "Captured base-player guide contract " + index
    );
console.log(
    "PASS " +
        fixture.cases.length +
        " captured base-player schedule/cache contracts"
);
