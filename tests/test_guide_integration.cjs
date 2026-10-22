const assert = require("node:assert/strict");
const fixture = require("./helpers/guide-runtime-fixture.cjs");
const privateRuntime = require("./helpers/private-runtime.cjs");
const vm = require("node:vm");
let count = 0;
function check(name, run) {
    run();
    count++;
    console.log("PASS guide integration: " + name);
}
check(
    "actual guide search uses canonical Unicode and selected-language casing",
    () => {
        for (const [locale, title, query] of [
            ["_eng", "Café", "Cafe\u0301"],
            ["_kor", "한 TV", "한"],
            ["_tur", "IŞIK", "ışık"],
        ]) {
            const f = fixture(),
                h = f.host;
            h.__ottInterfaceLanguage = locale;
            h.getChannelEpgCached(1, () => {});
            f.tick();
            f.complete([f.row(undefined, undefined, title)]);
            const results = h.__ottClassicGuide.search(query);
            assert.equal(results.length, 1);
            assert.equal(results[0].name, title);
        }
    }
);
check(
    "provider response coalesces and cache values cannot mutate owned schedules",
    () => {
        const f = fixture(),
            h = f.host,
            out = [];
        h.getChannelEpgCached(1, (_id, rows) => out.push(rows));
        h.getChannelEpgCached(1, (_id, rows) => out.push(rows));
        f.tick();
        assert.equal(f.requests.length, 1);
        f.complete([f.row()]);
        assert.equal(out.length, 2);
        out[0][0].name = "bad";
        assert.equal(h.getCachedChannelEpg(1)[0].name, "Programme");
        assert.equal(h.channels[1].name, "Programme");
        h.channels[1].name = "bad";
        assert.equal(h.channels[1].name, "Programme");
        assert.equal(h.epg[1][0].name, "Programme");
    }
);
check(
    "now/next seed does not become a full response cache and preserves next item",
    () => {
        const f = fixture(),
            h = f.host;
        h.setCurProg(1, [f.row(), f.row(f.now() + 100, f.now() + 200, "Next")]);
        assert.equal(h.channels[1].name, "Programme");
        assert.equal(h.channels[1].nextpr[0].name, "Next");
        assert.equal(h.getCachedChannelEpg(1), null);
    }
);
check("current subscribers repaint asynchronously and miss cannot spin", () => {
    const f = fixture(),
        h = f.host;
    let repaint = 0;
    h.getCurProgData(1, () => {
        repaint++;
        h.getCurProgData(1, () => {});
    });
    f.tick();
    f.complete(null);
    assert.equal(repaint, 1);
    assert.equal(f.requests.length, 1);
    assert.equal(h.channels[1].time_request, f.now() + 3600);
});
check("source replacement cancels backend and refuses late schedule", () => {
    const f = fixture(),
        h = f.host;
    let seen = 0;
    h.getChannelEpgCached(1, () => seen++);
    f.tick();
    h.p_pref = "provider-b";
    h.invalidateEpgCache();
    assert.equal(f.requests[0].aborts, 1);
    f.complete([f.row()]);
    assert.equal(seen, 0);
    assert.equal(h.getCachedChannelEpg(1), null);
});
check(
    "warm invalidation preserves pending UI consumer but rejects old response",
    () => {
        const f = fixture(),
            h = f.host;
        h.epgList(0, 0, false);
        f.tick();
        h.invalidateEpgCache(true);
        f.tick();
        f.complete([f.row(undefined, undefined, "Old")], 0);
        assert.equal(h.listArray.length, 0);
        f.complete([f.row(undefined, undefined, "Fresh")], 1);
        assert.equal(h.listArray[0].name, "Fresh");
    }
);
check(
    "replacement guide screen cannot be hijacked by a canceled EPG response",
    () => {
        const f = fixture(),
            h = f.host;
        h.epgList(0, 0, false);
        f.tick();
        h.epgList(0, 1, false);
        f.tick();
        f.complete([f.row(undefined, undefined, "Old")], 0);
        assert.equal(h.listArray.length, 0);
        f.complete([f.row(undefined, undefined, "B")], 1);
        assert.equal(h.epg_ch_id, 2);
        assert.equal(h.listArray[0].name, "B");
    }
);
check("half-open latest-start screen selection has one current row", () => {
    const f = fixture(),
        h = f.host;
    h.epgList(0, 0, false);
    f.tick();
    f.complete([
        f.row(f.now() - 50, f.now() + 100, "Long"),
        f.row(f.now() - 10, f.now() + 10, "Overlap"),
        f.row(f.now() + 10, f.now() + 30, "Next"),
    ]);
    assert.equal(h.listArray[h.selIndex].name, "Overlap");
    assert(h.itemEPG(h.listArray[1], 1).includes("btn red"));
    assert(!h.itemEPG(h.listArray[0], 0).includes("btn red"));
});
check(
    "alphabet and records derive from same model; latest duplicate recording wins",
    () => {
        const f = fixture(),
            h = f.host;
        h.recordsList(0, 0, false);
        f.tick();
        f.complete([
            f.row(f.now() - 100, f.now() - 50, "Same"),
            f.row(f.now() - 40, f.now() - 20, "Same"),
            f.row(f.now() - 20, f.now() + 40, "Current"),
        ]);
        assert.equal(h.listArray.length, 1);
        assert.equal(h.listArray[0].time, f.now() - 40);
        h.epgListAlpha(0, 0, false);
        assert.deepEqual(
            Array.from(h.listArray, (r) => r.name),
            ["Current", "Same", "Same"]
        );
    }
);
check(
    "PIN selection survives category reorder through stable channel identity",
    () => {
        const f = fixture({ pin: true }),
            h = f.host;
        h.epgList(1, 0, false);
        f.tick();
        f.complete([f.row(f.now() - 100, f.now() - 20)]);
        h.selectEpg();
        h.cats.Group = [2, 1];
        f.prompts[0].yes();
        assert.deepEqual(
            f.calls.filter((x) => x[0] === "select"),
            [["select", 1, true]]
        );
        assert.deepEqual(
            f.calls.filter((x) => x[0] === "archive"),
            [["archive", f.now() - 100]]
        );
    }
);
check(
    "PIN source replacement, row change and archive expiry revoke play",
    () => {
        for (const mutate of [
            (h) => {
                h.p_pref = "provider-b";
            },
            (h) => {
                h.selIndex = 1;
            },
            (h, f) => {
                f.tick(f.now() + 49 * 3600);
            },
        ]) {
            const f = fixture({ pin: true }),
                h = f.host;
            h.epgList(0, 0, false);
            f.tick();
            f.complete([
                f.row(f.now() - 100, f.now() - 20),
                f.row(f.now() - 20, f.now() - 10, "Second"),
            ]);
            h.selIndex = 0;
            h.selectEpg();
            mutate(h, f);
            f.prompts[0].yes();
            assert.equal(f.calls.filter((x) => x[0] === "archive").length, 0);
        }
    }
);
check(
    "reminder record has stable IDs and no category offsets or runtime handles",
    () => {
        const f = fixture(),
            h = f.host;
        h.epgList(0, 0, false);
        f.tick();
        f.complete([
            f.row(f.now() + 120, f.now() + 240, "Future", "broadcast:7"),
        ]);
        h.setEpgTimer();
        f.prompts[0].yes();
        assert.equal(h.epgTimers.length, 1);
        const key = [...f.saved.keys()].find((x) =>
            x.includes("guideReminders:")
        );
        const record = JSON.parse(f.saved.get(key)).records[0];
        assert.equal(record.channelId, "station:a");
        assert.equal(record.id, record.programmeId);
        for (const field of ["ci", "c", "i", "ti", "ri"])
            assert.equal(record[field], undefined);
    }
);
check(
    "reminder confirmation and PIN re-resolve channel after category reorder",
    () => {
        const f = fixture({ pin: true }),
            h = f.host;
        h.startEpgTimer({
            ci: 1,
            n: "Future",
            t: f.now() + 120,
            te: f.now() + 240,
        });
        f.tick(f.now() + 120);
        const prompt = f.prompts[0];
        prompt.yes();
        assert.equal(f.prompts[1].pin, true);
        h.cats.All = [2, 1];
        h.cats.Group = [];
        f.prompts[1].yes();
        assert.deepEqual(
            f.calls.filter((x) => x[0] === "play"),
            [["play", 1]]
        );
    }
);
check("reminder removal and source replacement revoke visible prompt", () => {
    for (const remove of [false, true]) {
        const f = fixture(),
            h = f.host;
        h.startEpgTimer({
            ci: 1,
            n: "Future",
            t: f.now() + 10,
            te: f.now() + 200,
        });
        f.tick(f.now() + 10);
        const prompt = f.prompts[0];
        if (remove) h.__ottClassicReminders.dispose();
        else {
            h.p_pref = "provider-b";
            h.invalidateEpgCache();
        }
        prompt.yes();
        assert.equal(f.calls.filter((x) => x[0] === "play").length, 0);
        assert.equal(h.dialogBoxKeyHandler, null);
    }
});
check(
    "legacy saved handles are never canceled and missing reminders are retained",
    () => {
        const f = fixture({
                saved: {
                    "provider-a:epgTimers": JSON.stringify([
                        {
                            ci: 99,
                            n: "Missing",
                            ri: 2,
                            t: 10100,
                            te: 10200,
                            ti: 1,
                        },
                        { ci: 1, n: "Present", t: 10300, te: 10400 },
                    ]),
                },
            }),
            h = f.host;
        h.loadEpgTimers();
        assert.equal(h.epgTimers.length, 2);
        assert.equal(h.epgTimers[0].ci, null);
        h.channels[99] = { channel_name: "Back", rec: 48 };
        h.cats.All.push(99);
        h.loadEpgTimers();
        f.tick(10100);
        assert.equal(f.prompts.length, 1);
    }
);
check(
    "warm refresh does not redirect timer toggle into newly selected channel",
    () => {
        const f = fixture(),
            h = f.host;
        h.epgList(0, 0, false);
        f.tick();
        f.complete([f.row(f.now() + 100, f.now() + 200)]);
        h.setEpgTimer();
        const prompt = f.prompts[0];
        h.epgList(0, 1, false);
        f.tick();
        f.complete([f.row(f.now() + 100, f.now() + 200, "B")]);
        prompt.yes();
        assert.equal(h.epgTimers.length, 0);
    }
);
check(
    "legacy import claims its account before use and cannot follow account switch",
    () => {
        const f = fixture({
                saved: {
                    "provider-a:epgTimers": JSON.stringify([
                        { ci: 1, n: "Old", t: 10100, te: 10200 },
                    ]),
                },
            }),
            h = f.host;
        h.sourceId = "account-a";
        h.__ottSourceIdentity = { current: () => h.sourceId };
        h.loadEpgTimers();
        assert.equal(h.epgTimers.length, 1);
        assert.equal(
            f.saved.get("provider-a:guideReminderSource"),
            "account-a"
        );
        h.sourceId = "account-b";
        h.loadEpgTimers();
        assert.equal(h.epgTimers.length, 0);
        f.tick(10100);
        assert.equal(f.prompts.length, 0);
    }
);
check(
    "legacy claim write rejection/readback mismatch/reentrant replacement cannot schedule",
    () => {
        for (const mode of ["throw", "ignore", "reenter"]) {
            const f = fixture({
                    saved: {
                        "provider-a:epgTimers": JSON.stringify([
                            { ci: 1, n: "Old", t: 10100, te: 10200 },
                        ]),
                    },
                }),
                h = f.host;
            h.sourceId = "account-a";
            h.__ottSourceIdentity = { current: () => h.sourceId };
            h.providerSetItem = () => {
                if (mode === "throw") throw Error("blocked");
                if (mode === "reenter") {
                    h.sourceId = "account-b";
                    h.providerGetItem = () => null;
                    h.loadEpgTimers();
                }
            };
            h.loadEpgTimers();
            assert.equal(h.epgTimers.length, 0);
            f.tick(10100);
            assert.equal(f.prompts.length, 0);
        }
    }
);
check(
    "legacy hash resolves a unique stable channel alias and does not duplicate provider programme ID",
    () => {
        const f = fixture({
                saved: {
                    "provider-a:epgTimers": JSON.stringify([
                        { ci: 99, n: "Old", t: 10100, te: 10200 },
                    ]),
                },
            }),
            h = f.host;
        h.channels[1].legacyChannelId = 99;
        h.loadEpgTimers();
        assert.equal(h.epgTimers[0].ci, 1);
        h.epgList(0, 0, false);
        f.tick();
        f.complete([f.row(10100, 10200, "Updated", "provider-programme")]);
        h.setEpgTimer();
        assert.equal(f.prompts[0].text, "Remove timer?");
        f.prompts[0].yes();
        assert.equal(h.epgTimers.length, 0);
    }
);
check(
    "ambiguous legacy hashes remain unresolved instead of choosing another channel",
    () => {
        const f = fixture({
                saved: {
                    "provider-a:epgTimers": JSON.stringify([
                        { ci: 99, n: "Old", t: 10100, te: 10200 },
                    ]),
                },
            }),
            h = f.host;
        h.channels[1].legacyChannelId = h.channels[2].legacyChannelId = 99;
        h.loadEpgTimers();
        assert.equal(h.epgTimers[0].ci, null);
        f.tick(10100);
        assert.equal(f.prompts.length, 0);
    }
);
check(
    "guide request is canceled by list disposal and publication binds replacement owner",
    () => {
        const f = fixture(),
            h = f.host;
        let cleanup = null;
        h.__ottClassicScreenPort = {
            onDispose(fn) {
                cleanup = fn;
                let active = true;
                return () => {
                    if (active) {
                        active = false;
                        if (cleanup === fn) cleanup = null;
                        fn();
                    }
                };
            },
        };
        h.epgList(0, 0, false);
        f.tick();
        cleanup();
        f.complete([f.row()]);
        assert.equal(h.listArray.length, 0);
        h.showPage = () => {
            if (cleanup) cleanup();
        };
        h.epgList(0, 1, false);
        f.tick();
        f.complete([f.row()]);
        assert.equal(h.epg_ch_id, 2);
        assert(h.__ottClassicGuideScreen.current());
        cleanup();
        assert.equal(h.__ottClassicGuideScreen.current(), null);
    }
);
check(
    "global legacy backup can be claimed by only one provider namespace",
    () => {
        const f = fixture({
                saved: {
                    epgTimers: JSON.stringify([
                        { ci: 1, n: "Global", t: 10100, te: 10200 },
                    ]),
                },
            }),
            h = f.host;
        h.loadEpgTimers();
        assert.equal(h.epgTimers.length, 1);
        assert(f.saved.get("guideReminderSource"));
        h.p_pref = "provider-b";
        h.loadEpgTimers();
        assert.equal(h.epgTimers.length, 0);
        f.tick(10100);
        assert.equal(f.prompts.length, 0);
    }
);
check("projection scalar getters do not serialize programme payloads", () => {
    const f = fixture(),
        h = f.host;
    h.setCurProg(1, [f.row(), f.row(f.now() + 100, f.now() + 200, "Next")]);
    h.serializationCount = 0;
    require("node:vm").runInContext(
        "var savedStringify=JSON.stringify; JSON.stringify=function(value){serializationCount++;return savedStringify(value);};",
        h
    );
    for (let i = 0; i < 100; i++) {
        assert.equal(h.channels[1].name, "Programme");
        assert(h.channels[1].time_to > 0);
        assert.equal(h.channels[1].descr, "Description");
    }
    assert.equal(h.serializationCount, 0);
    const next = h.channels[1].nextpr;
    next[0].name = "corrupt";
    assert.equal(h.channels[1].nextpr[0].name, "Next");
});
check(
    "string provider transport IDs seed owned programmes without a mutable cache copy",
    () => {
        const f = fixture(),
            h = f.host;
        h.channels = { one: { channel_name: "One", rec: 24 } };
        h.cList = h.curList = ["one"];
        h.cats.All = ["one"];
        h.epgCacheCapacity = 0;
        h.__ottClassicGuide.seed("one", [f.row()]);
        assert.equal(h.channels.one.name, "Programme");
        assert.equal(
            h.getCurProgData("one", () => {}),
            true
        );
        assert.equal(h.getCachedChannelEpg("one"), null);
        f.tick();
        assert.equal(f.requests.length, 0);
        h.getChannelEpgCached("one", () => {});
        f.tick();
        assert.equal(f.requests[0].id, "one");
    }
);
check(
    "retimed reminder revokes a parental continuation even when programme ID is unchanged",
    () => {
        const f = fixture({ pin: true }),
            h = f.host;
        const record = {
            ci: 1,
            n: "Programme",
            t: f.now() + 10,
            te: f.now() + 200,
        };
        h.startEpgTimer(record);
        f.tick(f.now() + 10);
        f.prompts[0].yes();
        assert.equal(f.prompts[1].pin, true);
        h.startEpgTimer({ ...record, te: record.te + 10 });
        f.prompts[1].yes();
        assert.equal(f.calls.filter((x) => x[0] === "play").length, 0);
    }
);
check(
    "abort reentry keeps a newer guide view instead of replacing it with the outer open",
    () => {
        const f = fixture(),
            h = f.host;
        h.epgList(0, 0, false);
        f.tick();
        f.requests[0].onCancel = () => h.epgList(0, 1, false);
        h.epgList(1, 0, false);
        f.tick();
        const latest = f.requests.at(-1);
        assert.equal(latest.id, 2);
        f.complete([f.row(undefined, undefined, "Newer")]);
        assert.equal(h.epg_ch_id, 2);
        assert.equal(h.listArray[0].name, "Newer");
    }
);
check(
    "switching sort modes and refreshing preserves selected programme identity",
    () => {
        const f = fixture(),
            h = f.host;
        h.epgList(0, 0, false);
        f.tick();
        f.complete([
            f.row(f.now() - 10, f.now() + 40, "Zulu"),
            f.row(f.now() + 40, f.now() + 100, "Alpha"),
        ]);
        h.selIndex = 1;
        const id = h.listArray[1].programmeId;
        h.epgListAlpha(0, 0, false);
        assert.equal(h.listArray[h.selIndex].programmeId, id);
        h.epgList(0, 0, false);
        assert.equal(h.selIndex, 1);
        h.invalidateEpgCache(true);
        f.tick();
        f.complete([
            f.row(f.now() - 10, f.now() + 40, "Zulu"),
            f.row(f.now() + 40, f.now() + 100, "Edited Alpha"),
        ]);
        assert.equal(h.listArray[h.selIndex].programmeId, id);
    }
);

