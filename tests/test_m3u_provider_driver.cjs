"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");
const fixture = require("./helpers/m3u-driver-fixture.cjs");
const corrected = require("./helpers/playlist-corrected-expectations.cjs");
const clone = (value) => JSON.parse(JSON.stringify(value));
const playlist =
    '#EXTM3U url-tvg="https://xml.test/main.xml"\n#EXTINF:-1 tvg-id="one" group-title="News",One\nhttps://cdn.test/one/index.m3u8\n#EXTINF:-1 tvg-id="two" group-title="News",Two\nhttps://cdn.test/two/index.m3u8\n';
const portal = "portal::[key:PRIVATE_FIXTURE]https://portal.test/api/v1/";
const secondPortal = "portal::[key:OTHER_FIXTURE]https://second.test/api/v1/";
let passed = 0;
function test(name, run) {
    run();
    passed++;
    console.log("PASS M3U driver: " + name);
}
function load(f, body = playlist) {
    const driver = f.start();
    let completed = 0;
    f.host.getChannelsArray(() => completed++);
    f.requests[0].resolve(body);
    return { completed, driver };
}
function key(f, index, value, slot = 0) {
    f.host.doEditListData(slot);
    f.host.selIndex = index;
    f.host.listKeyHandler(f.host.keys.ENTER);
    f.host.editvar = value;
    f.host.setEdit();
}

test("14 captured M3U catalogs and matching request bodies retain legacy channel identity", () => {
    for (const row of require("./fixtures/playlist/legacy.json").cases) {
        const f = fixture(),
            { completed } = load(f, row.input);
        const actual = clone({
            callbacks: completed,
            channels: f.host.channels,
            groupOrder: f.host.catsArray,
            groups: f.host.cats,
            ids: f.host.cList,
        });
        const contract = corrected.main(row);
        const expected = clone(contract);
        delete expected.epgConfig;
        delete expected.epgBody;
        delete expected.logoBody;
        assert.deepEqual(actual, expected, row.input);
        for (const [suffix, body] of [
            ["channels", contract.epgBody],
            ["logos", contract.logoBody],
        ]) {
            const request = f.requests.find((item) =>
                item.settings.url.endsWith("/match-" + suffix)
            );
            assert.equal(
                request?.settings.data.split("\n\t\n")[2] || "",
                body,
                suffix + ":" + row.input
            );
        }
        f.dom.window.close();
    }
});

test("invalid playlist responses fail once without exposing their body or starting matching", () => {
    const privateBody = "PRIVATE_RESPONSE_FIXTURE";
    const bodies = [
        "<!doctype html><html>" + privateBody + "</html>",
        "\ufeff \r\n<html>" + playlist + "</html>",
        "# upstream comment\r\n\n <html>" + privateBody + "</html>",
        "# upstream comment\r<html>" + privateBody + "</html>",
        '\n {"error":"' + privateBody + '"}',
        '\ufeff# upstream comment\n ["' + privateBody + '"]',
        "",
        " \t\r\n\ufeff",
        null,
        undefined,
        false,
        42,
        [],
        { error: privateBody },
        {
            toString() {
                throw new Error("Responses must not be coerced to text");
            },
        },
    ];
    for (const route of ["direct", "proxy", "local"])
        for (const body of bodies) {
            const f = fixture(
                route === "local"
                    ? {
                          config: {
                              active: 0,
                              M3Us: [{ www: "/sdcard/list.m3u" }],
                          },
                          readFile: () => body,
                      }
                    : {}
            );
            try {
                const driver = f.start();
                const outcomes = [];
                driver.load((catalog, error) =>
                    outcomes.push({ count: catalog.ids.length, error })
                );
                if (route !== "local") {
                    if (route === "proxy") f.requests[0].reject();
                    const request = f.requests.at(-1);
                    request.resolve(body);
                    request.resolve(playlist);
                    request.reject();
                }
                assert.deepEqual(outcomes, [
                    { count: 0, error: "m3u-processing" },
                ]);
                assert.equal(
                    f.requests.length,
                    route === "local" ? 0 : route === "proxy" ? 2 : 1,
                    "Invalid content must not start guide/logo matching or a retry"
                );
            } finally {
                f.dom.window.close();
            }
        }
    const f = fixture();
    try {
        load(f, bodies[0]);
        assert.deepEqual(f.errors, ["Failed to load channel list!"]);
    } finally {
        f.dom.window.close();
    }
});

test("playlist validation preserves headers, comments, BOM, bare URLs and empty M3U documents", () => {
    for (const [body, count] of [
        [playlist, 2],
        [playlist.slice(playlist.indexOf("\n") + 1), 2],
        ["\ufeff" + playlist.replace(/\n/g, "\r\n"), 2],
        ["# leading comment\r\n\r\n" + playlist, 2],
        ["# leading comment\r\n".repeat(10000) + playlist, 2],
        ["#EXTM3U", 0],
        ['\ufeff#EXTM3U url-tvg="https://xml.test/main.xml"\r\n# comment\n', 0],
        ["# comment only\n", 0],
        ["https://cdn.test/unadorned.m3u8\n", 0],
    ]) {
        const f = fixture();
        try {
            const driver = f.start();
            const outcomes = [];
            driver.load((catalog, error) =>
                outcomes.push({ count: catalog.ids.length, error })
            );
            f.host.resolveValidationResponse = () =>
                f.requests[0].resolve(body);
            vm.runInContext("resolveValidationResponse()", f.host, {
                timeout: 5000,
            });
            assert.deepEqual(outcomes, [{ count, error: undefined }]);
        } finally {
            f.dom.window.close();
        }
    }
});

test("cancelled playlist responses cannot report validation errors into a replacement load", () => {
    const f = fixture();
    try {
        const driver = f.start();
        const outcomes = [];
        driver.load(() => outcomes.push("old"));
        const previous = f.requests[0];
        driver.load((catalog, error) =>
            outcomes.push({ count: catalog.ids.length, error })
        );
        previous.resolve("<html>expired login</html>");
        assert.deepEqual(outcomes, []);
        f.requests.at(-1).resolve(playlist);
        assert.deepEqual(outcomes, [{ count: 2, error: undefined }]);
    } finally {
        f.dom.window.close();
    }
});

