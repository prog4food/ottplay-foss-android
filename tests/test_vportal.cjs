const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
const helpersSource = fs.readFileSync(
    path.join(root, "src/utils/helpers.ts"),
    "utf8"
);
const helpersAst = ts.createSourceFile(
    "helpers.ts",
    helpersSource,
    ts.ScriptTarget.Latest,
    true
);
const helperText = helpersAst.statements
    .filter(
        (node) =>
            ts.isFunctionDeclaration(node) &&
            ["metadataText", "metadataImageUrl"].includes(node.name?.text)
    )
    .map((node) => node.getText(helpersAst))
    .join("\n");
const compiled = ts.transpileModule(
    fs.readFileSync(path.join(root, "src/plugins/vportal.ts"), "utf8"),
    {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES5,
        },
    }
).outputText;
const helpers = { exports: {} };
vm.runInNewContext(
    ts.transpileModule(helperText, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES5,
        },
    }).outputText,
    helpers
);
const { localizationRuntime } = require("./helpers/localization-runtime.cjs");
const caseless = { exports: {} };
vm.runInNewContext(localizationRuntime(), caseless);
caseless.require = () => caseless;
vm.runInNewContext(
    ts.transpileModule(
        fs.readFileSync(path.join(root, "src/utils/caseless.ts"), "utf8"),
        {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES5,
            },
        }
    ).outputText,
    caseless
);
const link = "portal::[key:fixture-private-key]http://portal.example/api/v1/";

function fixture(overrides = {}, options = {}, hooks = {}) {
    const requests = [],
        alerts = [],
        played = [],
        dom = {};
    let active = true,
        client,
        selected,
        stopped = 0;
    const w = {
        _: (text) => text,
        _mediaLoadState: {},
        _playMedia(item) {
            client.cancel();
            played.push(item);
        },
        alert: (text) => alerts.push(text),
        closeList() {
            client.cancel();
            w._mediaLoadState = {};
        },
        host: "https://ott.example",
        keys: { ENTER: 4, EXIT: 2, RETURN: 1, STOP: 3 },
        medHistory: [],
        mediaName: "",
        mediaRecords: [],
        showSelectBox(index, labels, done, timeout) {
            assert.equal(
                timeout,
                -1,
                "Quality waits for explicit confirmation"
            );
            w.closeList();
            selected = { done, index, labels };
            w.selectBoxKeyHandler = (code) => {
                if (code === w.keys.ENTER) done(selected.index);
                return true;
            };
        },
        sPageSize: 30,
        stbStop() {
            stopped++;
            client.cancel();
        },
        ...overrides,
    };
    w.$ = (selector) => {
        dom[selector] ||= { text: "", visible: false };
        return {
            hide() {
                dom[selector].visible = false;
                if (hooks.hide) hooks.hide(selector);
                return this;
            },
            html(text) {
                dom[selector].text = text;
                return this;
            },
            show() {
                dom[selector].visible = true;
                return this;
            },
        };
    };
    w.$.ajax = (options) => {
        const request = {
            abort() {
                this.aborted = true;
                options.error({}, "abort");
                options.complete();
            },
            fail() {
                options.error({ responseText: "fixture-private-key" }, "error");
                options.complete();
            },
            options,
            receive(value) {
                options.success(value);
                options.complete();
            },
        };
        requests.push(request);
        return request;
    };
    const context = {
        exports: {},
        require: (name) =>
            name.includes("caseless") ? caseless.exports : helpers.exports,
        window: w,
    };
    vm.runInNewContext(compiled, context);
    client = context.exports.createVPortalClient(link, {
        isCurrent: () => active,
        title: "Fixture Library",
        ...options,
    });
    return {
        alerts,
        client,
        dom,
        parse: context.exports.parseVPortalLink,
        played,
        requests,
        selection: () => selected,
        setActive(value) {
            active = value;
        },
        stopped: () => stopped,
        w,
    };
}

{
    const f = fixture();
    assert.equal(f.parse(link).url, "http://portal.example/api/v1/");
    assert.equal(
        f.parse(" portal::%5Bkey:abc%5Dhttps://portal.example/api/%5Bid%5D/ ")
            .url,
        "https://portal.example/api/%5Bid%5D/"
    );
    for (const invalid of [
        "portal:[key:x]https://portal.example/api/",
        "portal::[key:]https://portal.example/api/",
        "portal::[key:x]file:///api/",
        "portal::[key:x]https://user:pass@portal.example/",
        "portal::[key:x]https://portal.example/#fragment",
        "portal::[key:x]https://portal.example/ trailing",
        "portal::[key:x\u0000]https://portal.example/",
        "portal::[key:x][https://portal.example/]",
        null,
    ])
        assert.equal(f.parse(invalid), null);
}

{
    const f = fixture();
    let completed = 0;
    f.client.load("", () => completed++);
    assert.equal(completed, 0, "Root request stays asynchronous");
    const request = f.requests[0];
    assert.equal(request.options.url, "https://ott.example/vportal/api");
    assert.equal(request.options.async, undefined);
    assert.equal(
        request.options.contentType,
        "application/json; charset=UTF-8"
    );
    assert.deepEqual(JSON.parse(request.options.data), {
        params: { app: "ott-play", key: "fixture-private-key", limit: 300 },
        url: "http://portal.example/api/v1/",
    });
    request.receive({
        controls: {
            filters: [
                {
                    items: [{ request: { year: 2026 }, title: "2026" }],
                    title: "Year",
                },
            ],
            search: true,
        },
        items: [
            {
                request: { cmd: "category", id: 4 },
                title: "Movies",
                type: "category",
            },
            {
                request: { cmd: "series", id: 5 },
                title: "Show",
                type: "multistream",
            },
            {
                description: "<img src=x onerror=bad()>",
                img: "javascript:alert(1)",
                request: { cmd: "play", id: 6 },
                title: "<script>bad</script>",
                type: "stream",
            },
            { type: "next" },
        ],
        type: "videoportal",
    });
    assert.equal(completed, 1);
    assert.equal(f.w.mediaName, "Fixture Library");
    assert.equal(f.w.mediaRecords.length, 6);
    const stream = f.w.mediaRecords[2];
    assert.equal(
        stream.__ottMediaSequence,
        undefined,
        "Movie catalogue rows are not episodes"
    );
    assert.equal(
        f.w.mediaRecords[1].__ottMediaSequence,
        undefined,
        "A series folder is not an episode"
    );
    assert.equal(
        stream.stream_url,
        "vportal:request",
        "Request-only entries must be selectable"
    );
    assert.equal(stream.logo_30x30, "");
    assert(!stream.description.includes("<script>"));
    assert(!stream.description.includes("<img"));
    const next = f.w.mediaRecords[3];
    assert.equal(next.playlist_url.request.offset, 3);
    const filters = f.w.mediaRecords[5];
    f.client.load(filters.playlist_url, () => completed++);
    assert.equal(
        f.requests.length,
        1,
        "Filter menus do not fetch a remote URL"
    );
    f.client.load(f.w.mediaRecords[0].playlist_url, () => completed++);
    assert.equal(f.w.mediaRecords[0].title, "2026");
    f.client.load(f.w.mediaRecords[0].playlist_url, () => completed++);
    assert.equal(JSON.parse(f.requests[1].options.data).params.year, 2026);
    f.requests[1].receive({ items: [], type: "category" });
    f.client.load(next.playlist_url, () => {});
    assert.equal(JSON.parse(f.requests[2].options.data).params.offset, 3);
}

