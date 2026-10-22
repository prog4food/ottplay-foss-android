"use strict";
const assert = require("node:assert/strict");
const vm = require("node:vm");
const {
    fixture,
    integrationFixture,
} = require("./helpers/provider-driver-fixture.cjs");
const { declarations } = require("./helpers/playlist-fixture.cjs");
const clone = (value) => JSON.parse(JSON.stringify(value));
const ids = ["itv", "ottclub", "shura"];
const prefixes = { itv: "itv", ottclub: "", shura: "sh" };
const base = "http://api.01cdn.wf/";
const categories =
    '#EXTM3U\n#EXTINF:-1 tvg-name="one" group-title="News",One\nhttp://v.test/token/one/a.ts\n#EXTINF:-1 tvg-name="two" group-title="Other",Two\nhttp://v.test/token/two/a.ts';
function settings(id, input = {}) {
    return Object.fromEntries(
        Object.entries({
            key: id === "shura" ? "12345678" : "1234567890",
            mpeg: "0",
            ottkey: "12345678",
            ottwww: "operator.test",
            server: "2",
            ...input,
        }).map(([key, value]) => [prefixes[id] + key, value])
    );
}
function context(id, input = {}) {
    const f = fixture(settings(id, input.settings));
    const host = f.host;
    const events = [],
        forms = {},
        panels = {},
        timers = new Map();
    let timerId = 0,
        restarts = 0;
    Object.assign(host, {
        _: (key, ...args) =>
            key.replace(/%(\d+)/g, (_match, index) => args[Number(index) - 1]),
        clearTimeout: (id) => timers.delete(id),
        epg: { retained: [{ name: "retained" }] },
        infoBox: (value) => {
            f.errors.push(value);
            events.push(["info", value]);
        },
        navigator: { userAgent: input.userAgent || "browser" },
        playArchive: (...args) => events.push(["archive", ...args]),
        playChannel: (...args) => events.push(["live", ...args]),
        popupList: (...args) => events.push(["popup", ...args]),
        restart: () => restarts++,
        setTimeout: (callback) => {
            const id = ++timerId;
            timers.set(id, callback);
            return id;
        },
        sNextCount: -1,
    });
    const query = (selector) => {
        const value = panels[selector] || (panels[selector] = {});
        const chain = {
            append(text) {
                events.push(["append", text]);
                return chain;
            },
            hide() {
                value.visible = false;
                return chain;
            },
            html(text) {
                if (arguments.length) value.html = text;
                return chain;
            },
            show() {
                value.visible = true;
                return chain;
            },
            val(text) {
                if (arguments.length) forms[selector] = text;
                return forms[selector];
            },
        };
        return chain;
    };
    query.ajax = (options) => {
        const request = f.ajax(options);
        const fail = request.fail;
        request.fail = function (callback) {
            request.reject = (...args) => callback(...args);
            return fail.call(request, callback);
        };
        return request;
    };
    host.$ = query;
    host.browserName = () => (input.dune ? "dune" : "browser");
    return {
        ...f,
        events,
        forms,
        panels,
        get restarts() {
            return restarts;
        },
        timers,
    };
}
function requestView(requests) {
    return requests.map(({ settings: r }) => ({
        dataType: r.dataType,
        timeout: r.timeout,
        url: r.url,
    }));
}
function catalogView(f, callbacks, failure = null) {
    return clone({
        callbacks,
        calls: requestView(f.requests),
        channels: f.host.channels,
        epg: f.host.epg,
        errors: f.errors,
        failure,
        groupOrder: f.host.catsArray,
        groups: f.host.cats,
        ids: f.host.cList,
    });
}
function payload(id) {
    if (id === "itv")
        return {
            channels: [
                {
                    cat_name: "News",
                    ch_id: "one",
                    channel_name: "One",
                    rec_time: 24,
                    server_cdn: "cdn.test",
                    token: "t",
                },
            ],
        };
    if (id === "ottclub")
        return '{"one":{"ch_id":"one","name":"One","category":"News","rec":true,"img":"one.png"}}';
    return [
        { archive: 24, id: "one", name: "One" },
        { archive: 0, id: "two", name: "Two" },
    ];
}
function finishLoad(f, id, data = payload(id), start = 0) {
    f.requests[start].resolve(data);
    if (id === "shura") f.requests[start + 1].resolve(categories);
}
let passed = 0;
function test(name, run) {
    run();
    passed++;
    console.log("PASS catalog drivers: " + name);
}

