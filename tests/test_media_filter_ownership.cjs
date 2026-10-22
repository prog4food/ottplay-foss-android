const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { fixture, sourceFunctions } = require("./test_port_vod.cjs");

function applyFilter(c, value) {
    c.__ottMedia.filter();
    c.editvar = value;
    c.setEdit();
}

function visibleIds(c) {
    return Array.from(
        c.listArray.filter((row) => row.id),
        (row) => row.id
    );
}

test("Media filtering uses the interface Unicode rules and preserves original titles", () => {
    for (const [locale, title, query] of [
        ["_ger", "Straße", "STRASSE"],
        ["_fra", "Café", "Cafe\u0301"],
        ["_tur", "IŞIK", "ışık"],
        ["_rus", "Ёлка   дома", "елка дома"],
    ]) {
        const c = fixture();
        c.__ottInterfaceLanguage = locale;
        c.catalogs[""] = [
            { id: 1, stream_url: "match.mp4", title },
            { id: 2, stream_url: "other.mp4", title: "Unrelated" },
        ];
        c.mediaList(null);
        applyFilter(c, query);
        assert.deepEqual(visibleIds(c), [1], locale + ": " + query);
        assert.equal(c.listArray.find((row) => row.id === 1).title, title);
        assert.equal(c.__ottMedia.snapshot().filter, query);
        c.__ottMedia.shufflePlay();
        assert.deepEqual(
            c.calls.filter((call) => call[0] === "play"),
            [["play", "match.mp4"]],
            "Shuffle obeys the same Unicode filter"
        );
    }
    const c = fixture();
    c.__ottInterfaceLanguage = "_fra";
    c.catalogs[""] = [{ id: 1, stream_url: "accent.mp4", title: "Café" }];
    c.mediaList(null);
    applyFilter(c, "Cafe");
    assert.deepEqual(visibleIds(c), [], "Significant accents are preserved");
});

test("Navigation during resolver cancellation discards the interrupted filter edit", () => {
    const c = fixture();
    let replaceOnCancel = false;
    c.catalogs[""] = [
        { id: 1, stream_url: "a.mp4", title: "Other" },
        { id: 2, stream_url: "b.mp4", title: "Match" },
    ];
    c.catalogs.child = [
        { id: 3, stream_url: "c.mp4", title: "Other child" },
        { id: 4, stream_url: "d.mp4", title: "Match child" },
    ];
    c.providerMediaClient = {
        cancel() {
            if (!replaceOnCancel) return;
            replaceOnCancel = false;
            c.__ottMedia.open("child");
        },
        resolve() {},
    };
    c.mediaList(null);
    c.selectMedia(0);
    c.__ottMedia.filter();
    c.editvar = "match";
    replaceOnCancel = true;
    c.setEdit();
    assert.equal(c.__ottMedia.snapshot().frame.route.target, "child");
    assert.equal(c.__ottMedia.snapshot().filter, "");
    assert.deepEqual(visibleIds(c), [3, 4]);
    c.__ottMedia.back();
    assert.equal(c.__ottMedia.snapshot().filter, "");
    assert.deepEqual(visibleIds(c), [1, 2]);
});

test("A highlight from before refilter cannot change selection in the new projection", () => {
    const c = fixture();
    c.catalogs[""] = [
        { id: 1, stream_url: "a.mp4", title: "Other" },
        { id: 2, stream_url: "b.mp4", title: "Match A" },
        { id: 3, stream_url: "c.mp4", title: "Match B" },
    ];
    c.mediaList(null);
    const staleRevision = c.__ottMedia.snapshot().revision;
    applyFilter(c, "match");
    assert.equal(c.__ottMedia.snapshot().frame.selected, 0);
    c.__ottMedia.highlight(1, staleRevision);
    assert.equal(c.__ottMedia.snapshot().frame.selected, 0);
    c.__ottMedia.highlight(1, c.__ottMedia.snapshot().revision);
    assert.equal(c.__ottMedia.snapshot().frame.selected, 1);
});

