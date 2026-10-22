/* Actual VPortal transport, native media adapter, journal and menus with a NAS installation. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { fixture, sourceFunctions } = require("./test_port_vod.cjs");
const root = path.resolve(__dirname, "..");
const sourceId = "nas:fixture-library";
const descriptor = {
    api: "/nas/api",
    enabled: true,
    sourceId,
    title: "Synology",
};
const film = {
    request: { cmd: "play", id: "42" },
    title: "Тестовый фильм",
    type: "stream",
};
function create(overrides = {}) {
    const c = fixture();
    const intervals = new Map();
    let intervalId = 0;
    Object.assign(
        c,
        {
            clearInterval(id) {
                intervals.delete(id);
            },
            location: { host: "player.invalid", protocol: "https:" },
            setInterval(run, delay) {
                intervals.set(++intervalId, { delay, run });
                return intervalId;
            },
            sPageSize: 30,
        },
        overrides
    );
    c.stbGetItem = (key) => c.stored[key] ?? null;
    const requests = [];
    c.$.ajax = (options) => {
        const request = {
            abort() {
                request.aborted = true;
                if (options.error) options.error({}, "abort");
                if (options.complete) options.complete();
            },
            aborted: false,
            options,
            reply(value) {
                if (options.success) options.success(value);
                if (options.complete) options.complete();
            },
        };
        requests.push(request);
        return request;
    };
    const source = fs.readFileSync(
        path.join(root, "src/plugins/vportal.ts"),
        "utf8"
    );
    vm.runInContext(
        ts
            .transpileModule(source, {
                compilerOptions: {
                    module: ts.ModuleKind.ES2015,
                    target: ts.ScriptTarget.ES5,
                },
            })
            .outputText.replace(/^import .*$/gm, "")
            .replace(/^export /gm, ""),
        c
    );
    vm.runInContext(sourceFunctions("src/ui/index.ts", ["popMedia"]), c);
    const nas = c.__ottNasLibrary;
    function discover(config = descriptor) {
        nas.init();
        requests.at(-1).reply(config);
    }
    function open(items = [film]) {
        nas.open();
        requests
            .at(-1)
            .reply({ items, title: "Synology", type: "videoportal" });
    }
    return { c, discover, intervals, nas, open, requests };
}
let passed = 0;
function test(name, run) {
    run();
    console.log("PASS NAS library: " + name);
    passed++;
}

test("same-origin discovery is optional, credential-free and bounded", () => {
    const f = create();
    for (const endpoint of [
        "//attacker.invalid",
        "//attacker",
        "/\\attacker",
        "/nas/api?redirect=1",
    ])
        assert.equal(
            f.c.createVPortalClient("", { directEndpoint: endpoint }),
            null
        );
    f.nas.init();
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].options.url, "/nas/config");
    assert.equal(f.requests[0].options.timeout, 5000);
    assert.equal(f.nas.available(), false);
    f.requests[0].reply(descriptor);
    assert.equal(f.nas.available(), true);
    assert.equal(JSON.stringify(f.c.stored), "{}");
    const provider = f.c.getMediaArray;
    const playback = f.c.playMedia;
    f.open();
    assert.equal(f.requests.at(-1).options.url, "/nas/api");
    assert.deepEqual(JSON.parse(f.requests.at(-1).options.data), {
        app: "ott-play",
        limit: 300,
    });
    assert.equal(f.c.getMediaArray, provider);
    assert.equal(f.c.playMedia, playback);
    assert.equal(f.c.__ottMedia.sourceId(), sourceId);
    assert.equal(f.c.listArray[0].title, film.title);
});

test("late discovery and invalid endpoint cannot publish or redirect requests", () => {
    const f = create();
    f.nas.init();
    const stale = f.requests[0];
    f.nas.init();
    assert.equal(stale.aborted, true);
    stale.reply(descriptor);
    assert.equal(f.nas.available(), false);
    f.requests[1].reply({ ...descriptor, api: "https://attacker.invalid/api" });
    assert.equal(f.nas.available(), false);
    f.discover({ ...descriptor, enabled: false });
    assert.equal(f.nas.available(), false);
    f.discover({ ...descriptor, sourceId: "<unsafe>" });
    assert.equal(f.nas.available(), false);
    for (const settings of [
        { location: { protocol: "file:" } },
        { __TAURI__: {} },
        { Capacitor: { isNativePlatform: () => true } },
    ]) {
        const native = create(settings);
        native.nas.init();
        assert.equal(native.requests.length, 0);
    }
});

test("one click resolves compatible default without a quality dialog", () => {
    const f = create();
    f.discover();
    f.open();
    f.c.showSelectBox = () =>
        assert.fail("NAS default must play without another choice");
    let providerCancelled = 0;
    f.c.providerMediaClient = { cancel: () => providerCancelled++ };
    f.c.selectMedia(0);
    assert.deepEqual(JSON.parse(f.requests.at(-1).options.data), {
        app: "ott-play",
        cmd: "play",
        id: "42",
    });
    f.requests.at(-1).reply({
        url: "https://player.invalid/nas/hls/signed/master.m3u8",
        variants: {
            Compatible: "https://player.invalid/nas/hls/signed/master.m3u8",
            Original: "https://player.invalid/nas/stream/signed/original.mkv",
        },
    });
    assert(
        f.c.calls.some(
            (call) => call[0] === "play" && call[1].includes("master.m3u8")
        )
    );
    assert.equal(
        providerCancelled,
        0,
        "NAS playback does not cancel the TV media client"
    );
    const journal = JSON.parse(
        f.c.stored["installation:mediaJournal.v1:" + sourceId]
    );
    assert.equal(journal.history.length, 1);
    assert.equal(journal.history[0].sourceId, sourceId);
    assert.equal(f.c.stored["mediaJournal.v1:" + sourceId], undefined);
});

test("provider changes preserve NAS ownership and returning restores untouched provider ports", () => {
    const f = create();
    f.discover();
    f.open([
        {
            request: { cmd: "folder", id: "8" },
            title: "Series",
            type: "category",
        },
    ]);
    f.c.selectMedia(0);
    const pending = f.requests.at(-1);
    const replacement = (target, done) => {
        f.c.mediaRecords = [{ stream_url: "provider.mp4", title: "Provider" }];
        done();
    };
    f.c.p_pref = "new-provider";
    f.c.getMediaArray = replacement;
    f.c.providerGetItem = () => "";
    f.c.providerSetItem = () =>
        assert.fail("NAS journal must not write provider storage");
    pending.reply({ items: [film], type: "category" });
    assert.equal(f.c.listArray[0].title, film.title);
    assert.equal(f.c.__ottMedia.sourceId(), sourceId);
    f.c.popMedia();
    assert.equal(f.c.listArray[0].title, "Provider");
    assert.equal(f.c.getMediaArray, replacement);
    assert.equal(f.c.__ottMedia.sourceId(), "new-provider");
    assert.equal(f.nas.available(), true);
});

test("restoring provider or closing NAS revokes delayed catalog and playback", () => {
    const f = create();
    f.discover();
    f.nas.open();
    const pending = f.requests.at(-1);
    f.c.popMedia();
    assert.equal(pending.aborted, true);
    pending.reply({ items: [film], type: "videoportal" });
    assert.equal(f.c.listArray[0].title, "Movie");
    f.open();
    f.c.selectMedia(0);
    const resolver = f.requests.at(-1);
    f.c.mediaKeyHandler(f.c.keys.RETURN);
    resolver.reply({ url: "https://player.invalid/late.mp4" });
    assert(!f.c.calls.some((call) => call[0] === "play"));
    f.nas.dispose();
    assert.equal(f.nas.available(), false);
});

test("NAS history survives cold start and provider changes, renewing signed URLs", () => {
    const first = create();
    first.c.stored.medHistory = JSON.stringify([
        { stream_url: "provider.mp4", title: "Private provider" },
    ]);
    first.discover();
    first.open();
    first.c.selectMedia(0);
    first.requests.at(-1).reply({ url: "https://player.invalid/old.mp4" });
    first.c.__ottMedia.checkpoint(first.c.__ottMedia.current().ref, 125, true);
    const cold = create({ p_pref: "other-provider" });
    Object.assign(cold.c.stored, first.c.stored);
    cold.discover();
    cold.open();
    cold.c.selectMedia(
        cold.c.listArray.findIndex((item) => item.__ottMediaRoute === "history")
    );
    assert.equal(cold.c.listArray[0].title, film.title);
    assert(!cold.c.listArray.some((item) => item.title === "Private provider"));
    const beforeResume = cold.requests.length;
    cold.c.selectMedia(0);
    assert.equal(cold.requests.length, beforeResume + 1);
    assert.equal(JSON.parse(cold.requests.at(-1).options.data).cmd, "play");
    cold.requests.at(-1).reply({ url: "https://player.invalid/fresh.mp4" });
    assert(
        cold.c.calls.some(
            (call) => call[0] === "play" && call[1].endsWith("fresh.mp4")
        )
    );
    cold.c.confirm();
    assert.deepEqual(cold.c.calls.at(-1), ["seek", 120]);
});

test("switching media sources flushes the confirmed playback position", () => {
    const f = create();
    f.discover();
    f.open();
    f.c.selectMedia(0);
    f.requests.at(-1).reply({ url: "https://player.invalid/film.mp4" });
    f.c.__ottClassicPlayback.command({ position: 137, type: "position" });
    const state = f.c.__ottClassicPlayback.snapshot();
    assert.equal(state.position, 137);
    f.c.popMedia();
    const journal = JSON.parse(
        f.c.stored["installation:mediaJournal.v1:" + sourceId]
    );
    assert.equal(journal.history[0].position, 137);
});

test("browsing another library preserves NAS playback ownership and continuing resume position", () => {
    const f = create();
    f.discover();
    f.open();
    f.c.selectMedia(0);
    f.requests.at(-1).reply({ url: "https://player.invalid/film.mp4" });
    const playback = f.c.__ottMedia.current();
    const backend = f.c.__ottClassicPlayback.context();
    f.c.popMedia();
    const providerHistory = f.c.medHistory;
    assert.equal(f.c.__ottMedia.current(), playback);
    assert.equal(backend.isCurrentBackend(), true);
    f.c.__ottClassicPlayback.reconcile();
    assert.equal(f.c.__ottClassicPlayback.snapshot().target.sourceId, sourceId);
    f.c.__ottClassicPlayback.command({ position: 246, type: "position" });
    f.c.__ottClassicPlayback.command({ type: "pause" });
    const key = "installation:mediaJournal.v1:" + sourceId;
    assert.equal(JSON.parse(f.c.stored[key]).history[0].position, 246);
    assert.equal(
        f.c.medHistory,
        providerHistory,
        "background checkpoint cannot replace provider lists"
    );
    const count = f.requests.length;
    f.nas.open();
    assert.equal(
        f.requests.length,
        count,
        "returning to the playing catalog reuses its owned view"
    );
    f.c.__ottMedia.favorite(f.c.listArray[0]);
    f.c.__ottClassicPlayback.command({ position: 300, type: "position" });
    f.c.__ottClassicPlayback.command({ type: "stop" });
    const journal = JSON.parse(f.c.stored[key]);
    assert.equal(journal.history[0].position, 300);
    assert.equal(
        journal.favorites.length,
        1,
        "playback and catalog retain a single journal writer"
    );
});

test("standalone NAS is available in popup with no provider; labels are escaped", () => {
    const f = create();
    f.c.getMediaArray = null;
    f.c.popupActions = [];
    f.c.popupArray = [];
    f.c.popupDetail = [];
    f.discover({ ...descriptor, title: "NAS <img src=x>" });
    const menu = f.c.__ottMenuRegistry.open(f.c, "media.nas");
    assert.equal(menu.rows.length, 1);
    assert.equal(menu.rows[0].id, "media.nas");
    assert.equal(menu.rows[0].name, "NAS &lt;img src=x&gt;");
    menu.invoke("media.nas");
    assert.equal(f.requests.at(-1).options.url, "/nas/api");
    f.c.sHideMenus = ["media.nas"];
    assert.equal(f.c.__ottMenuRegistry.open(f.c).rows.length, 0);
});

test("NAS discovery preserves settings navigation and stays in the main menu", () => {
    const f = create();
    const c = f.c;
    const selected = [];
    const chooseProvider = () => selected.push("provider");
    const chooseLanguage = () => selected.push("language");
    let returnedTo;
    Object.assign(c, {
        findOptionIndex: () => -1,
        isPlayDistribution: () => false,
        listCaptionElement: {},
        listDetail: {},
        listFooter: {},
        optionsArr: [
            { action: chooseProvider, name: "Provider" },
            { action: chooseLanguage, name: "Language" },
        ],
        popupActions: [],
        popupArray: [],
        popupDetail: [],
        popupList: (action) => {
            returnedTo = action;
        },
        prependMenuButtonHint: () => {},
        providerSelectionUnlockCount: 0,
        showProviderSelection: chooseProvider,
        sNoNumbersKeys: 1,
        strRETURN: "Return",
        strTools: "Tools",
        toggleProviderSelectionVisibility: () => {},
    });
    vm.runInContext(
        sourceFunctions("src/provider/index.ts", ["optionsList"]),
        c
    );
    c.optionsList(chooseLanguage);
    const settingsHandler = c.listKeyHandlerFn;
    f.discover();
    assert.deepEqual(Array.from(c.listArray), ["Provider", "Language"]);
    assert.equal(
        c.optionsArr.length,
        2,
        "discovery must not add media sources to settings"
    );
    assert.equal(c.selIndex, 1, "discovery preserves the selected setting");
    assert.equal(c.listKeyHandlerFn, settingsHandler);
    c.listKeyHandlerFn(c.keys.ENTER);
    c.optionsList(chooseLanguage);
    assert.deepEqual(Array.from(c.listArray), ["Provider", "Language"]);
    assert.equal(c.selIndex, 1);
    c.selIndex = 0;
    c.listKeyHandlerFn(c.keys.ENTER);
    assert.deepEqual(selected, ["language", "provider"]);
    c.listKeyHandlerFn(c.keys.RETURN);
    assert.equal(returnedTo, c.optionsList);
    const menu = c.__ottMenuRegistry.open(c);
    assert.equal(menu.rows.length, 1);
    assert.equal(menu.rows[0].id, "media.nas");
    menu.invoke("media.nas");
    assert.equal(f.requests.at(-1).options.url, "/nas/api");
});

const firstStop = "https://player.invalid/nas/stream/first.signature/media.bin";
const secondStop =
    "https://player.invalid/nas/stream/second.signature/media.bin";
function startSession(
    f,
    stop = firstStop,
    url = "https://player.invalid/first.m3u8",
    extra = {}
) {
    f.discover();
    f.open();
    f.c.selectMedia(0);
    f.requests.at(-1).reply({ stop, url, ...extra });
}

const firstHeartbeat =
    "https://player.invalid/nas/stream/heartbeat.signature/media.bin";

test("owned heartbeat preserves a paused NAS session while browsing and is revoked by Stop", () => {
    const f = create();
    startSession(f, firstStop, undefined, { heartbeat: firstHeartbeat });
    assert.equal(f.intervals.size, 1);
    const timer = [...f.intervals.values()][0];
    assert.equal(timer.delay, 30000);
    const playback = f.c.__ottMedia.current();
    f.c.__ottClassicPlayback.command({ type: "pause" });
    f.c.popMedia();
    for (let tick = 0; tick < 8; tick++) {
        timer.run();
        assert.equal(
            f.requests.at(-1).options.url,
            "/nas/stream/heartbeat.signature/media.bin"
        );
        assert.equal(f.requests.at(-1).options.type, "GET");
        assert.equal(f.requests.at(-1).options.data, undefined);
        const count = f.requests.length;
        timer.run();
        assert.equal(f.requests.length, count, "heartbeats never overlap");
        f.requests.at(-1).reply("");
    }
    assert.equal(f.c.__ottMedia.current(), playback);
    timer.run();
    const ping = f.requests.at(-1);
    f.c.__ottClassicPlayback.command({ type: "stop" });
    assert.equal(ping.aborted, true);
    assert.equal(f.intervals.size, 0);
    const count = f.requests.length;
    timer.run();
    assert.equal(
        f.requests.length,
        count,
        "queued timer cannot resurrect a stopped session"
    );
    assert.equal(
        f.requests.at(-1).options.url,
        "/nas/stream/first.signature/media.bin"
    );
});

test("heartbeat belongs only to the admitted session and disposal cancels it", () => {
    const f = create();
    startSession(f, firstStop, undefined, { heartbeat: firstHeartbeat });
    const old = [...f.intervals.values()][0];
    f.nas.open();
    f.c.selectMedia(0);
    assert.equal(f.intervals.size, 0);
    f.requests.at(-1).reply("");
    f.requests.at(-1).reply({
        heartbeat: firstHeartbeat,
        stop: secondStop,
        url: "https://player.invalid/second.m3u8",
    });
    assert.equal(f.intervals.size, 1);
    const count = f.requests.length;
    old.run();
    assert.equal(f.requests.length, count);
    const current = [...f.intervals.values()][0];
    current.run();
    const ping = f.requests.at(-1);
    f.nas.dispose();
    assert.equal(ping.aborted, true);
    assert.equal(f.intervals.size, 0);
});

test("native explicit NAS uses its configured origin for the same signed session lifecycle", () => {
    for (const native of [
        { __TAURI__: {} },
        { Capacitor: { isNativePlatform: () => true } },
    ]) {
        const f = create(native);
        const client = f.c.createVPortalClient(
            "portal::[key:fixture-private-key]http://nas.invalid:8443/nas/api"
        );
        const origin = "http://nas.invalid:8443";
        client.resolve(film, () => {});
        assert.equal(f.requests.at(-1).options.url, origin + "/nas/api");
        f.requests.at(-1).reply({
            heartbeat: origin + "/nas/stream/ping.signature/media.bin",
            stop: origin + "/nas/stream/stop.signature/media.bin",
            url: origin + "/video.m3u8",
        });
        assert.equal(f.intervals.size, 1);
        [...f.intervals.values()][0].run();
        assert.equal(
            f.requests.at(-1).options.url,
            origin + "/nas/stream/ping.signature/media.bin"
        );
        client.dispose();
        assert.equal(f.intervals.size, 0);
        assert.equal(
            f.requests.at(-1).options.url,
            origin + "/nas/stream/stop.signature/media.bin"
        );
    }
});

test("native quality selection owns only its chosen variant lease and cancel releases an unplayed request", () => {
    for (const selected of [0, 1, 2, -1]) {
        const f = create({ __TAURI__: {} });
        const origin = "http://nas.invalid";
        const client = f.c.createVPortalClient(
            "portal::[key:fixture-private-key]" + origin + "/nas/api"
        );
        let choose;
        let played;
        f.c.showSelectBox = (_index, _labels, done) => {
            client.cancel(); // The real picker closes its parent list before opening.
            f.c._mediaLoadState = {};
            choose = done;
            f.c.selectBoxKeyHandler = () => false;
        };
        const urls = [
            origin + "/original.mp4",
            origin + "/one.m3u8",
            origin + "/two.m3u8",
        ];
        const one = {
            heartbeat: origin + "/nas/stream/one-ping.signature/media.bin",
            stop: origin + "/nas/stream/one-stop.signature/media.bin",
        };
        const two = {
            heartbeat: origin + "/nas/stream/two-ping.signature/media.bin",
            stop: origin + "/nas/stream/two-stop.signature/media.bin",
        };
        client.resolve(film, (item) => (played = item));
        f.requests.at(-1).reply({
            url: urls[1],
            ...one,
            sessions: { [urls[1]]: one, [urls[2]]: two },
            // Server order is independent of alphabetical labels.
            variants: Object.fromEntries([
                ["Original", urls[0]],
                ["HLS", urls[1]],
                ["Alternate", urls[2]],
            ]),
        });
        assert.equal(
            f.requests.length,
            1,
            "opening quality picker does not stop the pending default"
        );
        assert.equal(
            f.intervals.size,
            0,
            "unselected variants never acquire a heartbeat"
        );
        if (selected < 0) {
            f.c.selectBoxKeyHandler(f.c.keys.RETURN);
            assert.equal(f.requests.at(-1).options.url, one.stop);
            assert.equal(played, undefined);
            continue;
        }
        choose(selected);
        assert.equal(played.stream_url, urls[selected]);
        assert.equal(f.intervals.size, selected ? 1 : 0);
        if (selected) {
            [...f.intervals.values()][0].run();
            assert.equal(
                f.requests.at(-1).options.url,
                (selected === 1 ? one : two).heartbeat
            );
        }
        client.dispose();
        assert.equal(f.intervals.size, 0);
        if (selected)
            assert.equal(
                f.requests.at(-1).options.url,
                (selected === 1 ? one : two).stop
            );
        else
            assert.equal(
                f.requests.length,
                1,
                "Original does not ping or stop an unused HLS variant"
            );
    }
});

test("heartbeat cannot follow arbitrary origins or start for a canceled resolve", () => {
    for (const heartbeat of [
        "https://attacker.invalid/nas/stream/ping.signature/media.bin",
        "https://player.invalid/admin/keepalive",
        "//player.invalid/nas/stream/ping.signature/media.bin",
    ]) {
        const f = create();
        startSession(f, firstStop, undefined, { heartbeat });
        assert.equal(f.intervals.size, 0);
    }
    const f = create();
    f.discover();
    f.open();
    f.c.selectMedia(0);
    const pending = f.requests.at(-1);
    f.c.cancelMediaLoad();
    pending.reply({
        heartbeat: firstHeartbeat,
        stop: firstStop,
        url: "https://player.invalid/late.m3u8",
    });
    assert.equal(f.intervals.size, 0);
});

test("NAS switching awaits session release; browsing and cancel keep playback alive", () => {
    const f = create();
    startSession(f);
    const started = f.requests.length;
    f.c.cancelMediaLoad();
    f.nas.open();
    assert.equal(
        f.requests.length,
        started,
        "opening/closing lists preserves the playing session"
    );
    f.c.settings.stopPlay = 1;
    f.c.stbStop = () => f.c.__ottClassicPlayback.command({ type: "stop" });
    f.c.selectMedia(0);
    const release = f.requests.at(-1);
    assert.equal(release.options.type, "GET");
    assert.equal(release.options.url, "/nas/stream/first.signature/media.bin");
    assert.equal(
        f.requests.length,
        started + 1,
        "new resolve waits for stop completion"
    );
    release.reply("");
    assert.equal(f.requests.at(-1).options.type, "POST");
    f.requests
        .at(-1)
        .reply({ stop: secondStop, url: "https://player.invalid/second.m3u8" });
    assert(
        f.c.calls.some(
            (call) => call[0] === "play" && call[1].includes("second.m3u8")
        )
    );
    assert.equal(
        f.requests.filter((request) =>
            request.options.url.includes("second.signature")
        ).length,
        0,
        "internal stbStop of the old target cannot release the newly resolved session"
    );
    f.c.__ottClassicPlayback.command({ type: "stop" });
    assert.equal(
        f.requests.at(-1).options.url,
        "/nas/stream/second.signature/media.bin"
    );
    const stopped = f.requests.length;
    f.c.__ottClassicPlayback.command({ type: "stop" });
    assert.equal(f.requests.length, stopped, "manual Stop is idempotent");
});

test("actual source replacement and disposal release NAS even while browsing provider media", () => {
    const f = create();
    startSession(f);
    f.c.popMedia();
    const count = f.requests.length;
    f.c.__ottClassicPlayback.command({ channelId: "1", type: "live" });
    assert.equal(f.requests.length, count + 1);
    assert.equal(
        f.requests.at(-1).options.url,
        "/nas/stream/first.signature/media.bin"
    );
    const second = create();
    startSession(second);
    second.nas.dispose();
    assert.equal(
        second.requests.at(-1).options.url,
        "/nas/stream/first.signature/media.bin"
    );
    const provider = create();
    startSession(provider);
    provider.c.popMedia();
    provider.c.selectMedia(0);
    assert.equal(provider.c.calls.at(-1)[0], "play");
    assert.equal(provider.c.calls.at(-1)[1], "movie.mp4");
    assert.equal(
        provider.requests.at(-1).options.url,
        "/nas/stream/first.signature/media.bin",
        "admitting provider VOD releases the previous installation session"
    );
});

test("episode completion renews NAS playback and changing libraries revokes auto-next", () => {
    const f = create();
    f.discover();
    f.nas.open();
    f.requests.at(-1).reply({
        items: [film, { ...film, request: { cmd: "play", id: "43" } }],
        type: "multistream",
    });
    f.c.selectMedia(0);
    f.requests
        .at(-1)
        .reply({ stop: firstStop, url: "https://player.invalid/first.m3u8" });
    function ended() {
        f.c.__ottClassicPlayback.command({ type: "stop" });
        f.c.__ottMedia.ended(f.c.__ottClassicPlayback.snapshot().generation);
        f.requests.at(-1).reply("");
    }
    ended();
    assert.equal(JSON.parse(f.requests.at(-1).options.data).id, "43");
    f.requests
        .at(-1)
        .reply({ stop: secondStop, url: "https://player.invalid/second.m3u8" });
    f.c.popMedia();
    const displayed = f.c.listArray;
    const count = f.requests.length;
    ended();
    assert.equal(
        f.requests.length,
        count + 1,
        "only session release; canceled queue cannot start another episode"
    );
    assert.equal(f.c.listArray, displayed);
});

test("canceled and accepted-but-unplayed responses release only their own signed session", () => {
    const f = create();
    f.discover();
    f.open();
    f.c.selectMedia(0);
    const stale = f.requests.at(-1);
    f.c.cancelMediaLoad();
    stale.reply({ stop: firstStop, url: "https://player.invalid/late.m3u8" });
    assert.equal(
        f.requests.at(-1).options.url,
        "/nas/stream/first.signature/media.bin"
    );
    assert(!f.c.calls.some((call) => call[0] === "play"));
    f.requests.at(-1).reply("");
    f.nas.open();
    f.c.selectMedia(0);
    const accepted = f.requests.at(-1);
    accepted.options.success({
        stop: secondStop,
        url: "https://player.invalid/unplayed.m3u8",
    });
    f.c.cancelMediaLoad();
    accepted.options.complete();
    assert.equal(
        f.requests.at(-1).options.url,
        "/nas/stream/second.signature/media.bin"
    );
    assert(!f.c.calls.some((call) => call[0] === "play"));
});

test("release failures unblock the next resolve and Stop cannot revive a canceled selection", () => {
    const f = create();
    startSession(f);
    f.nas.open();
    f.c.selectMedia(0);
    const release = f.requests.at(-1);
    assert.equal(release.options.timeout, 5000);
    release.options.complete(); // Timeout/error completion is best-effort, never a permanent queue lock.
    assert.equal(f.requests.at(-1).options.type, "POST");
    const next = f.requests.at(-1);
    next.reply({ stop: secondStop, url: "https://player.invalid/second.m3u8" });
    f.nas.open();
    f.c.selectMedia(0);
    const secondRelease = f.requests.at(-1);
    f.c.__ottClassicPlayback.command({ type: "stop" });
    const count = f.requests.length;
    secondRelease.reply("");
    assert.equal(
        f.requests.length,
        count,
        "retired waiter cannot issue a new playback request"
    );
});

test("cleanup never follows off-origin or unsigned arbitrary stop URLs", () => {
    for (const stop of [
        "https://attacker.invalid/nas/stream/first.signature/media.bin",
        "https://player.invalid.evil/nas/stream/first.signature/media.bin",
        "https://player.invalid/admin/delete",
        "//player.invalid/nas/stream/first.signature/media.bin",
    ]) {
        const f = create();
        startSession(f, stop);
        const count = f.requests.length;
        f.nas.dispose();
        assert.equal(f.requests.length, count);
    }
});

console.log(`PASS NAS library (${passed} integrated scenarios)`);