check(
    "category actions can be dismissed without changing the selected category or stored data",
    () => {
        for (const key of ["RETURN", "EXIT", "N0", "YELLOW", "TOOLS"]) {
            const f = fixture(),
                h = f.host;
            Object.assign(h.keys, { N0: 48, TOOLS: 84, YELLOW: 405 });
            h.catIndex = h.selIndex = 1;
            h.listArray = h.catsArray;
            const state = () =>
                JSON.stringify({
                    catIndex: h.catIndex,
                    cats: h.cats,
                    catsArray: h.catsArray,
                    listArray: h.listArray,
                    primaryIndex: h.primaryIndex,
                    selIndex: h.selIndex,
                });
            const before = state(),
                saved = [...f.saved];
            h.$("#listPopUp").show();

            assert.equal(h.bucketsKeyHandler(h.keys[key]), true, key);
            assert.equal(h.$("#listPopUp").is(":visible"), false, key);
            assert.equal(state(), before, key);
            assert.deepEqual([...f.saved], saved, key);
            assert.deepEqual(f.calls, [], key);
            assert.deepEqual(f.prompts, [], key);

            // Dismissing the actions leaves the category list open; Back can
            // then close the list and return to the existing playback.
            assert.equal(h.bucketsKeyHandler(h.keys.RETURN), true);
            assert.deepEqual(f.calls, [["close"]]);
            assert.equal(state(), before, key);
        }
    }
);