test("15 slots normalize corrupt configurations and preserve per-slot history/journal namespaces", () => {
    for (const raw of [
        "invalid",
        "null",
        "[]",
        '{"active":999,"M3Us":[null]}',
    ]) {
        const f = fixture({ storage: { m3um3uArr: raw } }),
            driver = f.start();
        assert.equal(driver.configuration().active, 0);
        assert.equal(driver.configuration().M3Us.length, 15);
        assert.equal(
            f.saved.get("m3um3uArr"),
            raw,
            "normalization on read is nondestructive"
        );
    }
    const f = fixture(),
        driver = f.start();
    for (let index = 0; index < 15; index++) {
        const cfg = driver.configuration();
        cfg.active = index;
        driver.saveConfiguration(cfg);
        f.host.providerSetItem("medHistory", String(index));
        f.host.providerSetItem("playbackJournal", String(index));
        assert.equal(
            f.saved.get("m3umedHistory" + (index || "")),
            String(index)
        );
        assert.equal(
            f.saved.get("m3uplaybackJournal" + (index || "")),
            String(index)
        );
        assert.equal(driver.storageKey("m3uArr"), "m3um3uArr");
        assert.equal(f.host.m3uArr.active, index);
    }
    const detached = driver.configuration();
    detached.M3Us[14].www = "corrupt";
    assert.notEqual(driver.configuration().M3Us[14].www, "corrupt");
});

test("direct timeout/proxy fallback/interception/local files retain request contract and finish once", () => {
    const intercepted = [],
        f = fixture({ intercept: (value) => intercepted.push(value) });
    const driver = f.start();
    let completed = 0;
    driver.load(() => completed++);
    assert.deepEqual(intercepted, ["https://playlist.test/list.m3u"]);
    assert.equal(f.requests[0].settings.timeout, 5000);
    assert(f.requests[0].settings.url.includes("?url=https%3A"));
    f.requests[0].reject();
    assert.deepEqual(clone(f.requests[1].settings), {
        data: { url: "@https://playlist.test/list.m3u" },
        dataType: "text",
        method: "post",
        timeout: 65000,
        url: "https://relay.test/m3u/cp.php",
    });
    f.requests[1].resolve(playlist);
    f.requests[1].reject();
    assert.equal(completed, 1);
    const local = fixture({
        config: { active: 0, M3Us: [{ www: "/sdcard/a.m3u" }] },
        readFile: (path) => {
            assert.equal(path, "/sdcard/a.m3u");
            return playlist;
        },
    });
    local.start();
    local.host.getChannelsArray(() => {});
    assert.equal(local.host.cList.length, 2);
    assert(local.requests.every((r) => r.settings.type === "POST"));
});

test("direct playlists remain text under legacy and native jQuery MIME detection", () => {
    for (const file of [
        "js/jquery-1.11.1.min.js",
        "node_modules/jquery/dist/jquery.min.js",
    ]) {
        for (const mime of [
            "text/plain",
            "application/json",
            "application/xml",
            "application/javascript",
        ]) {
            const f = fixture();
            const browser = new JSDOM("<!doctype html>", {
                runScripts: "outside-only",
                url: "https://playlist.test/",
            });
            try {
                const w = browser.window;
                w.eval(
                    fs.readFileSync(path.join(__dirname, "..", file), "utf8")
                );
                const requests = [];
                let response = playlist;
                w.$.ajaxTransport("+*", (options) => ({
                    abort() {},
                    send(_headers, complete) {
                        requests.push(options.url);
                        if (options.url === "https://playlist.test/list.m3u")
                            complete(
                                200,
                                "OK",
                                { text: response },
                                "Content-Type: " + mime
                            );
                        else complete(503, "Unavailable", { text: "" });
                    },
                }));
                f.host.$.ajax = w.$.ajax.bind(w.$);
                const driver = f.start();
                let completed = 0;
                driver.load((catalog, error) => {
                    assert.equal(error, undefined, file + ": " + mime);
                    assert.equal(catalog.ids.length, 2);
                    completed++;
                });
                assert.equal(completed, 1);
                assert.equal(
                    requests.some((url) => url.endsWith("/m3u/cp.php")),
                    false,
                    "A mislabeled response must not require the companion proxy"
                );
                if (mime === "application/javascript") {
                    response = "window.__ottPlaylistMimeExecuted = true;";
                    driver.load(() => completed++);
                    assert.equal(completed, 2);
                    assert.equal(w.__ottPlaylistMimeExecuted, undefined);
                }
            } finally {
                browser.window.close();
                f.dom.window.close();
            }
        }
    }
});

test("slow companion playlists get the upstream budget and still terminate at the client deadline", () => {
    const f = fixture();
    const browser = new JSDOM("<!doctype html>", {
        runScripts: "outside-only",
        url: "https://playlist.test/",
    });
    try {
        const w = browser.window;
        w.eval(
            fs.readFileSync(
                path.join(__dirname, "../js/jquery-1.11.1.min.js"),
                "utf8"
            )
        );
        const timers = new Map();
        let now = 0;
        let nextTimer = 0;
        w.setTimeout = (callback, delay) => {
            const id = ++nextTimer;
            timers.set(id, { at: now + delay, callback });
            return id;
        };
        w.clearTimeout = (id) => timers.delete(id);
        function advance(milliseconds) {
            const until = now + milliseconds;
            for (;;) {
                const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
                if (!next || next[1].at > until) break;
                now = next[1].at;
                timers.delete(next[0]);
                next[1].callback();
            }
            now = until;
        }
        let proxyResponse;
        let aborts = 0;
        w.$.ajaxTransport("+*", (options) => ({
            abort() {
                aborts++;
            },
            send(_headers, complete) {
                if (options.url.endsWith("/m3u/cp.php"))
                    proxyResponse = complete;
                else complete(503, "Unavailable", { text: "" });
            },
        }));
        f.host.$.ajax = w.$.ajax.bind(w.$);
        const driver = f.start();
        const outcomes = [];
        function completed(catalog, error) {
            outcomes.push({ count: catalog.ids.length, error });
        }
        driver.load(completed);
        advance(30000);
        assert.equal(
            outcomes.length,
            0,
            "Slow upstream playlists remain pending after 30 seconds"
        );
        proxyResponse(
            200,
            "OK",
            { text: playlist },
            "Content-Type: text/plain"
        );
        assert.deepEqual(outcomes, [{ count: 2, error: undefined }]);
        assert.equal(aborts, 0);
        driver.load(completed);
        advance(64999);
        assert.equal(outcomes.length, 1);
        advance(1);
        assert.deepEqual(outcomes[1], { count: 0, error: "m3u-network" });
        assert.equal(aborts, 1);
        proxyResponse(
            200,
            "OK",
            { text: playlist },
            "Content-Type: text/plain"
        );
        assert.equal(
            outcomes.length,
            2,
            "Timed-out responses cannot publish a late catalog"
        );
    } finally {
        browser.window.close();
        f.dom.window.close();
    }
});

