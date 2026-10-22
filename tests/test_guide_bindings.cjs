const assert = require("node:assert/strict");
const fixture = require("./helpers/m3u-driver-fixture.cjs");
const privateRuntime = require("./helpers/private-runtime.cjs");
const playlist =
    '#EXTM3U url-tvg="https://feed.test/old.xml"\n#EXTINF:-1 tvg-id="wrong" group-title="News",One\nhttps://cdn.test/one.m3u8\n#EXTINF:-1 tvg-id="two",Two\nhttps://cdn.test/two.m3u8';
function setup() {
    const f = fixture({ native: true });
    let source = "m3u:0@fixture";
    f.host.__ottSourceIdentity = { current: () => source };
    privateRuntime(f.host, "src/guide/bindings.ts");
    f.start();
    f.host.getChannelsArray(() => {});
    f.requests[0].resolve(playlist);
    f.api = f.host.__ottGuideBindings;
    f.changeSource = (value) => (source = value);
    f.source = () => source;
    f.id = f.host.cList[0];
    f.row = f.host.channels[f.id];
    f.binding = {
        channelId: "channel:" + f.id,
        feed: "https://feed.test/chosen.xml",
        xmltvId: "exact.one",
    };
    return f;
}
const f = setup();
f.api.save(f.source(), f.row, f.id, f.binding);
assert.deepEqual(
    JSON.parse(JSON.stringify(f.api.find(f.row, f.id))),
    f.binding
);
let reads = 0;
const read = f.host.providerGetItem;
f.host.providerGetItem = (key) => {
    reads++;
    return read(key);
};
const plan = f.api.prepare();
const row = { channel_name: "One", epg: "wrong", tn: "Wrong label" };
f.api.apply(row, f.id, plan);
assert.equal(reads, 1, "prepare reads storage once, not for each channel");
assert.equal(row.epg, "exact.one");
assert.equal(row.tn, "");
assert.equal(row.epg_manual, true);
assert.deepEqual(Array.from(row.xmltv_urls), ["https://feed.test/chosen.xml"]);
f.changeSource("m3u:1@different");
assert.equal(f.api.find(f.row, f.id), null);
assert.throws(
    () => f.api.save("m3u:0@fixture", f.row, f.id, f.binding),
    /source changed/
);
f.changeSource("m3u:0@fixture");
assert.throws(
    () =>
        f.api.save(f.source(), f.row, f.id, {
            ...f.binding,
            xmltvId: "bad\nID",
        }),
    /Invalid/
);
assert.throws(
    () =>
        f.api.save(f.source(), f.row, f.id, {
            ...f.binding,
            feed: "javascript:bad",
        }),
    /Invalid/
);
assert.throws(
    () => f.api.save(f.source(), {}, f.id, f.binding),
    /source changed/
);
const write = f.host.providerSetItem;
f.host.providerSetItem = () => {};
assert.throws(
    () =>
        f.api.save(f.source(), f.row, f.id, {
            ...f.binding,
            xmltvId: "rejected",
        }),
    /rejected/
);
f.host.providerSetItem = write;
// The actual M3U driver sends exact identity + one feed and no fuzzy names to native matching.
const before = f.requests.length;
f.host.getChannelsArray(() => {});
f.requests[before].resolve(playlist);
const request = f.requests
    .slice(before + 1)
    .find((r) => r.settings.url.endsWith("/match-channels"));
const metadata = JSON.parse(request.settings.data.split("\n\t\n")[0])
    .native_channels[String(f.id)];
assert.deepEqual(JSON.parse(JSON.stringify(metadata)), {
    name: "",
    tvg_id: "exact.one",
    tvg_name: "",
    xmltv_urls: ["https://feed.test/chosen.xml"],
});
assert.equal(
    f.host.channels[f.id].channel_name,
    "One",
    "display name remains unchanged"
);
f.api.save(f.source(), f.host.channels[f.id], f.id, null);
assert.equal(f.api.find(f.host.channels[f.id], f.id), null);
// Dialog callbacks captured before a playlist switch must not save or restart it.
f.host.curList = f.host.cList;
f.host.primaryIndex = 0;
let select;
f.host.showSelectBox = (_index, _labels, callback, timeout) => {
    assert.equal(
        timeout,
        -1,
        "selection must never auto-apply while navigating"
    );
    select = callback;
};
f.host.infoBox = () => {};
f.api.open();
f.changeSource("replacement");
const reloads = f.reloads;
select(2);
assert.equal(f.reloads, reloads);
// Stored corruption must not be silently overwritten; UTF-8 bytes, not JS code units, enforce the budget.
f.changeSource("m3u:0@fixture");
const storageKey = "guideBindings:" + f.source();
f.host.providerSetItem(
    storageKey,
    JSON.stringify({ rows: [f.binding, f.binding], version: 1 })
);
assert.throws(() => f.api.find(f.row, f.id), /Invalid/);
const largeRows = Array.from({ length: 100 }, (_, i) => ({
    ...f.binding,
    channelId: "channel:" + i,
    feed: "https://feed.test/" + "界".repeat(2900),
}));
const largeText = JSON.stringify({ rows: largeRows, version: 1 });
assert(largeText.length < 524288 && Buffer.byteLength(largeText) > 524288);
f.host.providerSetItem(storageKey, largeText);
assert.throws(() => f.api.find(f.row, f.id), /Invalid/);
f.dom.window.close();
console.log(
    "Guide bindings: source isolation, exact native metadata, read-once plan, validation, rejected writes, reset and stale UI checks passed"
);