check(
    "category record shortcuts use the selected category and EPG, never VOD IDs",
    () => {
        for (const key of ["RED", "PLAY", "PAUSE", "PRECH"]) {
            const f = fixture(),
                h = f.host;
            h.curList = [1];
            h.cats.Group = [2];
            h.channels[2].ch_id = 9002;
            h.getMediaArray = () =>
                assert.fail("Category archives cannot request VOD");
            h.selIndex = 1;
            assert.equal(h.bucketsKeyHandler(h.keys[key]), true);
            f.tick();
            assert.deepEqual(
                f.requests.map((r) => r.id),
                [2]
            );
            f.complete([
                f.row(f.now() - 100, f.now() - 20, "Category programme"),
            ]);
            assert.equal(h.listArray.length, 1);
            assert.equal(h.listArray[0].ch_id, 2);
            assert(f.elements.listCaption.textContent.includes("Group"));
            h.selectEpg();
            assert.deepEqual(
                f.calls.filter((x) => x[0] === "select"),
                [["select", 2, true]]
            );
            assert.deepEqual(
                f.calls.filter((x) => x[0] === "archive"),
                [["archive", f.now() - 100]]
            );
        }
    }
);

check(
    "category archive keeps per-channel latest titles, sorts results and skips unavailable guides",
    () => {
        const f = fixture(),
            h = f.host,
            now = f.now();
        h.channels[1].rec = 1;
        h.channels[3] = {
            channel_name: "Live only",
            itemId: "station:live",
            rec: 0,
        };
        h.channels[4] = {
            channel_name: "No guide",
            itemId: "station:empty",
            rec: 24,
        };
        h.cList = [1, 2, 3, 4];
        h.cats.Group = [2, 1, 3, 4];
        h.getMediaArray = () =>
            assert.fail("EPG archive must not enter provider media");
        const a = [
            f.row(now - 300, now - 250, "Same"),
            f.row(now - 100, now - 50, "Same"),
            f.row(now - 500, now - 450, "Alpha"),
            f.row(now - 3700, now - 3650, "Expired"),
            f.row(now - 10, now + 100, "Current"),
        ];
        // A cached later category member completes before the first queued member.
        h.getChannelEpgCached(1, () => {});
        f.tick();
        f.complete(a);
        h.openSelectedChannelRecordings(1);
        f.tick();
        assert.equal(f.requests.at(-1).id, 2);
        f.complete([
            f.row(now - 200, now - 150, "Same"),
            f.row(now - 600, now - 550, "Zulu"),
        ]);
        assert.equal(f.requests.at(-1).id, 4);
        f.complete(null);
        assert.deepEqual(
            f.requests.map((r) => r.id),
            [1, 2, 4]
        );
        assert.deepEqual(
            Array.from(h.listArray, (r) => r.name),
            ["Alpha", "Same", "Same", "Zulu"]
        );
        const same = Array.from(h.listArray).filter((r) => r.name === "Same");
        assert.deepEqual(
            same.map((r) => [r.ch_id, r.time]).sort((a, b) => a[0] - b[0]),
            [
                [1, now - 100],
                [2, now - 200],
            ]
        );
        assert.notEqual(same[0].programmeId, same[1].programmeId);
        h.selIndex = Array.from(h.listArray).findIndex(
            (r) => r.name === "Same" && r.ch_id === 1
        );
        h.selectEpg();
        assert.deepEqual(
            f.calls.filter((x) => x[0] === "select"),
            [["select", 1, true]]
        );
        assert.deepEqual(
            Array.from(h.epgArray, (r) => r.name),
            ["Alpha", "Same", "Same", "Current"]
        );
    }
);

