"use strict";
const assert = require("node:assert/strict");
const { edemFixture } = require("./helpers/edem-driver-fixture.cjs");
const clone = (value) => JSON.parse(JSON.stringify(value));
function withoutSource(value) {
    return JSON.parse(
        JSON.stringify(value, (key, item) =>
            key === "vportalSource" ? undefined : item
        )
    );
}
const portalCases =
    require("./fixtures/operator/portal-before-core.json").cases;
const playlist =
    '#EXTM3U\n#EXTINF:-1 tvg-id="epg42" tvg-logo="https://logo.test/42.png" group-title="News",One\nhttps://localhost/00000000000000/live/42/index.m3u8';
let passed = 0;
function test(name, run) {
    run();
    passed++;
    console.log("PASS Edem driver: " + name);
}
function setup(settings) {
    const f = edemFixture(settings);
    f.driver = f.mount("edem");
    return f;
}
function settle(f, data = playlist) {
    f.host.getChannelsArray(() => {});
    f.requests.at(-1).resolve(data);
    return f.host.cList[0];
}
function coreChannel(f, channel) {
    f.host.OttPlayCore.parseOperatorPlaylist = () => ({
        channels: { c: clone(channel) },
        entries: [],
        groupOrder: [],
        groups: {},
        ids: ["c"],
    });
    settle(f);
}
function requestView(request) {
    const r = request.settings;
    return {
        data: r.data || null,
        dataType: r.dataType,
        method: r.method || "GET",
        timeout: r.timeout,
        url: r.url,
    };
}
function catalogView(f, callbacks) {
    return clone({
        callbacks,
        channels: f.host.channels,
        groupOrder: f.host.catsArray,
        groups: f.host.cats,
        ids: f.host.cList,
    });
}
function portalCall(request) {
    return {
        data: request.settings.data,
        type: request.settings.type,
        url: request.settings.url,
    };
}
function normalizeRows(rows) {
    return withoutSource(rows).map((row) => {
        if (row) delete row.edemLazy;
        return row;
    });
}
function portalExpectedCall(row) {
    const expected = clone(row.expected.calls[0]);
    delete expected.async;
    const params = JSON.parse(expected.data);
    if (params.key === "existing") params.key = "secret";
    expected.data = JSON.stringify(params);
    return expected;
}

test("23 captured playlist projections and detached ownership", () => {
    for (const row of require("./fixtures/playlist/operators.json").cases) {
        const f = setup();
        let callbacks = 0;
        f.host.getChannelsArray(() => callbacks++);
        f.requests[0].resolve(row.input);
        const expected = clone(row.operators.edem);
        delete expected.errors;
        // The historical extraction omitted edkey/_edcdnHost; its blanket UI alert is not a parser contract.
        assert.deepEqual(catalogView(f, callbacks), expected);
        if (f.host.cList.length) {
            const id = f.host.cList[0],
                before = f.driver.stream(id);
            f.host.channels[id].url = "https://tampered.test";
            assert.equal(f.driver.stream(id), before);
        }
    }
});

test("12 captured template/interception/relay contracts plus all four list settings", () => {
    for (const row of require("./fixtures/operator/profiles-before-core.json").cases.filter(
        (row) => row.profile === "edem"
    )) {
        const settings = {
            ededcdn: "https://cdn.test/path",
            edkey: "12345678",
            edlist: "1",
            ...Object.fromEntries(
                Object.entries(row.input.settings || {}).map(([key, value]) => [
                    "ed" + key,
                    value,
                ])
            ),
        };
        const f = edemFixture(settings),
            intercepted = [];
        f.host.location.href =
            row.input.href || "https://player.test/index.html";
        if (row.input.intercept)
            f.host.stbInterceptRequest = (url) => intercepted.push(url);
        f.mount("edem");
        let callbacks = 0;
        f.host.getChannelsArray(() => callbacks++);
        for (let i = 0; i < f.requests.length; i++) {
            if (row.input.failAll || (row.input.failFirst && i === 0))
                f.requests[i].reject({}, "fixture", "failed");
            else f.requests[i].resolve("#EXTM3U\n");
        }
        assert.equal(callbacks, row.expected.callbacks);
        assert.deepEqual(
            clone(f.requests.map(requestView)),
            row.expected.calls
        );
        assert.deepEqual(
            intercepted,
            row.expected.events
                .filter((event) => event[0] === "intercept")
                .map((event) => event[1])
        );
        assert.equal(f.errors.length, row.input.failAll ? 1 : 0);
        if (row.input.settings?.key === "")
            assert(
                f.events.some(
                    (event) =>
                        event[0] === "info" && event[1].includes("Access key")
                )
            );
    }
    for (let list = 0; list < 4; list++) {
        const f = setup({ edlist: String(list) });
        settle(f);
        assert.equal(
            f.requests[0].settings.url,
            f.host.OttPlayCore.operatorProfileUrl("edem", "playlist", {
                list,
                scheme: "https://",
            })
        );
    }
    for (const scheme of ["http://", "https://"]) {
        const f = edemFixture();
        f.host.scheme = scheme;
        f.mount("edem");
        settle(f);
        assert(f.requests[0].settings.url.startsWith(scheme));
    }
});

