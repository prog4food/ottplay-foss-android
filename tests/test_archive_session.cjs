const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const sharedCore = require("./helpers/shared-core-runtime.cjs");
const { localizationRuntime } = require("./helpers/localization-runtime.cjs");
const localizationCode = localizationRuntime();
const root = path.resolve(__dirname, "..");
function include(c, names, file = "src/channels/index.ts") {
    names = require("./helpers/english-source-fixture.cjs").sourceNames(
        file,
        names
    );
    const ast = ts.createSourceFile(
        file,
        fs.readFileSync(path.join(root, file), "utf8"),
        ts.ScriptTarget.Latest,
        true
    );
    const selected = ast.statements.filter(
        (n) => ts.isFunctionDeclaration(n) && names.includes(n.name?.text)
    );
    assert.equal(selected.length, names.length);
    vm.runInContext(
        ts
            .transpileModule(selected.map((n) => n.getText(ast)).join("\n"), {
                compilerOptions: {
                    module: ts.ModuleKind.ES2015,
                    target: ts.ScriptTarget.ES5,
                },
            })
            .outputText.replace(/^export /gm, ""),
        c
    );
}
function fixture() {
    const effects = [],
        requests = [],
        prompts = [],
        elements = {},
        storage = {};
    const c = {
        _: (s) => s,
        $: () => ({ is: () => false }),
        catIndex: 0,
        cats: { All: [101, 202] },
        catsArray: ["All"],
        channels: {
            101: { channel_name: "First", rec: 24 },
            202: { channel_name: "Second", rec: 24 },
        },
        clearTimeout() {},
        console,
        curList: [101, 202],
        curProg: -1,
        Date: class extends Date {
            static now() {
                return 1000000000;
            }
        },
        document: {
            getElementById(id) {
                return (elements[id] ||= {
                    innerHTML: "",
                    style: {},
                    textContent: "",
                });
            },
        },
        epgArray: [
            { name: "One", time: 999000, time_to: 999100 },
            { name: "Two", time: 999100, time_to: 999200 },
        ],
        fileArchive: false,
        getArchiveUrl(id, start, end, programme) {
            effects.push(["resolve", id, start, end, programme]);
            return "archive:" + id + ":" + start;
        },
        getChannelEpgCached(id, done) {
            requests.push({ done, id });
        },
        getThumbnail: () => "",
        ifParentalAccessChId(_id, done) {
            if (!c.locked) return false;
            prompts.push(done);
            return true;
        },
        locked: false,
        medHistory: [],
        metadataCssUrl: (s) => s,
        metadataHtml: (s) => s || "",
        p_pref: "source-a",
        playTime: 0,
        playType: 0,
        prevArr: [],
        primaryIndex: 0,
        providerGetItem: (k) => storage[k],
        providerSetItem(k, v) {
            storage[k] = v;
        },
        setCurProg(id, rows) {
            effects.push(["guide", id, rows]);
        },
        setTimeout() {},
        settings: { prevCount: 2 },
        sFavorites: 0,
        showChannelInfo(n) {
            effects.push(["info", n]);
        },
        showShift(s) {
            effects.push(["message", s]);
        },
        stbGetLen: () => 600,
        stbGetPosTime: () => 0,
        stbIsPlaying: () => true,
        stbPause() {
            effects.push(["pause"]);
        },
        stbPlay(url, position) {
            effects.push(["open", url, position]);
            c.__ottClassicPlayback.command({ type: "playing" });
        },
        stbSetPosTime(position) {
            effects.push(["seek", position]);
            c.__ottClassicPlayback.command({ type: "playing" });
        },
        stbStop() {
            effects.push(["stop"]);
            c.__ottClassicPlayback.cancel();
            c.__ottClassicPlayback.command({ type: "stop" });
        },
        time2time: String,
    };
    c.window = c;
    vm.createContext(c);
    require("./helpers/english-source-fixture.cjs").attachSourceAliases(c);
    sharedCore(c);
    vm.runInContext(localizationCode, c);
    include(c, ["metadataText"], "src/utils/helpers.ts");
    c.__ottClassicPlayback.importLegacy(); // Explicit startup ingress for this retained-device fixture.
    include(c, [
        "playArchive",
        "timeShift",
        "liveStop",
        "updateArchiveInfo",
        "renderArchiveInfo",
        "setCurrent",
    ]);
    c.__ottRenderArchive = c.renderArchiveInfo;
    c.effects = effects;
    c.requests = requests;
    c.prompts = prompts;
    c.elements = elements;
    c.reply = (index, rows) => requests[index].done(requests[index].id, rows);
    c.opens = () => effects.filter((e) => e[0] === "open");
    return c;
}

