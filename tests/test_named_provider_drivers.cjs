"use strict";
const assert = require("node:assert/strict");
const vm = require("node:vm");
const {
    fixture,
    integrationFixture,
} = require("./helpers/provider-driver-fixture.cjs");
const { declarations } = require("./helpers/playlist-fixture.cjs");
const clone = (value) => JSON.parse(JSON.stringify(value));
// Historical captures preserve their original Russian UI text. Protocol fields
// remain unchanged; only these newly localized presentation values differ.
function localizedCapture(value) {
    const labels = {
        "??? Нет названия канала": "??? No channel name",
        "Для доступа необходимо ввести ID и PIN!":
            "Enter an ID and PIN to access this service.",
        "Для доступа необходимо ввести IPTV токен! (10 символов)":
            "Enter an IPTV token (10 characters).",
        "Для доступа необходимо ввести адрес плейлиста!":
            "Enter a playlist URL to access this service.",
        "Логин или пароль отсутсвуют!": "Username or password is missing.",
    };
    return JSON.parse(JSON.stringify(value), (_key, item) =>
        typeof item === "string" && Object.hasOwn(labels, item)
            ? labels[item]
            : item
    );
}
const named = ["1ott", "only4", "shara-tv", "tvteam"];
const prefixes = {
    "1ott": "1ott",
    "bestlist/stalker": "bestlist_stalker",
    only4: "o4",
    "shara-tv": "shtv",
    tvteam: "tvteam",
};
const defaults = {
    id: "fixture-id",
    login: "12345678",
    pass: "abcdefgh",
    pin: "fixture-pin",
    token: "1234567890",
    www: "https://tv.team/pl/11/token/playlist.m3u8",
};
const playlist =
    '#EXTM3U\n#EXTINF:-1 tvg-id="guide" tvg-name="123" group-title="News" catchup-days="2",Live\nhttps://stream.test/123/index.m3u8?token=test\n';
function namedFixture(id, input = {}) {
    const settings = { ...defaults, ...input.settings };
    const initial = Object.fromEntries(
        Object.entries(settings).map(([key, value]) => [
            prefixes[id] + key,
            value,
        ])
    );
    const f = fixture(initial);
    const events = [],
        writes = [],
        values = {};
    const host = f.host;
    const timers = new Map();
    let nextTimer = 0;
    host.setTimeout = (fn) => {
        const id = ++nextTimer;
        timers.set(id, fn);
        return id;
    };
    host.clearTimeout = (id) => timers.delete(id);
    const query = (selector) => ({
        append: (value) => events.push(["append", value]),
        hide() {},
        val(value) {
            if (arguments.length) values[selector] = value;
            return values[selector];
        },
    });
    query.ajax = f.ajax;
    host.$ = query;
    host.alert = (value) => {
        f.errors.push(value);
        events.push(["alert", value]);
    };
    host.infoBox = (value) => events.push(["info", value]);
    host.popupList = () => events.push(["settings"]);
    host.browserName = () => (input.dune ? "dune" : "browser");
    host.location = {
        href: input.href || "https://player.test/index.html",
        search: "",
    };
    if (input.intercept)
        host.stbInterceptRequest = (value) => events.push(["intercept", value]);
    const set = host.stbSetItem;
    host.stbSetItem = (key, value) => {
        writes.push([key.slice(prefixes[id].length), value]);
        set(key, value);
    };
    Object.assign(host.keys, { LEFT: 37, N8: 56, RIGHT: 39 });
    return {
        ...f,
        events,
        initial,
        get reloads() {
            return f.reloads;
        },
        timers,
        values,
        writes,
    };
}
function requestSnapshot(f) {
    return f.requests.map(({ settings }) => ({
        data: settings.data || null,
        dataType: settings.dataType,
        method: settings.method || "GET",
        timeout: settings.timeout,
        url: settings.url,
    }));
}
function catalogSnapshot(f, callbacks) {
    return clone({
        callbacks,
        channels: f.host.channels,
        groupOrder: f.host.catsArray,
        groups: f.host.cats,
        ids: f.host.cList,
    });
}
function settle(f, id, data = playlist) {
    for (let index = 0; index < f.requests.length; index++) {
        const r = f.requests[index];
        const url = (r.settings.data && r.settings.data.url) || r.settings.url;
        r.resolve(
            id === "1ott" && url.includes("/PinApi/")
                ? '{"token":"fixture-token"}'
                : data
        );
    }
}
let groups = 0;
function test(label, run) {
    run();
    groups++;
    console.log("PASS named drivers: " + label);
}

