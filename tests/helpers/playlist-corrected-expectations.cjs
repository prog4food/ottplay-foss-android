"use strict";

const assert = require("node:assert/strict");
const clone = (value) => JSON.parse(JSON.stringify(value));

// These are deliberate scanner corrections, not a newly captured production
// oracle. Everything outside the listed display fields/recovered records is
// compared with the immutable pre-core fixtures, including companion bodies.
const quotedInput =
    '#EXTM3U\n#EXTINF:-1 group-title="News, world" tvg-name="International, news",Name, comma\nhttps://v.test/a';
const blankInput =
    '#EXTM3U\r\n#EXTINF:-1 TVG-LOGO="https://l.test/a" GROUP-TITLE="Caps",É🎬\r\n#comment\r\n\r\nhttps://v.test/A\r\n';
const fullTitleBody =
    '#EXTINF:-1 group-title="A" tvg-id="epg" tvg-name="one" tvg-rec="4" timeshift="2" drm="clear" tvg-logo="https://i/logo",First, comma\nhttp://v.test/token/one/file.ts?q=1\n#EXTINF:-1 group-title="B" tvg-name="two",Second\nhttp://v.test/token/two/file.ts\n#EXTINF:-1 group-title="C",Duplicate\nhttp://v.test/token/one/file.ts?q=1';
const secondBlankBody =
    '#EXTINF:-1 group-title="A",\n#EXTGRP:Other\nhttp://v.test/token/one/a.ts\n#EXTINF:-1 tvg-name="two",\n#comment\n\nhttp://v.test/token/two/a.ts';
const headers = [
    "#EXTM3U ",
    '#EXTM3U catchup-days="2" catchup="append" catchup-source="?s={utc}" url-tvg="guide"',
    '#EXTM3U timeshift="bad"',
];
const fullTitleInputs = headers.map((header) => header + "\n" + fullTitleBody);
const secondBlankInputs = headers.map(
    (header) => header + "\n" + secondBlankBody
);

function change(value, key, before, after) {
    assert.equal(
        value[key],
        before,
        "Historical correction precondition: " + key
    );
    value[key] = after;
}

function generic(row) {
    const expected = clone(row.generic);
    if (row.input === quotedInput) {
        const channel = expected.channels[4291983546];
        for (const key of ["channel_name", "tn"])
            change(
                channel,
                key,
                'world" tvg-name="International, news",Name, comma',
                "Name, comma"
            );
    }
    return expected;
}

function main(row) {
    const expected = clone(row.main);
    if (row.input === quotedInput)
        change(
            expected.channels[3147444714],
            "channel_name",
            'world" tvg-name="International, news",Name, comma',
            "Name, comma"
        );
    if (row.input === blankInput) {
        assert.deepEqual(expected.ids, []);
        assert.deepEqual(expected.channels, {});
        assert.equal(expected.epgBody, "");
        assert.equal(expected.logoBody, "");
        expected.ids.push(2108869960);
        expected.channels[2108869960] = {
            ca: "",
            caso: "",
            category: { class: 1, name: "" },
            channel_name: "É🎬",
            epg: "",
            logo: "",
            rec: 48,
            time: 0,
            time_to: 0,
            tn: "",
            url: "https://v.test/A",
        };
        expected.epgBody = "2108869960-0-0-1976646085~%C3%89%F0%9F%8E%AC\n";
        expected.logoBody = expected.epgBody;
    }
    return expected;
}

function title(record, before, after) {
    change(record, "title", before, after);
    const oldHeading = "<center>" + before + "</center>";
    assert(record.description.includes(oldHeading));
    record.description = record.description.replace(
        oldHeading,
        "<center>" + after + "</center>"
    );
}

function media(row, profile, localizedTitles = profile === "antifriz") {
    const expected = clone(row.media[profile]);
    if (row.input === quotedInput)
        title(
            expected.records[0],
            'world" tvg-name="International',
            "Name, comma"
        );
    if (fullTitleInputs.includes(row.input))
        title(expected.records[0], "First", "First, comma");
    if (row.input === blankInput) {
        assert.equal(expected.records.length, 0);
        expected.records.push({
            description: "<table><h2><center>É🎬</center></h2></table>",
            logo_30x30: "",
            stream_url: "https://v.test/A",
            title: "É🎬",
        });
    }
    if (secondBlankInputs.includes(row.input)) {
        assert.equal(expected.records.length, 1);
        expected.records.push({
            description: "<table><h2><center></center></h2></table>",
            logo_30x30: "",
            stream_url: "http://v.test/token/two/a.ts",
            title: "",
        });
    }
    // Generated names are application UI; historical fixtures retain the old Russian fallback.
    for (const record of expected.records) {
        const generated =
            record.title === "??? Нет названия" ||
            (profile === "kb-team" && record.title === "??? No channel name");
        if (localizedTitles && record.title === "??? Нет названия")
            title(record, "??? Нет названия", "Untitled");
        if (generated && (profile !== "m3u" || localizedTitles))
            record.__ottMediaLabel = {
                heading: true,
                key: profile === "kb-team" ? "??? No channel name" : "Untitled",
                value: record.title,
            };
    }
    return expected;
}

function equivalentInput(input) {
    if (input === blankInput) return input.replace("\r\n\r\n", "\r\n");
    if (secondBlankInputs.includes(input)) return input.replace("\n\n", "\n");
    return null;
}

module.exports = { equivalentInput, generic, main, media };
