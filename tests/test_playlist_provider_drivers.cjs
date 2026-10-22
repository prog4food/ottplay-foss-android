"use strict";
const assert = require("node:assert/strict"),
    vm = require("node:vm");
const fixture = require("./helpers/playlist-provider-fixture.cjs");
const { integrationFixture } = require("./helpers/provider-driver-fixture.cjs");
const clone = (value) => JSON.parse(JSON.stringify(value));
const kbPlaylist =
    '#EXTM3U\n#EXTINF:-1 tvg-id="e" tvg-name="Guide One" group-title="News" catchup-days="2",One\nhttps://stream.test/token/one/index.m3u8\n';
const afPlaylist =
    '#EXTM3U\n#EXTINF:-1 tvg-id="e" tvg-rec="2" group-title="News",One\nhttp://cdn.test/live/token/42.m3u8\n';
let groups = 0;
function test(name, action) {
    action();
    groups++;
    console.log("PASS playlist drivers: " + name);
}
function load(f, text) {
    let completed = 0;
    f.host.getChannelsArray(() => completed++);
    f.requests.at(-1).resolve(text);
    return completed;
}
function view(f, callbacks) {
    return clone({
        callbacks,
        channels: f.host.channels,
        errors: f.errors,
        groupOrder: f.host.catsArray,
        groups: f.host.cats,
        ids: f.host.cList,
    });
}
function routes(f) {
    return clone(
        f.requests.map(({ settings: r }) => ({
            data: r.data || null,
            dataType: r.dataType,
            method: r.method || r.type || "GET",
            timeout: r.timeout,
            url: r.url,
        }))
    );
}

test("46 captured antifriz/KB playlist catalogs and enrichment payloads", () => {
    let count = 0;
    for (const row of require("./fixtures/playlist/operators.json").cases)
        for (const id of ["antifriz", "kb-team"]) {
            const f = fixture(id),
                completed = load(f, row.input),
                expected = clone(row.operators[id]);
            if (id === "kb-team") {
                const epg = f.requests.find((r) =>
                    r.settings.url.endsWith("gelist.php")
                );
                const logo = f.requests.find((r) =>
                    r.settings.url.endsWith("geicons.php")
                );
                assert.deepEqual(
                    epg ? JSON.parse(epg.settings.data.list) : {},
                    expected.epgBody
                );
                if (expected.logoBody)
                    assert.deepEqual(
                        JSON.parse(logo.settings.data.list),
                        expected.logoBody
                    );
                delete expected.epgBody;
                delete expected.logoBody;
            }
            assert.deepEqual(view(f, completed), expected, id + row.input);
            count++;
        }
    assert.equal(count, 46);
});

test("playlist retry/interception routes and credential rejection preserve protocols", () => {
    for (const id of ["antifriz", "kb-team"]) {
        for (const fail of [false, true]) {
            const f = fixture(id);
            let completed = 0;
            f.host.getChannelsArray(() => completed++);
            const first = f.requests[0];
            first.reject();
            assert.equal(
                f.requests[1].settings.url,
                "https://relay.test/m3u/cp.php"
            );
            if (fail) f.requests[1].reject();
            else f.requests[1].resolve("#EXTM3U\n");
            assert.equal(completed, 1);
            assert.equal(f.errors.length, fail ? 1 : 0);
            first.resolve(kbPlaylist);
            assert.equal(completed, 1);
        }
        const f = fixture(id, { intercept: true });
        f.driver.load(() => {});
        assert(f.events.some((e) => e[0] === "intercept"));
    }
    const a = fixture("antifriz", { saved: { azkey: "short" } }),
        b = fixture("kb-team", { mac: "" });
    for (const f of [a, b]) {
        let completed = 0;
        f.host.getChannelsArray(() => completed++);
        assert.equal(completed, 1);
        assert.equal(f.requests.length, 0);
        assert.equal(f.errors.length, 1);
    }
});