test("48 captured named credentials, URL bootstrap, auth, interception and retry contracts", () => {
    let count = 0;
    for (const row of require("./fixtures/operator/profiles-before-core.json")
        .cases) {
        if (!named.includes(row.profile)) continue;
        const f = namedFixture(row.profile, row.input);
        f.mount(row.profile);
        let callbacks = 0,
            failure = null;
        try {
            f.host.getChannelsArray(() => callbacks++);
            for (let index = 0; index < f.requests.length; index++) {
                const r = f.requests[index];
                if (row.input.failAll || (row.input.failFirst && index === 0))
                    r.reject();
                else {
                    const url =
                        (r.settings.data && r.settings.data.url) ||
                        r.settings.url;
                    r.resolve(
                        row.profile === "1ott" && url.includes("/PinApi/")
                            ? row.input.auth === undefined
                                ? ' {"token":"fixture-token"} '
                                : row.input.auth
                            : "#EXTM3U\n"
                    );
                }
            }
        } catch (error) {
            failure = { message: error.message, name: error.name };
        }
        assert.deepEqual(
            clone({
                ...catalogSnapshot(f, callbacks),
                calls: requestSnapshot(f),
                events: f.events,
                failure,
                href: f.host.location.href,
                writes: f.writes,
            }),
            localizedCapture(row.expected),
            row.profile + JSON.stringify(row.input)
        );
        count++;
    }
    assert.equal(count, 48);
});

test("92 captured named playlist catalogs including empty and malformed partial data", () => {
    let count = 0;
    for (const row of require("./fixtures/playlist/operators.json").cases)
        for (const id of named) {
            const f = namedFixture(id);
            f.mount(id);
            let callbacks = 0;
            f.host.getChannelsArray(() => callbacks++);
            settle(f, id, row.input);
            assert.deepEqual(
                { ...catalogSnapshot(f, callbacks), errors: f.errors },
                localizedCapture(row.operators[id]),
                id + ": " + row.input
            );
            count++;
        }
    assert.equal(count, 92);
});

test("bestlist/stalker keeps its12 API/fallback transports with provider-owned channel IDs", () => {
    for (const row of require("./fixtures/stalker/bestlist-xtream.json")
        .cases) {
        const f = fixture({
            bestlist_stalkercfg: JSON.stringify({
                m3u: "",
                pass: "x?&",
                server: row.input.server || "https://xc.test",
                user: "a/b",
            }),
        });
        f.mount("bestlist/stalker");
        let callbacks = 0;
        f.host.getChannelsArray(() => callbacks++);
        if (row.input.failed) f.requests[0].reject();
        else f.requests[0].resolve(row.input.account);
        if (f.requests[1]) f.requests[1].resolve("#EXTM3U\n");
        const calls = f.requests.map((r, index) =>
            index ? { m3u: r.settings.url } : { url: r.settings.url }
        );
        assert.deepEqual(calls, row.expected.calls);
        assert.equal(callbacks, row.expected.callbacks);
        assert.deepEqual(f.errors, []);
        const streams = row.input.account && row.input.account.live_streams;
        if (!streams || !streams.length) {
            const { calls: _calls, ...emptyCatalog } = row.expected;
            assert.deepEqual(catalogSnapshot(f, callbacks), emptyCatalog);
            continue;
        }
        // These captures deliberately contain duplicate/empty display names.
        // Both provider streams must survive, even when the old name-hash
        // catalog collapsed them. Group classes now index provider groups;
        // the old +2 belonged to the separately owned All/Favorites UI rows.
        const ids = streams.length === 1 ? [1] : [1, 2, 3];
        const groupNames =
            streams.length === 1 ? ["Other"] : ["News", "Unknown", "Other"];
        assert.deepEqual(clone(f.host.cList), ids);
        assert.deepEqual(clone(f.host.catsArray), groupNames);
        assert.deepEqual(
            clone(f.host.cats),
            streams.length === 1
                ? { Other: [1] }
                : { News: [1], Other: [3], Unknown: [2] }
        );
        for (const [index, id] of ids.entries()) {
            const stream = streams[index];
            const name = stream.name || String(id);
            assert.deepEqual(clone(f.host.channels[id]), {
                ca: "",
                caso: "",
                category: { class: index, name: groupNames[index] },
                ch_id: id,
                channel_name: name,
                epg: String(id),
                groupId: "xtream:category:" + stream.category_id,
                itemId: "xtream:stream:" + id,
                legacyChannelId: f.host.xxHash32S(stream.name, true),
                logo: stream.stream_icon || "",
                rec: 0,
                tn: name,
                url: "https://xc.test/live/a%2Fb/x%3F%26/" + id + ".m3u8",
            });
        }
    }
});

