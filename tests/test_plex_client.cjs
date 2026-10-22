const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");
const ts = require("typescript");
const { sourceFunctions } = require("./test_port_vod.cjs");
const root = path.resolve(__dirname, "..");
const compiled = ts.transpileModule(
    fs.readFileSync(path.join(root, "src/plugins/plex.ts"), "utf8"),
    {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES5,
        },
    }
).outputText;
const xmlParser = new JSDOM().window.DOMParser;
const token = "fixture-private-plex-token";
const source = "plex:fixture-account";
const film = {
    plexSource: source,
    request: { path: "/library/metadata/42" },
    stream_url: "plex:request",
    title: "Fixture",
};
function metadata(overrides = {}) {
    return {
        MediaContainer: {
            Metadata: [
                {
                    Media: [
                        {
                            audioCodec: "aac",
                            container: "mp4",
                            height: 1080,
                            Part: [{ key: "/library/parts/1/file.mp4" }],
                            videoCodec: "h264",
                            width: 1920,
                            ...overrides,
                        },
                    ],
                    ratingKey: "42",
                    type: "movie",
                },
            ],
        },
    };
}
function fixture(config = {}, capabilities = {}) {
    const requests = [],
        events = new Map(),
        keepalive = [],
        messages = [],
        intervals = new Map(),
        timers = new Map(),
        timerDelays = [];
    let next = 0,
        clock = Date.now(),
        active = true;
    const host = {
        $: {
            ajax(options) {
                const request = {
                    abort() {
                        this.aborted = true;
                        options.error?.({}, "abort");
                        options.complete?.();
                    },
                    aborted: false,
                    fail(status = 0, kind = "error") {
                        options.error?.({ responseText: token, status }, kind);
                        options.complete?.();
                    },
                    options,
                    reply(data) {
                        options.success?.(data);
                        options.complete?.();
                    },
                };
                requests.push(request);
                return request;
            },
        },
        addEventListener(event, listener, capture) {
            events.set(event, listener);
            capabilities.eventTarget?.addEventListener(
                event,
                listener,
                capture
            );
        },
        clearInterval(id) {
            intervals.delete(id);
        },
        clearTimeout(id) {
            timers.delete(id);
        },
        DOMParser: xmlParser,
        document: {
            createElement: () => ({
                canPlayType: capabilities.native || (() => ""),
            }),
        },
        fetch(url, options) {
            keepalive.push({ options, url });
            return {
                then(resolve) {
                    resolve?.();
                },
            };
        },
        Hls: { isSupported: () => capabilities.hls !== false },
        infoBox(message) {
            messages.push(message);
        },
        MediaSource: { isTypeSupported: capabilities.mse || (() => false) },
        mediaName: "untouched",
        mediaRecords: ["untouched"],
        removeEventListener(event, listener, capture) {
            if (events.get(event) === listener) events.delete(event);
            capabilities.eventTarget?.removeEventListener(
                event,
                listener,
                capture
            );
        },
        setInterval(run, delay) {
            intervals.set(++next, { delay, run });
            return next;
        },
        setTimeout(run, delay) {
            timerDelays.push(delay);
            run.fixtureDelay = delay;
            timers.set(++next, run);
            return next;
        },
    };
    const helpers = vm.createContext({});
    vm.runInContext(
        sourceFunctions("src/utils/helpers.ts", ["metadataText"]),
        helpers
    );
    const context = {
        Date: { now: () => clock },
        exports: {},
        require: () => helpers,
        window: host,
    };
    vm.runInNewContext(compiled, context);
    const api = {
        createPlexClient: host.__ottPlex.create,
        normalizePlexConfig: host.__ottPlex.normalize,
    };
    const client = api.createPlexClient(
        { address: "https://plex.invalid", token, ...config },
        { isCurrent: () => active, sourceId: source }
    );
    return {
        advance(milliseconds) {
            clock += milliseconds;
        },
        api,
        client,
        events,
        host,
        intervals,
        keepalive,
        messages,
        requests,
        retire() {
            active = false;
        },
        tick(maxDelay = Infinity) {
            const pending = [...timers.entries()].filter(
                ([, run]) => run.fixtureDelay <= maxDelay
            );
            pending.forEach(([id]) => timers.delete(id));
            pending.forEach(([, run]) => run());
        },
        timerDelays,
        timers,
    };
}
let passed = 0;
function test(name, run) {
    run();
    console.log("PASS Plex client: " + name);
    passed++;
}
function last(f) {
    return f.requests.at(-1);
}
function parsed(f) {
    return new URL(last(f).options.url);
}

test("configuration is explicit, normalized and refuses embedded credentials or ambiguous addresses", () => {
    const f = fixture();
    for (const address of [
        "//plex.invalid",
        "file:///library",
        "http://user:password@plex.invalid",
        "http://plex.invalid?token=hidden",
        "http://plex.invalid/../admin",
        "http://plex.invalid/#fragment",
        "http://plex.invalid:0",
        "http://plex.invalid:65536",
        "http://[::1]:99999",
    ])
        assert.equal(f.api.normalizePlexConfig({ address, token }), null);
    assert.equal(
        f.api.normalizePlexConfig({
            address: "http://plex.invalid",
            token: "a\nb",
        }),
        null
    );
    assert.equal(
        f.api.normalizePlexConfig({
            server: " http://plex.invalid:32400/ ",
            token,
        }).address,
        "http://plex.invalid:32400"
    );
    assert.equal(
        f.api.normalizePlexConfig({
            address: "https://plex.invalid",
            playback: "unknown",
            token,
        }).playback,
        "auto"
    );
});

test("connect keeps transient startup failures pending, with bounded cancellable retries", () => {
    for (const status of [0, 408, 429, 503]) {
        const f = fixture();
        const results = [];
        f.client.connect((error) => results.push(error));
        last(f).fail(status);
        assert.deepEqual(results, []);
        f.tick();
        assert.equal(f.requests.length, 2);
        last(f).fail(status);
        f.tick();
        assert.equal(f.requests.length, 3);
        last(f).reply({ MediaContainer: { Directory: [] } });
        assert.deepEqual(results, [undefined]);
    }
    const f = fixture();
    const results = [];
    f.client.connect((error) => results.push(error));
    for (let attempt = 0; attempt < 3; attempt++) {
        last(f).fail(503);
        f.tick();
    }
    assert.deepEqual(results, ["Plex connection failed"]);
    assert.equal(f.requests.length, 3);
    for (const cancel of [() => f.client.cancel(), () => f.client.dispose()]) {
        f.client.connect(() => assert.fail("Cancelled startup cannot settle"));
        last(f).fail();
        const count = f.requests.length;
        cancel();
        f.tick();
        assert.equal(f.requests.length, count);
    }
});

test("connect reports rejected credentials without retrying", () => {
    for (const status of [401, 403]) {
        const f = fixture();
        let error;
        f.client.connect((value) => (error = value));
        last(f).fail(status);
        f.tick();
        assert.equal(error, "Plex connection failed");
        assert.equal(f.requests.length, 1);
    }
});

test("connect authenticates directly and cached sections do not mutate another catalog", () => {
    const f = fixture();
    let connected = false;
    f.client.connect((error) => {
        assert.equal(error, undefined);
        connected = true;
    });
    assert.equal(parsed(f).origin, "https://plex.invalid");
    assert.equal(parsed(f).pathname, "/library/sections");
    assert.equal(parsed(f).searchParams.get("X-Plex-Token"), token);
    last(f).reply(
        '<MediaContainer size="1"><Directory key="1" title="Fixture library" type="movie"/></MediaContainer>'
    );
    assert.equal(connected, true);
    assert.deepEqual(f.host.mediaRecords, ["untouched"]);
    f.client.load("", () => {});
    assert.equal(f.requests.length, 1);
    assert.equal(
        f.host.mediaRecords[0].playlist_url.path,
        "/library/sections/1/all"
    );
    assert(!JSON.stringify(f.host.mediaRecords).includes(token));
    const second = fixture({
        address: "http://other.invalid:32400",
        token: "different-private-token",
    });
    second.client.connect(() => {});
    assert.equal(parsed(second).origin, "http://other.invalid:32400");
    assert.equal(
        parsed(second).searchParams.get("X-Plex-Token"),
        "different-private-token"
    );
    assert.equal(parsed(f).origin, "https://plex.invalid");
});

