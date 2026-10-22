const assert = require("node:assert/strict");
const { fixture } = require("./test_port_vod.cjs");
const { sourceFunctions } = require("./test_port_vod.cjs");
const vm = require("node:vm");
const plain = (value) => JSON.parse(JSON.stringify(value));
let groups = 0;
const cases = [];
function test(name, run) {
    cases.push(async () => {
        await run();
        groups++;
        console.log("PASS " + name);
    });
}

test("Scalar navigation reads and highlights never copy a catalog", () => {
    require("./helpers/media-read-cost.cjs").assertMediaReadContract(fixture());
});

test("Scoped internal snapshots detach metadata and preserve full public snapshots", () => {
    const c = fixture();
    require("./helpers/media-read-cost.cjs").trackMediaSnapshots(c);
    let reads = 0;
    let rendered;
    const library = c.__ottMediaLibrary.create({
        describe: (rows) => rows,
        items: () => [],
        load: (route, done) =>
            done([
                {
                    payload: {
                        get title() {
                            reads++;
                            return route.title;
                        },
                    },
                    ref: { itemId: route.title, sourceId: "scope-fixture" },
                    title: route.title,
                },
            ]),
        render: (view) => {
            rendered = view;
        },
    });
    library.open({ kind: "catalog", target: "parent", title: "Parent" });
    library.open({ kind: "catalog", target: "child", title: "Child" });
    assert.equal(rendered.frames[0].items.length, 0);
    assert.equal(rendered.frame.items[0].title, "Child");
    reads = 0;
    const navigation = library.snapshot("none");
    assert.equal(reads, 0, "Navigation reads no ancestor or current payloads");
    navigation.frame.route.title = "Poisoned route";
    const current = library.snapshot("current");
    assert.equal(reads, 1, "Current scope reads only the visible page");
    assert.equal(current.frame.route.title, "Child");
    current.frame.items[0].payload.title = "Poisoned current item";
    reads = 0;
    const all = library.snapshot();
    assert.equal(reads, 2, "Public default still detaches every page");
    assert.equal(all.frames[0].items[0].payload.title, "Parent");
    assert.equal(all.frame.items[0].payload.title, "Child");
});

test("Filter and paging copy costs exclude ancestor payloads at catalog scale", () => {
    const { mediaFilterCost } = require("./helpers/media-filter-cost.cjs");
    for (const rows of [300, 1000]) {
        const depth = 6;
        const cost = mediaFilterCost({ depth, rows, samples: 1 });
        assert(
            cost.filterOpen.objects <= depth * 4,
            "Opening the editor must copy only page metadata"
        );
        assert(
            cost.show.objects <= rows * 19 + depth * 4,
            "Rendering must detach current UI and provider projections only"
        );
        assert(
            cost.filterApplyAndClear.objects <= rows * 30 + depth * 40,
            "Refiltering must not clone retained parent pages"
        );
        assert(
            cost.nextAndBack.objects <= rows * 50 + depth * 40,
            "Paging cost must not include prior pages' payloads"
        );
    }
});

test("Facade highlight and screen release read revision without detached snapshots", () => {
    const c = fixture();
    const counts = require("./helpers/media-read-cost.cjs").trackMediaSnapshots(
        c
    );
    c.showPage = () => c.__ottClassicScreenPort.commitList();
    c.catalogs[""] = Array.from({ length: 1000 }, (_, id) => ({
        id,
        stream_url: id + ".mp4",
        title: "Movie " + id,
    }));
    c.mediaList(null);
    const revision = c.__ottMedia.snapshot().revision;
    const original = c.__ottMedia.capture();
    counts.reset();
    c.__ottMedia.highlight(999, revision);
    assert.equal(counts.snapshots, 0);
    assert.equal(
        counts.selects,
        0,
        "highlight does not request a detached item"
    );
    assert.equal(original(), false);
    const selected = c.__ottMedia.snapshot();
    assert.equal(selected.frame.selected, 999);
    c.__ottMedia.highlight(1, revision - 1);
    assert.equal(c.__ottMedia.snapshot().frame.selected, 999);
    counts.reset();
    c.__ottMedia.favorite(selected.frame.items[999].payload);
    assert.equal(
        counts.snapshots,
        1,
        "favorite captures its navigation context once"
    );
    assert.equal(c.documentState().favorites[0].itemId, "provider:999");
    counts.reset();
    c.__ottClassicScreenPort.listOwner().close();
    assert.equal(
        counts.snapshots,
        0,
        "screen cleanup compares only scalar revision"
    );
    assert.notEqual(c.__ottMedia.snapshot().revision, revision);
});

test("Owned frames restore selection and ignore poisoned UI projections", () => {
    const c = fixture();
    c.mediaList(null);
    c.selectMedia(1);
    c.mediaUrls = [-1, -2];
    c.mediaNames = ["poison"];
    c.mediaSelects = [99];
    c.mediaKeyHandler(c.keys.RETURN);
    assert.equal(c.listArray[1].title, "Folder");
    assert.equal(c.selIndex, 1);
    assert.equal(c.__ottMedia.snapshot().frame.route.kind, "catalog");
    c.listArray[1].title = "mutated renderer";
    c.__ottMedia.show();
    assert.equal(c.listArray[1].title, "Folder");
    c.selIndex = 0;
    c.detailListActionFn();
    c.closeList();
    c.mediaList(null);
    assert.equal(
        c.selIndex,
        0,
        "Highlight is an owned input and survives closing/reopening"
    );
});

test("Cold history re-resolves origin and resumes stable ID after signed URL changes", () => {
    const first = fixture();
    first.catalogs[""] = [
        { id: 42, stream_url: "old-token.mp4", title: "Film" },
    ];
    first.mediaList(null);
    first.selectMedia(0);
    first.setCurrent(0, -1);
    const cold = fixture();
    Object.assign(cold.stored, first.stored);
    cold.catalogs[""] = [
        { id: 42, stream_url: "new-token.mp4", title: "Renamed film" },
    ];
    cold.mediaList(null);
    cold.selectMedia(
        cold.listArray.findIndex((item) => item.__ottMediaRoute === "history")
    );
    cold.selectMedia(0);
    assert(
        cold.calls.some(
            (call) => call[0] === "play" && call[1] === "new-token.mp4"
        )
    );
    cold.confirm();
    assert.deepEqual(cold.calls.at(-1), ["seek", 120]);
    assert.equal(cold.documentState().history.length, 1);
    assert.equal(cold.documentState().history[0].payload.title, "Renamed film");
});

test("Back cancels history URL resolution and its late response cannot start playback", () => {
    const c = fixture();
    c.catalogs[""] = [{ id: 42, stream_url: "old.mp4", title: "Film" }];
    c.mediaList(null);
    c.selectMedia(0);
    c.setCurrent(0, -1);
    c.mediaList(null);
    c.selectMedia(
        c.listArray.findIndex((item) => item.__ottMediaRoute === "history")
    );
    const original = c.getMediaArray;
    let pending;
    // Keep the same provider resource identity; its transport becomes asynchronous.
    c.catalogs[""] = [{ id: 42, stream_url: "fresh.mp4", title: "Film" }];
    const provider = function (target, done) {
        if (pending === false) {
            pending = done;
            return;
        }
        original(target, done);
    };
    c.getMediaArray = provider;
    c.mediaList(null);
    c.selectMedia(
        c.listArray.findIndex((item) => item.__ottMediaRoute === "history")
    );
    pending = false;
    const plays = c.calls.filter((call) => call[0] === "play").length;
    c.selectMedia(0);
    assert.equal(typeof pending, "function");
    c.mediaKeyHandler(c.keys.RETURN);
    c.mediaRecords = c.catalogs[""];
    pending();
    assert.equal(c.calls.filter((call) => call[0] === "play").length, plays);
});

test("Provider resolve port is owned, one-shot and revoked by Back", () => {
    const c = fixture();
    let done,
        cancelled = 0;
    c.providerMediaClient = {
        cancel() {
            cancelled++;
        },
        resolve(item, next) {
            done = next;
        },
    };
    c.mediaList(null);
    c.selectMedia(1);
    c.selectMedia(0);
    c.mediaKeyHandler(c.keys.RETURN);
    done({ id: 8, stream_url: "late.mp4", title: "Late" });
    assert(!c.calls.some((call) => call[0] === "play"));
    assert(cancelled > 0);
    c.selectMedia(0);
    const current = done;
    current({ id: 9, stream_url: "ready.mp4", title: "Ready" });
    current({ id: 9, stream_url: "twice.mp4", title: "Again" });
    assert.equal(c.calls.filter((call) => call[0] === "play").length, 1);
});

test("Same account source survives stream URL renewal, distinct account and slot do not share", () => {
    const c = fixture();
    let user = "alice";
    c.p_pref = "xt";
    c.__ottActiveProviderDriver = {
        credentials: () => ({
            password: "pw",
            server: "https://portal.invalid",
            username: user,
        }),
    };
    c._playMedia({ id: 1, stream_url: "a.mp4", title: "Movie" });
    c.setCurrent(0, -1);
    const alice = c.__ottMedia.sourceId();
    user = "bob";
    c._playMedia({ id: 1, stream_url: "b.mp4", title: "Movie" });
    const bob = c.__ottMedia.sourceId();
    assert.notEqual(alice, bob);
    assert.equal(c.documentState().history[0].position, 0);
    assert.equal(
        JSON.parse(c.stored["mediaJournal.v1:" + alice]).history[0].position,
        125.9
    );
    c.p_pref = "m3u";
    c.m3uArr = {
        active: 0,
        M3Us: [
            { medSourceId: "a", www: "https://one.invalid" },
            { medSourceId: "b", www: "https://two.invalid" },
        ],
    };
    c._playMedia({ id: 1, stream_url: "zero.mp4", title: "Slot0" });
    const zero = c.__ottMedia.sourceId();
    c.m3uArr.active = 1;
    c._playMedia({ id: 1, stream_url: "one.mp4", title: "Slot1" });
    assert.notEqual(zero, c.__ottMedia.sourceId());
    assert.equal(c.documentState().history[0].position, 0);
});

test("Legacy adoption marker prevents account switch importing another account history", () => {
    const c = fixture();
    let account = "a";
    c.p_pref = "xt";
    c.__ottActiveProviderDriver = {
        credentials: () => ({
            password: "pw",
            server: "portal",
            username: account,
        }),
    };
    c.stored.medHistory = JSON.stringify([
        { current: 99, id: 11, stream_url: "old", title: "Legacy" },
    ]);
    c.mediaList(null);
    assert.equal(c.documentState().history.length, 1);
    account = "b";
    c.mediaList(null);
    assert.equal(c.documentState(), null);
    c._playMedia({ id: 12, stream_url: "own", title: "Own" });
    assert.equal(c.documentState().history.length, 1);
    assert.equal(c.documentState().history[0].payload.title, "Own");
});

test("Unavailable history entry never falls back to its expired URL", () => {
    const c = fixture();
    c.catalogs[""] = [{ id: 1, stream_url: "old", title: "Removed" }];
    c.mediaList(null);
    c.selectMedia(0);
    c.setCurrent(0, -1);
    c.catalogs[""] = [];
    c.mediaList(null);
    c.selectMedia(
        c.listArray.findIndex((item) => item.__ottMediaRoute === "history")
    );
    const count = c.calls.filter((call) => call[0] === "play").length;
    c.selectMedia(0);
    assert.equal(c.calls.filter((call) => call[0] === "play").length, count);
    assert(
        c.calls.some(
            (call) =>
                call[0] === "message" && call[1].includes("no longer available")
        )
    );
});

test("Same-title episodes retain separate provider/request identities", () => {
    const c = fixture();
    c._playMedia({
        request: { cmd: "play", episode: 1 },
        stream_url: "one",
        title: "Same",
    });
    c.setCurrent(0, -1);
    c._playMedia({
        request: { cmd: "play", episode: 2 },
        stream_url: "two",
        title: "Same",
    });
    assert.equal(c.documentState().history.length, 2);
    c._playMedia({
        request: { cmd: "play", episode: 1 },
        stream_url: "renewed",
        title: "Same",
    });
    c.confirm();
    assert.deepEqual(c.calls.at(-1), ["seek", 120]);
    assert.equal(c.documentState().history.length, 2);
});

test("Incremental provider page publication is accepted only for its frame", () => {
    const c = fixture();
    let completion;
    c.getMediaArray = (_route, done) => {
        completion = done;
        c.mediaRecords = [{ id: 1, stream_url: "old", title: "Loading" }];
        done();
    };
    c.mediaList(null);
    completion.publish(
        [{ id: 1, stream_url: "ready", title: "Ready" }],
        "Page",
        0
    );
    assert.equal(c.listArray[0].title, "Ready");
    const old = completion;
    c.mediaList("another");
    old.publish([{ id: 1, stream_url: "stale", title: "Stale" }]);
    assert.equal(c.listArray[0].title, "Loading");
});

test("Domain abort reentry cannot pop or publish the replacement navigation", () => {
    const c = fixture(),
        frames = [];
    let library, pending;
    const item = {
        payload: {},
        ref: { itemId: "i", sourceId: "s" },
        title: "Item",
    };
    library = c.__ottMediaLibrary.create({
        describe: () => [item],
        items: () => [item],
        load: (_route, done) => {
            pending = done;
            return () =>
                library.open({ kind: "favorites", title: "Replacement" }, true);
        },
        render: (view) => frames.push(view),
    });
    library.open({ kind: "catalog", target: "old", title: "Old" });
    library.close();
    pending([{}]);
    assert.equal(library.snapshot().frame.route.title, "Replacement");
    assert.equal(frames.length, 1);
});

test("Future or malformed journal versions are not overwritten; failed writes retain state", () => {
    const c = fixture();
    for (const raw of ['{"version":42}', "{broken"]) {
        const values = { "mediaJournal.v1:s": raw };
        let writes = 0;
        const journal = c.__ottMediaJournal.create({
            core: c.OttPlayCore,
            importRows: () => [],
            limit: () => 20,
            read: (key) => values[key] || null,
            sourceId: "s",
            write: () => writes++,
        });
        assert.equal(journal.read().writable, false);
        assert.equal(
            journal.change("visit", {
                itemId: "i",
                payload: {},
                position: 0,
                sourceId: "s",
            }),
            false
        );
        assert.equal(writes, 0);
    }
    const values = {};
    let fail = false;
    const journal = c.__ottMediaJournal.create({
        core: c.OttPlayCore,
        importRows: () => [],
        limit: () => 20,
        read: (key) => values[key] || null,
        sourceId: "s",
        write: (key, value) => {
            if (fail) throw Error("quota");
            values[key] = value;
        },
    });
    journal.read();
    fail = true;
    assert.equal(
        journal.change("visit", {
            itemId: "i",
            payload: {},
            position: 0,
            sourceId: "s",
        }),
        false
    );
    assert.equal(journal.read().document.history.length, 0);
});

test("Copying metadata never executes prototype setters or shares nested data", () => {
    const c = fixture();
    const data = JSON.parse(
        '{"__proto__":{"polluted":true},"nested":{"value":1}}'
    );
    const detached = c.__ottMediaLibrary.copy(data);
    detached.nested.value = 2;
    assert.equal(data.nested.value, 1);
    assert.equal({}.polluted, undefined);
    assert.equal(
        Object.prototype.hasOwnProperty.call(detached, "__proto__"),
        true
    );
    assert.deepEqual(plain(detached.__proto__), { polluted: true });
});

test("Metadata copies isolate sibling references and cut only ancestor cycles", () => {
    const c = fixture();
    const shared = { value: 1 };
    const source = { array: [shared], first: shared, second: shared };
    source.self = source;
    shared.parent = source;
    const seen = Object.freeze([]);
    const copy = c.__ottMediaLibrary.copy(source, seen);
    assert.equal(copy.self, undefined);
    assert.equal(copy.first.parent, undefined);
    assert.equal(copy.second.value, 1);
    assert.notEqual(copy.first, copy.second);
    assert.notEqual(copy.first, copy.array[0]);
    copy.first.value = 2;
    assert.equal(copy.second.value, 1);
    assert.equal(shared.value, 1);
    assert.equal(seen.length, 0);
});

test("Actual Edem lazy-page codec publishes detached updates without global-array ownership", () => {
    const { edemFixture } = require("./helpers/edem-driver-fixture.cjs");
    const f = edemFixture();
    f.mount("edem");
    f.host.sPageSize = 0.2;
    let rows,
        updates = 0;
    const done = () => {
        rows = f.host.mediaRecords;
        f.host.mediaRecords = [];
    };
    done.publish = (next, _title, selected) => {
        rows = next;
        updates++;
        assert.equal(selected, 3);
    };
    f.host.getMediaArray("", done);
    f.requests[0].resolve({
        count: 6,
        items: [{ title: "One", type: "stream" }, { type: "next" }],
        type: "category",
    });
    f.host.selIndex = 3;
    rows[3].description();
    assert.equal(f.requests.length, 2);
    f.requests[1].resolve({
        items: [
            { title: "Two", type: "stream" },
            { title: "Three", type: "stream" },
        ],
    });
    assert.equal(updates, 1);
    assert.equal(rows[3].title, "Three");
    assert.equal(f.host.mediaRecords.length, 0);
    f.host.selIndex = 5;
    rows[5].description();
    f.host.providerMediaClient.cancel();
    f.requests[2].resolve({ items: [{ title: "Stale", type: "stream" }] });
    assert.equal(updates, 1);
});

test("Actual VPortal quality resolver retains parent ownership and starts only selected quality", () => {
    for (const action of ["accept", "back", "replace"]) {
        const c = fixture(),
            requests = [];
        vm.runInContext(
            sourceFunctions("src/plugins/vportal.ts", [
                "parseVPortalLink",
                "createVPortalClient",
            ]),
            c
        );
        c.$.ajax = (options) => {
            const request = { abort() {}, options };
            requests.push(request);
            return request;
        };
        c.closeList = () => {
            c.__ottClassicScreenPort.closeList();
            c.cancelMediaLoad();
        };
        c.showPage = () => c.__ottClassicScreenPort.commitList();
        c.providerMediaClient = c.createVPortalClient(
            "portal::[key:fixture]https://portal.test/api"
        );
        c.getMediaArray = c.providerMediaClient.load;
        const reply = (index, data) => {
            requests[index].options.success(data);
            requests[index].options.complete();
        };
        c.mediaList(null);
        reply(0, {
            items: [
                {
                    request: { cmd: "play", id: 42 },
                    title: "Film",
                    type: "stream",
                },
            ],
            type: "category",
        });
        const parent = c.__ottClassicScreenPort.listOwner();
        c.selectMedia(0);
        reply(1, {
            url: "https://low",
            variants: { high: "https://high", low: "https://low" },
        });
        assert.equal(c.calls.filter((call) => call[0] === "play").length, 0);
        assert(parent.active());
        const saved = c.selectBoxKeyHandler;
        if (action === "back") {
            saved(c.keys.RETURN);
            saved(c.keys.ENTER);
            assert(parent.active());
            assert.equal(
                c.calls.filter((call) => call[0] === "play").length,
                0
            );
        } else if (action === "replace") {
            c.listArray = [{ title: "Other screen" }];
            c.listDataArray = c.listArray;
            c.showPage();
            saved(c.keys.ENTER);
            assert(!parent.active());
            assert.equal(
                c.calls.filter((call) => call[0] === "play").length,
                0
            );
        } else {
            saved(c.keys.LEFT);
            saved(c.keys.ENTER);
            assert(
                c.calls.some(
                    (call) => call[0] === "play" && call[1] === "https://high"
                )
            );
            assert.equal(c.documentState().history.length, 1);
        }
    }
});

