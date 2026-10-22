"use strict";
const assert = require("node:assert/strict");
const runner = require("./helpers/operator-portal-fixture.cjs");
const fixture = require("./fixtures/operator/portal-before-core.json");
for (const row of fixture.cases)
    assert.deepEqual(
        runner.run(JSON.parse(JSON.stringify(row.input))),
        row.expected,
        JSON.stringify(row.input)
    );
console.log(
    "PASS " +
        fixture.cases.length +
        " captured Edem VPortal navigation/catalog/page/media contracts"
);
