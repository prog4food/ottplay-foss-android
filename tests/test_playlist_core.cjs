"use strict";
const assert = require("node:assert/strict");
const fixture = require("./fixtures/playlist/legacy.json");
const runner = require("./helpers/playlist-fixture.cjs");
const corrected = require("./helpers/playlist-corrected-expectations.cjs");
assert.deepEqual(
    runner.parsers(),
    fixture.parsers,
    "Every retained generic provider must stay covered"
);
for (const row of fixture.cases) {
    for (const parser of fixture.parsers)
        assert.deepEqual(
            runner.generic(parser, row.input),
            corrected.generic(row),
            parser.file + ": " + row.input
        );
    assert.deepEqual(
        runner.main(row.input),
        corrected.main(row),
        "Base M3U: " + row.input
    );
    const equivalent = corrected.equivalentInput(row.input);
    if (equivalent)
        assert.deepEqual(
            runner.main(equivalent),
            corrected.main(row),
            "Recovered M3U entry exactly matches input without blank URI lines"
        );
}
console.log(
    "PASS shared playlist core: " +
        fixture.parsers.length +
        " provider adapters, " +
        fixture.cases.length +
        " captured legacy cases each, plus base M3U"
);
const operators = require("./fixtures/playlist/operators.json");
for (const row of operators.cases) {
    for (const profile of operators.operators)
        assert.deepEqual(
            runner.operator(profile, row.input),
            row.operators[profile],
            profile + ": " + row.input
        );
    for (const profile of operators.media)
        assert.deepEqual(
            runner.media(profile, row.input),
            corrected.media(row, profile),
            "Media " + profile + ": " + row.input
        );
    const equivalent = corrected.equivalentInput(row.input);
    if (equivalent)
        for (const profile of operators.media)
            assert.deepEqual(
                runner.media(profile, equivalent),
                corrected.media(row, profile),
                "Recovered media records match input without blank URI lines: " +
                    profile
            );
}
console.log(
    "PASS operator/media playlist adapters: " +
        operators.cases.length *
            (operators.operators.length + operators.media.length) +
        " captured cases"
);

require("./test_playlist_scanner_drivers.cjs");