test("JSON and XML folders recurse through Plex keys and shows/seasons retain stable IDs", () => {
    const f = fixture();
    f.client.load(
        { path: "/library/sections/1/all", plexSource: source },
        () => {}
    );
    last(f).reply({
        MediaContainer: {
            Directory: [
                { key: "/library/metadata/10", title: "Series", type: "show" },
            ],
        },
    });
    assert.equal(
        f.host.mediaRecords[0].playlist_url.path,
        "/library/sections/1/folder"
    );
    assert.equal(f.host.mediaRecords[0].title, "Browse folders");
    assert.equal(
        f.host.mediaRecords[1].playlist_url.path,
        "/library/metadata/10/children"
    );
    f.client.load(f.host.mediaRecords[0].playlist_url, () => {});
    last(f).reply({
        MediaContainer: {
            Metadata: [
                {
                    key: "/library/sections/1/folder?parent=17",
                    title: "Nested & folder",
                },
            ],
        },
    });
    f.client.load(f.host.mediaRecords[0].playlist_url, () => {});
    assert.equal(parsed(f).searchParams.get("parent"), "17");
    assert.equal(last(f).options.headers["X-Plex-Container-Start"], "0");
    last(f).reply(
        '<MediaContainer><Video ratingKey="42" title="Episode" summary="&lt;script&gt;not HTML&lt;/script&gt;" type="episode"/></MediaContainer>'
    );
    assert.equal(f.host.mediaRecords[0].request.path, "/library/metadata/42");
    assert.equal(f.host.mediaRecords[0].__ottMediaSequence, true);
    assert(!f.host.mediaRecords[0].description.includes("<script>"));
});

test("catalog labels stay nonblank without exposing filesystem parents or changing paging", () => {
    const f = fixture();
    f.client.load(
        { path: "/library/sections/1/all", plexSource: source },
        () => {}
    );
    last(f).reply({
        MediaContainer: {
            Metadata: [
                {
                    name: " Name\t label ",
                    ratingKey: "1",
                    title: " \n ",
                    type: "movie",
                },
                {
                    originalTitle: " Original ",
                    ratingKey: "2",
                    titleSort: "Sort",
                    type: "movie",
                },
                { ratingKey: "3", titleSort: " Sort ", type: "movie" },
                {
                    Media: [{ Part: [{ file: "/private/parents/File.mp4" }] }],
                    ratingKey: "4",
                    type: "movie",
                },
                {
                    Media: [
                        { Part: [{ file: "C:\\private\\parents\\Other.mkv" }] },
                    ],
                    ratingKey: "5",
                    type: "movie",
                },
                {
                    Media: [
                        {
                            Part: [
                                { file: "https://host.invalid/private/token" },
                            ],
                        },
                    ],
                    ratingKey: "6",
                    type: "movie",
                },
                { key: "/library/sections/1/folder?parent=2", title: "\t" },
                { ratingKey: "7", title: "", type: "episode" },
            ],
            size: 8,
            totalSize: 9,
        },
    });
    assert.deepEqual(
        Array.from(f.host.mediaRecords, (row) => row.title),
        [
            "Browse folders",
            "Name label",
            "Original",
            "Sort",
            "File.mp4",
            "Other.mkv",
            "Untitled",
            "Untitled folder",
            "Untitled",
            "Next",
        ]
    );
    assert.equal(f.host.mediaRecords.at(-1).playlist_url.offset, 8);
    assert.equal(f.host.mediaRecords[0].__ottMediaLabel.key, "Browse folders");
    assert.equal(f.host.mediaRecords[6].__ottMediaLabel.key, "Untitled");
    assert.equal(f.host.mediaRecords[7].__ottMediaLabel.key, "Untitled folder");
    assert(
        f.host.mediaRecords.slice(1, 6).every((item) => !item.__ottMediaLabel)
    );
    assert.equal(
        f.host.mediaRecords[7].playlist_url.path,
        "/library/sections/1/folder?parent=2"
    );
    assert(!JSON.stringify(f.host.mediaRecords).includes("private"));
    f.client.load("", () => {});
    last(f).reply({
        MediaContainer: {
            Directory: [
                { key: "1", title: "  ", type: "movie" },
                { key: "2", title: "Untitled folder" },
            ],
        },
    });
    assert.equal(
        f.host.mediaRecords[0].title,
        "Untitled folder",
        "an unnamed movie library is a directory, not a playable movie"
    );
    assert.equal(f.host.mediaRecords[1].__ottMediaLabel, undefined);
    assert.equal(f.host.mediaRecords[1].title, "Untitled folder");
});

test("collection capability uses the same flat route contract as collection", () => {
    const f = fixture();
    for (const target of [
        "",
        null,
        undefined,
        { path: "/library/sections", plexSource: source },
        { offset: 200, path: "/library/sections/1/all", plexSource: source },
        { path: "/library/sections/1/folder?parent=17", plexSource: source },
        { path: "/library/metadata/42/children", plexSource: source },
    ]) {
        assert.equal(f.client.canCollect(target), true);
        const count = f.requests.length;
        let result;
        f.client.collect(target, (value) => (result = value));
        assert.equal(f.requests.length, count + 1);
        last(f).reply({ MediaContainer: { size: 0, totalSize: 0 } });
        assert.equal(result.error, undefined);
    }
    for (const target of [
        "plexsearch?search=film",
        { path: "/hubs/search", plexSource: source, query: "film" },
        { path: "/library/metadata/42", plexSource: source },
        { path: "/library/parts/1/file.mp4", plexSource: source },
        { path: "/library/sections/1/all", plexSource: "other" },
        {
            path: "/library/sections/1/all?X-Plex-Token=other",
            plexSource: source,
        },
    ]) {
        const count = f.requests.length;
        assert.equal(f.client.canCollect(target), false);
        let result;
        f.client.collect(target, (value) => (result = value));
        assert.equal(result.error, "Unable to load playlist");
        assert.equal(f.requests.length, count);
    }
});

test("movies and clips retain title filtering while episode and track sequence markers remain unchanged", () => {
    const rows = ["movie", "clip", "episode", "track"].map((type, index) => ({
        ratingKey: String(index + 1),
        title: type,
        type,
    }));
    for (const path of [
        "/library/sections/1/all",
        "/library/sections/1/folder?parent=17",
        "/library/metadata/42/children",
    ]) {
        const f = fixture();
        f.client.load({ path, plexSource: source }, () => {});
        last(f).reply({ MediaContainer: { Metadata: rows } });
        const playable = f.host.mediaRecords.filter((record) => record.request);
        assert.equal(playable.length, 4);
        assert.deepEqual(
            Array.from(playable, (record) => record.__ottMediaSequence),
            [false, false, true, true]
        );
    }
    for (const target of ["", "plexsearch?search=film"]) {
        const f = fixture();
        f.client.load(target, () => {});
        last(f).reply({ MediaContainer: { Metadata: rows } });
        const playable = f.host.mediaRecords.filter((record) => record.request);
        assert.equal(playable.length, 4);
        assert.deepEqual(
            Array.from(playable, (record) => record.__ottMediaSequence),
            [false, false, true, true]
        );
    }
});

test("collection starts at zero, deduplicates flat playable pages and does not disturb a visible load", () => {
    const f = fixture();
    f.client.load("", () => {});
    const navigation = last(f);
    const projection = f.host.mediaRecords;
    let result;
    f.client.collect(
        {
            offset: 400,
            path: "/library/sections/1/folder?parent=17",
            plexSource: source,
        },
        (value) => (result = value)
    );
    assert.equal(last(f).options.headers["X-Plex-Container-Start"], "0");
    assert.equal(parsed(f).searchParams.get("parent"), "17");
    assert.equal(navigation.aborted, false);
    last(f).reply({
        MediaContainer: {
            Metadata: [
                { ratingKey: "42", title: "Film", type: "movie" },
                { key: "/library/sections/1/folder?parent=18", title: "Child" },
                { ratingKey: "43", title: "Episode", type: "episode" },
            ],
            offset: 0,
            size: 3,
            totalSize: 5,
        },
    });
    assert.equal(result, undefined);
    assert.equal(f.host.mediaRecords, projection);
    f.tick();
    assert.equal(last(f).options.headers["X-Plex-Container-Start"], "3");
    last(f).reply({
        MediaContainer: {
            Metadata: [
                { ratingKey: "43", title: "Duplicate", type: "episode" },
                { ratingKey: "44", title: "Track", type: "track" },
            ],
            offset: 3,
            size: 2,
            totalSize: 5,
        },
    });
    assert.equal(result.error, undefined);
    assert.deepEqual(
        Array.from(result.items, (row) => row.request.path),
        ["/library/metadata/42", "/library/metadata/43", "/library/metadata/44"]
    );
    assert(
        result.items.every(
            (row) => row.stream_url === "plex:request" && !row.playlist_url
        )
    );
    assert.deepEqual(
        Array.from(result.records, (row) => row.title),
        ["Film", "Child", "Episode", "Track"]
    );
    assert.deepEqual(
        Array.from(result.items, (row) => row.__ottMediaSequence),
        [false, true, true]
    );
    assert.equal(
        result.records[1].playlist_url.path,
        "/library/sections/1/folder?parent=18"
    );
    assert.equal(
        f.requests.length,
        3,
        "does not recurse into the child directory"
    );
    navigation.reply({
        MediaContainer: {
            Directory: [{ key: "1", title: "Library", type: "movie" }],
        },
    });
    assert.equal(
        f.host.mediaRecords[0].title,
        "Library",
        "collection did not invalidate the navigation revision"
    );
});