test("bestlist stream identity survives renaming, reordering and duplicate display names", () => {
    const f = fixture({
        bestlist_stalkercfg: JSON.stringify({
            m3u: "",
            pass: "x?&",
            server: "https://xc.test",
            user: "a/b",
        }),
    });
    f.mount("bestlist/stalker");
    let callbacks = 0;
    function load(streams) {
        f.host.getChannelsArray(() => callbacks++);
        f.requests.at(-1).resolve({ live_streams: streams });
    }
    load([
        { name: "Same", stream_id: 10 },
        { name: "Same", stream_id: 20 },
    ]);
    const first = clone(f.host.channels);
    assert.deepEqual(clone(f.host.cList), [10, 20]);
    assert.notEqual(first[10].itemId, first[20].itemId);
    load([
        { name: "Renamed", stream_id: 20 },
        { name: "Renamed", stream_id: 10 },
        { name: "Repeated provider row", stream_id: 20 },
        { name: "Missing provider ID" },
    ]);
    assert.equal(callbacks, 2);
    assert.equal(
        f.requests.length,
        2,
        "valid catalog does not trigger M3U fallback"
    );
    assert.deepEqual(clone(f.host.cList), [20, 10]);
    assert.deepEqual(clone(f.host.cats), { Other: [20, 10] });
    for (const id of [10, 20]) {
        const channel = f.host.channels[id];
        assert.equal(channel.ch_id, id);
        assert.equal(channel.itemId, first[id].itemId);
        assert.equal(channel.url, first[id].url);
        assert.equal(channel.epg, first[id].epg);
        assert.equal(channel.channel_name, "Renamed");
        assert.equal(channel.category.class, 0);
    }
    assert.deepEqual(f.errors, []);
});

test("bestlist real direct/proxy path preserves generic14 playlist contracts", () => {
    for (const row of require("./fixtures/playlist/legacy.json").cases) {
        const f = fixture({
            bestlist_stalkercfg: JSON.stringify({
                m3u: "https://list.test/path",
                pass: "",
                server: "",
                user: "",
            }),
        });
        f.mount("bestlist/stalker");
        let callbacks = 0;
        f.host.getChannelsArray(() => callbacks++);
        assert.equal(f.requests[0].settings.timeout, 15000);
        f.requests[0].reject();
        assert.deepEqual(clone(f.requests[1].settings), {
            data: { url: "@https://list.test/path" },
            dataType: "text",
            method: "post",
            timeout: 15000,
            url: "https://relay.test/m3u/cp.php",
        });
        f.requests[1].resolve(row.input);
        assert.deepEqual(
            catalogSnapshot(f, callbacks),
            require("./helpers/playlist-corrected-expectations.cjs").generic(
                row
            )
        );
    }
});

test("48 captured archive routes and10Only4 stream modes use the actual instance catalog", () => {
    let count = 0;
    for (const row of require("./fixtures/archive/providers.json").fixtures) {
        if (!named.includes(row.provider)) continue;
        const f = namedFixture(row.provider, {
            dune: row.dune,
            settings: { ts_hls: String(row.variant) },
        });
        // Inject a decoded catalog at the core port to cover archive-only edge records.
        f.host.OttPlayCore = Object.assign({}, f.host.OttPlayCore, {
            parseOperatorPlaylist: () => ({
                channels: { c: clone(row.channel) },
                entries: [],
                groupOrder: [],
                groups: {},
                ids: ["c"],
            }),
        });
        vm.runInContext(
            "Date.now = function () { return " + row.now * 1000 + "; };",
            f.host
        );
        const driver = f.mount(row.provider);
        driver.load(() => {});
        settle(f, row.provider);
        assert.equal(
            driver.archive("c", row.start, row.end),
            row.expected,
            row.provider + JSON.stringify(row)
        );
        count++;
    }
    assert.equal(count, 48);
    for (const row of require("./fixtures/operator/media-before-core.json").cases.filter(
        (row) => row.profile === "only4"
    )) {
        const f = namedFixture("only4", {
            settings: { ts_hls: String(row.input.mode || 0) },
        });
        f.host.OttPlayCore = Object.assign({}, f.host.OttPlayCore, {
            parseOperatorPlaylist: () => ({
                channels: {
                    c: {
                        url: "https://localhost/00000000000000/index.m3u8?foo=1",
                        ...row.input.channel,
                    },
                },
                entries: [],
                groupOrder: [],
                groups: {},
                ids: ["c"],
            }),
        });
        const driver = f.mount("only4");
        driver.load(() => {});
        settle(f, "only4");
        assert.equal(driver.stream("c"), row.expected.value);
    }
});

