const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const acorn = require("acorn");
const { fixture: originalMediaFixture } = require("./test_port_vod.cjs");
function mediaFixture() {
    const value = originalMediaFixture();
    value.catalogs[""][0].id = "stable-default";
    return value;
}
const plain = (value) => JSON.parse(JSON.stringify(value));
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
const code = compile("src/commands/remote-favorites.ts");
let passed = 0;
function scenario(name, run) {
    run();
    passed++;
    console.log("PASS " + name);
}
function fixture(storage = {}) {
    let config = {
        active: 0,
        M3Us: [
            { name: "One", www: "first" },
            { name: "Two", www: "second" },
        ],
    };
    let generation = 1;
    let state;
    let nextTimer = 0;
    const timers = new Map();
    const plays = [];
    const w = {
        __ottClassicPlayback: { snapshot: () => plain(state) },
        __ottCommandChannelLoad: {},
        __ottKiosk: { enabled: () => !!w.locked },
        __ottParental: { needs: (area) => !!w.pin && area !== "channels" },
        __ottPlex: { configuredSource: () => "plex:account" },
        __ottSourceIdentity: {
            current: () => source(),
            media: () => source() + ":media",
        },
        addToFavorites(id) {
            w.lastFavorite = id;
        },
        clearTimeout(id) {
            timers.delete(id);
        },
        commandChannelsReady: true,
        Date,
        exports: {},
        hasParentalLock: () => false,
        JSON,
        Math,
        Object,
        playChannel(cat, index, _fullscreen, admit) {
            if (!admit()) return false;
            const id = w.cats[w.catsArray[cat]][index];
            plays.push({
                itemId: w.channels[id].itemId,
                profile: config.active,
                source: source(),
            });
            state = {
                generation: ++generation,
                phase: "playing",
                target: {
                    channelId: String(id),
                    kind: "live",
                    sourceId: source(),
                },
            };
            return true;
        },
        providerGetItem: (key) => storage["provider:" + key] ?? null,
        providerGetPersistedItem: (key) => storage["provider:" + key] ?? null,
        saveChannelsCats() {
            storage["provider:favoritesLibrary:" + source()] = JSON.stringify({
                itemId: w.channels[w.lastFavorite].itemId,
            });
        },
        setTimeout(fn, ms) {
            const id = ++nextTimer;
            timers.set(id, { fn, ms });
            return id;
        },
        stbGetItem: (key) => storage[key] ?? null,
        stbGetPersistedItem: (key) => storage[key] ?? null,
        stbSetItem: (key, value) => {
            storage[key] = value;
        },
        window: null,
    };
    function source() {
        return (
            w.__ottActiveProviderDriver.id +
            ":" +
            config.active +
            "@" +
            config.M3Us[config.active].www
        );
    }
    const driver = {
        configuration: () => plain(config),
        fixedSlot: () => -1,
        id: "m3u",
    };
    w.__ottActiveProviderDriver = driver;
    function catalog() {
        w.channels = {
            42: {
                channel_name: "Channel " + config.active,
                itemId: "stable:" + config.active,
            },
        };
        w.cats = { All: [42] };
        w.catsArray = ["All"];
    }
    function selectProfile(number) {
        config.active = number - 1;
        w.__ottCommandChannelLoad = {};
        w.commandChannelsReady = false;
        catalog();
        if (!w.delay) w.commandChannelsReady = true;
    }
    catalog();
    state = {
        generation,
        phase: "playing",
        target: { channelId: "42", kind: "live", sourceId: source() },
    };
    w.window = w;
    w.require = (name) => {
        if (name === "./remote-favorites-contract")
            return {
                remoteFavoritesCapability: {
                    operations: ["list", "add", "remove", "play"],
                },
            };
        if (name === "../utils/caseless")
            return { caselessKey: (value) => value.toLowerCase() };
        if (name === "../provider")
            return {
                isProviderAllowed: () => !w.denied,
                providerIds: ["m3u", "stalker"],
                selectProviderByIndex(index) {
                    w.__ottActiveProviderDriver = {
                        ...driver,
                        id: ["m3u", "stalker"][index],
                    };
                    w.__ottCommandChannelLoad = {};
                    return true;
                },
            };
        if (name === "./remote-profiles")
            return {
                handleRemoteProfiles(request, done) {
                    selectProfile(request.params.number);
                    done({ status: "ok" });
                },
            };
        if (name === "./remote-plex")
            return {
                remotePlexQueue: () => ({
                    execute(request, done) {
                        plays.push(plain(request));
                        done({ data: { state: "playing" }, status: "ok" });
                    },
                }),
            };
        throw new Error(name);
    };
    vm.runInNewContext(compile("src/channels/channel-references.ts"), w);
    vm.runInNewContext(code, w);
    function call(op, extra = {}) {
        const replies = [];
        const cancel = w.exports.executeRemoteFavorites(
            w,
            "runtime-test",
            {
                action: "favorites",
                params: { op, runtime: "runtime-test", ...extra },
            },
            (value) => replies.push(plain(value))
        );
        return {
            cancel,
            replies,
            get result() {
                return replies.at(-1);
            },
        };
    }
    return {
        call,
        catalog,
        config,
        plays,
        selectProfile,
        get state() {
            return state;
        },
        set state(value) {
            generation = value.generation;
            state = value;
        },
        storage,
        tick() {
            const row = [...timers].find(([, item]) => item.ms === 50);
            assert(row);
            timers.delete(row[0]);
            row[1].fn();
        },
        timeout() {
            const row = [...timers].find(([, item]) => item.ms > 100);
            assert(row);
            timers.delete(row[0]);
            row[1].fn();
        },
        w,
    };
}
scenario("runtime and strict request grammar", () => {
    const f = fixture();
    for (const extra of [
        { runtime: "wrong" },
        { extra: 1 },
        { name: " " },
        { name: "x".repeat(161) },
    ])
        assert.equal(f.call("add", extra).result.data.error, "invalid_request");
    assert.equal(
        f.call("play", { id: "fav-one", query: "One" }).result.data.error,
        "invalid_request"
    );
});
scenario(
    "current playback, not browsed selection; stable reference and idempotent add",
    () => {
        const f = fixture();
        f.w.primaryIndex = 44;
        f.w.curList = [999];
        const first = f.call("add").result;
        assert.equal(first.status, "ok");
        assert.equal(first.data.entry.title, "Channel 0");
        assert.equal(first.data.created, true);
        assert.deepEqual(
            JSON.parse(f.storage["remoteFavorites.v1"]).entries[0].ref,
            { itemId: "stable:0" }
        );
        const again = f.call("add", { name: "  My favorite  " }).result;
        assert.equal(again.data.created, false);
        assert.equal(again.data.entry.id, first.data.entry.id);
        assert.equal(again.data.entry.name, "My favorite");
        assert.equal(f.call("list").result.data.entries.length, 1);
        assert(!JSON.stringify(first).includes("stable:"));
    }
);
scenario("durable index survives recreation and excludes stream URLs", () => {
    const f = fixture();
    f.w.channels[42].url = "https://temporary.invalid/token";
    const entry = f.call("add").result.data.entry;
    const other = fixture(f.storage);
    assert.equal(other.call("list").result.data.entries[0].id, entry.id);
    assert.equal(other.call("play", { id: entry.id }).result.status, "ok");
    assert.equal(other.plays[0].itemId, "stable:0");
    assert(!f.storage["remoteFavorites.v1"].includes("temporary"));
});
scenario(
    "same numeric channel on different profile waits for catalog and resolves saved stable ID",
    () => {
        const f = fixture();
        const a = f.call("add", { name: "One" }).result.data.entry;
        f.selectProfile(2);
        f.w.commandChannelsReady = true;
        f.state = {
            generation: 2,
            phase: "playing",
            target: { channelId: "42", kind: "live", sourceId: "m3u:1@second" },
        };
        const b = f.call("add", { name: "Two" }).result.data.entry;
        f.w.delay = true;
        const play = f.call("play", { id: a.id });
        assert.equal(play.replies.length, 0);
        assert.equal(f.plays.length, 0);
        f.w.commandChannelsReady = true;
        f.tick();
        assert.equal(play.result.status, "ok");
        assert.equal(f.plays[0].itemId, "stable:0");
        const next = f.call("play", { id: b.id });
        f.w.commandChannelsReady = true;
        f.tick();
        assert.equal(next.result.status, "ok");
        assert.equal(f.plays[1].itemId, "stable:1");
    }
);
scenario(
    "reconfigured profile, removed stable item and ambiguous item fail closed",
    () => {
        let f = fixture();
        const a = f.call("add").result.data.entry;
        f.config.M3Us[0].www = "replacement";
        assert.equal(
            f.call("play", { id: a.id }).result.data.error,
            "profile_changed"
        );
        assert.equal(f.plays.length, 0);
        f = fixture();
        const b = f.call("add").result.data.entry;
        f.w.channels[42].itemId = "other";
        assert.equal(
            f.call("play", { id: b.id }).result.data.error,
            "item_unavailable"
        );
        f.w.channels[42].itemId = "stable:0";
        f.w.channels[43] = { itemId: "stable:0", name: "collision" };
        assert.equal(
            f.call("play", { id: b.id }).result.data.error,
            "item_unavailable"
        );
    }
);
scenario("source changes and cancellation while loading never launch", () => {
    for (const event of ["load", "driver", "cancel", "timeout"]) {
        const f = fixture();
        const entry = f.call("add").result.data.entry;
        f.selectProfile(2);
        f.w.commandChannelsReady = true;
        f.w.delay = true;
        const play = f.call("play", { id: entry.id });
        if (event === "cancel") play.cancel();
        else if (event === "timeout") f.timeout();
        else {
            if (event === "load") f.w.__ottCommandChannelLoad = {};
            else
                f.w.__ottActiveProviderDriver = {
                    ...f.w.__ottActiveProviderDriver,
                };
            f.tick();
        }
        assert.equal(play.replies.length, 1);
        assert.equal(play.result.status, "rejected");
        assert.equal(f.plays.length, 0);
    }
});
scenario(
    "archive, idle, malformed storage, memory-only storage, policy and duplicate names",
    () => {
        let f = fixture();
        f.state.target.kind = "archive";
        assert.equal(f.call("add").result.data.error, "unsupported_item");
        f = fixture();
        f.state.phase = "idle";
        assert.equal(f.call("add").result.data.error, "no_current_item");
        f = fixture({ "remoteFavorites.v1": "{" });
        assert.equal(f.call("list").result.data.error, "storage_unavailable");
        f = fixture();
        f.w.stbGetPersistedItem = () => null;
        assert.equal(f.call("add").result.data.error, "storage_unavailable");
        f = fixture();
        f.w.locked = true;
        assert.equal(f.call("add").result.data.error, "policy_denied");
        f = fixture();
        f.w.pin = true;
        assert.equal(f.call("add").result.data.error, "policy_denied");
    }
);
scenario("query and remove affect only selected index entry", () => {
    const f = fixture();
    const a = f.call("add", { name: "Три кота" }).result.data.entry;
    assert.equal(f.call("play", { query: "КОТА" }).result.status, "ok");
    assert.equal(f.call("remove", { id: a.id }).result.data.removed, true);
    assert.equal(f.call("list").result.data.entries.length, 0);
    assert.equal(
        f.call("play", { id: a.id }).result.data.error,
        "favorite_not_found"
    );
});
scenario(
    "Plex overlay retains current TV profile and validates separate media account",
    () => {
        const f = fixture();
        const ref = { itemId: "provider:123", sourceId: "plex:account" };
        f.state = {
            generation: 2,
            phase: "playing",
            target: {
                channelId: ref.itemId,
                kind: "vod",
                sourceId: ref.sourceId,
            },
        };
        f.w.__ottMedia = {
            captureFavorite: () => ({ ref, title: "Film" }),
            current: () => ({
                context: {},
                payload: {
                    plexSource: ref.sourceId,
                    request: { path: "/library/metadata/123" },
                },
                ref,
            }),
        };
        const entry = f.call("add").result.data.entry;
        assert.equal(entry.provider, "m3u");
        assert.equal(entry.profile_number, 1);
        assert.equal(f.call("play", { id: entry.id }).result.status, "ok");
        assert.deepEqual(f.plays[0].params.ids, ["123"]);
        f.w.__ottPlex.configuredSource = () => "plex:another";
        assert.equal(
            f.call("play", { id: entry.id }).result.data.error,
            "profile_changed"
        );
    }
);
scenario(
    "real media journal adds current item, not browsed item, and strips temporary URL",
    () => {
        const c = mediaFixture();
        c.providerGetPersistedItem = c.providerGetItem;
        c.mediaList(null);
        c.selectMedia(0);
        const playing = c.__ottMedia.current();
        assert(playing);
        c.mediaList(null);
        const result = c.__ottMedia.captureFavorite();
        assert(result);
        assert.equal(result.ref.itemId, playing.ref.itemId);
        const saved = c.documentState().favorites[0];
        assert.equal(saved.payload.stream_url, undefined);
        assert.equal(
            c.__ottMedia.captureFavorite().ref.itemId,
            result.ref.itemId
        );
        assert.equal(c.documentState().favorites.length, 1);
        c.catalogs[""][0].stream_url = "fresh-after-restart.mp4";
        let done;
        assert.equal(
            c.__ottMedia.playFavorite(
                result.ref,
                () => true,
                (ok) => {
                    done = ok;
                }
            ),
            true
        );
        assert.equal(done, true);
        assert(
            c.calls.some(
                (row) =>
                    row[0] === "play" && row[1] === "fresh-after-restart.mp4"
            )
        );
    }
);
scenario("real media persistence fails if only memory readback exists", () => {
    const c = mediaFixture();
    c.providerGetPersistedItem = () => null;
    c.mediaList(null);
    c.selectMedia(0);
    assert.equal(c.__ottMedia.captureFavorite(), null);
});
scenario(
    "persisted storage is authoritative and a refused same-channel dispatch never succeeds",
    () => {
        const f = fixture();
        const saved = f.call("add").result.data.entry;
        f.w.stbGetPersistedItem = () => null;
        assert.equal(f.call("list").result.data.error, "storage_unavailable");
        assert.equal(
            f.call("play", { id: saved.id }).result.data.error,
            "storage_unavailable"
        );
        f.w.stbGetPersistedItem = f.w.stbGetItem;
        f.w.playChannel = () => false;
        assert.equal(
            f.call("play", { id: saved.id }).result.data.error,
            "playback_failed"
        );
    }
);
scenario(
    "remove does not need an active profile and profile URL lock prevents switching",
    () => {
        const f = fixture();
        const entry = f.call("add").result.data.entry;
        f.selectProfile(2);
        f.w.commandChannelsReady = true;
        f.w.__ottActiveProviderDriver.fixedSlot = () => 1;
        assert.equal(
            f.call("play", { id: entry.id }).result.data.error,
            "policy_denied"
        );
        f.w.__ottActiveProviderDriver = null;
        f.w.commandChannelsReady = false;
        assert.equal(f.call("remove", { id: entry.id }).result.status, "ok");
    }
);