test("matching companion uses the relay hostname and preserves custom and relative relays without URL", () => {
    for (const [relay, crossOrigin, origin, expected] of [
        ["https://ottp.eu.org", true, "player.test", "http://ottp.eu.org"],
        [
            "https://ottp.eu.org:8443/api",
            false,
            "player.test:8080",
            "http://player.test:8080",
        ],
        ["https://OTTP.EU.ORG/api", true, "player.test", "http://ottp.eu.org"],
        ["//ottp.eu.org/api", true, "player.test", "http://ottp.eu.org"],
        [
            "https://user:pass@ottp.eu.org/api",
            true,
            "player.test",
            "http://ottp.eu.org",
        ],
        [
            "https://relay.test/ottp.eu.org",
            true,
            "player.test",
            "https://relay.test/ottp.eu.org",
        ],
        [
            "https://relay.test?host=ottp.eu.org",
            true,
            "player.test",
            "https://relay.test?host=ottp.eu.org",
        ],
        [
            "https://ottp.eu.org.relay.test",
            true,
            "player.test",
            "https://ottp.eu.org.relay.test",
        ],
        [
            "https://prefix-ottp.eu.org",
            true,
            "player.test",
            "https://prefix-ottp.eu.org",
        ],
        [
            "https://ottp.eu.org@relay.test",
            true,
            "player.test",
            "https://ottp.eu.org@relay.test",
        ],
        [
            "https://private.test/companion",
            false,
            "player.test",
            "https://private.test/companion",
        ],
        [
            "//private.test/companion",
            false,
            "player.test",
            "//private.test/companion",
        ],
        ["/proxy/ottp.eu.org", true, "player.test", "/proxy/ottp.eu.org"],
        ["./ottp.eu.org", false, "player.test", "./ottp.eu.org"],
        ["", false, "player.test:8080", "http://player.test:8080"],
        ["", false, "ottp.eu.org", "http://ottp.eu.org"],
    ]) {
        const f = fixture({ crossOrigin });
        f.host.host = relay;
        f.host.location.host = origin;
        f.host.URL = undefined;
        load(f);
        const matches = f.requests.filter((request) =>
            /\/m3u\/match-(channels|logos)$/.test(request.settings.url)
        );
        assert(matches.length > 0, relay);
        for (const request of matches)
            assert.equal(
                request.settings.url.split("/m3u/")[0],
                expected,
                relay
            );
        f.dom.window.close();
    }
});

test("native XMLTV metadata carries source aliases while browser protocol stays minimal", () => {
    const text =
        '#EXTM3U url-tvg="https://xml.test/one.xml,//xml.test/two.xml" foss-tvg="alias::https://xml.test/custom.xml"\n#EXTINF:-1 tvg-id="one" tvg-source="#2,#alias" tvg-name="Native name",One\nhttps://cdn.test/live\n';
    for (const native of [false, true]) {
        const f = fixture({ native }),
            { driver } = load(f, text);
        const post = f.requests.find((r) =>
            r.settings.url.endsWith("/match-channels")
        );
        const metadata = JSON.parse(post.settings.data.split("\n\t\n")[0]);
        if (native) {
            const id = f.host.cList[0];
            assert.deepEqual(metadata.native_channels[id].xmltv_urls, [
                "https://xml.test/two.xml",
                "https://xml.test/custom.xml",
            ]);
            assert.equal(metadata.native_channels[id].tvg_name, "Native name");
        } else assert.deepEqual(metadata, {});
        assert(driver.stream(f.host.cList[0]));
    }
});

test("relative guide sources use the matching HTTP companion while independent source origins remain intact", () => {
    for (const native of [false, true])
        for (const [companion, source, expected] of [
            [
                "http://companion.test:8080",
                "/",
                "http://companion.test:8080/epg/",
            ],
            [
                "https://companion.test/prefix",
                "/",
                "https://companion.test/epg/",
            ],
            [
                "https://companion.test/prefix",
                "nested/",
                "https://companion.test/prefix/nested/epg/",
            ],
            [
                "https://companion.test/prefix/",
                "",
                "https://companion.test/prefix/epg/",
            ],
            [
                "https://companion.test/prefix",
                "../guide/",
                "https://companion.test/guide/epg/",
            ],
            [
                "https://companion.test",
                "https://other.test:9443/data/",
                "https://other.test:9443/data/epg/",
            ],
            [
                "https://companion.test",
                "//other.test/data/",
                "//other.test/data/epg/",
            ],
        ]) {
            const f = fixture({ native });
            f.host.URL = f.dom.window.URL;
            const { driver } = load(
                f,
                playlist.replace(
                    "#EXTM3U",
                    '#EXTM3U foss-tvg="!epg-server::' + companion + '"'
                )
            );
            try {
                const id = f.host.cList[0];
                const request = f.requests.find((r) =>
                    r.settings.url.endsWith("/match-channels")
                );
                assert.equal(
                    request.settings.url,
                    companion + "/m3u/match-channels"
                );
                request.resolve(
                    "{}\n\t\n" + id + "~local~one\n\t\nlocal~" + source
                );
                assert.equal(driver.currentGuideUrl(id), expected + "one.json");
                if (native)
                    assert.equal(f.host.channels[id].epg_external, true);
                let rows;
                driver.guide(id, (value) => (rows = value));
                const guide = f.requests.at(-1);
                assert.equal(
                    guide.settings.url,
                    expected + "one.json?hours=48"
                );
                guide.resolve({
                    epg_data: [
                        {
                            name: "Companion programme",
                            time: 100,
                            time_to: 200,
                        },
                    ],
                });
                assert.equal(rows[0].name, "Companion programme");
            } finally {
                driver.dispose();
                f.dom.window.close();
            }
        }
});

