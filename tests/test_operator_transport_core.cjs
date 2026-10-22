"use strict";
const assert = require("node:assert/strict");
const runner = require("./helpers/operator-transport-fixture.cjs");
const fixture = require("./fixtures/operator/transport-before-core.json");
for (const row of fixture.cases)
    for (const profile of fixture.profiles)
        assert.deepEqual(
            runner.run(profile, row.input),
            row.expected[profile],
            profile + " " + JSON.stringify(row.input)
        );
console.log(
    "PASS " +
        fixture.cases.length * fixture.profiles.length +
        " captured operator HTTP/intercept/proxy contracts"
);