test("Disabled persistence can be re-enabled without poisoning the journal and retired resume prompts cannot seek", () => {
    const c = fixture();
    c.sFavorites = -1;
    c.mediaList(null);
    c.selectMedia(0);
    assert(
        !Object.keys(c.stored).some((key) => key.indexOf("mediaJournal") === 0)
    );
    c.__ottClassicPlayback.command({ type: "stop" });
    c.sFavorites = 0;
    c._playMedia({ id: 5, stream_url: "enabled.mp4", title: "Enabled" });
    c.setCurrent(0, -1);
    c.__ottClassicPlayback.command({ type: "stop" });
    c._playMedia({ id: 5, stream_url: "renewed.mp4", title: "Enabled" });
    assert.equal(c.documentState().history[0].itemId, "provider:5");
    const seeks = c.calls.filter((call) => call[0] === "seek").length;
    c.__ottClassicPlayback.command({ type: "stop" });
    c.confirm();
    assert.equal(c.calls.filter((call) => call[0] === "seek").length, seeks);
});

test("Actual Edem portal ownership changes source identity without issuing transport", () => {
    const { edemFixture } = require("./helpers/edem-driver-fixture.cjs");
    const f = edemFixture(),
        c = fixture();
    f.driver = f.mount("edem");
    c.__ottActiveProviderDriver = f.driver;
    c.p_pref = "ed";
    const before = c.__ottMedia.sourceId(),
        count = f.requests.length;
    const television = c.__ottClassicPlayback.sourceId();
    assert.equal(c.__ottMedia.sourceId(), before);
    f.driver.saveSettings({
        ...f.driver.settings(),
        portal: "portal::[key:replacement]https://portal.test/api",
    });
    assert.notEqual(c.__ottMedia.sourceId(), before);
    assert.equal(c.__ottClassicPlayback.sourceId(), television);
    assert.equal(f.requests.length, count);
});

test("Screen replacement owns pending media while internal rendering and quality suspension preserve it", () => {
    const c = fixture();
    let cleanups = [];
    const replace = () => {
        const old = cleanups;
        cleanups = [];
        old.forEach((fn) => fn());
    };
    c.__ottClassicScreenPort = {
        listOwner: () => ({ own: (fn) => cleanups.push(fn) }),
    };
    const render = c.__ottRenderMedia;
    c.__ottRenderMedia = (view) => {
        replace();
        render(view);
    };
    c.mediaList(null);
    c.selectMedia(1);
    assert.equal(c.__ottMedia.snapshot().frame.route.target, "catalog.xml");
    const original = c.getMediaArray;
    let callback;
    c.getMediaArray = (url, done) => {
        if (url === "pending") callback = done;
        else original(url, done);
    };
    c.mediaList(null);
    c.requestMediaList("pending");
    assert(callback.isCurrent());
    replace();
    assert(!callback.isCurrent());
    c.mediaRecords = [{ stream_url: "late.mp4", title: "Stale" }];
    callback();
    assert(!c.listArray.some((row) => row.title === "Stale"));
});

test("Rejected nonthrowing writes cannot publish journal changes or claim imported data", () => {
    const c = fixture(),
        values = {};
    let reject = false;
    const journal = c.__ottMediaJournal.create({
        core: c.OttPlayCore,
        importRows: () => [],
        limit: () => 20,
        read: (key) => values[key] || null,
        sourceId: "s",
        write: (key, value) => {
            if (!reject) values[key] = value;
        },
    });
    journal.read();
    reject = true;
    assert.equal(
        journal.change("favorite", {
            itemId: "i",
            payload: {},
            position: 0,
            sourceId: "s",
        }),
        false
    );
    assert.equal(journal.read().document.favorites.length, 0);
    const f = fixture();
    f.stored.medHistory = JSON.stringify([
        { stream_url: "old.mp4", title: "Old" },
    ]);
    f.providerSetItem = () => {};
    f.mediaList(-1);
    assert.equal(f.listArray.length, 1);
    assert.equal(f.listArray[0].__ottMediaFilter, true);
    assert(
        !Object.keys(f.stored).some(
            (key) => key.indexOf("mediaJournalLegacyOwner") === 0
        )
    );
});

test("Synchronous source replacement during storage reads cannot publish the old account projections", () => {
    const c = fixture();
    const replacement = [{ title: "Replacement" }];
    const get = c.providerGetItem;
    c.providerGetItem = (key) => {
        if (key.indexOf("mediaJournal.v1:") === 0) {
            c.p_pref = "replacement";
            c.medHistory = replacement;
            c.medFavorites = replacement;
        }
        return get(key);
    };
    c.mediaList(-1);
    assert.equal(c.medHistory, replacement);
    assert.equal(c.medFavorites, replacement);
    assert(
        !Object.keys(c.stored).some((key) => key.indexOf("mediaJournal") === 0)
    );
});

function episodeFixture(ids = [30, 2, 11]) {
    const c = fixture();
    c.catalogs[""] = ids.map((id) => ({
        __ottMediaSequence: true,
        id,
        request: { fid: id },
        title: "Episode " + id,
    }));
    c.catalogs[""].splice(1, 0, {
        playlist_url: "elsewhere",
        title: "Navigation",
    });
    c.resolutions = [];
    c.providerMediaClient = {
        cancel() {},
        resolve(item, done, automatic) {
            c.resolutions.push({ automatic, item });
            const resolved = {
                ...item,
                stream_url:
                    item.id +
                    "-" +
                    (c.fixedUrls ? 1 : c.resolutions.length) +
                    ".mp4",
            };
            if (c.defer) c.pendingEpisode = () => done(resolved);
            else done(resolved);
        },
    };
    c.closeList = () => c.__ottMedia.cancel();
    c.stbStop = () => {
        c.__ottMedia.cancelAuto();
        c.__ottClassicPlayback.command({ type: "stop" });
    };
    c.finishEpisode = () => {
        c.__ottClassicPlayback.command({ type: "stop" });
        c.__ottMedia.ended(c.__ottClassicPlayback.snapshot().generation);
    };
    c.mediaList(null);
    c.selectMedia(0);
    return c;
}

test("Episode completion preserves provider order, resolves fresh URLs and loops last to first", () => {
    const c = episodeFixture();
    c.settings.stopPlay = true;
    const first = c.__ottMedia.current();
    c.__ottClassicPlayback.command({
        duration: 600,
        position: 599,
        type: "position",
    });
    c.__ottMedia.checkpoint(first.ref, 599, true);
    c.finishEpisode();
    assert.equal(
        c.documentState().history.find((row) => row.itemId === first.ref.itemId)
            .position,
        0,
        "The next episode's departure checkpoint cannot restore the completed position"
    );
    c.finishEpisode();
    c.finishEpisode();
    assert.deepEqual(
        c.resolutions.map((row) => row.item.id),
        [30, 2, 11, 30]
    );
    assert.deepEqual(
        c.resolutions.map((row) => row.automatic),
        [false, true, true, true]
    );
    assert.deepEqual(
        c.calls.filter((row) => row[0] === "play").map((row) => row[1]),
        ["30-1.mp4", "2-2.mp4", "11-3.mp4", "30-4.mp4"]
    );
    assert(
        !c.calls.some((row) => row[0] === "confirm"),
        "automatic restarts do not prompt to resume"
    );
    assert.equal(
        c.documentState().history.find((row) => row.itemId === first.ref.itemId)
            .position,
        0
    );
});

test("Automatic episode completion preserves a reopened browsing menu", () => {
    const c = episodeFixture();
    const browsing = [{ title: "Reopened browsing menu" }];
    c.listArray = c.listDataArray = browsing;
    c.closeList = () => {
        c.__ottMedia.cancelAuto();
        assert.fail("Automatic playback must not dismiss the current menu");
    };
    c.finishEpisode();
    assert.deepEqual(
        c.resolutions.map((row) => row.item.id),
        [30, 2]
    );
    assert.strictEqual(c.listArray, browsing);
    assert.strictEqual(c.listDataArray, browsing);
    assert.equal(c.calls.filter((row) => row[0] === "play").length, 2);
});

test("A synchronous Stop during the next episode's journal write cancels its playback", () => {
    const c = fixture();
    const write = c.providerSetItem;
    let armed = false;
    c.providerSetItem = (key, value) => {
        write(key, value);
        if (
            armed &&
            key.startsWith("mediaJournal.v1:") &&
            JSON.parse(value).history[0]?.itemId === "provider:2"
        ) {
            armed = false;
            c.__ottMedia.cancelAuto();
            c.__ottClassicPlayback.command({ type: "stop" });
        }
    };
    c.catalogs[""] = [
        { __ottMediaSequence: true, id: 1, stream_url: "one.mp4" },
        { __ottMediaSequence: true, id: 2, stream_url: "two.mp4" },
    ];
    c.mediaList(null);
    c.selectMedia(0);
    const first = c.__ottMedia.current();
    armed = true;
    c.__ottClassicPlayback.command({ type: "stop" });
    c.__ottMedia.ended(c.__ottClassicPlayback.snapshot().generation);
    assert.equal(armed, false, "The cancellation ran inside the journal write");
    assert.strictEqual(c.__ottMedia.current(), first);
    assert.equal(c.calls.filter((row) => row[0] === "play").length, 1);
});

test("Single episode loops; ordinary films and saved collections never become episode queues", () => {
    const single = episodeFixture([7]);
    single.finishEpisode();
    assert.deepEqual(
        single.resolutions.map((row) => row.item.id),
        [7, 7]
    );
    const movie = fixture();
    movie.mediaList(null);
    movie.selectMedia(0);
    movie.__ottClassicPlayback.command({ type: "stop" });
    movie.__ottMedia.ended(movie.__ottClassicPlayback.snapshot().generation);
    assert.equal(movie.calls.filter((row) => row[0] === "play").length, 1);
    for (const collection of [-1, -2]) {
        const c = episodeFixture();
        c.__ottMedia.favorite(c.__ottMedia.current().payload);
        c.mediaList(collection);
        c.selectMedia(0);
        const count = c.resolutions.length;
        c.finishEpisode();
        assert.equal(c.resolutions.length, count);
    }
});

test("Duplicate completion, Stop, Back, source replacement and manual selection revoke auto resolve", () => {
    for (const cancel of ["stop", "back", "source", "select"]) {
        const c = episodeFixture();
        c.defer = true;
        c.finishEpisode();
        const done = c.pendingEpisode;
        const generation = c.__ottClassicPlayback.snapshot().generation;
        c.__ottMedia.ended(generation);
        assert.equal(c.resolutions.length, 2, "completion dispatches once");
        if (cancel === "stop") c.stbStop();
        else if (cancel === "back") c.__ottMedia.back();
        else if (cancel === "source") c.providerGetItem = () => null;
        else {
            c.defer = false;
            c.__ottMedia.select(3);
        }
        const plays = c.calls.filter((row) => row[0] === "play").length;
        done();
        assert.equal(
            c.calls.filter((row) => row[0] === "play").length,
            plays,
            cancel
        );
    }
});

test("Auto-next respects parental access and Stop or navigation revokes a pending PIN", () => {
    for (const action of ["allow", "stop", "back"]) {
        const c = fixture();
        c.catalogs[""] = [
            { __ottMediaSequence: true, id: 1, stream_url: "one.mp4" },
            {
                __ottMediaSequence: true,
                adult: 1,
                id: 2,
                stream_url: "two.mp4",
            },
        ];
        c.mediaList(null);
        c.selectMedia(0);
        c.__ottClassicPlayback.command({ type: "stop" });
        c.__ottMedia.ended(c.__ottClassicPlayback.snapshot().generation);
        assert.equal(typeof c.unlock, "function");
        assert.equal(c.calls.filter((row) => row[0] === "play").length, 1);
        if (action === "stop") c.__ottMedia.cancelAuto();
        if (action === "back") c.__ottMedia.back();
        c.parentAccess = true;
        c.unlock();
        assert.equal(
            c.calls.filter((row) => row[0] === "play").length,
            action === "allow" ? 2 : 1
        );
    }
});

function applyTitleFilter(c, value) {
    c.__ottMedia.filter();
    c.editvar = value;
    c.setEdit();
}

test("Title filter matches series and films while preserving navigation across pages and Back", () => {
    const c = fixture();
    c.catalogs[""] = [{ playlist_url: "series", title: "Cartoon series" }];
    c.catalogs.series = [
        { __ottMediaFilterable: true, playlist_url: "cats", title: "Три кота" },
        {
            __ottMediaFilterable: true,
            playlist_url: "other",
            title: "Другой сериал",
        },
        { stream_url: "movie.mp4", title: "Три кота: фильм" },
        { stream_url: "other.mp4", title: "Другой фильм" },
        { playlist_url: "page2", title: "Next" },
        { playlist_url: "search", search_on: 1, title: "Search" },
    ];
    c.catalogs.page2 = [
        { __ottMediaFilterable: true, playlist_url: "other2", title: "Другие" },
        { playlist_url: "page3", title: "Next" },
    ];
    c.catalogs.page3 = [
        {
            __ottMediaFilterable: true,
            playlist_url: "more",
            title: "ТРИ КОТА — новое",
        },
    ];
    c.mediaList(null);
    applyTitleFilter(c, "  ТРИ   КОТ  ");
    c.selectMedia(0);
    assert.deepEqual(plain(c.listArray.map((row) => row.title)), [
        "Три кота",
        "Три кота: фильм",
        "Next",
        "Search",
        "Filter: ТРИ   КОТ",
    ]);
    c.selectMedia(2);
    assert.deepEqual(plain(c.listArray.map((row) => row.title)), [
        "Next",
        "Filter: ТРИ   КОТ",
    ]);
    c.selectMedia(0);
    assert.equal(c.listArray[0].title, "ТРИ КОТА — новое");
    c.__ottMedia.back();
    c.__ottMedia.back();
    assert.equal(c.__ottMedia.snapshot().filter, "ТРИ   КОТ");
    assert.equal(c.listArray.length, 5);
    const fetches = c.calls.filter((call) => call[0] === "fetch").length;
    applyTitleFilter(c, "");
    assert.equal(
        c.listArray.length,
        7,
        "clear restores the already loaded full page"
    );
    assert.equal(c.calls.filter((call) => call[0] === "fetch").length, fetches);
});

test("Filter preserves selected identity, rejects stale editors and resets with the source", () => {
    const c = fixture();
    c.catalogs[""] = [
        { id: 1, stream_url: "a", title: "Other" },
        { id: 2, stream_url: "b", title: "Ёжик" },
    ];
    c.mediaList(null);
    c.__ottMedia.highlight(1, c.__ottMedia.snapshot().revision);
    applyTitleFilter(c, "еж");
    assert.equal(c.__ottMedia.snapshot().frame.selected, 0);
    assert.equal(c.listArray[0].id, 2);
    c.__ottMedia.filter();
    const stale = c.setEdit;
    applyTitleFilter(c, "other");
    c.editvar = "stale";
    stale();
    assert.equal(c.__ottMedia.snapshot().filter, "other");
    c.__ottMedia.filter();
    const retired = c.setEdit;
    c.providerGetItem = () => null;
    c.mediaList(null);
    c.editvar = "retired";
    retired();
    assert.equal(c.__ottMedia.snapshot().filter, "");
    assert.equal(c.listArray[0].title, "Other");
    const filter = c.listArray.find((row) => row.__ottMediaFilter);
    c.__ottMedia.favorite(filter);
    assert.equal(c.medFavorites.length, 0);
});

test("Filtering retains incremental page ownership and never leaks the unfiltered catalog", () => {
    const c = fixture();
    let publish;
    c.getMediaArray = (_target, done) => {
        publish = done.publish;
        c.mediaRecords = [
            { id: 1, stream_url: "a", title: "Other" },
            { id: 2, stream_url: "b", title: "Match" },
        ];
        done();
    };
    c.mediaList(null);
    applyTitleFilter(c, "match");
    publish(
        [
            { id: 1, stream_url: "a", title: "Other" },
            { id: 3, stream_url: "c", title: "Match fresh" },
        ],
        "Updated",
        1
    );
    assert.equal(c.listArray[0].id, 3);
    assert.equal(
        c.__ottMedia.snapshot().frame.selected,
        0,
        "provider raw selection maps to its filtered item"
    );
    const view = c.__ottMedia.snapshot();
    assert.equal(view.frame.catalog, undefined);
    assert.equal(c.mediaRecords.filter((row) => row.stream_url).length, 2);
    assert(!c.mediaRecords.some((row) => row.__ottMediaFilter));
    c.listArray[0].title = "Poisoned projection";
    applyTitleFilter(c, "");
    assert.equal(c.listArray[1].title, "Match fresh");
});

test("Applying a filter cancels a pending manual resolver and rejects its late result", () => {
    const c = fixture();
    let pending;
    let cancellations = 0;
    c.providerMediaClient = {
        cancel() {
            cancellations++;
        },
        resolve(_item, done) {
            pending = done;
        },
    };
    c.catalogs[""] = [
        { id: 1, stream_url: "first.mp4", title: "First" },
        { id: 2, stream_url: "other.mp4", title: "Other" },
    ];
    c.mediaList(null);
    c.selectMedia(0);
    const before = cancellations;
    applyTitleFilter(c, "other");
    assert(cancellations > before, "The pending transport is cancelled");
    assert.equal(pending.isCurrent(), false);
    pending({ id: 1, stream_url: "late.mp4", title: "First" });
    assert.equal(c.calls.filter((call) => call[0] === "play").length, 0);
    assert.equal(c.listArray[0].id, 2);
});