test("complete catalog records retain deduplicated subfolders and omit synthetic navigation", () => {
    const f = fixture();
    const child = { key: "/library/metadata/10", title: "Child", type: "show" };
    let result;
    f.client.collect(
        { path: "/library/sections/1/all", plexSource: source },
        (value) => (result = value)
    );
    last(f).reply({
        MediaContainer: {
            Metadata: [
                { ratingKey: "42", title: "First", type: "movie" },
                child,
                { key: "/library/metadata/11", title: "Browse folders" },
            ],
            offset: 0,
            size: 3,
            totalSize: 6,
        },
    });
    assert.equal(result, undefined, "Never expose a partial folder");
    f.tick();
    last(f).reply({
        MediaContainer: {
            Metadata: [
                { ...child, title: "Duplicate child" },
                { ratingKey: "43", title: "Second", type: "clip" },
                { key: "/library/metadata/12", title: "Next" },
            ],
            offset: 3,
            size: 3,
            totalSize: 6,
        },
    });
    assert.equal(result.error, undefined);
    assert.deepEqual(
        Array.from(result.records, (record) => record.title),
        ["First", "Child", "Browse folders", "Second", "Next"],
        "Real folders with navigation-like titles must remain visible"
    );
    assert.deepEqual(
        Array.from(result.items, (record) => record.request.path),
        ["/library/metadata/42", "/library/metadata/43"]
    );
    const folders = result.records.filter((record) => record.playlist_url);
    assert.deepEqual(
        Array.from(folders, (record) => record.playlist_url.path),
        [
            "/library/metadata/10/children",
            "/library/metadata/11/children",
            "/library/metadata/12/children",
        ]
    );
    assert(folders.every((record) => record.playlist_url.offset === undefined));
    assert.equal(f.requests.length, 2, "Collection never visits child folders");
    assert(!JSON.stringify(result).includes(token));

    const root = fixture();
    root.client.collect("", (value) => (result = value));
    last(root).reply({
        MediaContainer: {
            Directory: [
                { key: "1", title: "Movies", type: "movie" },
                { key: "2", title: "Shows", type: "show" },
            ],
            size: 2,
            totalSize: 2,
        },
    });
    assert.equal(result.items.length, 0);
    assert.deepEqual(
        Array.from(result.records, (record) => record.title),
        ["Movies", "Shows"]
    );
    assert(
        result.records.every(
            (record) => typeof record.playlist_url === "object"
        )
    );
});

test("unknown totals require an empty terminal page and incomplete collections never return partial items", () => {
    const target = { path: "/library/sections/1/all", plexSource: source };
    const row = { ratingKey: "42", title: "Film", type: "movie" };
    const f = fixture();
    let result;
    f.client.collect(target, (value) => (result = value));
    last(f).reply({ MediaContainer: { Metadata: [row], size: 1 } });
    assert.equal(
        result,
        undefined,
        "short pages without a total do not prove completeness"
    );
    f.tick();
    assert.equal(last(f).options.headers["X-Plex-Container-Start"], "1");
    last(f).reply({ MediaContainer: { Metadata: [], size: 0 } });
    assert.equal(result.items.length, 1);
    for (const broken of [
        { Metadata: [row], offset: 0, size: 1, totalSize: 2 }, // repeated page/ignored offset
        { Metadata: [], offset: 1, size: 0, totalSize: 2 }, // promised data missing
        {
            Metadata: [{ ...row, ratingKey: "43" }],
            offset: 1,
            size: 1,
            totalSize: 3,
        }, // snapshot changes
        { Metadata: [row], offset: 1, size: 2, totalSize: 2 }, // inconsistent size
    ]) {
        const g = fixture();
        let failed;
        g.client.collect(target, (value) => (failed = value));
        last(g).reply({
            MediaContainer: {
                Metadata: [row],
                offset: 0,
                size: 1,
                totalSize: 2,
            },
        });
        g.tick();
        last(g).reply({ MediaContainer: broken });
        assert.equal(failed.error, "Unable to load playlist");
        assert.equal(failed.items.length, 0);
        assert.equal(failed.records.length, 0);
        assert.equal(g.timers.size, 0);
    }
    const g = fixture();
    let failed;
    g.client.collect(target, (value) => (failed = value));
    last(g).reply({
        MediaContainer: { Metadata: [row], size: 1, totalSize: 100001 },
    });
    assert.equal(failed.items.length, 0);
    assert.equal(failed.error, "Unable to load playlist");
});

test("collection cancellation, profile retirement and overlapping requests suppress late results", () => {
    const target = {
        path: "/library/metadata/10/children",
        plexSource: source,
    };
    const page = {
        MediaContainer: {
            Metadata: [{ ratingKey: "42", title: "Episode", type: "episode" }],
            size: 1,
            totalSize: 2,
        },
    };
    for (const method of [
        "returned",
        "dispose",
        "pagehide",
        "guard",
        "supersede",
    ]) {
        const f = fixture();
        let callbacks = 0,
            allowed = true;
        const cancel = f.client.collect(
            target,
            () => callbacks++,
            () => allowed
        );
        const request = last(f);
        if (method === "returned") cancel();
        if (method === "dispose") f.client.dispose();
        if (method === "pagehide") f.events.get("pagehide")();
        if (method === "guard") allowed = false;
        if (method === "supersede") f.client.collect(target, () => {});
        request.reply(page);
        f.tick();
        assert.equal(callbacks, 0, method);
        assert.equal(request.aborted, true, method);
    }
    const f = fixture();
    let callbacks = 0;
    const cancel = f.client.collect(target, () => callbacks++);
    last(f).reply(page);
    assert.equal(f.timers.size, 1);
    cancel();
    f.tick();
    assert.equal(f.requests.length, 1);
    assert.equal(callbacks, 0);
    assert.equal(f.host.mediaName, "untouched");
});

test("collection retries transient reads at the same offset without accepting stale pages", () => {
    for (const status of [0, 408, 429, 500, 503, 599]) {
        const f = fixture();
        const results = [];
        const row = { ratingKey: "42", title: "Film", type: "movie" };
        f.client.collect(
            { path: "/library/sections/1/all", plexSource: source },
            (value) => results.push(value)
        );
        const first = last(f);
        first.fail(status);
        first.fail(status);
        first.reply({
            MediaContainer: { Metadata: [row], size: 1, totalSize: 1 },
        });
        assert.equal(results.length, 0);
        assert.equal(f.timers.size, 1);
        f.tick();
        assert.equal(last(f).options.url, first.options.url);
        last(f).fail(status);
        f.tick();
        assert.deepEqual(f.timerDelays, [500, 1000]);
        last(f).reply({
            MediaContainer: { Metadata: [row], size: 1, totalSize: 3 },
        });
        f.tick();
        const second = last(f);
        assert.equal(second.options.headers["X-Plex-Container-Start"], "1");
        second.fail(status);
        f.tick();
        assert.equal(last(f).options.url, second.options.url);
        last(f).reply({
            MediaContainer: {
                Metadata: [row, { ...row, ratingKey: "43" }],
                offset: 1,
                size: 2,
                totalSize: 3,
            },
        });
        assert.equal(results.length, 1);
        assert.deepEqual(
            Array.from(results[0].items, (item) => item.request.path),
            ["/library/metadata/42", "/library/metadata/43"]
        );
        assert.equal(f.requests.length, 5);
        assert.equal(f.timers.size, 0);
    }
});

test("collection retry exhaustion returns no partial queue and semantic failures are terminal", () => {
    const target = { path: "/library/sections/1/all", plexSource: source };
    const f = fixture();
    const results = [];
    f.client.collect(target, (value) => results.push(value));
    last(f).reply({
        MediaContainer: {
            Metadata: [{ ratingKey: "42", title: "Film", type: "movie" }],
            size: 1,
            totalSize: 2,
        },
    });
    f.tick();
    for (let attempt = 0; attempt < 3; attempt++) {
        last(f).fail(503);
        f.tick();
    }
    assert.equal(f.requests.length, 4);
    assert.equal(results.length, 1);
    assert.equal(results[0].error, "Unable to load playlist");
    assert.equal(results[0].items.length, 0);
    for (const status of [400, 401, 403, 404, 422]) {
        const g = fixture();
        let result;
        g.client.collect(target, (value) => (result = value));
        last(g).fail(status);
        g.tick();
        assert.equal(g.requests.length, 1);
        assert.equal(result.error, "Unable to load playlist");
    }
    for (const fail of [
        (r) => r.reply("<broken"),
        (r) => r.fail(503, "parsererror"),
    ]) {
        const g = fixture();
        let result;
        g.client.collect(target, (value) => (result = value));
        fail(last(g));
        g.tick();
        assert.equal(g.requests.length, 1);
        assert.equal(result.error, "Unable to load playlist");
    }
});