{
    const f = fixture();
    f.client.load(
        { mediaName: "Series", request: { cmd: "series", fid: 10 } },
        () => {}
    );
    f.requests[0].receive({
        items: [
            {
                request: { cmd: "play", fid: 12 },
                title: "Episode 2",
                type: "stream",
            },
            {
                request: { cmd: "play", fid: 20 },
                title: "Episode 10",
                type: "stream",
            },
            {
                request: { cmd: "season", fid: 30 },
                title: "Other season",
                type: "category",
            },
        ],
        title: "Series",
        type: "multistream",
    });
    assert.deepEqual(
        Array.from(f.w.mediaRecords, (item) => item.title),
        ["Series - Episode 2", "Series - Episode 10", "Series - Other season"]
    );
    assert.deepEqual(
        Array.from(f.w.mediaRecords, (item) => item.__ottMediaSequence),
        [true, true, undefined]
    );
    assert.deepEqual(
        Array.from(f.w.mediaRecords.slice(0, 2), (item) => item.request.fid),
        [12, 20],
        "Episode order remains the provider's order"
    );
}

for (const native of [
    { __TAURI__: {} },
    { Capacitor: { isNativePlatform: () => true } },
]) {
    const f = fixture(native);
    f.client.load("", () => {});
    assert.equal(f.requests[0].options.url, "http://portal.example/api/v1/");
    assert.equal(f.requests[0].options.vportalRequest, true);
    assert.equal(
        JSON.parse(f.requests[0].options.data).key,
        "fixture-private-key"
    );
}
{
    const f = fixture({ Capacitor: { isNativePlatform: () => false } });
    f.client.load("", () => {});
    assert.equal(f.requests[0].options.url, "https://ott.example/vportal/api");
}

for (const query of [
    "Игра престолов",
    "a=b & c+d",
    "100%",
    "%D0%",
    "%ZZ + = &",
]) {
    const f = fixture();
    f.client.load("search?search=" + encodeURIComponent(query), () => {});
    assert.equal(JSON.parse(f.requests[0].options.data).params.query, query);
    f.requests[0].receive({ items: [], type: "category" });
    assert.equal(f.w.mediaName, "[" + query + "]");
}

{
    const f = fixture();
    const resolved = [];
    const episode = (fid) => ({
        request: { cmd: "play", fid },
        stream_url: "vportal:request",
        title: "Episode",
    });
    const reply = (
        index,
        fid,
        variants = { high: "high", low: "low" },
        defaultQuality = "low"
    ) => {
        const urls = Object.fromEntries(
            Object.entries(variants).map(([name, suffix]) => [
                name,
                "https://cdn.example/" + fid + "-" + suffix + ".mp4",
            ])
        );
        f.requests[index].receive({
            type: "stream",
            variants: urls,
            ...(defaultQuality
                ? {
                      url:
                          "https://cdn.example/" +
                          fid +
                          "-" +
                          defaultQuality +
                          ".mp4",
                  }
                : {}),
        });
    };
    f.client.resolve(episode(1), (item) => resolved.push(item));
    reply(0, 1);
    const picker = f.selection();
    picker.index = picker.labels.indexOf("high");
    f.w.selectBoxKeyHandler(f.w.keys.ENTER);
    assert.equal(resolved[0].stream_url, "https://cdn.example/1-high.mp4");

    f.client.resolve(episode(2), (item) => resolved.push(item), true);
    reply(1, 2);
    assert.strictEqual(
        f.selection(),
        picker,
        "Automatic episode resolution never reopens the quality picker"
    );
    assert.equal(
        resolved[1].stream_url,
        "https://cdn.example/2-high.mp4",
        "Automatic playback reuses the chosen quality label with a fresh URL"
    );
    assert.equal(JSON.parse(f.requests[1].options.data).params.fid, 2);

    f.client.resolve(episode(3), (item) => resolved.push(item), true);
    reply(2, 3, { low: "low", medium: "medium" }, "medium");
    assert.equal(
        resolved[2].stream_url,
        "https://cdn.example/3-medium.mp4",
        "An unavailable preferred quality falls back to the provider default"
    );
    f.client.resolve(episode(4), (item) => resolved.push(item), true);
    reply(3, 4);
    assert.equal(
        resolved[3].stream_url,
        "https://cdn.example/4-high.mp4",
        "A temporary fallback does not erase the user's preference"
    );

    f.client.resolve(episode(5), (item) => resolved.push(item));
    reply(4, 5);
    const cancelled = f.selection();
    assert.notStrictEqual(
        cancelled,
        picker,
        "Manual playback still offers explicit quality selection"
    );
    f.w.selectBoxKeyHandler(f.w.keys.RETURN);
    cancelled.done(cancelled.labels.indexOf("low"));
    assert.equal(
        resolved.length,
        4,
        "A stale quality callback cannot resolve playback"
    );
    f.client.resolve(episode(6), (item) => resolved.push(item), true);
    reply(5, 6);
    assert.equal(
        resolved[4].stream_url,
        "https://cdn.example/6-high.mp4",
        "A cancelled picker cannot change the remembered quality"
    );
    f.client.resolve(episode(7), (item) => resolved.push(item), true);
    reply(6, 7, { first: "first", second: "second" }, "");
    assert.equal(
        resolved[5].stream_url,
        "https://cdn.example/7-first.mp4",
        "Without a preferred or default URL, the first valid variant is used"
    );
    f.client.resolve(episode(8), (item) => resolved.push(item), true);
    f.client.cancel();
    reply(7, 8);
    assert.equal(
        resolved.length,
        6,
        "Cancelled automatic resolution cannot start a late episode"
    );
}