function legacyGuide(id, channelId, channels, response, failed) {
    const calls = [],
        events = [];
    const context = vm.createContext({
        _epgDomen: "http://epg.drm-play.com/",
        $: {
            ajax(request) {
                calls.push({
                    dataType: request.dataType,
                    timeout: request.timeout,
                    url: request.url,
                });
                if (!failed) request.success(response);
                request.complete();
            },
        },
        chanels: channels,
    });
    vm.runInContext(
        declarations("providers/" + id + "/provider.js")
            .filter((row) => ["getEPGurl", "getEPGchanel"].includes(row.name))
            .map((row) => row.text)
            .join("\n"),
        context
    );
    context.getEPGchanel(channelId, (id, data) => events.push([id, data]));
    return clone({ calls, events });
}

test("guide routing/JSON/null/failure exactly match retained source for each protocol", () => {
    for (const id of named)
        for (const variant of [
            "rows",
            "null",
            "empty",
            "failure",
            "no-guide",
        ]) {
            const f = namedFixture(id);
            f.mount(id);
            f.host.getChannelsArray(() => {});
            settle(f, id);
            const channelId = f.host.cList[0];
            assert.notEqual(channelId, undefined);
            // Clear guide metadata through the decoded core boundary, not by mutating driver snapshots.
            if (variant === "no-guide") {
                const channels = clone(f.host.channels);
                channels[channelId].epg = "";
                f.host.OttPlayCore.parseOperatorPlaylist = () => ({
                    channels,
                    entries: [],
                    groupOrder: [],
                    groups: {},
                    ids: [channelId],
                });
                f.host.getChannelsArray(() => {});
                settle(f, id);
            }
            const before = f.requests.length;
            const events = [];
            const response =
                variant === "rows"
                    ? { epg_data: [{ start: 123, title: "News" }] }
                    : variant === "null"
                      ? null
                      : {};
            const expected = legacyGuide(
                id,
                channelId,
                clone(f.host.channels),
                response,
                variant === "failure"
            );
            f.host.getChannelEpg(channelId, (id, data) =>
                events.push([id, data])
            );
            for (const r of f.requests.slice(before))
                if (variant === "failure") r.reject();
                else r.resolve(response);
            assert.deepEqual(
                clone({
                    calls: f.requests.slice(before).map(({ settings: r }) => ({
                        dataType: r.dataType,
                        timeout: r.timeout,
                        url: r.url,
                    })),
                    events,
                }),
                expected,
                id + ":" + variant
            );
        }
});

test("all named stages reject late responses after source switch, reload or credential save", () => {
    for (const id of [...named, "bestlist/stalker"])
        for (const retire of ["replace", "reload", "credentials"]) {
            const stages =
                id === "1ott" ? 4 : id === "bestlist/stalker" ? 3 : 2;
            for (let stage = 0; stage < stages; stage++) {
                const f = namedFixture(id);
                if (id === "bestlist/stalker")
                    f.saved.set(
                        "bestlist_stalkercfg",
                        JSON.stringify({
                            m3u: "",
                            pass: "b",
                            server: "https://xc.test",
                            user: "a",
                        })
                    );
                const driver = f.mount(id);
                let completed = 0;
                driver.load(() => completed++);
                for (let step = 0; step < stage; step++) {
                    if (id === "1ott" && step === 1)
                        f.requests[step].resolve('{"token":"ok"}');
                    else f.requests[step].reject();
                }
                const pending = f.requests[stage];
                assert(pending, id + ":" + stage);
                if (retire === "replace") f.mount("demo");
                else if (retire === "reload") driver.load(() => {});
                else
                    driver.saveCredentials({
                        ...driver.credentials(),
                        password: "new-password",
                        playlist: "https://new.test/list",
                        username: "new-account",
                    });
                assert.equal(
                    pending.aborts,
                    1,
                    id + ":" + stage + ":" + retire
                );
                const count = f.requests.length;
                pending.resolve(
                    stage === 0 && id === "1ott" ? '{"token":"late"}' : playlist
                );
                pending.reject();
                assert.equal(
                    f.requests.length,
                    count,
                    "late failure cannot continue auth/retry"
                );
                assert.equal(completed, 0);
                assert.deepEqual(f.errors, []);
            }
        }
});