test("collection cancellation owns retry timers and preserves the original deadline", () => {
    const target = { path: "/library/sections/1/all", plexSource: source };
    for (const method of [
        "returned",
        "dispose",
        "pagehide",
        "guard",
        "retire",
        "supersede",
    ]) {
        const f = fixture();
        let callbacks = 0,
            allowed = true;
        const cancel = f.client.collect(
            target,
            () => callbacks++,
            () => allowed
        );
        const first = last(f);
        first.fail(0);
        const retry = [...f.timers.values()][0];
        if (method === "returned") cancel();
        if (method === "dispose") f.client.dispose();
        if (method === "pagehide") f.events.get("pagehide")();
        if (method === "guard") allowed = false;
        if (method === "retire") f.retire();
        if (method === "supersede") f.client.collect(target, () => {});
        const count = f.requests.length;
        retry();
        first.abort();
        first.reply({ MediaContainer: { size: 0, totalSize: 0 } });
        f.tick();
        assert.equal(f.requests.length, count, method);
        assert.equal(callbacks, 0, method);
    }
    const f = fixture();
    let result;
    f.client.collect(target, (value) => (result = value));
    f.advance(118500);
    last(f).fail(0);
    f.advance(500);
    f.tick();
    assert.equal(last(f).options.timeout, 1000);
    f.advance(800);
    last(f).fail(0);
    assert.equal(f.timerDelays.at(-1), 200);
    f.advance(200);
    f.tick();
    assert.equal(result.error, "Unable to load playlist");
    assert.equal(f.requests.length, 2);
    assert.equal(f.timers.size, 0);
});

test("collection transport errors and unsupported targets fail safely without partial queues", () => {
    const f = fixture();
    let result;
    f.client.collect(
        { path: "/library/sections/1/all", plexSource: source },
        (value) => (result = value)
    );
    last(f).fail(400);
    assert.equal(result.error, "Unable to load playlist");
    assert.equal(result.items.length, 0);
    assert(!JSON.stringify(result).includes(token));
    for (const target of [
        "plexsearch?search=film",
        { path: "/hubs/search", plexSource: source, query: "film" },
        { path: "/library/parts/1/file", plexSource: source },
        { path: "/library/sections/1/all", plexSource: "other" },
    ]) {
        const count = f.requests.length;
        f.client.collect(target, (value) => (result = value));
        assert.equal(result.error, "Unable to load playlist");
        assert.equal(f.requests.length, count);
    }
});

test("collection time, page and retained data budgets fail closed", () => {
    const target = { path: "/library/sections/1/all", plexSource: source };
    const timed = fixture();
    let expired;
    timed.client.collect(target, (value) => (expired = value));
    assert.equal(last(timed).options.timeout, 30000);
    timed.advance(120001);
    last(timed).reply({ MediaContainer: { size: 0, totalSize: 0 } });
    assert.equal(expired.error, "Unable to load playlist");
    assert.equal(expired.items.length, 0);

    const paged = fixture();
    let limited;
    paged.client.collect(target, (value) => (limited = value));
    for (let attempt = 0; attempt < 2; attempt++) {
        last(paged).fail(503);
        paged.tick();
    }
    for (let index = 0; index < 1000; index++) {
        last(paged).reply({
            MediaContainer: {
                Directory: [
                    { key: "/library/metadata/" + index, title: "Folder" },
                ],
                offset: index,
                size: 1,
                totalSize: 1001,
            },
        });
        paged.tick();
    }
    assert.equal(limited.error, "Unable to load playlist");
    assert.equal(limited.items.length, 0);
    assert.equal(paged.requests.length, 1002);

    const large = fixture();
    let overflow;
    large.client.collect(target, (value) => (overflow = value));
    for (let index = 0; index < 2; index++) {
        last(large).reply({
            MediaContainer: {
                Metadata: [
                    {
                        ratingKey: String(index + 1),
                        summary: "x".repeat(5 * 1024 * 1024),
                        title: "Film",
                        type: "movie",
                    },
                ],
                offset: index,
                size: 1,
                totalSize: 2,
            },
        });
        large.tick();
    }
    assert.equal(overflow.error, "Unable to load playlist");
    assert.equal(overflow.items.length, 0);
    assert.equal(overflow.records.length, 0);
});

test("retained folder metadata shares the collection byte budget and never escapes as a partial catalog", () => {
    const f = fixture();
    let result;
    f.client.collect(
        { path: "/library/sections/1/folder?parent=17", plexSource: source },
        (value) => (result = value)
    );
    for (let index = 0; index < 2; index++) {
        last(f).reply({
            MediaContainer: {
                Directory: [
                    {
                        key:
                            "/library/sections/1/folder?parent=" + (index + 18),
                        summary: "x".repeat(5 * 1024 * 1024),
                        title: "Child " + index,
                    },
                ],
                offset: index,
                size: 1,
                totalSize: 2,
            },
        });
        f.tick();
    }
    assert.equal(result.error, "Unable to load playlist");
    assert.equal(result.records.length, 0);
    assert.equal(result.items.length, 0);
    assert.equal(f.timers.size, 0);
});

test("synchronous collection responses yield between pages and navigation cancellation stays separate", () => {
    const f = fixture();
    const pages = [];
    f.host.$.ajax = (options) => {
        const offset = Number(options.headers["X-Plex-Container-Start"]);
        pages.push(offset);
        options.success({
            MediaContainer: {
                Metadata: [
                    {
                        ratingKey: String(offset + 1),
                        title: "Film",
                        type: "movie",
                    },
                ],
                offset,
                size: 1,
                totalSize: 2,
            },
        });
        return {
            abort: () => assert.fail("completed request must not be aborted"),
        };
    };
    let result;
    f.client.collect(
        { path: "/library/sections/1/all", plexSource: source },
        (value) => (result = value)
    );
    assert.deepEqual(pages, [0]);
    f.client.cancel();
    f.tick();
    assert.deepEqual(pages, [0, 1]);
    assert.equal(result.items.length, 2);
    assert.equal(f.host.mediaName, "untouched");
});

test("search pages flattened hub media locally and metadata uses PMS pagination headers", () => {
    const f = fixture();
    f.client.load("plexsearch?search=two%20words", () => {});
    assert.equal(parsed(f).searchParams.get("query"), "two words");
    assert.equal(parsed(f).searchParams.get("limit"), "200");
    assert.equal(last(f).options.headers["X-Plex-Container-Start"], "0");
    assert.equal(last(f).options.headers["X-Plex-Container-Size"], "1000");
    last(f).reply({
        MediaContainer: {
            Hub: [
                {
                    Metadata: Array.from({ length: 200 }, (_, index) => ({
                        ratingKey: String(index + 1),
                        title: "Fixture",
                        type: "movie",
                    })),
                },
                {
                    Metadata: [
                        { ratingKey: "201", title: "Last", type: "movie" },
                    ],
                },
            ],
            size: 2,
            totalSize: 2,
        },
    });
    assert.equal(f.host.mediaRecords.length, 201);
    const next = f.host.mediaRecords.at(-1).playlist_url;
    assert.equal(next.offset, 200);
    assert.equal(next.query, "two words");
    f.client.load(next, () => {});
    assert.equal(
        f.requests.length,
        1,
        "next search page reuses one bounded hub snapshot"
    );
    assert.equal(f.host.mediaRecords.length, 1);
    assert.equal(f.host.mediaRecords[0].request.path, "/library/metadata/201");
    f.client.load(
        { offset: 200, path: "/library/sections/1/all", plexSource: source },
        () => {}
    );
    assert.equal(last(f).options.headers["X-Plex-Container-Start"], "200");
    assert.equal(last(f).options.headers["X-Plex-Container-Size"], "200");
    last(f).reply({
        MediaContainer: {
            Metadata: [{ ratingKey: "202", title: "Last", type: "movie" }],
            size: 1,
            totalSize: 202,
        },
    });
    assert.equal(f.host.mediaRecords[0].request.path, "/library/metadata/202");
    assert.equal(f.host.mediaRecords.at(-1).playlist_url.offset, 201);
});

test("stale loads, retired profiles, unsafe keys and XML failures cannot publish or leak errors", () => {
    const f = fixture();
    let completed = 0;
    f.client.load("", () => completed++);
    const stale = last(f);
    f.client.load(
        { path: "/library/sections/1/all", plexSource: source },
        () => completed++
    );
    stale.reply({
        MediaContainer: { Directory: [{ key: "1", title: "stale" }] },
    });
    assert.equal(completed, 0);
    last(f).reply("<!DOCTYPE MediaContainer><MediaContainer/>");
    assert.equal(completed, 1);
    assert(!JSON.stringify(f.messages).includes(token));
    for (const path of [
        "//attacker.invalid/library/metadata/1",
        "/library/metadata/../admin",
        "/library/metadata/%2e%2e/admin",
        "/library/metadata/42?X-Plex-Token=leaked",
    ])
        f.client.load({ path, plexSource: source }, () => {});
    assert.equal(f.requests.length, 2);
    f.client.load("", () => completed++);
    f.retire();
    last(f).reply({ MediaContainer: {} });
    assert.equal(completed, 1);
});