test("KB late metadata emits updates while startup completes once and private rows stay owned", () => {
    const f = fixture("kb-team"),
        updates = [];
    f.driver.updates((snapshot, kind) => updates.push({ kind, snapshot }));
    assert.equal(load(f, kbPlaylist), 1);
    const id = f.host.cList[0];
    f.host.curList = [id];
    f.host.primaryIndex = 0;
    f.requests[1].resolve({ [id]: "guide/path" });
    f.requests[2].resolve({ [id]: "https://logo.test/one.png" });
    assert.deepEqual(
        updates.map((x) => x.kind),
        ["guide", "logo"]
    );
    assert.equal(f.host.channels[id].epg_url, "guide/path");
    assert.equal(f.driver.logo(id), "https://logo.test/one.png");
    updates[1].snapshot.channels[id].url = "poison";
    f.host.channels[id].url = "poison";
    assert.equal(
        f.driver.stream(id),
        "https://stream.test/token/one/index.m3u8"
    );
    f.driver.guide(id, () => {});
    assert.equal(
        f.requests.at(-1).settings.url,
        "https://epg.drm-play.com/guide%2Fpath.json"
    );
    assert.equal(f.events.filter((e) => e[0] === "refresh").length, 2);
});

test("catalog, enrichment, guide, user-info and media reject retired responses", () => {
    for (const id of ["antifriz", "kb-team"])
        for (const action of ["reload", "save", "replace", "dispose"]) {
            const f = fixture(id);
            load(f, id === "kb-team" ? kbPlaylist : afPlaylist);
            const channel = f.host.cList[0];
            let late = 0;
            if (id === "kb-team") {
                f.requests[1].resolve({ [channel]: "guide" });
                f.driver.subscription(() => late++);
            }
            f.driver.guide(channel, () => late++);
            f.driver.media("https://vod.test/old", "Old", () => late++);
            const pending = f.requests
                .slice()
                .filter(
                    (r) =>
                        r !== f.requests[0] &&
                        !(id === "kb-team" && r === f.requests[1])
                );
            if (action === "reload") f.driver.load(() => {});
            if (action === "save")
                f.driver.saveCredentials({
                    ...f.driver.credentials(),
                    playlist: "1",
                    username: "87654321",
                });
            if (action === "replace") f.mount("demo");
            if (action === "dispose") f.driver.dispose();
            // Catalog reload retires catalog/guide metadata; media/panel are separate views until explicitly cancelled.
            if (action === "reload") {
                f.driver.cancelMedia();
                if (id === "kb-team") f.driver.subscription(() => {});
            }
            for (const request of pending) {
                request.resolve({});
                request.reject();
            }
            assert.equal(late, 0, id + action);
        }
});

test("antifriz guide/current and Tizen modes use owned catalog metadata", () => {
    const f = fixture("antifriz", { agent: "Tizen" });
    load(f, afPlaylist);
    const id = f.host.cList[0];
    assert(id !== undefined);
    assert(f.driver.stream(id).includes("video.m3u8"));
    let guide;
    f.host.sNextCount = 2;
    f.driver.guideCurrent(id, (value) => (guide = value));
    assert.equal(
        f.requests.at(-1).settings.url,
        "http://protected-api.com/epg/current/e?num=3"
    );
    assert.equal(f.requests.at(-1).settings.cache, false);
    f.requests.at(-1).resolve([{ descr: "D", name: "P", time: 1, time_to: 2 }]);
    assert.deepEqual(clone(guide), [
        { descr: "D", name: "P", time: 1, time_to: 2 },
    ]);
    f.driver.guide(id, (value) => (guide = value));
    assert.equal(
        f.requests.at(-1).settings.url,
        "http://protected-api.com/epg/e?date="
    );
    f.requests.at(-1).resolve([null]);
    assert.deepEqual(clone(guide), []);
    f.driver.saveCredentials({ ...f.driver.credentials(), mode: 1 });
    assert(f.driver.stream(id).includes("/mpegts?"));
});