test("21 captured catalog/seed EPG contracts with two intentional malformed-startup fixes", () => {
    for (const row of require("./fixtures/operator/catalogs-before-core.json")
        .cases) {
        const f = context(row.provider, row.input);
        f.mount(row.provider);
        let callbacks = 0,
            failure = null;
        try {
            f.host.getChannelsArray(() => callbacks++);
            if (f.requests[0]) {
                if (row.input.networkFailed)
                    f.requests[0].reject({}, "fixture", "failure");
                else f.requests[0].resolve(row.input.data);
            }
        } catch (error) {
            failure = { message: error.message, name: error.name };
        }
        const expected = clone(row.expected);
        expected.errors = expected.errors.map((message) => {
            if (message.includes("10-12"))
                return "Enter an application access key (10–12 characters).";
            if (
                message ===
                "Для доступа необходимо ввести ключ и адрес плейлиста!"
            )
                return "Access key is required!<br>Enter playlist URL";
            if (message.startsWith("Не удалось"))
                return "Failed to load channel list!";
            return message;
        });
        // Intentional runtime repair: the old async decoder threw and never completed startup.
        if (expected.failure)
            Object.assign(expected, {
                callbacks: 1,
                channels: {},
                errors: ["Failed to load channel list!"],
                failure: null,
                groupOrder: [],
                groups: {},
                ids: [],
            });
        for (const call of expected.calls)
            call.url = call.url.replace("http://api.fixture/", base);
        assert.deepEqual(
            catalogView(f, callbacks, failure),
            expected,
            row.provider + ": " + row.name
        );
    }
});

test("Shura12 captured bootstrap contracts including account failure/category fallback", () => {
    const rows =
        require("./fixtures/operator/profiles-before-core.json").cases.filter(
            (row) => row.profile === "shura"
        );
    assert.equal(rows.length, 12);
    for (const row of rows) {
        const f = context("shura", row.input);
        f.host.location = {
            href: row.input.href || "https://player.test/index.html",
        };
        f.mount("shura");
        let callbacks = 0,
            failure = null;
        try {
            f.host.getChannelsArray(() => callbacks++);
            for (let index = 0; index < f.requests.length; index++) {
                const request = f.requests[index];
                if (row.input.failAll || (row.input.failFirst && index === 0))
                    request.reject({}, "fixture", "failed");
                else
                    request.resolve(
                        request.settings.dataType === "jsonp"
                            ? row.input.channels === undefined
                                ? []
                                : row.input.channels
                            : "#EXTM3U\n"
                    );
            }
        } catch (error) {
            failure = { message: error.message, name: error.name };
        }
        const actual = clone({
            callbacks,
            calls: f.requests.map(({ settings: r }) => ({
                data: r.data || null,
                dataType: r.dataType,
                method: r.method || "GET",
                timeout: r.timeout,
                url: r.url,
            })),
            channels: f.host.channels,
            events: f.events.map((row) =>
                row[0] === "popup" ? ["settings"] : row
            ),
            failure,
            groupOrder: f.host.catsArray,
            groups: f.host.cats,
            href: f.host.location.href,
            ids: f.host.cList,
            writes: [],
        });
        const expected = clone(row.expected);
        for (const event of expected.events)
            if (
                event[0] === "info" &&
                event[1] === "Для доступа необходимо ввести ключ!"
            )
                event[1] = "Access key is required!";
        assert.deepEqual(actual, expected, JSON.stringify(row.input));
    }
});

