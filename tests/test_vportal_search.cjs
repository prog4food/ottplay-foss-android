const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
const compile = (source) =>
    ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES5,
        },
    }).outputText;
const helpersFile = ts.createSourceFile(
    "helpers.ts",
    fs.readFileSync(path.join(root, "src/utils/helpers.ts"), "utf8"),
    ts.ScriptTarget.Latest,
    true
);
const helpers = { exports: {} };
vm.runInNewContext(
    compile(
        helpersFile.statements
            .filter(
                (node) =>
                    ts.isFunctionDeclaration(node) &&
                    ["metadataText", "metadataImageUrl"].includes(
                        node.name?.text
                    )
            )
            .map((node) => node.getText(helpersFile))
            .join("\n")
    ),
    helpers
);
const { localizationRuntime } = require("./helpers/localization-runtime.cjs");
const caseless = { exports: {} };
vm.runInNewContext(localizationRuntime(), caseless);
caseless.require = () => caseless;
vm.runInNewContext(
    compile(fs.readFileSync(path.join(root, "src/utils/caseless.ts"), "utf8")),
    caseless
);
const code = compile(
    fs.readFileSync(path.join(root, "src/plugins/vportal.ts"), "utf8")
);
const privateKey = "fixture-search-private-key";
const endpoint = "https://portal.example/api";

function fixture(overrides = {}, transport) {
    const requests = [],
        notifications = [],
        timers = new Map();
    let current = true,
        timerId = 0,
        time = 1000,
        busy = 0;
    const w = {
        _mediaLoadState: {},
        alert(message) {
            notifications.push(message);
        },
        clearTimeout(id) {
            timers.delete(id);
        },
        host: "https://ott.example",
        setTimeout(callback, ms) {
            const id = ++timerId;
            timers.set(id, { callback, time: time + ms });
            return id;
        },
        showShift(message) {
            notifications.push(message);
        },
        ...overrides,
    };
    w.$ = () => ({
        hide() {
            busy--;
            return this;
        },
        html() {
            return this;
        },
        show() {
            busy++;
            return this;
        },
    });
    w.$.ajax = (options) => {
        const request = {
            abort() {
                this.aborted = true;
                options.error({}, "abort");
                options.complete();
            },
            fail() {
                options.error({ responseText: privateKey + endpoint }, "error");
                options.complete();
            },
            options,
            receive(data) {
                options.success(data);
                options.complete();
            },
        };
        requests.push(request);
        if (transport) transport(request, requests.length - 1);
        return request;
    };
    const context = {
        Date: { now: () => time },
        exports: {},
        require: (id) =>
            id.endsWith("/caseless") ? caseless.exports : helpers.exports,
        window: w,
    };
    vm.runInNewContext(code, context);
    const client = context.exports.createVPortalClient(
        "portal::[key:" + privateKey + "]" + endpoint,
        { isCurrent: () => current, sourceId: "source-a" }
    );
    return {
        advance(ms) {
            time += ms;
            for (const [id, timer] of [...timers])
                if (timer.time <= time) {
                    timers.delete(id);
                    timer.callback();
                }
        },
        busy: () => busy,
        client,
        notifications,
        requests,
        sourceCurrent(value) {
            current = value;
        },
        timers: () => timers.size,
        w,
    };
}
const page = (items, extra = {}) => ({ items, type: "category", ...extra });
const stream = (id, title = "Find " + id, extra = {}) => ({
    request: { cmd: "play", id },
    title,
    type: "stream",
    ...extra,
});
const series = (id, title = "Find series " + id, extra = {}) => ({
    request: { cmd: "series", id },
    title,
    type: "multistream",
    ...extra,
});
const next = (offset) => ({
    request: offset === undefined ? {} : { offset },
    type: "next",
});
const params = (request) => {
    const data = JSON.parse(request.options.data);
    return data.params || data;
};
function failure(result) {
    assert(result, "Search reports the failure");
    assert.equal(result.items.length, 0, "No partial result escapes");
    assert(
        [
            "VPortal search could not collect a complete result",
            "VPortal search timed out before collecting all results",
            "VPortal search requires a title filter",
        ].includes(result.error),
        "Search failures expose only fixed public messages"
    );
}