test("metadata resolution retries transient reads once per attempt and preserves request ownership", () => {
    for (const status of [0, 408, 429, 500, 503, 599]) {
        const f = fixture({ playback: "original" });
        const results = [];
        f.client.resolve(film, (value) => results.push(value));
        const first = last(f);
        first.fail(status);
        first.fail(status);
        first.reply(metadata());
        assert.equal(results.length, 0);
        assert.equal(f.timers.size, 1);
        f.tick();
        assert.equal(last(f).options.url, first.options.url);
        last(f).fail(status);
        f.tick();
        assert.deepEqual(f.timerDelays, [500, 1000]);
        const final = last(f);
        final.reply(metadata());
        final.fail(status);
        final.reply(metadata());
        assert.equal(f.requests.length, 3);
        assert.equal(results.length, 1);
        assert.equal(results[0].__ottNativeFile, true);
        assert.equal(f.messages.length, 0);
        assert.equal(f.timers.size, 0);
    }
    const nested = fixture();
    nested.client.resolve(film, () =>
        assert.fail("Cancelled decision cannot resolve")
    );
    last(nested).fail(0);
    nested.tick();
    last(nested).reply(metadata());
    const decision = last(nested);
    nested.client.cancel();
    assert.equal(decision.aborted, true);
});

test("metadata retry exhaustion reports one error while authentication and parse errors never retry", () => {
    const f = fixture();
    const results = [];
    f.client.resolve(film, (value) => results.push(value));
    for (let attempt = 0; attempt < 3; attempt++) {
        last(f).fail(503);
        f.tick();
    }
    assert.equal(f.requests.length, 3);
    assert.deepEqual(results, [null]);
    assert.deepEqual(f.messages, ["Plex connection failed"]);
    for (const fail of [
        ...[400, 401, 403, 404, 422].map((status) => (r) => r.fail(status)),
        (r) => r.fail(503, "parsererror"),
        (r) => r.reply("<broken"),
    ]) {
        const g = fixture();
        const outcomes = [];
        g.client.resolve(film, (value) => outcomes.push(value));
        fail(last(g));
        g.tick();
        assert.equal(g.requests.length, 1);
        assert.deepEqual(outcomes, [null]);
        assert.deepEqual(g.messages, ["Plex connection failed"]);
    }
});

test("metadata retry timers cannot revive cancelled or superseded playback", () => {
    for (const action of [
        "cancel",
        "replace",
        "retire",
        "dispose",
        "pagehide",
    ]) {
        const f = fixture({ playback: "original" });
        let callbacks = 0;
        f.client.resolve(film, () => callbacks++);
        const first = last(f);
        first.fail(0);
        const retry = [...f.timers.values()][0];
        if (action === "replace") f.client.resolve(film, () => {});
        else if (action === "retire") f.retire();
        else if (action === "pagehide") f.events.get("pagehide")();
        else f.client[action]();
        const count = f.requests.length;
        retry();
        first.abort();
        first.reply(metadata());
        f.tick();
        assert.equal(f.requests.length, count, action);
        assert.equal(callbacks, 0, action);
        assert.equal(f.messages.length, 0, action);
    }
});

test("native original admission resolves a fresh authenticated stream and persists only stable metadata", () => {
    const f = fixture({}, { native: () => "probably" });
    let played;
    f.client.resolve(film, (value) => (played = value));
    last(f).reply(metadata());
    assert.equal(f.requests.length, 1);
    assert.equal(played.__ottPlexPlayback.type, "file");
    assert.equal(played.__ottNativeFile, true);
    assert.equal(
        new URL(played.stream_url).searchParams.get("X-Plex-Token"),
        token
    );
    const saved = f.client.persist({
        ...played,
        nested: { artwork: played.stream_url, safe: "metadata" },
    });
    assert.equal(saved.stream_url, undefined);
    assert.equal(saved.__ottPlexPlayback, undefined);
    assert.equal(saved.request.path, film.request.path);
    assert.equal(saved.nested.safe, "metadata");
    assert(!JSON.stringify(saved).includes(token));
    f.client.resolve(saved, (value) => (played = value));
    last(f).reply(
        metadata({ Part: [{ key: "/library/parts/2/renewed.mp4" }] })
    );
    assert.equal(
        new URL(played.stream_url).pathname,
        "/library/parts/2/renewed.mp4"
    );
});

test("unknown native codec falls back to negotiated HLS and cancellation owns the nested decision request", () => {
    const f = fixture();
    let played = false;
    f.client.resolve(film, () => (played = true));
    last(f).reply(metadata());
    const decision = last(f);
    assert.equal(parsed(f).pathname, "/video/:/transcode/universal/decision");
    f.client.cancel();
    assert.equal(
        decision.aborted,
        true,
        "metadata completion must not clear its nested request owner"
    );
    decision.reply({ MediaContainer: { transcodeDecisionCode: 1001 } });
    assert.equal(played, false);
    assert.equal(f.intervals.size, 0);
    assert.equal(parsed(f).pathname, "/video/:/transcode/universal/stop");
});

test("resolution failures return null once so cold restore can fall back to its catalog", () => {
    const cases = [
        { item: null },
        { item: { ...film, plexSource: "another-account" } },
        { item: { ...film, request: { path: "/library/metadata/../admin" } } },
        { reply: { MediaContainer: {} } },
        { reply: metadata({ Part: [] }) },
        {
            reply: metadata({
                Part: [{ key: "https://foreign.invalid/file" }],
            }),
        },
        { reply: "<!DOCTYPE MediaContainer><MediaContainer/>" },
        { fail: true },
        { decision: { MediaContainer: { transcodeDecisionCode: 2001 } } },
        { decision: "<broken" },
        { decisionFail: true },
    ];
    for (const scenario of cases) {
        const f = fixture();
        const resolved = [];
        f.client.resolve(
            Object.hasOwn(scenario, "item") ? scenario.item : film,
            (value) => resolved.push(value)
        );
        if (Object.hasOwn(scenario, "item")) {
            assert.equal(f.requests.length, 0);
        } else {
            const metadataRequest = last(f);
            if (scenario.fail) metadataRequest.fail(401);
            else if (scenario.decision || scenario.decisionFail) {
                metadataRequest.reply(metadata());
                const decision = last(f);
                if (scenario.decisionFail) decision.fail();
                else decision.reply(scenario.decision);
                assert.equal(
                    parsed(f).pathname,
                    "/video/:/transcode/universal/stop"
                );
                decision.fail();
                decision.reply({
                    MediaContainer: { transcodeDecisionCode: 1001 },
                });
            } else metadataRequest.reply(scenario.reply);
            metadataRequest.fail();
            metadataRequest.reply(metadata());
        }
        assert.deepEqual(resolved, [null]);
        assert.deepEqual(f.messages, ["Plex connection failed"]);
        assert.equal(f.intervals.size, 0);
        assert(!JSON.stringify(f.messages).includes(token));
        assert.equal(f.host.mediaName, "untouched");
        assert.deepEqual(f.host.mediaRecords, ["untouched"]);
    }
});

test("resolution fallback cannot run after cancellation, replacement, retirement or reentrant navigation", () => {
    for (const decisionStage of [false, true]) {
        for (const action of [
            "cancel",
            "replace",
            "retire",
            "dispose",
            "pagehide",
        ]) {
            const f = fixture();
            let callbacks = 0;
            f.client.resolve(film, () => callbacks++);
            if (decisionStage) last(f).reply(metadata());
            const pending = last(f);
            if (action === "replace") f.client.load("", () => {});
            else if (action === "retire") f.retire();
            else if (action === "pagehide") f.events.get("pagehide")();
            else f.client[action]();
            pending.fail();
            pending.reply(
                decisionStage
                    ? { MediaContainer: { transcodeDecisionCode: 2001 } }
                    : { MediaContainer: {} }
            );
            assert.equal(callbacks, 0, action);
            assert.equal(f.messages.length, 0, action);
            assert.equal(f.intervals.size, 0, action);
        }
    }
    const f = fixture();
    let callbacks = 0;
    f.host.infoBox = () => f.retire();
    f.client.resolve(film, () => callbacks++);
    last(f).fail(401);
    assert.equal(
        callbacks,
        0,
        "the visible failure retired the source before fallback"
    );
});

test("resolution failure releases its owned wait before the error and retains cancellation guards", () => {
    for (const cancel of [false, true]) {
        const f = fixture(),
            events = [];
        const done = (value) => events.push(value);
        done.beforeError = () => {
            events.push("release wait");
            if (cancel) f.client.cancel();
        };
        f.host.infoBox = () => events.push("visible error");
        f.client.resolve(film, done);
        last(f).fail(401);
        assert.deepEqual(
            events,
            cancel ? ["release wait"] : ["release wait", "visible error", null]
        );
    }
});

