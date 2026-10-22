/* Exercise the actual legacy-bundle function bodies with a deterministic DOM/provider fixture. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { JSDOM } = require("jsdom");
const { settingsSource } = require("./helpers/settings-source-fixture.cjs");
const { localizationRuntime } = require("./helpers/localization-runtime.cjs");
const localizationCode = localizationRuntime();
const root = path.resolve(__dirname, "..");
const selectorDocument = new JSDOM("").window.document;

function sourceFunctions(file, names) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const found = ast.statements.filter(
        (node) =>
            ts.isFunctionDeclaration(node) &&
            node.body &&
            names.includes(node.name.text)
    );
    assert.equal(
        found.length,
        names.length,
        `Every function must exist in ${file}`
    );
    return ts.transpileModule(
        found
            .map((node) => node.getText(ast).replace(/^export\s+/, ""))
            .join("\n"),
        {
            compilerOptions: {
                module: ts.ModuleKind.None,
                target: ts.ScriptTarget.ES5,
            },
        }
    ).outputText;
}

function fixture() {
    const elements = {};
    const calls = [];
    const stored = {};
    const timers = [];
    const element = (id) =>
        (elements[id] ||= { innerHTML: "", style: {}, textContent: "" });
    function $(selector) {
        const el = typeof selector === "string" ? element(selector) : selector;
        return {
            css(name, value) {
                if (value !== undefined) el.style[name] = value;
                return this;
            },
            height() {
                return 0;
            },
            hide() {
                el.style.display = "none";
                return this;
            },
            html(value) {
                if (value !== undefined) el.innerHTML = value;
                return this;
            },
            not() {
                return this;
            },
            remove() {
                return this;
            },
            show() {
                el.style.display = "";
                return this;
            },
            text(value) {
                if (value !== undefined) el.textContent = String(value);
                return this;
            },
            toggle(visible) {
                el.style.display = visible ? "" : "none";
                return this;
            },
        };
    }
    const c = {
        _: (text) => text,
        _prog100: { name: "Live" },
        $,
        calls,
        catIndex: 0,
        cats: { All: [1] },
        catsArray: ["All"],
        channelNumberElement: selectorDocument.createElement("div"),
        clearTimeout() {},
        closeList() {
            calls.push(["close"]);
        },
        confirmBox(message, yes) {
            calls.push(["confirm", message]);
            c.confirm = yes;
        },
        console,
        curColor: "white",
        curColorB: "black",
        curList: [1],
        Date,
        document: {
            createElement: (tag) => selectorDocument.createElement(tag),
            getElementById: (id) => element(`#${id}`),
        },
        elements,
        encodeURIComponent,
        enterPinAndSetAccess(next) {
            calls.push(["pin"]);
            c.unlock = next;
        },
        formatSeekOffset: String,
        getThumbnail: () => "",
        getViewportHeightScale: () => 1,
        getViewportWidthScale: () => 1,
        infoBox(text) {
            calls.push(["message", text]);
        },
        infoMedia() {
            calls.push(["info"]);
        },
        innerHeight: 720,
        isFinite,
        JSON,
        keys: {
            BLUE: 406,
            DOWN: 40,
            ENTER: 13,
            EXIT: 27,
            FF: 34,
            GREEN: 404,
            LEFT: 37,
            N0: 48,
            N2: 50,
            N5: 53,
            N8: 56,
            N9: 57,
            NEXT: 35,
            PLAY: 415,
            PRECH: 191,
            PREV: 36,
            RED: 403,
            RETURN: 8,
            RIGHT: 39,
            RW: 33,
            TOOLS: 84,
            UP: 38,
            YELLOW: 405,
        },
        listArray: [],
        listDataArray: [],
        listElement: element("#list_window"),
        Math,
        medFavorites: [],
        medHistory: [],
        mediaCheckTimer: null,
        mediaName: "",
        mediaNames: [],
        mediaRecords: [],
        mediaRecordsPar: null,
        mediaSelects: [],
        mediaUrls: null,
        Number,
        parentAccess: false,
        parentPIN: "1234",
        playTime: 0,
        playType: 0,
        popupList() {
            calls.push(["popup"]);
        },
        prevArr: [],
        primaryIndex: 0,
        providerGetItem: (key) => stored[key] ?? null,
        providerSetItem: (key, value) => (stored[key] = value),
        refreshAudioBadge() {},
        renderButtonHint: (key, icon, text) => text,
        sArrowFun: 0,
        selIndex: 0,
        setInterval: (fn) => (timers.push(fn), timers.length),
        setTimeout: (fn) => (timers.push(fn), timers.length),
        settings: { favorites: 0, pageSize: 25, prevCount: 2 },
        sFavorites: 0,
        showEditKey() {
            calls.push(["edit"]);
        },
        showPage() {
            calls.push(["render", c.mediaName]);
        },
        showShift(text) {
            calls.push(["shift", text]);
        },
        sInfoSwitch: 0,
        sMedCount: 2,
        sNoSmall: 1,
        sPNFun: 1,
        sPSchannels: 1,
        sRewFun: 1,
        sShowPikon: 0,
        sStopPlay: 0,
        stbGetItem: () => "",
        stbGetLen: () => 600,
        stbGetPosTime: () => 125.9,
        stbIsPlaying: () => false,
        stbPlay(url) {
            calls.push(["play", url]);
            // This synchronous adapter fixture represents an already started backend.
            c.__ottClassicPlayback.command({ type: "playing" });
        },
        stbSetItem: (key, value) => (stored[key] = value),
        stbSetPosTime(value) {
            calls.push(["seek", value]);
        },
        stbStop() {
            calls.push(["stop"]);
        },
        stored,
        timers,
        video: null,
    };
    c.window = c;
    const context = vm.createContext(c);
    vm.runInContext(localizationCode, context);
    const initialPreferences = Object.fromEntries(
        Object.entries(c).filter(
            ([key]) => /^s[A-Z]/.test(key) || key === "parentPIN"
        )
    );
    c.storage = {
        del: (key) => delete stored[key],
        get: (key) => stored[key] ?? null,
        set: (key, value) => (stored[key] = String(value)),
        setI: (key, value) => (stored[key] = String(value)),
    };
    require("./helpers/pin-runtime.cjs")(context);
    vm.runInContext(settingsSource(), context);
    Object.assign(c, initialPreferences);
    c.OttPlayCore = require("./helpers/shared-core-runtime.cjs")(context);
    vm.runInContext(
        sourceFunctions("src/utils/helpers.ts", [
            "metadataText",
            "metadataImageUrl",
            "metadataCssUrl",
            "metadataHtml",
            "hasTmdbService",
            "formatTwoDigits",
        ]) +
            sourceFunctions("src/channels/index.ts", [
                "rememberMediaView",
                "cancelMediaLoad",
                "requestMediaList",
                "mediaBack",
                "mediaKeyHandler",
                "addToMedFavorites",
                "selectMedia",
                "showMediaList",
                "getMediaDescr",
                "searchMedia",
                "setCurrent",
            ]) +
            sourceFunctions("src/core/index.ts", ["updateCoreVideoInfo"]) +
            sourceFunctions("src/ui/index.ts", [
                "mediaPlaybackControls",
                "updateMediaPlaybackControls",
                "showMediaList1",
                "mediaList",
                "showSelectBox",
                "updateMediaInfo",
                "finiteProgrammeClock",
                "updateChannelInfo",
                "virtualTimeshiftProg",
                "initBackgroundIntervals",
                "_t2",
            ]) +
            sourceFunctions("src/index.ts", ["_playMedia", "_playChannel"]),
        context
    );
    c.__ottRenderMedia = c.showMediaList1;
    c.__ottUpdateMediaControls = c.updateMediaPlaybackControls;
    c.playMedia = c._playMedia;
    const catalogs = {
        "": [
            { stream_url: "movie.mp4", title: "Movie" },
            { playlist_url: "catalog.xml", title: "Folder" },
            {
                playlist_url: "search.xml?sort=name",
                search_on: true,
                title: "Search",
            },
            {
                playlist_url: "submenu",
                submenu: [{ stream_url: "sub.mp4", title: "Submovie" }],
                title: "Submenu",
            },
        ],
        "catalog.xml": [{ stream_url: "nested.mp4", title: "Nested movie" }],
    };
    c.catalogs = catalogs;
    c.getMediaArray = function (url, done) {
        assert.equal(
            typeof url,
            "string",
            "Provider receives a URL, not a callback in the first position"
        );
        assert.equal(
            typeof done,
            "function",
            "Provider receives its completion callback"
        );
        calls.push(["fetch", url]);
        c.mediaRecords = (catalogs[url] || []).map((item) => ({ ...item }));
        done(); // Real providers mutate mediaRecords and do not pass an array to the callback.
    };
    c.documentState = () =>
        JSON.parse(
            stored["mediaJournal.v1:" + c.__ottMedia.sourceId()] || "null"
        );
    return c;
}

module.exports = { fixture, sourceFunctions };

if (require.main === module) {
    // Generated labels retain provenance across cached frames and serialized journals.
    // Provider/user titles that happen to equal a translation remain literal.
    {
        const c = fixture(),
            dictionaries = {};
        for (const locale of ["russian", "english"])
            vm.runInNewContext(
                fs.readFileSync(
                    path.join(root, "locales", locale + ".js"),
                    "utf8"
                ),
                (dictionaries[locale] = {})
            );
        const language = (host, locale) => {
            host._ = (key) => dictionaries[locale].keyStrings[key] || key;
        };
        language(c, "russian");
        const title = c._("Untitled");
        const description =
            "<table><h2><center>" + title + "</center></h2></table>";
        const generated = {
            __ottMediaLabel: { heading: true, key: "Untitled", value: title },
            description,
            stream_url: "unnamed.mp4",
            title,
        };
        c.catalogs[""] = [
            generated,
            { stream_url: "explicit.mp4", title },
            {
                __ottMediaLabel: generated.__ottMediaLabel,
                description: "User description",
                stream_url: "edited.mp4",
                title: "My chosen title",
            },
            {
                __ottMediaLabel: {
                    key: "Untitled folder",
                    value: c._("Untitled folder"),
                },
                playlist_url: "unnamed-folder",
                title: c._("Untitled folder"),
            },
        ];
        c.catalogs["unnamed-folder"] = [
            { stream_url: "child.mp4", title: "Child" },
        ];
        const provider = c.getMediaArray,
            rootTitle = c._("Media Library");
        c.getMediaArray = (url, done) => {
            c.mediaName =
                url === "unnamed-folder" ? c.catalogs[""][3].title : rootTitle;
            provider(url, done);
        };
        c.mediaList(null);
        const identity = c.__ottMedia.snapshot().frame.items[0].ref.itemId;
        c.__ottMedia.favorite(c.listArray[0]);
        const saved = c.documentState().favorites[0].payload;
        assert.equal(saved.__ottMediaLabel.key, "Untitled");
        const requests = c.calls.filter((call) => call[0] === "fetch").length;
        language(c, "english");
        c.mediaList(null);
        assert.equal(
            c.calls.filter((call) => call[0] === "fetch").length,
            requests
        );
        assert.equal(
            c.__ottMedia.snapshot().frame.items[0].ref.itemId,
            identity
        );
        assert(c.getListItemFn(c.listArray[0], 0).includes("Untitled"));
        assert(c.getMediaDescr(c.listArray[0]).includes("Untitled"));
        assert(!c.getMediaDescr(c.listArray[0]).includes(title));
        assert.equal(c.__ottMedia.title(c.listArray[1]), title);
        assert.equal(c.__ottMedia.title(c.listArray[2]), "My chosen title");
        assert.equal(c.getMediaDescr(c.listArray[2]), "User description");
        const malformed = {
            __ottMediaLabel: { heading: true, key: "Untitled", value: 42 },
            description: "User description",
            title: 42,
        };
        assert.equal(c.__ottMedia.title(malformed), "42");
        assert.equal(c.getMediaDescr(malformed), "User description");
        assert.equal(c.__ottMedia.description(generated, 42), 42);
        for (const route of ["history", "favorites"])
            assert.equal(
                c.__ottMedia.title(
                    c.listArray.find((item) => item.__ottMediaRoute === route)
                ),
                c._(
                    route === "history"
                        ? "History of watched movies"
                        : "Favorites"
                )
            );
        assert.equal(c.__ottMedia.title(c.listArray.at(-1)), "Filter: ");
        c.selectMedia(3);
        assert.equal(c.mediaName, "Untitled folder");
        language(c, "russian");
        c.mediaList(null);
        assert.equal(c.mediaName, c._("Untitled folder"));
        c.mediaKeyHandler(c.keys.RETURN);
        c.__ottMedia.filter();
        c.editvar = c._("Untitled");
        c.setEdit();
        assert.equal(c.listArray.filter((item) => item.stream_url).length, 2);
        language(c, "english");
        c.__ottMedia.filter();
        c.editvar = "Untitled";
        c.setEdit();
        assert.deepEqual(
            Array.from(
                c.listArray.filter((item) => item.stream_url),
                (item) => item.stream_url
            ),
            ["unnamed.mp4"]
        );
        c._playMedia(c.listArray[0]);
        assert.equal(c.elements["#channel_name"].textContent, rootTitle);
        assert.equal(c.elements["#programm_name"].textContent, "Untitled");
        assert.equal(
            c.documentState().history[0].payload.__ottMediaLabel.key,
            "Untitled"
        );
        // A backup/restore-style JSON round trip retains provenance, without rewriting its source text.
        const restored = fixture();
        Object.assign(restored.stored, JSON.parse(JSON.stringify(c.stored)));
        language(restored, "english");
        restored.mediaList(-1);
        assert.equal(
            restored.__ottMedia.title(restored.listArray[0]),
            "Untitled"
        );
        assert.equal(restored.listArray[0].title, title);
        restored._playMedia(restored.listArray[0]);
        assert.equal(restored.elements["#channel_name"].textContent, rootTitle);
        assert.equal(
            restored.elements["#programm_name"].textContent,
            "Untitled"
        );
        assert.equal(restored.documentState().history[0].payload.title, title);
        // Newly loaded generated rows share an identity across UI languages.
        const reload = fixture();
        reload.catalogs[""] = [
            {
                ...generated,
                __ottMediaLabel: { key: "Untitled", value: "Untitled" },
                description:
                    "<table><h2><center>Untitled</center></h2></table>",
                title: "Untitled",
            },
        ];
        reload.mediaList(null);
        assert.equal(
            reload.__ottMedia.snapshot().frame.items[0].ref.itemId,
            identity
        );
    }
    // Startup resumes begin at the exact saved position, without the manual
    // minute rounding or confirmation, even while the decoder is loading.
    {
        const c = fixture();
        const prepare = c.__ottMedia.prepare;
        c.__ottMedia.prepare = (item, url) => ({
            ...prepare(item, url),
            resume: 12.375,
            resumeStartup: true,
        });
        c.stbPlay = (url, position) => {
            assert.equal(url, "startup.mp4");
            assert.equal(position, 12.375);
            assert.equal(c.__ottClassicPlayback.snapshot().position, 12.375);
            assert.equal(c.documentState().history[0].position, 12.375);
            assert.equal(c.__ottClassicPlayback.snapshot().phase, "loading");
        };
        c._playMedia(
            { id: 73, stream_url: "startup.mp4", title: "Saved" },
            true
        );
        assert(!c.calls.some((call) => call[0] === "confirm"));
        vm.runInContext(sourceFunctions("src/index.ts", ["body_onUnload"]), c);
        c.body_onUnload();
        assert.equal(
            c.documentState().history[0].position,
            12.375,
            "Closing during decoder startup retains the resume position"
        );
    }
    // Tauri's explicit Exit command checkpoints synchronously before Rust
    // terminates the process, which need not dispatch browser unload events.
    {
        const c = fixture();
        c._playMedia({ id: 74, stream_url: "exit.mp4", title: "Closing" });
        c.stbGetPosTime = () => 184.875;
        vm.runInContext(sourceFunctions("src/index.ts", ["body_onUnload"]), c);
        const source = fs.readFileSync(path.join(root, "src/index.ts"), "utf8");
        const ast = ts.createSourceFile(
            "index.ts",
            source,
            ts.ScriptTarget.Latest,
            true
        );
        const block = ast.statements.find(
            (node) =>
                ts.isIfStatement(node) &&
                node.getText(ast).includes("window.stbExit = function") &&
                node.getText(ast).includes('"exit_app"')
        );
        assert(block);
        let exits = 0;
        c.__TAURI__ = {};
        c.tauriInvoke = (command) => {
            assert.equal(command, "exit_app");
            assert.equal(c.documentState().history[0].position, 184.875);
            exits++;
            return { catch() {} };
        };
        vm.runInContext(
            ts.transpileModule(block.getText(ast), {
                compilerOptions: { target: ts.ScriptTarget.ES5 },
            }).outputText,
            c
        );
        c.stbExit();
        assert.equal(exits, 1);
    }
    // Playback controls remain separate from selectable metadata rows.
    {
        const c = fixture();
        c.mediaList(null);
        let shuffled = 0;
        let toggled = 0;
        let repeated = 0;
        c.__ottMedia.shufflePlay = () => shuffled++;
        c.__ottMedia.toggleShuffle = () => toggled++;
        c.__ottMedia.cycleRepeat = () => repeated++;
        assert.equal(c.mediaKeyHandler(c.keys.N5), true);
        assert.equal(c.mediaKeyHandler(c.keys.PLAY), true);
        assert.equal(c.mediaKeyHandler(c.keys.N9), true);
        assert.equal(shuffled, 1);
        assert.equal(toggled, 1);
        assert.equal(repeated, 1);
        const view = c.__ottMedia.snapshot();
        view.canShuffle = true;
        view.canRepeat = true;
        view.repeat = "one";
        c.showMediaList1(view);
        c.detailListActionFn();
        assert(c.elements["#listDetail"].innerHTML.includes("Shuffle: Off"));
        assert(c.elements["#listDetail"].innerHTML.includes("Repeat: One"));
        assert(c.getListItemFn({ title: "" }, 0).includes("Untitled"));
        view.canShuffle = false;
        c.showMediaList1(view);
        c.detailListActionFn();
        assert(!c.elements["#listDetail"].innerHTML.includes("Shuffle: Off"));
        assert(c.elements["#listDetail"].innerHTML.includes("Repeat: One"));
    }
    // Detail debounce must retain toolbar focus and never restore obsolete modes.
    {
        const c = fixture();
        const dom = new JSDOM(
            '<div id="listDetail"></div><div id="listCaption"></div><div id="listPodval"></div>'
        );
        c.document = dom.window.document;
        vm.runInContext(
            sourceFunctions("src/ui/index.ts", ["renderButtonHint"]),
            c
        );
        const port = c.__ottClassicScreenPort;
        let renders = 0;
        c.showPage = () => {
            renders++;
            port.commitList();
        };
        c.mediaList(null);
        const detail = c.document.getElementById("listDetail");
        const controls = detail.firstChild;
        const repeat = c.document.getElementById("mediaRepeatControl");
        repeat.focus();
        c.detailListActionFn();
        assert.equal(c.document.activeElement, repeat);
        assert.equal(detail.firstChild, controls);
        const owner = port.listOwner();
        const before = renders;
        c.__ottMedia.cycleRepeat();
        assert.equal(
            renders,
            before,
            "A mode change does not replace the list"
        );
        assert.equal(port.listOwner(), owner);
        assert.equal(c.document.activeElement.id, "mediaRepeatControl");
        assert.equal(
            c.document.activeElement.getAttribute("data-state"),
            "one"
        );
        const view = c.__ottMedia.snapshot();
        view.shuffle = "loading";
        c.showMediaList1(view);
        const lateDetail = c.detailListActionFn;
        const overlay = port.openOverlay("editor", () => {});
        const projection = c.listArray;
        const editorRenders = renders;
        c.updateMediaPlaybackControls({ repeat: "one", shuffle: "off" });
        lateDetail();
        assert.equal(renders, editorRenders);
        assert.equal(c.listArray, projection);
        assert(overlay.active() && overlay.foreground());
        assert.equal(
            c.document
                .getElementById("mediaShuffleControl")
                .getAttribute("data-state"),
            "off",
            "An old details closure cannot restore Loading"
        );
        port.close("editor");
        assert.equal(
            c.document
                .getElementById("mediaShuffleControl")
                .getAttribute("aria-busy"),
            "false",
            "Returning from the editor exposes the settled mode immediately"
        );
        dom.window.close();
    }
    // The filter is reachable by remote shortcut and its active query stays visible.
    {
        const c = fixture();
        c.mediaList(null);
        let opened = 0;
        c.__ottMedia.filter = () => opened++;
        assert.equal(c.mediaKeyHandler(c.keys.BLUE), true);
        assert.equal(opened, 1);
        assert(c.elements["#listPodval"].innerHTML.includes("Filter"));
        const view = c.__ottMedia.snapshot();
        view.filter = "три кот <tag>";
        c.showMediaList1(view);
        assert(
            c.elements["#listCaption"].textContent.includes(
                "Filter: три кот <tag>"
            ),
            "The caption uses plain text for the active substring"
        );
        view.frame.route.kind = "variants";
        view.filter = "";
        c.showMediaList1(view);
        assert(!c.elements["#listPodval"].innerHTML.includes("Filter"));
        let tmdb = 0;
        c.hasTmdbService = () => true;
        c.TMDb = { search: () => tmdb++ };
        c.listArray = [{ __ottMediaFilter: true, title: "Filter" }];
        c.selIndex = 0;
        assert.equal(c.mediaKeyHandler(c.keys.YELLOW), true);
        assert.equal(tmdb, 0, "The filter control is not a TMDb movie query");
        c.listArray = [{ title: "Film" }];
        c.mediaKeyHandler(c.keys.YELLOW);
        assert.equal(tmdb, 1);
    }
    // Favorites hint must hide when the filtered list is only the Filter control.
    {
        const c = fixture();
        c.sFavorites = 0;
        const filterRow = { __ottMediaFilter: true, title: "Filter" };
        const movie = { stream_url: "m.mp4", title: "Movie" };
        const view = {
            filter: "nomatch",
            frame: {
                items: [{ payload: filterRow }],
                route: { kind: "catalog", target: "", title: "" },
                selected: 0,
            },
            frames: [{}, {}],
            revision: 1,
        };
        c.showMediaList1(view);
        assert(
            !c.elements["#listPodval"].innerHTML.includes("Add to favorites"),
            "Favorites hint hidden when only the Filter control remains"
        );
        view.frame.items = [{ payload: filterRow }, { payload: movie }];
        c.showMediaList1(view);
        assert(
            c.elements["#listPodval"].innerHTML.includes("Add to favorites"),
            "Favorites hint remains when a favoriteable media row is present"
        );
    }
    // Finite media shares the default current/next programme layout on every provider.
    for (const provider of ["offline", "plex", "vportal"]) {
        const c = fixture();
        c.__ottActiveProviderDriver = { id: provider };
        c.playType = -1e11;
        const startedAt = new Date(2026, 9, 20, 4, 11, 52).getTime() / 1000;
        let programme = {
            collection: "Collection <one>",
            duration: 70,
            nextStartedAt: startedAt + 70,
            nextTitle: "Next & last.mkv",
            position: 10,
            startedAt,
            title: "Current <file>.mp4",
        };
        c.__ottClassicPlayback.programme = () => programme;
        c.updateMediaInfo();
        assert.equal(
            c.elements["#channel_name"].textContent,
            "Collection <one>"
        );
        assert.equal(
            c.elements["#programm_name"].textContent,
            "Current <file>.mp4"
        );
        assert.equal(
            c.elements["#programm_name2"].textContent,
            "Current <file>.mp4"
        );
        assert.equal(
            c.elements["#nprogramm_name"].textContent,
            "Next & last.mkv"
        );
        assert.equal(c.elements["#begin_time"].textContent, "04:11:52");
        assert.equal(c.elements["#nbegin_time"].textContent, "04:13:02");
        assert.equal(c.elements["#end_time"].textContent, "+1");
        assert.equal(c.elements["#nend_time"].textContent, "");
        assert(
            Math.abs(
                parseFloat(c.elements["#progress"].style.width) - 100 / 7
            ) < 0.0001
        );
        programme.position = 60; // Seek/progress must not turn start into an invented clock.
        c.updateMediaInfo();
        assert.equal(c.elements["#begin_time"].textContent, "04:11:52");
        assert.equal(c.elements["#nbegin_time"].textContent, "04:13:02");
        programme.duration = 0;
        programme.nextStartedAt = null;
        c.updateMediaInfo();
        assert.equal(c.elements["#nbegin_time"].textContent, "");
        assert.equal(
            c.elements["#nprogramm_name"].textContent,
            "Next & last.mkv"
        );
        programme.startedAt = null;
        c.updateMediaInfo();
        assert.equal(c.elements["#begin_time"].textContent, "");
        programme.startedAt =
            new Date(2026, 9, 20, 23, 59, 40).getTime() / 1000;
        programme.duration = 70;
        programme.nextStartedAt = programme.startedAt + 70;
        c.updateMediaInfo();
        assert.equal(c.elements["#begin_time"].textContent, "23:59:40");
        assert.equal(c.elements["#nbegin_time"].textContent, "00:00:50");
        programme.nextTitle = "";
        programme.nextStartedAt = startedAt + 70;
        c.updateMediaInfo();
        assert.equal(c.elements["#nprogramm_name"].textContent, "");
        assert.equal(c.elements["#nbegin_time"].textContent, "");
        programme = null; // Source/selection was replaced while an old timer was queued.
        c.updateMediaInfo();
        for (const selector of [
            "#channel_name",
            "#programm_name",
            "#programm_name2",
            "#nprogramm_name",
            "#begin_time",
            "#nbegin_time",
            "#end_time",
        ])
            assert.equal(c.elements[selector].textContent, "", selector);
    }
    // Local files become finite playback before their first channel-info paint.
    // Only the owned file/source may supply the footer, including after EOF.
    {
        const c = fixture();
        c.__ottActiveProviderDriver = { id: "offline" };
        c.p_pref = "offline";
        let namespace = "offline:0";
        c.__ottOfflineProfiles = { namespace: () => namespace };
        c.channels = {
            1: {
                __ottMediaCollection: "Cartoons",
                channel_name: "First <clip>.mp4",
                rec: 0,
            },
            2: {
                __ottMediaCollection: "Cartoons",
                channel_name: "Second clip.mkv",
                rec: 0,
            },
        };
        c.__ottChannels = {
            capture: () => ({
                active: () => true,
                members: () => c.cats.All.slice(),
            }),
            group: () => "system:all",
            index: (id) => (id === "system:all" ? 0 : -1),
            select: () => true,
        };
        c.observeCurrentProgramme = () =>
            assert.fail("Local files have no EPG");
        c.getChannelUrl = () => "blob:local";
        c.ifParentalAccessChId = () => false;
        c.checkMedia = () => {};
        for (const selector of [
            "#channel_name",
            "#programm_name",
            "#programm_name2",
        ])
            c.$(selector).text("Previous channel");
        c._playChannel(0, 0);
        assert(c.playType < 0, "local channel is immediately finite");
        assert.equal(c.elements["#channel_name"].textContent, "Cartoons");
        for (const selector of ["#programm_name", "#programm_name2"])
            assert.equal(c.elements[selector].textContent, "First <clip>.mp4");

        c.cats.All = [1, 2];
        c._playChannel(0, 1);
        c.updateChannelInfo(1); // Delayed paint for the old file.
        assert.equal(
            c.elements["#programm_name"].textContent,
            "Second clip.mkv"
        );
        c.__ottClassicPlayback.command({ type: "stop" });
        c.updateChannelInfo(2);
        assert.equal(
            c.elements["#programm_name"].textContent,
            "Second clip.mkv"
        );

        // A new local profile may reuse the same channel ID before its load completes.
        namespace = "offline:1";
        c.elements["#programm_name"].textContent = "New profile pending";
        c.updateChannelInfo(2);
        assert.equal(c.elements["#programm_name"].textContent, "");
        c.channels[2].channel_name = "Other profile.mp4";
        c._playChannel(0, 1);
        assert.equal(
            c.elements["#programm_name"].textContent,
            "Other profile.mp4"
        );

        // A new provider may also reuse a numeric ID while its old callback remains queued.
        c.p_pref = "m3u";
        c.__ottActiveProviderDriver = { id: "m3u" };
        c.elements["#programm_name"].textContent = "New source";
        c.updateChannelInfo(2);
        assert.equal(c.elements["#programm_name"].textContent, "New source");
    }
    // An outstanding TV guide callback must not overwrite the playing movie's OSD.
    {
        const c = fixture();
        let guideReady;
        c.channels = {
            1: {
                channel_name: "Previous TV",
                logo: "https://example.invalid/tv.png",
            },
        };
        c.observeCurrentProgramme = (_id, callback) => {
            guideReady = callback;
            return false;
        };
        c.updateChannelInfo(1);
        assert.equal(c.elements["#channel_name"].textContent, "Previous TV");
        c._playMedia({
            id: 8,
            logo_30x30: "https://example.invalid/movie.png",
            stream_url: "movie.mp4",
            title: "Selected movie",
        });
        c.__ottClassicPlayback.command({
            duration: 600,
            position: 125.9,
            type: "position",
        });
        c.updateMediaInfo();
        const movieInfo = JSON.stringify(c.elements);
        guideReady(1);
        assert.equal(JSON.stringify(c.elements), movieInfo);
        assert.equal(c.elements["#channel_name"].textContent, "");
        assert.equal(
            c.elements["#programm_name"].textContent,
            "Selected movie"
        );
        assert.match(
            c.elements["#begin_time"].textContent,
            /^\d{2}:\d{2}:\d{2}$/
        );
        assert.equal(c.elements["#end_time"].textContent, "+8");

        // Changing mode before rendering restores the previous channel on return.
        c.ifParentalAccessChId = () => false;
        c.getChannelUrl = () => "live.m3u8";
        c.checkMedia = () => {};
        c._playChannel(0, 0);
        assert.equal(c.playType, 0);
        assert.equal(c.elements["#channel_name"].textContent, "Previous TV");
        assert.equal(
            c.elements["#picon"].style.backgroundImage,
            'url("https://example.invalid/tv.png")'
        );
        assert.equal(c.elements["#channel_number"].innerHTML, "1");
    }
    // Root, folder, owned Back, local favorites/history, inline submenu.
    {
        const c = fixture();
        c.mediaList(null);
        assert.equal(c.listArray[1].title, "Folder");
        assert(c.listArray.some((item) => item.__ottMediaRoute === "history"));
        c.selectMedia(1);
        assert.equal(c.listArray[0].title, "Nested movie");
        c.mediaKeyHandler(c.keys.GREEN);
        assert.equal(
            c.documentState().favorites[0].payload.stream_url,
            "nested.mp4"
        );
        const fetched = c.calls.filter((call) => call[0] === "fetch").length;
        c.mediaKeyHandler(c.keys.RETURN);
        assert.equal(c.selIndex, 1);
        assert.equal(
            c.calls.filter((call) => call[0] === "fetch").length,
            fetched,
            "Back restores owned parent without another request"
        );
        c.selectMedia(
            c.listArray.findIndex(
                (item) => item.__ottMediaRoute === "favorites"
            )
        );
        assert.equal(c.listArray[0].title, "Nested movie");
        c.mediaKeyHandler(c.keys.GREEN);
        assert.equal(c.listArray.length, 1);
        assert.equal(c.listArray[0].__ottMediaFilter, true);
        assert.equal(c.documentState().favorites.length, 0);
        c.mediaKeyHandler(c.keys.RETURN);
        c.selIndex = 3;
        c.selectMedia();
        assert.equal(c.listArray[0].title, "Submovie");
        c.mediaKeyHandler(c.keys.RETURN);
        assert.equal(c.selIndex, 3);
    }
    // Search and PIN are captured intents; replacing navigation revokes old approvals.
    {
        const c = fixture();
        c.catalogs[""] = [
            { adult: 1, id: 9, stream_url: "locked.mp4", title: "Locked" },
            {
                playlist_url: "search.xml?sort=name",
                search_on: 1,
                title: "Search",
            },
        ];
        c.mediaList(null);
        c.selectMedia(1);
        c.editvar = "a & b";
        c.setEdit();
        assert(
            c.calls.some(
                (call) =>
                    call[0] === "fetch" &&
                    call[1] === "search.xml?sort=name&search=a%20%26%20b"
            )
        );
        c.mediaKeyHandler(c.keys.RETURN);
        c.selectMedia(0);
        assert.equal(typeof c.unlock, "function");
        const obsolete = c.unlock;
        c.mediaList("catalog.xml");
        c.parentAccess = true;
        obsolete();
        assert(!c.calls.some((call) => call[0] === "play"));
        c.mediaKeyHandler(c.keys.RETURN);
        c.selectMedia(0);
        assert(
            c.calls.some(
                (call) => call[0] === "play" && call[1] === "locked.mp4"
            )
        );
        assert.equal(
            c.getMediaDescr({ description: () => "Lazy description" }),
            "Lazy description"
        );
    }
    // Late providers may mutate their globals, but cannot replace an accepted parent/view.
    {
        const c = fixture(),
            pending = [];
        c.getMediaArray = (route, done) => pending.push({ done, route });
        const complete = (index, title, records) => {
            c.mediaName = title;
            c.mediaRecords = records;
            pending[index].done();
        };
        c.mediaList(null);
        complete(0, "Root", [{ playlist_url: "folder", title: "Folder" }]);
        c.selectMedia(0);
        c.mediaKeyHandler(c.keys.RETURN);
        const renders = c.calls.filter((call) => call[0] === "render").length;
        complete(1, "Late child", [{ stream_url: "stale", title: "Stale" }]);
        assert.equal(c.listArray[0].title, "Folder");
        assert.equal(c.mediaName, "Root");
        assert.equal(
            c.calls.filter((call) => call[0] === "render").length,
            renders
        );
        c.selectMedia(0);
        c.cancelMediaLoad();
        complete(2, "Closed", [{ stream_url: "closed", title: "Closed" }]);
        assert.equal(c.listArray[0].title, "Folder");
        c.getMediaArray = (_route, done) => {
            c.mediaRecords = [
                { id: 2, stream_url: "new", title: "New provider" },
            ];
            done();
        };
        c.mediaList(null);
        complete(2, "Old provider", [{ stream_url: "old", title: "Old" }]);
        assert.equal(c.listArray[0].title, "New provider");
    }
    // Search from a disposed source must not query a replacement provider.
    {
        const c = fixture();
        c.mediaList(null);
        c.selectMedia(2);
        let fetched = false;
        c.getMediaArray = () => {
            fetched = true;
        };
        c.editvar = "movie";
        c.setEdit();
        assert.equal(fetched, false);
    }
    // Actual _playMedia consumer uses owned identity and stored positions, never mutable history[0].
    {
        const c = fixture();
        const first = { id: 1, stream_url: "first.mp4", title: "First" };
        c._playMedia(first);
        c.setCurrent(0, -1);
        assert.equal(c.documentState().history[0].position, 125.9);
        c._playMedia({ id: 2, stream_url: "second.mp4", title: "Second" });
        c._playMedia({ ...first, stream_url: "renewed.mp4" });
        assert.equal(typeof c.confirm, "function");
        const oldConfirm = c.confirm;
        c.confirm();
        assert.deepEqual(c.calls.at(-1), ["seek", 120]);
        c.medHistory.unshift({
            current: 999,
            stream_url: "injected.mp4",
            title: "Injected",
        });
        assert.equal(
            c.__ottClassicPlayback.snapshot().target.channelId,
            "provider:1"
        );
        c._playMedia({ id: 3, stream_url: "other.mp4", title: "Other" });
        oldConfirm();
        assert.equal(c.calls.filter((call) => call[0] === "seek").length, 1);
        c.sMedCount = 0;
        c._playMedia({
            id: 4,
            stream_url: "fourth.mp4",
            title: "Disabled history",
        });
        assert.equal(c.documentState().history.length, 0);
        c.__ottClassicPlayback.command({
            duration: 600,
            position: 125.9,
            type: "position",
        });
        c.updateMediaInfo();
        const startClock = c.elements["#begin_time"].textContent;
        assert.match(startClock, /^\d{2}:\d{2}:\d{2}$/);
        assert.equal(c.elements["#end_time"].textContent, "+8");
        c.initBackgroundIntervals();
        c.elements["#begin_time"].textContent = "";
        c.timers.at(-2)();
        assert.equal(c.elements["#begin_time"].textContent, startClock);
        assert.equal(first.stream_url, "first.mp4");
    }
    // VOD, including Plex, uses the actual owned dialog to resume after ten seconds.
    for (const answer of ["timeout", "no", "stopped", "replacement"]) {
        const c = fixture();
        const pending = [];
        c.strENTER = "Enter";
        c.strRETURN = "Back";
        c.setTimeout = (callback, delay) => {
            pending.push({ callback, delay });
            return pending.length;
        };
        c.clearTimeout = (id) => {
            if (pending[id - 1]) pending[id - 1].cancelled = true;
        };
        vm.runInContext(
            localizationRuntime() +
                sourceFunctions("src/ui/index.ts", [
                    "confirmBox",
                    "localizedTextHtml",
                ]),
            vm.createContext(c)
        );
        c.stored.medHistory = JSON.stringify([
            { current: 125, id: 7, stream_url: "old.mp4", title: "Film" },
        ]);
        c._playMedia({ id: 7, stream_url: "fresh.mp4", title: "Film" });
        const resumeTimers = pending.filter((timer) => timer.delay === 10000);
        assert.equal(resumeTimers.length, 1);
        const timer = resumeTimers[0];
        assert.equal(
            c.calls.some((call) => call[0] === "seek"),
            false
        );
        if (answer === "no") c.dialogBoxKeyHandler(c.keys.RETURN);
        if (answer === "stopped")
            c.__ottClassicPlayback.command({ type: "stop" });
        if (answer === "replacement")
            c._playMedia({
                id: 8,
                stream_url: "other.mp4",
                title: "Other film",
            });
        // Exercise even a callback already queued before cancellation.
        timer.callback();
        const seeks = c.calls.filter((call) => call[0] === "seek");
        assert.deepEqual(
            seeks,
            answer === "timeout" ? [["seek", 120]] : [],
            answer
        );
        assert.equal(
            timer.cancelled,
            true,
            "Dialog retirement clears the timer"
        );
        timer.callback();
        assert.equal(
            c.calls.filter((call) => call[0] === "seek").length,
            seeks.length
        );
    }
    // Legacy history imports once and resume uses provider item identity across URL rotation.
    {
        const c = fixture();
        c.stored.medHistory = JSON.stringify([
            { current: 125, id: 7, stream_url: "expired.mp4", title: "Film" },
        ]);
        c._playMedia({ id: 7, stream_url: () => "fresh.mp4", title: "Film" });
        c.confirm();
        assert.deepEqual(c.calls.at(-1), ["seek", 120]);
        assert.equal(c.documentState().history.length, 1);
        assert.equal(
            c.documentState().history[0].payload.stream_url,
            "fresh.mp4"
        );
        assert.equal(
            JSON.parse(c.stored.medHistory)[0].stream_url,
            "expired.mp4",
            "Importer never rewrites old storage"
        );
    }
    // Selector input remains compatible with mouse row codes and remote extremes.
    {
        const c = fixture(),
            selected = [];
        c.showSelectBox(
            0,
            ["First", "Second", "Third"],
            (index) => selected.push(index),
            -1
        );
        c.selectBoxKeyHandler(-99);
        c.selectBoxKeyHandler(c.keys.ENTER);
        assert.deepEqual(selected, [1]);
        c.showSelectBox(
            0,
            ["First", "Second", "Third"],
            (index) => selected.push(index),
            -1
        );
        c.selectBoxKeyHandler(c.keys.RIGHT);
        c.selectBoxKeyHandler(c.keys.ENTER);
        assert.deepEqual(selected, [1, 2]);
        assert.equal(c.selectBoxKeyHandler, null);
    }
    console.log(
        "PASS active VOD navigation, favorites, search/PIN, stale callbacks, identity/resume, progress and input"
    );
}