// A live now/next subscription survives entering archive. Archive ticks and
// late guide replies must not repaint its footer with the wall-clock programme.
{
    const c = fixture();
    const callbacks = new Map();
    let nextTimer = 0;
    c.setTimeout = (fn, delay) => {
        const id = ++nextTimer;
        if (!delay) callbacks.set(id, fn);
        return id;
    };
    c.clearTimeout = (id) => callbacks.delete(id);
    const flush = () => {
        for (let turns = 0; callbacks.size; turns++) {
            assert(turns < 20, "Guide repaint callbacks converge");
            const pending = [...callbacks.values()];
            callbacks.clear();
            pending.forEach((fn) => fn());
        }
    };
    require("./helpers/guide-runtime-fixture.cjs").install(c);
    c.epgCacheCapacity = 10;
    c.$infoBar = { is: () => false };
    c.formatProgramDateTime = String;
    vm.runInContext(
        require("./test_port_vod.cjs").sourceFunctions("src/ui/index.ts", [
            "updateChannelInfo",
            "virtualTimeshiftProg",
        ]),
        c
    );
    c.epgArray = [
        { name: "Archive", time: 999000, time_to: 999200 },
        { name: "Archive next", time: 999200, time_to: 999400 },
        { name: "Live", time: 999940, time_to: 1000040 },
    ];
    c.__ottClassicGuide.seed(101, c.epgArray);
    c.updateChannelInfo(101);
    assert.equal(c.elements.programm_name.textContent, "Live");
    assert.equal(c.elements.progress.style.width, "60%");
    let publications = 0;
    const publish = c.__ottClassicGuide.publish;
    c.__ottClassicGuide.publish = (...args) => {
        publications++;
        return publish(...args);
    };
    c.sInfoChange = true;
    c.playArchive(999060);
    flush();
    assert.equal(c.elements.programm_name.textContent, "Archive");
    assert.equal(c.elements.progress.style.width, "30%");
    assert.equal(c._prog100.name, "Archive");
    assert.equal(c._prog100.time, 999000);
    const opened = c.effects.filter((e) => e[0] === "info").length;
    for (const position of [999061, 999062, 999063]) {
        c.updateArchiveInfo(position);
        flush();
        assert.equal(c.elements.programm_name.textContent, "Archive");
        assert.equal(
            c.elements.progress.style.width,
            (position - 999000) / 2 + "%"
        );
    }
    assert.equal(
        publications,
        1,
        "Position ticks do not republish the same schedule"
    );
    assert.equal(c.effects.filter((e) => e[0] === "info").length, opened);
    // A real schedule refresh can still notify the retained live subscriber.
    c.__ottClassicGuide.publish(101, c.epgArray);
    flush();
    assert.equal(c.elements.programm_name.textContent, "Archive");
    assert.equal(c.elements.progress.style.width, "31.5%");
    assert.equal(c._prog100.time, 999000);
    c.updateArchiveInfo(999220);
    flush();
    assert.equal(c.elements.programm_name.textContent, "Archive next");
    assert.equal(c.elements.progress.style.width, "10%");
    assert.equal(c.effects.filter((e) => e[0] === "info").length, opened + 1);
    c.updateArchiveInfo(999222);
    flush();
    assert.equal(c.effects.filter((e) => e[0] === "info").length, opened + 1);
    c.__ottClassicPlayback.command({ channelId: 101, type: "live" });
    c.updateChannelInfo(101);
    assert.equal(c.elements.programm_name.textContent, "Live");
    assert.equal(c.elements.progress.style.width, "60%");
    const liveOpened = c.effects.filter((e) => e[0] === "info").length;
    c.updateChannelInfo(101);
    c.updateChannelInfo(101);
    c.__ottClassicGuide.publish(101, c.epgArray);
    flush();
    assert.equal(
        c.effects.filter((e) => e[0] === "info").length,
        liveOpened,
        "Periodic live repaints and identical guide replies do not reopen the bar"
    );
    c.__ottClassicGuide.publish(101, [
        { name: "Corrected live title", time: 999940, time_to: 1000100 },
    ]);
    flush();
    assert.equal(c.elements.programm_name.textContent, "Corrected live title");
    assert.equal(c.effects.filter((e) => e[0] === "info").length, liveOpened);
    c.__ottClassicGuide.publish(101, []);
    flush();
    c.__ottClassicGuide.publish(101, [
        { name: "Corrected live title", time: 999940, time_to: 1000100 },
    ]);
    flush();
    assert.equal(c.effects.filter((e) => e[0] === "info").length, liveOpened);
    c.__ottClassicGuide.publish(101, [
        { name: "New live programme", time: 999980, time_to: 1000200 },
    ]);
    flush();
    assert.equal(c.elements.programm_name.textContent, "New live programme");
    assert.equal(
        c.effects.filter((e) => e[0] === "info").length,
        liveOpened + 1
    );
    c.updateChannelInfo(101);
    assert.equal(
        c.effects.filter((e) => e[0] === "info").length,
        liveOpened + 1
    );
}