test("10 captured live URLs, 8 archive URLs, full EPG namespaces, fail-closed getters", () => {
    for (const row of require("./fixtures/operator/media-before-core.json").cases.filter(
        (row) => row.profile === "edem"
    )) {
        const f = setup({
            ededcdn:
                row.input.host === undefined
                    ? "https://cdn.test/path"
                    : row.input.host,
            edkey: "ed-key",
        });
        coreChannel(f, {
            url: "https://localhost/00000000000000/index.m3u8?foo=1",
            ...row.input.channel,
        });
        assert.equal(f.driver.stream("c"), row.expected.value);
    }
    for (const row of require("./fixtures/archive/providers.json").fixtures.filter(
        (row) => row.provider === "edem"
    )) {
        const f = edemFixture();
        f.host.browserName = () => (row.dune ? "dune" : "browser");
        f.host.Date = { now: () => row.now * 1000 };
        f.driver = f.mount("edem");
        coreChannel(f, row.channel);
        assert.equal(f.driver.archive("c", row.start, row.end), row.expected);
    }
    for (const list of [0, 1, 2, 3]) {
        const f = setup({ edlist: String(list) });
        coreChannel(f, {
            epg: "guide42",
            logo: "picon",
            url: "https://cdn.test/live",
        });
        let guide;
        f.driver.guide("c", (value) => (guide = value));
        assert.equal(
            f.requests.at(-1).settings.url,
            `https://epg.drm-play.com/${list === 1 ? "iptv-e2-soveni" : "edem"}/epg/guide42.json`
        );
        const response = { epg_data: [{ name: "Now" }] };
        f.requests.at(-1).resolve(response);
        assert.deepEqual(clone(guide), response.epg_data);
        guide[0].name = "changed";
        assert.equal(response.epg_data[0].name, "Now");
        assert.equal(f.driver.logo("c"), "picon");
        assert.equal(f.driver.stream("missing"), "");
        assert.equal(f.driver.archive("missing", 1, 2), "");
        f.driver.guide("missing", (value) => assert.equal(value, null));
        f.driver.guide("c", (value) => assert.equal(value, null));
        f.requests.at(-1).reject();
    }
});

test("18 captured portal navigation/catalog/filter cases with owned asynchronous completion", () => {
    for (const row of portalCases.filter((row) => !row.input.method)) {
        const f = setup();
        let callbacks = 0;
        const complete = () => callbacks++;
        if (row.input.stale) complete.isCurrent = () => false;
        f.host.getMediaArray(
            row.input.url === undefined ? "" : clone(row.input.url),
            complete
        );
        if (row.input.stale) {
            assert.equal(f.requests.length, 0);
            assert.equal(callbacks, 0);
            continue;
        }
        if (f.requests[0]) {
            assert.deepEqual(
                portalCall(f.requests[0]),
                portalExpectedCall(row)
            );
            if (row.input.fail) f.requests[0].reject({ status: 500 });
            else f.requests[0].resolve(clone(row.input.response));
        }
        assert.equal(callbacks, 1);
        if (!row.input.fail)
            assert.deepEqual(
                normalizeRows(f.host.mediaRecords),
                row.expected.mediaRecords
            );
        assert.equal(
            f.host.mediaName,
            row.expected.mediaName.replace(
                "Media from ED",
                "Media from Edem.tv / iLook.tv"
            )
        );
        const errorCount = row.expected.events.filter(
            (event) => event[0] === "alert"
        ).length;
        assert.equal(f.errors.length, errorCount);
        if (errorCount) assert.equal(f.errors[0], "VPortal request failed");
    }
});

test("5 captured portal item inheritance/description cases without source mutation", () => {
    for (const row of portalCases.filter(
        (row) => row.input.method === "media"
    )) {
        const f = setup(),
            source = clone(row.input.item),
            before = clone(source);
        let result;
        f.driver.mediaLoad("", 2, (value) => (result = value));
        f.requests[0].resolve({
            ...clone(row.input.parent),
            items: [source],
            type: "category",
        });
        assert.deepEqual(
            withoutSource(result.records)[0],
            row.expected.value === undefined ? null : row.expected.value
        );
        assert.deepEqual(source, before);
    }
});

