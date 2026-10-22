const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const acorn = require("acorn");
const { JSDOM } = require("jsdom");
const { keyboardCode } = require("./helpers/localized-keyboard.cjs");
const { localizationRuntime } = require("./helpers/localization-runtime.cjs");
const root = path.resolve(__dirname, "..");
function functions(file, names) {
    const source = ts.createSourceFile(
        file,
        fs.readFileSync(path.join(root, file), "utf8"),
        ts.ScriptTarget.Latest,
        true
    );
    return ts
        .transpileModule(
            source.statements
                .filter(
                    (n) =>
                        ts.isFunctionDeclaration(n) &&
                        names.includes(n.name?.text)
                )
                .map((n) => n.getText(source))
                .join("\n"),
            {
                compilerOptions: {
                    module: ts.ModuleKind.ES2015,
                    target: ts.ScriptTarget.ES5,
                },
            }
        )
        .outputText.replace(/^export /gm, "");
}
function fixture() {
    const dom = new JSDOM(
        '<div id="dialogbox" style="display:none"></div><div id="listEdit" style="display:none"></div><div id="listAbout" style="display:none"></div><div id="listCaption">Parent</div><div id="listPodval">Footer</div><div id="listDetail">Detail</div><div id="numprog"></div><div id="list_window"></div><div id="list_osd"></div>',
        { runScripts: "outside-only" }
    );
    const w = dom.window,
        jobs = [],
        events = [];
    w.eval(fs.readFileSync(path.join(root, "js/jquery-1.11.1.min.js"), "utf8"));
    const originalIs = w.$.fn.is;
    w.$.fn.is = function (q) {
        return q === ":visible"
            ? !!this[0] && this[0].style.display !== "none"
            : originalIs.call(this, q);
    };
    Object.assign(w, {
        _: (x) => x,
        changeSelect: (delta) => events.push(["move", delta]),
        changeVolume: (value) => events.push(["volume", value]),
        channelNumberElement: w.document.getElementById("numprog"),
        clearTimeout(id) {
            if (jobs[id - 1]) jobs[id - 1].active = false;
        },
        closeList() {
            events.push(["close"]);
            w.__ottClassicScreenPort.closeList();
        },
        curColor: "#fff",
        curColorB: "#000",
        detailScrollTimer: null,
        detailTimer: null,
        keys: {
            BLUE: 406,
            CH_DOWN: 189,
            CH_UP: 187,
            DOWN: 40,
            ENTER: 13,
            EXIT: 27,
            FF: 34,
            GREEN: 404,
            LEFT: 37,
            MUTE: 173,
            N0: 48,
            N1: 49,
            N2: 50,
            N3: 51,
            N4: 52,
            N5: 53,
            N6: 54,
            N7: 55,
            N8: 56,
            N9: 57,
            NEXT: 35,
            PAUSE: 19,
            PLAY: 80,
            PLAYPAUSE: 10252,
            POWER: 81,
            PREV: 36,
            RED: 403,
            RETURN: 8,
            RIGHT: 39,
            RW: 33,
            TOOLS: 84,
            UP: 38,
            VOL_DOWN: 174,
            VOL_UP: 175,
            YELLOW: 405,
        },
        listCaptionElement: w.document.getElementById("listCaption"),
        listDetailElement: w.document.getElementById("listDetail"),
        listElement: w.document.getElementById("list_window"),
        listFooterElement: w.document.getElementById("listPodval"),
        nativeListInertia: null,
        setTimeout(callback, delay) {
            jobs.push({ active: true, callback, delay });
            return jobs.length;
        },
        showPage() {
            w.__ottClassicScreenPort.commitList();
            w.listElement.style.display = "";
        },
        showShift: (value) => events.push(["shift", value]),
        stbEventToKeyCode: (event) => event.keyCode || event.which,
        stbSetWindow() {},
        strDOWN: "Down",
        strENTER: "OK",
        strEXIT: "Esc",
        strLEFT: "Left",
        strRETURN: "Back",
        strRIGHT: "Right",
        strUP: "Up",
        sVolumeStep: 7,
    });
    require("./helpers/screen-runtime.cjs")(w);
    w.eval(
        functions("src/utils/helpers.ts", [
            "metadataText",
            "metadataHtml",
            "metadataImageUrl",
            "metadataCssUrl",
        ])
    );
    w.eval(localizationRuntime());
    w.eval(
        functions("src/ui/index.ts", [
            "_changeEdit",
            "infoBox",
            "confirmBox",
            "localizedTextHtml",
            "showSelectBox",
            "showShift",
            "selectValue",
            "clickVal",
            "saveListPanelState",
            "restoreListPanelState",
            "showEditKey2",
            "editKey2",
            "renderButtonHint",
            "scheduleListDetailUpdate",
            "scrollUp",
            "popupList",
            "hsvToRgb",
            "bindColorDialogInput",
            "showColorDialog",
            "colorDialog",
            "selColorDialog",
            "backColorDialog",
        ])
    );
    w.eval(
        functions("src/key-handler/index.ts", [
            "cancelNativeListInertia",
            "keyHandler",
            "dispatchKey",
        ])
    );
    w.editKey = w.editKey2;
    return {
        close: () => dom.window.close(),
        context: dom.getInternalVMContext(),
        events,
        jobs,
        key: (code) =>
            w.keyHandler({
                keyCode: code,
                preventDefault() {},
                stopPropagation() {},
            }),
        w,
    };
}
let passed = 0;
function test(name, fn) {
    const f = fixture();
    try {
        fn(f);
        passed++;
        console.log("PASS screen: " + name);
    } finally {
        f.close();
    }
}
for (const name of [
    "screen-controller",
    "input-router",
    "classic-screen-port",
    "menu-registry",
]) {
    const text = fs.readFileSync(
        path.join(root, "src/ui/" + name + ".ts"),
        "utf8"
    );
    acorn.parse(
        ts.transpileModule(text, {
            compilerOptions: { target: ts.ScriptTarget.ES5 },
        }).outputText,
        { ecmaVersion: 5 }
    );
}
test("webOS Plex arrows seek only behind no list or dialog and preserve volume keys", ({
    w,
    key,
    events,
}) => {
    w.version = "test";
    w.eval(functions("src/core/index.ts", ["stbEventToKeyCode"]));
    w.eval(
        fs.readFileSync(path.join(root, "devices/lg/webos/device.js"), "utf8")
    );
    w.eval(functions("src/key-handler/index.ts", ["handleMainKey", "keyFun"]));
    const seeks = [];
    w.playType = -1e11;
    w.settings = { alFun: 14, arFun: 13, volumeStep: 5 };
    w.__ottMedia = { current: () => ({ ref: { sourceId: "plex@remote" } }) };
    w.shiftArchive = (seconds) => seeks.push(seconds);
    key(37);
    key(39);
    for (const arrow of ["ArrowLeft", "ArrowRight"])
        w.keyHandler({ key: arrow, preventDefault() {}, stopPropagation() {} });
    assert.deepEqual(seeks.splice(0), [-10, 10, -10, 10]);
    assert.deepEqual(events, []);

    w.listArray = ["One", "Two"];
    w.listKeyHandler = () => false;
    w.showPage();
    key(39);
    assert.deepEqual(events.splice(0), [["move", 25]]);
    assert.deepEqual(seeks, []);
    const dialogKeys = [];
    w.$("#dialogbox").show();
    w.dialogBoxKeyHandler = (code) => dialogKeys.push(code);
    key(37);
    assert.deepEqual(dialogKeys, [37]);
    assert.deepEqual(seeks, []);
    w.$("#dialogbox").hide();
    w.dialogBoxKeyHandler = null;
    w.closeList();
    events.length = 0;
    w.sVolumeStep = 5;
    key(447);
    key(448);
    assert.deepEqual(events, [
        ["volume", 5],
        ["volume", -5],
    ]);
    assert.deepEqual(seeks, []);
});
test("Local videos arrows change files after finite classification and respect screen ownership", ({
    w,
    key,
}) => {
    w.eval(
        functions("src/key-handler/index.ts", [
            "handleMainKey",
            "keyFun",
            "plusProg",
            "minusProg",
        ])
    );
    w.settings = { adFun: 16, auFun: 15 };
    w.__ottActiveProviderDriver = { id: "offline" };
    w.curList = ["first", "second", "third"];
    w.catIndex = 2;
    const selected = [],
        seeks = [];
    w.playChannel = (category, index) => {
        selected.push([category, index]);
        w.primaryIndex = index;
    };
    w.shiftArchiveSelect = (seconds) => seeks.push(seconds);
    for (const mode of [0, -99999999999, -1e11]) {
        w.playType = mode;
        w.primaryIndex = 0;
        key(w.keys.UP);
        key(w.keys.DOWN);
        key(w.keys.DOWN);
        key(w.keys.UP);
        assert.deepEqual(
            selected.splice(0),
            [
                [2, 1],
                [2, 0],
                [2, 2],
                [2, 0],
            ],
            "default directions and wrapping stay the same for mode " + mode
        );
        assert.deepEqual(seeks, [], "finite local files never open Seek");
    }
    for (const kind of ["dialog", "list", "editor", "about"]) {
        const owned = [];
        const callback = (code) => {
            owned.push(code);
            return true;
        };
        let owner;
        if (kind === "list") {
            w.listKeyHandler = callback;
            w.showPage();
            owner = w.__ottClassicScreenPort.owner("list");
        } else {
            owner = w.__ottClassicScreenPort.setOwnedCallback(
                kind,
                callback
            ).owner;
            w.$(
                {
                    about: "#listAbout",
                    dialog: "#dialogbox",
                    editor: "#listEdit",
                }[kind]
            ).show();
        }
        key(w.keys.UP);
        key(w.keys.DOWN);
        assert.deepEqual(
            owned,
            [w.keys.UP, w.keys.DOWN],
            kind + " keeps its arrows"
        );
        assert.deepEqual(selected, []);
        owner.close();
        if (kind === "list") w.closeList();
    }
    w.settings.auFun = 16;
    w.settings.adFun = 15;
    w.primaryIndex = 1;
    key(w.keys.UP);
    key(w.keys.DOWN);
    assert.deepEqual(
        selected.splice(0),
        [
            [2, 0],
            [2, 1],
        ],
        "custom direction bindings are retained"
    );
    w.__ottActiveProviderDriver = { id: "m3u" };
    for (const mode of [12345, -1e11]) {
        w.playType = mode;
        key(w.keys.UP);
        key(w.keys.DOWN);
        assert.deepEqual(
            seeks.splice(0),
            [0, 60],
            "nonlocal archives/VOD keep Seek"
        );
        assert.deepEqual(selected, []);
    }
    w.playType = 0;
    key(w.keys.UP);
    key(w.keys.DOWN);
    assert.deepEqual(
        selected,
        [
            [2, 0],
            [2, 1],
        ],
        "ordinary live channels keep navigation"
    );
});
test("screen invalidation detaches every old owner before reentrant cleanup", ({
    w,
}) => {
    const c = w.__ottScreenController.create(),
        calls = [];
    const first = c.open({ handle: () => calls.push("old"), kind: "list" });
    const last = c.open({ handle: () => {}, kind: "dialog", priority: 50 });
    const stale = first.guard(() => calls.push("stale"));
    last.own(() => {
        stale();
        c.open({ handle: () => calls.push("new"), kind: "list" });
    });
    c.invalidate();
    c.dispatch({ id: "accept" });
    assert.deepEqual(calls, ["new"]);
    assert.equal(first.active(), false);
});
function layoutFixture(w) {
    const frames = [];
    const listIn = w.document.createElement("div");
    listIn.id = "listIn";
    w.listElement.appendChild(listIn);
    Object.defineProperty(listIn, "clientHeight", {
        configurable: true,
        value: 100,
    });
    listIn.getBoundingClientRect = () => ({ bottom: -2, top: 0 });
    let layouts = 0;
    Object.assign(w, {
        __ottClassicGuide: { cancelConsumers() {} },
        $infoBar: w.$("#numprog"),
        getListItemFn: (row) => row,
        getViewportWidthScale: () => 1,
        listArray: ["One"],
        listInElement: listIn,
        listKeyHandler: () => false,
        listRowHeight: () => 20,
        packListRowBoxes() {
            layouts++;
            return 20;
        },
        requestAnimationFrame(callback) {
            frames.push(callback);
        },
        selIndex: 0,
        settings: { noSmall: 1, pageSize: 25, showScroll: 0 },
    });
    w.listDataArray = w.listArray;
    w.eval(functions("src/ui/index.ts", ["showPage"]));
    return { frames, layouts: () => layouts, listIn };
}
// Real list formatter, DOM styling and guide subscriptions, with only layout,
// provider completion and time controlled by the fixture.
function channelPageFixture(f, pageSize, options = {}) {
    const { w, jobs, context } = f;
    const { listIn } = layoutFixture(w);
    listIn.getBoundingClientRect = () => ({ bottom: 600, top: 0 });
    Object.defineProperty(listIn, "clientHeight", { value: 600 });
    Object.defineProperty(listIn, "clientWidth", { value: 720 });
    w.document.body.insertAdjacentHTML(
        "beforeend",
        '<div id="testFont"></div><div id="listPopUp"></div>'
    );
    let now = 1000000;
    const requests = [],
        counts = { details: 0, preview: 0, rows: 0, scroll: 0 };
    w.Date.now = () => now;
    w.setTimeout = (callback, delay) => {
        jobs.push({ active: true, at: now + delay, callback, delay });
        return jobs.length;
    };
    const ids = Array.from(
        { length: pageSize * 2 + 1 },
        (_, i) => "channel" + i
    );
    Object.assign(w, {
        catIndex: 0,
        cats: { All: ids },
        catsArray: ["All"],
        channels: Object.fromEntries(
            ids.map((id) => [id, { channel_name: id, rec: 24 }])
        ),
        channelsKeyHandler: () => false,
        cList: ids,
        curList: ids,
        epg: {},
        epgCacheCapacity: 1000,
        fetchChannelGuide(id, complete) {
            requests.push({ complete, id });
            return () => {};
        },
        getChannelPicon: () => "https://images.invalid/channel.png",
        getViewportHeightScale: () => 1,
        listDetail: w.listDetailElement,
        listFooter: w.listFooterElement,
        p_pref: "fixture",
        parentalArray: [],
        parentPIN: "*",
        playType: 0,
        previewChId() {
            counts.preview++;
        },
        primaryIndex: 0,
        sArrowFun: 0,
        scrollUp() {
            counts.scroll++;
        },
        setPopupChannels() {},
        sNextCount: 2,
        sPNFun: 0,
        sPSchannels: 0,
        sRewFun: 0,
        sThumbnail: 1,
        strEPG: "EPG",
        strInfo: "Info",
        strPlayPause: "Play",
        strTools: "Settings",
        time2time: String,
    });
    Object.assign(w.settings, {
        channelLogoMode: 1,
        interfaceTheme: 0,
        nextCountList: 2,
        pageSize,
        preview: options.preview ?? 1,
        showArchive: 1,
        showDescription: options.description ?? 1,
        showName: 1,
        showNumber: 1,
        showProgram: options.program ?? 1,
        showProgress: options.progress ?? 1,
        showScroll: options.scroll ?? 1,
    });
    w.eval(fs.readFileSync(path.join(root, "vendor/ottplay-core.js"), "utf8"));
    for (const file of ["service", "classic-service"])
        require("./helpers/private-runtime.cjs")(
            context,
            "src/guide/" + file + ".ts"
        );
    w.eval(functions("src/channels/index.ts", ["observeCurrentProgramme"]));
    w.eval(
        functions("src/provider/index.ts", [
            "_channelsList",
            "updateChannelListRow",
            "detailProg",
        ])
    );
    w.eval(functions("src/ui/index.ts", ["changeSelect"]));
    const update = w.updateChannelListRow;
    w.updateChannelListRow = (id) => {
        counts.rows++;
        update(id);
    };
    const html = Object.getOwnPropertyDescriptor(
        w.Element.prototype,
        "innerHTML"
    );
    Object.defineProperty(w.listDetailElement, "innerHTML", {
        get() {
            return html.get.call(this);
        },
        set(value) {
            if (value) counts.details++;
            html.set.call(this, value);
        },
    });
    function programmes(id, expired = false) {
        const base = Math.floor(w.Date.now() / 1000);
        return [
            {
                descr: "Description",
                name: "Programme " + id,
                time: base - 100,
                time_to: base + (expired ? -50 : 500),
            },
            {
                descr: "Next description",
                name: "Next " + id,
                time: base + (expired ? -40 : 500),
                time_to: base + (expired ? -10 : 1100),
            },
        ];
    }
    function seed(expired = false) {
        ids.forEach((id) =>
            w.__ottClassicGuide.seed(id, programmes(id, expired))
        );
    }
    function advance(ms) {
        const until = now + ms;
        let calls = 0;
        for (;;) {
            const job = jobs
                .filter((entry) => entry.active && entry.at <= until)
                .sort((a, b) => a.at - b.at)[0];
            if (!job) break;
            assert(++calls < 200, "render timers converge");
            now = job.at;
            job.active = false;
            job.callback();
        }
        now = until;
    }
    function resetCounts() {
        Object.keys(counts).forEach((key) => {
            counts[key] = 0;
        });
    }
    return {
        advance,
        counts,
        ids,
        listIn,
        programmes,
        requests,
        resetCounts,
        seed,
    };
}
for (const pageSize of [25, 10, 30]) {
    test(
        "warm channel page renders details once at configured " +
            pageSize +
            " rows",
        (f) => {
            const { w } = f;
            const page = channelPageFixture(f, pageSize);
            page.seed();
            const settings = JSON.stringify(w.settings);
            function checkPage(first) {
                assert.equal(
                    page.listIn.querySelectorAll(".item").length,
                    pageSize
                );
                assert.equal(
                    w.document.getElementById("pn" + page.ids[first])
                        .textContent,
                    "Programme " + page.ids[first]
                );
                assert.equal(
                    w.document.getElementById("pr" + page.ids[first]).style
                        .width,
                    ((w.Date.now() / 1000 - 900) / 600) * 100 + "%"
                );
                assert.ok(page.listIn.querySelector(".list-scroll"));
                page.advance(200);
                assert.deepEqual(
                    page.counts,
                    { details: 1, preview: 1, rows: 0, scroll: 1 },
                    "warm page must not paint and immediately discard its detail or rewrite formatted rows"
                );
                assert.equal(
                    page.requests.length,
                    0,
                    "warm rendering never refetches"
                );
                assert.equal(JSON.stringify(w.settings), settings);
            }
            w._channelsList(0, 0);
            checkPage(0);
            page.resetCounts();
            w.changeSelect(pageSize);
            checkPage(pageSize);
            page.resetCounts();
            w.listArray = w.listDataArray = ["Other menu"];
            w.getListItemFn = (item) => item;
            w.detailListActionFn = () => {};
            w.selIndex = 0;
            w.showPage();
            page.advance(200);
            assert.equal(page.listIn.textContent, "Other menu");
            assert.deepEqual(page.counts, {
                details: 0,
                preview: 0,
                rows: 0,
                scroll: 0,
            });
        }
    );
    test(
        "expired channel pages preserve async fill/settings at " +
            pageSize +
            " rows",
        (f) => {
            const { w } = f;
            const page = channelPageFixture(f, pageSize, {
                description: 0,
                preview: 0,
                program: 0,
                progress: 0,
                scroll: 0,
            });
            page.seed(true);
            w._channelsList(0, 0);
            page.advance(200);
            assert.equal(
                page.listIn.querySelectorAll(".item").length,
                pageSize
            );
            assert.equal(
                page.listIn.querySelector(
                    ".ott-channel-programme, .ott-channel-progress, .list-scroll"
                ),
                null
            );
            assert.equal(w.listDetailElement.innerHTML, "");
            assert.equal(page.counts.preview, 0);
            page.advance(
                w.channels[page.ids[0]].time_request * 1000 - w.Date.now()
            );
            assert.equal(
                page.requests.length,
                1,
                "expired rows still start the serial guide queue"
            );
            page.resetCounts();
            const request = page.requests[0];
            request.complete(request.id, page.programmes(request.id));
            page.advance(0);
            assert.deepEqual(
                page.counts,
                { details: 1, preview: 0, rows: 1, scroll: 1 },
                "actual async guide callback still refreshes the selected detail"
            );
            assert.equal(
                w.document.getElementById("_descr").style.height,
                "0px"
            );
            assert.match(w.listDetailElement.textContent, /Programme channel0/);
            assert.equal(
                page.listIn.querySelector(
                    ".ott-channel-programme, .ott-channel-progress, .list-scroll"
                ),
                null
            );
        }
    );
}
for (const expired of [false, true])
    test(
        (expired ? "expired" : "cold") +
            " visible programme rows still fill asynchronously",
        (f) => {
            const { w } = f;
            const page = channelPageFixture(f, 25);
            if (expired) page.seed(true);
            w._channelsList(0, 0);
            page.advance(200);
            const id = page.ids[0];
            assert.ok(
                w.document.querySelector("#pn" + id + " .ott-channel-no-epg")
            );
            assert.equal(
                w.document.getElementById("pr" + id).style.width,
                "0%"
            );
            if (expired)
                page.advance(w.channels[id].time_request * 1000 - w.Date.now());
            assert.equal(page.requests.length, 1);
            page.resetCounts();
            const request = page.requests[0];
            request.complete(request.id, page.programmes(request.id));
            page.advance(0);
            assert.equal(
                w.document.getElementById("pn" + id).textContent,
                "Programme " + id
            );
            assert.equal(
                w.document.getElementById("pr" + id).style.width,
                ((w.Date.now() / 1000 - w.channels[id].time) / 600) * 100 + "%"
            );
            assert.deepEqual(page.counts, {
                details: 1,
                preview: 1,
                rows: 1,
                scroll: 1,
            });
        }
    );