{
    const f = fixture();
    let result;
    f.client.search("fInD", (value) => {
        result = value;
    });
    assert.equal(f.busy(), 0, "Search does not open the busy dialog");
    assert.deepEqual(params(f.requests[0]), {
        app: "ott-play",
        cmd: "search",
        key: privateKey,
        limit: 300,
        query: "fInD",
    });
    f.requests[0].receive(
        page([
            stream(1),
            series(10, "Find series", {
                adult: 1,
                description: "Parent description",
                img: "https://images.example/series.jpg",
            }),
            {
                request: { cmd: "category", id: 99 },
                title: "Find unrelated",
                type: "category",
            },
            stream(2, "Unrelated movie"),
            next(),
        ])
    );
    assert.equal(params(f.requests[1]).id, 10);
    f.requests[1].receive(
        page(
            [
                stream(11, "Episode 1"),
                {
                    request: { cmd: "season", id: 20 },
                    title: "Season 2",
                    type: "category",
                },
                next(2),
            ],
            { type: "multistream" }
        )
    );
    assert.equal(params(f.requests[2]).id, 20);
    f.requests[2].receive(
        page([stream(21, "Episode 1")], { type: "multistream" })
    );
    assert.equal(params(f.requests[3]).offset, 2);
    f.requests[3].receive(
        page([stream(12, "Episode 2")], { type: "multistream" })
    );
    assert.equal(params(f.requests[4]).offset, 4);
    f.requests[4].receive(
        page([
            stream(1), // Overlapping search pages preserve the first occurrence.
            series(30, "FIND another series"),
            {
                title: "Find direct",
                type: "stream",
                url: "https://cdn.example/direct.mp4",
            },
        ])
    );
    f.requests[5].receive(
        page([stream(31, "Episode unrelated to filter")], {
            type: "multistream",
        })
    );
    assert.deepEqual(
        Array.from(result.items, (item) => item.title),
        [
            "Find 1",
            "Find series - Episode 1",
            "Find series - Season 2 - Episode 1",
            "Find series - Episode 2",
            "FIND another series - Episode unrelated to filter",
            "Find direct",
        ]
    );
    assert.equal(result.error, undefined);
    for (const item of result.items) {
        assert.equal(item.vportalSource, "source-a");
        assert.equal(item.__ottMediaOrigin.kind, "catalog");
        assert.equal(item.__ottMediaOrigin.target.vportalSource, "source-a");
    }
    assert.equal(result.items[1].adult, 1);
    assert.equal(result.items[2].adult, 1);
    assert.equal(
        result.items[2].logo_30x30,
        "https://images.example/series.jpg"
    );
    assert.match(result.items[2].description, /Parent description/);
    assert.equal(result.items[2].__ottMediaSequence, true);
    assert.equal(result.items[2].__ottMediaOrigin.target.request.id, 20);
    assert.equal(result.items[3].__ottMediaOrigin.target.request.offset, 2);
    assert.equal(f.requests.length, 6, "No unrelated category is crawled");
    assert.equal(f.timers(), 0);
    let playable;
    f.client.resolve(
        result.items[1],
        (item) => {
            playable = item;
        },
        true
    );
    f.requests[6].receive({ url: "https://cdn.example/fresh.mp4" });
    assert.equal(playable.stream_url, "https://cdn.example/fresh.mp4");
    assert.equal(playable.adult, 1);
    assert.equal(playable.__ottMediaOrigin.target.request.id, 10);
    assert.equal(f.notifications.length, 0);
}

for (const [query, title, matches] of [
    ["strasse", "Straße", true],
    ["Σ", "ς", true],
    ["i", "ı", false],
    ["СВАДЬБА", "Большая свадьба", true],
]) {
    const f = fixture();
    let result;
    f.client.search(query, (value) => {
        result = value;
    });
    f.requests[0].receive(page([stream(1, title)]));
    assert.equal(result.items.length, matches ? 1 : 0);
}