test("large catalog and lazy pages traverse the response catalog only once", () => {
    for (const page of [false, true]) {
        const f = setup(),
            count = 128;
        let result,
            catalogReads = 0,
            titleReads = 0;
        if (page) {
            f.driver.mediaLoad("", count / 10, () => {});
            f.requests.at(-1).resolve({
                count,
                items: [{ type: "next" }],
                type: "category",
            });
            f.driver.mediaPage(0, (value) => (result = value));
        } else f.driver.mediaLoad("", count / 10, (value) => (result = value));
        const items = Object.freeze(
            Array.from({ length: count }, (_, id) =>
                Object.freeze({
                    request: Object.freeze({ id }),
                    title: "Item " + id,
                    type: "stream",
                    url: "https://media.test/" + id,
                })
            )
        );
        const response = Object.freeze({
            controls: {
                filters: [{ items: [], title: "Genre" }],
                search: true,
            },
            get items() {
                catalogReads++;
                return items;
            },
            get title() {
                titleReads++;
                return "Collection";
            },
            type: "category",
        });
        f.requests.at(-1).resolve(response);
        assert.equal(result.error, undefined);
        assert.equal(result.records.length, count + (page ? 0 : 2));
        assert.equal(result.records[0].title, "Collection - Item 0");
        assert.equal(result.records[count - 1].request.id, count - 1);
        assert.equal(
            catalogReads,
            1,
            "the decoder owns the only catalog traversal"
        );
        assert.equal(
            titleReads,
            2,
            "decoder plus one shared metadata snapshot"
        );
        result.records[0].request.id = "changed";
        assert.equal(items[0].request.id, 0);
        assert.equal(result.records[1].request.id, 1);
        if (!page) {
            assert.equal(result.records[count].search_on, 1);
            assert.equal(result.records[count + 1].playlist_url.a, "filters");
        }
    }
});

test("metadata projection preserves unusual own values and isolates core mutations", () => {
    for (const fields of [
        {
            agelimit: false,
            duration: 0,
            img: false,
            imglr: "cover",
            title: 0,
            year: null,
        },
        {
            agelimit: [12],
            description: { text: "summary" },
            duration: "90.5",
            img: { nested: ["cover"] },
            imglr: "",
            title: "Parent",
            year: JSON.parse('{"nested":[2026],"__proto__":{"valid":true}}'),
        },
    ]) {
        const f = setup(),
            response = {
                ...fields,
                description: fields.description,
                type: "category",
            },
            original = f.host.OttPlayCore.operatorPortalItem;
        Object.setPrototypeOf(response, {
            ignored: "prototype",
            title: "Inherited",
        });
        Object.defineProperty(response, "duration", {
            enumerable: false,
            value: response.duration,
        });
        const item = {
            request: { nested: [1] },
            title: "Child",
            type: "stream",
        };
        response.items = [clone(item), clone(item)];
        const before = clone(response);
        let calls = 0,
            result;
        f.host.OttPlayCore.operatorPortalItem = (value, parent) => {
            assert.equal(Object.hasOwn(parent, "items"), false);
            assert.equal(Object.hasOwn(parent, "duration"), false);
            const projected = original(value, parent),
                expected = original(clone(value), response);
            assert.deepEqual(clone(projected), clone(expected));
            if (parent.year && typeof parent.year === "object")
                parent.year.nested[0] = 1900;
            if (parent.img && typeof parent.img === "object")
                parent.img.nested[0] = "changed";
            value.request.nested[0] = 9;
            calls++;
            return projected;
        };
        f.driver.mediaLoad("", 2, (value) => (result = value));
        f.requests.at(-1).resolve(response);
        assert.equal(result.error, undefined);
        assert.equal(calls, 2);
        assert.deepEqual(clone(response), before);
        assert.deepEqual(clone(result.records[0].request), { nested: [1] });
        assert.deepEqual(clone(result.records[1].request), { nested: [1] });
    }
});

test("5 captured lazy-page routes/projections on actual placeholder state", () => {
    for (const row of portalCases.filter(
        (row) => row.input.method === "page"
    )) {
        const f = setup();
        let loaded, page;
        f.driver.mediaLoad("", 0.2, (value) => (loaded = value));
        f.requests[0].resolve({
            count: 6,
            items: [{ title: "previous", type: "stream" }, { type: "next" }],
            type: "category",
        });
        assert.equal(loaded.records.length, 6);
        f.driver.mediaPage(3, (value) => (page = value));
        assert.deepEqual(portalCall(f.requests[1]), portalExpectedCall(row));
        f.requests[1].resolve(clone(row.input.response));
        assert(page);
        if (row.expected.mediaRecords[2]) {
            assert.deepEqual(
                withoutSource(page.records[2]),
                row.expected.mediaRecords[2]
            );
            assert.equal(page.selected, 2);
            assert.equal(page.records.length, 3);
        } else {
            assert.equal(page.selected, 1);
            assert.equal(page.records.length, 2);
        }
    }
});

test("6 captured playback/variant responses using immutable history input", () => {
    for (const row of portalCases.filter(
        (row) => row.input.method === "play"
    )) {
        const f = setup(),
            item = clone(row.input.item),
            before = clone(item);
        f.host.medHistory = [item];
        f.host.playMedia(item);
        assert.equal(
            f.events.filter((event) => event[0] === "play").length,
            0,
            "resolution must be asynchronous"
        );
        assert.deepEqual(portalCall(f.requests[0]), portalExpectedCall(row));
        assert.notEqual(f.requests[0].settings.async, false);
        f.requests[0].resolve(clone(row.input.response));
        const variants = row.expected.events.find(
            (event) => event[0] === "variants"
        );
        if (variants) {
            const handler = f.host.dialogBoxKeyHandler;
            if (row.input.variant === -1) handler(f.host.keys.RETURN);
            else {
                handler(f.host.keys.DOWN);
                handler(f.host.keys.ENTER);
            }
        }
        const played = f.events.filter((event) => event[0] === "play");
        const expected = row.expected.events.find(
            (event) => event[0] === "play"
        );
        if (
            row.input.response &&
            row.input.response.type !== "error" &&
            row.input.variant !== -1
        )
            assert.deepEqual(withoutSource(played[0]), expected);
        else
            assert.equal(
                played.length,
                0,
                "null/error/cancel must not start stale media"
            );
        assert.deepEqual(
            withoutSource(item),
            before,
            "the history URL cannot be rewritten before core identity matching"
        );
    }
});