test("23 captured Shura category parsers bind to independently owned account catalog", () => {
    for (const row of require("./fixtures/playlist/operators.json").cases) {
        const f = context("shura");
        // Captured categories use preloaded minimal account records one/two.
        const Original = f.host.OttPlayCore.OperatorCatalogClient;
        f.host.OttPlayCore = Object.assign({}, f.host.OttPlayCore, {
            OperatorCatalogClient: function (id) {
                if (id !== "shura") return new Original(id);
                return {
                    accept() {},
                    result: () => ({
                        channels: {
                            one: { channel_name: "One" },
                            two: { channel_name: "Two" },
                        },
                        groupOrder: [],
                        groups: {},
                        ids: ["one", "two"],
                    }),
                };
            },
        });
        f.mount("shura");
        let callbacks = 0;
        f.host.getChannelsArray(() => callbacks++);
        f.requests[0].resolve([]);
        f.requests[1].resolve(row.input);
        assert.deepEqual(
            clone({
                callbacks,
                channels: f.host.channels,
                errors: f.errors,
                groupOrder: f.host.catsArray,
                groups: f.host.cats,
                ids: f.host.cList,
            }),
            row.operators.shura
        );
    }
});

function decodedCatalog(f, channels) {
    const core = f.host.OttPlayCore;
    f.host.OttPlayCore = Object.assign({}, core, {
        OperatorCatalogClient: function () {
            return {
                accept() {},
                result: () => ({
                    channels: clone(channels),
                    epg: {},
                    groupOrder: [],
                    groups: {},
                    ids: Object.keys(channels),
                }),
            };
        },
    });
}

test("61 captured live/full/current guide contracts with three intentional malformed-guide fixes", () => {
    let compared = 0;
    for (const row of require("./fixtures/operator/media-before-core.json").cases.filter(
        (row) => ids.includes(row.profile)
    )) {
        const f = context(row.profile, {
            settings: {
                key: row.profile === "shura" ? "sh-key" : "1234567890",
                mpeg: String(row.input.mode || 0),
                ottkey: "club-key",
                ottwww: "club.test",
                server: "2",
            },
        });
        const channelId = row.input.id === undefined ? "c" : row.input.id;
        decodedCatalog(f, {
            [channelId]: {
                rec: row.input.rec === undefined ? 0 : row.input.rec,
                server: "af.test",
                server_cdn: "itv.test",
                token: "token",
                url: "https://localhost/00000000000000/index.m3u8?foo=1",
                ...row.input.channel,
            },
        });
        const driver = f.mount(row.profile);
        driver.load(() => {});
        finishLoad(f, row.profile);
        f.host.sNextCount = row.input.next === undefined ? -1 : row.input.next;
        const start = f.requests.length,
            events = [];
        let value,
            failure = null;
        if (row.profile === "ottclub" && row.input.current) {
            assert.equal(
                driver.guideCurrent,
                undefined,
                "OTTCLUB relies on seeded/cache/full guide, no current endpoint"
            );
            assert(row.expected.failure);
            compared++;
            continue;
        }
        try {
            if (row.input.method !== "epg") value = driver.stream(channelId);
            else {
                driver[row.input.current ? "guideCurrent" : "guide"](
                    channelId,
                    (value) => events.push([channelId, value])
                );
                for (let index = start; index < f.requests.length; index++) {
                    const response = row.input.responses
                        ? row.input.responses[index - start]
                        : null;
                    if (response === undefined) f.requests[index].reject();
                    else f.requests[index].resolve(clone(response));
                }
            }
        } catch (error) {
            failure = { message: error.message, name: error.name };
        }
        const expected = clone(row.expected);
        // Intentional runtime repair: malformed Shura guide data completes once with no guide.
        if (row.profile === "shura" && expected.failure) {
            expected.failure = null;
            expected.events = [[channelId, null]];
        }
        for (const call of expected.calls)
            call.url = call.url.replace("https://itv.test/", base);
        assert.deepEqual(
            clone({
                calls: requestView(f.requests.slice(start)),
                events,
                failure,
                value,
            }),
            expected,
            row.profile + ":" + JSON.stringify(row.input)
        );
        compared++;
    }
    assert.equal(compared, 61);
});