check(
    "closing or replacing category recordings retires queued and late guide callbacks",
    () => {
        for (const replace of ["close", "source", "category"]) {
            const f = fixture(),
                h = f.host;
            h.cats.Group = [2];
            h.openSelectedChannelRecordings(0);
            f.tick();
            const old = f.requests[0];
            if (replace === "close") h.closeList();
            else if (replace === "source") {
                h.p_pref = "provider-b";
                h.invalidateEpgCache();
            } else h.openSelectedChannelRecordings(1);
            f.tick();
            assert.equal(old.aborts, 1);
            const pages = f.calls.filter((x) => x[0] === "page").length;
            f.complete([f.row(f.now() - 100, f.now() - 20, "Stale")], 0);
            assert.equal(f.calls.filter((x) => x[0] === "page").length, pages);
            assert(!Array.from(h.listArray).some((r) => r.name === "Stale"));
            if (replace === "category") {
                assert.equal(f.requests.at(-1).id, 2);
                f.complete([
                    f.row(f.now() - 100, f.now() - 20, "New category"),
                ]);
                assert.equal(h.listArray[0].name, "New category");
            } else
                assert.equal(
                    f.requests.length,
                    1,
                    "Retired category cannot start its next request"
                );
        }
    }
);

check(
    "category archive PIN resolves channel and programme after category and channel reorder",
    () => {
        const f = fixture({ pin: true }),
            h = f.host,
            start = f.now() - 100;
        h.cats.Group = [2, 1];
        h.openSelectedChannelRecordings(1);
        f.tick();
        f.complete([
            f.row(start, f.now() - 20, "B", "same-provider-programme"),
        ]);
        f.complete([
            f.row(start, f.now() - 20, "A", "same-provider-programme"),
        ]);
        h.selIndex = Array.from(h.listArray).findIndex((r) => r.ch_id === 2);
        h.selectEpg();
        assert.deepEqual(
            f.calls.filter((x) => x[0] === "pin"),
            [["pin", 2]]
        );
        h.catsArray = ["Group", "All"];
        h.cats.Group = [1, 2];
        f.prompts[0].yes();
        f.prompts[0].yes();
        assert.deepEqual(
            f.calls.filter((x) => x[0] === "select"),
            [["select", 2, true]]
        );
        assert.deepEqual(
            f.calls.filter((x) => x[0] === "archive"),
            [["archive", start]]
        );
    }
);