{
    const f = fixture();
    let done = 0;
    const callback = () => done++;
    callback.isCurrent = () => false;
    f.client.load("", callback);
    assert.equal(f.requests.length, 0);
    callback.isCurrent = () => true;
    f.client.load("", callback);
    callback.isCurrent = () => false;
    f.requests[0].fail();
    assert.equal(f.alerts.length, 0, "Stale errors stay silent");
    assert.equal(done, 0);
    f.client.load("", () => done++);
    f.client.load("search?search=new", () => done++);
    assert(f.requests[1].aborted);
    f.requests[2].receive({
        items: [
            {
                title: "New",
                type: "stream",
                url: "https://cdn.example/new.mp4",
            },
        ],
        type: "category",
    });
    f.requests[1].receive({
        items: [
            {
                title: "Old",
                type: "stream",
                url: "https://cdn.example/old.mp4",
            },
        ],
        type: "category",
    });
    assert.equal(f.w.mediaRecords[0].title, "New");
    assert.equal(done, 1);
    f.client.load("", () => done++);
    f.setActive(false);
    f.requests[3].receive({ items: [], type: "category" });
    assert.equal(done, 1, "Settings/provider changes invalidate callback");
    assert.equal(f.w.mediaRecords[0].title, "New");
}

{
    const f = fixture();
    const item = {
        request: { cmd: "play", id: 1 },
        stream_url: "vportal:request",
        title: "Film",
    };
    f.w.medHistory = [
        { ...item, current: 120, stream_url: "https://cdn.example/old.mp4" },
    ];
    f.client.play(item);
    assert.equal(f.played.length, 0);
    f.requests[0].receive({
        type: "stream",
        url: "https://cdn.example/low.mp4",
        variants: {
            high: "https://cdn.example/high.mp4",
            low: "https://cdn.example/low.mp4",
        },
    });
    assert.equal(f.played.length, 0, "Resolution waits for quality selection");
    f.selection().index = f.selection().labels.indexOf("high");
    f.w.selectBoxKeyHandler(f.w.keys.ENTER);
    assert.equal(f.played.length, 1);
    assert.equal(f.played[0].stream_url, "https://cdn.example/high.mp4");
    assert.notEqual(
        f.played[0],
        item,
        "Playback receives a copy so core can compare the history URL"
    );
    assert.equal(item.stream_url, "vportal:request");
    assert.equal(f.w.medHistory[0].current, 120);
    assert.equal(f.w.medHistory[0].stream_url, "https://cdn.example/old.mp4");
    f.client.play(item);
    f.w.dialogBoxKeyHandler(f.w.keys.STOP);
    f.requests[1].receive({
        type: "stream",
        url: "https://cdn.example/late.mp4",
    });
    assert.equal(f.played.length, 1, "Stop cancels delayed playback");
    assert.equal(f.stopped(), 1);
}

{
    const f = fixture();
    const item = {
        request: { app: "bad-override", cmd: "play", key: "bad-override" },
        stream_url: "https://cdn.example/expired.mp4",
        title: "Film",
    };
    f.client.play(item);
    assert.equal(
        JSON.parse(f.requests[0].options.data).params.key,
        "fixture-private-key"
    );
    assert.equal(JSON.parse(f.requests[0].options.data).params.app, "ott-play");
    f.requests[0].receive({
        description: "echo fixture-private-key",
        type: "error",
    });
    assert.equal(
        f.played.length,
        0,
        "A failed resolution must not use an expired URL"
    );
    assert.deepEqual(f.alerts, ["VPortal request failed"]);
    f.client.play(item);
    f.requests[1].receive({
        url: "https://cdn.example/low.mp4",
        variants: {
            high: "https://cdn.example/high.mp4",
            low: "https://cdn.example/low.mp4",
        },
    });
    const lateSelect = f.selection().done;
    f.w.selectBoxKeyHandler(f.w.keys.RETURN);
    lateSelect(1);
    assert.equal(
        f.played.length,
        0,
        "A departed quality picker cannot start playback"
    );
    f.client.dispose();
    f.client.play(item);
    f.client.load("", () => {
        throw new Error("Disposed client completed");
    });
    assert.equal(f.requests.length, 2);
}

{
    const f = fixture({}, { sourceId: "source-a" });
    f.client.load("", () => {});
    f.requests[0].receive({
        controls: {
            filters: [
                {
                    items: [{ request: { year: 2026 }, title: "2026" }],
                    title: "Year",
                },
            ],
        },
        items: [
            { request: { cmd: "play" }, title: "Film", type: "stream" },
            { request: { cmd: "folder" }, title: "Folder", type: "category" },
            { type: "next" },
        ],
        type: "videoportal",
    });
    assert.equal(f.w.mediaRecords[0].vportalSource, "source-a");
    assert.equal(f.w.mediaRecords[1].playlist_url.vportalSource, "source-a");
    assert.equal(f.w.mediaRecords[2].playlist_url.vportalSource, "source-a");
    f.client.load(f.w.mediaRecords[3].playlist_url, () => {});
    assert.equal(f.w.mediaRecords[0].playlist_url.vportalSource, "source-a");
    f.client.load(f.w.mediaRecords[0].playlist_url, () => {});
    assert.equal(f.w.mediaRecords[0].playlist_url.vportalSource, "source-a");
    f.client.play({
        request: { cmd: "play" },
        title: "Old",
        vportalSource: "source-b",
    });
    f.client.load(
        { request: { cmd: "folder" }, vportalSource: "source-b" },
        () => {}
    );
    f.client.play({ request: { cmd: "play" }, title: "Unmarked history" });
    assert.equal(
        f.requests.length,
        1,
        "Old portal source requests are never sent with a new key"
    );
    assert.equal(f.alerts.length, 3);
}