test("guide requests are cancelled by catalog replacement and cannot publish old EPG", () => {
    for (const id of named) {
        const f = namedFixture(id);
        const driver = f.mount(id);
        f.host.getChannelsArray(() => {});
        settle(f, id);
        let completed = 0;
        driver.guide(f.host.cList[0], () => completed++);
        const pending = f.requests.at(-1);
        driver.load(() => {});
        assert.equal(pending.aborts, 1);
        pending.resolve({ epg_data: ["old"] });
        pending.reject();
        assert.equal(completed, 0);
    }
});

test("named settings keep prefixes, defaults, validation, cancel and stale-handler guards", () => {
    for (const id of named) {
        const f = namedFixture(id);
        f.saved.set("foreign-history", "retained");
        f.mount(id);
        Object.assign(f.host, {
            popupActions: [f.host.noProvParam, () => {}, () => {}],
            popupArray: ["", "", ""],
            popupDetail: ["", "", ""],
        });
        f.host.duneAddSettings(1);
        assert.equal(f.host.p_pref, prefixes[id]);
        assert.equal(f.saved.get(prefixes[id] + "sShowArchive"), "1");
        if (id === "only4") {
            assert.equal(f.saved.get("o4sShowPikon"), "0");
            assert.equal(f.saved.get("o4ts_hls"), "1");
        }
        f.host.popupActions[1]();
        if (id === "1ott" || id === "only4") {
            f.host.selIndex = 0;
            f.host.listKeyHandler(f.host.keys.ENTER);
        }
        const key =
            id === "1ott"
                ? "id"
                : id === "only4"
                  ? "token"
                  : id === "tvteam"
                    ? "www"
                    : "login";
        const original = f.saved.get(prefixes[id] + key);
        f.host.editvar = "cancelled";
        // Cancelling keyboard means no confirmation callback, so persistence is untouched.
        assert.equal(f.saved.get(prefixes[id] + key), original);
        if (id === "only4" || id === "shara-tv") {
            f.host.setEdit();
            assert.equal(f.saved.get(prefixes[id] + key), original);
            assert.equal(f.errors.length, 1);
        }
        f.host.editvar =
            id === "only4"
                ? "abcdefghij"
                : id === "shara-tv"
                  ? "abcdefgh"
                  : id === "tvteam"
                    ? " https://new.test/channel "
                    : "new-id";
        f.host.setEdit();
        assert.equal(
            f.saved.get(prefixes[id] + key),
            id === "tvteam"
                ? "https://new.test/channel/playlist.m3u8"
                : f.host.editvar
        );
        const late = f.host.setEdit;
        const count = f.writes.length;
        f.mount("demo");
        f.host.editvar = "stale-change";
        late();
        assert.equal(f.writes.length, count);
        assert.equal(f.saved.get("foreign-history"), "retained");
    }
});