test("Incremental provider appends retain hidden media without copying view controls", () => {
    const c = fixture();
    let publish;
    c.getMediaArray = (_target, done) => {
        publish = done.publish;
        c.mediaRecords = [
            { id: 1, stream_url: "a", title: "Other" },
            { id: 2, stream_url: "b", title: "Match" },
        ];
        done();
    };
    c.mediaList(null);
    applyTitleFilter(c, "match");
    assert.deepEqual(plain(c.mediaRecords.map((row) => row.id)), [1, 2]);
    c.mediaRecords.push({ id: 3, stream_url: "c", title: "Match fresh" });
    publish(c.mediaRecords, "Updated", 2);
    for (const route of ["history", "favorites"])
        assert.equal(
            c.listArray.filter((row) => row.__ottMediaRoute === route).length,
            1,
            "Incremental results must not duplicate " + route
        );
    assert.equal(c.listArray.filter((row) => row.__ottMediaFilter).length, 1);
    assert.equal(c.__ottMedia.snapshot().frame.selected, 1);
    assert.equal(c.listArray[1].id, 3);
    applyTitleFilter(c, "");
    assert.deepEqual(
        plain(c.listArray.filter((row) => row.id).map((row) => row.id)),
        [1, 2, 3]
    );
});

test("Title filtering leaves explicit episodes and their autoplay order intact", () => {
    const c = episodeFixture();
    c.stbStop();
    applyTitleFilter(c, "Episode 30");
    assert.deepEqual(
        plain(
            c.listArray
                .filter((row) => row.__ottMediaSequence)
                .map((row) => row.id)
        ),
        [30, 2, 11]
    );
    c.selectMedia(0);
    c.finishEpisode();
    c.finishEpisode();
    assert.deepEqual(
        c.resolutions.slice(-3).map((row) => row.item.id),
        [30, 2, 11]
    );
});

test("Saving the Filter row focuses the first matching media instead of the control", () => {
    const c = fixture();
    c.catalogs[""] = [
        { id: 1, stream_url: "a", title: "Other" },
        { id: 2, stream_url: "b", title: "Match" },
    ];
    c.mediaList(null);
    c.selectMedia(c.listArray.findIndex((row) => row.__ottMediaFilter));
    c.editvar = "match";
    c.setEdit();
    assert.equal(c.__ottMedia.snapshot().frame.selected, 0);
    assert.equal(c.listArray[0].id, 2);
    c.selectMedia(c.listArray.findIndex((row) => row.__ottMediaFilter));
    c.editvar = "";
    c.setEdit();
    assert.equal(c.__ottMedia.snapshot().frame.selected, 0);
    assert.equal(c.listArray[0].id, 1);
});

test("Saved episode entries remain filterable in history and favorites", () => {
    const c = episodeFixture();
    c.finishEpisode();
    c.__ottMedia.favorite(c.listArray.find((row) => row.id === 30));
    c.__ottMedia.favorite(c.listArray.find((row) => row.id === 2));
    for (const target of [-1, -2]) {
        c.__ottMedia.open(target);
        applyTitleFilter(c, "Episode 30");
        assert.deepEqual(
            plain(c.listArray.filter((row) => row.id).map((row) => row.id)),
            [30]
        );
        applyTitleFilter(c, "no matching title");
        assert.equal(c.listArray.length, 1);
        assert.equal(c.listArray[0].__ottMediaFilter, true);
        applyTitleFilter(c, "");
        assert.equal(c.listArray.filter((row) => row.id).length, 2);
    }
});

test("Independent NAS leases preserve foreground catalogs while automatic episodes resolve", () => {
    for (const catalogFirst of [false, true]) {
        const c = fixture(),
            requests = [],
            timers = new Map();
        let timerId = 0,
            catalogs = 0;
        const played = [];
        c.location = { host: "player.test", protocol: "https:" };
        c.__OTTPLAY_HOSTED__ = { version: 1, vportal: { routes: [] } };
        c.setInterval = (run) => {
            timers.set(++timerId, run);
            return timerId;
        };
        c.clearInterval = (id) => timers.delete(id);
        vm.runInContext(
            sourceFunctions("src/plugins/vportal.ts", [
                "parseVPortalLink",
                "createVPortalClient",
            ]),
            c
        );
        c.$.ajax = (options) => {
            const request = {
                abort() {
                    this.aborted = true;
                    options.error?.({}, "abort");
                    options.complete?.();
                },
                aborted: false,
                options,
                reply(data) {
                    options.success?.(data);
                    options.complete?.();
                },
            };
            requests.push(request);
            return request;
        };
        const source = "nas:independent",
            client = c.createVPortalClient("", {
                directEndpoint: "/nas/api",
                preferDefault: true,
                sourceId: source,
            });
        const payload = (id) => ({
            request: { cmd: "play", id },
            title: "Episode",
            vportalSource: source,
        });
        const lease = (id) => ({
            heartbeat:
                "https://player.test/nas/stream/ping" + id + ".sig/media.ts",
            stop: "https://player.test/nas/stream/stop" + id + ".sig/media.ts",
            url:
                "https://player.test/nas/stream/video" + id + ".sig/media.m3u8",
        });
        client.resolve(payload(1), (item) => played.push(item));
        requests.at(-1).reply(lease(1));
        client.load(
            { request: { cmd: "browse" }, vportalSource: source },
            () => catalogs++
        );
        const catalog = requests.at(-1);
        client.resolve(payload(2), (item) => played.push(item), true);
        assert.equal(catalog.aborted, false);
        assert.equal(
            requests.at(-1).options.url,
            "/nas/stream/stop1.sig/media.ts"
        );
        assert.equal(timers.size, 0);
        requests.at(-1).reply("");
        const episode = requests.at(-1);
        assert.equal(
            episode.options.url,
            "/nas/api",
            "An installation keeps its explicit endpoint on hosted pages"
        );
        assert.equal(JSON.parse(episode.options.data).key, undefined);
        const catalogReply = () =>
            catalog.reply({ items: [], type: "category" });
        if (catalogFirst) catalogReply();
        episode.reply(lease(2));
        if (!catalogFirst) catalogReply();
        assert.equal(catalogs, 1);
        assert.equal(played.length, 2);
        assert.equal(timers.size, 1);
        client.cancelAutomatic();
        assert.equal(
            timers.size,
            1,
            "Automatic cancellation preserves admitted playback"
        );
        client.resolve(payload(3), (item) => played.push(item));
        requests.at(-1).reply("");
        const foreground = requests.at(-1);
        foreground.options.success(lease(3));
        const count = requests.length;
        client.cancelAutomatic();
        assert.equal(
            requests.length,
            count,
            "A pending foreground lease does not belong to the automatic request lane"
        );
        foreground.options.complete();
        assert.equal(played.length, 3);
        assert.equal(timers.size, 1);
        client.dispose();
        assert.equal(timers.size, 0);
        assert.equal(
            requests.at(-1).options.url,
            "/nas/stream/stop3.sig/media.ts"
        );
    }
});

function remoteQueueFixture() {
    const c = fixture();
    c.commandChannelsReady = false;
    c.resolutions = [];
    c.replies = [];
    c.providerMediaClient = {
        cancel() {},
        cancelAutomatic() {},
        resolve(item, done, automatic) {
            c.resolutions.push({ automatic, item });
            const playable = {
                ...item,
                stream_url: item.id + "-" + c.resolutions.length + ".mp4",
            };
            c.completeResolve = () => done(playable);
            if (!c.deferResolve) c.completeResolve();
        },
        search(query, done, guard) {
            c.searchQuery = query;
            c.completeSearch = (items, error) => {
                if (guard()) done({ error, items });
            };
            return () => {
                c.searchCancelled = true;
            };
        },
    };
    vm.runInContext(
        sourceFunctions("src/commands/remote-requests.ts", [
            "executeRemoteRequest",
        ]),
        c
    );
    c.requestQueue = (action = "vportal", query = "  Фильм  ") =>
        c.executeRemoteRequest({ action, params: { query } }, (reply) =>
            c.replies.push(plain(reply))
        );
    c.finishItem = () => {
        c.__ottClassicPlayback.command({ type: "stop" });
        c.__ottMedia.ended(c.__ottClassicPlayback.snapshot().generation);
    };
    return c;
}

test("Remote VPortal queue loops every result in order with fresh URLs and no resume or quality prompt", () => {
    for (const ids of [[30, 2, 11], [7]]) {
        const c = remoteQueueFixture();
        c.requestQueue();
        assert.equal(c.searchQuery, "Фильм");
        assert.equal(c.resolutions.length, 0, "Wait for the complete search");
        c.completeSearch(
            ids.map((id) => ({ id, request: { id }, title: "Фильм " + id }))
        );
        assert.equal(
            c.replies.length,
            1,
            JSON.stringify({
                calls: c.calls,
                resolutions: c.resolutions,
                state: c.__ottClassicPlayback.snapshot(),
            })
        );
        assert.deepEqual(c.replies[0], {
            data: {
                dispatched: true,
                items: ids.map((id, index) => ({
                    number: index + 1,
                    title: "Фильм " + id,
                })),
                loop: true,
                total: ids.length,
            },
            status: "ok",
        });
        for (let n = 0; n < ids.length; n++) c.finishItem();
        assert.deepEqual(
            c.resolutions.map((row) => row.item.id),
            [...ids, ids[0]]
        );
        assert(c.resolutions.every((row) => row.automatic));
        assert.equal(
            c.calls.filter((row) => row[0] === "play").length,
            ids.length + 1
        );
        assert(
            !c.calls.some((row) => row[0] === "confirm" || row[0] === "pin")
        );
        assert(!JSON.stringify(c.replies).includes(".mp4"));
    }
});

test("VPortal kiosk captures requests, restores the episode cursor and renews URLs", () => {
    function configured() {
        const c = remoteQueueFixture();
        c.p_pref = "vportal";
        c.__ottActiveProviderDriver = {
            configuration: () => ({ active: 0 }),
            credentials: () => ({
                playlist: "portal::[key:private]https://portal.invalid/api/",
            }),
            id: "vportal",
        };
        return c;
    }
    const c = configured();
    c.requestQueue();
    c.completeSearch(
        [1, 2].map((id) => ({ id, request: { id }, title: "Episode " + id }))
    );
    c.__ottMedia.keepKioskLoop();
    c.finishItem();
    c.__ottClassicPlayback.command({
        duration: 600,
        position: 42,
        type: "position",
    });
    const selected = c.__ottMedia.kioskSelection();
    assert(selected);
    assert.equal(selected.index, 1);
    assert.equal(selected.position, 42);
    assert.equal(selected.records.length, 2);
    assert(!JSON.stringify(selected).includes(".mp4"));
    selected.records[0].request.id = 999;
    assert.equal(
        c.__ottMedia.current().sequence.items[0].payload.request.id,
        1,
        "saved selection is detached"
    );
    const saved = c.__ottMedia.kioskSelection();
    const restored = configured();
    assert.equal(
        restored.__ottMedia.restoreKiosk(saved, () => true),
        true
    );
    assert.equal(restored.resolutions[0].item.request.id, 2);
    assert.equal(restored.__ottMedia.current().sequence.repeat, "all");
    restored.finishItem();
    assert.equal(restored.resolutions.at(-1).item.request.id, 1);
    assert.equal(
        restored.__ottMedia.restoreKiosk(
            { ...saved, source: "another-profile" },
            () => true
        ),
        false
    );
    restored.deferResolve = true;
    let enabled = true;
    restored.__ottMedia.restoreKiosk(saved, () => enabled);
    const before = restored.calls.filter((row) => row[0] === "play").length;
    enabled = false;
    restored.completeResolve();
    assert.equal(
        restored.calls.filter((row) => row[0] === "play").length,
        before,
        "unlock rejects late resume"
    );
});

function isolateQueueRandom(c, random) {
    const playQueue = c.__ottMedia.playQueue;
    c.Math = Object.create(Math);
    c.__ottMedia.playQueue = function (...args) {
        // The shared core also draws object identity hashes. Count only the
        // remote queue construction, before handing records to the runtime.
        c.Math.random = Math.random;
        return playQueue(...args);
    };
    const arm = () => {
        c.Math.random = random;
    };
    arm();
    return arm;
}

test("Random remote VPortal queues shuffle a copy once and repeat the same complete permutation", () => {
    const c = remoteQueueFixture();
    c.deferResolve = true;
    const draws = [0, 0, 0, 0.99, 0.99, 0.99];
    let randomCalls = 0;
    const armShuffle = isolateQueueRandom(c, () => {
        assert(
            randomCalls < draws.length,
            "No extra shuffle on next or repeat"
        );
        return draws[randomCalls++];
    });
    const records = Object.freeze(
        [1, 2, 3, 4].map((id) =>
            Object.freeze({ id, request: { id }, title: "Три кота " + id })
        )
    );
    const original = plain(records);
    const playQueue = c.__ottMedia.playQueue;
    const queues = [];
    c.__ottMedia.playQueue = function (...args) {
        queues.push(args[0]);
        return playQueue(...args);
    };
    c.requestQueue("vportal_random", "  ТРИ КОТА  ");
    assert.equal(c.searchQuery, "ТРИ КОТА");
    assert.equal(randomCalls, 0, "Wait for the complete collection");
    c.completeSearch(records);
    assert.equal(randomCalls, records.length - 1);
    assert.equal(queues.length, 1);
    assert.notEqual(queues[0], records);
    assert.deepEqual(plain(queues[0].map((item) => item.id)), [2, 3, 4, 1]);
    assert.deepEqual(plain(records), original);
    assert.equal(c.replies.length, 0, "No acknowledgement before dispatch");
    c.completeResolve();
    const order = [2, 3, 4, 1];
    assert.deepEqual(c.replies, [
        {
            data: {
                dispatched: true,
                items: order.map((id, index) => ({
                    number: index + 1,
                    title: "Три кота " + id,
                })),
                loop: true,
                shuffled: true,
                total: 4,
            },
            status: "ok",
        },
    ]);
    c.deferResolve = false;
    for (let n = 0; n < order.length * 2; n++) c.finishItem();
    assert.deepEqual(
        c.resolutions.map((row) => row.item.id),
        [...order, ...order, order[0]]
    );
    assert.equal(randomCalls, records.length - 1);
    assert.equal(queues.length, 1, "Repeat uses the existing queue");
    assert.equal(
        new Set(c.calls.filter((row) => row[0] === "play").map((row) => row[1]))
            .size,
        9,
        "Each visit resolves a fresh URL"
    );
    assert(!JSON.stringify(c.replies).includes(".mp4"));
    c.requestQueue("vportal_random");
    armShuffle();
    c.completeSearch(records);
    assert.equal(randomCalls, 6, "A new request shuffles again");
    assert.equal(queues.length, 2);
    assert.deepEqual(
        c.replies[1].data.items.map((item) => item.title),
        original.map((item) => item.title)
    );
    assert.deepEqual(plain(records), original);
});

test("A 477-result random VPortal queue acknowledges every item in playback order and wraps once", () => {
    const c = remoteQueueFixture();
    let randomCalls = 0;
    isolateQueueRandom(c, () => {
        randomCalls++;
        return 0;
    });
    const records = Object.freeze(
        Array.from({ length: 477 }, (_, index) =>
            Object.freeze({
                id: index + 1,
                request: { id: index + 1 },
                title: "Film " + (index + 1),
            })
        )
    );
    const original = plain(records);
    const queues = [];
    const playQueue = c.__ottMedia.playQueue;
    c.__ottMedia.playQueue = function (...args) {
        assert.equal(
            randomCalls,
            476,
            "Exactly one Fisher-Yates pass before dispatch"
        );
        queues.push(args[0]);
        return playQueue(...args);
    };
    c.requestQueue("vportal_random");
    c.completeSearch(records);
    const order = [...Array.from({ length: 476 }, (_, index) => index + 2), 1];
    assert.equal(queues.length, 1);
    assert.notEqual(queues[0], records);
    assert.deepEqual(plain(queues[0].map((item) => item.id)), order);
    assert.equal(new Set(queues[0].map((item) => item.id)).size, 477);
    assert.deepEqual(c.replies, [
        {
            data: {
                dispatched: true,
                items: order.map((id, index) => ({
                    number: index + 1,
                    title: "Film " + id,
                })),
                loop: true,
                shuffled: true,
                total: 477,
            },
            status: "ok",
        },
    ]);
    for (let index = 0; index < records.length; index++) c.finishItem();
    assert.deepEqual(
        c.resolutions.map((row) => row.item.id),
        [...order, order[0]]
    );
    assert.equal(
        queues.length,
        1,
        "Natural completion reuses the existing permutation"
    );
    assert.equal(
        randomCalls,
        476,
        "Advancement never constructs another shuffle"
    );
    assert.deepEqual(plain(records), original);
});

test("Ordinary VPortal playback and listing never shuffle provider order", () => {
    for (const action of ["vportal", "vportal_search"]) {
        const c = remoteQueueFixture();
        isolateQueueRandom(c, () => {
            assert.fail("Ordered requests must not shuffle");
        });
        c.requestQueue(action);
        c.completeSearch(
            [3, 1, 2].map((id) => ({
                id,
                request: { id },
                title: "Film " + id,
            }))
        );
        assert.deepEqual(
            c.replies[0].data.items.map((item) => item.title),
            ["Film 3", "Film 1", "Film 2"]
        );
        assert.equal(c.replies[0].data.shuffled, undefined);
        assert.equal(c.resolutions.length, action === "vportal" ? 1 : 0);
    }
});

test("Random VPortal empty and single-result queues need no random draws", () => {
    for (const count of [0, 1]) {
        const c = remoteQueueFixture();
        isolateQueueRandom(c, () => assert.fail("No random draw needed"));
        c.requestQueue("vportal_random");
        c.completeSearch(
            count ? [{ id: 7, request: { id: 7 }, title: "Film" }] : []
        );
        if (!count) {
            assert.equal(c.replies[0].status, "rejected");
            assert.equal(c.resolutions.length, 0);
        } else {
            assert.equal(c.replies[0].data.shuffled, true);
            assert.equal(c.replies[0].data.loop, true);
            assert.equal(c.replies[0].data.total, 1);
            c.finishItem();
            assert.deepEqual(
                c.resolutions.map((row) => row.item.id),
                [7, 7]
            );
        }
    }
});