for (const automaticFirst of [true, false]) {
    const previous = () => {},
        editor = () => {},
        picker = () => {},
        f = fixture({
            dialogBoxKeyHandler: previous,
            editKey: editor,
            selectBoxKeyHandler: picker,
        });
    let catalogCalls = 0;
    const resolved = [];
    f.client.load("search?q=current", () => catalogCalls++);
    const catalog = f.requests[0],
        busy = f.w.dialogBoxKeyHandler;
    f.client.resolve(
        { request: { cmd: "play", fid: 2 }, title: "Next episode" },
        (item) => resolved.push(item),
        true
    );
    const automatic = f.requests[1];
    assert.equal(catalog.aborted, undefined);
    assert.strictEqual(f.w.dialogBoxKeyHandler, busy);
    assert.equal(f.dom["#dialogbox"].visible, true);
    const receiveCatalog = () =>
        catalog.receive({
            items: [
                {
                    title: "Current catalog",
                    type: "stream",
                    url: "https://cdn.example/catalog.mp4",
                },
            ],
            type: "category",
        });
    const receiveAutomatic = () =>
        automatic.receive({ url: "https://cdn.example/episode-2-fresh.mp4" });
    if (automaticFirst) {
        receiveAutomatic();
        assert.strictEqual(f.w.dialogBoxKeyHandler, busy);
        assert.equal(f.dom["#dialogbox"].visible, true);
        receiveCatalog();
    } else {
        receiveCatalog();
        receiveAutomatic();
    }
    assert.equal(catalogCalls, 1);
    assert.equal(f.w.mediaRecords[0].title, "Current catalog");
    assert.equal(resolved.length, 1);
    assert.equal(
        resolved[0].stream_url,
        "https://cdn.example/episode-2-fresh.mp4"
    );
    assert.strictEqual(f.w.dialogBoxKeyHandler, previous);
    assert.strictEqual(f.w.editKey, editor);
    assert.strictEqual(f.w.selectBoxKeyHandler, picker);
    assert.equal(f.dom["#dialogbox"].visible, false);
}

{
    const f = fixture();
    let catalogCalls = 0,
        automaticCalls = 0;
    f.client.load("", () => catalogCalls++);
    const busy = f.w.dialogBoxKeyHandler;
    const next = () =>
        f.client.resolve(
            { request: { cmd: "play", fid: 2 } },
            () => automaticCalls++,
            true
        );
    next();
    const replaced = f.requests[1];
    next();
    assert.equal(replaced.aborted, true);
    assert.equal(f.requests[0].aborted, undefined);
    assert.strictEqual(f.w.dialogBoxKeyHandler, busy);
    f.client.cancelAutomatic();
    assert.equal(f.requests[2].aborted, true);
    assert.equal(f.requests[0].aborted, undefined);
    for (const old of f.requests.slice(1)) {
        old.receive({ url: "https://cdn.example/stale.mp4" });
        old.fail();
    }
    assert.equal(automaticCalls, 0);
    assert.equal(f.alerts.length, 0);
    assert.strictEqual(f.w.dialogBoxKeyHandler, busy);
    assert.equal(f.dom["#dialogbox"].visible, true);
    f.requests[0].receive({ items: [], type: "category" });
    assert.equal(catalogCalls, 1);
}

for (const action of ["cancel", "dispose", "load", "play", "resolve"]) {
    const f = fixture();
    let retiredCalls = 0;
    f.client.load("", () => retiredCalls++);
    f.client.resolve(
        { request: { cmd: "play", fid: 2 } },
        () => retiredCalls++,
        true
    );
    const retired = f.requests.slice();
    if (action === "load") f.client.load("search?q=new", () => {});
    else if (action === "play" || action === "resolve")
        f.client[action]({ request: { cmd: "play", fid: 3 } }, () => {});
    else f.client[action]();
    for (const old of retired) {
        assert.equal(old.aborted, true, action + " aborts both lanes");
        old.receive({
            items: [],
            type: "category",
            url: "https://cdn.example/stale.mp4",
        });
        old.fail();
    }
    assert.equal(retiredCalls, 0);
    assert.equal(f.played.length, 0);
    assert.equal(f.alerts.length, 0);
    assert.equal(
        f.requests.length,
        action === "cancel" || action === "dispose" ? 2 : 3
    );
}

for (const sourceActive of [true, false]) {
    const f = fixture();
    let calls = 0;
    f.client.resolve({ request: { cmd: "play", fid: 2 } }, () => calls++, true);
    f.w._mediaLoadState = {};
    f.setActive(sourceActive);
    f.requests[0].receive({ url: "https://cdn.example/fresh.mp4" });
    assert.equal(
        calls,
        sourceActive ? 1 : 0,
        "Automatic playback follows source ownership, not the catalog marker"
    );
}

for (const failure of ["network", "provider", "url", "throw"]) {
    const editor = () => {},
        previous = () => {},
        toasts = [],
        f = fixture({
            dialogBoxKeyHandler: previous,
            editKey: editor,
            showShift: (text) => toasts.push(text),
        });
    f.client.load("", () => {});
    const busy = f.w.dialogBoxKeyHandler;
    if (failure === "throw")
        f.w.$.ajax = () => {
            throw Error("fixture-private-key");
        };
    const failures = [];
    f.client.resolve(
        { request: { cmd: "play", fid: 2 } },
        (item) => failures.push(item),
        true
    );
    if (failure === "network") f.requests[1].fail();
    else if (failure !== "throw")
        f.requests[1].receive({
            type: failure === "provider" ? "error" : "stream",
            url: "fixture-private-key",
        });
    assert.deepEqual(failures, [null], "A failed request completes its owner");
    assert.deepEqual(toasts, ["VPortal request failed"]);
    assert.equal(f.alerts.length, 0);
    assert.strictEqual(f.w.dialogBoxKeyHandler, busy);
    assert.strictEqual(f.w.editKey, editor);
    assert.equal(f.dom["#dialogbox"].visible, true);
    assert.equal(f.requests[0].aborted, undefined);
    f.requests[0].fail();
    assert.deepEqual(
        f.alerts,
        ["VPortal request failed"],
        "Manual errors stay visible"
    );
    assert.strictEqual(f.w.dialogBoxKeyHandler, previous);
}

{
    const f = fixture();
    f.client.resolve({ request: { cmd: "play" } }, () => {}, true);
    f.requests[0].fail();
    assert.equal(
        f.alerts.length,
        0,
        "Missing toast support never falls back to a modal"
    );
    assert.equal(f.dom["#dialogbox"], undefined);
}