test("named settings translate captions, protocol choices, length errors and tv.team help", () => {
    function translate(key, ...args) {
        return (
            "localized:" +
            key.replace(/%(\d+)/g, (_match, index) => args[Number(index) - 1])
        );
    }
    for (const id of named) {
        const f = namedFixture(id);
        f.host._ = translate;
        f.mount(id);
        Object.assign(f.host, {
            popupActions: [f.host.noProvParam, () => {}],
            popupArray: ["", ""],
            popupDetail: ["", ""],
        });
        f.host.duneAddSettings(1);
        assert(
            !/[А-Яа-я]/.test(
                f.host.popupArray.join("") + f.host.popupDetail.join("")
            )
        );
        if (id === "shara-tv") {
            assert(f.host.popupArray[1].endsWith("localized:Username"));
            assert(f.host.popupDetail[1].includes("localized:Enter username"));
            f.host.popupActions[1]();
            assert(f.host.editCaption.startsWith("localized:Enter username"));
            f.host.editvar = "short";
            f.host.setEdit();
            assert.equal(
                f.errors.at(-1),
                "localized:Enter a username (8 characters)."
            );
            f.host.popupActions[2]();
            f.host.editvar = "short";
            f.host.setEdit();
            assert.equal(
                f.errors.at(-1),
                "localized:Enter a password (8 characters)."
            );
        } else if (id === "only4") {
            f.host.popupActions[1]();
            assert.equal(f.host.listArray[0], "localized:IPTV token");
            assert.match(
                f.host.listArray[1],
                /^localized:Stream type: (MPEGTS|HLS\([av]\))$/
            );
            f.host.selIndex = 1;
            f.host.detailListAction();
            assert.equal(
                f.host.listDetail.innerHTML,
                "localized:Select a stream type:<br>MPEGTS, HLS(v), HLS(a)"
            );
            f.host.selIndex = 0;
            f.host.listKeyHandler(f.host.keys.ENTER);
            assert.equal(
                f.host.editCaption,
                "localized:Enter an IPTV token (10 characters)."
            );
            f.host.editvar = "short";
            f.host.setEdit();
            assert.equal(
                f.errors.at(-1),
                "localized:Enter an IPTV token (10 characters)."
            );
        } else if (id === "tvteam") {
            assert(
                f.host.popupDetail[1].startsWith(
                    "localized:Enter the tv.team playlist URL."
                )
            );
            assert(f.host.popupDetail[1].includes("<b>OTTPlayer</b>"));
            assert(f.host.popupDetail[1].includes('"/playlist.m3u8"'));
            f.host.popupActions[1]();
            assert.equal(
                f.host.editCaption,
                "localized:Enter playlist URL tv.team"
            );
        }
    }
});

test("Only4 mode edit preserves owned catalog, cycles both ways and replays live/archive", () => {
    const f = namedFixture("only4");
    const driver = f.mount("only4");
    Object.assign(f.host, {
        popupActions: [f.host.noProvParam, () => {}],
        popupArray: ["", ""],
        popupDetail: ["", ""],
    });
    f.host.duneAddSettings(1);
    f.host.getChannelsArray(() => {});
    settle(f, "only4");
    const id = f.host.cList[0],
        urls = [],
        archives = [];
    f.host.playType = 0;
    f.host.playChannel = () => urls.push(driver.stream(id));
    f.host.playArchive = (value) => archives.push(value);
    f.host.popupActions[1]();
    f.host.selIndex = 1;
    f.host.listKeyHandler(f.host.keys.LEFT);
    assert.equal(f.saved.get("o4ts_hls"), "0");
    assert.equal(urls[0], driver.stream(id));
    assert(urls[0].includes("mpegts"));
    f.host.listKeyHandler(f.host.keys.LEFT);
    assert.equal(f.saved.get("o4ts_hls"), "2");
    f.host.playType = 100;
    f.host.playTime = 20;
    f.host.listKeyHandler(f.host.keys.RIGHT);
    assert.equal(f.saved.get("o4ts_hls"), "0");
    assert.deepEqual(archives, [120]);
    f.host.selIndex = 3;
    f.host.listKeyHandler(f.host.keys.ENTER);
    assert.equal(f.reloads, 1);
});

test("public HTML settings decode credentials and retain tvteam URL bootstrap semantics", () => {
    for (const id of ["shara-tv", "tvteam"]) {
        const f = namedFixture(id, {
            href: "https://player.test/?token=a%2Fb",
        });
        f.mount(id);
        const value = f.host.getProviderParams();
        if (id === "tvteam") {
            assert.equal(value, "https://tv.team/pl/11/a%2Fb/playlist.m3u8");
            assert.equal(f.host.location.href, "https://player.test/");
            f.values["#tvteamwww"] = " https%3A%2F%2Fcustom.test%2Ffile.m3u ";
        } else {
            assert.equal(value, true);
            f.values["#login"] = " new%2Fuser ";
            f.values["#pass"] = " secret12 ";
        }
        assert.equal(f.host.setProviderParams(), true);
        assert.equal(f.host.setProviderParams(), false);
        if (id === "tvteam")
            assert.equal(
                f.saved.get("tvteamwww"),
                "https://custom.test/file.m3u"
            );
        else {
            assert.equal(f.saved.get("shtvlogin"), "new/user");
            assert.equal(f.saved.get("shtvpass"), "secret12");
        }
        const late = f.host.setProviderParams;
        f.mount("demo");
        const writes = f.writes.length;
        assert.equal(late(), false);
        assert.equal(f.writes.length, writes);
    }
});