scenario(
    "finite channel favorites acknowledge dispatch without canceling media loading",
    () => {
        const f = fixture();
        const saved = f.call("add").result.data.entry;
        f.w.__ottActiveProviderDriver.capabilities = { mediaPlaylist: true };
        f.w.channels[42].__ottMediaItem = { request: { id: 42 } };
        f.w.closeList = () => {
            throw new Error("Do not cancel the pending media resolver");
        };
        f.w.playChannel = (category, index, fullscreen, admit) => {
            assert.equal(admit(), true);
            f.w.curList = f.w.cats[f.w.catsArray[category]];
            f.w.primaryIndex = index;
            return true;
        };
        const response = f.call("play", { id: saved.id }).result;
        assert.equal(response.status, "ok");
        assert.equal(response.data.state, "dispatched");
        assert.equal(response.data.dispatched, true);
        f.w.playChannel = () => false;
        assert.equal(
            f.call("play", { id: saved.id }).result.data.error,
            "playback_failed"
        );
    }
);
scenario(
    "generic media completion closes overlays and cancellation runs before a reentrant reply",
    () => {
        const f = fixture();
        const ref = { itemId: "provider:9", sourceId: "m3u:0@first:media" };
        f.state = {
            generation: 2,
            phase: "playing",
            target: {
                channelId: ref.itemId,
                kind: "vod",
                sourceId: ref.sourceId,
            },
        };
        let completion,
            cancelled = 0,
            closed = 0;
        f.w.closeList = (restore) => {
            assert.equal(restore, false);
            closed++;
        };
        f.w.__ottMedia = {
            cancelAuto() {
                cancelled++;
            },
            captureFavorite: () => ({ ref, title: "Film" }),
            current: () => ({ payload: { request: { id: 9 } }, ref }),
            playFavorite(_ref, guard, done) {
                assert(guard());
                completion = done;
                return true;
            },
        };
        const entry = f.call("add").result.data.entry;
        const play = f.call("play", { id: entry.id });
        completion(true);
        assert.equal(play.result.status, "ok");
        assert.equal(closed, 1);
        let response;
        const stop = f.w.exports.executeRemoteFavorites(
            f.w,
            "runtime-test",
            { params: { id: entry.id, op: "play", runtime: "runtime-test" } },
            (value) => {
                assert.equal(
                    cancelled,
                    1,
                    "the old owner is cancelled before reply can admit new work"
                );
                response = value;
                assert.equal(f.call("list").result.status, "ok");
            }
        );
        stop();
        assert.equal(response.data.error, "cancelled");
    }
);
scenario(
    "real media missing or ambiguous identity fails rather than using old URL",
    () => {
        for (const ambiguous of [false, true]) {
            const c = mediaFixture();
            c.providerGetPersistedItem = c.providerGetItem;
            c.catalogs[""][0].id = "stable-media";
            c.mediaList(null);
            c.selectMedia(0);
            const saved = c.__ottMedia.captureFavorite();
            assert(saved);
            c.catalogs[""] = ambiguous
                ? [c.catalogs[""][0], c.catalogs[""][0]]
                : [];
            const before = c.calls.filter((row) => row[0] === "play").length;
            let result;
            assert.equal(
                c.__ottMedia.playFavorite(
                    saved.ref,
                    () => true,
                    (ok) => {
                        result = ok;
                    }
                ),
                true
            );
            assert.equal(result, false);
            assert.equal(
                c.calls.filter((row) => row[0] === "play").length,
                before
            );
        }
    }
);
scenario(
    "shared favorite contract matches player capability and error enum",
    () => {
        const contract = JSON.parse(
            fs.readFileSync("contracts/favorites-v1.json", "utf8")
        );
        const module = {};
        vm.runInNewContext(
            compile("src/commands/remote-favorites-contract.ts"),
            { exports: module }
        );
        assert.equal(
            module.remoteFavoritesCapability.max_items,
            contract.max_items
        );
        assert.deepEqual(
            plain(module.remoteFavoritesCapability.operations),
            contract.operations
        );
        for (const match of fs
            .readFileSync("src/commands/remote-favorites.ts", "utf8")
            .matchAll(/(?:finish|fail)\("([a-z_]+)"/g))
            assert(contract.errors.includes(match[1]), match[1]);
    }
);
scenario(
    "real media favorite survives runtime recreation and resolves current provider URL",
    () => {
        const first = mediaFixture();
        first.providerGetPersistedItem = first.providerGetItem;
        first.catalogs[""][0].id = "stable-movie";
        first.mediaList(null);
        first.selectMedia(0);
        const saved = first.__ottMedia.captureFavorite();
        assert(saved);
        const second = mediaFixture();
        second.providerGetPersistedItem = second.providerGetItem;
        Object.assign(second.stored, first.stored);
        second.catalogs[""][0].id = "stable-movie";
        second.catalogs[""][0].stream_url = "resolved-in-new-runtime.mp4";
        let result;
        assert.equal(
            second.__ottMedia.playFavorite(
                saved.ref,
                () => true,
                (ok) => {
                    result = ok;
                }
            ),
            true
        );
        assert.equal(result, true);
        assert(
            second.calls.some(
                (row) =>
                    row[0] === "play" &&
                    row[1] === "resolved-in-new-runtime.mp4"
            )
        );
    }
);
scenario(
    "current parental channel and media policies apply before persistence",
    () => {
        const f = fixture();
        f.w.hasParentalLock = () => true;
        f.w.__ottParental.needs = (area) => area === "channels";
        assert.equal(f.call("add").result.data.error, "policy_denied");
        assert.equal(f.storage["remoteFavorites.v1"], undefined);
    }
);
scenario("saved healthy profile recovers from a current failed catalog", () => {
    const f = fixture();
    const saved = f.call("add").result.data.entry;
    f.selectProfile(2);
    f.w.commandChannelsReady = false;
    const reply = f.call("play", { id: saved.id }).result;
    assert.equal(reply.status, "ok");
    assert.equal(f.plays[0].profile, 0);
});
scenario("unstable title-occurrence movie references are refused", () => {
    const c = originalMediaFixture();
    c.providerGetPersistedItem = c.providerGetItem;
    c.catalogs[""] = [
        { stream_url: "first.mp4", title: "Same" },
        { stream_url: "second.mp4", title: "Same" },
    ];
    c.mediaList(null);
    c.selectMedia(0);
    const ref = c.__ottMedia.current().ref;
    assert(ref.itemId.startsWith("catalog:"));
    assert.equal(c.__ottMedia.captureFavorite(), null);
    c.catalogs[""].reverse();
    assert.equal(
        c.__ottMedia.playFavorite(
            ref,
            () => true,
            () => assert.fail("must not dispatch")
        ),
        false
    );
});
scenario(
    "fresh media adult metadata and delayed policy changes are checked before dispatch",
    () => {
        for (const delayed of [false, true]) {
            const c = mediaFixture();
            c.providerGetPersistedItem = c.providerGetItem;
            c.mediaList(null);
            c.selectMedia(0);
            const saved = c.__ottMedia.captureFavorite();
            assert(saved);
            c.catalogs[""][0].adult = 1;
            let locked = !delayed,
                pending;
            c.__ottParental = { needs: () => locked };
            if (delayed)
                c.providerMediaClient = {
                    cancel() {},
                    resolve(payload, done) {
                        pending = () =>
                            done({ ...payload, stream_url: "adult.mp4" });
                    },
                };
            const before = c.calls.filter((row) => row[0] === "play").length;
            let result;
            assert.equal(
                c.__ottMedia.playFavorite(
                    saved.ref,
                    () => true,
                    (ok) => {
                        result = ok;
                    }
                ),
                true
            );
            if (delayed) {
                assert(pending);
                locked = true;
                pending();
            }
            assert.equal(result, false);
            assert.equal(
                c.calls.filter((row) => row[0] === "play").length,
                before
            );
            assert(!c.calls.some((row) => row[0] === "pin"));
        }
    }
);
scenario(
    "VOD without a durable resolver reports unsupported, not storage failure",
    () => {
        const f = fixture();
        const ref = { itemId: "provider:9", sourceId: "m3u:0@first:media" };
        f.state = {
            generation: 2,
            phase: "playing",
            target: {
                channelId: ref.itemId,
                kind: "vod",
                sourceId: ref.sourceId,
            },
        };
        f.w.__ottMedia = { current: () => ({ payload: {}, ref }) };
        assert.equal(f.call("add").result.data.error, "unsupported_item");
        f.w.__ottMedia.current = () => ({
            payload: { request: { id: 9 } },
            ref,
        });
        assert.equal(f.call("add").result.data.error, "unsupported");
    }
);
console.log(`PASS ${passed} remote favorites groups`);