// Resolution failures belong to the requesting playback, including the error UI.
for (const automatic of [false, true]) {
    for (const failure of [
        "network",
        "throw",
        "null",
        "provider",
        "url",
        "source",
        "item",
    ]) {
        const events = [];
        const f = fixture(
            {
                alert: () => events.push("alert"),
                showShift: () => events.push("shift"),
            },
            { sourceId: "current" }
        );
        const ajax = f.w.$.ajax;
        if (failure === "throw")
            f.w.$.ajax = () => {
                throw Error("fixture-private-key");
            };
        const done = (item) => events.push(item);
        done.beforeError = () => events.push("before");
        f.client.resolve(
            failure === "item"
                ? null
                : {
                      request: { cmd: "play", id: 1 },
                      vportalSource: failure === "source" ? "old" : "current",
                  },
            done,
            automatic
        );
        const request = f.requests[0];
        if (request) {
            if (failure === "network") request.fail();
            else
                request.receive(
                    failure === "null"
                        ? null
                        : {
                              type: failure === "provider" ? "error" : "stream",
                              url: "invalid",
                          }
                );
            request.fail();
            request.receive({ url: "https://cdn.example/late.mp4" });
        }
        assert.deepEqual(
            events,
            ["before", automatic ? "shift" : "alert", null],
            failure +
                " finishes once, retires owned loading before notifying, and never starts late media"
        );
        f.w.$.ajax = ajax;
        const retried = [];
        f.client.resolve(
            { request: { id: 1 }, vportalSource: "current" },
            (item) => retried.push(item),
            automatic
        );
        f.requests.at(-1).receive({ url: "https://cdn.example/retried.mp4" });
        assert.equal(retried.length, 1);
        assert.equal(retried[0].stream_url, "https://cdn.example/retried.mp4");
    }
    for (const invalidate of ["caller", "before", "notice"]) {
        const events = [];
        let active = true;
        const f = fixture({
            alert: notice,
            showShift: notice,
        });
        function notice() {
            events.push("notice");
            if (invalidate === "notice") active = false;
        }
        const done = () => events.push("done");
        done.isCurrent = () => active;
        done.beforeError = () => {
            events.push("before");
            if (invalidate === "before") active = false;
        };
        f.client.resolve({ request: { id: 1 } }, done, automatic);
        if (invalidate === "caller") active = false;
        f.requests[0].fail();
        assert.deepEqual(
            events,
            invalidate === "caller"
                ? []
                : invalidate === "before"
                  ? ["before"]
                  : ["before", "notice"],
            "retired completion cannot overwrite the next owner's error UI"
        );
    }
}

for (const trigger of ["foreground", "background"]) {
    const previous = () => {},
        f = fixture({ dialogBoxKeyHandler: previous });
    let newestCalls = 0,
        newestHandler;
    f.client.load("", () => assert.fail("Canceled catalog completed"));
    f.client.resolve(
        { request: { cmd: "play", fid: 2 } },
        () => assert.fail("Canceled automatic playback resolved"),
        true
    );
    const old = f.requests[trigger === "foreground" ? 0 : 1],
        abort = old.abort;
    old.abort = function () {
        abort.call(this);
        if (trigger === "foreground")
            f.client.resolve(
                { request: { cmd: "play", fid: 3 } },
                () => newestCalls++,
                true
            );
        else {
            f.client.load("search?q=newest", () => newestCalls++);
            newestHandler = f.w.dialogBoxKeyHandler;
        }
    };
    f.client.cancel();
    assert.equal(f.requests.length, 3);
    assert.equal(f.requests[0].aborted, true);
    assert.equal(f.requests[1].aborted, true);
    assert.equal(
        f.requests[2].aborted,
        undefined,
        "Global cancellation preserves newer work from either abort callback"
    );
    if (trigger === "background") {
        assert.strictEqual(f.w.dialogBoxKeyHandler, newestHandler);
        assert.equal(f.dom["#dialogbox"].visible, true);
    } else assert.strictEqual(f.w.dialogBoxKeyHandler, previous);
    f.requests[2].receive({
        items: [],
        type: "category",
        url: "https://cdn.example/newest.mp4",
    });
    assert.equal(newestCalls, 1);
    for (const retired of f.requests.slice(0, 2)) retired.fail();
    assert.equal(f.alerts.length, 0);
    assert.strictEqual(f.w.dialogBoxKeyHandler, previous);
}

{
    const f = fixture();
    let newestCalls = 0;
    const resolve = (fid, done) =>
        f.client.resolve({ request: { cmd: "play", fid } }, done, true);
    resolve(1, () => assert.fail("Old automatic request resolved"));
    const old = f.requests[0],
        abort = old.abort;
    old.abort = function () {
        abort.call(this);
        resolve(3, () => newestCalls++);
    };
    resolve(2, () => assert.fail("Superseded automatic request resolved"));
    assert.equal(
        f.requests.length,
        2,
        "Automatic replacement yields to abort reentry"
    );
    assert.equal(JSON.parse(f.requests[1].options.data).params.fid, 3);
    f.requests[1].receive({ url: "https://cdn.example/newest.mp4" });
    old.receive({ url: "https://cdn.example/stale.mp4" });
    assert.equal(newestCalls, 1);
}

for (const action of ["load", "play", "resolve", "cancel"]) {
    const previous = () => {},
        f = fixture({ dialogBoxKeyHandler: previous });
    let oldCalls = 0,
        middleCalls = 0,
        newestCalls = 0,
        newestHandler;
    f.client.load("", () => oldCalls++);
    const old = f.requests[0],
        abort = old.abort;
    old.abort = function () {
        abort.call(this);
        f.client.load("search?q=newest", () => newestCalls++);
        newestHandler = f.w.dialogBoxKeyHandler;
    };
    if (action === "load")
        f.client.load("search?q=middle", () => middleCalls++);
    else if (action === "cancel") f.client.cancel();
    else
        f.client[action](
            { request: { cmd: "play" }, title: "Retired" },
            () => middleCalls++
        );
    assert.equal(f.requests.length, 2, action + " must yield to abort reentry");
    assert.strictEqual(f.w.dialogBoxKeyHandler, newestHandler);
    assert.equal(f.dom["#dialogbox"].visible, true);
    f.requests[1].receive({ items: [], type: "category" });
    old.receive({ items: [], type: "category" });
    assert.equal(newestCalls, 1);
    assert.equal(oldCalls, 0);
    assert.equal(middleCalls, 0);
    assert.equal(f.played.length, 0);
    assert.strictEqual(f.w.dialogBoxKeyHandler, previous);
}

for (const trigger of ["#dialogbox", "#numprog"]) {
    let armed = false,
        newestCalls = 0,
        middleCalls = 0;
    const f = fixture(
        {},
        {},
        {
            hide(selector) {
                if (!armed || selector !== trigger) return;
                armed = false;
                f.client.load("search?q=newest", () => newestCalls++);
            },
        }
    );
    if (trigger === "#numprog") {
        f.client.play({ request: { cmd: "play" }, title: "Quality" });
        f.requests[0].receive({
            url: "https://cdn.example/low.mp4",
            variants: {
                high: "https://cdn.example/high.mp4",
                low: "https://cdn.example/low.mp4",
            },
        });
    } else f.client.load("", () => {});
    armed = true;
    f.client.load("search?q=middle", () => middleCalls++);
    assert.equal(
        f.requests.length,
        2,
        "DOM cleanup reentry owns the next request"
    );
    assert.equal(f.dom["#dialogbox"].visible, true);
    f.requests[1].receive({ items: [], type: "category" });
    assert.equal(newestCalls, 1);
    assert.equal(middleCalls, 0);
}