test("seven Edem searches preserve decoded JSON query and malformed legacy percent text", () => {
    for (const text of [
        "Игра престолов",
        "Star Wars",
        "a=b & c+d",
        "100% and a literal %20",
        "100%",
        "%D0%",
        "%ZZ + = &",
    ]) {
        const f = setup(),
            encoded = ["100%", "%D0%", "%ZZ + = &"].includes(text)
                ? text
                : encodeURIComponent(text);
        f.host.getMediaArray("search?search=" + encoded, () => {});
        const params = JSON.parse(f.requests[0].settings.data);
        assert.equal(params.cmd, "search");
        assert.equal(params.query, text);
        f.requests[0].resolve({ items: [], type: "category" });
        assert.equal(f.host.mediaName, "[" + text + "]");
    }
});

test("lazy rows survive renderer state replacement and keep page array identity", () => {
    const f = setup();
    f.host.sPageSize = 0.2;
    f.host.getMediaArray("", () => {
        f.host._mediaLoadState = { records: f.host.mediaRecords };
        f.host.listArray = f.host.mediaRecords;
    });
    f.requests[0].resolve({
        count: 6,
        items: [{ title: "one", type: "stream" }, { type: "next" }],
        type: "category",
    });
    const accepted = f.host.mediaRecords;
    f.host.selIndex = 3;
    accepted[3].description();
    accepted[3].description();
    assert.equal(
        f.requests.length,
        2,
        "repeat detail rendering must not duplicate the pending page"
    );
    assert.equal(JSON.parse(f.requests[1].settings.data).offset, 2);
    f.requests[1].resolve({
        items: [
            { title: "two", type: "stream" },
            { title: "three", type: "stream" },
        ],
    });
    assert.strictEqual(f.host.mediaRecords, accepted);
    assert.strictEqual(f.host.listArray, accepted);
    assert.equal(accepted[3].title, "three");
    assert.equal(f.host.selIndex, 3);
    f.host.selIndex = 5;
    accepted[5].description();
    assert.equal(JSON.parse(f.requests[2].settings.data).offset, 4);
    f.host.closeList();
    f.requests[2].resolve({ items: [{ title: "late", type: "stream" }] });
    assert.equal(f.requests[2].aborts, 1);
    assert.notEqual(accepted[4].title, "late");
});

test("catalog/guide/root/page/play requests are aborted and reject late callbacks on provider switch", () => {
    for (const phase of ["catalog", "guide", "root", "page", "play"]) {
        const f = setup();
        let callbacks = 0;
        if (phase === "catalog") f.host.getChannelsArray(() => callbacks++);
        if (phase === "guide") {
            coreChannel(f, { epg: "guide", url: "https://stream" });
            f.driver.guide("c", () => callbacks++);
        }
        if (phase === "root") f.host.getMediaArray("", () => callbacks++);
        if (phase === "page") {
            f.driver.mediaLoad("", 0.2, () => {});
            f.requests.at(-1).resolve({
                count: 4,
                items: [{ type: "next" }],
                type: "category",
            });
            f.driver.mediaPage(2, () => callbacks++);
        }
        if (phase === "play")
            f.host.playMedia({ request: { id: 4 }, title: "movie" });
        const request = f.requests.at(-1),
            count = f.requests.length;
        f.mount("demo");
        request.resolve({ items: [], type: "category", url: "https://late" });
        request.reject();
        assert.equal(request.aborts, 1, phase);
        assert.equal(callbacks, 0, phase);
        assert.equal(f.requests.length, count, phase);
        assert.equal(f.events.filter((event) => event[0] === "play").length, 0);
    }
});

test("new navigation/page and explicit cancellation reject uncooperative old responses", () => {
    const f = setup();
    let first = 0,
        second = 0;
    f.host.getMediaArray("", () => first++);
    const old = f.requests[0];
    f.host.getMediaArray("search=second", () => second++);
    old.resolve({
        items: [{ title: "old", type: "stream" }],
        type: "category",
    });
    f.requests[1].resolve({ items: [], type: "category" });
    assert.equal(old.aborts, 1);
    assert.equal(first, 0);
    assert.equal(second, 1);
    assert.equal(f.host.mediaName, "[second]");
    f.driver.mediaLoad("", 0.2, () => {});
    f.requests[2].resolve({
        count: 10,
        items: [{ type: "next" }],
        type: "category",
    });
    f.driver.mediaPage(2, () => first++);
    const oldPage = f.requests[3];
    f.driver.mediaPage(4, () => second++);
    oldPage.resolve({ items: [] });
    f.requests[4].resolve({ items: [] });
    assert.equal(oldPage.aborts, 1);
    assert.equal(first, 0);
    assert.equal(second, 2);
    f.host.playMedia({ request: {}, title: "cancelled" });
    const pending = f.requests.at(-1),
        busy = f.host.dialogBoxKeyHandler;
    busy(f.host.keys.STOP);
    pending.resolve({ url: "https://late" });
    assert.equal(pending.aborts, 1);
    assert.equal(f.events.filter((event) => event[0] === "play").length, 0);
});

