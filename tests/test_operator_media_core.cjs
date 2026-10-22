"use strict";
const assert = require("node:assert/strict");
const runner = require("./helpers/operator-media-fixture.cjs");
const fixture = require("./fixtures/operator/media-before-core.json");
for (const row of fixture.cases)
    assert.deepEqual(
        runner.run(row.profile, row.input),
        row.expected,
        row.profile + " " + JSON.stringify(row.input)
    );
console.log(
    "PASS " +
        fixture.cases.length +
        " captured operator live stream/JSON guide contracts"
);