test("actual loadProv/loadChannels selects all five drivers without scripts or ajax reassignment", () => {
    for (const id of [...named, "bestlist/stalker"]) {
        const initial = Object.fromEntries(
            Object.entries(defaults).map(([key, value]) => [
                prefixes[id] + key,
                value,
            ])
        );
        if (id === "bestlist/stalker")
            initial.bestlist_stalkercfg = JSON.stringify({
                m3u: "",
                pass: "b",
                server: "https://xc.test",
                user: "a",
            });
        const f = integrationFixture(id, initial);
        f.host.loadProv();
        assert.equal(f.host.__ottActiveProviderDriver.id, id);
        assert.equal(f.requests.length, 1);
        if (id === "bestlist/stalker") {
            f.requests[0].reject();
            f.requests[1].resolve(playlist);
        } else settle(f, id);
        assert.equal(f.completed, 1);
        assert(f.host.cList.length > 0);
        f.host.loadChannels();
        const pending = f.requests.at(-1);
        f.host.loadProv("demo");
        assert.equal(pending.aborts, 1);
        const count = f.requests.length;
        pending.reject();
        pending.resolve("late");
        assert.equal(f.requests.length, count);
        assert.equal(f.completed, 2);
        assert.deepEqual(f.scripts, []);
        assert.equal(f.ajaxWrites, 0);
        assert.equal(f.host.getMediaArray, null);
    }
});

test("failed reload cannot resurrect old catalog and transport teardown reentry keeps latest load", () => {
    for (const id of [...named, "bestlist/stalker"]) {
        const f = namedFixture(id);
        if (id === "bestlist/stalker")
            f.saved.set(
                "bestlist_stalkercfg",
                JSON.stringify({
                    m3u: "https://list.test/live",
                    pass: "",
                    server: "",
                    user: "",
                })
            );
        const driver = f.mount(id);
        f.host.getChannelsArray(() => {});
        settle(f, id);
        assert(f.host.cList.length);
        f.host.getChannelsArray(() => {});
        for (
            let index = f.requests.length - 1;
            index < f.requests.length;
            index++
        )
            f.requests[index].reject();
        assert.deepEqual(Array.from(f.host.cList), []);
        const previousErrors = f.errors.length;
        driver.load(() => {});
        const pending = f.requests.at(-1);
        const abort = pending.abort.bind(pending);
        let nested = 0,
            result;
        pending.abort = () => {
            abort();
            driver.load((catalog) => {
                nested++;
                result = catalog;
            });
            settle(f, id);
        };
        const before = f.requests.length;
        driver.load(() => {
            throw new Error("superseded load completed");
        });
        assert.equal(nested, 1);
        assert.equal(f.requests.length, before + (id === "1ott" ? 2 : 1));
        assert.equal(f.errors.length, previousErrors);
        assert(result.ids.length > 0);
        assert(driver.stream(result.ids[0]));
    }
});

test("Only4 invalid token editor reopens after keyboard close and retires its timer on source change", () => {
    const f = namedFixture("only4");
    f.mount("only4");
    Object.assign(f.host, {
        popupActions: [f.host.noProvParam, () => {}],
        popupArray: ["", ""],
        popupDetail: ["", ""],
    });
    f.host.duneAddSettings(1);
    f.host.popupActions[1]();
    f.host.selIndex = 0;
    f.host.listKeyHandler(f.host.keys.ENTER);
    const before = f.edits.length;
    f.host.editvar = "bad";
    f.host.setEdit();
    assert.equal(
        f.edits.length,
        before,
        "reopen must wait for keyboard completion"
    );
    assert.equal(f.timers.size, 1);
    const [timer, reopen] = Array.from(f.timers.entries())[0];
    f.timers.delete(timer);
    reopen();
    assert.equal(f.edits.length, before + 1);
    f.host.setEdit();
    assert.equal(f.timers.size, 1);
    const stale = Array.from(f.timers.values())[0];
    f.mount("demo");
    assert.equal(f.timers.size, 0);
    stale();
    assert.equal(f.edits.length, before + 1);
});