test("variant remote/mouse/foreign-dialog and stale handler ownership", () => {
    const f = setup();
    function begin() {
        f.host.playMedia({ request: {}, title: "Movie" });
        f.requests.at(-1).resolve({
            url: "high",
            variants: Object.fromEntries([
                ["Low", "low"],
                ["High", "high"],
            ]),
        });
        return f.host.dialogBoxKeyHandler;
    }
    let handler = begin();
    handler(f.host.keys.RIGHT);
    handler(f.host.keys.ENTER);
    assert.equal(
        f.events.find((event) => event[0] === "play")[1].stream_url,
        "low"
    );
    const previous = begin(),
        newer = begin();
    assert.equal(previous(f.host.keys.ENTER), false);
    newer(f.host.keys.UP);
    newer(f.host.keys.ENTER);
    assert.equal(
        f.events.filter((event) => event[0] === "play").at(-1)[1].stream_url,
        "high"
    );
    handler = begin();
    const foreign = () => {};
    f.host.dialogBoxKeyHandler = foreign;
    f.panels["#dialogbox"].html = "foreign";
    assert.equal(handler(f.host.keys.RETURN), false);
    f.host.providerMediaClient.cancel();
    assert.equal(f.panels["#dialogbox"].html, "foreign");
    assert.strictEqual(f.host.dialogBoxKeyHandler, foreign);
    begin();
    f.panels["#edemQuality0"].click();
    f.panels["#edemQuality0"].click();
    assert.equal(
        f.events.filter((event) => event[0] === "play").at(-1)[1].stream_url,
        "low"
    );
    handler = begin();
    f.mount("demo");
    const n = f.events.length;
    handler(f.host.keys.ENTER);
    assert.equal(f.events.length, n);
});

test("settings retain key/list/CDN/portal behavior, prefix and remote navigation", () => {
    const f = setup();
    settle(f);
    const id = f.host.cList[0];
    f.host.duneAddSettings(0);
    assert.equal(f.host.popupArray[0], "Access settings Edem.tv / iLook.tv");
    f.host.popupActions[0]();
    assert.equal(f.host.listArray.length, 6);
    f.host.selIndex = 0;
    f.host.listKeyHandler(f.host.keys.ENTER);
    f.host.editvar = "new-key";
    f.host.setEdit();
    assert.equal(f.saved.get("edkey"), "new-key");
    assert.equal(f.events.filter((event) => event[0] === "live").length, 1);
    assert(f.driver.stream(id).includes("new-key"));
    f.host.selIndex = 1;
    assert.equal(f.host.listKeyHandler(f.host.keys.LEFT), false);
    f.host.listKeyHandler(f.host.keys.ENTER);
    f.host.editvar = "x";
    f.host.setEdit();
    assert.equal(f.errors.length, 1);
    f.host.editvar = " https://edge.cdn.test/folder/stream ";
    f.host.setEdit();
    assert.equal(f.saved.get("ededcdn"), "edge.cdn.test");
    assert(f.host.listArray[1].includes("edge.cdn.test"));
    f.host.selIndex = 2;
    f.host.listKeyHandler(f.host.keys.LEFT);
    assert.equal(f.saved.get("edlist"), "3");
    f.host.listKeyHandler(f.host.keys.RIGHT);
    assert.equal(f.saved.get("edlist"), "0");
    f.host.selIndex = 3;
    f.host.listKeyHandler(f.host.keys.ENTER);
    f.host.editvar = "wrong";
    f.host.setEdit();
    assert.equal(f.errors.length, 2);
    f.host.editvar = "portal::%5Bkey:other%5Dhttps://new.test/api";
    f.host.setEdit();
    assert.equal(
        f.saved.get("edvpurl"),
        "portal::[key:other]https://new.test/api"
    );
    assert.deepEqual(clone(f.host.mediaSelects), [0]);
    assert.equal(f.host.mediaUrls, null);
    f.host.listKeyHandler(f.host.keys.ENTER);
    f.host.editvar = "";
    f.host.setEdit();
    assert.equal(f.host.getMediaArray, null);
    f.host.listKeyHandler(f.host.keys.N8);
    assert.equal(f.reloads, 1);
    f.host.listKeyHandler(f.host.keys.RETURN);
    assert(
        f.calls.some((value) => Array.isArray(value) && value[0] === "popup")
    );
});