test("40 captured archive URLs keep provider modes, clock and Dune boundaries", () => {
    let compared = 0;
    for (const row of require("./fixtures/archive/providers.json").fixtures.filter(
        (row) => ids.includes(row.provider)
    )) {
        const f = context(row.provider, {
            dune: row.dune,
            settings: {
                key: row.provider === "shura" ? "shura-key" : "1234567890",
                mpeg: String(row.variant),
                ottkey: "ott-key",
                ottwww: "club.test",
                server: "2",
            },
        });
        decodedCatalog(f, { 42: row.channel });
        // Archive captures stubbed getChannelUrl; preserve that boundary while testing the real instance.
        if (row.provider !== "itv")
            f.host.OttPlayCore.operatorLiveUrl = () => row.channel.url;
        vm.runInContext(
            "Date.now = function () { return " + row.now * 1000 + "; };",
            f.host
        );
        const driver = f.mount(row.provider);
        driver.load(() => {});
        finishLoad(f, row.provider);
        assert.equal(
            driver.archive("42", row.start, row.end),
            row.expected,
            row.provider + ":" + JSON.stringify(row)
        );
        compared++;
    }
    assert.equal(compared, 40);
});

test("catalog, full/current guide and Shura retry stages retire on source/catalog/config replacement", () => {
    for (const id of ids)
        for (const retire of ["source", "catalog", "credentials"]) {
            for (let stage = 0; stage < (id === "shura" ? 3 : 1); stage++) {
                const f = context(id);
                const driver = f.mount(id);
                let completed = 0;
                driver.load(() => completed++);
                if (stage > 0) f.requests[0].resolve(payload(id));
                if (stage > 1) f.requests[1].reject();
                const pending = f.requests.at(-1);
                if (retire === "source") f.mount("demo");
                else if (retire === "catalog") driver.load(() => {});
                else
                    driver.saveCredentials({
                        ...driver.credentials(),
                        server: "new.test",
                        username: "replaced-key",
                    });
                assert.equal(
                    pending.aborts,
                    1,
                    id + ":" + retire + ":" + stage
                );
                const count = f.requests.length;
                pending.reject();
                pending.resolve(stage ? categories : payload(id));
                assert.equal(
                    f.requests.length,
                    count,
                    "retired response cannot continue phases"
                );
                assert.equal(completed, 0);
            }
            for (const current of [false, true]) {
                if (current && id === "ottclub") continue;
                const stages = id === "shura" && !current ? 2 : 1;
                for (let stage = 0; stage < stages; stage++) {
                    const f = context(id),
                        driver = f.mount(id);
                    driver.load(() => {});
                    finishLoad(f, id);
                    let completed = 0;
                    driver[current ? "guideCurrent" : "guide"](
                        "one",
                        () => completed++
                    );
                    if (stage) f.requests.at(-1).resolve([]);
                    const pending = f.requests.at(-1);
                    if (retire === "source") f.mount("demo");
                    else if (retire === "catalog") driver.load(() => {});
                    else
                        driver.saveCredentials({
                            ...driver.credentials(),
                            server: "new.test",
                            username: "new-key",
                        });
                    assert.equal(pending.aborts, 1);
                    const count = f.requests.length;
                    pending.resolve([]);
                    pending.reject();
                    assert.equal(f.requests.length, count);
                    assert.equal(completed, 0);
                }
            }
        }
});

test("catalog and seed guide snapshots cannot mutate private playback or route state", () => {
    for (const id of ids) {
        const f = context(id),
            driver = f.mount(id);
        f.host.getChannelsArray(() => {});
        finishLoad(f, id);
        const url = driver.stream("one"),
            archive = driver.archive("one", 1769990000, 1769991000),
            logo = driver.logo("one");
        f.host.channels.one.server_cdn = "mutated.test";
        f.host.channels.one.token = "mutated";
        f.host.channels.one.rec = 0;
        f.host.channels.one.img = "mutated.png";
        f.host.channels.one.category.name = "Mutated";
        if (id === "ottclub") {
            assert.notEqual(f.host.epg.one[0], f.host.channels.one);
            f.host.epg.one[0].img = "poison.png";
            f.host.epg.one[0].category.name = "Poison";
            assert.deepEqual(clone(f.host.epg.retained), [
                { name: "retained" },
            ]);
        }
        assert.equal(driver.stream("one"), url);
        assert.equal(driver.archive("one", 1769990000, 1769991000), archive);
        assert.equal(driver.logo("one"), logo);
        if (id === "shura") {
            driver.guide("one", () => {});
            f.requests.at(-1).resolve([]);
            assert(
                f.requests.at(-1).settings.url.endsWith("archive.jsonp"),
                "guide uses owned archive hours"
            );
        }
        f.mount("demo");
        assert.equal(driver.stream("one"), "");
        assert.equal(driver.archive("one", 1, 2), "");
        assert.equal(driver.logo("one"), "");
    }
});