test("KB slot selection changes namespaced storage only at Load and keeps persisted MAC fallback", () => {
    const f = fixture("kb-team"),
        w = f.host;
    w.popupActions = [() => {}];
    w.popupArray = [""];
    w.popupDetail = [""];
    w.duneAddSettings(0);
    assert.equal(w.p_pref, "kbc0");
    w.providerSetItem("primaryIndex", "10");
    assert.equal(f.saved.get("kbc0primaryIndex"), "10");
    w.popupActions[0]();
    assert.equal(w.p_pref, "kbc0");
    assert.equal(f.saved.get("kbcv_list"), "0");
    w.popupActions[1]();
    assert.equal(w.p_pref, "kbc1");
    assert.equal(f.saved.get("kbcv_list"), "1");
    assert.equal(f.saved.get("kbc1v_list"), "1");
    w.providerSetItem("primaryIndex", "20");
    assert.equal(f.saved.get("kbc1primaryIndex"), "20");
    assert.equal(f.saved.get("kbc0primaryIndex"), "10");
    const g = fixture("kb-team", { slot: 9 });
    assert.equal(
        g.driver.configuration().slot,
        0,
        "corrupt slot safely chooses first playlist"
    );
});

test("settings and user-info callbacks are scoped, escaped and closeable", () => {
    const f = fixture("antifriz"),
        w = f.host;
    w.duneAddSettings(0);
    w.popupActions[0]();
    w.editvar = "short";
    w.setEdit();
    assert.equal(f.saved.get("azkey"), "12345678");
    w.editvar = "87654321";
    w.setEdit();
    assert.equal(f.saved.get("azkey"), "87654321");
    assert(f.events.some((e) => e[0] === "restart"));
    const k = fixture("kb-team"),
        h = k.host;
    h.duneAddSettings(0);
    h.popupActions[2]();
    const old = k.requests.at(-1);
    h.aboutKeyHandler();
    old.resolve({
        channels: [{ title: "obsolete" }],
        title: "KinoBoom User Info",
    });
    assert(!k.panels["#listAbout"].visible);
    h.popupActions[2]();
    k.requests.at(-1).resolve({
        channels: [
            { title: "<img src=x onerror=evil()>" },
            { title: "Speedtest" },
        ],
        title: "KinoBoom User Info",
    });
    assert(k.panels["#listAbout"].html.includes("&lt;img"));
    assert(!k.panels["#listAbout"].html.includes("Speedtest"));
});

test("Antifriz settings localize access-key validation and stream choices", () => {
    const f = fixture("antifriz"),
        w = f.host;
    w._ = (key, ...args) =>
        "localized:" +
        key.replace(/%(\d+)/g, (_match, index) => args[Number(index) - 1]);
    w.duneAddSettings(0);
    assert.equal(w.popupArray[0], "localized:Access key");
    assert.equal(w.popupArray[1], "localized:Stream type: HLS");
    assert.equal(
        w.popupDetail[0],
        "localized:Enter an application access key (8 characters)."
    );
    assert.equal(
        w.popupDetail[1],
        "localized:Select a stream type:<br>HLS, MPEGTS"
    );
    w.popupActions[0]();
    assert.equal(
        w.editCaption,
        "localized:Enter an application access key (8 characters)."
    );
    w.editvar = "short";
    w.setEdit();
    assert.equal(
        f.errors.at(-1),
        "localized:Enter an application access key (8 characters)."
    );
    assert.equal(f.saved.get("azkey"), "12345678");
    w.popupActions[1]();
    assert.equal(w.popupArray[1], "localized:Stream type: MPEGTS");
});