test("portal header normalization preserves complete opaque endpoints in root, navigation, page and playback requests", () => {
    for (const [header, endpoint] of [
        [
            "portal::%5Bkey:other%5D",
            "https://new.test/api?filters%5B0%5D=a%2Bb&filters%5B1%5D=c",
        ],
        [
            "portal::%5bkey:other%5d",
            "https://new.test/api?filters%5b0%5D=a%2Bb&filters%5B1%5d=c",
        ],
        [
            "portal::[key:other%5d",
            "https://new.test/[path]/api?filters[0]=a%2Bb&filters[1]=c",
        ],
        [
            "portal::[key:other]",
            "http://[2001:db8::1]:8080/api?filters[]=[]&literal=%255B%2F%26",
        ],
    ]) {
        const f = setup();
        f.host.duneAddSettings(0);
        f.host.popupActions[0]();
        f.host.selIndex = 3;
        f.host.listKeyHandler(f.host.keys.ENTER);
        f.host.editvar = header + endpoint;
        f.host.setEdit();
        assert.equal(f.saved.get("edvpurl"), "portal::[key:other]" + endpoint);
        assert.equal(f.errors.length, 0);
        f.driver.mediaResolve({ request: { cmd: "play", id: 7 } }, () => {});
        assert.equal(f.requests.at(-1).settings.url, endpoint);
        f.requests.at(-1).reject();
        f.host.getMediaArray("", () => {});
        assert.equal(f.requests.at(-1).settings.url, endpoint);
        assert.equal(JSON.parse(f.requests.at(-1).settings.data).key, "other");
        f.requests.at(-1).resolve({
            count: 6,
            items: [{ title: "previous", type: "stream" }, { type: "next" }],
            type: "category",
        });
        f.driver.mediaPage(3, () => {});
        assert.equal(f.requests.at(-1).settings.url, endpoint);
        f.requests.at(-1).resolve({ items: [], type: "category" });
        f.driver.mediaLoad({ request: { cmd: "open", id: 8 } }, 2, () => {});
        assert.equal(f.requests.at(-1).settings.url, endpoint);
        assert.equal(JSON.parse(f.requests.at(-1).settings.data).cmd, "open");
    }
});

test("settings/account teardown reentry cannot overwrite storage or replay a replacement owner", () => {
    for (const row of [0, 1, 3]) {
        const f = setup();
        f.host.duneAddSettings(0);
        f.host.popupActions[0]();
        f.host.getMediaArray("", () => {});
        const pending = f.requests[0],
            originalAbort = pending.abort;
        pending.abort = function () {
            originalAbort.call(this);
            f.mount("demo");
        };
        f.host.selIndex = row;
        f.host.listKeyHandler(f.host.keys.ENTER);
        const callback = f.host.setEdit;
        f.host.editvar =
            row === 0
                ? "other"
                : row === 1
                  ? "next.cdn.test"
                  : "portal::[key:other]https://next.test";
        const before = Array.from(f.saved),
            count = f.events.filter((event) => event[0] === "render").length;
        callback();
        assert.deepEqual(Array.from(f.saved), before);
        assert.equal(f.events.filter((event) => event[0] === "live").length, 0);
        assert.equal(
            f.events.filter((event) => event[0] === "render").length,
            count
        );
        callback();
        assert.deepEqual(Array.from(f.saved), before);
    }
    const f = setup();
    f.host.duneAddSettings(0);
    f.host.popupActions[0]();
    f.host.selIndex = 0;
    f.host.listKeyHandler(f.host.keys.ENTER);
    const old = f.host.setEdit;
    f.host.selIndex = 1;
    f.host.listKeyHandler(f.host.keys.ENTER);
    f.host.editvar = "latest.cdn.test";
    old();
    assert.equal(f.saved.get("edkey"), "12345678");
});

test("abort reentry preserves newest media operation and retired dialog handlers", () => {
    const f = setup();
    let oldCalls = 0,
        newCalls = 0,
        middle = 0;
    f.driver.mediaLoad("", 2, () => oldCalls++);
    const old = f.requests[0],
        abort = old.abort;
    old.abort = function () {
        abort.call(this);
        f.driver.mediaLoad("search=latest", 2, () => newCalls++);
    };
    f.driver.mediaLoad("search=middle", 2, () => middle++);
    assert.equal(f.requests.length, 2);
    assert.equal(JSON.parse(f.requests[1].settings.data).query, "latest");
    f.requests[1].resolve({ items: [], type: "category" });
    old.resolve({ type: "category" });
    assert.equal(oldCalls, 0);
    assert.equal(middle, 0);
    assert.equal(newCalls, 1);
    f.host.getMediaArray("", () => {});
    const oldHandler = f.host.dialogBoxKeyHandler;
    f.host.getMediaArray("search=newer", () => {});
    const current = f.host.dialogBoxKeyHandler;
    assert.equal(oldHandler(f.host.keys.RETURN), false);
    assert.strictEqual(f.host.dialogBoxKeyHandler, current);
});