for (const data of [
    page([]),
    page([
        stream(1, "Other"),
        series(2, "Other series"),
        { title: "Find folder", type: "category" },
    ]),
]) {
    const f = fixture();
    let result;
    f.client.search("find", (value) => {
        result = value;
    });
    f.requests[0].receive(data);
    assert.equal(result.items.length, 0);
    assert.equal(result.error, undefined);
    assert.equal(f.requests.length, 1);
}

for (const malformed of [
    null,
    { message: privateKey, type: "error" },
    page([], { truncated: true }),
    page([stream(2)], { total: 50 }),
    page([], { has_more: true }),
    page([null]),
    page([next(1), next(2)]),
    page([series(1, "Find", { request: {} })]),
    page([stream(1, "Find empty request", { request: {} })]),
    page([{ title: "Find broken", type: "stream" }]),
]) {
    const f = fixture();
    let result;
    f.client.search("find", (value) => {
        result = value;
    });
    f.requests[0].receive(page([stream(1), next(1)]));
    f.requests[1].receive(malformed);
    failure(result);
    assert.equal(f.notifications.length, 0);
}

for (const brokenPage of [
    page([stream(1), next(2)]),
    page([stream(2), next(0)]),
    page([stream(2), { request: { cmd: "other" }, type: "next" }]),
]) {
    const f = fixture();
    let result;
    f.client.search("find", (value) => {
        result = value;
    });
    f.requests[0].receive(page([stream(1), next(1)]));
    f.requests[1].receive(brokenPage);
    if (!result) f.requests[2].receive(page([stream(3), next(1)]));
    failure(result);
}

{
    const f = fixture();
    let result;
    f.client.search("find", (value) => {
        result = value;
    });
    f.requests[0].receive(page([series(1)]));
    f.requests[1].receive(page([series(2, "Inner")]));
    f.requests[2].receive(
        page([
            series(1, "Cycle", {
                request: JSON.parse('{"id":1,"cmd":"series"}'),
            }),
        ])
    );
    failure(result);
    assert.equal(
        f.requests.length,
        3,
        "Reordered request keys cannot bypass ancestor checks"
    );
}

{
    const f = fixture();
    let result;
    f.client.search("find", (value) => {
        result = value;
    });
    f.requests[0].receive(page([stream(1), series(2), stream(1), series(2)]));
    f.requests[1].receive(page([stream(3, "One"), stream(3, "Repeated")]));
    assert.deepEqual(
        Array.from(result.items, (item) => item.request.id),
        [1, 3]
    );
    assert.equal(f.requests.length, 2, "Repeated series are not fetched twice");
}

for (const action of [
    "cancel",
    "dispose",
    "returned",
    "guard",
    "source",
    "replace",
    "load",
    "play",
]) {
    const f = fixture();
    let called = 0,
        owned = true;
    const cancel = f.client.search(
        "find",
        () => called++,
        () => owned
    );
    const retired = f.requests[0];
    if (action === "returned") cancel();
    else if (action === "guard") owned = false;
    else if (action === "source") f.sourceCurrent(false);
    else if (action === "replace") f.client.search("new", () => {});
    else if (action === "load") f.client.load("", () => {});
    else if (action === "play") f.client.play({ stream_url: "" });
    else f.client[action]();
    retired.receive(page([stream(1), next(1)]));
    retired.fail();
    f.advance(25000);
    assert.equal(called, 0, action + " retires search callbacks");
    assert(retired.aborted, action + " aborts retired transport");
    assert.equal(f.notifications.length, 0);
}

for (const reason of [
    "transport",
    "timeout",
    "page cap",
    "item cap",
    "row cap",
]) {
    const f = fixture();
    let result;
    f.client.search("find", (value) => {
        result = value;
    });
    if (reason === "transport") f.requests[0].fail();
    else if (reason === "timeout") {
        f.advance(25000);
        assert(f.requests[0].aborted);
        f.requests[0].receive(page([stream(1)]));
    } else if (reason === "page cap") {
        for (let index = 0; index < 100; index++)
            f.requests[index].receive(page([stream(index), next(index + 1)]));
    } else if (reason === "item cap") {
        for (let index = 0; index < 7; index++)
            f.requests[index].receive(
                page([
                    ...Array.from({ length: 300 }, (_, n) =>
                        stream(index * 300 + n)
                    ),
                    next((index + 1) * 300),
                ])
            );
    } else
        f.requests[0].receive(
            page(Array.from({ length: 10001 }, (_, n) => stream(n)))
        );
    failure(result);
    assert.equal(f.notifications.length, 0);
    assert.equal(f.timers(), 0);
}