// Position ticks reuse the full schedule projection while still updating the footer.
{
    const c = fixture();
    let mappings = 0,
        mappedRows = 0;
    const create = c.__ottArchiveSession.create;
    c.__ottArchiveSession.create = (core, ports) => {
        const publish = ports.publish;
        ports.publish = (model) => {
            const map = model.rows.map;
            model.rows.map = function (callback) {
                mappings++;
                mappedRows += this.length;
                return map.call(this, callback);
            };
            try {
                return publish(model);
            } finally {
                delete model.rows.map;
            }
        };
        return create(core, ports);
    };
    c.epgArray = Array.from({ length: 1000 }, (_, index) => ({
        name: "Programme " + index,
        time: 900000 + index * 100,
        time_to: 900100 + index * 100,
    }));
    c.playArchive(999060);
    const schedule = c.epgArray;
    assert.equal(mappings, 1, "One full conversion when adopting a schedule");
    assert.equal(mappedRows, 1000);
    assert.equal(c.elements.programm_name.textContent, "Programme 990");
    assert.equal(c.elements.progress.style.width, "60%");
    mappings = mappedRows = 0;
    for (const position of [999061, 999062, 999063]) {
        c.updateArchiveInfo(position);
        assert.equal(c.epgArray, schedule);
        assert.equal(c.curProg, 990);
        assert.equal(c.elements.programm_name.textContent, "Programme 990");
        assert.equal(c.elements.progress.style.width, position - 999000 + "%");
    }
    assert.equal(mappings, 0, "Position ticks allocate no schedule arrays");
    assert.equal(
        mappedRows,
        0,
        "Position ticks traverse no schedule for encoding"
    );
    c.updateArchiveInfo(999120);
    assert.equal(
        c.epgArray,
        schedule,
        "A programme boundary keeps the schedule"
    );
    assert.equal(c.curProg, 991);
    assert.equal(c.elements.programm_name.textContent, "Programme 991");
    assert.equal(c.elements.progress.style.width, "20%");
    c.epgArray = [{ name: "Foreign view", time: 999100, time_to: 999200 }];
    c.updateArchiveInfo(999121);
    assert.equal(c.epgArray, schedule, "A tick restores its owned projection");
    assert.equal(mappings, 0);

    // Explicit selections may replace the schedule, and late refills may correct it.
    c.epgArray = [{ name: "Corrected", time: 999100, time_to: 999300 }];
    c.playArchive(999150);
    const corrected = c.epgArray;
    assert.notEqual(corrected, schedule);
    assert.equal(mappings, 1);
    assert.equal(mappedRows, 1);
    assert.equal(c.curProg, 0);
    assert.equal(c.elements.programm_name.textContent, "Corrected");
    assert.equal(c.elements.progress.style.width, "25%");
    c.updateArchiveInfo(999151);
    assert.equal(c.epgArray, corrected);
    assert.equal(c.requests.length, 1);
    c.__ottClassicPlayback.command({ position: 1, type: "position" });
    c.reply(0, [
        { name: "Refilled", time: 999100, time_to: 999400 },
        { name: "Refilled next", time: 999400, time_to: 1000000 },
    ]);
    const refilled = c.epgArray;
    assert.notEqual(refilled, corrected);
    assert.equal(mappings, 2, "A changed schedule is encoded once");
    assert.equal(mappedRows, 3);
    assert.equal(c.elements.programm_name.textContent, "Refilled");
    assert.equal(c.elements.nprogramm_name.textContent, "Refilled next");
    assert.equal(c.elements.progress.style.width, "17%");
    c.updateArchiveInfo(999152);
    assert.equal(c.epgArray, refilled);
    assert.equal(mappings, 2);
    assert.equal(
        c.opens().length,
        2,
        "Refilling the guide does not reopen media"
    );
}