test("multi-key credential writes exclude same-instance and replacement readers until rollback", () => {
    for (const replace of [false, true]) {
        const f = namedFixture("1ott"),
            d = f.mount("1ott");
        let entered = false,
            next = d;
        const set = f.host.stbSetItem;
        f.host.stbSetItem = (key, value) => {
            set(key, value);
            if (!entered && key === "1ottid" && value === "new-user") {
                entered = true;
                if (replace) next = f.mount("1ott");
                next.load(() => {});
                assert.equal(
                    f.requests.length,
                    0,
                    "reader waits for the complete batch"
                );
            }
        };
        assert.equal(
            d.saveCredentials({
                password: "new-pin",
                server: "",
                username: "new-user",
            }),
            false
        );
        assert.equal(f.requests.length, 1);
        assert(f.requests[0].settings.url.includes("/fixture-id/fixture-pin"));
        assert.equal(next.credentials().username, "fixture-id");
        assert.equal(next.credentials().password, "fixture-pin");
        assert.equal(d.load.length, 1);
        assert.equal(d.saveCredentials.length, 1);
    }
});

test("failed rollback is observable and never starts a queued mixed-account request", () => {
    const f = namedFixture("1ott"),
        d = f.mount("1ott");
    let entered = false;
    const set = f.host.stbSetItem;
    f.host.stbSetItem = (key, value) => {
        if (entered && key === "1ottid" && value === "fixture-id")
            throw Error("rollback rejected");
        set(key, value);
        if (!entered && key === "1ottid") {
            entered = true;
            d.load(() => {});
        }
    };
    assert.throws(() =>
        d.saveCredentials({
            password: "new-pin",
            server: "",
            username: "new-user",
        })
    );
    assert.equal(f.requests.length, 0);
});

test("credential reads and rejected writes cannot partially commit a named account", () => {
    for (const mode of ["read", "reject", "throw"]) {
        const f = namedFixture("1ott"),
            d = f.mount("1ott");
        let entered = false;
        const get = f.host.stbGetItem,
            set = f.host.stbSetItem;
        if (mode === "read")
            f.host.stbGetItem = (key) => {
                const value = get(key);
                if (!entered && key === "1ottpin") {
                    entered = true;
                    d.load(() => {});
                }
                return value;
            };
        else
            f.host.stbSetItem = (key, value) => {
                if (key === "1ottpin" && value === "new-pin") {
                    if (mode === "throw") throw Error("write unavailable");
                    return;
                }
                set(key, value);
            };
        const save = () =>
            d.saveCredentials({
                password: "new-pin",
                server: "",
                username: "new-user",
            });
        if (mode === "read") assert.equal(save(), false);
        else assert.throws(save);
        assert.equal(f.saved.get("1ottid"), "fixture-id");
        assert.equal(f.saved.get("1ottpin"), "fixture-pin");
        if (mode === "read") assert.equal(f.requests.length, 1);
        else assert.equal(f.requests.length, 0);
    }
});

test("Only4 mode changes preserve the active catalog request and named decode reentry is revoked", () => {
    const f = namedFixture("only4"),
        d = f.mount("only4");
    let completed = 0;
    d.load(() => completed++);
    assert.equal(d.saveCredentials({ ...d.credentials(), mode: 2 }), true);
    f.requests[0].resolve(playlist);
    assert.equal(completed, 1);
    assert(d.stream(123));
    assert.equal(d.credentials().mode, 2);
    const n = namedFixture("tvteam"),
        nd = n.mount("tvteam");
    let oldCompleted = 0;
    nd.load(() => oldCompleted++);
    const parse = n.host.OttPlayCore.parseOperatorPlaylist;
    let decoded = 0;
    n.host.OttPlayCore.parseOperatorPlaylist = (...args) => {
        const result = parse(...args);
        decoded++;
        nd.saveCredentials({
            ...nd.credentials(),
            playlist: "https://tv.team/pl/11/new/playlist.m3u8",
        });
        return result;
    };
    n.requests[0].resolve(
        "#EXTM3U\n#EXTINF:-1,\nhttps://stream.test/123/index.m3u8\n"
    );
    assert.equal(decoded, 1);
    assert.equal(oldCompleted, 0);
    assert.equal(nd.stream(123), "");
});

console.log("PASS independent named providers: " + groups + " groups");