test("Incremental replacement at the same selected index revokes an old PIN intent", () => {
    const c = fixture();
    let publish;
    c.getMediaArray = (_target, done) => {
        publish = done.publish;
        c.mediaRecords = [
            { adult: 1, id: 1, stream_url: "old.mp4", title: "Old" },
        ];
        done();
    };
    c.sPSchannels = 1;
    c.parentPIN = "1234";
    c.parentAccess = false;
    c.mediaList(null);
    c.selectMedia(0);
    const oldApproval = c.unlock;
    assert.equal(typeof oldApproval, "function");
    publish(
        [{ adult: 1, id: 2, stream_url: "new.mp4", title: "New" }],
        "Updated",
        0
    );
    assert.equal(c.listArray[0].id, 2);
    oldApproval();
    assert.equal(c.calls.filter((call) => call[0] === "play").length, 0);
});

test("Committing a filter revokes a pending autoplay PIN without changing episode membership", () => {
    const c = fixture();
    c.catalogs[""] = [
        {
            __ottMediaSequence: true,
            id: 1,
            stream_url: "one.mp4",
            title: "One",
        },
        {
            __ottMediaSequence: true,
            adult: 1,
            id: 2,
            stream_url: "two.mp4",
            title: "Two",
        },
    ];
    c.sPSchannels = 1;
    c.parentPIN = "1234";
    c.parentAccess = false;
    c.mediaList(null);
    c.selectMedia(0);
    c.__ottClassicPlayback.command({ type: "stop" });
    c.__ottMedia.ended(c.__ottClassicPlayback.snapshot().generation);
    const oldApproval = c.unlock;
    assert.equal(typeof oldApproval, "function");
    applyFilter(c, "unrelated title");
    assert.deepEqual(visibleIds(c), [1, 2]);
    oldApproval();
    assert.equal(c.calls.filter((call) => call[0] === "play").length, 1);
});

test("Favorite removal cannot overwrite navigation opened during its journal write", () => {
    const c = fixture();
    const write = c.providerSetItem;
    let navigateDuringWrite = false;
    c.providerSetItem = (key, value) => {
        write(key, value);
        if (navigateDuringWrite && key.startsWith("mediaJournal.v1:")) {
            navigateDuringWrite = false;
            c.__ottMedia.open("child");
        }
    };
    c.catalogs[""] = [{ id: 1, stream_url: "a.mp4", title: "Favorite" }];
    c.catalogs.child = [{ id: 2, stream_url: "b.mp4", title: "Child" }];
    c.mediaList(null);
    c.__ottMedia.favorite(c.listArray[0]);
    c.__ottMedia.open(-2);
    navigateDuringWrite = true;
    c.__ottMedia.favorite(c.listArray[0]);
    assert.equal(c.documentState().favorites.length, 0);
    assert.equal(c.__ottMedia.snapshot().frame.route.target, "child");
    assert.deepEqual(visibleIds(c), [2]);
});

function startEpisodes(c) {
    c.catalogs[""] = [
        {
            __ottMediaSequence: true,
            id: 1,
            stream_url: "one.mp4",
            title: "One",
        },
        {
            __ottMediaSequence: true,
            id: 2,
            stream_url: "two.mp4",
            title: "Two",
        },
    ];
    c.closeList = () => c.__ottMedia.cancel();
    c.mediaList(null);
    c.selectMedia(0);
}

function finishEpisode(c) {
    c.__ottClassicPlayback.command({ type: "stop" });
    c.__ottMedia.ended(c.__ottClassicPlayback.snapshot().generation);
}

