"use strict";
const assert = require("node:assert/strict");
const runner = require("./helpers/operator-vod-fixture.cjs");
const fixture = require("./fixtures/operator/vod-before-core.json");
for (const row of fixture.cases) {
    const expected = JSON.parse(JSON.stringify(row.expected));
    for (const event of expected.events)
        if (event[0] === "alert")
            event[1] = event[1].replace(
                /^Error (XML|JSON|M3U) !!!$/,
                "Unable to load playlist ($1)"
            );
    assert.deepEqual(
        runner.run(row.profile, row.input),
        expected,
        row.profile + " " + JSON.stringify(row.input)
    );
}
for (const profile of ["antifriz", "kb-team"])
    for (const data of ["{broken json", '<?xml version="1.0"?><broken>']) {
        const result = runner.run(
            profile,
            { data },
            (key) => "localized:" + key
        );
        assert(
            result.events.some(
                (event) =>
                    event[0] === "alert" &&
                    /^localized:Unable to load playlist \((JSON|XML)\)$/.test(
                        event[1]
                    )
            )
        );
    }
console.log(
    "PASS " +
        fixture.cases.length +
        " captured operator XML/JSON/M3U media contracts"
);