test("route-only credentials retain selected public channel while invalidating old guide requests", () => {
    for (const id of ["ottclub", "shura"]) {
        const f = context(id),
            driver = f.mount(id);
        driver.load(() => {});
        finishLoad(f, id);
        let completed = 0;
        driver.guide("one", () => completed++);
        const old = f.requests.at(-1);
        const next = { ...driver.credentials(), username: "new-account-key" };
        if (id === "shura") next.server = "5";
        driver.saveCredentials(next);
        assert.equal(old.aborts, 1);
        assert(driver.stream("one").includes("new-account-key"));
        if (id === "shura")
            assert(driver.stream("one").startsWith("http://s5."));
        driver.guide("one", () => completed++);
        const afterSave = f.requests.at(-1);
        driver.load(() => {});
        assert.equal(
            afterSave.aborts,
            1,
            "fresh guide after settings save has catalog lifetime"
        );
        old.resolve({});
        afterSave.resolve({});
        assert.equal(completed, 0);
    }
});

function addSettings(f) {
    Object.assign(f.host, {
        popupActions: [f.host.noProvParam, () => {}],
        popupArray: ["", ""],
        popupDetail: ["", ""],
    });
    f.host.duneAddSettings(1);
}

test("settings defaults, prefix, edit validation/cancel and stream replay preserve behavior", () => {
    for (const id of ids) {
        const f = context(id, { userAgent: "SmartTV Tizen" }),
            driver = f.mount(id);
        f.saved.delete(prefixes[id] + "mpeg");
        f.saved.set("foreign-marker", "keep");
        addSettings(f);
        assert.equal(f.host.p_pref, prefixes[id]);
        if (id !== "ottclub")
            assert.equal(f.saved.get(prefixes[id] + "sShowArchive"), "1");
        if (id === "itv") assert.equal(f.saved.get("itvmpeg"), "2");
        driver.load(() => {});
        finishLoad(f, id);
        const keyAction = f.host.popupActions[id === "itv" ? 1 : 2];
        keyAction();
        const original = f.saved.get(
            prefixes[id] + (id === "ottclub" ? "ottkey" : "key")
        );
        f.host.editvar = "cancelled";
        assert.equal(
            f.saved.get(prefixes[id] + (id === "ottclub" ? "ottkey" : "key")),
            original
        );
        if (id !== "ottclub") {
            f.host.editvar = "bad";
            f.host.setEdit();
            assert.equal(f.errors.length, 1);
            assert.equal(f.saved.get(prefixes[id] + "key"), original);
            if (id === "shura") assert.equal(f.timers.size, 1);
        }
        f.host.editvar = "abcdefghij";
        f.host.setEdit();
        assert.equal(
            f.saved.get(prefixes[id] + (id === "ottclub" ? "ottkey" : "key")),
            "abcdefghij"
        );
        if (id === "itv") assert.equal(f.restarts, 1);
        else {
            assert.equal(f.events.at(-1)[0], "live");
            assert(driver.stream("one").includes("abcdefghij"));
        }
        const stale = f.host.setEdit;
        f.mount("demo");
        f.host.editvar = "old-owner";
        stale();
        assert.equal(
            f.saved.get(prefixes[id] + (id === "ottclub" ? "ottkey" : "key")),
            "abcdefghij"
        );
        assert.equal(f.saved.get("foreign-marker"), "keep");
        assert.equal(f.timers.size, 0);
    }
});

