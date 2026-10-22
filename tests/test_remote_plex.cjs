const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const acorn = require("acorn");
const { fixture, sourceFunctions } = require("./test_port_vod.cjs");
const plain = (x) => JSON.parse(JSON.stringify(x));
const contract = JSON.parse(
    fs.readFileSync("contracts/plex-queue-v1.json", "utf8")
);
function compile(file) {
    const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES5,
        },
    }).outputText;
    acorn.parse(code, { ecmaVersion: 5 });
    return code;
}
const remotePlexCode = compile("src/commands/remote-plex.ts");
function setup() {
    const c = fixture();
    let now = 1700000000000;
    c.Date = class extends Date {
        static now() {
            return now;
        }
    };
    const module_ = {};
    vm.runInNewContext(remotePlexCode, { Date: c.Date, exports: module_ });
    const timers = new Map();
    c.setTimeout = (fn, ms) => {
        const key = {};
        timers.set(key, { fn, ms });
        return key;
    };
    c.clearTimeout = (key) => timers.delete(key);
    c.addEventListener = () => {};
    c.removeEventListener = () => {};
    c.stored.plexcfg = JSON.stringify({
        address: "https://plex.invalid",
        playback: "original",
        token: "synthetic-only",
    });
    c.stbGetItem = (key) => c.stored[key] || null;
    c.__ottPlexAuth = { routing: () => null };
    c.p_pref = "m3u";
    c.commandChannelsReady = true;
    c.__ottActiveProviderDriver = { id: "m3u" };
    c.sPSchannels = 1;
    c.parentPIN = "1234";
    c.parentAccess = false;
    c.__ottParental = { needs: () => true };
    const requests = [];
    c.$.ajax = (options) => {
        const req = {
            ...options,
            abort() {
                this.aborted = true;
            },
            aborted: false,
        };
        requests.push(req);
        return req;
    };
    vm.runInNewContext(compile("src/plugins/plex.ts"), c);
    vm.runInNewContext(compile("src/plugins/plex-queue.ts"), c);
    const queue = module_.remotePlexQueue(c, "runtime-fixture");
    function call(op, ids, extra = {}) {
        const result = { replies: [] };
        result.cancel = queue.execute(
            {
                params: {
                    op,
                    runtime: "runtime-fixture",
                    ...(ids ? { ids } : {}),
                    ...extra,
                },
            },
            (r) => result.replies.push(plain(r))
        );
        return result;
    }
    function library(op, selector = {}, extra = {}) {
        const result = { replies: [] };
        result.cancel = queue.execute(
            {
                action: "plex_library",
                params: {
                    op,
                    runtime: "runtime-fixture",
                    ...selector,
                    ...extra,
                },
            },
            (r) => result.replies.push(plain(r))
        );
        return result;
    }
    function page(rows, offset = 0, total = rows.length, directories = false) {
        const req = requests.shift();
        assert(req, "Expected an owned page request");
        req.success({
            MediaContainer: {
                [directories ? "Directory" : "Metadata"]: rows,
                offset,
                size: rows.length,
                ...(total === null ? {} : { totalSize: total }),
            },
        });
        if (req.complete) req.complete();
        return req;
    }
    function tickPage() {
        const row = [...timers].find(([, timer]) => timer.ms === 0);
        assert(row, "Expected a pagination yield");
        timers.delete(row[0]);
        row[1].fn();
    }
    function reply(items = []) {
        const request = requests.shift();
        assert(request, "Expected a Plex request");
        request.success({ MediaContainer: { Metadata: items } });
        if (request.complete) request.complete();
        return request;
    }
    const item = (id, title = "Film " + id) => ({
        Media: [
            {
                container: "mp4",
                Part: [{ key: "/library/parts/" + id + "/file.mp4" }],
            },
        ],
        ratingKey: id,
        title,
        type: "movie",
    });
    function prepare(ids) {
        reply();
        reply(
            ids
                .slice()
                .reverse()
                .map((id) => item(id))
        );
    }
    function resolve(id) {
        reply([item(id)]);
    }
    function end() {
        c.__ottClassicPlayback.command({ type: "stop" });
        c.__ottMedia.ended(c.__ottClassicPlayback.snapshot().generation);
    }
    return {
        advance(ms) {
            now += ms;
        },
        c,
        call,
        end,
        item,
        library,
        page,
        prepare,
        queue,
        reply,
        requests,
        resolve,
        tickPage,
        timers,
    };
}
let groups = 0;
function test(name, fn) {
    fn();
    groups++;
    console.log("PASS " + name);
}
test("explicit saved Plex queue preserves provider until preflight, starts at zero, advances exactly and stops", () => {
    const h = setup();
    const ids = ["78777", "78776", "78775"];
    const originalProvider = h.c.__ottActiveProviderDriver;
    const saved = h.c.stored.plexcfg;
    const preview = { ch_id: "preview-tv" };
    h.c.previewChan = preview;
    h.c.previewTimer = h.c.setTimeout(() => {}, 500);
    const close = h.c.closeList;
    const closed = [];
    h.c.closeList = (restorePip) => {
        closed.push(restorePip);
        assert.equal(h.c.previewChan, null);
        if (typeof close === "function") close(restorePip);
    };
    const request = h.call("play", ids);
    assert.equal(h.c.previewChan, preview);
    assert.equal(h.timers.has(h.c.previewTimer), true);
    assert.equal(h.queue.snapshot().state, "preparing");
    assert.equal(h.c.calls.filter((x) => x[0] === "play").length, 0);
    h.prepare(ids);
    assert.equal(h.c.calls.filter((x) => x[0] === "play").length, 0);
    h.resolve(ids[0]);
    assert.equal(request.replies[0].status, "ok");
    assert.deepEqual(closed, [false]);
    assert.equal(h.timers.has(h.c.previewTimer), false);
    assert.equal(h.queue.snapshot().state, "playing");
    assert.equal(h.queue.snapshot().index, 0);
    assert.equal(h.c.__ottClassicPlayback.snapshot().position, 0);
    h.c.__ottMedia.cycleRepeat();
    h.c.__ottMedia.toggleShuffle();
    assert.equal(h.c.__ottMedia.current().sequence.repeat, "off");
    h.end();
    h.resolve(ids[1]);
    assert.equal(h.queue.snapshot().index, 1);
    h.end();
    h.resolve(ids[2]);
    assert.equal(h.queue.snapshot().index, 2);
    h.end();
    assert.equal(h.queue.snapshot().state, "ended");
    assert.equal(h.queue.snapshot().active, true);
    assert.equal(h.requests.length, 0);
    assert.equal(h.c.calls.filter((x) => x[0] === "play").length, 3);
    assert.equal(h.c.__ottActiveProviderDriver, originalProvider);
    assert.equal(h.c.p_pref, "m3u");
    assert.equal(h.c.stored.plexcfg, saved);
    assert.equal(h.call("next").replies[0].status, "rejected");
    const previous = h.call("previous");
    h.prepare(ids);
    h.resolve(ids[1]);
    assert.equal(previous.replies[0].status, "ok");
    assert.equal(h.queue.snapshot().index, 1);
    h.call("stop");
    assert.equal(h.queue.snapshot().state, "idle");
    assert.equal(h.queue.snapshot().active, false);
});
test("manual sibling arrows retain the remote queue identity and exact stop boundary", () => {
    const h = setup();
    const ids = ["1", "2", "3"];
    h.call("play", ids);
    h.prepare(ids);
    h.resolve("1");
    h.c.__ottMedia.skip(-1);
    assert.equal(
        h.requests.length,
        0,
        "The first item has no previous sibling"
    );
    h.c.__ottMedia.skip(1);
    h.resolve("2");
    assert.deepEqual(plain(h.queue.snapshot().ids), ids);
    assert.equal(h.queue.snapshot().active, true);
    assert.equal(h.queue.snapshot().index, 1);
    assert.equal(h.queue.snapshot().state, "playing");
    h.c.__ottMedia.cycleRepeat();
    h.c.__ottMedia.toggleShuffle();
    assert.equal(h.c.__ottMedia.current().sequence.repeat, "off");
    h.c.__ottMedia.skip(-1);
    h.resolve("1");
    assert.equal(h.queue.snapshot().index, 0);
    h.c.__ottMedia.skip(1);
    h.resolve("2");
    h.end();
    h.resolve("3");
    assert.equal(h.queue.snapshot().index, 2);
    h.c.__ottMedia.skip(1);
    assert.equal(
        h.requests.length,
        0,
        "The final item does not wrap on an arrow"
    );
    h.end();
    assert.equal(h.queue.snapshot().state, "ended");
    assert.equal(h.requests.length, 0);
});
test("a failed arrow resolution still reports failure to the owning remote queue", () => {
    const h = setup();
    h.call("play", ["1", "2", "3"]);
    h.prepare(["1", "2", "3"]);
    h.resolve("1");
    h.c.__ottMedia.skip(1);
    h.resolve("2");
    h.c.__ottMedia.skip(1);
    h.reply([]);
    assert.equal(h.queue.snapshot().state, "error");
    assert.equal(
        h.c.__ottMedia.current().payload.request.path,
        "/library/metadata/2"
    );
});
test("Fullscreen arrows follow the playing Plex source without changing the selected provider", () => {
    for (const provider of ["m3u", "vportal", "stalker"]) {
        const h = setup();
        h.c.p_pref = provider;
        h.c.__ottActiveProviderDriver = { id: provider };
        const selected = h.c.__ottActiveProviderDriver;
        vm.runInContext(
            sourceFunctions("src/key-handler/index.ts", [
                "handleMainKey",
                "keyFun",
            ]),
            h.c
        );
        h.c.settings.auFun = 19;
        h.c.settings.adFun = 18;
        h.c.settings.alFun = 14;
        h.c.settings.arFun = 13;
        h.c.sVolumeStep = 5;
        const seeks = [];
        const volumes = [];
        h.c.shiftArchive = (seconds) => seeks.push(seconds);
        h.c.changeVolume = (delta) => volumes.push(delta);
        const press = (key) =>
            h.c.handleMainKey(key, {
                preventDefault() {},
                stopPropagation() {},
            });
        h.call("play", ["1", "2", "3"]);
        h.prepare(["1", "2", "3"]);
        h.resolve("1");
        press(h.c.keys.LEFT);
        press(h.c.keys.RIGHT);
        assert.deepEqual(seeks.splice(0), [-10, 10]);
        assert.deepEqual(volumes, []);
        assert.equal(h.requests.length, 0);
        assert.equal(h.queue.snapshot().index, 0);
        press(h.c.keys.UP);
        assert.equal(
            h.requests.length,
            1,
            provider + " must resolve the next Plex video"
        );
        h.resolve("2");
        assert.equal(h.queue.snapshot().index, 1);
        press(h.c.keys.DOWN);
        h.resolve("1");
        assert.equal(h.queue.snapshot().index, 0);
        assert.deepEqual(seeks, []);
        assert.equal(h.c.p_pref, provider);
        assert.equal(h.c.__ottActiveProviderDriver, selected);

        h.call("stop");
        h.c._playMedia({
            id: "own-video",
            stream_url: "own-video.mp4",
            title: "Own video",
        });
        press(h.c.keys.UP);
        press(h.c.keys.DOWN);
        assert.deepEqual(
            seeks,
            [60, -60],
            "The selected provider's own video keeps configured seeking"
        );
        press(h.c.keys.LEFT);
        press(h.c.keys.RIGHT);
        assert.deepEqual(volumes, [-5, 5]);
    }
});
test("preview validates order without publishing, resolving streams or modifying saved settings", () => {
    const h = setup();
    const originalSource = h.c.__ottMedia.sourceId();
    const before = JSON.stringify(h.c.stored);
    const request = h.call("preview", ["2", "1"]);
    h.prepare(["2", "1"]);
    assert.deepEqual(request.replies[0].data.ids, ["2", "1"]);
    assert.deepEqual(request.replies[0].data.titles, ["Film 2", "Film 1"]);
    assert.equal(request.replies[0].data.state, "ready");
    assert.equal(h.queue.snapshot().state, "idle");
    assert.equal(h.c.__ottMedia.sourceId(), originalSource);
    assert.equal(JSON.stringify(h.c.stored), before);
    assert.equal(h.requests.length, 0);
});
test("startup readiness rejects playback but preserves preview and Plex-only providers", () => {
    const h = setup();
    h.c.commandChannelsReady = false;
    assert.equal(h.call("play", ["1"]).replies[0].status, "rejected");
    assert.equal(h.requests.length, 0);
    assert.equal(h.queue.retained(), false);
    assert.equal(h.call("status").replies[0].data.state, "idle");
    const preview = h.call("preview", ["1"]);
    h.prepare(["1"]);
    assert.equal(preview.replies[0].data.state, "ready");
    assert.equal(h.call("play", ["1"]).replies[0].status, "rejected");
    h.c.__ottActiveProviderDriver = {
        capabilities: { libraryOnly: true },
        id: "plex",
    };
    h.c.p_pref = "plex";
    h.c.cList = [];
    h.c.commandChannelsReady = true;
    const play = h.call("play", ["1"]);
    h.prepare(["1"]);
    h.resolve("1");
    assert.equal(
        play.replies[0].status,
        "ok",
        "A ready Plex-only provider needs no TV channels"
    );
});
test("a catalog reload during Plex preparation cannot commit late playback", () => {
    const h = setup();
    const play = h.call("play", ["1"]);
    h.c.commandChannelsReady = false;
    const stale = h.reply();
    assert.equal(play.replies.length, 0);
    assert.equal(h.c.calls.filter((x) => x[0] === "play").length, 0);
    const deadline = [...h.timers.values()].find((timer) => timer.ms === 35000);
    assert(deadline, "Lost readiness still has a bounded execution deadline");
    deadline.fn();
    assert.equal(play.replies[0].status, "rejected");
    h.c.commandChannelsReady = true;
    stale.success({ MediaContainer: {} });
    assert.equal(play.replies.length, 1);
    assert.equal(h.c.calls.filter((x) => x[0] === "play").length, 0);
    assert.equal(h.queue.retained(), false);
});
test("failed replacement preflight preserves an already playing queue and client", () => {
    const h = setup();
    h.call("play", ["1", "2"]);
    h.prepare(["1", "2"]);
    h.resolve("1");
    const current = h.c.__ottMedia.current();
    const failed = h.call("play", ["3"]);
    h.reply();
    h.reply([]);
    assert.equal(failed.replies[0].status, "rejected");
    assert.equal(h.c.__ottMedia.current(), current);
    assert.deepEqual(plain(h.queue.snapshot().ids), ["1", "2"]);
    h.end();
    h.resolve("2");
    assert.equal(h.queue.snapshot().index, 1);
});
test("refused or throwing dispatch restores exact old runtime and its natural EOS", () => {
    for (const mode of ["refuse", "throw", "prepare-only", "prepare-same-id"]) {
        const h = setup();
        h.call("play", ["1", "2"]);
        h.prepare(["1", "2"]);
        h.resolve("1");
        const previous = h.c.__ottMedia.current();
        const previousState = plain(h.c.__ottClassicPlayback.snapshot());
        const play = h.c._playMedia;
        h.c._playMedia = (payload) => {
            if (mode === "throw")
                throw new Error("synthetic admission refusal");
            if (mode === "prepare-only" || mode === "prepare-same-id")
                h.c.__ottMedia.prepare(payload, payload.stream_url);
        };
        const ids = mode === "prepare-same-id" ? ["1", "4"] : ["3", "4"];
        const replacement = h.call("play", ids);
        h.prepare(ids);
        h.resolve(ids[0]);
        assert.equal(replacement.replies.length, 1, mode);
        assert.equal(replacement.replies[0].status, "rejected", mode);
        assert.equal(h.c.__ottMedia.current(), previous, mode);
        assert.deepEqual(
            plain(h.c.__ottClassicPlayback.snapshot()),
            previousState,
            mode
        );
        assert.deepEqual(plain(h.queue.snapshot().ids), ["1", "2"], mode);
        h.c._playMedia = play;
        h.end();
        h.resolve("2");
        assert.equal(h.queue.snapshot().index, 1, mode);
        assert.equal(h.queue.snapshot().state, "playing", mode);
    }
});
test("an exception after decoder dispatch cannot restore stale queue ownership", () => {
    const h = setup();
    h.call("play", ["1", "2"]);
    h.prepare(["1", "2"]);
    h.resolve("1");
    const prior = h.c.__ottMedia.current();
    const play = h.c._playMedia;
    h.c._playMedia = (...args) => {
        play(...args);
        throw new Error("synthetic post-dispatch failure");
    };
    const request = h.call("play", ["3", "4"]);
    h.prepare(["3", "4"]);
    h.resolve("3");
    assert.equal(request.replies[0].status, "ok");
    assert.notEqual(h.c.__ottMedia.current(), prior);
    assert.deepEqual(plain(h.queue.snapshot().ids), ["3", "4"]);
    assert.equal(h.queue.snapshot().state, "playing");
    h.c._playMedia = play;
    h.end();
    h.resolve("4");
    assert.equal(h.queue.snapshot().index, 1);
});
test("preview and status cannot interrupt pending play, and a failed draft does not own TV", () => {
    const h = setup();
    const playing = h.call("play", ["1"]);
    const pending = h.requests[0];
    const preview = h.call("preview", ["2"]);
    assert.equal(preview.replies[0].status, "rejected");
    assert.equal(pending.aborted, false);
    assert.equal(h.call("status").replies[0].data.state, "preparing");
    h.prepare(["1"]);
    h.resolve("1");
    assert.equal(playing.replies[0].status, "ok");
    const missing = setup();
    missing.c.stored.plexcfg = "";
    assert.equal(missing.call("play", ["1"]).replies[0].status, "rejected");
    assert.equal(missing.queue.snapshot().state, "error");
    assert.equal(missing.queue.snapshot().active, false);
    assert.deepEqual(plain(missing.queue.snapshot().ids), []);
    assert.equal(missing.queue.snapshot().index, null);
    assert.equal(missing.queue.retained(), false);
    assert.equal(missing.call("next").replies[0].status, "rejected");
});
test("lazy failure and cancellation remain inactive and preview preserves the error", () => {
    const h = setup();
    const factory = h.c.__ottPlexQueueFactory;
    h.c.__ottPlexQueueFactory = null;
    let ready, reject;
    h.c.__ottProviderAssets = {
        classic: {
            ensure(_p, _h, _v, _owner, ok, fail) {
                ready = ok;
                reject = fail;
            },
        },
    };
    const pending = h.call("play", ["1"]);
    assert.equal(h.queue.retained(), true);
    reject();
    const failed = plain(h.queue.snapshot());
    assert.equal(failed.active, false);
    assert.equal(failed.state, "error");
    assert.equal(failed.index, null);
    assert.deepEqual(failed.ids, []);
    assert.equal(h.queue.retained(), false);
    assert.equal(pending.replies[0].status, "rejected");
    const preview = h.call("preview", ["2"]);
    assert.deepEqual(plain(h.queue.snapshot()), failed);
    h.c.__ottPlexQueueFactory = factory;
    ready();
    h.prepare(["2"]);
    assert.equal(preview.replies[0].data.state, "ready");
    assert.deepEqual(plain(h.queue.snapshot()), failed);
    const cancelled = setup();
    cancelled.c.__ottPlexQueueFactory = null;
    cancelled.c.__ottProviderAssets = { classic: { ensure() {} } };
    cancelled.call("play", ["1"]).cancel();
    assert.equal(cancelled.queue.snapshot().state, "error");
    assert.equal(cancelled.queue.snapshot().active, false);
    assert.equal(cancelled.queue.retained(), false);
});
test("standby cancels lazy and loaded Plex preparation without a playback generation change", () => {
    for (const lazy of [true, false]) {
        const h = setup();
        const factory = h.c.__ottPlexQueueFactory;
        let ready;
        if (lazy) {
            delete h.c.__ottPlexQueueFactory;
            h.c.__ottProviderAssets = {
                classic: {
                    ensure(_p, _h, _v, _owner, callback) {
                        ready = callback;
                    },
                },
            };
        }
        h.call("play", ["1"]);
        const generation = h.c.__ottClassicPlayback.snapshot().generation;
        h.c.stbIsStandby = () => true;
        h.queue.stop();
        assert.equal(
            h.c.__ottClassicPlayback.snapshot().generation,
            generation
        );
        if (lazy) {
            h.c.__ottPlexQueueFactory = factory;
            ready();
        } else {
            assert.equal(h.requests[0].aborted, true);
            h.reply();
        }
        assert.equal(h.requests.length, 0);
        assert.equal(h.c.calls.filter((x) => x[0] === "play").length, 0);
        assert.equal(h.queue.snapshot().active, false);
        assert.equal(h.call("play", ["2"]).replies[0].status, "rejected");
        assert.equal(
            h.library("play", { library_id: "16" }).replies[0].status,
            "rejected"
        );
        assert.equal(
            h.requests.length,
            0,
            "standby cannot start new preparation"
        );
        assert.equal(h.call("status").replies[0].status, "ok");
        assert.equal(h.call("stop").replies[0].status, "ok");
        h.c.stbIsStandby = () => false;
        h.call("play", ["2"]);
        h.prepare(["2"]);
        h.resolve("2");
        assert.equal(h.queue.snapshot().state, "playing");
    }
});
test("standby guards fence retained lazy and metadata callbacks before explicit cancellation", () => {
    for (const lazy of [true, false]) {
        const h = setup();
        const factory = h.c.__ottPlexQueueFactory;
        let ready;
        if (lazy) {
            delete h.c.__ottPlexQueueFactory;
            h.c.__ottProviderAssets = {
                classic: {
                    ensure(_p, _h, _v, _owner, callback) {
                        ready = callback;
                    },
                },
            };
        }
        const pending = h.call("play", ["1"]);
        h.c.stbIsStandby = () => true;
        if (lazy) {
            h.c.__ottPlexQueueFactory = factory;
            ready();
        } else h.reply();
        assert.equal(h.requests.length, 0);
        assert.equal(h.c.calls.filter((x) => x[0] === "play").length, 0);
        h.queue.stop();
        assert.equal(pending.replies[0].status, "rejected");
    }
});
test("policy changes during preflight cancel admission, and stopping an old queue cannot stop new TV", () => {
    const h = setup();
    const request = h.call("play", ["1"]);
    h.c.parentAccess = true;
    h.c.__ottParental.needs = () => false;
    h.reply();
    h.reply([{ ...h.item("1"), adult: 1 }]);
    h.c.parentAccess = false;
    h.c.__ottParental.needs = () => true;
    h.resolve("1");
    assert.equal(h.c.calls.filter((x) => x[0] === "play").length, 0);
    request.cancel();
    const playing = setup();
    playing.call("play", ["1"]);
    playing.prepare(["1"]);
    playing.resolve("1");
    playing.c.__ottClassicPlayback.command({
        channelId: "tv",
        sourceId: "m3u",
        type: "live",
    });
    const stopped = playing.c.calls.filter((x) => x[0] === "stop").length;
    playing.call("stop");
    assert.equal(
        playing.c.calls.filter((x) => x[0] === "stop").length,
        stopped
    );
});
test("a locked kiosk rejects queue stop without disposing playback", () => {
    const h = setup();
    h.call("play", ["1", "2"]);
    h.prepare(["1", "2"]);
    h.resolve("1");
    const before = plain(h.queue.snapshot());
    const calls = h.c.calls.length;
    h.c.__ottKiosk = { enabled: () => true };
    assert.equal(h.call("stop").replies[0].status, "rejected");
    assert.deepEqual(plain(h.queue.snapshot()), before);
    assert.equal(h.c.calls.length, calls);
    assert.equal(h.call("status").replies[0].status, "ok");
    h.c.__ottKiosk.enabled = () => false;
    assert.equal(h.call("stop").replies[0].status, "ok");
    assert.equal(h.queue.snapshot().active, false);
});
test("cancel, timeout, changed provider and expired requests cannot start later", () => {
    for (const action of ["cancel", "timeout", "provider", "config"]) {
        const h = setup();
        const request = h.call("play", ["1"]);
        if (action === "cancel") request.cancel();
        if (action === "timeout")
            [...h.timers.values()].find((x) => x.ms === 35000).fn();
        if (action === "provider")
            h.c.__ottActiveProviderDriver = { id: "other" };
        if (action === "config") h.c.stored.plexcfg = "{}";
        h.reply();
        assert.equal(h.c.calls.filter((x) => x[0] === "play").length, 0);
        assert.equal(h.requests.length, 0);
    }
    const h = setup();
    const replies = [];
    h.queue.execute(
        {
            expires_at: 1,
            params: { ids: ["1"], op: "play", runtime: "runtime-fixture" },
        },
        (x) => replies.push(x)
    );
    assert.equal(replies[0].status, "rejected");
    assert.equal(h.requests.length, 0);
});
test("the default and shortened deadlines fence responses before timers fire", () => {
    for (const duration of [35000, 7000]) {
        const h = setup(),
            replies = [];
        h.queue.execute(
            {
                action: "plex_library",
                ...(duration === 7000
                    ? { expires_at: (h.c.Date.now() + duration) / 1000 }
                    : {}),
                params: { op: "list", runtime: "runtime-fixture" },
            },
            (result) => replies.push(plain(result))
        );
        const deadline = [...h.timers.values()].find(
            (timer) => timer.ms === duration
        );
        assert(
            deadline,
            "The earlier request expiry bounds the execution timer"
        );
        h.advance(duration - 1);
        h.reply();
        assert.equal(
            h.requests.length,
            1,
            "Work continues before the deadline"
        );
        assert.equal(replies.length, 0);
        h.advance(1);
        h.page([], 0, 0, true);
        assert.equal(
            replies.length,
            1,
            "The deadline fences work before the timer runs"
        );
        assert.equal(replies[0].status, "rejected");
        assert.equal(replies[0].data.state, "error");
        deadline.fn();
        assert.equal(replies.length, 1);
        assert.equal(h.requests.length, 0);
        assert.equal(h.c.calls.filter((x) => x[0] === "play").length, 0);
        assert.equal(h.queue.retained(), false);
    }
});
test("canonical IDs, bounded titles and exact runtime are enforced", () => {
    for (const ids of [
        ["0"],
        ["01"],
        ["1.0"],
        [1],
        [],
        Array(501).fill("1"),
        ["1".repeat(21)],
    ]) {
        const h = setup();
        assert.equal(h.call("play", ids).replies[0].status, "rejected");
        assert.equal(h.requests.length, 0);
    }
    const h = setup();
    assert.equal(
        h.call("play", ["1"], { runtime: "wrong" }).replies[0].status,
        "rejected"
    );
    const ids = Array.from({ length: 500 }, (_, i) => String(i + 1));
    const preview = h.call("preview", ids);
    h.reply();
    h.reply(ids.map((id) => h.item(id, "🙂".repeat(200) + "\ud800")));
    assert.equal(preview.replies[0].data.titles.length, 500);
    assert(
        preview.replies[0].data.titles.every((x) => Buffer.byteLength(x) <= 512)
    );
});
test("shared contract capability and maximum escaped preview stay bounded", () => {
    const h = setup();
    assert.deepEqual(plain(h.queue.capability), contract.capability);
    const ids = Array.from({ length: contract.max_items }, (_, i) =>
        String(i + 1)
    );
    const preview = h.call("preview", ids);
    h.reply();
    h.reply(ids.map((id) => h.item(id, '"'.repeat(512))));
    assert(
        Buffer.byteLength(JSON.stringify(preview.replies[0].data)) <
            contract.max_preview_result_bytes
    );
    for (const file of [
        "src/commands/remote-plex.ts",
        "src/plugins/plex-queue.ts",
    ]) {
        const source = fs.readFileSync(file, "utf8");
        for (const match of source.matchAll(
            /"((?:Plex |One or more Plex |Player context |Unlock parental |Kiosk mode)[^"\n]*\.)"/g
        ))
            assert(contract.errors.includes(match[1]), match[1]);
    }
});
test("Plex kiosk retains 265 ordered requests, loops, and restores without media URLs", () => {
    const h = setup();
    h.c.__ottActiveProviderDriver = { id: "plex" };
    const ids = Array.from({ length: 265 }, (_, i) => String(265 - i));
    const request = h.call("play", ids);
    h.prepare(ids);
    h.resolve(ids[0]);
    assert.equal(request.replies[0].status, "ok");
    h.c.__ottMedia.keepKioskLoop();
    assert.equal(h.queue.snapshot().repeat, "all");
    const selection = plain(h.c.__ottMedia.kioskSelection());
    assert.equal(selection.records.length, 265);
    assert.equal(selection.records[0].request.path, "/library/metadata/265");
    assert(
        selection.records.every((row) => row.plexSource === selection.source)
    );
    assert(selection.records.every((row) => !row.stream_url));
    assert(!JSON.stringify(selection).includes("synthetic-only"));
    assert(selection.queueId);
    assert.equal(
        h.c.__ottMedia.restoreKiosk({ ...selection, index: 264 }, () => true),
        true
    );
    h.resolve(ids[264]);
    assert.equal(h.queue.snapshot().index, 264);
    assert.equal(h.queue.snapshot().repeat, "all");
    h.end();
    h.resolve(ids[0]);
    assert.equal(h.queue.snapshot().index, 0);
    assert.equal(h.queue.snapshot().state, "playing");
});
test("Plex kiosk captures the actual cursor when IDs repeat", () => {
    const h = setup();
    h.c.__ottActiveProviderDriver = { id: "plex" };
    h.call("play", ["1", "1"]);
    h.prepare(["1", "1"]);
    h.resolve("1");
    assert.equal(h.c.__ottMedia.kioskSelection().index, 0);
    h.c.__ottMedia.current().sequence = null;
    assert.equal(h.c.__ottMedia.kioskSelection().queueId, undefined);
    assert.equal(h.c.__ottMedia.kioskSelection().records.length, 1);
});
const section = (id = "16", title = "Три кота", type = "show") => ({
    key: id,
    title,
    type,
});
function libraryInventory(h, rows = [section()]) {
    h.reply(); // connection preflight; inventory itself must be complete
    h.page(rows, 0, rows.length, true);
}
const episodes = (h, from, count) =>
    Array.from({ length: count }, (_, i) => ({
        ...h.item(String(from + i)),
        type: "episode",
    }));
