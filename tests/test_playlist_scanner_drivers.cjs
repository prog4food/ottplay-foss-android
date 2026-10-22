"use strict";

const assert = require("node:assert/strict");
const fixture = require("./helpers/m3u-driver-fixture.cjs");
const captured = require("./fixtures/playlist/legacy.json");
const operators = require("./fixtures/playlist/operators.json");
const corrected = require("./helpers/playlist-corrected-expectations.cjs");
const clone = (value) => JSON.parse(JSON.stringify(value));

function catalog(input, native = false) {
    const f = fixture({ native });
    try {
        const driver = f.start();
        let callbacks = 0;
        f.host.getChannelsArray(() => callbacks++);
        f.requests[0].resolve(input);
        return clone({
            callbacks,
            channels: f.host.channels,
            groupOrder: f.host.catsArray,
            groups: f.host.cats,
            ids: f.host.cList,
            journalKey: driver.storageKey("playbackJournal"),
            matching: f.requests
                .filter((request) =>
                    /\/match-(channels|logos)$/.test(request.settings.url)
                )
                .map((request) => ({
                    body: request.settings.data,
                    url: request.settings.url,
                })),
            stream: f.host.cList.map((id) => driver.stream(id)),
        });
    } finally {
        f.dom.window.close();
    }
}

// The second input is semantically identical but previously the base scanner
// lost its URI. Compare the whole real driver's publication and wire requests.
for (const native of [false, true]) {
    const row = captured.cases[6];
    const actual = catalog(row.input, native);
    assert.deepEqual(
        actual,
        catalog(corrected.equivalentInput(row.input), native)
    );
    assert.equal(actual.callbacks, 1);
    assert.deepEqual(actual.ids, [2108869960]);
    assert.equal(actual.channels[2108869960].channel_name, "É🎬");
    assert.equal(actual.channels[2108869960].rec, 48);
    assert.deepEqual(actual.stream, ["https://v.test/A"]);
    assert.equal(actual.journalKey, "m3uplaybackJournal");
}
console.log(
    "PASS playlist scanner driver: blank URI recovery preserves web/native identity and protocol"
);

{
    const row = captured.cases[5];
    const actual = catalog(row.input);
    assert.equal(actual.channels[3147444714].channel_name, "Name, comma");
    assert.equal(actual.channels[3147444714].tn, "International, news");
    assert.deepEqual(actual.ids, row.main.ids);
    assert.equal(actual.matching.length, 2);
    for (const request of actual.matching) {
        const body = request.body.split("\n\t\n")[2];
        assert.equal(
            body,
            request.url.endsWith("/match-channels")
                ? row.main.epgBody
                : row.main.logoBody,
            "Correct display names must not change historical EPG/logo lookup tokens"
        );
    }
    assert.deepEqual(
        actual,
        catalog(
            row.input.replace(
                "\nhttps://v.test/a",
                "\n#comment\n\nhttps://v.test/a"
            )
        )
    );
}
console.log(
    "PASS playlist scanner driver: quoted display labels keep complete companion payloads"
);

for (const index of [5, 6, 14, 15, 17, 18, 20, 21]) {
    const row = operators.cases[index];
    const f = fixture({
        config: {
            active: 0,
            M3Us: [
                { medUrl: "https://vod.test/root", www: "https://tv.test/" },
            ],
        },
        dune: true,
    });
    try {
        f.start();
        let callbacks = 0;
        f.host.getMediaArray("", () => callbacks++);
        assert.equal(f.requests.length, 1);
        f.requests[0].resolve(row.input);
        assert.equal(callbacks, 1);
        assert.deepEqual(
            clone(f.host.mediaRecords),
            corrected.media(row, "m3u", true).records,
            "Actual Dune media path: " + index
        );
    } finally {
        f.dom.window.close();
    }
}
console.log(
    "PASS playlist scanner driver: eight real Dune loads retain full titles and recovered records"
);