{
    const previous = () => {},
        f = fixture({ dialogBoxKeyHandler: previous });
    f.client.load("", () => assert.fail("Disposed load completed"));
    const old = f.requests[0],
        abort = old.abort;
    old.abort = function () {
        abort.call(this);
        f.client.load("search?q=newest", () => assert.fail("Revived load"));
        f.client.play({ request: { cmd: "play" }, title: "Revived play" });
    };
    f.client.dispose();
    assert.equal(f.requests.length, 1, "Abort cannot revive a disposed client");
    assert.strictEqual(f.w.dialogBoxKeyHandler, previous);
    assert.equal(f.dom["#dialogbox"].visible, false);
    old.receive({ items: [], type: "category" });
    const foreign = () => {};
    f.w.dialogBoxKeyHandler = foreign;
    f.w.selectBoxKeyHandler = foreign;
    f.client.cancel();
    assert.strictEqual(f.w.dialogBoxKeyHandler, foreign);
    assert.strictEqual(f.w.selectBoxKeyHandler, foreign);
}

{
    const profile = {
        version: 1,
        vportal: {
            routes: [
                {
                    path: "/vportal/provider-1",
                    upstream: "http://portal.example/api/v1/",
                },
            ],
        },
    };
    const f = fixture({ __OTTPLAY_HOSTED__: profile });
    f.client.load("", () => {});
    const request = f.requests[0].options;
    assert.equal(request.url, "/vportal/provider-1");
    assert.equal(request.type, "POST");
    assert.equal(request.contentType, "application/json; charset=UTF-8");
    assert.deepEqual(JSON.parse(request.data), {
        app: "ott-play",
        key: "fixture-private-key",
        limit: 300,
    });
    assert(!request.url.includes("fixture-private-key"));
    assert.equal(JSON.parse(request.data).url, undefined);
    assert.equal(JSON.parse(request.data).params, undefined);

    for (const invalid of [
        null,
        {},
        { ...profile, version: 2 },
        { version: 1, vportal: { routes: [] } },
        {
            version: 1,
            vportal: {
                routes: [
                    {
                        ...profile.vportal.routes[0],
                        upstream: "https://portal.example/api/v1/",
                    },
                ],
            },
        },
        ...[
            "//attacker.example",
            "https://attacker.example/api",
            "/vportal/provider-1?url=external",
            "/vportal/../api",
            "/vportal/provider-1/extra",
        ].map((path) => ({
            version: 1,
            vportal: { routes: [{ ...profile.vportal.routes[0], path }] },
        })),
        {
            version: 1,
            vportal: {
                routes: [profile.vportal.routes[0], profile.vportal.routes[0]],
            },
        },
    ]) {
        const rejected = fixture({ __OTTPLAY_HOSTED__: invalid });
        let completed = 0;
        rejected.client.load("", () => completed++);
        assert.equal(
            rejected.requests.length,
            0,
            "Invalid hosted route cannot fall back to another relay"
        );
        assert.equal(completed, 1);
        assert.equal(rejected.alerts.length, 1);
        assert(!rejected.alerts[0].includes("fixture-private-key"));
        assert.equal(rejected.dom["#dialogbox"].visible, false);
    }

    const native = fixture({ __OTTPLAY_HOSTED__: profile, __TAURI__: {} });
    native.client.load("", () => {});
    assert.equal(
        native.requests[0].options.url,
        "http://portal.example/api/v1/"
    );
    assert.equal(JSON.parse(native.requests[0].options.data).params, undefined);
}

// Incremental pages own a quiet transport lane, including while complete
// search collection and automatic playback are active.
{
    const f = fixture({ clearTimeout() {}, setTimeout: () => 1 });
    const target = {
        mediaName: "Current folder",
        request: { cmd: "browse", id: 3, offset: 300 },
    };
    let paged, resolved, collected;
    f.client.page(target, (result) => (paged = result));
    const page = f.requests.at(-1);
    f.client.resolve(
        { request: { cmd: "play", id: 8 } },
        (item) => (resolved = item),
        true
    );
    const playback = f.requests.at(-1);
    f.client.search("Found", (result) => (collected = result));
    const search = f.requests.at(-1);
    const before = JSON.stringify([
        f.w.mediaRecords,
        f.w.mediaName,
        f.w.dialogBoxKeyHandler,
    ]);
    page.receive({
        items: [
            {
                request: { cmd: "browse", id: 90 },
                title: "Next",
                type: "category",
            },
            {
                request: { cmd: "play", id: 10 },
                title: "Following",
                type: "stream",
            },
            { request: { offset: 600 }, type: "next" },
        ],
        type: "category",
    });
    playback.receive({ url: "https://cdn.example/fresh.mp4" });
    search.receive({
        items: [
            {
                request: { cmd: "play", id: 99 },
                title: "Found",
                type: "stream",
            },
        ],
        type: "category",
    });
    assert.equal(paged.items.length, 3);
    assert.equal(paged.items[0].__ottMediaNext, undefined);
    assert.equal(paged.items[2].__ottMediaNext, true);
    assert.equal(paged.items[2].playlist_url.request.offset, 600);
    assert.equal(paged.items[2].playlist_url.mediaName, "Current folder");
    assert.equal(resolved.stream_url, "https://cdn.example/fresh.mp4");
    assert.equal(collected.items.length, 1);
    assert(!page.aborted && !playback.aborted && !search.aborted);
    assert.equal(
        JSON.stringify([
            f.w.mediaRecords,
            f.w.mediaName,
            f.w.dialogBoxKeyHandler,
        ]),
        before
    );
    assert.deepEqual(f.alerts, []);
    assert.deepEqual(f.dom, {});
}