{
    const f = fixture();
    let calls = 0,
        automatic = 0,
        catalog = 0;
    f.client.load("", () => catalog++);
    f.client.search("find", () => calls++);
    f.client.resolve(
        { request: { cmd: "play", id: 3 }, vportalSource: "source-a" },
        () => automatic++,
        true
    );
    f.client.cancelAutomatic();
    assert.equal(f.requests[0].aborted, undefined);
    assert.equal(f.requests[1].aborted, undefined);
    assert.equal(f.requests[2].aborted, true);
    f.requests[1].receive(page([stream(1)]));
    assert.equal(
        f.busy(),
        1,
        "Search completion cannot hide foreground busy UI"
    );
    f.requests[0].receive(page([]));
    assert.equal(f.busy(), 0);
    f.requests[2].receive({ url: "https://cdn.example/retired.mp4" });
    assert.equal(calls, 1);
    assert.equal(catalog, 1);
    assert.equal(automatic, 0);
}

for (const overrides of [
    { __TAURI__: {} },
    { Capacitor: { isNativePlatform: () => true } },
    {
        __OTTPLAY_HOSTED__: {
            version: 1,
            vportal: {
                routes: [{ path: "/vportal/approved", upstream: endpoint }],
            },
        },
    },
]) {
    const f = fixture(overrides);
    let result;
    f.client.search("find", (value) => {
        result = value;
    });
    assert.equal(
        f.requests[0].options.url,
        overrides.__OTTPLAY_HOSTED__ ? "/vportal/approved" : endpoint
    );
    assert.equal(params(f.requests[0]).key, privateKey);
    assert.equal(f.requests[0].options.vportalRequest, true);
    f.requests[0].receive(page([]));
    assert.equal(result.error, undefined);
}

{
    const f = fixture({
        __OTTPLAY_HOSTED__: { version: 1, vportal: { routes: [] } },
    });
    let result;
    f.client.search("find", (value) => {
        result = value;
    });
    failure(result);
    assert.equal(f.requests.length, 0);
    assert.equal(f.notifications.length, 0);
}

{
    const f = fixture();
    const results = [];
    f.client.search("   ", (result) => results.push(result));
    failure(results[0]);
    assert.equal(f.requests.length, 0);
    f.client.search("find", (result) => results.push(result));
    f.requests[0].receive(page([stream(1)]));
    f.requests[0].receive(page([stream(2)]));
    assert.equal(
        results.length,
        2,
        "Duplicate transport callbacks are ignored"
    );
    assert.equal(results[1].items[0].request.id, 1);
}

{
    const f = fixture();
    let result;
    f.client.search("find", (value) => {
        result = value;
    });
    f.requests[0].receive(page([series(1)]));
    f.requests[1].receive(
        page([stream(2, "Episode 1"), next(1)], {
            adult: 1,
            img: "https://images.example/response.jpg",
            title: "Provider heading",
            type: "multistream",
        })
    );
    f.requests[2].receive(
        page([stream(3, "Episode 2")], { type: "multistream" })
    );
    assert.deepEqual(
        Array.from(result.items, (item) => item.adult),
        [1, 1],
        "Response adult metadata is inherited across pages"
    );
    assert.deepEqual(
        Array.from(result.items, (item) => item.title),
        ["Find series 1 - Episode 1", "Find series 1 - Episode 2"]
    );
    assert.equal(
        result.items[1].logo_30x30,
        "https://images.example/response.jpg"
    );
}

{
    const f = fixture({}, (request, index) => {
        if (index === 0) request.receive(page([stream(1), next(1)]));
    });
    let calls = 0;
    const cancel = f.client.search("find", () => calls++);
    assert.equal(f.requests.length, 2);
    cancel();
    assert.equal(f.requests[0].aborted, undefined);
    assert.equal(
        f.requests[1].aborted,
        true,
        "A synchronous response cannot overwrite the next pending request"
    );
    f.requests[1].receive(page([stream(2)]));
    assert.equal(calls, 0);
}

