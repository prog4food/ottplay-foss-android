// Actual owned M3U driver + GuideService: matching must recover a prior empty guide.
const assert = require("node:assert/strict");
const fixture = require("./helpers/m3u-driver-fixture.cjs");
const { install } = require("./helpers/guide-runtime-fixture.cjs");
const playlist =
    '#EXTM3U\n#EXTINF:-1 tvg-id="one",One\nhttps://cdn.test/one\n#EXTINF:-1 tvg-id="two",Two\nhttps://cdn.test/two\n';
for (const capacity of [0, 16]) {
    const f = fixture(),
        h = f.host;
    f.start();
    h.getChannelsArray(() => {});
    f.requests[0].resolve(playlist);
    const timers = new Map();
    let serial = 0;
    h.setTimeout = (fn, delay) => {
        const id = ++serial;
        timers.set(id, { delay, fn });
        return id;
    };
    h.clearTimeout = (id) => timers.delete(id);
    function drain() {
        for (let n = 0; n < 100; n++) {
            const next = [...timers].find(([, t]) => t.delay === 0);
            if (!next) return;
            timers.delete(next[0]);
            next[1].fn();
        }
        throw Error("queue did not converge");
    }
    install(h);
    h.epgCacheCapacity = capacity;
    h.curList = h.cList.slice();
    h.primaryIndex = 0;
    const refreshed = [];
    h.updateChannelListRow = (id) => refreshed.push(id);
    h.updateChannelInfo = (id) => h.getCurProgData(id, h.updateChannelListRow);
    for (const id of h.cList) h.getCurProgData(id, h.updateChannelListRow);
    drain();
    for (const id of h.cList)
        assert(h.channels[id].time_request > Date.now() / 1000);
    const ids = h.cList.slice(),
        match = f.requests.find((r) =>
            r.settings.url.endsWith("/match-channels")
        );
    match.resolve(
        "{}\n\t\n" +
            ids.map((id, i) => id + "~source~c" + i).join("\n") +
            "\n\t\nsource~https://epg.test/"
    );
    drain();
    let seen = 0;
    for (let i = 0; i < 10; i++) {
        const req = f.requests.find(
            (r) => /\/c\d\.json/.test(r.settings.url) && !r.guideResolved
        );
        if (!req) break;
        req.guideResolved = true;
        seen++;
        req.resolve({
            epg_data: [
                {
                    name: "Programme",
                    time: Date.now() / 1000 - 60,
                    time_to: Date.now() / 1000 + 600,
                },
            ],
        });
        drain();
    }
    assert.equal(seen, 2);
    for (const id of ids) {
        assert.equal(h.channels[id].name, "Programme");
        assert.equal(h.channels[id].time_request, 0);
        assert(refreshed.includes(id));
    }
    h.__ottClassicGuide.invalidate(false);
    f.dom.window.close();
    console.log(
        "PASS actual M3U matching recovers missing guide, capacity " + capacity
    );
}