test("Random VPortal keeps complete-result, metadata, query and parental guards", () => {
    for (const params of [
        {},
        { query: "" },
        { query: "   " },
        { query: "я".repeat(513) },
        { query: "\ud800" },
        { extra: true, query: "film" },
    ]) {
        const c = remoteQueueFixture();
        c.executeRemoteRequest({ action: "vportal_random", params }, (reply) =>
            c.replies.push(plain(reply))
        );
        assert.equal(c.replies[0].status, "rejected");
        assert.equal(c.searchQuery, undefined);
    }
    for (const result of ["partial", "oversized", "parental", "timeout"]) {
        const c = remoteQueueFixture();
        c.requestQueue("vportal_random");
        if (result === "timeout") c.timers.at(-1)();
        c.completeSearch(
            [
                {
                    adult: result === "parental" ? 1 : 0,
                    id: 1,
                    request: { id: 1 },
                    title: result === "oversized" ? "x".repeat(500000) : "Film",
                },
            ],
            result === "partial" ? "PRIVATE provider error" : undefined
        );
        assert.equal(c.replies[0].status, "rejected", result);
        assert.equal(c.resolutions.length, 0, result);
        assert(!JSON.stringify(c.replies).includes("PRIVATE"));
    }
    const missing = remoteQueueFixture();
    delete missing.providerMediaClient.search;
    missing.requestQueue("vportal_random");
    assert.equal(missing.replies[0].status, "unsupported");
});

test("Random VPortal cancellation, Stop and source changes reject late search or stream results", () => {
    for (const at of ["search", "resolve"]) {
        for (const action of ["cancel", "stop", "source"]) {
            const c = remoteQueueFixture();
            c.deferResolve = true;
            const records = [1, 2].map((id) => ({
                id,
                request: { id },
                title: "Film " + id,
            }));
            const cancel = c.requestQueue("vportal_random");
            if (at === "resolve") c.completeSearch(records);
            if (action === "cancel") cancel();
            if (action === "stop") {
                c.__ottMedia.cancelAuto();
                c.__ottClassicPlayback.command({ type: "stop" });
            }
            if (action === "source") c.providerMediaClient = {};
            if (at === "search") c.completeSearch(records);
            else c.completeResolve();
            assert.equal(c.resolutions.length, at === "resolve" ? 1 : 0);
            assert.equal(c.replies.length, 0);
            assert.equal(c.calls.filter((row) => row[0] === "play").length, 0);
        }
    }
});

test("Remote VPortal list-only and empty or failed searches never start a queue", () => {
    const listing = remoteQueueFixture();
    listing.requestQueue("vportal_search");
    listing.completeSearch([
        {
            id: 1,
            request: { key: "not-public" },
            stream_url: "https://private.invalid/video?token=secret",
            title: "Film",
        },
    ]);
    assert.deepEqual(listing.replies, [
        {
            data: { items: [{ number: 1, title: "Film" }], total: 1 },
            status: "ok",
        },
    ]);
    assert.equal(listing.resolutions.length, 0);
    for (const error of [undefined, "provider URL and key must not leak"]) {
        const c = remoteQueueFixture();
        c.requestQueue();
        c.completeSearch([], error);
        assert.equal(c.replies[0].status, "rejected");
        assert.equal(c.resolutions.length, 0);
        assert(!JSON.stringify(c.replies).includes("must not leak"));
    }
});

test("A replacement remote queue restarts its shared first item and advances through the new selection", () => {
    const c = remoteQueueFixture();
    c.fixedUrls = true;
    for (const ids of [
        [1, 2],
        [1, 3],
    ]) {
        c.requestQueue();
        c.completeSearch(
            ids.map((id) => ({ id, request: { id }, title: "Film " + id }))
        );
    }
    assert.equal(c.replies.length, 2);
    assert.equal(c.calls.filter((row) => row[0] === "play").length, 2);
    c.finishItem();
    assert.deepEqual(
        c.resolutions.map((row) => row.item.id),
        [1, 1, 3]
    );
});

test("Repeated Stop while already stopped cancels a pending remote search", () => {
    const c = remoteQueueFixture();
    c.__ottClassicPlayback.reconcile();
    c.__ottClassicPlayback.command({ type: "stop" });
    c.requestQueue();
    const generation = c.__ottClassicPlayback.snapshot().generation;
    c.__ottMedia.cancelAuto();
    c.__ottClassicPlayback.command({ type: "stop" });
    assert.equal(c.__ottClassicPlayback.snapshot().generation, generation);
    c.completeSearch([{ id: 1, request: { id: 1 }, title: "Film" }]);
    assert.equal(c.resolutions.length, 0);
    assert.equal(c.replies.length, 0);
    assert.equal(c.calls.filter((row) => row[0] === "play").length, 0);
});

test("Oversized remote queue metadata is rejected before playback dispatch", () => {
    const c = remoteQueueFixture();
    c.requestQueue();
    c.completeSearch([
        { id: 1, request: { id: 1 }, title: "я".repeat(500000) },
    ]);
    assert.equal(c.replies[0].status, "rejected");
    assert.match(c.replies[0].data.error, /more specific/);
    assert.equal(c.resolutions.length, 0);
});

test("Remote VPortal validates queries and rejects unavailable or parental-locked queues", () => {
    for (const query of ["", "   ", "я".repeat(513), "\ud800"]) {
        const c = remoteQueueFixture();
        c.requestQueue("vportal", query);
        assert.equal(c.replies[0].status, "rejected");
        assert.equal(c.searchQuery, undefined);
    }
    const missing = remoteQueueFixture();
    delete missing.providerMediaClient.search;
    missing.requestQueue();
    assert.equal(missing.replies[0].status, "unsupported");
    const locked = remoteQueueFixture();
    locked.requestQueue();
    locked.completeSearch([
        { adult: 1, id: 1, request: { id: 1 }, title: "Film" },
    ]);
    assert.equal(locked.replies[0].status, "rejected");
    assert.equal(locked.resolutions.length, 0);
    assert(!locked.calls.some((row) => row[0] === "pin"));
});

test("Remote request cancellation, Stop and source replacement block late search and stream replies", () => {
    for (const at of ["search", "resolve"]) {
        for (const action of ["cancel", "stop", "source"]) {
            const c = remoteQueueFixture();
            c.deferResolve = true;
            const cancel = c.requestQueue();
            if (at === "resolve")
                c.completeSearch([
                    { id: 1, request: { id: 1 }, title: "Film" },
                ]);
            if (action === "cancel") cancel();
            if (action === "stop") {
                c.__ottMedia.cancelAuto();
                c.__ottClassicPlayback.command({ type: "stop" });
            }
            if (action === "source") c.providerMediaClient = {};
            if (at === "search")
                c.completeSearch([
                    { id: 1, request: { id: 1 }, title: "Film" },
                ]);
            else c.completeResolve();
            assert.equal(
                c.calls.filter((row) => row[0] === "play").length,
                0,
                at + ": " + action
            );
            assert.equal(c.replies.length, 0);
        }
    }
});

test("A remote queue's direct-URL identity retains its provider page when reloaded from history", () => {
    const c = remoteQueueFixture();
    c.requestQueue();
    const origin = {
        kind: "catalog",
        target: "provider-page",
        title: "Provider page",
    };
    c.completeSearch([
        {
            __ottMediaOrigin: origin,
            stream_url: "old.mp4",
            title: "Same title",
        },
    ]);
    const original = c.__ottMedia.current().ref.itemId;
    c.__ottMedia.checkpoint(c.__ottMedia.current().ref, 150, true);
    c.catalogs["provider-page"] = [
        { stream_url: "renewed.mp4", title: "Same title" },
    ];
    c.mediaList(-1);
    c.selectMedia(0);
    assert.equal(c.__ottMedia.current().ref.itemId, original);
    assert.equal(
        c.resolutions.length,
        2,
        "History found the item in its originating page"
    );
});

function folderQueueFixture(ids = [1, 2, 3], collect = true) {
    const c = fixture();
    c.Math = Object.create(Math);
    c.Math.random = () => 0;
    c.catalogs[""] = ids.map((id) => ({
        id,
        request: { id },
        title: "Movie " + id,
    }));
    c.resolutions = [];
    c.collectionCancels = 0;
    c.providerMediaClient = {
        cancel() {},
        cancelAutomatic() {},
        resolve(item, done, automatic) {
            c.resolutions.push({ automatic, item: plain(item) });
            const resolved = {
                ...item,
                stream_url: item.id + "-" + c.resolutions.length + ".mp4",
            };
            c.completeResolve = () => done(resolved);
            if (!c.deferResolve) c.completeResolve();
        },
    };
    if (collect)
        c.providerMediaClient.collect = (target, done, guard) => {
            c.collectedTarget = target;
            c.collectionGuard = guard;
            c.completeCollection = (items = c.catalogs[""], error) =>
                done({ error, items });
            return () => c.collectionCancels++;
        };
    c.closeList = () => c.__ottMedia.cancel();
    c.stbStop = () => {
        c.__ottMedia.cancelAuto();
        c.__ottClassicPlayback.command({ type: "stop" });
    };
    c.finishItem = () => {
        c.__ottClassicPlayback.command({ type: "stop" });
        c.__ottMedia.ended(c.__ottClassicPlayback.snapshot().generation);
    };
    c.mediaList(null);
    return c;
}

test("Folder shuffle waits for all collected pages, filters and deduplicates playable items", () => {
    const c = folderQueueFixture();
    applyTitleFilter(c, "movie");
    assert.equal(c.__ottMedia.snapshot().canShuffle, true);
    c.__ottMedia.shufflePlay();
    assert.equal(c.resolutions.length, 0);
    const rows = [
        ...c.catalogs[""],
        { id: 4, request: { id: 4 }, title: "Movie 4 from page 2" },
        { id: 5, request: { id: 5 }, title: "Unrelated" },
        c.catalogs[""][0],
        { playlist_url: "folder", title: "Movie Folder" },
        { playlist_url: "next", title: "Next" },
    ];
    c.completeCollection(rows);
    assert.equal(
        c.calls.filter((row) => row[0] === "play").length,
        1,
        JSON.stringify({
            calls: c.calls,
            current: c.__ottMedia.current(),
            state: c.__ottClassicPlayback.snapshot(),
        })
    );
    rows[1].title = "Changed after queue admission";
    for (let n = 0; n < 4; n++) c.finishItem();
    assert.deepEqual(
        c.resolutions.map((row) => row.item.id),
        [2, 3, 4, 1, 2]
    );
    assert.equal(c.resolutions[0].item.title, "Movie 2");
    assert(c.resolutions.every((row) => row.automatic));
    assert(!c.calls.some((row) => row[0] === "confirm"));
    assert.equal(c.__ottMedia.snapshot().repeat, "all");
});

test("Folder queue Repeat One refreshes current URLs and Repeat Off stops after the last item", () => {
    const c = folderQueueFixture();
    c.__ottMedia.shufflePlay();
    c.completeCollection();
    c.__ottMedia.cycleRepeat();
    assert.equal(c.__ottMedia.snapshot().repeat, "one");
    c.finishItem();
    c.finishItem();
    assert.deepEqual(
        c.resolutions.map((row) => row.item.id),
        [2, 2, 2]
    );
    assert.equal(
        new Set(c.calls.filter((row) => row[0] === "play").map((row) => row[1]))
            .size,
        3
    );
    c.__ottMedia.cycleRepeat();
    assert.equal(c.__ottMedia.snapshot().repeat, "off");
    c.finishItem();
    c.finishItem();
    c.finishItem();
    c.finishItem();
    assert.deepEqual(
        c.resolutions.map((row) => row.item.id),
        [2, 2, 2, 3, 1]
    );
    assert.equal(c.__ottClassicPlayback.snapshot().phase, "stopped");
    assert.equal(
        c.documentState().history.find((row) => row.itemId === "provider:1")
            .position,
        0
    );
});

test("Shuffle reports pending and active modes, then restores provider order without restarting", () => {
    const c = folderQueueFixture();
    assert.equal(c.__ottMedia.snapshot().shuffle, "off");
    c.__ottMedia.toggleShuffle();
    assert.equal(c.__ottMedia.snapshot().shuffle, "loading");
    c.completeCollection();
    assert.equal(c.__ottMedia.snapshot().shuffle, "on");
    assert.equal(c.__ottMedia.current().payload.id, 2);
    c.finishItem();
    assert.equal(c.__ottMedia.snapshot().shuffle, "on", "EOF retains the mode");
    assert.equal(c.__ottMedia.current().payload.id, 3);
    const generation = c.__ottClassicPlayback.snapshot().generation;
    c.__ottMedia.toggleShuffle();
    assert.equal(c.__ottMedia.snapshot().shuffle, "off");
    assert.equal(c.__ottClassicPlayback.snapshot().generation, generation);
    assert.deepEqual(
        plain(
            c.__ottMedia.current().sequence.items.map((item) => item.payload.id)
        ),
        [1, 2, 3]
    );
    assert.equal(c.__ottMedia.current().sequence.index, 2);
    c.finishItem();
    assert.equal(
        c.__ottMedia.current().payload.id,
        1,
        "Repeat All uses provider order"
    );
});

test("Toggling pending shuffle off cancels collection, PIN and resolution", () => {
    for (const phase of ["collect", "pin", "resolve"]) {
        const c = folderQueueFixture();
        if (phase === "pin") c.catalogs[""][1].adult = 1;
        if (phase === "resolve") c.deferResolve = true;
        c.__ottMedia.toggleShuffle();
        if (phase !== "collect") c.completeCollection();
        assert.equal(c.__ottMedia.snapshot().shuffle, "loading");
        const late =
            phase === "collect"
                ? c.completeCollection
                : phase === "pin"
                  ? c.unlock
                  : c.completeResolve;
        c.__ottMedia.toggleShuffle();
        assert.equal(c.__ottMedia.snapshot().shuffle, "off");
        c.parentAccess = true;
        late();
        assert.equal(
            c.calls.filter((row) => row[0] === "play").length,
            0,
            phase
        );
    }
});

test("Moving the highlight preserves a folder shuffle during collection, PIN and resolution", () => {
    for (const phase of ["collect", "pin", "resolve"]) {
        const c = folderQueueFixture();
        c.showPage = () => c.__ottClassicScreenPort.commitList();
        c.closeList = () => c.__ottClassicScreenPort.closeList();
        if (phase === "pin") c.catalogs[""][1].adult = 1;
        if (phase === "resolve") c.deferResolve = true;
        c.mediaList("");
        c.__ottMedia.toggleShuffle();
        if (phase !== "collect") c.completeCollection();
        const complete =
            phase === "collect"
                ? c.completeCollection
                : phase === "pin"
                  ? c.unlock
                  : c.completeResolve;
        c.selIndex = 2;
        c.detailListActionFn();
        assert.equal(c.__ottMedia.snapshot().frame.selected, 2, phase);
        assert.equal(c.collectionGuard(), true, phase);
        assert.equal(c.__ottMedia.snapshot().shuffle, "loading", phase);
        assert.equal(c.calls.filter((row) => row[0] === "play").length, 0);
        c.parentAccess = true;
        complete();
        assert.equal(c.__ottMedia.current().payload.id, 2, phase);
        assert.equal(c.__ottMedia.snapshot().shuffle, "on", phase);
        assert.equal(c.calls.filter((row) => row[0] === "play").length, 1);
        complete();
        assert.equal(
            c.calls.filter((row) => row[0] === "play").length,
            1,
            phase + ": a late duplicate cannot replay the first item"
        );
    }
});

test("External overlays retire pending shuffle work without closing or repainting the overlay", () => {
    for (const phase of ["collect", "resolve"])
        for (const kind of ["editor", "dialog", "picker"]) {
            const c = folderQueueFixture();
            const port = c.__ottClassicScreenPort;
            c.showPage = () => port.commitList();
            c.closeList = () => port.closeList();
            c.mediaList("");
            c.__ottMedia.toggleShuffle();
            if (phase === "resolve") {
                c.deferResolve = true;
                c.completeCollection();
            }
            const late =
                phase === "collect" ? c.completeCollection : c.completeResolve;
            const listOwner = port.listOwner();
            const overlay = port.openOverlay(kind, () => {});
            const projection = JSON.stringify(c.listArray);
            late();
            assert.equal(c.__ottMedia.snapshot().shuffle, "off", phase + kind);
            assert.equal(c.calls.filter((row) => row[0] === "play").length, 0);
            assert.equal(overlay.active() && overlay.foreground(), true);
            assert.equal(port.listOwner(), listOwner);
            assert.equal(JSON.stringify(c.listArray), projection);
            port.close(kind);
            late();
            assert.equal(c.calls.filter((row) => row[0] === "play").length, 0);
        }
});

test("Actual PIN cancellation, denial and replacement clear shuffle while only a current grant may play", async () => {
    for (const outcome of ["cancelled", "denied", "replaced", "accepted"]) {
        const c = folderQueueFixture();
        const port = c.__ottClassicScreenPort;
        c.showPage = () => port.commitList();
        c.closeList = () => port.closeList();
        for (let digit = 0; digit < 10; digit++)
            c.keys["N" + digit] = 48 + digit;
        const jquery = c.$;
        c.$ = (selector) => Object.assign(jquery(selector), { length: 1 });
        require("./helpers/access-runtime.cjs")(c);
        const deferred = [];
        const setTimeout = c.setTimeout;
        c.setTimeout = (callback, delay) => {
            if (delay === 0) return deferred.push(callback);
            return setTimeout(callback, delay);
        };
        const flushDeferred = () => {
            while (deferred.length) deferred.shift()();
        };
        const settlePin = require("./helpers/protected-pin-fixture.cjs")(
            c,
            "2468",
            flushDeferred
        );
        vm.runInContext(
            sourceFunctions("src/channels/index.ts", ["enterPinAndSetAccess"]),
            c
        );
        c.catalogs[""][1].adult = 1;
        c.mediaList("");
        c.__ottMedia.toggleShuffle();
        c.completeCollection();
        const old = c.dialogBoxKeyHandler;
        assert.equal(c.__ottMedia.snapshot().shuffle, "loading", outcome);
        let replacement;
        if (outcome === "cancelled") old(c.keys.RETURN);
        else if (outcome === "replaced") {
            replacement = port.setOwnedCallback("dialog", () => {});
            while (c.timers.length) c.timers.shift()();
        } else
            for (const digit of outcome === "accepted" ? "2468" : "0000")
                old(c.keys["N" + digit]);
        assert.equal(
            c.calls.filter((row) => row[0] === "play").length,
            0,
            "no playback before actual async verification"
        );
        flushDeferred();
        await settlePin();
        assert.equal(
            c.__ottMedia.snapshot().shuffle,
            outcome === "accepted" ? "on" : "off",
            outcome
        );
        assert.equal(
            c.calls.filter((row) => row[0] === "play").length,
            outcome === "accepted" ? 1 : 0,
            outcome
        );
        if (replacement) assert.equal(replacement.owner.foreground(), true);
        for (const digit of "2468") old(c.keys["N" + digit]);
        flushDeferred();
        await settlePin();
        assert.equal(
            c.calls.filter((row) => row[0] === "play").length,
            outcome === "accepted" ? 1 : 0,
            outcome + ": retired PIN cannot authorize a late start"
        );
    }
});

