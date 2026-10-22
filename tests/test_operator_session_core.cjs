"use strict";
const assert = require("node:assert/strict");
const runner = require("./helpers/operator-session-fixture.cjs");
const fixture = require("./fixtures/operator/sessions-before-core.json");
assert.deepEqual(
    runner.providers,
    fixture.providers,
    "Every active generic operator remains registered"
);
let count = 0;
for (const row of fixture.cases) {
    for (const outcome of row.outcomes) {
        for (const file of outcome.providers) {
            const provider = runner.providers.find(
                (item) => item.file === file
            );
            assert.deepEqual(
                runner.run(provider, row.input),
                outcome.expected,
                file + ": " + row.name
            );
            count++;
        }
    }
}
assert.equal(count, fixture.providers.length * fixture.cases.length);
console.log(
    "PASS " + count + " captured generic operator session/catalog contracts"
);