{
    const f = fixture();
    const results = [];
    const cancel = f.client.search("find", (result) => {
        results.push(result);
        f.client.search("replacement", (value) => results.push(value));
    });
    f.requests[0].receive(page([stream(1)]));
    cancel();
    assert.equal(
        f.requests[1].aborted,
        undefined,
        "Completed cancellation cannot abort a callback's newer search"
    );
    f.requests[1].receive(page([stream(2, "Replacement")]));
    assert.equal(results.length, 2);
}

const directStream = (title, url, extra = {}) => ({
    title,
    type: "stream",
    url,
    ...extra,
});
function directQueue(f, rows, inSeries = false) {
    let result;
    f.client.search("find", (value) => {
        result = value;
    });
    if (inSeries) {
        f.requests[0].receive(page([series(42, "Find parent", { adult: 1 })]));
        f.requests[1].receive(page(rows, { type: "multistream" }));
    } else f.requests[0].receive(page(rows));
    assert.equal(result.error, undefined);
    for (const item of result.items) item.__ottVPortalQueue = true;
    return result.items;
}

{
    const f = fixture();
    const [item] = directQueue(
        f,
        [directStream("Episode 1", "https://cdn.example/old.m3u8")],
        true
    );
    const original = JSON.stringify(item);
    const resolved = [];
    f.client.resolve(item, (value) => resolved.push(value), true);
    assert.equal(
        resolved.length,
        0,
        "Direct queue playback waits for a fresh catalog URL"
    );
    assert.equal(params(f.requests[2]).cmd, "series");
    assert.equal(params(f.requests[2]).id, 42);
    f.requests[2].receive(
        page([directStream("Episode 1", "https://cdn.example/new.m3u8")], {
            type: "multistream",
        })
    );
    assert.equal(resolved[0].stream_url, "https://cdn.example/new.m3u8");
    assert.equal(resolved[0].title, "Find parent - Episode 1");
    assert.equal(resolved[0].adult, 1);
    assert.equal(resolved[0].vportalSource, "source-a");
    assert.equal(
        JSON.stringify(item),
        original,
        "Refresh cannot mutate queue/history-owned objects"
    );
    f.client.resolve(resolved[0], (value) => resolved.push(value), true);
    f.requests[3].receive(
        page([directStream("Episode 1", "https://cdn.example/loop.m3u8")], {
            type: "multistream",
        })
    );
    assert.equal(resolved[1].stream_url, "https://cdn.example/loop.m3u8");
    assert.equal(f.busy(), 0);
    assert.equal(f.notifications.length, 0);
}

{
    const f = fixture();
    const items = directQueue(f, [
        directStream("Find duplicate", "https://cdn.example/first-old.mp4"),
        stream(4, "Find duplicate"),
        directStream("Find duplicate", "https://cdn.example/third-old.mp4"),
    ]);
    let resolved;
    f.client.resolve(
        items[2],
        (value) => {
            resolved = value;
        },
        true
    );
    f.requests[1].receive(
        page([
            directStream("Find duplicate", "https://cdn.example/first-new.mp4"),
            stream(4, "Find duplicate"),
            directStream("Find duplicate", "https://cdn.example/third-new.mp4"),
        ])
    );
    assert.equal(
        resolved.stream_url,
        "https://cdn.example/third-new.mp4",
        "Same-title occurrence includes request-backed siblings"
    );
}

for (const field of ["id", "fid", "stream_id"]) {
    const f = fixture();
    const items = directQueue(f, [
        directStream("Find first", "https://cdn.example/first-old.mp4", {
            [field]: 10,
        }),
        directStream("Find second", "https://cdn.example/second-old.mp4", {
            [field]: 20,
        }),
    ]);
    let resolved;
    f.client.resolve(
        items[1],
        (value) => {
            resolved = value;
        },
        true
    );
    f.requests[1].receive(
        page([
            directStream(
                "Renamed second",
                "https://cdn.example/second-new.mp4",
                { id: 999, [field]: "20" }
            ),
            directStream("Find first", "https://cdn.example/first-new.mp4", {
                [field]: 10,
            }),
        ])
    );
    assert.equal(
        resolved.stream_url,
        "https://cdn.example/second-new.mp4",
        "Provider ID survives reordered rows and renamed titles"
    );
}