check(
    "category archive PIN rejects changed source, row, membership, retention and departed screen",
    () => {
        for (const mutation of [
            "source",
            "row",
            "membership",
            "category",
            "retention",
            "close",
        ]) {
            const f = fixture({ pin: true }),
                h = f.host;
            h.cats.Group = [2];
            h.openSelectedChannelRecordings(1);
            f.tick();
            f.complete([f.row(f.now() - 100, f.now() - 20, "B")]);
            h.selectEpg();
            assert.equal(f.prompts.length, 1);
            if (mutation === "source") h.p_pref = "provider-b";
            if (mutation === "row") h.channels[2] = { ...h.channels[2] };
            if (mutation === "membership") h.cats.Group = [];
            if (mutation === "category") h.catsArray = ["All"];
            if (mutation === "retention") f.tick(f.now() + 49 * 3600);
            if (mutation === "close") h.closeList();
            f.prompts[0].yes();
            assert.equal(
                f.calls.filter((x) => x[0] === "archive").length,
                0,
                mutation
            );
        }
    }
);

check(
    "category guide completion cannot publish a channel removed while loading",
    () => {
        const f = fixture(),
            h = f.host;
        h.cats.Group = [2];
        h.openSelectedChannelRecordings(1);
        f.tick();
        h.cats.Group = [1];
        f.complete([f.row(f.now() - 100, f.now() - 20, "Removed")]);
        assert(!Array.from(h.listArray).some((r) => r.name === "Removed"));
    }
);

check(
    "category refresh retains a non-first channel programme and selected schedule",
    () => {
        const f = fixture(),
            h = f.host,
            now = f.now();
        h.cats.Group = [2, 1];
        h.openSelectedChannelRecordings(1);
        f.tick();
        f.complete([f.row(now - 100, now - 20, "Zulu", "b-programme")]);
        f.complete([f.row(now - 200, now - 120, "Alpha", "a-programme")]);
        h.selIndex = 1;
        const selected = h.listArray[1].programmeId;
        h.__ottClassicGuideScreen.refresh();
        assert.equal(h.listArray[h.selIndex].programmeId, selected);
        h.invalidateEpgCache(true);
        h.__ottClassicGuideScreen.refresh();
        f.tick();
        f.complete([f.row(now - 100, now - 20, "Updated Zulu", "b-programme")]);
        f.complete([f.row(now - 200, now - 120, "Alpha", "a-programme")]);
        assert.equal(h.listArray[h.selIndex].programmeId, selected);
        assert.equal(h.listArray[h.selIndex].ch_id, 2);
        h.selectEpg();
        assert.deepEqual(
            f.calls.filter((x) => x[0] === "select"),
            [["select", 2, true]]
        );
        assert.deepEqual(
            Array.from(h.epgArray, (r) => r.name),
            ["Updated Zulu"]
        );
    }
);

check(
    "category cancellation reentry preserves the newer single-channel guide",
    () => {
        const f = fixture(),
            h = f.host;
        h.openSelectedChannelRecordings(0);
        f.tick();
        f.requests[0].onCancel = () => h.epgList(0, 1, false);
        h.openSelectedChannelRecordings(1);
        f.tick();
        assert.equal(f.requests.at(-1).id, 2);
        const latest = f.requests.length - 1;
        f.complete([f.row(undefined, undefined, "New guide")], latest);
        f.complete([f.row(f.now() - 100, f.now() - 20, "Stale archive")], 0);
        assert.equal(h.epg_ch_id, 2);
        assert.equal(h.listArray[0].name, "New guide");
        assert.equal(h.__ottClassicGuideScreen.current().reference.id, 2);
    }
);

check(
    "category list-owner disposal cancels a partially completed aggregate",
    () => {
        const f = fixture(),
            h = f.host;
        let cleanup;
        h.__ottClassicScreenPort = {
            onDispose(fn) {
                cleanup = fn;
                let active = true;
                return () => {
                    if (!active) return;
                    active = false;
                    if (cleanup === fn) cleanup = null;
                    fn();
                };
            },
        };
        h.openSelectedChannelRecordings(0);
        f.tick();
        f.complete([f.row(f.now() - 100, f.now() - 20, "First")]);
        assert.equal(f.requests.at(-1).id, 2);
        cleanup();
        assert.equal(f.requests.at(-1).aborts, 1);
        f.complete([f.row(f.now() - 100, f.now() - 20, "Late")]);
        assert.equal(h.listArray.length, 0);
        assert.equal(f.calls.filter((x) => x[0] === "page").length, 0);
        assert.equal(h.__ottClassicGuideScreen.current(), null);
    }
);

