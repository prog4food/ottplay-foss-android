/** Real guide owner + classic codec integration; transport is controlled. */
import assert from "node:assert/strict";
import fixture from "./helpers/guide-runtime-fixture.cjs";
import "./test_guide_integration.cjs";

const { host } = fixture();
for (const epoch of [1733155200, 1733126400, 1e12, 0, -1]) {
    const date = new Date(epoch * 1000);
    const expected =
        String(date.getHours()).padStart(2, "0") +
        ":" +
        String(date.getMinutes()).padStart(2, "0");
    assert.equal(host.formatEpgTime(epoch), expected);
}
assert.equal(host.formatEpgTime(1733155200000), host.formatEpgTime(1733155200));
assert.equal(host.formatEpgTime(Number.NaN), "--:--");
assert.equal(host.formatEpgTime(Infinity), "--:--");
assert.equal(host.renderEpgHTML(null), "");
assert.equal(host.renderEpgHTML([]), "");
const html = host.renderEpgHTML([
    { descr: "Wake up", name: "Morning Show", time: 10000, time_to: 11000 },
]);
for (const text of [
    "Morning Show",
    "Wake up",
    "epg-entry",
    "epg-time",
    host.formatEpgTime(10000),
])
    assert(html.includes(text));
assert(
    !host
        .renderEpgHTML([
            { descr: "", name: "Movie", time: 10000, time_to: 11000 },
        ])
        .includes("epg-descr")
);
console.log(
    "PASS EPG renderer/time zone contracts and owned lifecycle integration"
);