// Real entrypoints use resource bounds, never the renderer's mutable programme index.
{
    const c = fixture();
    c.fileArchive = true;
    c.playArchive(999050);
    assert.deepEqual(c.opens(), [["open", "archive:101:999050", 50]]);
    assert.equal(c.elements.programm_name.textContent, "One");
    c.curProg = 999;
    c.playArchive(999060);
    assert.equal(c.opens().length, 1);
    assert.deepEqual(
        c.effects.filter((e) => e[0] === "seek"),
        [["seek", 60]]
    );
    c.curProg = 0;
    c.playArchive(999120);
    assert.equal(
        c.opens().length,
        2,
        "Different programme reopens even if classic index was reused"
    );
    assert.equal(c.opens()[1][2], 20);
    c.primaryIndex = 1;
    c.curList = c.cats.All;
    c.playArchive(999130);
    assert.equal(
        c.opens().length,
        3,
        "Different channel cannot reuse the previous resource"
    );
    c.p_pref = "source-b";
    c.playArchive(999140);
    assert.equal(
        c.opens().length,
        4,
        "Same IDs in another source cannot reuse the resource"
    );
}

// Archive history labels follow the selected programme, not the outgoing live projection.
{
    const c = fixture();
    c._prog100 = { name: "Outgoing live" };
    c.epgArray = [
        { name: "Older", time: 999000, time_to: 999100 },
        { name: "Current", time: 999100, time_to: 1001000 },
    ];
    c.playArchive(999150);
    assert.equal(c.__ottClassicPlayback.snapshot().target.payload.e, "Current");
    c.playArchive(999050);
    assert.equal(c.__ottClassicPlayback.snapshot().target.payload.e, "Older");
    c.setCurrent(0, 1);
    assert.equal(c.prevArr[0].e, "Older");
}

// Stream-style catchup reopens; unknown guide windows stay positive and synthetic files never alias index -1.
{
    const c = fixture();
    c.epgArray = [];
    c.fileArchive = true;
    c.playArchive(999050);
    c.playArchive(999060);
    assert.equal(c.opens().length, 2);
    assert(
        c.effects.filter((e) => e[0] === "resolve").every((e) => e[3] > e[2])
    );
    assert.equal(c.elements.progress.style.width, "80%");
    const before = c.opens().length;
    c.playArchive(0);
    c.playArchive(NaN);
    c.playArchive(Infinity);
    assert.equal(c.opens().length, before);
}
{
    const c = fixture();
    c.playArchive(999050);
    c.playArchive(999060);
    assert.equal(c.opens().length, 2);
    assert(c.opens().every((e) => e[2] === 0));
}