test("retired list layout frames cannot resize or reopen the list", ({ w }) => {
    const { frames, layouts, listIn } = layoutFixture(w);
    w.showPage();
    assert.equal(
        frames.length,
        2,
        "layout and clipped-cursor retries are queued"
    );
    const owner = w.__ottClassicScreenPort.listOwner();
    w.closeList();
    assert.equal(owner.active(), false);
    const html = listIn.innerHTML;
    const pending = frames.splice(0);
    pending.forEach((callback) => callback());
    assert.equal(layouts(), 1, "retired rows are not measured again");
    assert.equal(w.__ottClassicScreenPort.listOwner(), null);
    assert.equal(listIn.innerHTML, html);
    assert.equal(
        frames.length,
        0,
        "a retired retry cannot schedule more frames"
    );
    assert.equal(w.__ottListCursorRetry, false);
});
for (const kind of ["cursor", "fit"])
    test(
        "replacement list owns its " +
            kind +
            " retry before the retired frame runs",
        ({ w }) => {
            const { frames, layouts, listIn } = layoutFixture(w);
            const slot =
                kind === "cursor"
                    ? "__ottListCursorRetry"
                    : "__ottListFitRetry";
            if (kind === "fit") {
                Object.defineProperty(listIn, "clientHeight", { value: 0 });
                listIn.getBoundingClientRect = () => ({ bottom: 100, top: 0 });
            }
            w.showPage();
            const oldOwner = w.__ottClassicScreenPort.listOwner();
            const oldRetry = w[slot];
            w.listArray = ["Replacement"];
            w.listDataArray = w.listArray;
            w.showPage();
            const replacement = w.__ottClassicScreenPort.listOwner();
            const replacementRetry = w[slot];
            assert.equal(oldOwner.active(), false);
            assert.equal(replacement.active(), true);
            assert.equal(
                frames.length,
                4,
                "replacement queues its own layout retry"
            );
            assert.notEqual(replacementRetry, oldRetry);
            w.showPage();
            assert.equal(
                frames.length,
                5,
                "same owner coalesces a pending layout retry"
            );
            assert.equal(w[slot], replacementRetry);
            const pending = frames.splice(0);
            pending[0]();
            pending[1]();
            assert.equal(
                layouts(),
                3,
                "retired layout cannot touch replacement rows"
            );
            assert.equal(
                w[slot],
                replacementRetry,
                "retired retry cannot clear replacement state"
            );
            assert.equal(frames.length, 0);
            Object.defineProperty(listIn, "clientHeight", { value: 100 });
            listIn.getBoundingClientRect = () => ({ bottom: 100, top: 0 });
            pending.slice(2).forEach((callback) => callback());
            assert.equal(w.__ottClassicScreenPort.listOwner(), replacement);
            assert.equal(w[slot], false);
            assert.equal(
                frames.length,
                1,
                "replacement rerenders exactly once, then only queues layout"
            );
            assert.equal(layouts(), 6);
        }
    );