test("owned media navigation supports JSON/XML/M3U and blocks stale/cancelled views", () => {
    for (const id of ["antifriz", "kb-team"]) {
        const f = fixture(id),
            w = f.host;
        let completed = 0;
        const callback = () => completed++;
        callback.isCurrent = () => true;
        w.getMediaArray("https://vod.test/a", callback);
        const stale = f.requests.at(-1);
        w.getMediaArray("https://vod.test/b", callback);
        assert.equal(stale.aborts, 1);
        stale.resolve('{"title":"old","channel":{}}');
        assert.equal(completed, 0);
        f.requests
            .at(-1)
            .resolve(
                '{"title":"Films","channel":{"title":"One","stream_url":"https://v.test/1"},"next_page_url":"next"}'
            );
        assert.equal(completed, 1);
        assert.equal(w.mediaName, "Films");
        assert.equal(w.mediaRecords.length, 2);
        w.getMediaArray("https://vod.test/xml", callback);
        f.requests
            .at(-1)
            .resolve(
                '<?xml version="1.0"?><items><title>XML</title><channel><title>Two</title></channel></items>'
            );
        assert.equal(w.mediaName, "XML");
        w.getMediaArray("https://vod.test/m3u", callback);
        f.requests
            .at(-1)
            .resolve(
                '#EXTM3U\n#EXTINF:-1 tvg-logo="https://img.test/one",<script>evil</script>\nhttps://video.test/a\n'
            );
        assert(w.mediaRecords[0].description.includes("&lt;script&gt;"));
        w.getMediaArray("https://vod.test/cancel", callback);
        const pending = f.requests.at(-1);
        w.providerMediaClient.cancel();
        pending.resolve("{}");
        assert.equal(completed, 3);
    }
});

test("media parsing errors and generated titles use the selected language", () => {
    for (const id of ["antifriz", "kb-team"]) {
        const f = fixture(id),
            w = f.host;
        w._ = (key) => "localized:" + key;
        for (const data of ["{broken json", '<?xml version="1.0"?><broken>']) {
            w.getMediaArray("https://vod.test/broken", () => {});
            f.requests.at(-1).resolve(data);
            assert.match(
                f.errors.at(-1),
                /^localized:Unable to load playlist \((JSON|XML)\)$/
            );
        }
        w.getMediaArray("https://vod.test/unnamed", () => {});
        f.requests
            .at(-1)
            .resolve(
                '#EXTM3U\n#EXTINF:-1 tvg-name="one"\nhttps://video.test/unnamed\n'
            );
        assert.equal(
            w.mediaRecords[0].title,
            "localized:" +
                (id === "kb-team" ? "??? No channel name" : "Untitled")
        );
        assert(w.mediaRecords[0].description.includes(w.mediaRecords[0].title));
        assert.equal(
            w.mediaRecords[0].__ottMediaLabel.value,
            w.mediaRecords[0].title
        );
        assert.equal(w.mediaRecords[0].__ottMediaLabel.heading, true);
    }
});

test("media busy views retire on cancel/keys/source disposal without closing a newer dialog", () => {
    for (const id of ["antifriz", "kb-team"])
        for (const action of [
            "cancel",
            "return",
            "stop",
            "source",
            "foreign",
            "reentry",
        ]) {
            const f = fixture(id),
                w = f.host;
            let completed = 0;
            const priorHandler = () => false;
            w.dialogBoxKeyHandler = priorHandler;
            w.getMediaArray("https://vod.test/old", () => completed++);
            const request = f.requests.at(-1),
                oldHandler = w.dialogBoxKeyHandler;
            assert.equal(f.panels["#dialogbox"].visible, true);
            if (action === "foreign") {
                w.dialogBoxKeyHandler = () => true;
                w.$("#dialogbox").html("New dialog").show();
                w.providerMediaClient.cancel();
            } else if (action === "reentry") {
                const abort = request.abort;
                request.abort = function () {
                    abort.call(request);
                    w.getMediaArray(
                        "https://vod.test/newer",
                        () => completed++
                    );
                };
                w.getMediaArray(
                    "https://vod.test/superseded",
                    () => completed++
                );
                assert(f.requests.at(-1).settings.url.includes("/newer"));
            } else if (action === "source") f.mount("demo");
            else if (action === "return" || action === "stop")
                assert.equal(
                    oldHandler(w.keys[action === "return" ? "RETURN" : "STOP"]),
                    true
                );
            else w.providerMediaClient.cancel();
            assert.equal(request.aborts, 1, id + action);
            request.resolve('{"title":"Stale","channel":{}}');
            request.reject();
            assert.equal(completed, 0, id + action);
            assert.equal(oldHandler(w.keys.RETURN), false);
            if (action === "foreign") {
                assert.equal(f.panels["#dialogbox"].visible, true);
                assert.equal(f.panels["#dialogbox"].html, "New dialog");
            } else if (action === "reentry") {
                assert.equal(f.panels["#dialogbox"].visible, true);
                f.requests.at(-1).resolve('{"title":"New","channel":{}}');
                assert.equal(completed, 1);
                assert.equal(f.panels["#dialogbox"].visible, false);
            } else {
                assert.equal(
                    f.panels["#dialogbox"].visible,
                    false,
                    id + action
                );
                assert.equal(w.dialogBoxKeyHandler, priorHandler);
            }
        }
});

