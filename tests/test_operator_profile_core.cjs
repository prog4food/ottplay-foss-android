"use strict";
const assert = require("node:assert/strict");
const runner = require("./helpers/operator-profile-fixture.cjs");
const fixture = require("./fixtures/operator/profiles-before-core.json");
for (const row of fixture.cases)
    assert.deepEqual(
        runner.run(row.profile, row.input),
        row.expected,
        row.profile + " " + JSON.stringify(row.input)
    );
console.log(
    "PASS " +
        fixture.cases.length +
        " captured named operator credential/request contracts"
);