test("library movie preview and play reuse all 57 catalog records without bulk metadata", () => {
    for (const op of ["preview", "play"]) {
        const h = setup();
        h.c.Math = Object.create(Math);
        h.c.Math.random = () => 0;
        const saved = JSON.stringify(h.c.stored);
        const request = h.library(op, { query: "Кукутики" }, { shuffle: true });
        libraryInventory(h, [section("20", "Кукутики", "movie")]);
        assert.equal(new URL(h.requests[0].url).searchParams.get("type"), "1");
        const movies = Array.from({ length: 57 }, (_, i) =>
            h.item(String(i + 1))
        );
        h.page(movies);
        assert.equal(
            h.requests.length,
            op === "play" ? 1 : 0,
            "Only playback resolves the first item after complete collection"
        );
        const ids =
            op === "play"
                ? plain(h.queue.snapshot().ids)
                : request.replies[0].data.queue.ids;
        assert.deepEqual(
            ids,
            movies
                .slice(1)
                .concat(movies[0])
                .map((row) => row.ratingKey)
        );
        assert.equal(h.c.calls.filter((x) => x[0] === "play").length, 0);
        if (op === "play") {
            assert.equal(
                new URL(h.requests[0].url).pathname,
                "/library/metadata/" + ids[0],
                "Fresh single-item resolution replaces no catalog validation"
            );
            h.resolve(ids[0]);
            assert.equal(request.replies[0].data.queue.title, "Film " + ids[0]);
            h.end();
            h.resolve(ids[1]);
            assert.equal(h.queue.snapshot().title, "Film " + ids[1]);
        } else {
            assert.deepEqual(
                request.replies[0].data.queue.titles,
                ids.map((id) => "Film " + id)
            );
        }
        assert.deepEqual(request.replies[0].data.queue.ids, ids);
        assert.equal(request.replies[0].status, "ok");
        assert.equal(h.c.stored.plexcfg, JSON.parse(saved).plexcfg);
        if (op === "preview") assert.equal(JSON.stringify(h.c.stored), saved);
    }
});
test("library rejects an unplayable first or final catalog page without skipping items", () => {
    for (const op of ["preview", "play"])
        for (const page of ["first", "final"])
            for (const failure of [
                "missing-media",
                "missing-part",
                "empty-part",
                "later-media",
                "later-part",
                "absolute-key",
                "traversal-key",
                "token-key",
            ]) {
                const h = setup();
                const source = h.c.__ottMedia.sourceId();
                const stored = JSON.stringify(h.c.stored);
                const request = h.library(op, { library_id: "16" });
                libraryInventory(h);
                const bad = episodes(h, 2, 1)[0];
                if (failure === "missing-media") delete bad.Media;
                if (failure === "missing-part") delete bad.Media[0].Part;
                if (failure === "empty-part") bad.Media[0].Part = [];
                if (failure === "later-media") bad.Media.unshift({ Part: [] });
                if (failure === "later-part") bad.Media[0].Part.unshift({});
                const unsafe = {
                    "absolute-key": "https://other.invalid/file.mp4",
                    "token-key": "/library/parts/2/file.mp4?X-Plex-Token=other",
                    "traversal-key": "/library/parts/%2e%2e/file.mp4",
                }[failure];
                if (unsafe) bad.Media[0].Part[0].key = unsafe;
                if (page === "final") {
                    h.page(episodes(h, 1, 1), 0, 2);
                    assert.equal(request.replies.length, 0);
                    h.tickPage();
                }
                h.page([bad], page === "final" ? 1 : 0, 2);
                assert.equal(
                    request.replies[0].data.error,
                    "One or more Plex items are unavailable or not playable.",
                    op + "/" + page + "/" + failure
                );
                assert.equal(h.requests.length, 0);
                assert.equal(
                    h.c.calls.filter((x) => x[0] === "play").length,
                    0
                );
                assert.equal(h.c.__ottMedia.sourceId(), source);
                assert.equal(JSON.stringify(h.c.stored), stored);
            }
});
test("library catalog parental admission and fresh first-item resolution preserve the prior queue", () => {
    for (const failure of ["catalog-part", "parental", "resolve"]) {
        const h = setup();
        h.call("play", ["8", "9"]);
        h.prepare(["8", "9"]);
        h.resolve("8");
        const prior = h.c.__ottMedia.current();
        const request = h.library("play", { library_id: "16" });
        libraryInventory(h);
        const rows = episodes(h, 1, 2);
        if (failure === "catalog-part") rows[1].Media[0].Part = [];
        if (failure === "parental") rows[1].adult = 1;
        h.page(rows);
        if (failure === "resolve") {
            assert.equal(
                new URL(h.requests[0].url).pathname,
                "/library/metadata/1"
            );
            h.reply([]);
        }
        assert.equal(request.replies[0].status, "rejected", failure);
        assert.equal(h.requests.length, 0);
        assert.equal(h.c.__ottMedia.current(), prior);
        assert.equal(h.c.calls.filter((x) => x[0] === "play").length, 1);
        assert.deepEqual(plain(h.queue.snapshot().ids), ["8", "9"]);
        h.end();
        h.resolve("9");
        assert.equal(h.queue.snapshot().title, "Film 9");
    }
});
test("library object-form media metadata retains parental restrictions without blocking preview", () => {
    const h = setup();
    const request = h.library("preview", { library_id: "16" });
    libraryInventory(h);
    const row = episodes(h, 1, 1)[0];
    row.adult = 1;
    row.Media = { Part: row.Media[0].Part[0] };
    h.page([row]);
    assert.equal(request.replies[0].status, "ok");
    assert.deepEqual(request.replies[0].data.queue.ids, ["1"]);
    assert.equal(h.requests.length, 0);
});
test("library show collects 265 episodes before one shuffle and the existing queue handoff", () => {
    const h = setup();
    const saved = h.c.stored.plexcfg;
    const request = h.library(
        "play",
        { query: "три  КОТА" },
        { shuffle: true }
    );
    libraryInventory(h);
    assert.equal(
        new URL(h.requests[0].url).pathname,
        "/library/sections/16/all"
    );
    assert.equal(new URL(h.requests[0].url).searchParams.get("type"), "4");
    assert.equal(
        h.queue.snapshot().active,
        false,
        "No empty preparing queue is published"
    );
    h.page(episodes(h, 1, 200), 0, 265);
    assert.equal(h.c.calls.filter((x) => x[0] === "play").length, 0);
    h.tickPage();
    assert.equal(h.requests[0].headers["X-Plex-Container-Start"], "200");
    h.page(episodes(h, 201, 65), 200, 265);
    const ids = plain(h.queue.snapshot().ids);
    assert.equal(
        new URL(h.requests[0].url).pathname,
        "/library/metadata/" + ids[0]
    );
    assert.equal(ids.length, 265);
    assert.equal(new Set(ids).size, 265);
    assert.deepEqual(
        [...ids].sort((a, b) => a - b),
        Array.from({ length: 265 }, (_, i) => String(i + 1))
    );
    assert.equal(request.replies.length, 0);
    assert.equal(h.c.calls.filter((x) => x[0] === "play").length, 0);
    h.resolve(ids[0]);
    const data = request.replies[0].data;
    assert.equal(request.replies[0].status, "ok");
    assert.deepEqual(data.library, {
        id: "16",
        title: "Три кота",
        type: "show",
    });
    assert.equal(data.shuffled, true);
    assert.deepEqual(data.queue.ids, ids);
    assert.equal(data.queue.repeat, "none");
    assert.equal(h.c.stored.plexcfg, saved);
    h.end();
    h.resolve(ids[1]);
    assert.deepEqual(
        plain(h.queue.snapshot().ids),
        ids,
        "EOS retains the one-time permutation"
    );
    assert.equal(h.queue.snapshot().index, 1);
});
test("library inventory paginates before exact match and list emits bounded safe metadata", () => {
    const h = setup();
    const request = h.library("preview", { query: "Три кота" });
    h.reply();
    h.page([section("1", "Три кота extras")], 0, 2, true);
    h.tickPage();
    h.page([section()], 1, 2, true);
    assert.equal(
        new URL(h.requests[0].url).pathname,
        "/library/sections/16/all"
    );
    h.page(episodes(h, 1, 1));
    assert.equal(request.replies[0].data.queue.state, "ready");
    assert.equal(h.c.calls.filter((x) => x[0] === "play").length, 0);
    const list = h.library("list");
    libraryInventory(h, [
        section("1", "Ж".repeat(100), "movie"),
        section("2", "Music", "artist"),
    ]);
    assert.equal(list.replies[0].data.libraries.length, 1);
    assert.equal(
        Buffer.byteLength(list.replies[0].data.libraries[0].title),
        160
    );
    assert.deepEqual(Object.keys(list.replies[0].data).sort(), [
        "libraries",
        "op",
        "runtime",
        "state",
        "version",
    ]);
});
test("library labels remain nonblank after sanitization before list or play", () => {
    for (const op of ["list", "play"])
        for (const name of ["\x01", "\ud800", "\udfff"]) {
            const h = setup(),
                request = h.library(
                    op,
                    op === "list" ? {} : { library_id: "16" }
                );
            libraryInventory(h, [section("16", name)]);
            assert.equal(request.replies[0].data.error, "incomplete_library");
            assert.equal(h.c.calls.filter((x) => x[0] === "play").length, 0);
        }
    const h = setup(),
        request = h.library("play", { library_id: "16" });
    libraryInventory(h, [section("16", " ".repeat(160) + "A")]);
    h.page(episodes(h, 1, 1));
    h.resolve("1");
    assert.equal(request.replies[0].data.library.title, "A");
});
test("library supports the 500-item boundary without partial publication", () => {
    const h = setup(),
        request = h.library("preview", { library_id: "16" });
    libraryInventory(h);
    h.page(episodes(h, 1, 200), 0, 500);
    h.tickPage();
    h.page(episodes(h, 201, 200), 200, 500);
    h.tickPage();
    h.page(episodes(h, 401, 100), 400, 500);
    assert.equal(h.requests.length, 0);
    assert.equal(request.replies[0].data.queue.ids.length, 500);
    assert.equal(h.c.calls.filter((x) => x[0] === "play").length, 0);
});
test("library selection refuses ambiguous, missing and unsupported targets", () => {
    for (const [rows, selector, error] of [
        [
            [section("1"), section("2")],
            { query: "Три кота" },
            "ambiguous_library",
        ],
        [
            [section("1", "Коты 1"), section("2", "Коты 2")],
            { query: "коты" },
            "ambiguous_library",
        ],
        [[section()], { query: "absent" }, "library_not_found"],
        [
            [section("2", "Music", "artist")],
            { library_id: "2" },
            "unsupported_library",
        ],
    ]) {
        const h = setup(),
            request = h.library("play", selector);
        libraryInventory(h, rows);
        assert.equal(request.replies[0].data.error, error);
        assert.deepEqual(Object.keys(request.replies[0].data).sort(), [
            "error",
            "op",
            "runtime",
            "state",
            "version",
        ]);
        assert.equal(h.requests.length, 0);
    }
});
test("library strict request schema rejects aliases, extra fields and malformed selectors before IO", () => {
    for (const [op, selector, extra] of [
        ["list", { query: "x" }],
        ["list", {}, { shuffle: false }],
        ["preview", {}],
        ["play", { library_id: "16", query: "x" }],
        ["play", { library_id: "16", query: undefined }],
        ["play", { library_id: undefined, query: "x" }],
        ["play", { query: " " }],
        ["play", { query: "x\n" }],
        ["play", { query: "Ж".repeat(129) }],
        ["play", { query: "\ud800" }],
        ["play", { library_id: "016" }],
        ["play", { library_id: "16\n" }],
        ["play", { library_id: 16 }],
        ["play", { library_id: "16" }, { shuffle: "true" }],
        ["play", { library_id: "16" }, { ids: ["1"] }],
    ]) {
        const h = setup(),
            request = h.library(op, selector, extra);
        assert.equal(request.replies[0].status, "rejected");
        assert.equal(h.requests.length, 0);
    }
});
test("library collection rejects overflow, duplicate IDs, wrong offsets, types and drifting totals", () => {
    for (const failure of [
        "overflow",
        "duplicate",
        "offset",
        "type",
        "total",
        "truncated",
        "network",
    ]) {
        const h = setup(),
            request = h.library("play", { library_id: "16" });
        libraryInventory(h);
        if (failure === "overflow") h.page(episodes(h, 1, 1), 0, 501);
        else if (failure === "type") h.page([h.item("1")]);
        else {
            h.page(episodes(h, 1, 1), 0, 2);
            h.tickPage();
            if (failure === "duplicate") h.page(episodes(h, 1, 1), 1, 2);
            if (failure === "offset") h.page(episodes(h, 2, 1), 0, 2);
            if (failure === "total") h.page(episodes(h, 2, 1), 1, 3);
            if (failure === "truncated") h.page([], 1, 2);
            if (failure === "network") {
                for (let attempt = 0; attempt < 3; attempt++) {
                    h.requests.shift().error({}, "error");
                    if (attempt < 2) {
                        assert.equal(request.replies.length, 0);
                        const retry = [...h.timers].find(
                            ([, timer]) => timer.ms === (attempt + 1) * 500
                        );
                        assert(retry, "Expected a bounded collection retry");
                        h.timers.delete(retry[0]);
                        retry[1].fn();
                    }
                }
                assert.equal(h.requests.length, 0);
            }
        }
        assert.equal(
            request.replies[0].data.error,
            failure === "overflow" ? "too_many_items" : "incomplete_library",
            failure
        );
        assert.equal(h.c.calls.filter((x) => x[0] === "play").length, 0);
    }
});
test("library inventory refuses duplicates and overflow and unknown totals require terminal page", () => {
    for (const failure of ["duplicate", "overflow"]) {
        const h = setup(),
            request = h.library("list");
        h.reply();
        h.page(
            failure === "duplicate" ? [section(), section()] : [section()],
            0,
            failure === "duplicate" ? 2 : 1001,
            true
        );
        assert.equal(
            request.replies[0].data.error,
            failure === "duplicate"
                ? "incomplete_library"
                : "too_many_libraries"
        );
    }
    const h = setup(),
        request = h.library("preview", { library_id: "1" }, { shuffle: true });
    libraryInventory(h, [section("1", "Film", "movie")]);
    assert.equal(new URL(h.requests[0].url).searchParams.get("type"), "1");
    h.page([h.item("1")], 0, null);
    assert.equal(request.replies.length, 0);
    h.tickPage();
    h.page([], 1, null);
    assert.deepEqual(request.replies[0].data.queue.ids, ["1"]);
});
test("library pending owner is retired by stop, newer play, context changes and cancellation", () => {
    for (const stage of ["collection", "resolve"])
        for (const change of [
            "stop",
            "play",
            "library",
            "config",
            "provider",
            "generation",
            "cancel",
            "deadline",
            "expired",
        ]) {
            const h = setup(),
                old = h.library("play", { library_id: "16" });
            libraryInventory(h);
            if (stage === "collection") {
                h.page(episodes(h, 1, 1), 0, 2);
                h.tickPage();
            } else h.page(episodes(h, 1, 2));
            const late = h.requests.shift();
            let newer;
            if (change === "stop") h.call("stop");
            if (change === "play") newer = h.call("play", ["9"]);
            if (change === "library")
                newer = h.library("play", { library_id: "16" });
            if (change === "config") h.c.stored.plexcfg += " ";
            if (change === "provider")
                h.c.__ottActiveProviderDriver = { id: "other" };
            if (change === "generation")
                h.c.__ottClassicPlayback.command({ type: "stop" });
            if (change === "cancel") old.cancel();
            if (change === "deadline")
                [...h.timers.values()].find((timer) => timer.ms > 30000).fn();
            if (change === "expired") h.advance(35000);
            late.success({
                MediaContainer: {
                    Metadata: episodes(h, stage === "collection" ? 2 : 1, 1),
                    offset: 1,
                    size: 1,
                    totalSize: 2,
                },
            });
            assert.equal(
                h.c.calls.filter((x) => x[0] === "play").length,
                0,
                stage + "/" + change
            );
            if (change === "play") {
                h.prepare(["9"]);
                h.resolve("9");
                assert.equal(newer.replies[0].status, "ok");
            }
            if (change === "library") {
                libraryInventory(h);
                h.page(episodes(h, 9, 1));
                h.resolve("9");
                assert.equal(newer.replies[0].status, "ok");
            }
            assert(old.replies.length <= 1, stage + "/" + change);
        }
});
test("library reads cannot replace pending play and failed discovery preserves prior queue", () => {
    const h = setup(),
        request = h.library("play", { library_id: "16" });
    assert.equal(
        h.library("list").replies[0].data.error,
        "Plex queue request is already in progress."
    );
    assert.equal(
        h.library("preview", { library_id: "16" }).replies[0].data.error,
        "Plex queue request is already in progress."
    );
    libraryInventory(h);
    h.page(episodes(h, 1, 2));
    h.resolve("1");
    assert.equal(request.replies[0].status, "ok");
    const old = h.c.__ottMedia.current(),
        failed = h.library("play", { query: "missing" });
    libraryInventory(h);
    assert.equal(failed.replies[0].data.error, "library_not_found");
    assert.equal(h.c.__ottMedia.current(), old);
    h.end();
    h.resolve("2");
    assert.equal(h.queue.snapshot().index, 1);
});
test("invalid library selectors preserve an existing lazy queue or library owner", () => {
    for (const library of [false, true]) {
        const h = setup(),
            factory = h.c.__ottPlexQueueFactory;
        let ready;
        delete h.c.__ottPlexQueueFactory;
        h.c.__ottProviderAssets = {
            classic: {
                ensure(_family, _host, _cv, _owner, callback) {
                    assert.equal(ready, undefined);
                    ready = callback;
                },
            },
        };
        const pending = library
            ? h.library("play", { library_id: "16" })
            : h.call("play", ["9"]);
        for (const selector of [
            { library_id: "16", query: undefined },
            { library_id: undefined, query: "x" },
            { library_id: "16\n" },
        ])
            assert.equal(
                h.library("play", selector).replies[0].status,
                "rejected"
            );
        h.c.__ottPlexQueueFactory = factory;
        ready();
        if (library) {
            libraryInventory(h);
            h.page(episodes(h, 9, 1));
        } else h.prepare(["9"]);
        h.resolve("9");
        assert.equal(pending.replies[0].status, "ok");
    }
});
test("lazy library resolution cannot override later stop or queue play", () => {
    for (const replacement of ["stop", "play"]) {
        const h = setup(),
            factory = h.c.__ottPlexQueueFactory,
            callbacks = [];
        delete h.c.__ottPlexQueueFactory;
        h.c.__ottProviderAssets = {
            classic: {
                ensure(_family, _host, _cv, _owner, ready) {
                    callbacks.push(ready);
                },
            },
        };
        h.library("play", { library_id: "16" });
        const newer =
            replacement === "stop" ? h.call("stop") : h.call("play", ["9"]);
        h.c.__ottPlexQueueFactory = factory;
        callbacks[0]();
        assert.equal(h.requests.length, 0);
        if (replacement === "play") {
            callbacks[1]();
            h.prepare(["9"]);
            h.resolve("9");
            assert.equal(newer.replies[0].status, "ok");
        }
    }
});
test("Plex overlay favorites persist the current stable request and reject stale saved source", () => {
    const h = setup();
    h.c.stbGetPersistedItem = h.c.stbGetItem;
    h.call("play", ["78777"]);
    h.prepare(["78777"]);
    h.resolve("78777");
    const current = h.c.__ottMedia.current();
    const saved = h.c.__ottMedia.captureFavorite();
    assert(saved);
    assert.equal(saved.ref.sourceId, current.ref.sourceId);
    const text = h.c.stored["plexmediaJournal.v1:" + saved.ref.sourceId];
    const document = JSON.parse(text);
    assert.equal(document.favorites.length, 1);
    assert.equal(
        document.favorites[0].payload.request.path,
        "/library/metadata/78777"
    );
    assert.equal(document.favorites[0].payload.stream_url, undefined);
    let failure;
    h.queue.execute(
        {
            action: "plex_queue",
            favorite_source: "different-account",
            params: { ids: ["78777"], op: "play", runtime: "runtime-fixture" },
        },
        (value) => {
            failure = value;
        }
    );
    assert.equal(failure.status, "rejected");
    assert.equal(
        h.requests.length,
        0,
        "foreign bookmark source cannot make metadata or stream requests"
    );
});
console.log("PASS Plex queue: " + groups + " behavior groups");