test("Empty, failed and unresolvable shuffled queues clear the loading indicator", () => {
    for (const failure of ["empty", "error", "resolve"]) {
        const c = folderQueueFixture();
        if (failure === "resolve")
            c.providerMediaClient.resolve = (_item, done) => done(null);
        c.__ottMedia.toggleShuffle();
        if (failure === "resolve") c.completeCollection();
        else c.completeCollection([], failure === "error");
        assert.equal(c.__ottMedia.snapshot().shuffle, "off", failure);
        assert.equal(c.calls.filter((row) => row[0] === "play").length, 0);
    }
});

test("Disabling shuffle during EOF resolution cancels the old next item and resumes in order", () => {
    const c = folderQueueFixture();
    c.__ottMedia.toggleShuffle();
    c.completeCollection();
    c.deferResolve = true;
    c.finishItem();
    const stale = c.completeResolve;
    c.__ottMedia.toggleShuffle();
    stale();
    assert.equal(c.calls.filter((row) => row[0] === "play").length, 1);
    c.completeResolve();
    assert.equal(c.__ottMedia.current().payload.id, 3);
    assert.equal(c.__ottMedia.snapshot().shuffle, "off");
    c.deferResolve = false;
    c.finishItem();
    assert.equal(c.__ottMedia.current().payload.id, 1);
});

test("Reentrant Stop while cancelling an EOF resolver defeats shuffle and repeat changes", () => {
    for (const action of ["toggleShuffle", "cycleRepeat"]) {
        const c = folderQueueFixture();
        c.__ottMedia.toggleShuffle();
        c.completeCollection();
        c.deferResolve = true;
        c.finishItem();
        const late = c.completeResolve;
        const generation = c.__ottClassicPlayback.snapshot().generation;
        let stops = 0;
        c.providerMediaClient.cancelAutomatic = () => {
            stops++;
            c.stbStop();
        };
        c.__ottMedia[action]();
        late();
        c.__ottMedia.ended(generation);
        assert.equal(stops, 1, action);
        assert.deepEqual(
            c.resolutions.map((row) => row.item.id),
            [2, 3],
            action + ": Stop must prevent a replacement EOF resolver"
        );
        assert.equal(c.calls.filter((row) => row[0] === "play").length, 1);
        assert.equal(c.__ottClassicPlayback.snapshot().phase, "stopped");
        assert.equal(c.__ottMedia.snapshot().repeat, "all", action);
    }
});

test("Local single-item shuffle supports repeat off without requiring a provider collector", () => {
    const c = folderQueueFixture([7], false);
    c.__ottMedia.cycleRepeat();
    c.__ottMedia.cycleRepeat();
    c.__ottMedia.shufflePlay();
    c.finishItem();
    assert.deepEqual(
        c.resolutions.map((row) => row.item.id),
        [7]
    );
    c.mediaList(-1);
    assert.equal(c.__ottMedia.snapshot().canShuffle, false);
});

test("Explicit Repeat One applies to a current ordinary movie and later manual selection", () => {
    const c = folderQueueFixture([1, 2], false);
    c.selectMedia(0);
    assert.equal(c.__ottMedia.current().sequence, null);
    c.__ottMedia.cycleRepeat();
    c.finishItem();
    assert.deepEqual(
        c.resolutions.map((row) => row.item.id),
        [1, 1]
    );
    c.__ottMedia.select(1);
    c.finishItem();
    assert.deepEqual(
        c.resolutions.map((row) => row.item.id),
        [1, 1, 2, 2]
    );
});

test("Folder collection cancellation rejects late replies after Stop, Back, filter, selection or source change", () => {
    for (const action of [
        "stop",
        "back",
        "filter",
        "select",
        "select-pin",
        "source",
    ]) {
        const c = folderQueueFixture();
        if (action === "select-pin") {
            c.catalogs[""][1].adult = 1;
            c.mediaList("");
        }
        c.__ottMedia.shufflePlay();
        const late = c.completeCollection;
        if (action === "stop") c.stbStop();
        if (action === "back") c.__ottMedia.back();
        if (action === "filter") applyTitleFilter(c, "2");
        if (action === "select") c.__ottMedia.select(0);
        if (action === "select-pin") c.__ottMedia.select(1);
        if (action === "source") {
            c.p_pref = "new-account";
            c.mediaList(null);
        }
        const count = c.resolutions.length;
        assert(c.collectionCancels > 0, action);
        late();
        assert.equal(c.resolutions.length, count, action);
    }
});

test("New folder collection retires old EOS and superseded collectors cannot start a queue", () => {
    const c = folderQueueFixture();
    c.__ottMedia.shufflePlay();
    c.completeCollection();
    c.__ottMedia.shufflePlay();
    const old = c.completeCollection;
    c.__ottMedia.shufflePlay();
    old();
    assert.equal(c.resolutions.length, 1);
    c.finishItem();
    c.completeCollection();
    assert.equal(
        c.resolutions.length,
        1,
        "Old playback EOS cannot advance or revive collection"
    );
});

test("First shuffled adult item waits for PIN and cancellation revokes that intent", () => {
    for (const action of ["allow", "stop", "back", "repeat"]) {
        const c = folderQueueFixture();
        c.catalogs[""][1].adult = 1;
        c.__ottMedia.shufflePlay();
        c.completeCollection();
        assert.equal(c.resolutions.length, 0);
        assert.equal(typeof c.unlock, "function");
        if (action === "stop") c.stbStop();
        if (action === "back") c.__ottMedia.back();
        if (action === "repeat") c.__ottMedia.cycleRepeat();
        c.parentAccess = true;
        c.unlock();
        assert.equal(c.resolutions.length, action === "allow" ? 1 : 0, action);
    }
});

test("Repeat change reschedules owned EOS and rejects its old resolver or PIN callback", () => {
    for (const phase of ["pin", "resolve"]) {
        const c = folderQueueFixture();
        if (phase === "pin") c.catalogs[""][2].adult = 1;
        c.__ottMedia.shufflePlay();
        c.completeCollection();
        if (phase === "resolve") c.deferResolve = true;
        c.finishItem();
        const generation = c.__ottClassicPlayback.snapshot().generation;
        const late = phase === "pin" ? c.unlock : c.completeResolve;
        assert.equal(typeof late, "function");
        c.__ottMedia.cycleRepeat();
        const resolutions = c.resolutions.length;
        c.__ottMedia.ended(generation);
        assert.equal(
            c.resolutions.length,
            resolutions,
            "Duplicate EOS cannot add another request"
        );
        c.parentAccess = true;
        late();
        if (phase === "resolve") {
            assert.equal(c.calls.filter((row) => row[0] === "play").length, 1);
            c.completeResolve();
        }
        assert.equal(c.calls.filter((row) => row[0] === "play").length, 2);
        assert.equal(
            c.resolutions.at(-1).item.id,
            2,
            "New Repeat One replays current item"
        );
        c.__ottMedia.ended(generation);
        assert.equal(c.resolutions.length, resolutions);
    }
});

test("Repeat Off reschedules pending EOS to next in the middle and stops at the end", () => {
    for (const ids of [[1, 2, 3], [7]]) {
        const c = folderQueueFixture(ids);
        c.__ottMedia.shufflePlay();
        c.completeCollection();
        c.__ottMedia.cycleRepeat();
        c.deferResolve = true;
        c.finishItem();
        const late = c.completeResolve;
        c.__ottMedia.cycleRepeat();
        late();
        assert.equal(c.calls.filter((row) => row[0] === "play").length, 1);
        if (ids.length > 1) {
            assert.deepEqual(
                c.resolutions.map((row) => row.item.id),
                [2, 2, 3]
            );
            c.completeResolve();
            c.deferResolve = false;
            c.finishItem();
            c.finishItem();
            assert.deepEqual(
                c.resolutions.map((row) => row.item.id),
                [2, 2, 3, 1]
            );
        } else
            assert.deepEqual(
                c.resolutions.map((row) => row.item.id),
                [7, 7]
            );
        assert.equal(c.__ottClassicPlayback.snapshot().phase, "stopped");
    }
});

test("Repeat cannot revive a pending completion cancelled by Stop, Back or source replacement", () => {
    for (const action of ["stop", "back", "source"]) {
        const c = folderQueueFixture();
        c.__ottMedia.shufflePlay();
        c.completeCollection();
        c.deferResolve = true;
        c.finishItem();
        const late = c.completeResolve;
        if (action === "stop") c.stbStop();
        if (action === "back") c.__ottMedia.back();
        if (action === "source") {
            c.p_pref = "replacement";
            c.mediaList(null);
        }
        const count = c.resolutions.length;
        c.__ottMedia.cycleRepeat();
        late();
        assert.equal(c.resolutions.length, count, action);
        assert.equal(
            c.calls.filter((row) => row[0] === "play").length,
            1,
            action
        );
    }
});

test("Initial Repeat One keeps full episode membership for a later switch to All", () => {
    const c = folderQueueFixture([1, 2, 3], false);
    c.catalogs[""].forEach((row) => (row.__ottMediaSequence = true));
    c.mediaList("");
    c.__ottMedia.cycleRepeat();
    c.selectMedia(0);
    assert.equal(c.__ottMedia.current().sequence.items.length, 3);
    c.__ottMedia.cycleRepeat();
    c.__ottMedia.cycleRepeat();
    c.finishItem();
    assert.deepEqual(
        c.resolutions.map((row) => row.item.id),
        [1, 2]
    );
});

test("Collection capability hides and rejects shuffle while keeping single-item repeat", () => {
    const c = folderQueueFixture();
    c.providerMediaClient.canCollect = () => false;
    const view = c.__ottMedia.snapshot();
    assert.equal(view.canShuffle, false);
    assert.equal(view.canRepeat, true);
    c.__ottMedia.shufflePlay();
    assert.equal(c.completeCollection, undefined);
    c.__ottMedia.cycleRepeat();
    c.selectMedia(0);
    c.finishItem();
    assert.deepEqual(
        c.resolutions.map((row) => row.item.id),
        [1, 1]
    );
});

test("Shuffle revokes an earlier manual resolver and manual PIN before collection", () => {
    for (const phase of ["resolve", "pin"]) {
        const c = folderQueueFixture();
        if (phase === "pin") {
            c.catalogs[""][0].adult = 1;
            c.mediaList("");
        } else c.deferResolve = true;
        c.selectMedia(0);
        const late = phase === "pin" ? c.unlock : c.completeResolve;
        c.__ottMedia.shufflePlay();
        c.parentAccess = true;
        late();
        assert.equal(c.calls.filter((row) => row[0] === "play").length, 0);
        assert.equal(
            c.collectionCancels,
            0,
            "Late manual work cannot cancel new collection"
        );
        c.deferResolve = false;
        c.completeCollection();
        assert.equal(c.__ottMedia.current().payload.id, 2);
        assert.equal(c.calls.filter((row) => row[0] === "play").length, 1);
    }
});

test("Reentrant navigation during manual resolver abort prevents shuffle in the replacement frame", () => {
    const c = folderQueueFixture();
    c.deferResolve = true;
    c.selectMedia(0);
    c.catalogs.child = [{ id: 9, request: { id: 9 }, title: "Child" }];
    let navigate = true;
    c.providerMediaClient.cancel = () => {
        if (!navigate) return;
        navigate = false;
        c.__ottMedia.open("child");
    };
    c.__ottMedia.shufflePlay();
    assert.equal(c.__ottMedia.snapshot().frame.route.target, "child");
    assert.equal(c.completeCollection, undefined);
    assert.equal(c.calls.filter((row) => row[0] === "play").length, 0);
});

test("Reentrant Stop while saving Repeat cannot re-admit its captured natural completion", () => {
    const c = folderQueueFixture();
    c.__ottMedia.shufflePlay();
    c.completeCollection();
    c.deferResolve = true;
    c.finishItem();
    const late = c.completeResolve;
    Object.defineProperty(
        c.stored,
        "mediaRepeat.v1:" + c.__ottMedia.sourceId(),
        {
            configurable: true,
            get: () => "all",
            set: () => c.stbStop(),
        }
    );
    c.__ottMedia.cycleRepeat();
    late();
    assert.equal(
        c.resolutions.length,
        2,
        "Only the cancelled old next-item request exists"
    );
    assert.equal(c.calls.filter((row) => row[0] === "play").length, 1);
});

test("Actual screen owner close revokes shuffle collection, first PIN and pending resolve", () => {
    for (const phase of ["collect", "pin", "resolve"]) {
        const c = folderQueueFixture();
        c.showPage = () => c.__ottClassicScreenPort.commitList();
        c.closeList = () => c.__ottClassicScreenPort.closeList();
        if (phase === "pin") c.catalogs[""][1].adult = 1;
        if (phase === "resolve") c.deferResolve = true;
        c.mediaList("");
        c.__ottMedia.shufflePlay();
        if (phase !== "collect") c.completeCollection();
        const late =
            phase === "collect"
                ? c.completeCollection
                : phase === "pin"
                  ? c.unlock
                  : c.completeResolve;
        const owner = c.__ottClassicScreenPort.listOwner();
        assert(owner.active());
        c.closeList();
        assert.equal(owner.active(), false);
        if (phase === "collect")
            assert.equal(
                c.collectionCancels,
                1,
                "Closing the real owner aborts collection"
            );
        c.parentAccess = true;
        late();
        assert.equal(
            c.calls.filter((row) => row[0] === "play").length,
            0,
            phase
        );
    }
});

test("Shuffle refreshes UI highlight ownership after revoking manual work", () => {
    const c = folderQueueFixture();
    c.showPage = () => c.__ottClassicScreenPort.commitList();
    c.mediaList("");
    const oldHighlight = c.detailListActionFn;
    c.__ottMedia.shufflePlay();
    c.selIndex = 1;
    oldHighlight();
    assert.equal(
        c.__ottMedia.snapshot().frame.selected,
        0,
        "Old render callback remains stale"
    );
    c.selIndex = 2;
    c.detailListActionFn();
    assert.equal(
        c.__ottMedia.snapshot().frame.selected,
        2,
        "New render callback captures current revision"
    );
});

test("Navigation during shuffle projection refresh prevents collecting the replaced catalog", () => {
    const c = folderQueueFixture();
    const render = c.__ottRenderMedia;
    c.catalogs.child = [{ id: 9, request: { id: 9 }, title: "Child" }];
    let replace = true;
    c.__ottRenderMedia = (view) => {
        render(view);
        if (!replace) return;
        replace = false;
        c.__ottMedia.open("child");
    };
    c.__ottMedia.shufflePlay();
    assert.equal(c.__ottMedia.snapshot().frame.route.target, "child");
    assert.equal(c.completeCollection, undefined);
});

test("Reentrant Stop during shuffle projection refresh rejects the new intent", () => {
    const c = folderQueueFixture();
    const render = c.__ottRenderMedia;
    c.__ottRenderMedia = (view) => {
        render(view);
        c.stbStop();
    };
    c.__ottMedia.shufflePlay();
    assert.equal(c.completeCollection, undefined);
    assert.equal(c.calls.filter((row) => row[0] === "play").length, 0);
});

test("Empty or failed collection never starts a partial queue or displays provider errors", () => {
    for (const error of [undefined, "private URL/token"]) {
        const c = folderQueueFixture();
        c.__ottMedia.shufflePlay();
        c.completeCollection(error ? c.catalogs[""] : [], error);
        assert.equal(c.resolutions.length, 0);
        assert(!JSON.stringify(c.calls).includes("private URL/token"));
    }
});

test("Repeat preference is source-scoped and survives reopening its runtime", () => {
    const c = folderQueueFixture();
    const originalProvider = c.p_pref;
    const source = c.__ottMedia.sourceId();
    c.__ottMedia.cycleRepeat();
    assert.equal(c.stored["mediaRepeat.v1:" + source], "one");
    c.p_pref = "new-account";
    c.mediaList(null);
    assert.equal(c.__ottMedia.snapshot().repeat, "all");
    c.p_pref = originalProvider;
    c.mediaList(null);
    assert.equal(c.__ottMedia.snapshot().repeat, "one");
    const repeatKeys = Object.keys(c.stored).filter((key) =>
        key.startsWith("mediaRepeat.v1:")
    );
    assert.deepEqual(repeatKeys, ["mediaRepeat.v1:" + source]);
});

function coldResumeFixture(position = 123.4) {
    function configure(c) {
        c.p_pref = "plex";
        c.__ottActiveProviderDriver = {
            credentials: () => ({
                password: "account-fixture",
                server: "https://plex.invalid",
            }),
            id: "plex",
        };
        c.resolutions = [];
        c.providerMediaClient = {
            cancel() {},
            cancelAutomatic() {},
            persist(payload) {
                delete payload.stream_url;
                return payload;
            },
            resolve(payload, done) {
                c.resolutions.push(plain(payload));
                c.beforeResumeError = done.beforeError;
                c.finishResume = (result = {}) =>
                    done(
                        result === null
                            ? null
                            : {
                                  ...payload,
                                  stream_url: "fresh-access.mp4",
                                  ...result,
                              }
                    );
                if (!c.deferResume) c.finishResume();
            },
            stableRequests: true,
        };
        c.stbPlay = (url, at) => {
            c.calls.push(["play", url, at]);
            c.__ottClassicPlayback.command({ type: "playing" });
        };
    }
    const original = fixture();
    configure(original);
    original._playMedia({
        id: 42,
        request: { path: "/library/metadata/42" },
        stream_url: "expired-access.mp4?X-Plex-Token=expired-fixture",
        title: "Saved item",
    });
    original.__ottMedia.checkpoint(
        original.__ottMedia.current().ref,
        position,
        true
    );
    // A new VM has no playback, pending request or library instances from the
    // closed player; only the persisted source-scoped document crosses boot.
    const c = fixture();
    configure(c);
    Object.assign(c.stored, original.stored);
    c.journalKey = "mediaJournal.v1:" + c.__ottMedia.sourceId();
    c.changeSaved = (change) => {
        const document = JSON.parse(c.stored[c.journalKey]);
        change(document);
        c.stored[c.journalKey] = JSON.stringify(document);
    };
    return c;
}