for (const response of [
    null,
    page([]),
    page([
        directStream("Find item", "https://cdn.example/new.mp4", { id: 99 }),
    ]),
    page([directStream("Find item", "javascript:bad()", { id: 10 })]),
    page([
        directStream("Find item", "https://cdn.example/new.mp4", { id: 10 }),
        directStream("Ambiguous ID", "https://cdn.example/other.mp4", {
            id: 10,
        }),
    ]),
    { message: privateKey, type: "error" },
]) {
    const f = fixture();
    const [item] = directQueue(f, [
        directStream("Find item", "https://cdn.example/old.mp4", { id: 10 }),
    ]);
    const resolved = [];
    f.client.resolve(item, (value) => resolved.push(value), true);
    f.requests[1].receive(response);
    assert.deepEqual(
        resolved,
        [null],
        "Missing, changed, invalid or ambiguous items complete without a stale URL"
    );
    assert.deepEqual(f.notifications, ["VPortal request failed"]);
}

for (const action of [
    "transport",
    "cancelAutomatic",
    "cancel",
    "dispose",
    "source",
]) {
    const f = fixture();
    const [item] = directQueue(f, [
        directStream("Find item", "https://cdn.example/old.mp4"),
    ]);
    const resolved = [];
    f.client.resolve(item, (value) => resolved.push(value), true);
    if (action === "transport") f.requests[1].fail();
    else if (action === "source") f.sourceCurrent(false);
    else f.client[action]();
    f.requests[1].receive(
        page([directStream("Find item", "https://cdn.example/new.mp4")])
    );
    assert.deepEqual(
        resolved,
        action === "transport" ? [null] : [],
        action + " cannot revive old signed URLs"
    );
    assert.deepEqual(
        f.notifications,
        action === "transport" ? ["VPortal request failed"] : []
    );
}

{
    const f = fixture();
    const [item] = directQueue(f, [
        directStream("Find item", "https://cdn.example/old.mp4"),
    ]);
    let foreground = 0,
        resolved;
    f.client.load("", () => foreground++);
    f.w.editKey = function editor() {};
    f.w.selectBoxKeyHandler = function picker() {};
    const editor = f.w.editKey,
        picker = f.w.selectBoxKeyHandler,
        busy = f.w.dialogBoxKeyHandler;
    f.client.resolve(
        item,
        (value) => {
            resolved = value;
        },
        true
    );
    assert.equal(f.requests[1].aborted, undefined);
    f.requests[2].receive(
        page([directStream("Find item", "https://cdn.example/new.mp4")])
    );
    assert.equal(resolved.stream_url, "https://cdn.example/new.mp4");
    assert.strictEqual(f.w.editKey, editor);
    assert.strictEqual(f.w.selectBoxKeyHandler, picker);
    assert.strictEqual(f.w.dialogBoxKeyHandler, busy);
    assert.equal(
        f.busy(),
        1,
        "Background direct refresh preserves foreground dialog ownership"
    );
    f.requests[1].receive(page([]));
    assert.equal(foreground, 1);
}

{
    const f = fixture();
    let result, resolved;
    f.client.search("find", (value) => {
        result = value;
    });
    f.requests[0].receive(page([stream(1), next(1)]));
    f.requests[1].receive(
        page([directStream("Find direct", "https://cdn.example/old.mp4")])
    );
    const item = result.items[1];
    item.__ottVPortalQueue = true;
    f.client.resolve(
        item,
        (value) => {
            resolved = value;
        },
        true
    );
    assert.equal(
        params(f.requests[2]).offset,
        1,
        "Direct refresh fetches its original page, not search page one"
    );
    f.requests[2].receive(
        page([directStream("Find direct", "https://cdn.example/new.mp4")])
    );
    assert.equal(resolved.stream_url, "https://cdn.example/new.mp4");
    item.__ottMediaOrigin.target.vportalSource = "different-source";
    const rejected = [];
    f.client.resolve(item, (value) => rejected.push(value), true);
    assert.deepEqual(
        rejected,
        [null],
        "Foreign origin completes without playback"
    );
    assert.equal(
        f.requests.length,
        3,
        "Origin ownership is checked before sending its request with this key"
    );
    assert.deepEqual(f.notifications, ["VPortal request failed"]);
}