test("ITV mode preserves explicit preference, cycles and replays live/archive; Shura server edits replay", () => {
    for (const id of ["itv", "shura"]) {
        const f = context(id, { userAgent: "Tizen" }),
            driver = f.mount(id);
        addSettings(f);
        assert.equal(f.saved.get(prefixes[id] + "mpeg"), "0");
        driver.load(() => {});
        finishLoad(f, id);
        f.host.playType = 0;
        const action = f.host.popupActions[id === "itv" ? 2 : 3];
        action();
        assert.equal(f.saved.get(prefixes[id] + "mpeg"), "1");
        assert.equal(f.events.at(-1)[0], "live");
        f.host.playType = 100;
        f.host.playTime = 25;
        action();
        assert.deepEqual(f.events.at(-1), ["archive", 125]);
        assert.equal(
            f.saved.get(prefixes[id] + "mpeg"),
            id === "itv" ? "2" : "0"
        );
        if (id === "shura") {
            f.host.popupActions[1]();
            f.host.editvar = "5";
            f.host.setEdit();
            assert(driver.stream("one").startsWith("http://s5."));
        }
    }
    const f = context("ottclub");
    f.mount("ottclub");
    addSettings(f);
    f.host.popupActions[1]();
    f.host.setEdit();
    assert.equal(f.restarts, 0);
    f.host.editvar = "new.test";
    f.host.setEdit();
    assert.equal(f.restarts, 1);
    assert.equal(f.saved.get("ottwww"), "new.test");
});

test("ITV HTML parameter codec decodes and detects changes; provider switch revokes old editor", () => {
    const f = context("itv");
    f.mount("itv");
    assert.equal(f.host.getProviderParams(), "1234567890");
    f.forms["#itvkey"] = " abc%2F123456 ";
    assert.equal(f.host.setProviderParams(), true);
    assert.equal(f.saved.get("itvkey"), "abc/123456");
    assert.equal(f.host.setProviderParams(), false);
    const stale = f.host.setProviderParams;
    f.mount("demo");
    f.forms["#itvkey"] = "XXXXXXXXXX";
    assert.equal(stale(), false);
    assert.equal(f.saved.get("itvkey"), "abc/123456");
});

test("ITV subscription renders data/errors, escapes service text, and tolerates absent payload", () => {
    const f = context("itv");
    f.mount("itv");
    addSettings(f);
    const open = f.host.popupActions[3];
    open();
    assert.equal(f.requests[0].settings.url, base + "data/1234567890");
    assert.equal(f.requests[0].settings.timeout, 30000);
    f.requests[0].resolve({
        package_info: [{ name: "Basic" }, { name: "Sport" }],
        user_info: { cash: 12.5, login: "viewer", pay_system: 1 },
    });
    assert.equal(
        f.panels["#listAbout"].html,
        "Subscription information:<br/><br/>Login: viewer<br/>Balance, $: 12.5<br/>Payment method: Prepaid<br/>Packages: Basic, Sport"
    );
    open();
    f.requests.at(-1).resolve({
        package_info: [{ name: "<script>bad</script>" }],
        user_info: { cash: "<&>", login: '<img src=x onerror="bad">' },
    });
    assert(!f.panels["#listAbout"].html.includes("<img"));
    assert(
        f.panels["#listAbout"].html.includes("&lt;script&gt;bad&lt;/script&gt;")
    );
    open();
    f.requests
        .at(-1)
        .reject(
            { responseText: "<script>bad</script>" },
            "<status>",
            "<error>"
        );
    assert(!f.panels["#listAbout"].html.includes("<script>"));
    assert.equal(f.panels["#listAbout"].html, "Failed to load!");
    for (const value of [undefined, null]) {
        open();
        assert.doesNotThrow(() => f.requests.at(-1).resolve(value));
    }
});