test("malformed or non-HTTP companions preserve the existing request and error path", () => {
    for (const companion of [
        "http://[invalid",
        "//companion.test",
        "/companion",
        "tauri://localhost",
    ]) {
        const f = fixture();
        f.host.URL = f.dom.window.URL;
        const { driver } = load(
            f,
            playlist.replace(
                "#EXTM3U",
                '#EXTM3U foss-tvg="!epg-server::' + companion + '"'
            )
        );
        try {
            const id = f.host.cList[0];
            const request = f.requests.find((r) =>
                r.settings.url.endsWith("/match-channels")
            );
            assert.equal(
                request.settings.url,
                companion + "/m3u/match-channels"
            );
            request.resolve("{}\n\t\n" + id + "~local~one\n\t\nlocal~/");
            assert.equal(driver.currentGuideUrl(id), "/epg/one.json");
            const callbacks = [];
            driver.guide(id, (value) => callbacks.push(value));
            f.requests.at(-1).reject();
            assert.deepEqual(callbacks, [null]);
        } finally {
            driver.dispose();
            f.dom.window.close();
        }
    }
});

test("the shipped legacy URL polyfill resolves a separate companion without a native URL constructor", () => {
    const f = fixture();
    f.host.URL = undefined;
    vm.runInContext(
        fs.readFileSync(
            path.join(__dirname, "../js/runtime-polyfills.js"),
            "utf8"
        ),
        f.host
    );
    assert.equal(typeof f.host.URL, "function");
    const { driver } = load(
        f,
        playlist.replace(
            "#EXTM3U",
            '#EXTM3U foss-tvg="!epg-server::https://companion.test/service"'
        )
    );
    try {
        const id = f.host.cList[0];
        f.requests
            .find((r) => r.settings.url.endsWith("/match-channels"))
            .resolve("{}\n\t\n" + id + "~local~one\n\t\nlocal~nested/");
        assert.equal(
            driver.currentGuideUrl(id),
            "https://companion.test/service/nested/epg/one.json"
        );
    } finally {
        driver.dispose();
        f.dom.window.close();
    }
});

test("late matching patches owned route/logo only, refreshes missing EPG and retains valid schedule state", () => {
    const f = fixture({ crossOrigin: false }),
        { driver } = load(f);
    const ids = f.host.cList;
    f.host.__ottClassicGuide = {
        invalidateChannel(id) {
            f.events.push(["invalidate-guide", id]);
        },
    };
    f.host.curList = ids.slice();
    f.host.primaryIndex = 0;
    for (const id of ids)
        Object.assign(f.host.channels[id], {
            name: "Old programme",
            time: 10,
            time_request: Date.now() / 1000 + 3600,
        });
    const guide = f.requests.find((r) =>
        r.settings.url.endsWith("/match-channels")
    );
    guide.resolve(
        "{}\n\t\n" +
            ids.map((id, i) => id + "~s~c" + i).join("\n") +
            "\n\t\ns~http://epg.ottp.eu.org/"
    );
    assert(
        f.events.some(
            (entry) => entry[0] === "invalidate-guide" && entry[1] === ids[1]
        )
    );
    assert(f.events.some((e) => e[0] === "refresh" && e[1] === ids[1]));
    assert.equal(f.host.channels[ids[0]].name, "Old programme");
    assert.equal(f.host.channels[ids[0]].time, 10);
    let rows;
    driver.guide(ids[0], (value) => (rows = value));
    const pending = f.requests.at(-1);
    assert.equal(
        pending.settings.url,
        "http://player.test/e/epg/c0.json?hours=48"
    );
    const response = { epg_data: [{ name: "New", time: 100, time_to: 200 }] };
    pending.resolve(response);
    assert.equal(rows[0].name, "New");
    rows[0].time = -1;
    assert.equal(response.epg_data[0].time, 100);
    const logo = f.requests.find((r) =>
        r.settings.url.endsWith("/match-logos")
    );
    logo.resolve("{}\n\t\n" + ids[0] + "~https://icons.test/new.png");
    assert.equal(driver.logo(ids[0]), "https://icons.test/new.png");
    f.host.channels[ids[0]].url = "corrupt";
    f.host.channels[ids[0]].epg_url = "corrupt";
    assert.notEqual(driver.stream(ids[0]), "corrupt");
    assert(!driver.currentGuideUrl(ids[0]).includes("corrupt"));
});

test("slot/provider/reload replacement cancels every playlist and matching stage, ignoring hostile late responses", () => {
    for (const phase of ["direct", "proxy", "guide", "logo", "epg"])
        for (const retire of ["slot", "provider", "reload"]) {
            const f = fixture(),
                driver = f.start();
            let calls = 0;
            driver.load(() => calls++);
            if (phase === "proxy") f.requests[0].reject();
            if (["guide", "logo", "epg"].includes(phase))
                f.requests[0].resolve(playlist);
            let pending = phase === "guide" ? f.requests[1] : f.requests.at(-1);
            if (phase === "epg") {
                const catalog = f.host.OttPlayCore.parseProviderPlaylist(
                    playlist,
                    "m3u",
                    (url) => f.host.murmurhash3_32_gc(url, 10),
                    48
                );
                const id = catalog.ids[0];
                f.requests[1].resolve(
                    "{}\n\t\n" + id + "~s~one\n\t\ns~http://epg.test/"
                );
                driver.guide(id, () => calls++);
                pending = f.requests.at(-1);
            }
            if (retire === "provider") f.mount("demo");
            if (retire === "reload") driver.load(() => {});
            if (retire === "slot") {
                const cfg = driver.configuration();
                cfg.active = 1;
                cfg.M3Us[1].www = "https://second.test/list";
                driver.saveConfiguration(cfg);
            }
            assert.equal(pending.aborts, 1, phase + ":" + retire);
            const count = f.requests.length,
                before = calls;
            pending.resolve(playlist);
            pending.reject();
            assert.equal(f.requests.length, count);
            assert.equal(calls, before);
        }
});

