"use strict";
const assert = require("node:assert/strict");
const runner = require("./helpers/operator-catalog-fixture.cjs");
const fixture = require("./fixtures/operator/catalogs-before-core.json");
for (const row of fixture.cases)
    assert.deepEqual(
        runner.run(row.provider, row.input),
        row.expected,
        row.provider + ": " + row.name
    );
console.log(
    "PASS " +
        fixture.cases.length +
        " captured proprietary operator catalog contracts"
);