function coldFolderResumeFixture() {
    const folder = "/library/sections/7/folder?parent=FFFF";
    function configure(c) {
        c.p_pref = "plex";
        c.__ottActiveProviderDriver = {
            credentials: () => ({
                password: "folder-fixture-account",
                server: "https://plex.invalid",
            }),
            id: "plex",
        };
        const target = (path, title) => ({ path, title });
        const movie = (id, title) => ({
            request: { path: "/library/metadata/" + id },
            title,
        });
        c.folderRows = [
            {
                playlist_url: target(folder + "-child", "Child folder"),
                title: "Child folder",
            },
            movie(41, "Previous film"),
            movie(42, "Saved film"),
            movie(43, "Next film"),
        ];
        const catalogs = {
            "": [
                {
                    playlist_url: target("library", "Library"),
                    title: "Library",
                },
            ],
            library: [{ playlist_url: target(folder, "FFFF"), title: "FFFF" }],
            [folder]: c.folderRows,
        };
        c.getMediaArray = (value, done) => {
            const path = typeof value === "string" ? value : value.path;
            c.calls.push(["fetch", path]);
            c.mediaRecords = plain(catalogs[path] || []);
            c.mediaName = value.title || "Media Library";
            done();
        };
        c.collections = [];
        c.collectionCancels = 0;
        c.resolutions = [];
        c.providerMediaClient = {
            canCollect: (value) => value && value.path === folder,
            cancel() {},
            cancelAutomatic() {},
            collect(value, done, guard) {
                c.collections.push(plain(value));
                c.completeFolder = (late = false) => {
                    if (late || !guard || guard())
                        done({
                            items: plain(
                                c.folderRows.filter((row) => row.request)
                            ),
                            records: plain(c.folderRows),
                        });
                };
                if (!c.deferFolder) c.completeFolder();
                return () => c.collectionCancels++;
            },
            persist(payload) {
                delete payload.stream_url;
                return payload;
            },
            resolve(payload, done, automatic) {
                c.resolutions.push({ automatic, item: plain(payload) });
                done({ ...payload, stream_url: payload.request.path + ".mp4" });
            },
            stableRequests: true,
        };
        c.stbPlay = (url, position) => {
            c.calls.push(["play", url, position]);
            c.__ottClassicPlayback.command({ type: "playing" });
        };
        c.chooseTitle = (title) => {
            const index = c.listArray.findIndex((row) => row.title === title);
            assert(index >= 0, "Catalog contains " + title);
            c.selectMedia(index);
        };
    }
    const first = fixture();
    configure(first);
    first.mediaList(null);
    first.chooseTitle("Library");
    first.chooseTitle("FFFF");
    first.chooseTitle("Saved film");
    first.__ottMedia.checkpoint(first.__ottMedia.current().ref, 123.4, true);
    const c = fixture();
    configure(c);
    Object.assign(c.stored, first.stored);
    c.savedTrail = plain(
        first.__ottMedia.snapshot().frames.map((row) => row.route)
    );
    c.savedRef = plain(first.__ottMedia.current().ref);
    c.folderTarget = folder;
    c.journalKey = "mediaJournal.v1:" + c.__ottMedia.sourceId();
    return c;
}

test("Full-screen Plex arrows seek horizontally and select adjacent videos vertically", () => {
    const c = coldFolderResumeFixture();
    vm.runInContext(
        sourceFunctions("src/key-handler/index.ts", [
            "handleMainKey",
            "keyFun",
            "toggleMainPlayback",
        ]),
        c
    );
    c.settings.auFun = 19;
    c.settings.adFun = 18;
    c.settings.alFun = 14;
    c.settings.arFun = 13;
    c.sVolumeStep = 5;
    const seeks = [];
    const volumes = [];
    c.shiftArchive = (seconds) => seeks.push(seconds);
    c.changeVolume = (delta) => volumes.push(delta);
    const press = (key) =>
        c.handleMainKey(key, {
            preventDefault() {},
            stopPropagation() {},
        });
    c.__ottMedia.restoreLast();
    const current = plain(c.__ottMedia.current().ref);
    for (const [left, right] of [
        [14, 13],
        [1, 4],
    ]) {
        c.settings.alFun = left;
        c.settings.arFun = right;
        press(c.keys.LEFT);
        press(c.keys.RIGHT);
        assert.deepEqual(seeks.splice(0), [-10, 10]);
    }
    c.settings.alFun = 14;
    c.settings.arFun = 13;
    assert.deepEqual(volumes, []);
    assert.deepEqual(plain(c.__ottMedia.current().ref), current);
    const levels = [];
    let volume = 50;
    c.keys.VOL_UP = 447;
    c.keys.VOL_DOWN = 448;
    c.settings.volumeStep = 5;
    c.stbGetVolume = () => volume;
    c.stbSetVolume = (value) => levels.push((volume = value));
    press(c.keys.VOL_UP);
    press(c.keys.VOL_DOWN);
    assert.deepEqual(levels, [55, 50]);
    assert.deepEqual(seeks, []);
    press(c.keys.UP);
    assert.equal(
        c.__ottMedia.current().payload.request.path,
        "/library/metadata/43"
    );
    press(c.keys.DOWN);
    assert.equal(
        c.__ottMedia.current().payload.request.path,
        "/library/metadata/42"
    );
    assert.deepEqual(seeks, []);
    assert.equal(
        c.collections.length,
        1,
        "Arrows reuse the loaded folder queue"
    );
    c.p_pref = "another-provider";
    press(c.keys.UP);
    press(c.keys.DOWN);
    assert.deepEqual(
        seeks,
        [60, -60],
        "Other providers keep their configured bindings"
    );
    press(c.keys.LEFT);
    press(c.keys.RIGHT);
    assert.deepEqual(volumes, [-5, 5]);
});

function resumedWithoutFolder(repeat) {
    const c = coldFolderResumeFixture();
    if (repeat) c.stored["mediaRepeat.v1:" + c.__ottMedia.sourceId()] = repeat;
    const collect = c.providerMediaClient.collect;
    c.providerMediaClient.collect = (_target, done) =>
        done({ error: true, items: [] });
    assert.equal(c.__ottMedia.restoreLast(), true);
    if (repeat !== "one") assert.equal(c.__ottMedia.current().sequence, null);
    c.providerMediaClient.collect = collect;
    c.deferFolder = true;
    return c;
}

test("Plex arrows recover the original folder after an unavailable startup catalog", () => {
    const c = resumedWithoutFolder();
    c.__ottMedia.skip(1);
    assert.equal(c.collections.length, 1);
    assert.equal(
        c.resolutions.length,
        1,
        "The current file keeps playing during collection"
    );
    c.completeFolder();
    assert.equal(
        c.__ottMedia.current().payload.request.path,
        "/library/metadata/43"
    );
    c.__ottMedia.skip(-1);
    assert.equal(
        c.__ottMedia.current().payload.request.path,
        "/library/metadata/42"
    );
    assert.equal(c.collections.length, 1, "Recovered siblings are reused");
});

test("Repeat One keeps folder recovery available after replaying the fallback item", () => {
    const c = resumedWithoutFolder("one");
    c.__ottClassicPlayback.command({
        duration: 600,
        position: 600,
        type: "position",
    });
    c.__ottClassicPlayback.command({ type: "stop" });
    c.__ottMedia.ended(c.__ottClassicPlayback.snapshot().generation);
    assert.equal(
        c.resolutions.length,
        2,
        "Natural completion repeats the current file"
    );
    c.__ottMedia.skip(1);
    assert.equal(c.collections.length, 1);
    c.completeFolder();
    assert.equal(
        c.__ottMedia.current().payload.request.path,
        "/library/metadata/43"
    );
    assert.equal(c.__ottMedia.current().sequence.repeat, "one");
});

test("Enabling Repeat One on a file without a queue does not disable arrow recovery", () => {
    const c = resumedWithoutFolder();
    c.__ottMedia.cycleRepeat();
    c.__ottMedia.skip(-1);
    assert.equal(c.collections.length, 1);
    c.completeFolder();
    assert.equal(
        c.__ottMedia.current().payload.request.path,
        "/library/metadata/41"
    );
    assert.equal(c.__ottMedia.current().sequence.repeat, "one");
});

test("A real one-file folder is collected once without recursive recovery", () => {
    const c = resumedWithoutFolder("one");
    c.folderRows = c.folderRows.filter(
        (row) => row.request?.path === "/library/metadata/42"
    );
    c.__ottMedia.skip(1);
    c.completeFolder();
    c.__ottMedia.skip(-1);
    assert.equal(c.collections.length, 1);
    assert.equal(c.resolutions.length, 1);
    assert.equal(
        c.__ottMedia.current().payload.request.path,
        "/library/metadata/42"
    );
});

test("Pending folder recovery combines arrow presses without restarting the request", () => {
    const c = resumedWithoutFolder();
    c.__ottMedia.skip(-1);
    c.__ottMedia.skip(-1);
    c.__ottMedia.skip(-1);
    c.__ottMedia.skip(-1);
    assert.equal(c.collections.length, 1);
    c.completeFolder();
    assert.equal(
        c.__ottMedia.current().payload.request.path,
        "/library/metadata/41"
    );
});

test("Stopped fallback recovery retries while natural completion preserves every explicit arrow", () => {
    for (const ended of [false, true]) {
        for (const finishBeforeRetry of [false, true]) {
            const c = resumedWithoutFolder();
            c.__ottMedia.skip(1);
            const stale = c.completeFolder;
            c.__ottClassicPlayback.command({ type: "stop" });
            if (ended)
                c.__ottMedia.ended(
                    c.__ottClassicPlayback.snapshot().generation
                );
            if (finishBeforeRetry) stale(true);
            assert.equal(c.resolutions.length, 1);
            c.__ottMedia.skip(1);
            assert.equal(
                c.collections.length,
                2,
                "A new arrow starts a fresh folder request"
            );
            stale(true);
            assert.equal(
                c.resolutions.length,
                1,
                "The stale folder reply cannot start a video"
            );
            c.completeFolder();
            assert.equal(
                c.__ottMedia.current().payload.request.path,
                ended ? "/library/metadata/41" : "/library/metadata/43"
            );
            assert.equal(c.resolutions.length, 2);
        }
    }
});

test("Cancelled folder recovery cannot replace newer playback or navigation", () => {
    for (const cancel of [
        (c) => c.__ottMedia.cancelAuto(),
        (c) => c.__ottClassicPlayback.command({ type: "stop" }),
        (c) => c.mediaList("library"),
    ]) {
        const c = resumedWithoutFolder();
        c.__ottMedia.skip(1);
        const finish = c.completeFolder;
        cancel(c);
        finish(true);
        assert.equal(c.resolutions.length, 1);
        assert.equal(c.__ottMedia.current().sequence, null);
    }
});

test("Missing original file never falls through to an unrelated folder sibling", () => {
    const c = resumedWithoutFolder();
    c.folderRows = c.folderRows.filter(
        (row) => !row.request || row.request.path !== "/library/metadata/42"
    );
    c.__ottMedia.skip(1);
    c.completeFolder();
    assert.equal(c.resolutions.length, 1);
    assert.equal(c.__ottMedia.current().sequence, null);
    c.__ottMedia.skip(1);
    assert.equal(
        c.collections.length,
        2,
        "A later press can retry a failed collection"
    );
});

test("Manual media skip respects queue order, repeat boundaries and shuffle", () => {
    const c = coldFolderResumeFixture();
    c.__ottMedia.restoreLast();
    c.__ottMedia.cycleRepeat(); // one
    c.__ottMedia.skip(1);
    assert.equal(
        c.__ottMedia.current().payload.request.path,
        "/library/metadata/43"
    );
    c.__ottMedia.cycleRepeat(); // off
    const count = c.resolutions.length;
    c.__ottMedia.skip(1);
    assert.equal(c.resolutions.length, count);
    c.__ottMedia.skip(-1);
    assert.equal(
        c.__ottMedia.current().payload.request.path,
        "/library/metadata/42"
    );
    c.__ottMedia.cycleRepeat(); // all
    c.__ottMedia.skip(-1);
    c.__ottMedia.skip(-1);
    assert.equal(
        c.__ottMedia.current().payload.request.path,
        "/library/metadata/43"
    );
    c.mediaList(null);
    c.__ottMedia.shufflePlay();
    const shuffled = c.__ottMedia.current().sequence;
    assert(shuffled.ordered);
    const next = shuffled.items[1].ref.itemId;
    const first = shuffled.items[0].ref.itemId;
    c.__ottMedia.skip(1);
    assert.equal(c.__ottMedia.current().ref.itemId, next);
    c.__ottMedia.skip(-1);
    assert.equal(c.__ottMedia.current().ref.itemId, first);
    assert(c.__ottMedia.current().sequence.ordered);
});

test("Rapid media skips supersede pending resolutions and cancelled PIN grants cannot play", () => {
    const c = coldFolderResumeFixture();
    c.__ottMedia.restoreLast();
    const pending = [];
    c.providerMediaClient.resolve = (item, done) =>
        pending.push(() =>
            done({
                ...item,
                stream_url: item.request.path + ".mp4",
            })
        );
    c.__ottMedia.skip(1);
    c.__ottMedia.skip(1);
    pending[0]();
    assert.equal(
        c.__ottMedia.current().payload.request.path,
        "/library/metadata/42"
    );
    pending[1]();
    assert.equal(
        c.__ottMedia.current().payload.request.path,
        "/library/metadata/41"
    );
    c.__ottMedia.skip(1);
    c.__ottMedia.cancelAuto();
    pending[2]();
    assert.equal(
        c.__ottMedia.current().payload.request.path,
        "/library/metadata/41"
    );

    const protectedQueue = coldFolderResumeFixture();
    protectedQueue.folderRows[3].adult = 1;
    protectedQueue.__ottMedia.restoreLast();
    protectedQueue.__ottMedia.skip(1);
    assert(protectedQueue.unlock);
    protectedQueue.__ottMedia.cancelAuto();
    protectedQueue.parentAccess = true;
    protectedQueue.unlock();
    assert.equal(protectedQueue.resolutions.length, 1);

    const edge = coldFolderResumeFixture();
    edge.__ottMedia.restoreLast();
    edge.__ottMedia.cycleRepeat();
    edge.__ottMedia.cycleRepeat(); // off
    let finish;
    edge.providerMediaClient.resolve = (item, done) => {
        finish = () => done({ ...item, stream_url: "last.mp4" });
    };
    edge.__ottMedia.skip(1);
    edge.__ottMedia.skip(1); // A repeated press at the end keeps the pending last video.
    finish();
    assert.equal(
        edge.__ottMedia.current().payload.request.path,
        "/library/metadata/43"
    );
});

function pendingPlexSkipFixture(recovering = false) {
    const c = recovering ? resumedWithoutFolder() : coldFolderResumeFixture();
    if (!recovering) c.__ottMedia.restoreLast();
    c.__ottClassicScreenPort.closeList();
    c.pendingSkips = [];
    c.providerMediaClient.resolve = (item, done) => {
        c.pendingSkips.push({
            done,
            finish: () =>
                done({ ...item, stream_url: item.request.path + ".mp4" }),
        });
    };
    c.skipWait = () => c.elements["#dialogbox"];
    c.pressWait = (key) =>
        c.__ottClassicScreenPort.screens.dispatch({ code: key, id: "test" });
    return c;
}

test("Explicit Plex skip waits visibly and releases its dialog before decoder startup", () => {
    const c = pendingPlexSkipFixture();
    const current = c.__ottMedia.current().ref.itemId;
    c.__ottMedia.skip(1);
    assert.match(c.skipWait().innerHTML, /ott-spinner/);
    assert.match(c.skipWait().innerHTML, /Next film/);
    assert.equal(c.skipWait().style.display, "");
    assert.equal(c.__ottMedia.current().ref.itemId, current);
    const play = c.stbPlay;
    c.stbPlay = (...args) => {
        assert.equal(c.skipWait().style.display, "none");
        play(...args);
    };
    c.pendingSkips[0].finish();
    assert.equal(
        c.__ottMedia.current().payload.request.path,
        "/library/metadata/43"
    );
    assert.equal(c.__ottClassicScreenPort.screens.current(), null);
});

test("Explicit Plex skip wait accepts rapid arrows and ignores superseded replies", () => {
    const c = pendingPlexSkipFixture();
    c.__ottMedia.skip(1);
    c.pressWait(c.keys.UP);
    c.pressWait(c.keys.DOWN);
    assert.equal(c.pendingSkips.length, 3);
    c.pendingSkips[0].finish();
    c.pendingSkips[1].finish();
    assert.equal(
        c.__ottMedia.current().payload.request.path,
        "/library/metadata/42"
    );
    assert.equal(c.skipWait().style.display, "");
    c.pendingSkips[2].finish();
    assert.equal(
        c.__ottMedia.current().payload.request.path,
        "/library/metadata/43"
    );
    assert.equal(c.skipWait().style.display, "none");
});

test("Explicit Plex skip Back cancels the pending request without leaving the playing video", () => {
    const c = pendingPlexSkipFixture();
    const before = plain(c.__ottClassicPlayback.snapshot());
    let cancelled = 0;
    c.providerMediaClient.cancelAutomatic = () => cancelled++;
    c.__ottMedia.skip(1);
    c.pressWait(c.keys.RETURN);
    assert.equal(cancelled, 1);
    assert.equal(c.skipWait().style.display, "none");
    c.pendingSkips[0].finish();
    assert.deepEqual(plain(c.__ottClassicPlayback.snapshot()), before);
    assert.equal(c.isListVisible, false);
});

test("Natural completion preserves a pending explicit Plex skip and rejects its old responses", () => {
    for (const recovering of [false, true]) {
        const c = pendingPlexSkipFixture(recovering);
        c.__ottMedia.skip(1);
        c.pressWait(c.keys.UP);
        const staleFolder = c.completeFolder;
        const staleResolves = c.pendingSkips.slice();
        const oldPlayback = c.__ottMedia.current();
        c.__ottClassicPlayback.command({
            duration: 600,
            position: 600,
            type: "position",
        });
        c.__ottClassicPlayback.command({ type: "stop" });
        const generation = c.__ottClassicPlayback.snapshot().generation;
        c.__ottMedia.ended(generation);
        c.__ottMedia.ended(generation);
        assert.equal(
            c.skipWait().style.display,
            "",
            "The explicit wait continues"
        );
        if (recovering) {
            assert.equal(c.collections.length, 2);
            staleFolder(true);
            assert.equal(c.pendingSkips.length, 0);
            c.completeFolder();
        } else {
            assert.equal(c.pendingSkips.length, 3);
            staleResolves.forEach((request) => request.finish());
        }
        assert.equal(c.__ottMedia.current(), oldPlayback);
        c.pendingSkips.at(-1).finish();
        assert.equal(
            c.__ottMedia.current().payload.request.path,
            "/library/metadata/41",
            "Both arrows remain effective after the old decoder ends"
        );
        assert.equal(c.skipWait().style.display, "none");
    }
});