test("external metadata is escaped and request failures complete once without leaking credentials", () => {
    const f = setup();
    let callbacks = 0;
    f.host.getMediaArray("", () => callbacks++);
    f.requests[0].resolve({
        items: [
            {
                description: "<script>bad</script>",
                img: "javascript:alert(1)",
                request: {},
                title: '<img onerror="bad">',
                type: "stream",
            },
        ],
        type: "category",
    });
    assert(f.host.mediaRecords[0].description.includes("&lt;img"));
    assert(!f.host.mediaRecords[0].description.includes("javascript:"));
    assert.equal(callbacks, 1);
    f.host.getMediaArray("", () => callbacks++);
    const request = f.requests[1];
    request.reject({ responseText: "secret" });
    request.resolve({ type: "category" });
    assert.equal(callbacks, 2);
    assert.equal(f.errors.at(-1), "VPortal request failed");
    f.host.playMedia({ request: {}, title: "A" });
    const play = f.requests.at(-1);
    play.reject({ responseText: "secret" });
    play.resolve({ url: "late" });
    assert.equal(f.events.filter((event) => event[0] === "play").length, 0);
});

test("history uses source/request identity across URL renewal and preserves resume", () => {
    const f = setup();
    const previous = {
        current: 75,
        request: { cmd: "play", id: 42 },
        stream_url: "https://expired",
        title: "Same title",
    };
    f.host.medHistory = [previous];
    let selection, playable;
    f.host._playMedia = (item) => {
        playable = item;
        selection = f.host.OttPlayCore.classicHistorySelection(
            f.host.medHistory,
            item,
            item.stream_url,
            -1e11,
            2
        );
    };
    f.host.playMedia(previous);
    f.requests[0].resolve({ url: "https://renewed" });
    assert.equal(previous.stream_url, "https://expired");
    assert.equal(selection.index, 0);
    assert.equal(selection.resume, 60);
    assert.equal(selection.skip, false);
    assert.equal(playable.stream_url, "https://renewed");
    assert.notStrictEqual(playable, previous);
    assert.equal(previous.vportalSource, f.driver.mediaSource());
    assert(!previous.vportalSource.includes("secret"));
    f.host.playMedia({ request: { cmd: "play", id: 99 }, title: "Same title" });
    f.requests[1].resolve({ url: "https://different" });
    assert.equal(selection.index, -1);
    assert.equal(selection.resume, 0);
    f.driver.saveSettings({
        ...f.driver.settings(),
        portal: "portal::[key:other]https://portal.test/api",
    });
    const count = f.requests.length;
    f.host.playMedia(previous);
    assert.equal(
        f.requests.length,
        count,
        "media from a retired portal cannot resolve against a new account"
    );
});

test("credentials teardown respects a newer direct media load; list changes dismiss cancelled work", () => {
    const f = setup();
    f.driver.mediaLoad("", 2, () => {});
    const old = f.requests[0],
        abort = old.abort;
    old.abort = function () {
        abort.call(this);
        f.driver.mediaLoad("search=newest", 2, () => {});
    };
    const before = Array.from(f.saved);
    assert.equal(
        f.driver.saveSettings({ ...f.driver.settings(), key: "replacement" }),
        false
    );
    assert.deepEqual(Array.from(f.saved), before);
    assert.equal(f.requests[1].aborts, 0);
    assert.equal(JSON.parse(f.requests[1].settings.data).query, "newest");
    f.requests[1].resolve({ items: [], type: "category" });
    f.host.getMediaArray("", () => {});
    const request = f.requests.at(-1);
    f.host.duneAddSettings(0);
    f.host.popupActions[0]();
    f.host.selIndex = 2;
    f.host.listKeyHandler(f.host.keys.RIGHT);
    assert.equal(request.aborts, 1);
    assert.equal(f.panels["#dialogbox"].visible, false);
});

test("local filters invoke a throwing consumer exactly once", () => {
    for (const target of [
        { a: "filters", filters: [{ items: [], title: "Genre" }] },
        { a: "filter", items: [{ request: {}, title: "All" }] },
    ]) {
        const f = setup();
        let calls = 0;
        assert.throws(
            () =>
                f.driver.mediaLoad(target, 2, () => {
                    calls++;
                    throw new Error("renderer");
                }),
            /renderer/
        );
        assert.equal(calls, 1);
        assert.equal(f.requests.length, 0);
    }
});

test("portal identity distinguishes case-sensitive access keys", () => {
    const f = setup();
    const original = f.driver.mediaSource();
    f.host.getMediaArray("", () => {});
    f.requests[0].resolve({
        items: [{ request: { id: 1 }, title: "Old", type: "stream" }],
        type: "category",
    });
    const old = f.host.mediaRecords[0];
    f.driver.saveSettings({
        ...f.driver.settings(),
        portal: "portal::[key:SECRET]https://portal.test/api",
    });
    assert.notEqual(f.driver.mediaSource(), original);
    const count = f.requests.length;
    f.host.playMedia(old);
    assert.equal(f.requests.length, count);
});