// Live rewind, programme start and live pause share a scoped guide request.
{
    const c = fixture();
    c.timeShift(30);
    assert.equal(c.opens().length, 0);
    c.reply(0, [{ name: "Current", time: 999000, time_to: 1001000 }]);
    c.reply(0, []);
    assert.deepEqual(c.opens(), [["open", "archive:101:999970", 0]]);
    assert.equal(c.__ottClassicPlayback.snapshot().target.archiveStart, 999970);
    assert.equal(c.prevArr[0].ci, 101);
}
{
    const c = fixture();
    c.timeShift(0);
    c.reply(0, []);
    assert.equal(
        c.opens().length,
        0,
        "Begin without a current programme is a safe no-op"
    );
    c.timeShift(0);
    c.reply(1, [{ name: "Current", time: 999100, time_to: 1000100 }]);
    assert.equal(c.opens()[0][1], "archive:101:999100");
}
{
    const c = fixture();
    c.liveStop();
    c.reply(0, []);
    assert.equal(c.__ottClassicPlayback.snapshot().phase, "paused");
    assert.equal(
        c.__ottClassicPlayback.snapshot().target.archiveStart,
        1000000
    );
    assert.equal(c.effects.filter((e) => e[0] === "pause").length, 1);
    assert.equal(c.opens().length, 0);
}
for (const change of [
    (c) => c.__ottClassicPlayback.cancel(),
    (c) => c.__ottClassicPlayback.command({ type: "stop" }),
    (c) => {
        c.p_pref = "replacement";
    },
    (c) => {
        c.primaryIndex = 1;
    },
    (c) => {
        c.channels = { ...c.channels };
    },
    (c) => {
        c.cats.All = [101, 202];
    },
]) {
    for (const action of ["timeShift", "liveStop"]) {
        const c = fixture();
        c[action](30);
        change(c);
        c.reply(0, c.epgArray);
        assert.equal(c.opens().length, 0);
        assert.equal(
            c.effects.filter((e) => e[0] === "pause" || e[0] === "guide")
                .length,
            0
        );
    }
}

// PIN completion and a permission expiring while the guide loads cannot admit abandoned work.
{
    const c = fixture();
    c.locked = true;
    c.timeShift(30);
    assert.equal(c.requests.length, 0);
    c.__ottClassicPlayback.cancel();
    c.locked = false;
    c.prompts[0]();
    assert.equal(c.requests.length, 0);
}
{
    const c = fixture();
    c.timeShift(30);
    c.locked = true;
    c.reply(0, c.epgArray);
    assert.equal(c.opens().length, 0);
    assert.equal(c.prompts.length, 1);
    c.primaryIndex = 1;
    c.locked = false;
    c.prompts[0]();
    assert.equal(c.opens().length, 0);
}

// Refill belongs to the displayed session; no renderer fetches or old callbacks can publish.
for (const change of [
    (c) => c.__ottClassicPlayback.cancel(),
    (c) => c.__ottClassicPlayback.command({ channelId: 101, type: "live" }),
    (c) => {
        c.p_pref = "replacement";
    },
]) {
    const c = fixture();
    c.playArchive(999050);
    c.updateArchiveInfo(999120);
    assert.equal(c.requests.length, 1);
    change(c);
    const before = c.effects.filter((e) => e[0] === "guide").length;
    c.reply(0, [{ name: "Stale", time: 999100, time_to: 1000200 }]);
    assert.equal(c.effects.filter((e) => e[0] === "guide").length, before);
    assert.notEqual(c.elements.programm_name.textContent, "Stale");
}
{
    const c = fixture();
    c.playArchive(999050);
    c.updateArchiveInfo(999120);
    c.__ottClassicPlayback.command({ position: 70, type: "position" });
    c.reply(0, [
        { name: "Fresh", time: 999100, time_to: 1000200 },
        { name: "Next", time: 1000200, time_to: 1001000 },
    ]);
    assert.equal(c.elements.programm_name.textContent, "Fresh");
    assert.equal(
        c.elements.nprogramm_name.textContent,
        "Next",
        "Final next entry is no longer hidden by a length-1 condition"
    );
    assert.equal(c.opens().length, 1, "Guide refresh never reloads a stream");
}
{
    const c = fixture();
    c.sStopPlay = 1;
    c.playArchive(999050);
    assert.equal(
        c.opens().length,
        1,
        "Coordinator-owned backend replacement is not external cancellation"
    );
    assert.equal(c.__ottClassicPlayback.snapshot().target.kind, "archive");
}
// First display of a missing/terminal programme refreshes independently of renderer changes.
for (const empty of [false, true]) {
    const c = fixture();
    if (empty) c.epgArray = [];
    c.playArchive(999120);
    assert.equal(
        c.requests.length,
        0,
        "Opening is not blocked by an optional guide refresh"
    );
    c.updateArchiveInfo(999120);
    c.updateArchiveInfo(999121);
    assert.equal(
        c.requests.length,
        1,
        "One missing-window request is enough while pending"
    );
    c.reply(0, []);
    c.updateArchiveInfo(999122);
    assert.equal(c.requests.length, 1);
    c.Date = class extends Date {
        static now() {
            return 1000060000;
        }
    };
    c.updateArchiveInfo(999180);
    assert.equal(
        c.requests.length,
        2,
        "Empty schedules can recover after the bounded retry delay"
    );
}