test("catalog settings, validation and subscription use the current language", () => {
    for (const id of ids) {
        const f = context(id);
        f.mount(id);
        addSettings(f);
        f.host._ = (key, ...args) =>
            "localized:" +
            key.replace(/%(\d+)/g, (_match, index) => args[Number(index) - 1]);
        const editKey = f.host.popupActions[id === "itv" ? 1 : 2];
        editKey();
        assert(f.host.editCaption.startsWith("localized:Edit access key"));
        assert(editKey.menuDetail().startsWith("localized:"));
        if (id === "itv") {
            assert(f.host.editCaption.includes("10–12"));
            f.host.editvar = "short";
            f.host.setEdit();
            assert.equal(
                f.errors.at(-1),
                "localized:Enter an application access key (10–12 characters)."
            );
            f.host.popupActions[3]();
            assert.equal(
                f.panels["#listAbout"].html,
                "localized:Loading. Please wait..."
            );
            f.requests.at(-1).resolve({
                package_info: [{ name: "Provider package" }],
                user_info: { cash: 1, login: "viewer", pay_system: 2 },
            });
            assert(f.panels["#listAbout"].html.includes("localized:Postpaid"));
            assert(
                f.panels["#listAbout"].html.includes(
                    "localized:Packages: Provider package"
                )
            );
        } else {
            const address = f.host.popupActions[1];
            address();
            assert.equal(
                f.host.editCaption,
                id === "shura"
                    ? "localized:Enter server number (1, 2, 3, 5)."
                    : "localized:Enter playlist URL"
            );
            assert(address.menuDetail().startsWith("localized:"));
        }
        if (id !== "ottclub") {
            const mode = f.host.popupActions[id === "itv" ? 2 : 3];
            assert(mode.menuTitle().startsWith("localized:Stream type: "));
            assert(
                mode
                    .menuDetail()
                    .startsWith("localized:Select a stream type:<br>")
            );
        }
    }
});

test("subscription closing/reopening/source change and foreign About view reject late callbacks", () => {
    for (const retire of ["close", "reopen", "source", "foreign"]) {
        const f = context("itv");
        f.mount("itv");
        addSettings(f);
        const open = f.host.popupActions[3];
        open();
        const oldHandler = f.host.aboutKeyHandler,
            old = f.requests.at(-1);
        if (retire === "close") f.host.aboutKeyHandler();
        if (retire === "reopen") open();
        if (retire === "source") f.mount("demo");
        if (retire === "foreign") {
            f.host.aboutKeyHandler = () => true;
            f.panels["#listAbout"].html = "Different view";
        }
        const before = { ...f.panels["#listAbout"] };
        if (retire !== "foreign") assert.equal(old.aborts, 1);
        if (retire === "reopen") {
            assert.equal(oldHandler(), false);
            assert.equal(f.panels["#listAbout"].visible, true);
        }
        old.resolve({ package_info: [], user_info: { login: "stale" } });
        old.reject({}, "stale", "stale");
        assert.deepEqual(f.panels["#listAbout"], before, retire);
    }
});

test("unknown/failed-reload stream/archive returns empty and cleanup reentry cannot write retired credentials", () => {
    for (const id of ids) {
        const f = context(id),
            driver = f.mount(id);
        assert.equal(driver.stream("missing"), "");
        assert.equal(driver.archive("missing", 1, 2), "");
        driver.load(() => {});
        finishLoad(f, id);
        driver.load(() => {});
        let start = f.requests.length - 1;
        for (; start < f.requests.length; start++) f.requests[start].reject();
        assert.equal(driver.stream("one"), "");
        assert.equal(driver.archive("one", 1, 2), "");
        driver.load(() => {});
        const request = f.requests.at(-1),
            abort = request.abort.bind(request);
        request.abort = () => {
            abort();
            f.mount("demo");
        };
        const snapshot = Array.from(f.saved.entries());
        driver.saveCredentials({
            ...driver.credentials(),
            server: "new-server",
            username: "new-key",
        });
        assert.deepEqual(
            Array.from(f.saved.entries()),
            snapshot,
            "retired save must not persist"
        );
    }
});