check("empty channel guides retain LG Back and parent-list navigation", () => {
    for (const mode of ["epgList", "epgListAlpha", "recordsList"]) {
        for (const returnToList of [false, true]) {
            for (const refreshing of [false, true]) {
                const f = fixture(),
                    h = f.host,
                    returned = [];
                for (const name of [
                    "screen-controller",
                    "input-router",
                    "classic-screen-port",
                ])
                    privateRuntime(h, "src/ui/" + name + ".ts");
                const port = h.__ottClassicScreenPort;
                const showPage = h.showPage,
                    closeList = h.closeList;
                h.showPage = () => {
                    port.commitList();
                    showPage();
                };
                h.closeList = () => {
                    port.closeList();
                    closeList();
                };
                h.keys.RETURN = 461;
                h.channelsList = (category, index) => {
                    returned.push([category, index]);
                    // Channel navigation replaces the owned guide list.
                    h.listArray = h.listDataArray = ["channels"];
                    h.listKeyHandler = () => false;
                    h.showPage();
                };
                h[mode](0, 1, returnToList);
                f.tick();
                f.complete([]);
                assert.equal(h.listArray.length, 0);
                if (refreshing) {
                    h.__ottClassicGuideScreen.refresh();
                    f.tick();
                    assert.equal(f.requests.length, 2);
                    assert.equal(f.requests[1].aborts, 0);
                }
                const owner = port.listOwner();
                port.dispatch(461, undefined, () =>
                    assert.fail("LG Back must remain owned by the guide")
                );
                assert.equal(
                    owner.active(),
                    false,
                    mode + " must retire the empty guide on LG Back"
                );
                assert.deepEqual(returned, returnToList ? [[0, 1]] : []);
                assert.equal(
                    f.calls.filter((call) => call[0] === "close").length,
                    returnToList ? 0 : 1
                );
                if (refreshing) assert.equal(f.requests[1].aborts, 1);
                const pageCount = f.calls.filter(
                    (call) => call[0] === "page"
                ).length;
                f.complete([f.row(f.now() - 100, f.now() - 20, "Late")]);
                assert.equal(
                    f.calls.filter((call) => call[0] === "page").length,
                    pageCount,
                    "A late response cannot reopen a departed guide"
                );
                assert.equal(h.__ottClassicGuideScreen.current(), null);
            }
        }
    }
});
check(
    "empty channel guide keeps channel, category and mode controls usable",
    () => {
        const f = fixture(),
            h = f.host,
            navigated = [];
        Object.assign(h.keys, {
            BLUE: 406,
            LEFT: 37,
            N1: 49,
            N3: 51,
            PREV: 424,
            RW: 412,
            YELLOW: 405,
        });
        h.epgList(0, 1, true);
        f.tick();
        f.complete([]);
        h.channelsList = (category, index) =>
            navigated.push(["channels", category, index]);
        h.bucketsList = (category) => navigated.push(["categories", category]);
        h.sArrowFun = 2;
        h.sRewFun = h.sPNFun = 1;
        for (const code of [405, 51, 37, 412, 424]) {
            assert.equal(h.listKeyHandler(code), true);
            assert.deepEqual(navigated.pop(), ["channels", 0, 1]);
        }
        for (const code of [406, 49, 415, 19]) {
            assert.equal(h.listKeyHandler(code), true);
            assert.deepEqual(navigated.pop(), ["categories", 0]);
        }
        // Mode cycling still uses the actual guide model and retains its return path.
        for (const mode of [2, 0, 1]) {
            assert.equal(h.listKeyHandler(h.keys.RED), true);
            f.tick();
            f.complete([]);
            assert.equal(h.epgListMode, mode);
            assert.equal(h.epgreturn, true);
            assert.equal(h.listArray.length, 0);
        }
    }
);
check(
    "empty guide row actions are inert and populated guide selection still plays",
    () => {
        const f = fixture(),
            h = f.host;
        Object.assign(h.keys, {
            FF: 417,
            GREEN: 404,
            INFO: 457,
            N2: 50,
            N5: 53,
            NEXT: 425,
            RIGHT: 39,
        });
        h.epgList(0, 1, false);
        f.tick();
        const start = f.now() - 100;
        f.complete([f.row(start, f.now() - 20, "Recording")]);
        h.sArrowFun = 2;
        h.sRewFun = h.sPNFun = 1;
        // A stale selection is equivalent to an empty schedule for row actions.
        h.selIndex = 3;
        const before = f.calls.length;
        for (const code of [13, 50, 53, 39, 417, 425, 457, 404])
            assert.equal(h.listKeyHandler(code), false);
        assert.equal(f.calls.length, before);
        assert.equal(f.prompts.length, 0);
        h.selIndex = 0;
        assert.equal(h.listKeyHandler(457), true);
        assert.deepEqual(f.calls.at(-1), ["description", "Recording"]);
        assert.equal(h.listKeyHandler(13), true);
        assert.deepEqual(
            f.calls.filter((call) => call[0] === "archive"),
            [["archive", start]]
        );
    }
);

check(
    "empty category recordings do not fetch VOD and return to the same moved category",
    () => {
        const f = fixture(),
            h = f.host;
        h.channels[1].rec = 0;
        h.getMediaArray = () =>
            assert.fail("Empty archives cannot fall back to VOD");
        h.openSelectedChannelRecordings(1);
        f.tick();
        assert.equal(f.requests.length, 0);
        assert.equal(h.listArray.length, 0);
        assert(
            f.calls.some(
                (x) => x[0] === "info" && x[1] === "Records library is empty"
            )
        );
        h.catsArray = ["Group", "All"];
        const returned = [];
        h.bucketsList = (category) => returned.push(category);
        h.listKeyHandler(h.keys.RETURN);
        assert.deepEqual(returned, [0]);
    }
);

check(
    "batch references preserve scalar numeric, ambiguous, duplicate and prototype-like identities",
    () => {
        const f = fixture(),
            h = f.host,
            guide = h.__ottClassicGuide;
        h.channels = Object.create(null);
        h.cList = [
            0,
            1,
            "1",
            2,
            2,
            "003",
            "__proto__",
            "constructor",
            "toString",
            "hasOwnProperty",
        ];
        for (const id of [...h.cList, "outside-list"])
            h.channels[id] = { itemId: "station:" + id, rec: 24 };
        const ids = [
                "0",
                0,
                "1",
                1,
                "2",
                2,
                "003",
                "__proto__",
                "constructor",
                "toString",
                "hasOwnProperty",
                "outside-list",
                "absent",
                999,
                null,
                undefined,
                "0",
            ],
            scalar = ids.map((id) => guide.reference(id)),
            batch = guide.references(ids);
        assert.equal(guide.reference.length, 1);
        assert.equal(batch.length, scalar.length);
        for (let i = 0; i < scalar.length; i++) {
            if (!scalar[i]) assert.equal(batch[i], null, String(ids[i]));
            else {
                assert.equal(batch[i].id, scalar[i].id);
                assert.equal(batch[i].channelId, scalar[i].channelId);
                assert.equal(batch[i].sourceId, scalar[i].sourceId);
                assert.equal(batch[i].token, scalar[i].token);
                assert.deepEqual(Object.keys(batch[i]), Object.keys(scalar[i]));
            }
        }
        assert.equal(batch[0].id, 0, "Only unique matches canonicalize type");
        assert.equal(batch[2].id, "1", "Mixed-type duplicates stay ambiguous");
        assert.equal(batch[4].id, "2", "Repeated identical IDs stay ambiguous");
        assert.notEqual(
            batch[0],
            batch[16],
            "References remain independently owned"
        );
        assert.equal(batch[0].token, batch[16].token);
    }
);