test("failed reload clears stale streams and external raw slot changes invalidate requests without publication", () => {
    const f = fixture(),
        { driver } = load(f),
        id = f.host.cList[0];
    driver.load(() => {});
    f.requests.at(-1).reject();
    f.requests.at(-1).reject();
    assert.equal(driver.stream(id), "");
    let complete = 0;
    driver.load(() => complete++);
    const pending = f.requests.at(-1);
    f.saved.set(
        "m3um3uArr",
        JSON.stringify({ active: 1, M3Us: [{}, { www: "https://new.test/" }] })
    );
    pending.resolve(playlist);
    assert.equal(complete, 0);
    assert.equal(driver.storageKey("medHistory"), "m3umedHistory1");
});

test("settings editors mask portal keys, guard stale handlers, import files and scope reset to edited active slot", () => {
    const f = fixture({
            config: {
                active: 0,
                M3Us: [
                    { medUrl: portal, www: "https://playlist.test/old" },
                    { www: "https://other.test/" },
                ],
            },
            readFile: () => playlist,
        }),
        driver = f.start();
    f.host.providerSetItem("playbackJournal", "old");
    f.saved.set("m3uplaybackJournal1", "keep");
    f.host.doEditListData(0);
    assert(!f.host.listArray.join(" ").includes("PRIVATE_FIXTURE"));
    f.host.selIndex = 2;
    f.host.listKeyHandler(f.host.keys.ENTER);
    f.host.editvar = "/sdcard/new.m3u";
    f.host.setEdit();
    assert.equal(driver.configuration().M3Us[0].www, "/sdcard/new.m3u");
    assert.equal(f.saved.get("m3uplaybackJournal"), undefined);
    assert.equal(f.saved.get("m3uplaybackJournal1"), "keep");
    assert(f.events.some((e) => e[0] === "suspend-journal"));
    f.host.doEditListData(0);
    f.host.selIndex = 0;
    f.host.listKeyHandler(f.host.keys.ENTER);
    const old = f.host.setEdit;
    f.host.doEditListData(1);
    f.host.editvar = "stale";
    old();
    assert.notEqual(driver.configuration().M3Us[0].name, "stale");
    key(f, 1, secondPortal);
    const reopen = Array.from(f.timers.values()).at(-1);
    const count = f.edits.length;
    f.mount("demo");
    reopen();
    assert.equal(f.edits.length, count);
});

test("legacy portal slots stay inert through startup, refresh and slot changes without affecting TV", () => {
    for (const dune of [false, true]) {
        const f = fixture({
            config: {
                active: 0,
                M3Us: [
                    {
                        medSourceId: "keep-source",
                        medUrl: portal,
                        name: "Home",
                        www: "https://tv.test/",
                    },
                    { medUrl: secondPortal, www: "https://tv.test/other" },
                ],
            },
            dune,
        });
        const before = f.saved.get("m3um3uArr");
        const driver = f.start();
        f.host.duneAddSettings(0);
        f.host.m3uUpdateMedia();
        assert.equal(f.saved.get("m3um3uArr"), before);
        assert.equal(f.host.providerMediaClient, null);
        assert.equal(f.host.getMediaArray, null);
        assert.equal(f.host.playMedia, f.host._playMedia);
        assert.equal(f.requests.length, 0);
        f.host.providerSetItem("medHistory", "saved-history");
        f.host.selectAndRestart(1);
        assert.equal(f.saved.get("m3umedHistory"), "saved-history");
        assert.equal(f.host.providerMediaClient, null);
        assert.equal(f.host.getMediaArray, null);
        let completed = 0;
        let catalog;
        driver.load((value) => {
            completed++;
            catalog = value;
        });
        assert.equal(f.requests[0].settings.url, "https://tv.test/other");
        f.requests[0].resolve(playlist);
        assert.equal(completed, 1);
        assert.equal(catalog.ids.length, 2);
        assert.equal(driver.configuration().M3Us[0].medSourceId, "keep-source");
        assert.equal(driver.configuration().M3Us[1].medUrl, secondPortal);
        f.dom.window.close();
    }
});

test("public HTML params retain15 slots and tolerate malformed escapes; Dune n parameter pins selected slot", () => {
    const f = fixture(),
        driver = f.start();
    assert.equal(f.host.getProviderParams(), "https://playlist.test/list.m3u");
    f.forms["#www0"] = "https://new.test/%broken";
    f.forms["#rechours0"] = "72";
    f.forms["input[name=odin]:checked"] = 0;
    assert.equal(f.host.setProviderParams(), true);
    assert.equal(
        driver.configuration().M3Us[0].www,
        "https://new.test/%broken"
    );
    assert.equal(driver.configuration().M3Us.length, 15);
    const d = fixture({
            config: { active: 1, M3Us: [] },
            dune: true,
            href: "http://player.test/?m3u&n=15",
        }),
        dd = d.start();
    assert.equal(dd.configuration().active, 14);
    d.host.selectAndRestart(1);
    assert.equal(dd.configuration().active, 14);
});

test("Dune saved XML/JSON/M3U catalogs use owned media transport with MAC and stale navigation guards", () => {
    for (const format of ["json", "xml", "m3u"]) {
        const f = fixture({
            config: {
                active: 0,
                M3Us: [
                    {
                        medUrl: "https://catalog.test/root",
                        www: "https://tv.test/",
                    },
                ],
            },
            dune: true,
        });
        f.start();
        let complete = 0;
        f.host.mediaUrls = [""];
        f.host.getMediaArray("", () => complete++);
        const request = f.requests[0];
        assert(request.settings.url.includes("box_mac=001122334455"));
        const body =
            format === "json"
                ? JSON.stringify({
                      channels: [
                          { stream_url: "https://video.test/a", title: "Film" },
                      ],
                      next_page_url: "next",
                      title: "Library",
                  })
                : format === "xml"
                  ? "<items><playlist_name>Library</playlist_name><channels><channel><title>Film</title><stream_url>https://video.test/a</stream_url></channel></channels><next_page_url>next</next_page_url></items>"
                  : "#EXTM3U\n#EXTINF:-1,Film\nhttps://video.test/a\n";
        request.resolve(body);
        assert.equal(complete, 1);
        assert.equal(f.host.mediaRecords[0].title, "Film");
        f.host.getMediaArray("next", () => complete++);
        const pending = f.requests.at(-1);
        f.mount("demo");
        pending.resolve(body);
        assert.equal(complete, 1);
        assert.equal(pending.aborts, 1);
    }
});