test("Navigation during EOS cancellation defeats the old explicit Plex skip", () => {
    const c = pendingPlexSkipFixture();
    c.__ottMedia.skip(1);
    c.providerMediaClient.cancelAutomatic = () => c.mediaList("library");
    c.__ottClassicPlayback.command({ type: "stop" });
    c.__ottMedia.ended(c.__ottClassicPlayback.snapshot().generation);
    assert.equal(
        c.pendingSkips.length,
        1,
        "Navigation must not restart the skip"
    );
    c.pendingSkips[0].finish();
    assert.equal(
        c.__ottMedia.current().payload.request.path,
        "/library/metadata/42"
    );
    assert.equal(c.skipWait().style.display, "none");
    assert.equal(c.__ottMedia.snapshot().frame.route.target, "library");
});

test("Opposite arrows during fallback recovery leave no wait at natural completion", () => {
    const c = pendingPlexSkipFixture(true);
    c.__ottMedia.skip(1);
    c.pressWait(c.keys.DOWN);
    c.__ottClassicPlayback.command({ type: "stop" });
    c.__ottMedia.ended(c.__ottClassicPlayback.snapshot().generation);
    c.completeFolder(true);
    assert.equal(c.pendingSkips.length, 0);
    assert.equal(c.collections.length, 1);
    assert.equal(c.skipWait().style.display, "none");
    assert.equal(c.__ottClassicPlayback.snapshot().phase, "stopped");
});

test("Explicit Plex skip wait spans folder recovery and closes on collection failure", () => {
    for (const failure of [false, true]) {
        const c = pendingPlexSkipFixture(true);
        if (failure)
            c.folderRows = c.folderRows.filter(
                (row) => row.request?.path !== "/library/metadata/42"
            );
        c.__ottMedia.skip(1);
        assert.equal(c.skipWait().style.display, "");
        c.pressWait(c.keys.UP);
        assert.equal(c.collections.length, 1);
        c.completeFolder();
        if (failure) {
            assert.equal(c.skipWait().style.display, "none");
            assert.equal(c.pendingSkips.length, 0);
            assert(
                c.calls.some(
                    (row) =>
                        row[0] === "shift" &&
                        row[1] === "Unable to load playlist"
                )
            );
        } else {
            assert.equal(c.skipWait().style.display, "");
            assert.equal(c.pendingSkips.length, 1);
            c.pendingSkips[0].finish();
            assert.equal(
                c.__ottMedia.current().payload.request.path,
                "/library/metadata/41"
            );
            assert.equal(c.skipWait().style.display, "none");
        }
    }
});

test("Explicit Plex skip yields to metadata errors and allows retry after dismissal", () => {
    const c = pendingPlexSkipFixture();
    c.__ottMedia.skip(1);
    const pending = c.pendingSkips[0];
    assert.equal(typeof pending.done.beforeError, "function");
    pending.done.beforeError();
    assert.equal(c.skipWait().style.display, "none");
    const error = c.__ottClassicScreenPort.setOwnedCallback(
        "dialog",
        () => {}
    ).owner;
    c.$("#dialogbox").html("Plex connection failed").show();
    pending.done(null);
    assert.equal(c.skipWait().style.display, "");
    assert.equal(c.skipWait().innerHTML, "Plex connection failed");
    error.close();
    c.__ottMedia.skip(1);
    c.pendingSkips[1].finish();
    assert.equal(
        c.__ottMedia.current().payload.request.path,
        "/library/metadata/43"
    );
});

test("Explicit Plex skip cancellation never hides a replacement screen or admits stale playback", () => {
    for (const replacement of ["dialog", "list", "stop", "source"]) {
        const c = pendingPlexSkipFixture();
        c.__ottMedia.skip(1);
        if (replacement === "dialog") {
            c.__ottClassicScreenPort.setOwnedCallback("dialog", () => {});
            c.$("#dialogbox").html("Other dialog").show();
        } else if (replacement === "list") c.mediaList(null);
        else if (replacement === "source") {
            c.p_pref = "other";
            c.mediaList(null);
        } else {
            c.__ottMedia.cancelAuto();
            c.__ottClassicPlayback.command({ type: "stop" });
        }
        const before = plain(c.__ottClassicPlayback.snapshot());
        c.pendingSkips[0].finish();
        assert.deepEqual(
            plain(c.__ottClassicPlayback.snapshot()),
            before,
            replacement
        );
        if (replacement === "dialog") {
            assert.equal(c.skipWait().innerHTML, "Other dialog");
            assert.equal(c.skipWait().style.display, "");
        } else assert.equal(c.skipWait().style.display, "none", replacement);
    }
});

test("Explicit Plex skip never takes input ownership from an existing screen", () => {
    for (const kind of ["dialog", "list"]) {
        const c = pendingPlexSkipFixture();
        const owner =
            kind === "list"
                ? c.__ottClassicScreenPort.commitList()
                : c.__ottClassicScreenPort.setOwnedCallback("dialog", () => {})
                      .owner;
        if (kind === "dialog") c.$("#dialogbox").html("Other dialog").show();
        c.__ottMedia.skip(1);
        assert.equal(c.__ottClassicScreenPort.screens.current(), owner);
        c.pendingSkips[0].finish();
        assert.equal(c.__ottClassicScreenPort.screens.current(), owner);
        if (kind === "dialog")
            assert.equal(c.skipWait().innerHTML, "Other dialog");
    }
});

test("Cold Plex startup waits visibly for both folder collection and stream resolution", () => {
    const c = coldFolderResumeFixture();
    c.deferFolder = true;
    let finish;
    c.providerMediaClient.resolve = (payload, done) => {
        finish = () => done({ ...payload, stream_url: "ready.mp4" });
    };
    c.__ottMedia.restoreLast();
    const dialog = c.elements["#dialogbox"];
    assert.match(dialog?.innerHTML || "", /ott-spinner/);
    assert.equal(dialog.style.display, "");
    c.completeFolder();
    assert.equal(dialog.style.display, "", "Metadata is still pending");
    assert(!c.calls.some((row) => row[0] === "play"));
    finish();
    assert.equal(dialog.style.display, "none");
    assert(c.calls.some((row) => row[0] === "play"));
});

test("Cold Plex startup cancels on Back and preserves a replacement error dialog", () => {
    for (const outcome of ["back", "error"]) {
        const c = coldResumeFixture();
        c.deferResume = true;
        let fallback = 0;
        c.__ottMedia.restoreLast(() => fallback++);
        const dialog = c.elements["#dialogbox"];
        assert.equal(dialog?.style.display, "");
        if (outcome === "back") {
            c.dialogBoxKeyHandler(c.keys.RETURN);
            c.finishResume();
            assert.equal(dialog.style.display, "none");
        } else {
            c.beforeResumeError();
            c.__ottClassicScreenPort.setOwnedCallback("dialog", () => {});
            c.$("#dialogbox").html("Connection error").show();
            c.finishResume(null);
            assert.equal(dialog.style.display, "");
            assert.equal(dialog.innerHTML, "Connection error");
        }
        assert.equal(fallback, 1);
        assert(!c.calls.some((row) => row[0] === "play"));
    }
});

test("Replacing the cold Plex wait cancels folder and metadata work without taking the new dialog", () => {
    for (const phase of ["folder", "resolve"]) {
        const c = coldFolderResumeFixture();
        c.deferFolder = phase === "folder";
        let finish;
        let cancelled = 0;
        c.providerMediaClient.cancelAutomatic = () => cancelled++;
        c.providerMediaClient.resolve = (payload, done) => {
            finish = () => done({ ...payload, stream_url: "late.mp4" });
        };
        let fallback = 0;
        c.__ottMedia.restoreLast(() => fallback++);
        const replacement = c.__ottClassicScreenPort.setOwnedCallback(
            "dialog",
            () => {}
        ).owner;
        c.$("#dialogbox").html("New dialog").show();
        if (phase === "folder") c.completeFolder(true);
        else finish();
        assert.equal(c.__ottClassicScreenPort.screens.current(), replacement);
        assert.equal(c.elements["#dialogbox"].style.display, "");
        assert.equal(c.elements["#dialogbox"].innerHTML, "New dialog");
        assert.equal(c.calls.filter((row) => row[0] === "play").length, 0);
        assert.equal(c.documentState().history[0].position, 123.4);
        assert.equal(fallback, 0, "The new screen owns further navigation");
        assert.equal(phase === "folder" ? c.collectionCancels : cancelled, 1);
    }
});

test("Cold Plex folder resume restores breadcrumbs, selected file and the next movie sibling", () => {
    const c = coldFolderResumeFixture();
    assert.equal(c.__ottMedia.restoreLast(), true);
    assert.deepEqual(
        c.calls.filter((row) => row[0] === "play"),
        [["play", "/library/metadata/42.mp4", 123.4]]
    );
    c.mediaList(null);
    const view = c.__ottMedia.snapshot();
    assert.deepEqual(plain(view.frames.map((row) => row.route)), c.savedTrail);
    assert.equal(view.frame.route.title, "FFFF");
    assert.deepEqual(
        plain(view.frame.items[view.frame.selected].ref),
        c.savedRef
    );
    assert.deepEqual(
        plain(
            view.frame.items
                .filter((row) => !row.payload.__ottMediaFilter)
                .map((row) => row.title)
        ),
        ["Child folder", "Previous film", "Saved film", "Next film"]
    );
    assert.deepEqual(plain(c.mediaNames), ["Media Library", "Library", "FFFF"]);
    assert.equal(
        c.collections.length,
        1,
        "Only the saved flat folder is collected"
    );
    assert.equal(c.collections[0].path, c.folderTarget);
    assert(
        !c.calls.some((row) => row[0] === "fetch"),
        "Cold resume does not walk ancestors eagerly"
    );
    c.__ottClassicPlayback.command({
        duration: 600,
        position: 600,
        type: "position",
    });
    c.__ottClassicPlayback.command({ type: "stop" });
    c.__ottMedia.ended(c.__ottClassicPlayback.snapshot().generation);
    assert.deepEqual(
        c.calls.filter((row) => row[0] === "play"),
        [
            ["play", "/library/metadata/42.mp4", 123.4],
            ["play", "/library/metadata/43.mp4", undefined],
        ]
    );
    assert.equal(c.__ottClassicPlayback.snapshot().position, 0);
    assert.deepEqual(
        c.resolutions.map((row) => row.item.request.path),
        ["/library/metadata/42", "/library/metadata/43"]
    );
    assert.equal(
        c.collections.length,
        1,
        "EOF reuses the admitted sibling order"
    );
    assert(!c.calls.some((row) => row[0] === "confirm"));
});

test("Cold Plex folder breadcrumbs lazily reload their parent and preserve its selection", () => {
    const c = coldFolderResumeFixture();
    assert.equal(c.__ottMedia.restoreLast(), true);
    c.mediaList(null);
    c.__ottMedia.back();
    const parent = c.__ottMedia.snapshot().frame;
    assert.equal(parent.route.title, "Library");
    assert.equal(parent.items[parent.selected].title, "FFFF");
    assert.deepEqual(
        c.calls.filter((row) => row[0] === "fetch"),
        [["fetch", "library"]]
    );
    c.chooseTitle("FFFF");
    assert.equal(c.__ottMedia.snapshot().frame.route.title, "FFFF");
    assert(c.listArray.some((row) => row.title === "Saved film"));
});

test("Legacy Plex folder bookmarks without a saved trail retain folder and next-sibling recovery", () => {
    const c = coldFolderResumeFixture();
    const saved = JSON.parse(c.stored[c.journalKey]);
    delete saved.history[0].payload.__ottMediaTrail;
    c.stored[c.journalKey] = JSON.stringify(saved);
    assert.equal(c.__ottMedia.restoreLast(), true);
    c.mediaList(null);
    const view = c.__ottMedia.snapshot();
    assert.equal(view.frame.route.target.path, c.folderTarget);
    assert.equal(view.frame.items[view.frame.selected].title, "Saved film");
    c.__ottClassicPlayback.command({ type: "stop" });
    c.__ottMedia.ended(c.__ottClassicPlayback.snapshot().generation);
    assert.equal(
        c.resolutions.at(-1).item.request.path,
        "/library/metadata/43"
    );
});

test("Cold Plex folder resume honors Repeat Off after the final sibling", () => {
    const c = coldFolderResumeFixture();
    c.stored["mediaRepeat.v1:" + c.__ottMedia.sourceId()] = "off";
    assert.equal(c.__ottMedia.restoreLast(), true);
    for (let index = 0; index < 2; index++) {
        c.__ottClassicPlayback.command({
            duration: 600,
            position: 600,
            type: "position",
        });
        c.__ottClassicPlayback.command({ type: "stop" });
        c.__ottMedia.ended(c.__ottClassicPlayback.snapshot().generation);
    }
    assert.deepEqual(
        c.resolutions.map((row) => row.item.request.path),
        ["/library/metadata/42", "/library/metadata/43"]
    );
    assert.equal(c.__ottClassicPlayback.snapshot().phase, "stopped");
    assert.equal(c.documentState().history[0].position, 0);
});

test("Cancelled cold folder collection cannot restore navigation or start late playback", () => {
    const cancel = [
        (c) => c.__ottMedia.cancelAuto(),
        (c) => c.__ottMedia.back(),
        (c) => c.mediaList("library"),
        (c) => c.__ottClassicPlayback.command({ type: "stop" }),
    ];
    for (const stop of cancel) {
        const c = coldFolderResumeFixture();
        c.deferFolder = true;
        assert.equal(c.__ottMedia.restoreLast(), true);
        assert.equal(c.collections.length, 1);
        assert.equal(c.resolutions.length, 0);
        const finish = c.completeFolder;
        stop(c);
        const view = plain(c.__ottMedia.snapshot());
        // Model a late transport callback even if its cancellation was ignored.
        finish(true);
        assert.deepEqual(plain(c.__ottMedia.snapshot()), view);
        assert.equal(c.resolutions.length, 0);
        assert(!c.calls.some((row) => row[0] === "play"));
        assert.equal(c.documentState().history[0].position, 123.4);
    }
});

test("Pending Plex selection blocks replacement and cancellation cannot revive either file", () => {
    const c = coldFolderResumeFixture();
    assert.equal(c.__ottMedia.restoreLast(), true);
    c.mediaList(null);
    const pending = [];
    c.providerMediaClient.resolve = (payload, done) =>
        pending.push({ done, payload });
    c.chooseTitle("Previous film");
    assert.equal(pending.length, 1);
    let cancellations = 0;
    c.providerMediaClient.cancel = () => {
        cancellations++;
        c.__ottMedia.cancelAuto();
        c.__ottClassicPlayback.command({ type: "stop" });
    };
    const plays = c.calls.filter((row) => row[0] === "play").length;
    c.chooseTitle("Next film");
    assert.equal(
        cancellations,
        0,
        "a second selection cannot replace the loading file"
    );
    assert.equal(pending.length, 1);
    c.dialogBoxKeyHandler(c.keys.RETURN);
    assert.equal(cancellations, 1);
    assert.equal(
        pending.length,
        1,
        "cancellation cannot dispatch the queued selection"
    );
    assert.equal(c.__ottClassicPlayback.snapshot().phase, "stopped");
    pending[0].done({ ...pending[0].payload, stream_url: "late-film.mp4" });
    assert.equal(c.calls.filter((row) => row[0] === "play").length, plays);
});

test("Failed full-folder collection never falls back to a visible partial provider sequence", () => {
    const c = coldFolderResumeFixture();
    c.folderRows.splice(3);
    c.folderRows.forEach((row) => {
        if (row.request) row.__ottMediaSequence = true;
    });
    c.providerMediaClient.collect = (_target, done) =>
        done({ error: "Unavailable", items: [] });
    c.mediaList(null);
    c.chooseTitle("Library");
    c.chooseTitle("FFFF");
    c.chooseTitle("Previous film");
    assert.equal(c.__ottMedia.current().sequence, null);
    c.__ottClassicPlayback.command({ type: "stop" });
    c.__ottMedia.ended(c.__ottClassicPlayback.snapshot().generation);
    assert.deepEqual(
        c.resolutions.map((row) => row.item.request.path),
        ["/library/metadata/41"]
    );
    assert.equal(c.__ottClassicPlayback.snapshot().phase, "stopped");
});

test("Cold Plex resume resolves a fresh stable item at its exact saved position", () => {
    for (const position of [10.25, 123.4]) {
        const c = coldResumeFixture(position);
        assert.equal(c.__ottMedia.current(), null);
        assert.equal(c.__ottMedia.restoreLast(), true);
        assert.deepEqual(
            c.calls.filter((call) => call[0] === "play"),
            [["play", "fresh-access.mp4", position]]
        );
        assert.equal(c.resolutions.length, 1);
        assert.equal(c.resolutions[0].request.path, "/library/metadata/42");
        assert.equal(c.resolutions[0].stream_url, undefined);
        assert.equal(c.__ottClassicPlayback.snapshot().position, position);
        assert.equal(c.documentState().history[0].position, position);
        assert(!c.stored[c.journalKey].includes("expired-fixture"));
        assert(!c.stored[c.journalKey].includes("stream_url"));
        assert(!c.calls.some((call) => /^(confirm|fetch)$/.test(call[0])));
        assert.equal(c.__ottMedia.restoreLast(), false);
        assert.equal(
            c.resolutions.length,
            1,
            "One startup attempt per runtime"
        );
    }
});

test("Cold resume retains its checkpoint while the new decoder is loading", () => {
    const c = coldResumeFixture(123.4);
    c.stbPlay = (url, position) => {
        assert.equal(position, 123.4);
        assert.equal(c.__ottClassicPlayback.snapshot().phase, "loading");
        assert.equal(c.documentState().history[0].position, 123.4);
        c.__ottClassicPlayback.checkpoint(
            c.__ottClassicPlayback.snapshot(),
            true
        );
    };
    assert.equal(c.__ottMedia.restoreLast(), true);
    assert.equal(c.documentState().history[0].position, 123.4);
});

test("Cold resume skips disabled, malformed, foreign and completed histories", () => {
    const cases = [
        (c) => (c.sFavorites = -1),
        (c) => (c.sMedCount = 0),
        (c) => (c.stored[c.journalKey] = "{invalid"),
        (c) => c.changeSaved((doc) => (doc.version = 99)),
        (c) => c.changeSaved((doc) => (doc.sourceId = "other-account")),
        (c) => c.changeSaved((doc) => (doc.history[0].sourceId = "other")),
        (c) => c.changeSaved((doc) => (doc.history[0].position = -1)),
        (c) => c.changeSaved((doc) => (doc.history[0].position = "123")),
        (c) => c.changeSaved((doc) => (doc.history[0].position = null)),
        (c) => c.changeSaved((doc) => (doc.history[0].position = 0)),
        (c) => c.changeSaved((doc) => (doc.history = [])),
        (c) => c.changeSaved((doc) => delete doc.history[0].payload.request),
        (c) => (c.providerMediaClient.stableRequests = false),
    ];
    cases.forEach((change) => {
        const c = coldResumeFixture();
        change(c);
        assert.equal(c.__ottMedia.restoreLast(), false);
        assert.equal(c.resolutions.length, 0);
    });
    const c = coldResumeFixture();
    c.changeSaved((doc) => {
        doc.history.unshift({
            ...doc.history[0],
            itemId: "completed",
            position: 0,
        });
    });
    assert.equal(
        c.__ottMedia.restoreLast(),
        false,
        "Never resume an older film"
    );
});