test("mount publication respects source replacement inside injected translation/storage callbacks", () => {
    const hooks = [
        "getMediaArray",
        "playMedia",
        "providerMediaClient",
        "duneAddSettings",
        "parental",
        "p_pref",
    ];
    for (const target of ["demo", "xtream"]) {
        for (const phrase of [
            "epg.one (Standard)",
            "epg.one (Thematic)",
            "epg.one (Ordered)",
            "Enter the VPortal link as shown in the cabinet",
            "storage",
        ]) {
            const f = edemFixture();
            let replacement;
            function replace() {
                f.mount(target);
                replacement = Object.fromEntries(
                    hooks.map((key) => [key, f.host[key]])
                );
            }
            if (phrase === "storage") {
                const read = f.host.stbGetItem;
                let replaced = false;
                f.host.stbGetItem = (key) => {
                    if (key === "edvpurl" && !replaced) {
                        replaced = true;
                        replace();
                    }
                    return read(key);
                };
            } else
                f.host._ = (value) => {
                    if (value === phrase && !replacement) replace();
                    return value;
                };
            f.mount("edem");
            assert(replacement, phrase);
            assert.equal(f.host.__ottActiveProviderDriver.id, target);
            for (const key of hooks)
                assert.strictEqual(
                    f.host[key],
                    replacement[key],
                    target + ":" + phrase + ":" + key
                );
            assert.equal(f.requests.length, 0);
        }
    }
});

test("real loadProv/loadChannels dispatches Edem without provider script or AJAX patching", () => {
    const f = edemFixture({}, true);
    f.host.loadProv();
    assert.equal(f.host.__ottActiveProviderDriver.id, "edem");
    assert.equal(f.scripts.length, 0);
    assert.equal(f.ajaxWrites, 0);
    for (const callback of Array.from(f.timers.values())) callback();
    assert.equal(f.requests.length, 1);
    f.requests[0].resolve(playlist);
    assert.equal(f.completed, 1);
    assert.equal(typeof f.host.getMediaArray, "function");
    f.host.getMediaArray("", () => {});
    const old = f.requests.at(-1);
    f.saved.set("ottplayprov", "demo");
    f.host.loadProv();
    assert.equal(old.aborts, 1);
    old.resolve({
        items: [{ title: "late", type: "stream" }],
        type: "category",
    });
    assert.equal(f.host.__ottActiveProviderDriver.id, "demo");
    assert.equal(f.scripts.length, 0);
    assert.equal(f.ajaxWrites, 0);
});
test("remote queues use the shared VPortal search and automatic resolver with owned cancellation", () => {
    const f = setup();
    const clients = [];
    f.host.parseVPortalLink = () => ({ url: "https://portal.test/api" });
    f.host.checkProviderUrl = () => true;
    f.host.createVPortalClient = (link, options) => {
        const record = {
            automaticCancels: 0,
            cancels: 0,
            disposed: 0,
            link,
            options,
            resolutions: [],
        };
        record.client = {
            cancel() {
                record.cancels++;
            },
            cancelAutomatic() {
                record.automaticCancels++;
            },
            dispose() {
                record.disposed++;
            },
            resolve(item, done, automatic) {
                record.resolutions.push({ automatic, item });
                done({ ...item, stream_url: "https://video.test/fresh.mp4" });
            },
            search(query, done, guard) {
                record.query = query;
                record.guard = guard;
                done({ items: [] });
                return () => {
                    record.searchCancelled = true;
                };
            },
        };
        clients.push(record);
        return record.client;
    };
    const client = f.host.providerMediaClient;
    const guard = () => true;
    let result;
    const cancel = client.search(
        "Фильм",
        (value) => {
            result = value;
        },
        guard
    );
    assert.deepEqual(clone(result), { items: [] });
    assert.equal(clients[0].query, "Фильм");
    assert.strictEqual(clients[0].guard, guard);
    assert.equal(clients[0].options.sourceId, f.driver.mediaSource());
    assert.equal(clients[0].options.isCurrent(), true);
    cancel();
    assert.equal(clients[0].searchCancelled, true);
    const item = { __ottVPortalQueue: true, request: { id: 7 } };
    client.resolve(item, () => {}, true);
    assert.deepEqual(clients[0].resolutions, [{ automatic: true, item }]);
    client.cancelAutomatic();
    assert.equal(clients[0].automaticCancels, 1);
    client.cancel();
    assert.equal(clients[0].cancels, 1);
    f.saved.set("edvpurl", "portal::[key:new-secret]https://other.test/api");
    assert.equal(clients[0].options.isCurrent(), false);
    client.search("Next", () => {}, guard);
    assert.equal(clients.length, 2);
    assert.equal(clients[0].disposed, 1);
    f.mount("m3u");
    assert.equal(clients[1].options.isCurrent(), false);
    assert.equal(clients[1].disposed, 1);
});

test("remote VPortal does not instantiate a portal rejected by platform policy", () => {
    const f = setup();
    f.host.parseVPortalLink = () => ({ url: "https://portal.test/api" });
    f.host.checkProviderUrl = () => false;
    f.host.createVPortalClient = () => assert.fail("Blocked provider endpoint");
    let reply;
    f.host.providerMediaClient.search("Movie", (result) => {
        reply = result;
    });
    assert.equal(reply.error, "VPortal is not configured.");
    assert.deepEqual(clone(reply.items), []);
});

console.log("PASS " + passed + " Edem instance driver groups");