test("HEVC HLS preserves source resolution only when the actual MSE codec is supported", () => {
    for (const [supported, hls] of [
        [false, true],
        [true, false],
        [true, true],
    ]) {
        const f = fixture({}, { hls, mse: () => supported });
        let played;
        f.client.resolve(film, (value) => {
            played = value;
        });
        last(f).reply(
            metadata({
                audioCodec: "opus",
                container: "mkv",
                height: 2160,
                videoCodec: "hevc",
                width: 3840,
            })
        );
        assert.equal(
            parsed(f).searchParams.get("videoResolution"),
            supported && hls ? "3840x2160" : "1920x1080"
        );
        assert.equal(
            parsed(f).searchParams.has("X-Plex-Client-Profile-Extra"),
            supported && hls
        );
        if (supported && hls)
            assert.equal(
                parsed(f).searchParams.get("X-Plex-Client-Profile-Extra"),
                "add-transcode-target(type=videoProfile&context=streaming&protocol=hls&container=mp4&videoCodec=h264,hevc&audioCodec=aac&replace=true)"
            );
        last(f).reply({ MediaContainer: { transcodeDecisionCode: 1001 } });
        assert.equal(
            played.__ottPlexPlayback.engine,
            supported && hls ? "mse" : undefined
        );
        f.client.dispose();
    }
});

test("HLS heartbeat survives browsing, never overlaps, stops on replacement and cannot revive disposed playback", () => {
    const f = fixture();
    let played;
    f.client.resolve(film, (item) => (played = item));
    last(f).reply(metadata());
    const id = parsed(f).searchParams.get("session");
    last(f).reply({ MediaContainer: { transcodeDecisionCode: 1001 } });
    assert.equal(played.__ottPlexPlayback.type, "hls");
    assert.equal(new URL(played.stream_url).searchParams.get("session"), id);
    const timer = [...f.intervals.values()][0];
    assert.equal(timer.delay, 30000);
    f.client.load("", () => {});
    last(f).reply({ MediaContainer: {} });
    timer.run();
    const ping = last(f);
    const count = f.requests.length;
    timer.run();
    assert.equal(f.requests.length, count);
    f.client.stop("https://unrelated.invalid/video");
    assert.equal(f.intervals.size, 1);
    f.client.resolve(film, () => {});
    assert.equal(ping.aborted, true);
    assert.equal(f.intervals.size, 0);
    assert.equal(parsed(f).pathname, "/video/:/transcode/universal/stop");
    assert.equal(parsed(f).searchParams.get("session"), id);
    last(f).reply("");
    assert.equal(parsed(f).pathname, "/library/metadata/42");
    f.client.dispose();
    const disposed = f.requests.length;
    timer.run();
    assert.equal(f.requests.length, disposed);
});

test("explicit Original bypasses uncertain probes and connection failures expose fixed text only", () => {
    const f = fixture({ playback: "original" });
    let played;
    f.client.resolve(film, (item) => (played = item));
    last(f).reply(
        metadata({ audioCodec: "opus", container: "mkv", videoCodec: "hevc" })
    );
    assert.equal(played.__ottPlexPlayback.mime, "video/x-matroska");
    assert.equal(f.requests.length, 1);
    let error;
    f.client.connect((message) => (error = message));
    last(f).fail(401);
    assert.equal(error, "Plex connection failed");
    assert(!JSON.stringify(f.messages).includes(token));
});

test("pagehide releases only its owned session with a credential-free keepalive GET and dispose removes handler", () => {
    const f = fixture();
    f.client.resolve(film, () => {});
    last(f).reply(metadata());
    const session = parsed(f).searchParams.get("session");
    last(f).reply({ MediaContainer: { transcodeDecisionCode: 1001 } });
    const before = f.requests.length;
    f.events.get("pagehide")();
    assert.equal(f.intervals.size, 0);
    assert.equal(f.requests.length, before);
    assert.equal(f.keepalive.length, 1);
    assert.equal(
        new URL(f.keepalive[0].url).pathname,
        "/video/:/transcode/universal/stop"
    );
    assert.equal(
        new URL(f.keepalive[0].url).searchParams.get("session"),
        session
    );
    assert.equal(f.keepalive[0].options.credentials, "omit");
    assert.equal(f.keepalive[0].options.keepalive, true);
    assert.equal(f.keepalive[0].options.method, "GET");
    f.events.get("pagehide")();
    assert.equal(f.keepalive.length, 1);
    f.client.dispose();
    assert.equal(f.events.has("pagehide"), false);
});
test("pagehide releases Plex before an earlier queue stop listener and removes the same capture listener", () => {
    const dom = new JSDOM();
    const target = dom.window;
    let f;
    target.addEventListener("pagehide", () => f.client.stop());
    let handler;
    let calls = 0;
    const eventTarget = {
        addEventListener(event, listener, capture) {
            handler = () => {
                calls++;
                listener();
            };
            target.addEventListener(event, handler, capture);
        },
        removeEventListener(event, _listener, capture) {
            target.removeEventListener(event, handler, capture);
        },
    };
    f = fixture({}, { eventTarget });
    f.client.resolve(film, () => {});
    last(f).reply(metadata());
    last(f).reply({ MediaContainer: { transcodeDecisionCode: 1001 } });
    const before = f.requests.length;
    target.dispatchEvent(new target.Event("pagehide"));
    assert.equal(f.keepalive.length, 1);
    assert.equal(f.requests.length, before, "No unload stop XHR is issued");
    assert.equal(f.intervals.size, 0);
    target.dispatchEvent(new target.Event("pagehide"));
    assert.equal(
        f.keepalive.length,
        1,
        "The released session cannot stop twice"
    );
    assert.equal(calls, 2);
    f.client.dispose();
    target.dispatchEvent(new target.Event("pagehide"));
    assert.equal(calls, 2, "Dispose removes the capture listener");
    dom.window.close();
});

test("cursor rows are explicit and selected folder titles override generic server labels", () => {
    const f = fixture();
    f.client.load(
        {
            path: "/library/sections/1/folder?parent=9",
            plexSource: source,
            title: "Actual folder",
        },
        () => {}
    );
    last(f).reply({
        MediaContainer: {
            Directory: [
                { key: "/library/sections/1/folder?parent=10", title: "Next" },
            ],
            size: 1,
            title1: "Folder",
            title2: "Folder",
            totalSize: 2,
        },
    });
    assert.equal(f.host.mediaName, "Actual folder");
    assert.equal(f.host.mediaRecords[0].__ottMediaNext, undefined);
    const next = f.host.mediaRecords[1];
    assert.equal(next.__ottMediaNext, true);
    assert.equal(next.playlist_url.title, "Actual folder");
    let following;
    f.client.page(next.playlist_url, (value) => (following = value));
    last(f).reply({
        MediaContainer: {
            Directory: [
                {
                    key: "/library/sections/1/folder?parent=11",
                    title: "Same name",
                },
                {
                    key: "/library/sections/1/folder?parent=12",
                    title: "Same name",
                },
            ],
            offset: 1,
            size: 2,
            totalSize: 3,
        },
    });
    assert.equal(following.items.length, 2);
    assert.notEqual(
        following.items[0].playlist_url.path,
        following.items[1].playlist_url.path
    );
    assert(!following.items.some((row) => row.__ottMediaNext));
    f.client.collect(
        { path: "/library/sections/1/all", plexSource: source },
        (value) => {
            assert(!value.records.some((row) => row.__ottMediaNext));
        }
    );
    last(f).reply({
        MediaContainer: {
            Metadata: [{ ratingKey: "1", title: "Film", type: "movie" }],
            size: 1,
            totalSize: 1,
        },
    });
});

test("unknown catalog totals retain quiet pagination through full pages and stop at short or empty pages", () => {
    for (const total of [200, 403]) {
        const f = fixture();
        const route = {
            path: "/library/metadata/10/children",
            plexSource: source,
            title: "Episodes",
        };
        function reply(offset) {
            last(f).reply({
                MediaContainer: {
                    Metadata: Array.from(
                        { length: Math.min(200, total - offset) },
                        (_, i) => ({
                            ratingKey: String(offset + i + 1),
                            title: "Episode " + (offset + i + 1),
                            type: "episode",
                        })
                    ),
                    offset,
                },
            });
        }
        f.client.load(route, () => {});
        reply(0);
        let rows = f.host.mediaRecords;
        const initial = JSON.stringify(rows);
        const ids = [];
        for (let step = 0; step < 4; step++) {
            ids.push(
                ...rows
                    .filter((row) => row.request)
                    .map((row) => row.request.path)
            );
            const cursor = rows.find((row) => row.__ottMediaNext);
            if (!cursor) break;
            assert.equal(cursor.playlist_url.offset, ids.length);
            f.client.page(cursor.playlist_url, (result) => {
                assert.equal(result.error, undefined);
                rows = result.items;
            });
            reply(cursor.playlist_url.offset);
        }
        assert.equal(ids.length, total);
        assert.equal(new Set(ids).size, total);
        assert.equal(
            rows.some((row) => row.__ottMediaNext),
            false
        );
        assert.equal(f.requests.length, Math.floor(total / 200) + 1);
        assert.equal(JSON.stringify(f.host.mediaRecords), initial);
    }
});