for (const editor of ["filter", "search"]) {
    test(
        "An owned " + editor + " save survives background episode advance",
        () => {
            const c = fixture();
            startEpisodes(c);
            c.mediaList(null);
            if (editor === "filter") c.__ottMedia.filter();
            else c.searchMedia({ playlist_url: "search", title: "Search" });
            const save = c.setEdit;
            const before = c.__ottMedia.snapshot();
            const rows = c.listArray;
            // The same saved callback receives text returned from SWOP or typed locally.
            c.editvar = "Три кота & café";
            finishEpisode(c);
            assert.equal(c.calls.filter((row) => row[0] === "play").length, 2);
            assert.strictEqual(c.listArray, rows);
            assert.equal(c.__ottMedia.snapshot().revision, before.revision);
            save();
            if (editor === "filter")
                assert.equal(c.__ottMedia.snapshot().filter, "Три кота & café");
            else {
                assert.equal(c.stored.medSearch, "Три кота & café");
                assert.equal(
                    c.__ottMedia.snapshot().frame.route.target,
                    "search?search=" + encodeURIComponent("Три кота & café")
                );
            }
        }
    );
}

function actualVPortalEpisodes() {
    const c = fixture();
    const requests = [];
    vm.runInContext(
        sourceFunctions("src/plugins/vportal.ts", [
            "parseVPortalLink",
            "hostedVPortalRoute",
            "createVPortalClient",
        ]),
        c
    );
    c.$.ajax = (options) => {
        const request = {
            abort() {
                request.aborted = true;
                options.error({}, "abort");
                options.complete();
            },
            aborted: false,
            reply(data) {
                options.success(data);
                options.complete();
            },
        };
        requests.push(request);
        return request;
    };
    c.closeList = () => {
        c.__ottClassicScreenPort.closeList();
        c.cancelMediaLoad();
    };
    c.showPage = () => c.__ottClassicScreenPort.commitList();
    c.providerMediaClient = c.createVPortalClient(
        "portal::[key:synthetic-test-only]https://portal.test/api"
    );
    c.getMediaArray = c.providerMediaClient.load;
    c.mediaList(null);
    requests[0].reply({
        items: [
            { request: { cmd: "play", fid: 1 }, title: "One", type: "stream" },
            { request: { cmd: "play", fid: 2 }, title: "Two", type: "stream" },
        ],
        title: "Series",
        type: "multistream",
    });
    c.selectMedia(0);
    requests[1].reply({ url: "https://media.test/one.mp4" });
    assert.equal(c.calls.filter((row) => row[0] === "play").length, 1);
    return { c, requests };
}

for (const first of ["catalog", "episode"]) {
    test(
        "Actual VPortal preserves catalog and autoplay when " +
            first +
            " responds first",
        () => {
            const { c, requests } = actualVPortalEpisodes();
            c.__ottMedia.open({
                mediaName: "Child",
                request: { cmd: "list", fid: "child" },
            });
            const catalog = requests[2];
            const busy = c.dialogBoxKeyHandler;
            finishEpisode(c);
            assert.equal(requests.length, 4);
            const episode = requests[3];
            assert.equal(catalog.aborted, false);
            assert.strictEqual(
                c.dialogBoxKeyHandler,
                busy,
                "Background autoplay must not replace the user's catalog dialog"
            );
            const catalogData = {
                items: [
                    {
                        title: "Child movie",
                        type: "stream",
                        url: "https://media.test/child.mp4",
                    },
                ],
                type: "category",
            };
            if (first === "catalog") {
                catalog.reply(catalogData);
                assert.equal(episode.aborted, false);
                episode.reply({ url: "https://media.test/two.mp4" });
            } else {
                episode.reply({ url: "https://media.test/two.mp4" });
                assert.equal(catalog.aborted, false);
                catalog.reply(catalogData);
            }
            assert.equal(
                c.__ottMedia.snapshot().frame.route.target.request.fid,
                "child"
            );
            assert.equal(
                c.__ottMedia.snapshot().frame.items[0].title,
                "Child movie"
            );
            assert.deepEqual(
                c.calls.filter((row) => row[0] === "play").map((row) => row[1]),
                ["https://media.test/one.mp4", "https://media.test/two.mp4"]
            );
        }
    );
}