test("list callbacks, focus and cleanup have one authoritative owner", ({
    w,
    key,
    events,
}) => {
    let disposed = 0;
    w.listArray = ["a", "b"];
    w.listDataArray = w.listArray;
    w.listKeyHandler = () => false;
    const owner = w.__ottClassicScreenPort.commitList();
    owner.own(() => disposed++);
    assert.equal(w.__ottClassicScreenPort.commitList(), owner);
    w.selIndex = 1;
    assert.equal(owner.model.focus, 1);
    key(40);
    key(175);
    assert.deepEqual(events, [
        ["move", 1],
        ["volume", 7],
    ]);
    w.listKeyHandlerFn = () => true;
    w.__ottClassicScreenPort.commitList();
    assert.equal(disposed, 1);
    assert.equal(owner.active(), false);
});
test("list handler opening replacement cannot move replacement focus on fallthrough", ({
    w,
    key,
    events,
}) => {
    w.listKeyHandler = () => {
        w.listKeyHandler = () => false;
        w.__ottClassicScreenPort.commitList();
        return false;
    };
    w.__ottClassicScreenPort.commitList();
    key(40);
    assert.deepEqual(events, []);
});
test("physical editor deletion and insertion preserve grapheme boundaries", ({
    w,
}) => {
    w.eval(keyboardCode());
    w._setCase(false);
    w.editKey = w.editKey1;
    w.$("#listEdit").show();
    const port = w.__ottClassicScreenPort;
    port.openEditor();
    function key(value, code) {
        port.dispatch(code, { key: value }, () =>
            assert.fail("editor owns input")
        );
    }
    for (const value of [
        "📺",
        "e\u0301",
        "👨‍👩‍👧‍👦",
        "🇮🇳",
        "\u0301\u0308",
        "\r\n",
    ]) {
        w.editvar = "\n" + value + "z";
        w.editPos = 1 + value.length;
        key("Backspace", 8);
        assert.equal(
            w.editvar,
            "\nz",
            "physical Backspace removes one grapheme"
        );
        assert.equal(w.editPos, 1);
        w.editvar = "\n" + value + "z";
        w.editPos = 1;
        key("Delete", 46);
        assert.equal(w.editvar, "\nz", "physical Delete removes one grapheme");
        assert.equal(w.editPos, 1);
    }
    for (const [physical, position] of [
        ["Backspace", 3],
        ["Delete", 2],
    ]) {
        w.editvar = "🇦x🇧🇨";
        w.editPos = position;
        key(physical, physical === "Delete" ? 46 : 8);
        assert.equal(w.editvar, "🇦🇧🇨");
        assert.equal(
            w.editPos,
            4,
            "joined regional indicators realign the caret"
        );
    }
    w.editvar = "\u0301";
    w.editPos = 0;
    key("a", 65);
    assert.equal(w.editvar, "a\u0301");
    assert.equal(w.editPos, 2, "physical insertion joins the following mark");
    key("Backspace", 8);
    assert.equal(w.editvar, "");
    for (const [position, snapped] of [
        [-4, 0],
        [NaN, 0],
        [0.5, 2],
        [1, 2],
        [99, 3],
    ]) {
        w.editvar = "📺z";
        w.editPos = position;
        key("a", 65);
        assert.equal(
            w.editvar,
            "📺z".slice(0, snapped) + "a" + "📺z".slice(snapped)
        );
        assert.equal(w.editPos, snapped + 1);
    }
    for (const character of ["𐐀", "𐒰", "📺"]) {
        w.editvar = "az";
        w.editPos = 1;
        key(character, 65);
        assert.equal(
            w.editvar,
            "a" + character + "z",
            "physical supplementary scalar inserts intact"
        );
        assert.equal(w.editPos, 3);
        key("Backspace", 8);
        assert.equal(w.editvar, "az");
    }
    for (const name of [
        "Dead",
        "Delete",
        "Backspace",
        "ArrowLeft",
        "Enter",
        "ab",
        "\ud800x",
        "x\udc00",
        "\udc00\ud800",
    ]) {
        assert.equal(
            port.normalize(0, { key: name }).text,
            undefined,
            "named key or malformed pair is not text"
        );
    }
    w.editvar = "📺";
    w.editPos = 1;
    key("Backspace", 8);
    assert.equal(
        w.editvar,
        "",
        "interior cursor never leaves half a surrogate"
    );
    w.editvar = "📺";
    w.editPos = 2;
    key("Delete", 46);
    assert.equal(w.editvar, "📺", "Delete at end is inert, not a period");
    w.editPos = 0;
    key("Backspace", 8);
    assert.equal(w.editvar, "📺", "Backspace at start is inert");
});
test("native input Backspace and Delete remain browser-owned", ({ w }) => {
    w.editvar = "📺";
    w.showEditKey2();
    const input = w.document.getElementById("editvar");
    let prevented = false;
    for (const [key, code] of [
        ["Backspace", 8],
        ["Delete", 46],
    ]) {
        w.keyHandler({
            key,
            keyCode: code,
            preventDefault() {
                prevented = true;
            },
            stopPropagation() {},
            target: input,
        });
    }
    assert.equal(prevented, false, "native editor handles its own deletion");
    assert.equal(input.value, "📺");
    assert.equal(w.editvar, "📺");
});
test("nested dialog/editor suspend list and dialog closes once", ({
    w,
    key,
}) => {
    w.listKeyHandler = () => false;
    const list = w.__ottClassicScreenPort.commitList();
    let saves = 0;
    w.editvar = "old";
    w.setEdit = () => saves++;
    w.showEditKey2();
    const editor = w.__ottClassicScreenPort.owner("editor");
    let yes = 0;
    w.confirmBox("Continue?", () => yes++);
    const old = w.dialogBoxKeyHandler;
    key(13);
    old(13);
    assert.equal(yes, 1);
    assert(editor.active());
    assert(list.active());
    w.document.getElementById("editvar").value = "new";
    key(13);
    assert.equal(saves, 1);
    assert.equal(w.__ottScreens.current(), list);
});
test("saved native key callback cannot save a replacement editor", ({ w }) => {
    let oldSaves = 0,
        newSaves = 0;
    w.editvar = "old";
    w.setEdit = () => oldSaves++;
    let handler;
    const events = w.EventTarget.prototype;
    const add = events.addEventListener;
    events.addEventListener = function (type, callback, options) {
        if (this.id === "editvar" && type === "keydown") handler = callback;
        return add.call(this, type, callback, options);
    };
    try {
        w.showEditKey2();
    } finally {
        events.addEventListener = add;
    }
    assert.equal(typeof handler, "function");
    w.setEdit = () => newSaves++;
    w.editvar = "new";
    w.showEditKey2();
    handler({ key: "Enter", preventDefault() {}, stopPropagation() {} });
    assert.equal(oldSaves, 0);
    assert.equal(newSaves, 0);
    assert.equal(w.document.getElementById("editvar").value, "new");
});
test("editor save reentry preserves replacement editor and callback", ({
    w,
}) => {
    let saved = 0;
    w.editvar = "first";
    w.setEdit = () => {
        saved++;
        w.setEdit = () => (saved += 10);
        w.editvar = "second";
        w.showEditKey2();
    };
    w.showEditKey2();
    w.editKey2(13);
    assert.equal(saved, 1);
    assert.equal(w.document.getElementById("editvar").value, "second");
    assert.notEqual(
        w.document.getElementById("listEdit").style.display,
        "none"
    );
    w.editKey2(13);
    assert.equal(saved, 11);
});
function configureSwopEditor(w, mode) {
    w.eval(keyboardCode());
    Object.assign(w, {
        ensureDeviceClientId: () => "test-device",
        getSwopBaseUrl: () => "/swop",
        makeQrSvg: () => "<svg></svg>",
        ott_device: mode === "native" ? "pc" : "tizen",
        POLL_MS: 2500,
        SESSION_TIMEOUT_MS: 600000,
        stbGetItem: () => "_eng",
        wire: {
            swopClientHeader: "X-Swop-Client-Id",
            swopSessionPath: "/session",
            swopValuePath: "/val",
        },
    });
    w.eval(functions("src/swop/index.ts", ["swopHeaders", "swopLoadValue"]));
    w.editKey = mode === "native" ? w.editKey2 : w.editKey1;
    // Exercise the desktop redirect as well as the TV renderer.
    w.showEditKey = w.showEditKey1;
}
test("native editor consumes its opening key until release and releases stale listeners", ({
    w,
}) => {
    const port = w.__ottClassicScreenPort;
    const event = (type, code, repeat = false) =>
        new w.KeyboardEvent(type, {
            bubbles: true,
            cancelable: true,
            keyCode: code,
            repeat,
        });
    w.aboutKeyHandler = () => w.showEditKey2();
    w.$("#listAbout").show();
    w.keyHandler(event("keydown", 51));
    const input = w.document.getElementById("editvar");
    assert.equal(
        port.keyEvent(),
        null,
        "dispatch context ends with the opening action"
    );
    assert.equal(input.readOnly, true);
    for (const type of ["keydown", "keypress"]) {
        const held = event(type, 51, true);
        input.dispatchEvent(held);
        assert.equal(
            held.defaultPrevented,
            true,
            type + " cannot insert the shortcut digit"
        );
    }
    input.dispatchEvent(event("keyup", 51));
    assert.equal(input.readOnly, false);
    assert.equal(w.document.activeElement, input);
    const typed = event("keydown", 51);
    input.dispatchEvent(typed);
    assert.equal(
        typed.defaultPrevented,
        false,
        "a fresh digit press remains normal typing"
    );
    w.editKey2(w.keys.EXIT);
    w.$("#listAbout").show();
    w.keyHandler(event("keydown", 52));
    const previous = w.document.getElementById("editvar");
    assert.equal(previous.readOnly, true);
    w.showEditKey2();
    const replacement = w.document.getElementById("editvar");
    previous.dispatchEvent(event("keyup", 52));
    assert.equal(w.document.activeElement, replacement);
    assert.equal(replacement.readOnly, false);
    const fresh = event("keydown", 52);
    replacement.dispatchEvent(fresh);
    assert.equal(
        fresh.defaultPrevented,
        false,
        "retired opening-key capture cannot swallow later input"
    );
});
test("forced native editor keeps its hidden settings parent and routes remote save", ({
    w,
    key,
}) => {
    const port = w.__ottClassicScreenPort;
    w.aboutKeyHandler = () => true;
    w.$("#listAbout").show();
    const parent = port.owner("about");
    w.editKey1 = () =>
        assert.fail("Native settings must not route to the graphical editor");
    w.editKey = w.editKey1;
    const saved = [];
    w.setEdit = () => saved.push(w.editvar);
    w.$("#listAbout").hide();
    w.showEditKey2();
    const editor = port.owner("editor");
    key(w.keys.DOWN);
    assert.equal(editor.active(), true);
    assert.equal(
        parent.active(),
        true,
        "hidden settings parent is suspended, not retired"
    );
    assert.equal(w.document.activeElement.id, "editRemoteInput");
    key(w.keys.UP);
    w.document.getElementById("editvar").value =
        "https://fixture.invalid/control";
    key(w.keys.ENTER);
    assert.deepEqual(saved, ["https://fixture.invalid/control"]);
    assert.equal(editor.active(), false);
    assert.equal(parent.active(), true);
    port.reconcile();
    assert.equal(
        parent.active(),
        false,
        "hidden foreground screens still retire normally"
    );
});
test("native editor D-pad reaches remote input, keeps cursor keys, and hands off the draft once", ({
    w,
}) => {
    configureSwopEditor(w, "native");
    let saves = 0;
    const requests = [];
    w.setEdit = () => saves++;
    w.$.ajax = (request) => requests.push(request);
    w.showEditKey2(undefined, true);
    const input = w.document.getElementById("editvar");
    const button = w.document.getElementById("editRemoteInput");
    input.value = "https://fixture.invalid:8081/path?x=&y=3";
    function press(target, key, keyCode, isComposing = false) {
        const event = new w.KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            isComposing,
            key,
            keyCode,
        });
        target.dispatchEvent(event);
        return event;
    }
    assert.equal(press(input, "ArrowLeft", 37).defaultPrevented, false);
    assert.equal(
        press(input, "ArrowDown", 40, true).defaultPrevented,
        false,
        "IME keeps candidate navigation"
    );
    assert.equal(w.document.activeElement, input);
    assert.equal(press(input, "ArrowDown", 40).defaultPrevented, true);
    assert.equal(w.document.activeElement, button);
    press(button, "ArrowUp", 38);
    assert.equal(w.document.activeElement, input);
    press(input, "ArrowUp", 38);
    assert.equal(w.document.activeElement, button);
    press(button, "Enter", 13);
    assert.equal(requests.length, 1);
    assert.equal(JSON.parse(requests[0].data).draft, input.value);
    assert.equal(saves, 0, "OK on remote input does not save the editor");
    press(button, "Enter", 13);
    assert.equal(
        requests.length,
        1,
        "detached remote button cannot start another session"
    );
});
test("CJK TV editors use native composition and preserve exact Unicode on commit", ({
    w,
    key,
}) => {
    configureSwopEditor(w, "TV");
    const samples = { _chi: "新闻𠀀", _jpn: "ニュース東京", _kor: "한글한" };
    const saves = [];
    for (const [code, value] of Object.entries(samples)) {
        w.stbGetItem = () => code;
        w.editvar = "before";
        w.setEdit = () => saves.push(w.editvar);
        w.showEditKey1();
        const owner = w.__ottClassicScreenPort.owner("editor");
        const input = w.document.getElementById("editvar");
        assert(input, code + " routes TV input to the IME-capable field");
        assert.equal(input.getAttribute("dir"), "auto");
        input.dispatchEvent(
            new w.CompositionEvent("compositionstart", { data: "" })
        );
        input.value = value;
        for (const keyName of ["Enter", "Escape", "ArrowDown"]) {
            const event = new w.KeyboardEvent("keydown", {
                bubbles: true,
                cancelable: true,
                key: keyName,
                keyCode:
                    keyName === "Enter" ? 13 : keyName === "Escape" ? 27 : 40,
            });
            input.dispatchEvent(event);
            assert.equal(
                event.defaultPrevented,
                false,
                "IME retains candidate controls without isComposing"
            );
            assert.equal(owner.active(), true);
        }
        // Hint buttons / raw TV command routing must not commit mid-composition.
        key(w.keys.ENTER);
        assert.equal(owner.active(), true);
        input.dispatchEvent(
            new w.CompositionEvent("compositionend", { data: value })
        );
        input.dispatchEvent(
            new w.KeyboardEvent("keydown", {
                bubbles: true,
                cancelable: true,
                key: "Enter",
                keyCode: 229,
            })
        );
        assert.equal(owner.active(), true, "229 commit event is not a save");
        key(w.keys.ENTER);
        assert.equal(
            owner.active(),
            true,
            "raw TV Enter cannot implicitly submit after composition"
        );
        w.document.querySelector('#listEdit [data-ott-key="13"]').focus();
        key(w.keys.ENTER);
        assert.equal(owner.active(), false);
        assert.equal(
            saves[saves.length - 1],
            value,
            "read input.value once without appending event.data"
        );
        input.dispatchEvent(new w.CompositionEvent("compositionstart"));
        assert.equal(
            owner.model.nativeInputComposing,
            false,
            "closed editor removes composition listeners"
        );
    }
    assert.equal(saves.length, 3);
});
function beginSwopEditor({ w, jobs }, mode, pendingSession = false) {
    configureSwopEditor(w, mode);
    const port = w.__ottClassicScreenPort;
    const requests = [],
        saves = [];
    w.$.ajax = (request) => requests.push(request);
    w.listKeyHandler = () => true;
    port.commitList();
    w.editCaption = "Search";
    w.editvar = mode === "native" ? "before typing" : "initial draft";
    let editor;
    const save = () => {
        // Channel search captures this original owner when opening the editor.
        if (!port.acceptsEditorSave(editor)) return;
        saves.push(w.editvar);
    };
    w.setEdit = save;
    w.showEditKey(null, true);
    editor = port.owner("editor");
    const handler = w.editKey,
        panel = port.savedPanel();
    const button = w.document.getElementById("editRemoteInput");
    if (mode === "native") {
        assert.equal(button.textContent, "Remote text entry");
        let bodyClicks = 0;
        w.document.body.addEventListener("click", () => bodyClicks++);
        const input = w.document.getElementById("editvar");
        input.value = "initial draft";
        button.click();
        assert.equal(
            bodyClicks,
            0,
            "remote button must not reach the body click-to-close router"
        );
        input.dispatchEvent(
            new w.KeyboardEvent("keydown", { key: "Enter", keyCode: 13 })
        );
        button.dispatchEvent(
            new w.KeyboardEvent("keydown", { key: "Escape", keyCode: 27 })
        );
        assert(
            editor.active(),
            "detached native controls cannot finish a pending remote session"
        );
    } else w.swopLoadValue();
    assert.notEqual(w.editKey, handler);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/swop/session");
    assert.equal(JSON.parse(requests[0].data).draft, "initial draft");
    assert.deepEqual(saves, []);
    assert.deepEqual(Object.keys(requests[0].headers), ["X-Swop-Client-Id"]);
    if (pendingSession)
        return { button, editor, handler, panel, port, requests, save, saves };
    requests[0].success({
        code: "ABCDEF",
        entryCode: "ABCDEF-GHJKLM",
        entryUrl: "https://swop.test/",
        sessionToken: "test-read-token",
        url: "https://swop.test/?c=ABCDEF&t=test-write-token",
    });
    const poll = jobs.find((job) => job.active && job.delay === 3000);
    assert(poll, "session schedules the production poll callback");
    poll.active = false;
    poll.callback();
    assert.equal(requests.length, 2);
    assert.equal(requests[1].url, "/swop/val");
    return { button, editor, handler, panel, port, requests, save, saves };
}
for (const platform of ["__TAURI__", "Capacitor"]) {
    test(
        platform +
            " redirect exposes native remote input instead of the TV keyboard",
        ({ w }) => {
            configureSwopEditor(w, "TV");
            w[platform] = {};
            w.showEditKey();
            assert(w.document.getElementById("editvar"));
            assert.equal(
                w.document.getElementById("editRemoteInput").textContent,
                "Remote text entry"
            );
        }
    );
}
test("Tauri fullscreen capture lets native remote-button Escape discard the editor", ({
    w,
}) => {
    configureSwopEditor(w, "native");
    const fullscreenCalls = [],
        saves = [];
    w.__TAURI__ = {};
    w.__ottTauriNativeFs = true;
    w.stbSetTauriNativeFullscreen = (value) => fullscreenCalls.push(value);
    w.eval(functions("src/core/index.ts", ["installTauriFsKeyCapture"]));
    w.installTauriFsKeyCapture();
    w.setEdit = () => saves.push(w.editvar);
    w.showEditKey();
    const owner = w.__ottClassicScreenPort.owner("editor");
    const button = w.document.getElementById("editRemoteInput");
    const escape = () =>
        new w.KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            code: "Escape",
            key: "Escape",
            keyCode: 27,
        });
    button.focus();
    button.dispatchEvent(escape());
    assert.equal(owner.active(), false);
    assert.deepEqual(saves, []);
    assert.deepEqual(fullscreenCalls, []);
    w.document.body.dispatchEvent(escape());
    assert.deepEqual(
        fullscreenCalls,
        [false],
        "Escape outside the editor still exits fullscreen"
    );
});
for (const mode of ["native", "TV"]) {
    test(
        "SWOP " + mode + " resumes the original editor and Enter saves once",
        (f) => {
            const { w, key } = f;
            const s = beginSwopEditor(f, mode);
            const value = "Новости & café <2026>";
            s.requests[1].success({ status: "ready", value });
            assert.equal(s.port.owner("editor"), s.editor);
            assert.equal(s.editor.model.save, s.save);
            assert.equal(s.port.savedPanel(), s.panel);
            assert.equal(w.editKey, s.handler);
            assert.equal(w.editvar, value);
            if (mode === "native") {
                const input = w.document.getElementById("editvar");
                assert.equal(input.value, value);
                assert.equal(input.type, "password");
                assert.equal(w.document.activeElement, input);
                s.button.click();
                assert.equal(
                    s.requests.length,
                    2,
                    "retired button is detached"
                );
            } else {
                const selected = w.document.getElementById("ik" + w._keyCur);
                assert.equal(selected.textContent.trim(), "Ok");
                assert(selected.style.backgroundColor);
            }
            key(w.keys.ENTER);
            assert.deepEqual(s.saves, [value]);
            assert.equal(s.editor.active(), false);
            assert.equal(w.$("#listEdit").is(":visible"), false);
            assert.equal(w.listCaptionElement.textContent, "Parent");
            assert.equal(w.listFooterElement.textContent, "Footer");
            key(w.keys.ENTER);
            assert.deepEqual(s.saves, [value]);
        }
    );
    test(
        "SWOP " + mode + " cancel retains the editor and ignores a late result",
        (f) => {
            const { w, key } = f;
            const s = beginSwopEditor(f, mode);
            key(w.keys.RETURN);
            assert.equal(s.port.owner("editor"), s.editor);
            assert.equal(s.editor.model.save, s.save);
            assert.equal(s.port.savedPanel(), s.panel);
            assert.equal(w.editKey, s.handler);
            assert.equal(w.editvar, "initial draft");
            if (mode === "native")
                assert.equal(
                    w.document.getElementById("editvar").type,
                    "password"
                );
            assert.equal(w.$("#listEdit").is(":visible"), true);
            assert.deepEqual(s.saves, []);
            s.requests[1].success({
                status: "ready",
                value: "late phone value",
            });
            assert.equal(w.editvar, "initial draft");
            key(w.keys.RETURN);
            assert.equal(s.editor.active(), false);
            assert.equal(w.$("#listEdit").is(":visible"), false);
            assert.equal(w.listCaptionElement.textContent, "Parent");
            assert.deepEqual(s.saves, []);
        }
    );
    test(
        "SWOP " + mode + " resume without an editor cannot create one",
        ({ w }) => {
            configureSwopEditor(w, mode);
            assert.doesNotThrow(() => w.showEditKey(null, undefined, true));
            assert.equal(w.__ottClassicScreenPort.owner("editor"), undefined);
            assert.equal(w.__ottScreens.current(), null);
            assert.equal(w.$("#listEdit").is(":visible"), false);
            assert.equal(w.listCaptionElement.textContent, "Parent");
        }
    );
}
test("native remote button reports unconfigured service without saving or leaving the field", ({
    w,
}) => {
    configureSwopEditor(w, "native");
    const alerts = [];
    w.alert = (message) => alerts.push(message);
    w.getSwopBaseUrl = () => "";
    w.$.ajax = () => assert.fail("unconfigured input must not make a request");
    w.setEdit = () => assert.fail("opening remote input must not save");
    w.showEditKey();
    const input = w.document.getElementById("editvar");
    input.value = "typed & <literal>";
    w.document.getElementById("editRemoteInput").click();
    assert.deepEqual(alerts, ["Remote text entry not configured"]);
    assert.equal(w.document.getElementById("editvar"), input);
    assert.equal(w.editvar, input.value);
});
for (const mode of ["native", "TV"]) {
    test(
        "SWOP " +
            mode +
            " owner cleanup rejects late session callbacks and stale input",
        (f) => {
            const { w, jobs } = f;
            const s = beginSwopEditor(f, mode, true);
            const staleKey = w.editKey;
            w.setEdit = () =>
                assert.fail("stale session cannot save replacement");
            w.editvar = "replacement draft";
            w.showEditKey();
            const replacement = s.port.owner("editor");
            const html = w.document.getElementById("listEdit").innerHTML;
            const handler = w.editKey;
            assert.equal(s.editor.active(), false);
            assert.equal(
                jobs.some((job) => job.active && job.delay === 600000),
                false
            );
            s.requests[0].error({
                responseJSON: { error: "late denial" },
                status: 403,
            });
            s.requests[0].success({ code: "OLDOLD", sessionToken: "stale" });
            jobs.forEach((job) => job.callback());
            staleKey(w.keys.RETURN);
            if (s.button) s.button.click();
            assert.equal(s.port.owner("editor"), replacement);
            assert.equal(w.editKey, handler);
            assert.equal(w.editvar, "replacement draft");
            assert.equal(w.document.getElementById("listEdit").innerHTML, html);
            assert.equal(s.requests.length, 1);
        }
    );
    test(
        "SWOP " +
            mode +
            " invalidation cancels polls and ignores late ready/error callbacks",
        (f) => {
            const { w, jobs } = f;
            const s = beginSwopEditor(f, mode);
            s.port.invalidate();
            w.editvar = "new source";
            w.$("#listEdit").html("new screen").show();
            s.requests[1].error({ status: 500 });
            s.requests[1].success({ status: "ready", value: "stale value" });
            jobs.forEach((job) => job.callback());
            assert.equal(w.editvar, "new source");
            assert.equal(w.$("#listEdit").text(), "new screen");
            assert.equal(s.requests.length, 2);
            assert.equal(
                jobs.some((job) => job.active),
                false
            );
        }
    );
}
test("native SWOP timeout restores the typed draft and original save callback", (f) => {
    const { w, jobs } = f;
    const alerts = [];
    w.alert = (message) => alerts.push(message);
    const s = beginSwopEditor(f, "native", true);
    jobs.find((job) => job.active && job.delay === 600000).callback();
    assert.deepEqual(alerts, ["Remote session expired"]);
    assert.equal(s.port.owner("editor"), s.editor);
    assert.equal(s.editor.model.save, s.save);
    assert.equal(w.document.getElementById("editvar").value, "initial draft");
    assert.equal(w.document.getElementById("editvar").type, "password");
    assert.deepEqual(s.saves, []);
});
test("source replacement retires dialogs, editor and scheduled list detail", ({
    w,
    jobs,
}) => {
    let calls = 0;
    w.detailListActionFn = () => calls++;
    w.__ottClassicScreenPort.commitList();
    w.scheduleListDetailUpdate();
    w.confirmBox("old", () => calls++);
    const old = w.dialogBoxKeyHandler;
    w.__ottClassicScreenPort.invalidate();
    old(13);
    jobs.forEach((j) => j.callback());
    assert.equal(calls, 0);
});
test("playback description scrolling cannot cancel pending list controls", ({
    w,
    jobs,
}) => {
    let rendered = 0;
    w.detailListActionFn = () => rendered++;
    w.__ottClassicScreenPort.commitList();
    w.scheduleListDetailUpdate();
    const detail = jobs.at(-1);
    // A previous playback-description animation completes after opening search.
    w.scrollUp("programm_descr", 20, 10000);
    const animation = jobs.at(-1);
    assert.equal(
        detail.active,
        true,
        "The list still owns its scheduled render"
    );
    detail.callback();
    assert.equal(rendered, 1);
    w.scheduleListDetailUpdate();
    assert.equal(
        animation.active,
        false,
        "New selection retires old scrolling"
    );
});
test("rapid list selection owns only the pending detail timer", ({
    w,
    jobs,
}) => {
    const owner = w.__ottClassicScreenPort.commitList();
    const own = owner.own;
    let cleanups = 0;
    const rendered = [];
    owner.own = (cleanup) => {
        cleanups++;
        return own(() => {
            cleanups--;
            cleanup();
        });
    };
    for (let selection = 0; selection < 100; selection++) {
        w.detailListActionFn = () => rendered.push(selection);
        w.scheduleListDetailUpdate();
    }
    assert.equal(jobs.filter((job) => job.active).length, 1);
    assert.equal(cleanups, 1, "canceled debounce cleanups are released");
    jobs.forEach((job) => job.callback());
    assert.deepEqual(rendered, [99], "queued canceled callbacks are inert");
    assert.equal(cleanups, 0, "completed timer releases its cleanup");
    assert.equal(jobs.filter((job) => job.active).length, 0);
    w.scheduleListDetailUpdate();
    assert.equal(cleanups, 1);
    owner.close();
    assert.equal(cleanups, 0, "closing the list releases the final timer");
    assert.equal(jobs.filter((job) => job.active).length, 0);
    jobs[jobs.length - 1].callback();
    assert.deepEqual(rendered, [99]);
});
test("dialog callback opens a replacement without old closure closing it", ({
    w,
    key,
}) => {
    let calls = 0;
    w.confirmBox("first", () => w.confirmBox("second", () => calls++));
    const old = w.dialogBoxKeyHandler;
    key(13);
    old(13);
    assert.equal(calls, 0);
    assert.notEqual(
        w.document.getElementById("dialogbox").style.display,
        "none"
    );
    key(13);
    assert.equal(calls, 1);
});
test("picker timeout and saved callback cannot affect newer picker", ({
    w,
    jobs,
}) => {
    const chosen = [];
    w.showSelectBox(0, ["a", "b"], (v) => chosen.push(["old", v]), 0);
    const first = w.selectBoxKeyHandler;
    w.showSelectBox(0, ["c", "d"], (v) => chosen.push(["new", v]), -1);
    jobs[0].callback();
    first(13);
    assert.deepEqual(chosen, []);
    w.selectBoxKeyHandler(40);
    w.selectBoxKeyHandler(13);
    assert.deepEqual(chosen, [["new", 1]]);
});
test("retired focused picker row lets Enter reach the new confirmation", ({
    w,
}) => {
    let selected = 0,
        resumed = 0;
    w._doKey = w.dispatchKey;
    w.addEventListener("keydown", w.keyHandler);
    w.showSelectBox(
        0,
        ["HD", "SD"],
        () => {
            selected++;
            w.confirmBox("Continue?", () => resumed++);
        },
        -1
    );
    const old = w.channelNumberElement.firstChild;
    const press = (target, code) =>
        target.dispatchEvent(
            new w.KeyboardEvent("keydown", {
                bubbles: true,
                cancelable: true,
                keyCode: code,
                which: code,
            })
        );
    press(old, w.keys.ENTER);
    assert.equal(selected, 1);
    assert.equal(resumed, 0, "opening key cannot also accept the confirmation");
    assert.equal(w.channelNumberElement.style.display, "none");
    // Chromium may target this old focused node until the next rendering frame.
    press(old, w.keys.ENTER);
    assert.equal(selected, 1);
    assert.equal(
        resumed,
        1,
        "retired node does not swallow the current modal's key"
    );
    w.showSelectBox(0, ["HD", "SD"], () => selected++, -1);
    press(w.channelNumberElement.firstChild, 32);
    assert.equal(
        selected,
        2,
        "Space still accepts a foreground quality option once"
    );
});
test("quality picker suspends and restores its media parent", ({
    w,
    events,
}) => {
    const list = w.__ottClassicScreenPort.commitList();
    let cleanup = 0;
    list.own(() => cleanup++);
    w.showSelectBox(0, ["HD", "SD"], () => {}, -1, true);
    assert(list.active());
    assert.equal(cleanup, 0);
    assert.deepEqual(events, []);
    w.selectBoxKeyHandler(8);
    assert.equal(w.__ottScreens.current(), list);
    assert.equal(w.listElement.style.display, "");
});
test("immediate picker reentry cannot overwrite newer markup or timer", ({
    w,
    jobs,
}) => {
    w.showSelectBox(
        0,
        ["old-a", "old-b"],
        () => w.showSelectBox(0, ["new-a", "new-b"], () => {}, -1),
        1000
    );
    assert.match(w.channelNumberElement.innerHTML, /new-a/);
    assert.doesNotMatch(w.channelNumberElement.innerHTML, /old-a/);
    assert.equal(jobs.length, 0);
});
test("explicit picker decoration preserves its owner, input dispatch and stale guards", ({
    w,
    key,
}) => {
    const port = w.__ottClassicScreenPort,
        parent = port.commitList(),
        chosen = [];
    let cleanup = 0,
        calls = 0;
    parent.own(() => cleanup++);
    w.showSelectBox(0, ["HD", "SD"], (value) => chosen.push(value), -1, true);
    const original = w.selectBoxKeyHandler,
        owner = port.owner("picker");
    const decorated = port.decorateOwnedCallback("picker", original, (code) => {
        calls++;
        return original(code);
    });
    assert.equal(port.owner("picker"), owner);
    assert.equal(cleanup, 0);
    assert.equal(
        port.decorateOwnedCallback("picker", original, () => {}),
        null
    );
    key(40);
    key(13);
    assert.deepEqual(chosen, [1]);
    assert.equal(calls, 2);
    assert(parent.active());
    w.showSelectBox(0, ["new", "other"], () => {}, -1, true);
    decorated(13);
    assert.equal(calls, 2);
    assert.deepEqual(chosen, [1]);
});
test("notification replacement cancels the earlier hide timer", ({
    w,
    jobs,
}) => {
    const info = w.document.createElement("div");
    info.id = "info";
    w.document.body.appendChild(info);
    w.showShift("First");
    w.showShift("Settings saved");
    assert.equal(jobs.filter((job) => job.active).length, 1);
    assert.equal(jobs[0].active, false);
    assert.equal(info.style.display, "block");
    assert.equal(info.textContent, "Settings saved");
    jobs[1].callback();
    assert.equal(info.style.display, "none");
});
test("notification delay belongs to its node after replacement", ({
    w,
    jobs,
}) => {
    w.showShift("Missing node");
    assert.equal(jobs.length, 0);
    const oldInfo = w.document.createElement("div");
    oldInfo.id = "info";
    w.document.body.appendChild(oldInfo);
    w.showShift("Old node");
    oldInfo.remove();
    const info = w.document.createElement("div");
    info.id = "info";
    info.style.display = "inline";
    w.document.body.appendChild(info);
    w.showShift("Replacement node");
    assert.equal(info.style.display, "block");
    jobs[0].callback();
    assert.equal(oldInfo.style.display, "none");
    assert.equal(info.style.display, "block");
    assert.equal(info.textContent, "Replacement node");
    jobs[1].callback();
    assert.equal(info.style.display, "none");
});
test("settings value clicks honor filtered indices and the current overlay", ({
    w,
    key,
}) => {
    w.settings = { pageSize: 25 };
    w.getViewportHeightScale = () => 1;
    w._curVal = 0;
    w.showPage();
    const row = { name: "Fixture", val: 0, values: ["A", "@@@", "B", "C"] };
    w.selectValue(row);
    const button = w.document.getElementById("ik1");
    assert.equal(button.getAttribute("onclick"), null);
    assert.equal(button.style.lineHeight, "32px");
    assert(button.style.width);
    w.confirmBox("Overlay", () =>
        assert.fail("grid cannot activate the dialog")
    );
    button.click();
    assert.equal(w._curVal, 0, "covered grid cannot change selection");
    key(w.keys.RETURN);
    button.click();
    assert.equal(w._curVal, 1);
    assert.equal(row.val, 0, "first click only focuses");
    assert.equal(w.listDetailElement.textContent, "B");
    button.click();
    assert.equal(
        row.val,
        2,
        "second click commits the original, unfiltered index"
    );
    assert.equal(w.$("#listAbout").is(":visible"), false);
    w.selectValue(row);
    key(w.keys.RIGHT);
    key(w.keys.RETURN);
    assert.equal(row.val, 2, "Back cancels the uncommitted keyboard selection");
    w.selectValue(row);
    key(w.keys.RIGHT);
    key(w.keys.ENTER);
    assert.equal(row.val, 3, "keyboard acceptance still commits");
});
test("settings grid keeps label markup consistent without confirming zero movement", ({
    w,
    key,
}) => {
    w.settings = { pageSize: 25 };
    w.getViewportHeightScale = () => 1;
    w._curVal = 0;
    w.showPage();
    const row = {
        name: "Fixture",
        val: 0,
        values: ["Rock &amp; Roll <b>HD</b>", "News &lt;Live&gt; <i>2</i>"],
    };
    w.selectValue(row);
    const first = w.document.getElementById("ik0");
    const second = w.document.getElementById("ik1");
    assert.equal(w.listDetailElement.innerHTML, first.innerHTML);
    assert.equal(w.listDetailElement.textContent, "Rock & Roll HD");
    key(w.keys.UP);
    assert.equal(
        w._curVal,
        0,
        "Up at the first short row moves zero positions"
    );
    assert.equal(w.$("#listAbout").is(":visible"), true);
    assert.equal(row.val, 0);
    key(w.keys.RIGHT);
    assert.equal(w.listDetailElement.innerHTML, second.innerHTML);
    assert.equal(w.listDetailElement.textContent, "News <Live> 2");
    first.click();
    assert.equal(w.listDetailElement.innerHTML, first.innerHTML);
    assert.equal(w.listDetailElement.textContent, "Rock & Roll HD");
    assert.equal(w.$("#listAbout").is(":visible"), true);
});
test("settings grid measures each visible label once and clears the probe once", ({
    w,
    key,
}) => {
    w.settings = { pageSize: 25 };
    w.getViewportHeightScale = () => 1;
    w._curVal = 0;
    w.showPage();
    w.$("body").append('<div id="testFont"></div>');
    const widths = { A: 40, B: 120, C: 80, D: 40, E: 100, Wide: 250 };
    const measured = [];
    let clears = 0;
    const originalWidth = w.$.fn.width;
    const originalText = w.$.fn.text;
    w.$.fn.width = function () {
        if (this[0]?.id === "testFont") {
            const label = this[0].textContent.trim();
            measured.push(label);
            return widths[label];
        }
        if (this[0]?.id === "listAbout") return 1000;
        return originalWidth.apply(this, arguments);
    };
    w.$.fn.text = function (value) {
        if (this[0]?.id === "testFont" && value === "") clears++;
        return originalText.apply(this, arguments);
    };
    const row = {
        name: "Fixture",
        val: 0,
        values: ["A", "@@@", "Wide", "B", "C", "D", "E"],
    };
    w.selectValue(row);
    assert.deepEqual(measured, ["A", "Wide", "B", "C", "D", "E"]);
    assert.equal(clears, 1);
    assert.equal(w.document.getElementById("testFont").textContent, "");
    assert.equal(
        parseFloat(w.document.getElementById("ik0").style.width),
        98 / 3,
        "the widest label determines three columns"
    );
    key(w.keys.DOWN);
    assert.equal(w.listDetailElement.textContent, "C");
    key(w.keys.ENTER);
    assert.equal(
        row.val,
        4,
        "vertical movement retains the filtered value map"
    );
});
for (const width of [0, undefined]) {
    test(
        "settings grid retains six-column fallback for width " + width,
        ({ w }) => {
            w.settings = { pageSize: 25 };
            w.getViewportHeightScale = () => 1;
            w._curVal = 0;
            w.showPage();
            const originalWidth = w.$.fn.width;
            w.$.fn.width = function () {
                if (this[0]?.id === "listAbout") return 1000;
                if (!this.length) return width;
                return originalWidth.apply(this, arguments);
            };
            w.selectValue({ name: "Fixture", val: 0, values: ["A", "B"] });
            assert.equal(
                parseFloat(w.document.getElementById("ik0").style.width),
                98 / 6
            );
        }
    );
}
test("color picker old callback cannot commit to a new settings draft", ({
    w,
}) => {
    w.eSHLcolor = "50,85";
    w.colorDialog();
    const old = w.aboutKeyHandler;
    w.__ottClassicScreenPort.invalidate();
    w.eSHLcolor = "90,90";
    old(13);
    assert.equal(w.eSHLcolor, "90,90");
});
const colorCases = require("./fixtures/ui/color-dialogs-before-shared.json");
function colorSetting(name) {
    return name === "colorDialog"
        ? "eSHLcolor"
        : name === "selColorDialog"
          ? "eSHLcolSel"
          : "eSHLcolorB";
}
function colorSnapshot(w, setting) {
    return {
        caption: w.listCaptionElement.innerHTML,
        detail: w.listDetailElement.innerHTML,
        focus: w.selIndex,
        preview: w.document.getElementById("step")?.style.cssText ?? null,
        value: w[setting] ?? null,
        visible: w.$("#listAbout").is(":visible"),
    };
}
for (const scenario of colorCases.records) {
    test(
        "captured color input " +
            scenario.name +
            " " +
            scenario.initial +
            " " +
            scenario.keys.join("/"),
        ({ w }) => {
            const setting = colorSetting(scenario.name);
            if (scenario.initial !== null) w[setting] = scenario.initial;
            if (scenario.keyCodes) Object.assign(w.keys, scenario.keyCodes);
            w.listArray = ["first", "second"];
            w.listDataArray = w.listArray;
            w.listKeyHandler = () => false;
            w.selIndex = 1;
            w.__ottClassicScreenPort.commitList();
            assert.equal(w[scenario.name].length, 0, "public dialog arity");
            w[scenario.name]();
            const states = [colorSnapshot(w, setting)];
            for (const keyName of scenario.keys) {
                const handled = w.aboutKeyHandler(w.keys[keyName]);
                states.push({ handled, ...colorSnapshot(w, setting) });
            }
            assert.deepEqual(states, scenario.states);
        }
    );
}
function clickColorControl(w, element) {
    assert(element, "rendered mouse control exists");
    if (!w.uiInit) w.eval(functions("src/ui/index.ts", ["uiInit"]));
    const listElement = w.listElement;
    w.uiInit();
    w.listElement = listElement;
    assert.equal(element.getAttribute("onclick"), null);
    element.click();
}
for (const name of ["colorDialog", "selColorDialog", "backColorDialog"]) {
    test("color remote/mouse save and parent focus " + name, ({ w, key }) => {
        const setting = colorSetting(name),
            writes = [];
        let saved = "20,30";
        Object.defineProperty(w, setting, {
            configurable: true,
            get: () => saved,
            set: (value) => {
                saved = value;
                writes.push(value);
            },
        });
        w.listArray = ["first", "second"];
        w.listDataArray = w.listArray;
        w.selIndex = 1;
        const listKeys = [];
        w.listKeyHandler = (code) => {
            listKeys.push(code);
            return true;
        };
        const parent = w.__ottClassicScreenPort.commitList();
        w._doKey = key;
        w[name]();
        key(w.keys.RIGHT);
        key(w.keys.UP);
        assert.deepEqual(writes, [], "preview does not commit");
        assert.deepEqual(listKeys, [], "overlay suspends parent input");
        assert.equal(w.selIndex, 1);
        clickColorControl(
            w,
            w.listFooterElement.querySelector('[aria-label="Set"]')
        );
        assert.deepEqual(
            writes,
            ["30,35"],
            "commit invokes original setting setter once"
        );
        assert.equal(w.listCaptionElement.innerHTML, "Parent");
        assert.equal(w.listFooterElement.innerHTML, "Footer");
        assert.equal(w.listDetailElement.innerHTML, "Detail");
        assert.equal(w.$("#listAbout").is(":visible"), false);
        assert(parent.active());
        assert.equal(w.selIndex, 1);
        key(w.keys.ENTER);
        assert.deepEqual(
            listKeys,
            [w.keys.ENTER],
            "parent receives input again"
        );
        w[name]();
        key(w.keys.BLUE);
        clickColorControl(
            w,
            w.listFooterElement.querySelector('[aria-label="Close"]')
        );
        assert.deepEqual(writes, ["30,35"], "mouse cancel discards preview");
    });
    test(
        "retired color input cannot overwrite replacement " + name,
        ({ w }) => {
            const setting = colorSetting(name);
            w[setting] = "20,30";
            w[name]();
            const retired = w.aboutKeyHandler;
            w.__ottClassicScreenPort.invalidate();
            w[name]();
            const preview = w.document.getElementById("step").style.cssText;
            retired(w.keys.BLUE);
            retired(w.keys.ENTER);
            assert.equal(w[setting], "20,30");
            assert.equal(
                w.document.getElementById("step").style.cssText,
                preview
            );
            assert.equal(w.$("#listAbout").is(":visible"), true);
        }
    );
}
test("foreground mouse arrows and color presets dispatch the same owned input", ({
    w,
    key,
}) => {
    w.eSHLcolor = "20,30";
    w._doKey = key;
    w.colorDialog();
    for (const name of ["RIGHT", "UP"]) {
        clickColorControl(
            w,
            w.document.querySelector(
                '#listAbout [data-ott-key="' + w.keys[name] + '"]'
            )
        );
    }
    assert.equal(
        w.document.getElementById("step").style.color,
        "rgb(255, 210, 166)"
    );
    clickColorControl(
        w,
        w.document.querySelector('#listAbout [aria-label="Green"]')
    );
    assert.equal(
        w.document.getElementById("step").style.color,
        "rgb(147, 255, 38)"
    );
    clickColorControl(
        w,
        w.listFooterElement.querySelector('[aria-label="Set"]')
    );
    assert.equal(w.eSHLcolor, "90,85");
});
test("menu IDs survive labels, host function names and legacy hide imports", ({
    w,
}) => {
    w.toggleAspectRatio = function renamed() {};
    w.toggleProviderSettingsVisibility = function unlock() {};
    w.popupActions = [w.toggleAspectRatio, w.toggleProviderSettingsVisibility];
    w.popupArray = ["Translated", ""];
    w.popupDetail = [];
    w.sHideMenus = ["noProvParam"];
    const first = w.__ottMenuRegistry.open(w);
    assert.equal(first.rows.length, 1);
    assert.equal(first.rows[0].id, "video.aspect");
    w.sHideMenus = ["video.aspect"];
    const second = w.__ottMenuRegistry.open(w);
    assert.equal(second.rows[0].id, "provider.unlock");
});
test("actual popup has owned menu command dispatch and rejects captured retired handler", ({
    w,
    key,
}) => {
    let calls = 0;
    w.optionsList = () => calls++;
    w.popupActions = [w.optionsList];
    w.popupArray = ["Settings"];
    w.popupDetail = [];
    w.popupList("settings.open");
    const old = w.listKeyHandlerFn;
    key(13);
    assert.equal(calls, 1);
    w.__ottClassicScreenPort.invalidate();
    old(13);
    assert.equal(calls, 1);
});
test("menu capability filtering preserves legacy archive and media availability", ({
    w,
}) => {
    w.popPause = () => {};
    w.popMedia = () => {};
    w.popupActions = [w.popPause, w.popMedia];
    w.popupArray = ["Pause/Play", "Media"];
    w.channels = { x: { rec: 0 } };
    w.curList = ["x"];
    w.primaryIndex = 0;
    w.playType = 0;
    assert.equal(w.__ottMenuRegistry.open(w).rows.length, 0);
    w.playType = -1;
    w.getMediaArray = () => {};
    assert.equal(w.__ottMenuRegistry.open(w).rows.length, 2);
});
test("closing the parent revokes nested callbacks and hides their surfaces", ({
    w,
}) => {
    const list = w.__ottClassicScreenPort.commitList();
    w.editvar = "old";
    w.setEdit = () => {
        throw new Error("retired save");
    };
    w.showEditKey2();
    w.confirmBox("old", () => {
        throw new Error("retired confirmation");
    });
    const stale = w.dialogBoxKeyHandler;
    w.__ottClassicScreenPort.closeList();
    stale(w.keys.ENTER);
    assert.equal(list.active(), false);
    assert.equal(w.__ottScreens.current(), null);
    assert.equal(w.document.getElementById("dialogbox").style.display, "none");
    assert.equal(w.document.getElementById("listEdit").style.display, "none");
});
test("pointer and wheel selection cannot move a covered list, while model updates remain available", ({
    w,
}) => {
    w.eval(functions("src/ui/index.ts", ["setSelect", "changeSelect"]));
    w.settings = { pageSize: 25 };
    w.listArray = w.listDataArray = ["first", "second"];
    w.selIndex = 0;
    w.scheduleListDetailUpdate = () => {};
    w.showPage();
    const dialog = w.__ottClassicScreenPort.setOwnedCallback(
        "dialog",
        () => {}
    ).owner;
    w.setSelect(1);
    w.changeSelect(1);
    assert.equal(w.selIndex, 0);
    // Provider/render projection writes are independent of input admission.
    w.listArray = w.listDataArray = ["updated", "second"];
    assert.equal(w.listArray[0], "updated");
    dialog.close();
    w.showPage();
    w.setSelect(1);
    assert.equal(w.selIndex, 1);
    w.changeSelect(-1);
    assert.equal(w.selIndex, 0);
});
test("retired list models do not alias replacement fields", ({ w }) => {
    w.listArray = ["old"];
    w.listDataArray = w.listArray;
    const first = w.__ottClassicScreenPort.commitList();
    w.listArray = ["new"];
    w.listDataArray = w.listArray;
    const second = w.__ottClassicScreenPort.commitList();
    assert.notEqual(first.model, second.model);
    assert.equal(first.model.items[0], "old");
    assert.equal(second.model.items[0], "new");
});
test("overlay cleanup reentry keeps the latest owner and callback", ({ w }) => {
    const calls = [];
    w.__ottClassicScreenPort.setOwnedCallback("dialog", () =>
        calls.push("first")
    );
    w.__ottClassicScreenPort.owner("dialog").own(() => {
        w.__ottClassicScreenPort.setOwnedCallback("dialog", () =>
            calls.push("newest")
        );
    });
    const abandoned = w.__ottClassicScreenPort.setOwnedCallback("dialog", () =>
        calls.push("abandoned")
    );
    abandoned(w.keys.ENTER);
    w.dialogBoxKeyHandler(w.keys.ENTER);
    assert.deepEqual(calls, ["newest"]);
});
test("list cleanup source replacement cannot resurrect an abandoned screen", ({
    w,
}) => {
    const port = w.__ottClassicScreenPort;
    w.listKeyHandler = () => false;
    const first = port.commitList();
    first.own(() => port.invalidate());
    w.listKeyHandler = () => true;
    const abandoned = port.commitList();
    assert.equal(abandoned.active(), false);
    assert.equal(w.__ottScreens.current(), null);
});
test("picker cleanup reentry cannot render an abandoned choice", ({ w }) => {
    w.showSelectBox(0, ["first", "first2"], () => {}, -1);
    w.__ottClassicScreenPort.owner("picker").own(() => {
        w.showSelectBox(0, ["newest", "newest2"], () => {}, -1);
    });
    w.showSelectBox(0, ["abandoned", "abandoned2"], () => {}, -1);
    assert.match(w.channelNumberElement.innerHTML, /newest/);
    assert.doesNotMatch(w.channelNumberElement.innerHTML, /abandoned/);
});
test("nested about screens resume the saved owner and isolate suspended input", ({
    w,
}) => {
    let parentCalls = 0;
    w.__ottClassicScreenPort.setOwnedCallback("about", () => {
        parentCalls++;
        return true;
    });
    const parent = w.__ottClassicScreenPort.owner("about");
    const parentCallback = w.aboutKeyHandler;
    w.saveListPanelState();
    w.__ottClassicScreenPort.setOwnedCallback("about", () => true);
    parentCallback(w.keys.ENTER);
    assert.equal(parentCalls, 0);
    assert.equal(parent.active(), true);
    w.restoreListPanelState();
    assert.equal(w.__ottScreens.current(), parent);
    parentCallback(w.keys.ENTER);
    assert.equal(parentCalls, 1);
});
test("saved panels are released with their parent and cursor timers with the editor", ({
    w,
}) => {
    const port = w.__ottClassicScreenPort;
    w.listKeyHandler = () => false;
    const parent = port.commitList();
    port.savePanel({ retained: "parent" });
    parent.close();
    assert.equal(port.savedPanel().retained, undefined);
    const cleared = [];
    const intervals = [];
    w.cursorInterval = null;
    w.setInterval = (callback) => {
        intervals.push(callback);
        return intervals.length;
    };
    w.clearInterval = (id) => cleared.push(id);
    w.editvar = "text";
    const editor = port.openEditor();
    w._changeEdit();
    w._changeEdit();
    assert(cleared.includes(1), "redraw releases the previous cursor interval");
    port.invalidate();
    assert.equal(editor.active(), false);
    assert(
        cleared.includes(2),
        "source replacement releases the latest cursor interval"
    );
});
test("numeric button settings import to stable command identities without mutation", ({
    w,
}) => {
    const expected = [
        "archive.records",
        "menu.open",
        "channel.previous",
        "archive.seek",
        "information.channel",
        "video.aspect",
        "audio.track",
        "pip.toggle",
        "pip.close",
        "channels.categories",
        "guide.open",
        "media.open",
        "navigation.quick",
        "volume.increase",
        "volume.decrease",
        "navigation.forward",
        "navigation.backward",
        "subtitle.track",
        "archive.minute-back",
        "archive.minute-forward",
        "program.previous",
        "program.next",
    ];
    assert.deepEqual(
        expected.map((_, index) => w.__ottInputRouter.binding(index)),
        expected
    );
    assert.equal(w.__ottInputRouter.binding(-1), undefined);
    assert.equal(w.__ottInputRouter.binding(22), undefined);
});
console.log(
    "PASS screen ownership: " +
        passed +
        " groups, actual ES5 private modules and UI/input functions"
);

test("loading cancellation runs before Q exits but ordinary dialogs stay modal", ({
    w,
}) => {
    const actions = [];
    w.keys.POWER = 81;
    w.stbExit = () => actions.push("exit");
    w.body_onUnload = () => actions.push("save");
    w.$("#dialogbox").show();
    const loading = w.__ottClassicScreenPort.setOwnedCallback("dialog", () =>
        actions.push("loading-key")
    ).owner;
    loading.model.cancelOnPower = () => {
        actions.push("cancel");
        loading.close();
    };
    w.__ottClassicScreenPort.dispatch(81, null, (command) =>
        actions.push(command.id)
    );
    assert.equal(actions[0], "cancel");
    assert.ok(actions.includes("power"));
    assert.ok(!actions.includes("loading-key"));
    actions.length = 0;
    w.$("#dialogbox").show();
    w.__ottClassicScreenPort.setOwnedCallback("dialog", () =>
        actions.push("modal-key")
    );
    w.__ottClassicScreenPort.dispatch(81, null, (command) =>
        actions.push(command.id)
    );
    assert.deepEqual(actions, ["modal-key"]);
});