for (const extra of [0, 1]) {
    const f = fixture();
    let result;
    f.client.search("find", (value) => {
        result = value;
    });
    const requestLength = JSON.stringify({
        cmd: "search",
        limit: 300,
        query: "find",
    }).length;
    const pageOverhead = JSON.stringify([["category", "", null, null]]).length;
    const title = "x".repeat(
        1048576 - requestLength * 2 - pageOverhead + extra
    );
    f.requests[0].receive(page([{ title, type: "category" }]));
    if (extra) failure(result);
    else {
        assert.equal(
            result.error,
            undefined,
            "Exactly 2 MiB of canonical UTF-16 storage fits"
        );
        assert.equal(result.items.length, 0);
    }
}

{
    const f = fixture();
    let result;
    f.client.search("find", (value) => {
        result = value;
    });
    f.requests[0].receive(page([stream(1), next(1)]));
    f.requests[1].receive(
        page([{ title: "x".repeat(1048576), type: "category" }])
    );
    failure(result);
    assert.equal(
        f.timers(),
        0,
        "The shared budget retires an incomplete multi-page search"
    );
}

{
    const f = fixture();
    let result;
    const titles = [
        "Винни-Пух",
        "Винни Пух идёт в гости",
        "Винни Пух и день забот",
    ];
    f.client.search("exact:" + JSON.stringify(titles), (value) => {
        result = value;
    });
    for (let i = 0; i < titles.length; i++) {
        assert.equal(params(f.requests[i]).query, titles[i]);
        // Search results may overlap, contain sequels and return a different order.
        f.requests[i].receive(
            page([
                stream(3, titles[2]),
                stream(2, titles[1]),
                stream(1, titles[0].toUpperCase()),
                stream(4, "Винни Пух: Кровь и мёд"),
                series(5, titles[0]),
            ])
        );
    }
    assert.equal(result.error, undefined);
    assert.deepEqual(
        Array.from(result.items, (item) => item.request.id),
        [1, 2, 3]
    );
    assert.equal(
        f.requests.length,
        3,
        "Exact movie selection does not expand same-named series"
    );
    assert.equal(f.timers(), 0);
}
for (const rows of [
    [stream(1, "Other")],
    [stream(1, "Film"), stream(2, "Film")],
]) {
    const f = fixture();
    let result;
    f.client.search('exact:["Film"]', (value) => {
        result = value;
    });
    f.requests[0].receive(page(rows));
    assert.equal(result.error, "Missing or ambiguous VPortal title");
    assert.equal(
        result.items.length,
        0,
        "Never start a partial or ambiguous queue"
    );
}
for (const query of [
    "exact:[]",
    "exact:{}",
    'exact:[""]',
    'exact:["Film","FILM"]',
    "exact:[1]",
    "exact:" + JSON.stringify(Array.from({ length: 21 }, (_, i) => String(i))),
]) {
    const f = fixture();
    let result;
    f.client.search(query, (value) => {
        result = value;
    });
    assert.equal(result.error, "Invalid exact VPortal titles");
    assert.equal(f.requests.length, 0);
    assert.equal(f.timers(), 0);
}
{
    const f = fixture();
    let result;
    const cancel = f.client.search('exact:["First","Second"]', (value) => {
        result = value;
    });
    f.requests[0].receive(page([stream(1, "First")]));
    cancel();
    f.requests[1].receive(page([stream(2, "Second")]));
    assert.equal(
        result,
        undefined,
        "Cancellation during the second title cancels the whole selection"
    );
    assert.equal(f.timers(), 0);
}

console.log(
    "PASS VPortal complete filtered search: ordered series/pages, Unicode, bounds, origins, cancellation and fresh direct-URL resolution"
);