test("Dune media errors and generated names follow the selected language", () => {
    const f = fixture({
        config: {
            active: 0,
            M3Us: [
                {
                    medUrl: "https://catalog.test/root",
                    www: "https://tv.test/",
                },
            ],
        },
        dune: true,
    });
    try {
        f.host._ = (key) => "localized:" + key;
        f.start();
        for (const data of [
            "short",
            "{broken json",
            "unrecognized data header",
        ]) {
            f.host.getMediaArray("", () => {});
            f.requests.at(-1).resolve(data);
            assert.equal(f.errors.at(-1), "localized:Unable to load playlist");
        }
        f.host.getMediaArray("", () => {});
        f.requests.at(-1).reject({ status: 503 });
        assert.equal(
            f.errors.at(-1),
            "localized:Unable to load playlist (503)"
        );
        f.host.getMediaArray("", () => {});
        f.requests
            .at(-1)
            .resolve(
                '#EXTM3U\n#EXTINF:-1 tvg-name="one"\nhttps://video.test/unnamed\n'
            );
        assert.equal(f.host.mediaRecords[0].title, "localized:Untitled");
        assert.equal(f.host.mediaRecords[0].__ottMediaLabel.key, "Untitled");
        f.host.getMediaArray("", () => {});
        f.requests
            .at(-1)
            .resolve(
                "<items><channel><stream_url>unnamed</stream_url></channel><channel><title>localized:Untitled</title><stream_url>named</stream_url></channel></items>"
            );
        assert.equal(f.host.mediaRecords[0].__ottMediaLabel.key, "Untitled");
        assert.equal(f.host.mediaRecords[1].__ottMediaLabel, undefined);
        assert.equal(f.host.mediaRecords[1].title, "localized:Untitled");
    } finally {
        f.dom.window.close();
    }
});

test("catalog delivery detaches nested XML rows and never appends pagination to the decoder cache", () => {
    const f = fixture();
    const cached = JSON.parse(
        '{"channels":[{"title":"Film","__proto__":{"safe":true},"details":{"cast":["Actor"]}}],"next_page_url":"next"}'
    );
    Object.freeze(cached.channels);
    Object.freeze(cached.channels[0]);
    const owner = f.host.__ottProviderRuntime.createRegistry().activate("test");
    let complete;
    const catalog = f.host.__ottMediaCatalog.create(
        {
            core: { operatorVodUrl: (_profile, url) => url },
            createLifetime: f.host.__ottProviderRuntime.createRegistry,
            decodeXml: () => cached,
        },
        owner,
        {
            transport: () => ({
                dispose() {},
                send(scope, _request, success) {
                    complete = scope.guard(success);
                },
            }),
        }
    );
    let delivered;
    catalog.load(
        { profile: "m3u", url: "https://catalog.test/xml" },
        (value) => {
            delivered = value;
        }
    );
    complete("<items>cached</items>");
    assert.equal(delivered.records.length, 2);
    assert.equal(delivered.records[1].playlist_url, "next");
    assert.equal(cached.channels.length, 1);
    delivered.records[0].details.cast[0] = "Changed";
    delivered.records[0].__proto__.safe = false;
    assert.equal(cached.channels[0].details.cast[0], "Actor");
    assert.equal(cached.channels[0].__proto__.safe, true);
    const json =
        '{"channels":[{"title":"Film","details":{"cast":["Actor"]}}],"menu":[{"title":"Folder"}]}';
    catalog.load(
        { profile: "m3u", url: "https://catalog.test/json" },
        (value) => {
            delivered = value;
        }
    );
    complete(json);
    assert.deepEqual(
        Array.from(delivered.records, (row) => row.t),
        ["channel", "menu"]
    );
    assert.equal(delivered.records[0].details.cast[0], "Actor");
    owner.dispose();
    f.dom.window.close();
});

test("actual loadProv/loadChannels boot owns M3U without dynamic script or source callback resurrection", () => {
    const f = fixture({ integration: true });
    f.start();
    assert.equal(f.host.__ottActiveProviderDriver.id, "m3u");
    f.requests[0].resolve(playlist);
    assert.equal(f.completed, 1);
    assert.equal(f.host.cList.length, 2);
    assert.deepEqual(f.scripts, []);
    f.host.loadChannels();
    const pending = f.requests.at(-1);
    f.host.loadProv("demo");
    pending.resolve(playlist);
    assert.equal(f.host.__ottActiveProviderDriver.id, "demo");
    assert.equal(f.completed, 2);
});

test("54 captured archive rules use owned metadata with real core and current clock", () => {
    for (const row of require("./fixtures/archive/providers.json").fixtures.filter(
        (row) => row.provider === "m3u"
    )) {
        const f = fixture({ dune: row.dune });
        require("node:vm").runInContext(
            "Date.now=function(){return " + row.now * 1000 + ";};",
            f.host
        );
        f.host.OttPlayCore.parseProviderPlaylist = () => ({
            channels: { 42: clone(row.channel) },
            entries: [],
            groupOrder: [],
            groups: {},
            header: "#EXTM3U",
            ids: [42],
        });
        const { driver } = load(f);
        assert.equal(
            driver.archive(42, row.start, row.end),
            row.expected,
            JSON.stringify(row)
        );
        assert.equal(driver.archive("missing", row.start, row.end), "");
    }
});

test("direct guide aliases and archive lookback shift detached programme timestamps once", () => {
    const f = fixture(),
        { driver } = load(
            f,
            '#EXTM3U foss-tvg="=fixed::https://direct.test/epg/"\n#EXTINF:-1 tvg-id="one" tvg-source="=fixed" tvg-shift="2" tvg-logo="https://icons.test/logo.png",One\nhttps://cdn.test/one\n'
        );
    const id = f.host.cList[0];
    assert.equal(f.requests.length, 1);
    assert(driver.currentGuideUrl(id).startsWith("https://direct.test/epg/"));
    const callbacks = [];
    driver.guide(id, (value) => callbacks.push(value));
    const request = f.requests.at(-1);
    assert(request.settings.url.endsWith(".json?hours=48"));
    const input = {
        epg_data: [{ name: "Shifted", time: 100, time_to: 200 }, null],
    };
    request.resolve(input);
    request.resolve(input);
    request.reject();
    assert.equal(callbacks.length, 1);
    assert.equal(callbacks[0][0].time, -7100);
    assert.equal(input.epg_data[0].time, 100);
    driver.guide(id, (value) => callbacks.push(value));
    f.requests.at(-1).resolve({ epg_data: { malformed: true } });
    assert.equal(callbacks[1], null);
});