check(
    "batch reference indexes do not survive list, row or source replacement",
    () => {
        const f = fixture(),
            h = f.host,
            guide = h.__ottClassicGuide;
        h.cList = [1];
        const old = guide.references(["1"])[0];
        h.cList = ["1"];
        h.channels[1] = { ...h.channels[1], itemId: "replacement" };
        h.p_pref = "provider-b";
        const next = guide.references([1])[0];
        assert.equal(next.id, "1");
        assert.equal(next.channelId, "replacement");
        assert.notEqual(next.token, old.token);
        assert.notEqual(next.sourceId, old.sourceId);
        assert.equal(guide.valid(old), false);
        assert.equal(guide.valid(next), true);
        delete h.cList;
        h.curList = [1];
        assert.equal(guide.references(["1"])[0].id, 1);
        h.cList = [];
        assert.equal(guide.references(["1"])[0].id, "1");
        assert.deepEqual(Array.from(guide.references([])), []);
    }
);

check(
    "batch and category reference resolution scan a thousand-channel list once",
    () => {
        const f = fixture(),
            h = f.host,
            ids = Array.from({ length: 1000 }, (_, index) => index);
        let reads = 0;
        h.channels = Object.create(null);
        for (const id of ids)
            h.channels[id] = {
                channel_name: "Channel " + id,
                epg: "epg:" + id,
                itemId: "station:" + id,
                rec: 24,
            };
        h.cList = new Proxy(ids, {
            get(target, key) {
                if (/^\d+$/.test(String(key))) reads++;
                return target[key];
            },
        });
        const batch = h.__ottClassicGuide.references(ids.map(String));
        assert.equal(
            reads,
            ids.length,
            "Batch canonicalization is one linear scan"
        );
        assert.equal(batch.length, ids.length);
        for (const id of ids) {
            assert.equal(batch[id].id, id);
            assert.equal(batch[id].token, h.channels[id]);
        }
        reads = 0;
        h.cats.Group = ids;
        h.openSelectedChannelRecordings(1);
        assert.equal(
            reads,
            ids.length,
            "The actual category caller uses the batch API"
        );
        h.closeList();
        assert.equal(h.__ottClassicGuideScreen.current(), null);
    }
);

// Exercise the real list close/footer/clock with the guide owner and transport.
const footerUi = require("./test_port_vod.cjs").sourceFunctions(
    "src/ui/index.ts",
    [
        "closeList",
        "updateChannelInfo",
        "virtualTimeshiftProg",
        "initBackgroundIntervals",
    ]
);
function installFooterUi(f) {
    const h = f.host,
        query = h.$;
    h.$ = (selector) => {
        const result = query(selector);
        result.toggle = () => result;
        return result;
    };
    h.__ottClassicScreenPort = { closeList() {} };
    h.cancelMediaLoad = () => {};
    h.listElement = null;
    h.isListVisible = true;
    h.listChannel = 2;
    h.time2time = String;
    h.formatProgramDateTime = String;
    h.setInterval = (run) => run;
    h.clearInterval = () => {};
    vm.runInContext(footerUi, h);
    return h;
}
check(
    "closing the list retires hidden guide rows and restores the playing footer",
    () => {
        const f = fixture(),
            h = installFooterUi(f),
            listCallbacks = [];
        h.epgCacheCapacity = 0;
        h.getCurProgData(1, () => listCallbacks.push(1));
        h.getCurProgData(2, () => listCallbacks.push(2));
        f.tick();
        f.complete([f.row(f.now() - 10, f.now() + 10, "First")], 0);
        f.complete([f.row(f.now() - 10, f.now() + 10, "Hidden")], 1);
        h.closeList();
        assert.equal(
            h.document.getElementById("programm_name").textContent,
            "First"
        );
        listCallbacks.length = 0;
        f.tick(f.now() + 10);
        assert.deepEqual(
            f.requests.map((request) => request.id),
            [1, 2, 1]
        );
        // An idempotent close must not cancel the restored live subscription.
        h.closeList();
        assert.equal(f.requests[2].aborts, 0);
        f.complete([f.row(f.now(), f.now() + 100, "Second")], 2);
        assert.equal(
            h.document.getElementById("programm_name").textContent,
            "Second"
        );
        assert.deepEqual(listCallbacks, []);
        assert.equal(
            f.requests.length,
            3,
            "The hidden second row never refetches"
        );
        // The periodic fallback follows playback, not the last browsed channel.
        h.document.getElementById("programm_name").textContent = "";
        h.initBackgroundIntervals();
        h.__ottUiTimers.guide();
        assert.equal(
            h.document.getElementById("programm_name").textContent,
            "Second"
        );
    }
);
check(
    "closing a list during archive or VOD cancels row work without a live repaint",
    () => {
        for (const playType of [9990, -1]) {
            const f = fixture(),
                h = installFooterUi(f);
            h.playType = playType;
            h.getCurProgData(1, () => assert.fail("Retired list callback"));
            h.getCurProgData(2, () => assert.fail("Retired list callback"));
            f.tick();
            h.document.getElementById("programm_name").textContent = "Playback";
            h.closeList();
            assert.equal(f.requests[0].aborts, 1);
            f.complete([f.row()], 0);
            f.tick(f.now() + 3600);
            assert.equal(f.requests.length, 1);
            assert.equal(
                h.document.getElementById("programm_name").textContent,
                "Playback"
            );
        }
    }
);