test("settings save reentry cannot restart, replay, redraw or alert a replacement provider", () => {
    for (const id of ids) {
        const f = context(id),
            driver = f.mount(id);
        addSettings(f);
        driver.load(() => {});
        const pending = f.requests[0],
            abort = pending.abort.bind(pending);
        pending.abort = () => {
            abort();
            f.mount("demo");
        };
        f.host.popupActions[id === "itv" ? 1 : 2]();
        const before = Array.from(f.saved.entries());
        f.host.editvar = "changed-key";
        f.host.setEdit();
        assert.equal(f.host.__ottActiveProviderDriver.id, "demo");
        assert.deepEqual(Array.from(f.saved.entries()), before);
        assert.equal(f.restarts, 0, id + ": retired editor cannot restart");
        assert.equal(
            f.events.filter((event) => ["live", "archive"].includes(event[0]))
                .length,
            0
        );
    }
    for (const id of ["itv", "shura"]) {
        const f = context(id);
        f.mount(id);
        addSettings(f);
        const set = f.host.stbSetItem;
        f.host.stbSetItem = (key, value) => {
            set(key, value);
            if (key === prefixes[id] + "mpeg") f.mount("demo");
        };
        const before = Array.from(f.host.popupArray);
        f.host.popupActions[id === "itv" ? 2 : 3]();
        assert.equal(f.host.__ottActiveProviderDriver.id, "demo");
        assert.deepEqual(Array.from(f.host.popupArray), before);
        assert.deepEqual(f.events, []);
    }
    const f = context("itv"),
        driver = f.mount("itv");
    driver.load(() => {});
    const pending = f.requests[0],
        abort = pending.abort.bind(pending);
    pending.abort = () => {
        abort();
        f.mount("demo");
    };
    f.forms["#itvkey"] = "bad";
    assert.equal(f.host.setProviderParams(), false);
    assert.deepEqual(f.errors, []);
});

test("actual loadProv/loadChannels uses all catalog drivers without legacy scripts or AJAX patches", () => {
    for (const id of ids) {
        const f = integrationFixture(id, settings(id));
        f.host.navigator = { userAgent: "browser" };
        f.host.epg = {};
        f.host.infoBox = () => {};
        f.host.loadProv();
        assert.equal(f.host.__ottActiveProviderDriver.id, id);
        finishLoad(f, id);
        assert.equal(f.completed, 1);
        assert(f.host.cList.length > 0);
        assert(f.host.getChannelUrl(f.host.cList[0]));
        if (id !== "ottclub")
            assert.equal(typeof f.host.getCurrentChannelEpg, "function");
        else assert(f.host.epg.one.length > 0);
        f.host.loadChannels();
        const pending = f.requests.at(-1);
        f.host.loadProv("demo");
        assert.equal(pending.aborts, 1);
        const count = f.requests.length;
        pending.resolve(payload(id));
        pending.reject();
        assert.equal(f.requests.length, count);
        assert.equal(f.completed, 2);
        assert.deepEqual(f.scripts, []);
        assert.equal(f.ajaxWrites, 0);
        assert.equal(f.host.getMediaArray, null);
    }
});

test("malformed async payloads complete host startup once, clear partial accounts and allow recovery", () => {
    for (const id of ids) {
        const f = integrationFixture(id, settings(id));
        Object.assign(f.host, {
            epg: {},
            infoBox() {},
            navigator: { userAgent: "browser" },
        });
        f.host.loadProv();
        const bad =
            id === "itv"
                ? { channels: [payload(id).channels[0], null] }
                : id === "ottclub"
                  ? "{bad-json"
                  : [payload(id)[0], null];
        assert.doesNotThrow(() => f.requests[0].resolve(bad));
        if (id === "shura") f.requests[1].resolve(categories);
        assert.equal(f.completed, 1);
        assert.deepEqual(Array.from(f.host.cList), []);
        assert.deepEqual(clone(f.host.channels), {});
        f.requests[0].resolve(payload(id));
        f.requests[0].reject();
        assert.equal(f.completed, 1);
        const start = f.requests.length;
        f.host.loadChannels();
        finishLoad(f, id, payload(id), start);
        assert.equal(f.completed, 2);
        assert(f.host.cList.length > 0);
        f.host.loadChannels();
        const pending = f.requests.at(-1);
        f.host.loadProv("demo");
        pending.reject();
        pending.resolve(bad);
        assert.equal(f.completed, 3);
        assert.equal(f.host.__ottActiveProviderDriver.id, "demo");
    }
    const f = context("shura"),
        driver = f.mount("shura");
    driver.load(() => {});
    finishLoad(f, "shura");
    const values = [];
    driver.guide("one", (value) => values.push(value));
    f.requests
        .at(-1)
        .resolve([{ duration: 20, name: "valid", start_time: 100 }]);
    const last = f.requests.at(-1);
    assert.doesNotThrow(() => last.resolve([null]));
    last.reject();
    last.resolve([]);
    assert.deepEqual(values, [null]);
});

console.log("PASS catalog provider instances: " + passed + " groups");