test("unknown-total cursors preserve offset and size guards and cannot grow beyond the catalog bound", () => {
    const route = {
        offset: 200,
        path: "/library/metadata/10/children",
        plexSource: source,
    };
    const rows = Array.from({ length: 200 }, (_, i) => ({
        ratingKey: String(i + 1),
        title: "Episode " + i,
        type: "episode",
    }));
    for (const response of [
        { Metadata: rows, offset: 0 },
        { Metadata: rows.concat(rows[0]), offset: 200 },
    ]) {
        const f = fixture();
        let result;
        f.client.page(route, (value) => (result = value));
        last(f).reply({ MediaContainer: response });
        assert(result.error);
        assert.equal(result.items.length, 0);
    }
    for (const response of [
        { Metadata: rows, offset: 200, size: 0 },
        { Metadata: rows, offset: 200, size: 201 },
        { Metadata: rows, offset: 99800 },
    ]) {
        const f = fixture();
        let result;
        f.client.page(
            { ...route, offset: response.offset },
            (value) => (result = value)
        );
        last(f).reply({ MediaContainer: response });
        assert.equal(
            result.items.some((row) => row.__ottMediaNext),
            false
        );
    }
});

test("quiet pages do not mutate navigation or cancel resolve and full collection", () => {
    const f = fixture({ playback: "original" });
    const target = {
        offset: 200,
        path: "/library/sections/1/all",
        plexSource: source,
        title: "Chosen folder",
    };
    let paged, played, collected;
    f.client.page(target, (value) => (paged = value));
    const page = last(f);
    assert.equal(page.options.headers["X-Plex-Container-Start"], "200");
    assert.equal(page.options.headers["X-Plex-Container-Size"], "200");
    f.client.resolve(film, (value) => (played = value));
    const resolve = last(f);
    f.client.collect({ ...target, offset: 0 }, (value) => (collected = value));
    const collect = last(f);
    page.reply({
        MediaContainer: {
            Metadata: [{ ratingKey: "43", title: "Following", type: "movie" }],
            offset: 200,
            size: 1,
            title2: "Folder",
            totalSize: 202,
        },
    });
    resolve.reply(metadata());
    collect.reply({ MediaContainer: { Metadata: [], size: 0, totalSize: 0 } });
    assert.equal(paged.items[0].request.path, "/library/metadata/43");
    assert.equal(paged.items[1].__ottMediaNext, true);
    assert.equal(paged.items[1].playlist_url.title, "Chosen folder");
    assert(played.stream_url);
    assert.equal(collected.items.length, 0);
    assert(!page.aborted && !resolve.aborted && !collect.aborted);
    assert.deepEqual(f.host.mediaRecords, ["untouched"]);
    assert.equal(f.host.mediaName, "untouched");
    assert.deepEqual(f.messages, []);
});

test("page errors are terminal and sanitized while cancellation or source retirement suppress late callbacks", () => {
    const target = {
        offset: 200,
        path: "/library/sections/1/all",
        plexSource: source,
    };
    for (const action of [
        "cancel",
        "supersede",
        "dispose",
        "pagehide",
        "retire",
    ]) {
        const f = fixture();
        let callbacks = 0;
        const cancel = f.client.page(target, () => callbacks++);
        const pending = last(f);
        if (action === "cancel") cancel();
        if (action === "supersede") f.client.page(target, () => {});
        if (action === "dispose") f.client.dispose();
        if (action === "pagehide") f.events.get("pagehide")();
        if (action === "retire") f.retire();
        pending.reply({ MediaContainer: {} });
        pending.fail();
        assert.equal(callbacks, 0, action);
        if (action !== "retire") assert(pending.aborted, action);
        assert.deepEqual(f.messages, []);
    }
    for (const reply of [
        null,
        "invalid " + token,
        { MediaContainer: { Metadata: [], offset: 0 } },
    ]) {
        const f = fixture();
        const values = [];
        f.client.page(target, (value) => values.push(value));
        if (reply === null) last(f).fail();
        else last(f).reply(reply);
        last(f).fail();
        assert.equal(values.length, 1);
        assert.equal(values[0].items.length, 0);
        assert(values[0].error);
        assert(!JSON.stringify(values).includes(token));
        assert.deepEqual(f.messages, []);
    }
    const retired = fixture();
    retired.client.dispose();
    retired.client.page(target, () => assert.fail("disposed page callback"));
    assert.equal(retired.requests.length, 0);
});

test("independent search paging reuses the flattened snapshot without publishing globals", () => {
    const f = fixture();
    f.client.load("plexsearch?search=Find", () => {});
    last(f).reply({
        MediaContainer: {
            Hub: [
                {
                    Metadata: Array.from({ length: 205 }, (_, i) => ({
                        ratingKey: String(i),
                        title: "Found " + i,
                        type: "movie",
                    })),
                },
            ],
        },
    });
    const before = JSON.stringify(f.host.mediaRecords);
    const cursor = f.host.mediaRecords.find(
        (row) => row.__ottMediaNext
    ).playlist_url;
    let result;
    f.client.page(cursor, (value) => (result = value));
    assert.equal(result.items.length, 5);
    assert(!result.items.some((row) => row.__ottMediaNext));
    assert.equal(f.requests.length, 1);
    assert.equal(JSON.stringify(f.host.mediaRecords), before);
});

test("page abort reentry preserves the newer page and never dispatches the interrupted request", () => {
    const f = fixture();
    const target = {
        offset: 200,
        path: "/library/sections/1/all",
        plexSource: source,
    };
    f.client.page(target, () => assert.fail("old page"));
    const old = last(f);
    const abort = old.abort.bind(old);
    let latest;
    old.abort = () => {
        abort();
        f.client.page({ ...target, offset: 600 }, (value) => (latest = value));
    };
    f.client.page({ ...target, offset: 400 }, () =>
        assert.fail("interrupted page")
    );
    assert.equal(f.requests.length, 2);
    assert.equal(parsed(f).searchParams.get("X-Plex-Container-Start"), "600");
    last(f).reply({ MediaContainer: { offset: 600, size: 0, totalSize: 600 } });
    assert.equal(latest.items.length, 0);
});

test("profile folders reject unsafe roots and normalize duplicate selections", () => {
    const f = fixture();
    const base = { address: "https://plex.invalid", token };
    for (const path of [
        "/library/sections",
        "https://other.invalid/x",
        "/library/parts/1/file",
        "/library/sections/1/all?X-Plex-Token=secret",
        "/library/sections/1/all?type=11",
        "/library/sections/1/all?type=100",
        "/library/sections/1/folder?parent=../2",
        "/library/metadata/4",
    ]) {
        assert.equal(
            f.api.normalizePlexConfig({
                ...base,
                folders: [{ path, title: "A" }],
            }),
            null
        );
    }
    const root = { path: "/library/sections/1/all?type=4", title: " A\nB " };
    const normalized = f.api.normalizePlexConfig({
        ...base,
        folders: [root, root],
    });
    assert.deepEqual(JSON.parse(JSON.stringify(normalized.folders)), [
        { ...root, title: "A B" },
    ]);
    for (const type of [1, 3, 4, 10]) {
        const path = "/library/sections/1/all?type=" + type;
        assert.equal(
            f.api.normalizePlexConfig({
                ...base,
                folders: [{ path, title: "Selected" }],
            }).folders[0].path,
            path
        );
    }
    assert.equal(f.api.normalizePlexConfig({ ...base, folders: "all" }), null);
});

function scanRow(id, title = "Film " + id) {
    return { ratingKey: String(id), title, type: "episode" };
}