test("empty/portal/local-read-failure startup finishes safely or opens preserved editor", () => {
    for (const url of ["", portal, "/broken.m3u"]) {
        const f = fixture({
            config: { active: 0, M3Us: [{ www: url }] },
            readFile: () => {
                throw Error("file");
            },
        });
        f.start();
        let completed = 0;
        assert.doesNotThrow(() => f.host.getChannelsArray(() => completed++));
        assert.equal(completed, url ? 1 : 0);
        assert.equal(f.requests.length, 0);
        if (!url)
            assert.equal(f.host.listCaption.innerHTML, "Edit playlist data");
        else assert.equal(f.errors.length, 1);
    }
});

test("catalog teardown, editor save and injected hashing reentry preserve newer work", () => {
    const f = fixture(),
        driver = f.start();
    driver.load(() => {});
    const pending = f.requests[0],
        abort = pending.abort.bind(pending);
    pending.abort = () => {
        abort();
        f.mount("demo");
    };
    const before = f.saved.get("m3um3uArr");
    key(f, 1, "https://changed.test/");
    assert.equal(f.saved.get("m3um3uArr"), before);
    assert.equal(f.host.__ottActiveProviderDriver.id, "demo");
    assert.equal(f.reloads, 0);
    const h = fixture(),
        d = h.start(),
        hash = h.host.murmurhash3_32_gc;
    let first = true,
        old = 0,
        newer = 0;
    h.host.murmurhash3_32_gc = (...args) => {
        if (first) {
            first = false;
            d.load(() => newer++);
            h.requests
                .at(-1)
                .resolve(
                    '#EXTM3U foss-tvg="=new::https://new.test/epg/"\n#EXTINF:-1 tvg-id="new" tvg-source="=new" tvg-logo="https://icons.test/n.png",New\nhttps://new.test/live\n'
                );
        }
        return hash(...args);
    };
    d.load(() => old++);
    h.requests[0].resolve(
        '#EXTM3U foss-tvg="=old::https://old.test/epg/"\n#EXTINF:-1 tvg-id="old" tvg-source="=old",Old\nhttps://old.test/live\n'
    );
    assert.equal(old, 0);
    assert.equal(newer, 1);
    assert.equal(h.requests.length, 2);
    assert.equal(d.stream(hash("https://old.test/live", 10)), "");
    assert(
        d
            .currentGuideUrl(hash("https://new.test/live", 10))
            .startsWith("https://new.test/epg/")
    );
});

test("M3U settings hide legacy portal configuration and preserve it during ordinary edits", () => {
    const f = fixture({
        config: {
            active: 0,
            M3Us: [
                {
                    medSourceId: "keep-source",
                    medUrl: portal,
                    www: "https://tv.test/",
                },
            ],
        },
    });
    const driver = f.start();
    f.host.providerSetItem("medHistory", "saved-history");
    f.host.doEditListData(0);
    assert.equal(f.host.listArray.length, 5);
    assert.equal(f.host.listArray[4], "Load playlist");
    assert(
        !/VPortal|PRIVATE_FIXTURE|portal.test/.test(f.host.listArray.join(" "))
    );
    f.host.doEditM3Ua(0);
    f.host.detailListAction();
    assert(
        !/VPortal|PRIVATE_FIXTURE|portal.test/.test(f.host.listDetail.innerHTML)
    );
    key(f, 0, "Updated TV");
    const slot = driver.configuration().M3Us[0];
    assert.equal(slot.name, "Updated TV");
    assert.equal(slot.medUrl, portal);
    assert.equal(slot.medSourceId, "keep-source");
    assert.equal(f.saved.get("m3umedHistory"), "saved-history");
    assert.equal(f.host.providerMediaClient, null);
    assert.equal(f.requests.length, 0);
});

test("Dune busy view closes on cancel/Return/source change without hiding a replacement dialog", () => {
    for (const action of ["cancel", "return", "source", "foreign"]) {
        const f = fixture({
            config: {
                active: 0,
                M3Us: [
                    {
                        medUrl: "https://vod.test/root",
                        www: "https://tv.test/",
                    },
                ],
            },
            dune: true,
        });
        f.start();
        let calls = 0;
        const previous = () => true;
        f.host.dialogBoxKeyHandler = previous;
        f.host.getMediaArray("", () => calls++);
        const pending = f.requests[0],
            handler = f.host.dialogBoxKeyHandler;
        if (action === "foreign") {
            f.host.dialogBoxKeyHandler = () => true;
            f.panels["#dialogbox"].html = "Other view";
        }
        if (action === "source") f.mount("demo");
        else if (action === "return") handler(f.host.keys.RETURN);
        else f.host.providerMediaClient.cancel();
        assert.equal(pending.aborts, 1);
        assert.equal(f.panels["#dialogbox"].visible, action === "foreign");
        if (action !== "foreign")
            assert.equal(f.host.dialogBoxKeyHandler, previous);
        pending.resolve('{"channels":[{"title":"Late"}]}');
        assert.equal(calls, 0);
        if (action === "foreign")
            assert.equal(f.panels["#dialogbox"].html, "Other view");
    }
});

test("guide projection stops refreshing the old view when a row callback replaces source or catalog", () => {
    for (const replace of ["source", "catalog"]) {
        const f = fixture(),
            { driver } = load(
                f,
                playlist +
                    '#EXTINF:-1 tvg-id="three",Three\nhttps://cdn.test/three\n'
            );
        const ids = f.host.cList;
        f.host.curList = ids.slice();
        f.host.primaryIndex = 0;
        for (const id of ids)
            f.host.channels[id].time_request = Date.now() / 1000 + 50;
        let refresh = 0;
        f.host.getCurProgData = () => {
            refresh++;
            if (replace === "source") f.mount("demo");
            else driver.load(() => {});
        };
        const before = f.events.filter((e) => e[0] === "info").length;
        f.requests[1].resolve(
            "{}\n\t\n" +
                ids.map((id) => id + "~s~" + id).join("\n") +
                "\n\t\ns~https://epg.test/"
        );
        assert.equal(refresh, 1);
        assert.equal(f.events.filter((e) => e[0] === "info").length, before);
    }
});