test("94 captured archive routes preserve modes, fallback resources, clocks and Dune behavior", () => {
    let count = 0;
    for (const row of require("./fixtures/archive/providers.json").fixtures.filter(
        (row) => ["antifriz", "kb-team"].includes(row.provider)
    )) {
        const f = fixture(row.provider, {
            dune: row.dune,
            saved: { azmpeg: String(row.variant) },
        });
        vm.runInContext(
            "Date.now=function(){return " + row.now * 1000 + ";};",
            f.host
        );
        // Capture begins at a decoded channel record; parser contracts are covered separately.
        f.host.OttPlayCore.parseOperatorPlaylist = () => ({
            channels: {
                42: clone({
                    ...row.channel,
                    server: row.channel.server || "cdn.test",
                }),
            },
            entries: [],
            groupOrder: [],
            groups: {},
            ids: [42],
            malformed: false,
        });
        load(f, "#EXTM3U\n");
        assert.equal(
            f.driver.archive(42, row.start, row.end),
            row.expected,
            row.provider + JSON.stringify(row)
        );
        count++;
    }
    assert.equal(count, 94);
});

test("34 captured operator media decoder contracts keep records and URL parameters", () => {
    let count = 0;
    for (const row of require("./fixtures/operator/vod-before-core.json")
        .cases) {
        const f = fixture(row.profile),
            loader = f.media(),
            input = row.input;
        let completed = 0,
            name = "Previous catalog",
            records = [{ title: "Previous" }];
        loader.load(
            {
                mac: input.mac === undefined ? "00:11:22:33:44:55" : input.mac,
                name,
                profile: row.profile,
                url:
                    input.url === undefined
                        ? "https://vod.test/catalog"
                        : input.url,
            },
            (result) => {
                completed++;
                if (result.records) {
                    name = result.name;
                    records = result.records;
                }
            }
        );
        if (input.stale) loader.cancel();
        if (f.requests[0]) {
            if (input.failed) f.requests[0].reject();
            else f.requests[0].resolve(input.data);
        }
        assert.deepEqual(
            clone({
                callbacks: completed,
                calls: f.requests.map(({ settings: r }) => ({
                    dataType: r.dataType,
                    timeout: r.timeout,
                    url: r.url,
                })),
                mediaName: name,
                mediaRecords: records,
            }),
            {
                callbacks: row.expected.callbacks,
                calls: row.expected.calls,
                mediaName: row.expected.mediaName,
                mediaRecords: row.expected.mediaRecords,
            },
            row.profile + JSON.stringify(input)
        );
        count++;
    }
    assert.equal(count, 34);
});