test("selected folders publish before traversal finishes, flatten descendants and deduplicate overlapping roots", () => {
    const f = fixture(),
        batches = [],
        errors = [];
    f.client.scanFolders(
        [
            { path: "/library/sections/1/folder?parent=10", title: "Selected" },
            {
                path: "/library/metadata/20/children",
                title: "Overlapping child",
            },
        ],
        (rows, scanned) => batches.push({ rows, scanned }),
        (error) => errors.push(error)
    );
    assert.equal(parsed(f).pathname, "/library/sections/1/folder");
    last(f).reply({
        MediaContainer: {
            Metadata: [
                { ...scanRow(1), adult: "1" },
                {
                    key: "/library/metadata/20/children",
                    title: "Child",
                    type: "season",
                },
            ],
            size: 2,
            totalSize: 2,
        },
    });
    assert.equal(batches.length, 1);
    assert.equal(batches[0].rows[0].request.path, "/library/metadata/1");
    assert.equal(batches[0].rows[0].adult, 1);
    assert.equal(
        errors.length,
        0,
        "first playable file is available while descendants are pending"
    );
    f.tick(5000);
    assert.equal(parsed(f).pathname, "/library/metadata/20/children");
    last(f).reply({
        MediaContainer: {
            Metadata: [scanRow(1), scanRow(2)],
            size: 2,
            totalSize: 2,
        },
    });
    f.tick(5000);
    assert.equal(
        f.requests.length,
        2,
        "overlapping selected child is fetched once"
    );
    assert.deepEqual(
        batches.flatMap((batch) =>
            Array.from(batch.rows, (row) => row.request.path)
        ),
        ["/library/metadata/1", "/library/metadata/2"]
    );
    assert.deepEqual(errors, [undefined]);
    assert.equal(batches[1].rows[0].adult, 0);
    assert(
        !f.requests.some(
            (request) =>
                new URL(request.options.url).pathname === "/library/sections"
        ),
        "unselected libraries are never enumerated"
    );
});

test("profile scan pagination and playback resolution have independent ownership", () => {
    const f = fixture({ playback: "original" }),
        rows = [],
        complete = [];
    f.client.scanFolders(
        [{ path: "/library/sections/1/all?type=4", title: "Shows" }],
        (items) => rows.push(...items),
        (error) => complete.push(error)
    );
    const scan = last(f);
    let playback;
    f.client.resolve(film, (result) => (playback = result));
    const resolution = last(f);
    assert.equal(scan.aborted, false);
    scan.reply({
        MediaContainer: {
            Metadata: Array.from({ length: 200 }, (_, index) =>
                scanRow(index + 1)
            ),
            size: 200,
            totalSize: 201,
        },
    });
    assert.equal(rows.length, 200);
    assert.equal(resolution.aborted, false);
    resolution.reply(metadata());
    assert(playback.stream_url);
    f.tick(5000);
    assert.equal(parsed(f).searchParams.get("X-Plex-Container-Start"), "200");
    last(f).reply({
        MediaContainer: {
            Metadata: [scanRow(201)],
            offset: 200,
            size: 1,
            totalSize: 201,
        },
    });
    f.tick(5000);
    assert.equal(rows.length, 201);
    assert.deepEqual(complete, [undefined]);
});

test("missing roots and malformed repeated pages surface errors without admitting unselected content", () => {
    const f = fixture(),
        rows = [],
        errors = [];
    f.client.scanFolders(
        [{ path: "/library/sections/9/all?type=1", title: "Deleted" }],
        (batch) => rows.push(...batch),
        (error) => errors.push(error)
    );
    last(f).fail(404);
    assert.deepEqual(errors, ["Plex connection failed"]);
    assert.equal(rows.length, 0);
    f.client.scanFolders(
        [{ path: "/library/sections/1/all?type=4", title: "A" }],
        (batch) => rows.push(...batch),
        (error) => errors.push(error)
    );
    const page = Array.from({ length: 200 }, (_, index) => scanRow(index + 1));
    last(f).reply({ MediaContainer: { Metadata: page, size: 200 } });
    f.tick(5000);
    last(f).reply({
        MediaContainer: { Metadata: page, offset: 200, size: 200 },
    });
    assert.equal(rows.length, 200);
    assert.equal(errors.at(-1), "Invalid Plex response");
});

test("profile scan replacement, disposal, retirement and retry cancellation suppress old batches", () => {
    for (const action of ["replace", "dispose", "retire", "cancel"]) {
        const f = fixture();
        let calls = 0;
        const args = [
            [{ path: "/library/sections/1/all?type=4", title: "A" }],
            () => calls++,
            () => calls++,
        ];
        const cancel = f.client.scanFolders(...args);
        const pending = last(f);
        if (action === "replace") f.client.scanFolders(...args);
        else if (action === "dispose") f.client.dispose();
        else if (action === "retire") f.retire();
        else cancel();
        pending.reply({ MediaContainer: { Metadata: [scanRow(1)], size: 1 } });
        assert.equal(calls, 0, action);
    }
    const f = fixture();
    let calls = 0;
    const cancel = f.client.scanFolders(
        [{ path: "/library/sections/1/all?type=4", title: "A" }],
        () => calls++,
        () => calls++
    );
    last(f).fail(503);
    cancel();
    f.tick(5000);
    assert.equal(f.requests.length, 1);
    assert.equal(calls, 0);
});

test("profile folder picker separates selecting a library from browsing its filesystem roots", () => {
    const f = fixture();
    f.client.connect(() => {});
    last(f).reply({
        MediaContainer: {
            Directory: [
                { key: "1", title: "Shows", type: "show" },
                { key: "2", title: "Movies", type: "movie" },
            ],
        },
    });
    let result;
    f.client.folderChoices(null, (value) => (result = value));
    if (!result)
        last(f).reply({
            MediaContainer: {
                Directory: [
                    { key: "1", title: "Shows", type: "show" },
                    { key: "2", title: "Movies", type: "movie" },
                ],
            },
        });
    assert.equal(result.items[0].path, "/library/sections/1/all?type=4");
    assert.equal(result.items[0].browse.path, "/library/sections/1/folder");
    assert.equal(result.items[1].path, "/library/sections/2/all?type=1");
    assert.equal(
        result.items.length,
        2,
        "search is supplied by the standard channel Actions menu"
    );
});

test("selecting an artist library saves a track root and scans playable tracks in JSON and XML", () => {
    for (const response of [
        {
            MediaContainer: {
                Metadata: [{ ratingKey: "42", title: "Song", type: "track" }],
                size: 1,
                totalSize: 1,
            },
        },
        '<MediaContainer size="1" totalSize="1"><Track ratingKey="42" title="Song" type="track"/></MediaContainer>',
    ]) {
        const f = fixture();
        const libraries = {
            MediaContainer: {
                Directory: [{ key: "3", title: "Music", type: "artist" }],
            },
        };
        f.client.connect(() => {});
        last(f).reply(libraries);
        let choice;
        f.client.folderChoices(null, (result) => (choice = result.items[0]));
        if (!choice) last(f).reply(libraries);
        assert.equal(choice.path, "/library/sections/3/all?type=10");
        assert.equal(choice.browse.path, "/library/sections/3/folder");
        const config = f.api.normalizePlexConfig({
            address: "https://plex.invalid",
            folders: [choice],
            token,
        });
        assert(
            config,
            "a selected music library must survive profile validation"
        );
        const tracks = [],
            completions = [];
        f.client.scanFolders(
            config.folders,
            (rows) => tracks.push(...rows),
            (error) => completions.push(error)
        );
        assert.equal(parsed(f).pathname, "/library/sections/3/all");
        assert.equal(parsed(f).searchParams.get("type"), "10");
        last(f).reply(response);
        f.tick(5000);
        assert.deepEqual(completions, [undefined]);
        assert.equal(tracks.length, 1);
        assert.equal(tracks[0].request.path, "/library/metadata/42");
        assert.equal(tracks[0].stream_url, "plex:request");
        assert.equal(tracks[0].__ottMediaSequence, true);
        assert.equal(tracks[0].title, "Song");
    }
});

test("profile scan follows capped short pages without totals until an empty terminal page", () => {
    const f = fixture(),
        rows = [],
        completions = [];
    f.client.scanFolders(
        [{ path: "/library/sections/1/all?type=4", title: "A" }],
        (batch) => rows.push(...batch),
        (error) => completions.push(error)
    );
    last(f).reply({
        MediaContainer: { Metadata: [scanRow(1), scanRow(2)], size: 2 },
    });
    f.tick(5000);
    assert.equal(parsed(f).searchParams.get("X-Plex-Container-Start"), "2");
    last(f).reply({ MediaContainer: { Metadata: [scanRow(3)], size: 1 } });
    assert.equal(completions.length, 0);
    f.tick(5000);
    assert.equal(parsed(f).searchParams.get("X-Plex-Container-Start"), "3");
    last(f).reply({ MediaContainer: { Metadata: [], size: 0 } });
    f.tick(5000);
    assert.equal(rows.length, 3);
    assert.deepEqual(completions, [undefined]);
});

test("profile scan watchdog aborts a stalled transport and late responses cannot revive it", () => {
    const f = fixture();
    let batches = 0;
    const errors = [];
    f.client.scanFolders(
        [{ path: "/library/sections/1/all?type=4", title: "A" }],
        () => batches++,
        (error) => errors.push(error)
    );
    const pending = last(f);
    f.tick(60000);
    assert.equal(pending.aborted, true);
    assert.deepEqual(errors, ["Plex source did not respond"]);
    pending.reply({ MediaContainer: { Metadata: [scanRow(1)], size: 1 } });
    assert.equal(batches, 0);
});

console.log(`PASS Plex client (${passed} scenarios)`);