for (const action of ["cancel", "replace", "dispose", "pagehide", "retire"]) {
    const events = new Map();
    const f = fixture(
        {
            addEventListener: (name, callback) => events.set(name, callback),
            removeEventListener: (name) => events.delete(name),
        },
        { sourceId: "owned" }
    );
    const target = { request: { offset: 300 }, vportalSource: "owned" };
    let callbacks = 0;
    const cancel = f.client.page(target, () => callbacks++);
    const pending = f.requests[0];
    if (action === "cancel") cancel();
    if (action === "replace") f.client.page(target, () => {});
    if (action === "dispose") f.client.dispose();
    if (action === "pagehide") events.get("pagehide")();
    if (action === "retire") f.setActive(false);
    pending.receive({ items: [], type: "category" });
    pending.fail();
    assert.equal(callbacks, 0, action);
    if (action !== "retire") assert(pending.aborted, action);
    assert.deepEqual(f.alerts, []);
    assert(!f.dom["#dialogbox"]?.visible);
}

for (const response of [
    null,
    { error: "fixture-private-key", type: "error" },
    { items: "invalid", type: "category" },
]) {
    const f = fixture();
    const values = [];
    f.client.page({ request: { offset: 300 } }, (value) => values.push(value));
    if (response) f.requests[0].receive(response);
    else f.requests[0].fail();
    f.requests[0].receive({ items: [], type: "category" });
    assert.equal(values.length, 1);
    assert.equal(values[0].items.length, 0);
    assert(values[0].error);
    assert(!JSON.stringify(values).includes("fixture-private-key"));
    assert.deepEqual(f.alerts, []);
    assert.deepEqual(f.dom, {});
}

{
    const f = fixture({}, { sourceId: "owned" });
    let failed;
    f.client.page(
        { request: { offset: 1 }, vportalSource: "other" },
        (value) => (failed = value)
    );
    assert(failed.error);
    assert.equal(f.requests.length, 0);
    f.client.dispose();
    f.client.page({ request: {}, vportalSource: "owned" }, () =>
        assert.fail("disposed callback")
    );
    assert.equal(f.requests.length, 0);
}

{
    const f = fixture();
    f.client.page({ request: { offset: 300 } }, () => assert.fail("old page"));
    const old = f.requests[0];
    const abort = old.abort.bind(old);
    let latest;
    old.abort = () => {
        abort();
        f.client.page(
            { request: { offset: 900 } },
            (value) => (latest = value)
        );
    };
    f.client.page({ request: { offset: 600 } }, () =>
        assert.fail("interrupted page")
    );
    assert.equal(f.requests.length, 2);
    assert.equal(JSON.parse(f.requests[1].options.data).params.offset, 900);
    f.requests[1].receive({ items: [], type: "category" });
    assert.equal(latest.items.length, 0);
}

{
    const f = fixture();
    let sections;
    f.client.sections((value) => (sections = value));
    f.requests[0].receive({
        items: [
            { request: { cmd: "films" }, title: "Films", type: "category" },
            { request: { cmd: "series" }, title: "Series", type: "category" },
        ],
        type: "videoportal",
    });
    assert.equal(sections.items.length, 2);
    assert.equal(
        f.requests.length,
        1,
        "section picker does not scan descendants"
    );
    assert.equal(
        f.dom["#dialogbox"],
        undefined,
        "catalog fetching does not steal playback dialog"
    );
}
{
    const f = fixture({}, { sourceId: "owned" });
    const batches = [];
    f.client.playlist(
        [{ request: { cmd: "chosen" }, title: "Chosen" }],
        (items, complete, error) => batches.push({ complete, error, items })
    );
    assert.equal(JSON.parse(f.requests[0].options.data).params.cmd, "chosen");
    f.requests[0].receive({
        items: [
            { request: { cmd: "play", id: 1 }, title: "First", type: "stream" },
            {
                request: { cmd: "season" },
                title: "Season",
                type: "multistream",
            },
            { request: { offset: 2 }, type: "next" },
        ],
        type: "category",
    });
    assert.equal(batches.length, 1);
    assert.equal(batches[0].items.length, 1);
    assert.equal(
        batches[0].complete,
        false,
        "first playable is available before the season scan"
    );
    assert.equal(batches[0].items[0].vportalSource, "owned");
    f.requests[1].receive({
        items: [
            {
                request: { cmd: "play", id: 2 },
                title: "Episode",
                type: "stream",
            },
            {
                request: { cmd: "play", id: 1 },
                title: "Duplicate",
                type: "stream",
            },
        ],
        title: "Season",
        type: "multistream",
    });
    f.requests[2].receive({
        items: [
            {
                title: "Last",
                type: "stream",
                url: "https://stream.example/last.mp4",
            },
        ],
        type: "category",
    });
    assert.equal(batches.at(-1).complete, true);
    assert.deepEqual(
        Array.from(batches.at(-1).items, (x) => x.title),
        ["First", "Season - Episode", "Last"]
    );
    assert.deepEqual(
        Array.from(batches.at(-1).items, (x) => x.__ottMediaCollection),
        ["Chosen", "Season", "Chosen"],
        "collection follows the selected section and nested folder, not the profile or pagination label"
    );
    assert.equal(
        f.requests.length,
        3,
        "only the selected section and its children are fetched"
    );
    assert.equal(f.alerts.length, 0);
}
for (const providerId of ["episode-7", undefined]) {
    const shifts = [];
    const f = fixture(
        { showShift: (text) => shifts.push(text) },
        { sourceId: "direct-profile" }
    );
    const root = { request: { cmd: "season", id: 3 }, title: "Season" };
    const page = (signature) => ({
        items: [
            {
                id: providerId,
                title: "Episode",
                type: "stream",
                url: "https://cdn.example/episode.mp4?signature=" + signature,
            },
        ],
        type: "category",
    });
    let first;
    f.client.playlist([root], (items) => {
        first = items[0];
    });
    f.requests.at(-1).receive(page("expired"));
    let refreshed;
    f.client.playlist([root], (items) => {
        refreshed = items[0];
    });
    f.requests.at(-1).receive(page("new-catalog"));
    assert.equal(
        first.__ottPlaylistId,
        refreshed.__ottPlaylistId,
        "rotating direct URLs must not change the selected channel identity"
    );
    assert.deepEqual(
        first.__ottMediaRef,
        refreshed.__ottMediaRef,
        "the media resume journal keeps the same direct file identity"
    );
    assert(first.__ottMediaRef.itemId);
    for (const automatic of [true, false]) {
        for (const signature of ["selected", "repeat"]) {
            let played;
            const before = f.requests.length;
            f.client.resolve(
                first,
                (item) => {
                    played = item;
                },
                automatic
            );
            assert.equal(
                played,
                undefined,
                "cached direct access URLs must not play before re-resolution"
            );
            assert.equal(f.requests.length, before + 1);
            assert.equal(
                JSON.parse(f.requests.at(-1).options.data).params.cmd,
                "season"
            );
            f.requests.at(-1).receive(page(signature));
            assert.equal(
                played.stream_url,
                "https://cdn.example/episode.mp4?signature=" + signature
            );
            assert.deepEqual(played.__ottMediaRef, first.__ottMediaRef);
            assert.equal(first.stream_url, page("expired").items[0].url);
        }
        for (const failure of [
            "missing-origin",
            null,
            { items: [], type: "invalid" },
            { items: [], type: "category" },
        ]) {
            const alertsBefore = f.alerts.length;
            const shiftsBefore = shifts.length;
            const broken = { ...first };
            if (failure === "missing-origin") delete broken.__ottMediaOrigin;
            let played;
            f.client.resolve(
                broken,
                (item) => {
                    played = item;
                },
                automatic
            );
            if (failure !== "missing-origin")
                f.requests.at(-1).receive(failure);
            assert.equal(
                played,
                null,
                "a failed refresh completes without reusing the expired URL"
            );
            assert.equal(f.alerts.length, alertsBefore + (automatic ? 0 : 1));
            assert.equal(shifts.length, shiftsBefore + (automatic ? 1 : 0));
        }
    }
}
{
    const f = fixture();
    const batches = [];
    const cancel = f.client.playlist(
        [{ request: { cmd: "chosen" }, title: "Chosen" }],
        (items, complete, error) => batches.push({ complete, error, items })
    );
    f.requests[0].receive({
        items: [
            { request: { cmd: "play", id: 1 }, title: "First", type: "stream" },
            { request: { cmd: "slow" }, title: "Slow", type: "category" },
        ],
        type: "category",
    });
    cancel();
    assert.equal(f.requests[1].aborted, true);
    f.requests[1].receive({
        items: [{ request: { id: 2 }, title: "Late", type: "stream" }],
        type: "category",
    });
    assert.equal(batches.length, 1);
}
{
    const f = fixture();
    const batches = [];
    f.client.playlist(
        [{ request: { cmd: "chosen" }, title: "Chosen" }],
        (items, complete, error) => batches.push({ complete, error, items })
    );
    f.requests[0].receive({
        items: [
            { request: { cmd: "play", id: 1 }, title: "First", type: "stream" },
            { request: { cmd: "fail" }, title: "Fail", type: "category" },
        ],
        type: "category",
    });
    f.requests[1].fail();
    assert.equal(
        batches.at(-1).items.length,
        1,
        "failure keeps the usable partial catalog"
    );
    assert.equal(batches.at(-1).complete, true);
    assert(batches.at(-1).error);
    assert(!JSON.stringify(batches).includes("fixture-private-key"));
}
{
    const f = fixture();
    let finished = 0;
    f.client.playlist(
        [{ request: { cmd: "chosen" }, title: "Chosen" }],
        () => finished++
    );
    f.client.dispose();
    assert.equal(f.requests[0].aborted, true);
    f.requests[0].receive({ items: [], type: "category" });
    assert.equal(finished, 0);
}

