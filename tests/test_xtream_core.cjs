"use strict";
const assert = require("node:assert/strict"),
    runner = require("./helpers/xtream-fixture.cjs"),
    fixture = require("./fixtures/xtream/legacy.json");
for (const row of fixture.cases)
    assert.deepEqual(runner.run(row.input), row.expected);
for (const row of fixture.guide)
    assert.deepEqual(runner.guide(row.input), row.expected);
console.log(
    "PASS " +
        (fixture.cases.length + fixture.guide.length) +
        " captured base-player Xtream catalog/EPG contracts"
);