// Explicit programme selection imports a new schedule revision without relying on its old index.
{
    const c = fixture();
    c.fileArchive = true;
    c.playArchive(999050);
    c.epgArray = [
        {
            id: "different-resource",
            name: "Updated",
            time: 999100,
            time_to: 999900,
        },
    ];
    c.curProg = 0;
    c.playArchive(999120);
    assert.equal(c.opens().length, 2);
    assert.equal(c.effects.filter((e) => e[0] === "resolve").at(-1)[3], 999900);
    assert.equal(c.elements.programm_name.textContent, "Updated");
}
// Retention and permission are checked against the final clock/capabilities, not request time.
for (const change of [
    (c) => {
        c.Date = class extends Date {
            static now() {
                return 1000002000;
            }
        };
    },
    (c) => {
        c.channels[101].rec = 0;
    },
]) {
    const c = fixture();
    c.locked = true;
    c.playArchive(913601);
    change(c);
    c.locked = false;
    c.prompts[0]();
    assert.equal(c.opens().length, 0);
    assert.equal(c.effects.filter((e) => e[0] === "resolve").length, 0);
}
// The independent controller admits one owned resolver completion and needs no classic globals.
{
    const c = fixture(),
        events = [];
    const context = {
        channelId: "x",
        file: false,
        isCurrent: () => true,
        retention: 1000,
        schedule: [],
        sourceId: "s",
    };
    let reply;
    const controller = c.__ottArchiveSession.create(c.OttPlayCore, {
        authorize: () => false,
        capture: () => context,
        epoch: () => 100,
        guide: (_c, done) => done([]),
        now: () => 200,
        open: (_c, _v, url) => {
            events.push(url);
            return context;
        },
        pause: () => context,
        publish: () => {},
        resolve: (_c, _v, done) => {
            reply = done;
        },
        seek: () => context,
    });
    controller.open(100);
    const old = reply;
    controller.cancel();
    old("abandoned");
    assert.deepEqual(events, []);
    controller.open(101);
    reply("current");
    reply("duplicate");
    assert.deepEqual(events, ["current"]);
    const pure = fs.readFileSync(
        path.join(root, "src/playback/archive.ts"),
        "utf8"
    );
    assert(
        !/\b(document|curProg|epgArray|playType|playTime|stbPlay|setCurrent)\b/.test(
            pure
        )
    );
}
// A corrected programme can retain its ID but map to a different file origin.
{
    const c = fixture(),
        effects = [];
    const context = {
        channelId: "x",
        file: true,
        isCurrent: () => true,
        retention: 1000,
        schedule: [{ end: 150, key: "same-id", payload: {}, start: 90 }],
        sourceId: "s",
    };
    const controller = c.__ottArchiveSession.create(c.OttPlayCore, {
        authorize: () => false,
        capture: () => context,
        epoch: () => 100,
        guide: (_c, done) => done([]),
        now: () => 200,
        open: (_c, model) => {
            effects.push(["open", model.window.start]);
            return context;
        },
        pause: () => context,
        publish: () => {},
        resolve: (_c, _v, done) => done("file"),
        seek: (_c, _v, offset) => {
            effects.push(["seek", offset]);
            return context;
        },
    });
    controller.open(100);
    context.schedule = [{ end: 155, key: "same-id", payload: {}, start: 95 }];
    controller.open(110);
    assert.deepEqual(effects, [
        ["open", 90],
        ["open", 95],
    ]);
}
console.log(
    "PASS archive coordinator: real entrypoints, file identity, scoped guide/PIN/refill, synthetic windows and independent rendering"
);