test("Unavailable cold item falls back once without deleting its saved position", () => {
    for (const throwing of [false, true]) {
        const c = coldResumeFixture();
        c.deferResume = true;
        if (throwing)
            c.providerMediaClient.resolve = () => {
                throw new Error("private provider detail");
            };
        let failures = 0;
        assert.equal(
            c.__ottMedia.restoreLast(() => failures++),
            true
        );
        if (!throwing) {
            c.finishResume(null);
            c.finishResume(null);
        }
        assert.equal(failures, 1);
        assert.equal(c.documentState().history[0].position, 123.4);
        assert(!c.calls.some((call) => call[0] === "play"));
        assert(!JSON.stringify(c.calls).includes("private provider detail"));
    }
});

test("Stop, Back, navigation and source changes cancel pending cold playback and fallback", () => {
    const cancel = [
        (c) => c.__ottMedia.cancelAuto(),
        (c) => c.__ottMedia.cancel(),
        (c) => c.__ottMedia.back(),
        (c) => c.mediaList("catalog.xml"),
        (c) => (c.p_pref = "another-source"),
        (c) => (c.providerMediaClient = { ...c.providerMediaClient }),
        (c) => c.__ottClassicPlayback.command({ type: "stop" }),
    ];
    for (const stop of cancel) {
        for (const result of [{}, null]) {
            const c = coldResumeFixture();
            c.deferResume = true;
            let failures = 0;
            c.__ottMedia.restoreLast(() => failures++);
            const finish = c.finishResume;
            stop(c);
            finish(result);
            assert.equal(failures, 0);
            assert(!c.calls.some((call) => call[0] === "play"));
        }
    }
});

test("Cold resume preserves parental authorization and rejects cancelled PIN callbacks", () => {
    for (const cancel of [false, true]) {
        const c = coldResumeFixture();
        c.changeSaved((doc) => (doc.history[0].payload.adult = 1));
        c.parentPIN = "1234";
        c.parentAccess = false;
        let unlock;
        c.enterPinAndSetAccess = (done) => (unlock = done);
        assert.equal(c.__ottMedia.restoreLast(), true);
        assert.equal(c.resolutions.length, 0);
        if (cancel) c.__ottMedia.cancelAuto();
        unlock();
        assert.equal(c.resolutions.length, cancel ? 0 : 1);
        assert.equal(
            c.calls.filter((call) => call[0] === "play").length,
            cancel ? 0 : 1
        );
    }
});

test("A manual selection supersedes a pending cold restore", () => {
    const c = coldResumeFixture();
    c.deferResume = true;
    c.__ottMedia.restoreLast();
    const late = c.finishResume;
    c.catalogs[""] = [
        { id: 84, request: { path: "/library/metadata/84" }, title: "Chosen" },
    ];
    c.mediaList("");
    c.selectMedia(0);
    const selected = c.finishResume;
    late();
    assert(!c.calls.some((call) => call[0] === "play"));
    selected();
    assert.equal(c.__ottMedia.current().ref.itemId, "provider:84");
    assert.equal(c.calls.filter((call) => call[0] === "play").length, 1);
});

test("A resumed standalone film completes once and is not restored after the next cold boot", () => {
    const c = coldResumeFixture(123.4);
    c.__ottMedia.restoreLast();
    const playback = c.__ottMedia.current();
    assert.equal(playback.sequence, null);
    c.__ottClassicPlayback.command({
        duration: 600,
        position: 600,
        type: "position",
    });
    // The owned backend translates natural EOS to stop, then passes that
    // generation to Media; manual Stop does not call the completion hook.
    c.__ottClassicPlayback.command({ type: "stop" });
    const generation = c.__ottClassicPlayback.snapshot().generation;
    c.__ottMedia.ended(generation);
    assert.equal(playback.ended, true);
    assert.equal(c.documentState().history[0].position, 0);
    const completed = c.stored[c.journalKey];
    c.__ottMedia.ended(generation);
    c.__ottMedia.checkpoint(playback.ref, 600, true);
    assert.equal(c.stored[c.journalKey], completed);
    assert.equal(c.calls.filter((call) => call[0] === "play").length, 1);
    const reopened = coldResumeFixture();
    Object.assign(reopened.stored, c.stored);
    assert.equal(reopened.__ottMedia.restoreLast(), false);
    assert.equal(reopened.resolutions.length, 0);
});

test("Natural completion clears ordinary standalone films without creating a queue", () => {
    const c = fixture();
    c.mediaList("");
    c.selectMedia(0);
    const playback = c.__ottMedia.current();
    assert.equal(playback.sequence, null);
    c.__ottClassicPlayback.command({
        duration: 600,
        position: 600,
        type: "position",
    });
    c.__ottClassicPlayback.command({ type: "stop" });
    c.__ottMedia.ended(c.__ottClassicPlayback.snapshot().generation);
    assert.equal(c.documentState().history[0].position, 0);
    assert.equal(c.calls.filter((call) => call[0] === "play").length, 1);
});

test("Standalone completion retains source, generation and natural-EOS ownership", () => {
    const idle = fixture();
    idle.__ottMedia.ended(0);
    for (const action of ["playing", "manual-stop", "source", "generation"]) {
        const c = coldResumeFixture(123.4);
        c.__ottMedia.restoreLast();
        const playback = c.__ottMedia.current();
        const generation = c.__ottClassicPlayback.snapshot().generation;
        if (action !== "playing")
            c.__ottClassicPlayback.command({ type: "stop" });
        if (action === "source") c.p_pref = "different-account";
        if (action !== "manual-stop")
            c.__ottMedia.ended(
                action === "source" ? generation + 1 : generation
            );
        assert(!playback.ended, action);
        assert.equal(
            JSON.parse(c.stored[c.journalKey]).history[0].position,
            123.4,
            action
        );
    }
});

function pagingFixture() {
    const c = fixture();
    const pending = [];
    const row = (id, title = "Movie " + id) => ({
        itemId: String(id),
        stream_url: id + ".mp4",
        title,
    });
    const next = (page) => ({
        __ottMediaNext: true,
        itemId: "page:" + page,
        playlist_url: "page:" + page,
        title: "Next Page",
    });
    c.catalogs[""] = [{ playlist_url: "catalog.xml", title: "Movies" }];
    c.catalogs["catalog.xml"] = Array.from({ length: 8 }, (_, i) =>
        row(i)
    ).concat(next(1));
    c.providerMediaClient = {
        cancel() {},
        page(target, done) {
            const request = { aborted: false, done, target };
            pending.push(request);
            return () => {
                request.aborted = true;
            };
        },
    };
    c.mediaList(null);
    c.selectMedia(0);
    const highlight = (index) => {
        c.__ottMedia.highlight(index, c.__ottMedia.snapshot().revision);
        while (c.timers.length) c.timers.shift()();
    };
    return { c, highlight, next, pending, row };
}

test("Near-end paging waits for pending shuffle collection, PIN and resolution", () => {
    for (const phase of ["collect", "pin", "resolve"]) {
        const { c, highlight, pending } = pagingFixture();
        c.Math = Object.create(Math);
        c.Math.random = () => 0;
        if (phase === "pin") c.catalogs["catalog.xml"][1].adult = 1;
        let collect;
        let resolved;
        c.providerMediaClient.collect = (_target, done) => {
            collect = () => done({ items: c.catalogs["catalog.xml"] });
            return () => {};
        };
        c.providerMediaClient.resolve = (item, done) => {
            resolved = () => done(item);
        };
        c.__ottMedia.toggleShuffle();
        if (phase !== "collect") collect();
        assert.equal(c.__ottMedia.snapshot().shuffle, "loading", phase);
        highlight(5);
        assert.equal(pending.length, 0, phase);
        assert.equal(c.__ottMedia.snapshot().frame.selected, 5, phase);
        c.__ottMedia.toggleShuffle();
        assert.equal(c.__ottMedia.snapshot().shuffle, "off", phase);
        highlight(5);
        assert.equal(
            pending.length,
            1,
            phase + ": paging resumes after cancel"
        );
        c.parentAccess = true;
        if (phase === "collect") collect();
        else if (phase === "pin") c.unlock();
        else resolved();
        assert.equal(c.calls.filter((row) => row[0] === "play").length, 0);
    }
});

test("Near-end paging appends once without a navigation frame or selection jump", () => {
    const { c, highlight, next, pending, row } = pagingFixture();
    const before = c.__ottMedia.snapshot();
    highlight(4);
    assert.equal(pending.length, 0);
    highlight(5);
    assert.equal(pending.length, 1);
    assert.equal(
        c.__ottMedia.snapshot().loading,
        false,
        "paging is not a new folder load"
    );
    assert.match(c.getListItemFn(c.listArray[8], 8), /Loading/);
    highlight(8);
    c.selectMedia(8);
    assert.equal(
        pending.length,
        1,
        "Enter while loading does not duplicate the request"
    );
    pending[0].done({ items: [row(7), row(8), row(9), next(2)] });
    const after = c.__ottMedia.snapshot();
    assert.equal(after.frames.length, before.frames.length);
    assert.deepEqual(plain(after.frame.route), plain(before.frame.route));
    assert.equal(after.frame.selected, 8);
    assert.equal(c.listArray[8].title, "Movie 8");
    assert.equal(c.listArray.filter((x) => x.itemId === "7").length, 1);
    assert.equal(c.listArray.filter((x) => x.__ottMediaFilter).length, 1);
    c.__ottMedia.back();
    assert.equal(c.__ottMedia.snapshot().frames.length, 1);
    assert.equal(c.listArray[0].title, "Movies");
});

test("Paging preserves a newer highlight and retains retry state on errors", () => {
    const { c, highlight, pending, row } = pagingFixture();
    highlight(5);
    highlight(2);
    pending[0].done({ error: "unavailable", items: [] });
    assert.equal(c.__ottMedia.snapshot().frame.selected, 2);
    assert.equal(c.listArray[0].title, "Movie 0");
    assert.match(c.getListItemFn(c.listArray[8], 8), /Select to retry/);
    highlight(8);
    assert.equal(pending.length, 1, "failed pages never auto-retry in a loop");
    c.selectMedia(8);
    assert.equal(pending.length, 2);
    highlight(1);
    pending[1].done({ items: [row(8)] });
    assert.equal(c.__ottMedia.snapshot().frame.selected, 1);
    assert.equal(c.listArray[1].title, "Movie 1");
});

test("Back, close, filter and playback cancel page ownership and reject late replies", () => {
    for (const action of ["back", "close", "filter", "play", "source"]) {
        const { c, highlight, pending, row } = pagingFixture();
        highlight(8);
        if (action === "back") c.__ottMedia.back();
        if (action === "close") c.__ottMedia.cancel();
        if (action === "filter") c.__ottMedia.filter();
        if (action === "play") c.selectMedia(0);
        if (action === "source") {
            c.p_pref = "replacement";
            c.mediaList("");
        }
        assert.equal(pending[0].aborted, true, action);
        const before = JSON.stringify(c.__ottMedia.snapshot());
        pending[0].done({ items: [row(999, "Stale response")] });
        assert.equal(JSON.stringify(c.__ottMedia.snapshot()), before, action);
        if (action === "close")
            assert.equal(
                c.__ottMedia.snapshot().frames.length,
                2,
                "closing a loading cursor retains the current directory"
            );
    }
});

test("Filtered cursor replacement focuses first visible insertion and empty pages remove the cursor", () => {
    const { c, highlight, pending, row } = pagingFixture();
    c.__ottMedia.filter();
    c.editvar = "Movie 7";
    c.setEdit();
    const cursor = c.listArray.findIndex((x) => x.__ottMediaNext);
    highlight(cursor);
    pending[0].done({ items: [row(8, "Hidden"), row(9, "Movie 7 sequel")] });
    assert.equal(c.listArray[c.selIndex].title, "Movie 7 sequel");
    assert(!c.listArray.some((x) => x.__ottMediaNext));
    const empty = pagingFixture();
    empty.highlight(8);
    empty.pending[0].done({ items: [] });
    assert(!empty.c.listArray.some((x) => x.__ottMediaNext));
    assert.equal(empty.c.__ottMedia.snapshot().frames.length, 2);
});

test("Cached filtered pages keep scheduling after an immediate append", () => {
    const { c, next, row } = pagingFixture();
    const before = c.__ottMedia.snapshot();
    const requested = [];
    // Real list painting highlights the selected row, including loading rows.
    c.showPage = () => c.detailListActionFn();
    c.providerMediaClient.page = (target, done) => {
        requested.push(target);
        done({
            items:
                target === "page:1"
                    ? [row(8, "Hidden"), next(2)]
                    : [row(9, "Needle result")],
        });
        return () => {};
    };
    c.__ottMedia.filter();
    c.editvar = "needle";
    c.setEdit();
    let ticks = 0;
    while (c.timers.length && ticks++ < 20) c.timers.shift()();
    assert.deepEqual(requested, ["page:1", "page:2"]);
    assert.equal(c.timers.length, 0, "cached responses cannot loop timers");
    const after = c.__ottMedia.snapshot();
    assert.deepEqual(plain(after.frame.route), plain(before.frame.route));
    assert.equal(after.frames.length, before.frames.length);
    assert.equal(c.listArray[c.selIndex].title, "Needle result");
    assert(!c.listArray.some((item) => item.__ottMediaNext));
    assert.equal(c.calls.filter((call) => call[0] === "play").length, 0);
});

test("Reentrant page cancellation rejects the old selected file and filter action", () => {
    for (const action of ["play", "filter"]) {
        const { c, highlight, row } = pagingFixture();
        let armed = true;
        let late;
        c.catalogs.replacement = [row(999, "Replacement")];
        c.providerMediaClient.page = (_, done) => {
            late = done;
            return () => {
                if (!armed) return;
                armed = false;
                c.mediaList("replacement");
            };
        };
        highlight(5);
        const editor = c.setEdit;
        if (action === "play") c.selectMedia(0);
        else c.__ottMedia.filter();
        assert.equal(armed, false, action);
        assert.equal(c.__ottMedia.snapshot().frame.route.target, "replacement");
        assert.equal(c.listArray[0].title, "Replacement");
        assert.equal(c.calls.filter((call) => call[0] === "play").length, 0);
        assert.equal(c.calls.filter((call) => call[0] === "edit").length, 0);
        assert.equal(
            c.setEdit,
            editor,
            "the old action cannot install an editor"
        );
        const after = JSON.stringify(c.__ottMedia.snapshot());
        late({ items: [row(1000, "Stale response")] });
        assert.equal(JSON.stringify(c.__ottMedia.snapshot()), after, action);
    }
});

test("Stable appended media retains the folder origin and saved breadcrumb", () => {
    const { c, highlight, pending, row } = pagingFixture();
    c.providerMediaClient.stableRequests = true;
    const before = plain(
        c.__ottMedia.snapshot().frames.map((frame) => frame.route)
    );
    highlight(8);
    pending[0].done({ items: [row(8)] });
    const appended = c.listArray[8];
    assert.deepEqual(plain(appended.__ottMediaOrigin), before.at(-1));
    c.selectMedia(8);
    const saved = c.documentState().history[0];
    assert.equal(saved.itemId, "provider:8");
    assert.deepEqual(plain(saved.payload.__ottMediaOrigin), before.at(-1));
    assert.deepEqual(
        plain(saved.payload.__ottMediaTrail.map((frame) => frame.route)),
        before
    );
    assert.equal(saved.payload.__ottMediaTrail.at(-1).selected, 8);
});

test("Appended same-title folders retain route identity and repeated cursors stop", () => {
    const { c, highlight, next, pending } = pagingFixture();
    c.providerMediaClient.stableRequests = true;
    const folder = (path) => ({
        playlist_url: path,
        title: "Same folder name",
    });
    const before = c.__ottMedia.snapshot();
    highlight(8);
    pending[0].done({ items: [folder("folder:a"), next(2)] });
    highlight(c.listArray.findIndex((item) => item.__ottMediaNext));
    pending[1].done({
        items: [folder("folder:b"), folder("folder:a"), next(1)],
    });
    const folders = c.listArray.filter(
        (item) => item.title === "Same folder name"
    );
    assert.deepEqual(plain(folders.map((item) => item.playlist_url)), [
        "folder:a",
        "folder:b",
    ]);
    assert.notEqual(
        folders[0].__ottMediaRef.itemId,
        folders[1].__ottMediaRef.itemId
    );
    assert(!c.listArray.some((item) => item.__ottMediaNext));
    highlight(c.selIndex);
    assert.equal(
        pending.length,
        2,
        "a repeated cursor cannot create a fetch cycle"
    );
    const after = c.__ottMedia.snapshot();
    assert.equal(after.frames.length, before.frames.length);
    assert.deepEqual(plain(after.frame.route), plain(before.frame.route));
});

test("A page reply preserves foreground overlays and retries after they close", () => {
    for (const kind of ["dialog", "editor", "picker"]) {
        const { c, highlight, pending, row } = pagingFixture();
        const port = c.__ottClassicScreenPort;
        c.showPage = () => port.commitList();
        c.mediaList(null);
        highlight(5);
        const owner = port.listOwner();
        const overlay = port.openOverlay(kind, () => {});
        const projection = JSON.stringify(c.listArray);
        assert(overlay.foreground(), kind);
        pending[0].done({ items: [row(8)] });
        assert.equal(pending[0].aborted, true, kind);
        assert(overlay.active() && overlay.foreground(), kind);
        assert.equal(port.listOwner(), owner, kind);
        assert(owner.active(), kind);
        assert.equal(JSON.stringify(c.listArray), projection, kind);
        port.close(kind);
        assert(owner.foreground(), kind);
        highlight(5);
        assert.equal(pending.length, 2, kind);
        pending[0].done({ items: [row(999, "Stale response")] });
        pending[1].done({ items: [row(8)] });
        assert.equal(c.listArray[8].title, "Movie 8", kind);
        assert(!c.listArray.some((item) => item.itemId === "999"), kind);
    }
});

(async () => {
    for (const run of cases) await run();
    console.log(`PASS MediaLibrary/MediaJournal ${groups} scenario groups`);
    require("./test_media_filter_ownership.cjs");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