const liveFooter = require("./test_port_vod.cjs").sourceFunctions(
    "src/ui/index.ts",
    [
        "_t2",
        "formatProgramDateTime",
        "initBackgroundIntervals",
        "updateChannelInfo",
        "virtualTimeshiftProg",
    ]
);
function installLiveFooter(f, paintLimit = 12) {
    const h = f.host;
    h.channels[1].rec = 0;
    h.time2time = (value) => String(value);
    vm.runInContext(liveFooter, h);
    let paints = 0;
    const paint = h.updateChannelInfo;
    h.updateChannelInfo = (channelId) => {
        paints += 1;
        if (paints > paintLimit) throw Error("guide repaint did not settle");
        return paint(channelId);
    };
    h.guidePaints = () => paints;
    const fetchGuide = h.getChannelEpg;
    h.getChannelEpg = (id, done) => {
        const before = f.requests.length;
        const stop = fetchGuide(id, done);
        if (f.requests.length === before + 1)
            f.requests[before].source = h.p_pref;
        return stop;
    };
    return h;
}
function footerText(h, id) {
    return h.document.getElementById(id).textContent;
}
const CLOCK_BASE = 1700000000;
function clockRows(f) {
    return [
        f.row(CLOCK_BASE, CLOCK_BASE + 60, "Programme A", "prog-a"),
        f.row(CLOCK_BASE + 60, CLOCK_BASE + 120, "Programme B", "prog-b"),
        f.row(CLOCK_BASE + 120, CLOCK_BASE + 180, "Programme C", "prog-c"),
    ];
}
function establishFooter() {
    const f = fixture({ independentClock: true, now: CLOCK_BASE + 90 });
    const h = installLiveFooter(f);
    h.updateChannelInfo(1);
    f.advanceElapsed(0);
    assert.equal(f.requests.length, 1);
    f.complete(clockRows(f));
    assert.equal(footerText(h, "programm_name"), "Programme B");
    assert.equal(footerText(h, "nprogramm_name"), "Programme C");
    assert.equal(footerText(h, "begin_time"), String(CLOCK_BASE + 60));
    h.initBackgroundIntervals();
    return { f, h };
}
check("channel scalar getters realign immediately after clock rollback", () => {
    const { f, h } = establishFooter();
    f.setEpoch(CLOCK_BASE);
    assert.equal(h.channels[1].name, "Programme A");
    assert.equal(h.channels[1].time, CLOCK_BASE);
    assert.equal(h.channels[1].time_to, CLOCK_BASE + 60);
    assert.equal(h.channels[1].nextpr[0].name, "Programme B");
    f.advanceElapsed(0);
    assert.equal(footerText(h, "programm_name"), "Programme A");
    assert.equal(f.requests.length, 1);
    assert.ok(h.guidePaints() <= 8);
    assert.ok(f.timers.size <= 4);
});
check(
    "backward epoch repaints the retained current footer without a second request",
    () => {
        const { f, h } = establishFooter();
        const started = f.requests.length;
        f.setEpoch(CLOCK_BASE);
        f.advanceElapsed(30000);
        assert.equal(f.epoch(), CLOCK_BASE + 30);
        assert.equal(f.elapsed(), 30000);
        assert.equal(
            h.observeCurrentProgramme(1, () => {}),
            true
        );
        assert.equal(footerText(h, "programm_name"), "Programme A");
        assert.equal(footerText(h, "nprogramm_name"), "Programme B");
        assert.equal(footerText(h, "begin_time"), String(CLOCK_BASE));
        assert.equal(footerText(h, "nbegin_time"), String(CLOCK_BASE + 60));
        assert.equal(f.requests.length, started);
        assert.equal(h.channels[1].time, CLOCK_BASE);
        assert.equal(h.channels[1].time_to, CLOCK_BASE + 60);
        assert.ok(h.guidePaints() <= 8);
        assert.ok(f.timers.size <= 4);
    }
);
check(
    "forward elapsed repaint selects the half-open next programme once",
    () => {
        const { f, h } = establishFooter();
        f.advanceElapsed(30000);
        assert.equal(f.epoch(), CLOCK_BASE + 120);
        assert.equal(
            h.observeCurrentProgramme(1, () => {}),
            true
        );
        assert.equal(footerText(h, "programm_name"), "Programme C");
        assert.equal(footerText(h, "begin_time"), String(CLOCK_BASE + 120));
        assert.equal(f.requests.length, 1);
    }
);
check(
    "retired guide timers stay inert while the current footer may request the new source",
    () => {
        const { f, h } = establishFooter();
        const captured = [...f.timers.values()];
        assert.equal(
            captured.filter((timer) => !timer.interval && timer.delay === 30000)
                .length,
            1
        );
        assert.equal(
            captured.filter((timer) => timer.interval && timer.delay === 1000)
                .length,
            1
        );
        const guide = captured.filter(
            (timer) => timer.interval && timer.delay === 30000
        );
        assert.equal(guide.length, 1);
        h.p_pref = "provider-b";
        h.invalidateEpgCache(false);
        h.document.getElementById("programm_name").textContent = "sentinel";
        const before = f.requests.length;
        for (const timer of captured) {
            if (timer === guide[0]) continue;
            timer.fn();
            f.advanceElapsed(0);
        }
        assert.equal(f.requests.length, before);
        assert.equal(footerText(h, "programm_name"), "sentinel");
        guide[0].fn();
        f.advanceElapsed(0);
        assert.equal(f.requests.length, before + 1);
        assert.equal(f.requests.at(-1).source, "provider-b");
        assert.equal(f.requests.at(-1).id, 1);
    }
);

check(
    "distant future footer does not repaint as forward async time advances",
    () => {
        const origin = CLOCK_BASE + 90.004;
        const f = fixture({
            independentClock: true,
            minimumDelay: 4,
            now: origin,
        });
        const h = installLiveFooter(f, 40);
        h.updateChannelInfo(1);
        f.advanceElapsed(4);
        assert.equal(f.requests.length, 1);
        f.complete([
            f.row(CLOCK_BASE + 10000, CLOCK_BASE + 10100, "Later", "later"),
        ]);
        const reference = h.__ottClassicGuide.reference(1);
        const owner = h.__ottClassicGuide.owner();
        const retained = owner.snapshot(reference);
        assert.equal(retained.current, null);
        assert.equal(retained.following[0].title, "Later");
        assert.ok(Math.abs(retained.retryAt - (f.epoch() + 3600)) < 0.01);
        f.advanceElapsed(100);
        assert.ok(h.guidePaints() <= 3, "paints " + h.guidePaints());
        assert.equal(f.requests.length, 1);
        const after = owner.snapshot(reference);
        assert.equal(after.current, null);
        assert.equal(after.retryAt, retained.retryAt);
        assert.equal(
            [...f.timers.values()].some((timer) => timer.delay <= 4),
            false
        );
    }
);

for (const delay of [0, -10]) {
    check(`nonpositive interval ${delay} advances and can be cancelled`, () => {
        const f = fixture({ independentClock: true, now: CLOCK_BASE });
        let intervals = 0;
        let timeouts = 0;
        f.host.setTimeout(() => {
            timeouts++;
        }, 0);
        const id = f.host.setInterval(() => {
            intervals++;
        }, delay);
        f.advanceElapsed(0);
        assert.equal(timeouts, 1, "zero-delay timeout remains immediate");
        assert.equal(
            intervals,
            0,
            "interval advances before its first callback"
        );
        f.advanceElapsed(3);
        assert.equal(intervals, 3);
        assert.equal(f.elapsed(), 3);
        f.host.clearInterval(id);
        f.advanceElapsed(3);
        assert.equal(intervals, 3, "cancelled interval stays retired");
        assert.equal(f.timers.has(id), false);
    });
}

console.log("PASS " + count + " guide integration scenarios");