test("media callbacks settle once including consumer exceptions and injected decode reentry", () => {
    const f = fixture("kb-team"),
        loader = f.media();
    let count = 0;
    loader.load({ profile: "m3u", url: "https://vod.test/short" }, () => {
        count++;
        throw Error("consumer");
    });
    assert.throws(() => f.requests[0].resolve("bad"), /consumer/);
    assert.equal(count, 1);
    f.requests[0].reject();
    assert.equal(count, 1);
    const original = f.host.__ottCatalogXml.decode;
    f.host.__ottCatalogXml.decode = () => {
        loader.load(
            { profile: "m3u", url: "https://vod.test/new" },
            () => count++
        );
        return { channels: [{ title: "old" }] };
    };
    loader.load({ profile: "m3u", url: "https://vod.test/old" }, () => {
        throw Error("obsolete XML published");
    });
    f.requests[1].resolve("<items></items>");
    f.requests[2].resolve('{"channels":[{"title":"New"}]}');
    assert.equal(count, 2);
    f.host.__ottCatalogXml.decode = original;
    loader.load(
        { profile: "m3u", url: "https://vod.test/special" },
        (result) => {
            assert(
                Object.prototype.hasOwnProperty.call(
                    result.records[0],
                    "__proto__"
                )
            );
            assert.equal(result.records[0].polluted, undefined);
        }
    );
    f.requests[3].resolve(
        '{"channels":[{"__proto__":{"polluted":true},"nested":{"title":"Safe"}}]}'
    );
});

test("startup and settings teardown reentry cannot publish obsolete metadata or effects", () => {
    const f = fixture("kb-team");
    let old = 0,
        fresh = 0;
    f.driver.load(() => {
        old++;
        f.driver.load(() => fresh++);
    });
    f.requests[0].resolve(kbPlaylist);
    assert.equal(
        f.requests.length,
        2,
        "superseded callback must not start old metadata requests"
    );
    f.requests[1].resolve("#EXTM3U\n");
    assert.deepEqual([old, fresh], [1, 1]);
    const g = fixture("kb-team"),
        w = g.host;
    load(g, kbPlaylist);
    w.duneAddSettings(0);
    w.popupActions[0]();
    const pending = g.requests[1],
        abort = pending.abort.bind(pending);
    pending.abort = () => {
        abort();
        g.mount("demo");
    };
    w.popupActions[1]();
    assert.equal(w.p_pref, "demo");
    assert.equal(g.saved.get("kbcv_list"), "0");
    assert.equal(g.saved.get("kbc1v_list"), undefined);
    const h = fixture("kb-team");
    load(h, kbPlaylist);
    h.host.duneAddSettings(0);
    h.host.popupActions[2]();
    const close = h.host.aboutKeyHandler;
    h.mount("demo");
    const before = h.events.length;
    close();
    assert.equal(
        h.events.length,
        before,
        "retired About handler cannot restore or hide another screen"
    );
});

test("actual host startup mounts playlist instances with no scripts or ajax mutation", () => {
    for (const id of ["antifriz", "kb-team"]) {
        const f = integrationFixture(id, { azkey: "12345678", kbcv_list: "2" });
        f.host.stb = { getMacAddress: () => "AA:BB:CC:DD:EE:FF" };
        f.host.navigator = { userAgent: "browser" };
        f.host.infoBox = () => {};
        f.host.updateChannelInfo = () => {};
        f.host.loadProv();
        assert.equal(f.host.__ottActiveProviderDriver.id, id);
        f.requests[0].resolve(id === "antifriz" ? afPlaylist : kbPlaylist);
        assert.equal(f.completed, 1);
        assert.equal(f.ajaxWrites, 0);
        assert.deepEqual(f.scripts, []);
        assert.equal(typeof f.host.getMediaArray, "function");
        if (id === "kb-team") {
            assert.equal(f.host.p_pref, "kbc2");
            assert(f.requests[0].settings.url.includes("bid=iptvk"));
            assert(f.requests[0].settings.url.includes("aabbccddeeff"));
            const pending = f.requests[1];
            f.host.loadProv("demo");
            pending.resolve({});
            assert.equal(f.completed, 2);
        }
    }
});

console.log("PASS " + groups + " owned playlist driver scenario groups");