test("programmatic and raw legacy portal changes stay inactive and preserve source identity", () => {
    for (const raw of [false, true]) {
        const f = fixture({
            config: {
                active: 0,
                M3Us: [
                    {
                        medSourceId: "keep-source",
                        medUrl: portal,
                        www: "https://tv.test/",
                    },
                ],
            },
        });
        const driver = f.start();
        const cfg = driver.configuration();
        cfg.M3Us[0].medUrl = secondPortal;
        if (raw) {
            f.saved.set("m3um3uArr", JSON.stringify(cfg));
            f.host.m3uUpdateMedia();
        } else driver.saveConfiguration(cfg);
        assert.equal(driver.configuration().M3Us[0].medSourceId, "keep-source");
        assert.equal(driver.configuration().M3Us[0].medUrl, secondPortal);
        assert.equal(f.host.providerMediaClient, null);
        assert.equal(f.host.getMediaArray, null);
        assert.equal(f.requests.length, 0);
    }
});

test("switching a Dune catalog to a legacy portal cancels pending loading and keeps its stored value", () => {
    const f = fixture({
        config: {
            active: 0,
            M3Us: [
                {
                    medUrl: "https://catalog.test/root",
                    www: "https://tv.test/",
                },
            ],
        },
        dune: true,
    });
    const driver = f.start();
    let completed = 0;
    f.host.getMediaArray("", () => completed++);
    const pending = f.requests[0];
    const cfg = driver.configuration();
    cfg.M3Us[0].medUrl = portal;
    driver.saveConfiguration(cfg);
    assert.equal(pending.aborts, 1);
    assert.equal(f.host.getMediaArray, null);
    assert.equal(f.host.providerMediaClient, null);
    assert.equal(f.panels["#dialogbox"].visible, false);
    pending.resolve(
        '{"channels":[{"title":"Late","stream_url":"https://old.test/movie"}]}'
    );
    assert.equal(completed, 0);
    assert.equal(f.host.mediaRecords.length, 0);
    assert.equal(f.requests.length, 1);
    assert.equal(driver.configuration().M3Us[0].medUrl, portal);
});

test("Dune legacy media entrypoint ignores portal links without fetching or exposing credentials", () => {
    const f = fixture({ dune: true });
    const driver = f.start();
    const results = [];
    driver.loadMedia(portal, "Old portal", (result) =>
        results.push(clone(result))
    );
    driver.loadMedia("  PoRtAl::invalid  ", "Invalid portal", (result) =>
        results.push(clone(result))
    );
    assert.deepEqual(results, [{ records: [] }, { records: [] }]);
    assert.equal(f.requests.length, 0);
    assert.equal(f.errors.length, 0);
});

test("hosted M3U owns XMLTV without companion requests and disposes stale guide sessions", () => {
    const f = fixture();
    let rows,
        notify,
        stopped = 0;
    f.host.__ottHostedEpg = {
        enabled: () => true,
        open(entries, callback) {
            rows = entries;
            notify = callback;
            return {
                close() {
                    stopped++;
                },
                guide(id, callback) {
                    callback([
                        {
                            descr: "",
                            name: "Hosted",
                            time: 10000,
                            time_to: 11000,
                        },
                    ]);
                },
            };
        },
    };
    const { driver } = load(f);
    assert.equal(
        f.requests.length,
        1,
        "only the playlist is fetched; no matching POST"
    );
    assert.deepEqual(clone(rows[0].xmltv_urls), ["https://xml.test/main.xml"]);
    const id = f.host.cList[0];
    notify({ [id]: { logo: "https://logos.test/one.png" } });
    let result;
    driver.guide(id, (value) => (result = value));
    assert.equal(result[0].name, "Hosted");
    assert.equal(f.requests.length, 1, "guide comes from worker bridge");
    driver.load(() => {});
    assert.equal(stopped, 1);
    notify({ [id]: { logo: "https://logos.test/stale.png" } });
    assert.equal(
        driver.logo(id),
        "",
        "old worker cannot publish into the new catalog"
    );
    f.requests[1].reject();
    assert.equal(
        f.requests.length,
        2,
        "hosted playlist failure never falls back to companion cp.php"
    );
    f.dom.window.close();
});

test("hosted M3U ignores retired companion directives and retains explicit provider JSON guides", () => {
    const f = fixture();
    let entries;
    f.host.__ottHostedEpg = {
        enabled: () => true,
        open(rows) {
            entries = rows;
            return { close() {}, guide() {} };
        },
    };
    const body = playlist
        .replace(
            "#EXTM3U",
            '#EXTM3U foss-tvg="!epg-server::https://epg.2560801.xyz,!ico-server::https://epg.2560801.xyz,=provider::https://provider.test/guide/"'
        )
        .replace('tvg-id="one"', 'tvg-id="one" tvg-source="=provider"');
    const { driver } = load(f, body);
    try {
        assert.equal(f.requests.length, 1, "no guide or logo companion POST");
        assert.equal(
            entries.length,
            1,
            "only the XMLTV channel enters the worker"
        );
        assert.equal(entries[0].id, f.host.cList[1]);
        assert.equal(entries[0].epg_external, false);
        assert.deepEqual(clone(entries[0].xmltv_urls), [
            "https://xml.test/main.xml",
        ]);
        const id = f.host.cList[0];
        assert.equal(f.host.channels[id].epg_src, "=provider");
        let programme;
        driver.guide(id, (rows) => (programme = rows));
        assert.equal(
            f.requests.length,
            2,
            "an explicit provider guide remains direct"
        );
        assert(
            f.requests[1].settings.url.startsWith(
                "https://provider.test/guide/"
            )
        );
        f.requests[1].resolve({
            epg_data: [{ name: "Provider guide", time: 100, time_to: 200 }],
        });
        assert.equal(programme[0].name, "Provider guide");
        assert(
            f.requests.every(
                (request) => !request.settings.url.includes("2560801.xyz")
            )
        );
    } finally {
        driver.dispose();
        f.dom.window.close();
    }
});

console.log("PASS M3U provider driver: " + passed + " scenario groups");