{
    const f = fixture();
    const batches = [];
    f.client.playlist(
        [
            { request: { cmd: "chosen", id: 1 }, title: "First" },
            { request: { cmd: "chosen", id: 1 }, title: "Duplicate root" },
        ],
        (items, complete) => batches.push({ complete, items })
    );
    f.requests[0].receive({
        items: [
            {
                request: { cmd: "chosen", id: 1 },
                title: "Self",
                type: "category",
            },
            { request: { cmd: "play", id: 1 }, title: "One", type: "stream" },
        ],
        type: "category",
    });
    assert.equal(
        f.requests.length,
        1,
        "overlapping selections and folder cycles are deduplicated"
    );
    assert.equal(batches.at(-1).complete, true);
    assert.equal(batches.at(-1).items.length, 1);
}
{
    const f = fixture();
    f.client.playlist([{ request: { cmd: "old" }, title: "Old" }], () =>
        assert.fail("stale callback")
    );
    const old = f.requests[0];
    const abort = old.abort.bind(old);
    let latest;
    old.abort = () => {
        abort();
        f.client.playlist(
            [{ request: { cmd: "latest" }, title: "Latest" }],
            (items) => (latest = items)
        );
    };
    f.client.playlist(
        [{ request: { cmd: "interrupted" }, title: "Interrupted" }],
        () => assert.fail("reentrant superseded callback")
    );
    assert.equal(f.requests.length, 2);
    assert.equal(JSON.parse(f.requests[1].options.data).params.cmd, "latest");
    f.requests[1].receive({ items: [], type: "category" });
    assert.equal(latest.length, 0);
}
{
    const f = fixture();
    let result;
    f.client.playlist(
        [{ request: { cmd: "broken", offset: 1 }, title: "Broken" }],
        (items, complete, error) => (result = { complete, error, items })
    );
    f.requests[0].receive({
        items: [{ request: { offset: 1 }, type: "next" }],
        type: "category",
    });
    assert.equal(result.complete, true);
    assert(
        result.error,
        "non-advancing pagination is never silently treated as complete"
    );
}

{
    const f = fixture();
    let result;
    f.client.playlist(
        [
            {
                adult: true,
                request: { cmd: "series" },
                sequence: true,
                title: "Selected series",
            },
        ],
        (items, complete, error) => (result = { complete, error, items })
    );
    f.requests[0].receive({
        items: [
            { request: { cmd: "season" }, title: "Season", type: "category" },
        ],
        type: "category",
    });
    f.requests[1].receive({
        items: [
            {
                request: { cmd: "play", id: 1 },
                title: "Episode",
                type: "stream",
            },
        ],
        type: "category",
    });
    assert.equal(result.complete, true);
    assert.equal(
        result.items[0].adult,
        1,
        "selected root adult flag survives absent child metadata"
    );
    assert.equal(result.items[0].__ottMediaSequence, true);
    assert.equal(result.items[0].title, "Selected series - Season - Episode");
}
{
    const f = fixture();
    let result;
    f.client.playlist(
        [{ request: { cmd: "chosen" }, title: "Chosen" }],
        (items, complete, error) => (result = { complete, error, items })
    );
    f.requests[0].receive({
        items: [
            { request: { cmd: "outside-selection", offset: 1 }, type: "next" },
        ],
        type: "category",
    });
    assert.equal(result.complete, true);
    assert(
        result.error,
        "pagination cannot switch into an unselected collection"
    );
    assert.equal(f.requests.length, 1);
}

console.log(
    "PASS VPortal parser, browser/native JSON transport, catalogue controls and paging, asynchronous lifecycle, quality and secret-safe failures"
);

require("./test_vportal_search.cjs");
