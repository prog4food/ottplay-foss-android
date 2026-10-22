const assert = require("node:assert/strict");
const { fixture, sourceFunctions } = require("./test_port_vod.cjs");
const vm = require("node:vm");

function setup(provider = "plex") {
    const c = fixture();
    const pending = [];
    c.p_pref = provider;
    c.__ottActiveProviderDriver = {
        capabilities: { mediaPlaylist: true },
        id: provider,
    };
    c.channels = {};
    c.cats = { All: [101, 102, 103] };
    c.catsArray = ["All"];
    c.curList = c.cats.All;
    c.cList = c.curList;
    c.__ottChannels = {
        capture: () => ({
            active: () => c.__ottActiveProviderDriver.id === provider,
            category: () => 0,
            members: () => c.cats.All.slice(),
        }),
        group: () => "system:all",
        index: (group) => (group === "system:all" ? 0 : -1),
        select() {},
    };
    for (const id of c.cats.All)
        c.channels[id] = {
            __ottMediaItem: {
                id,
                request: { id },
                title: "Film " + id,
            },
            channel_name: "Film " + id,
        };
    c.ifParentalAccessChId = () => false;
    c.getChannelUrl = () => "";
    c.channelsList = () => c.calls.push(["channels"]);
    c.playChannel = c._playChannel;
    c.stbPlay = (url, position) => {
        c.calls.push(["play", url, position]);
        c.__ottClassicPlayback.command({ type: "playing" });
    };
    c.providerMediaClient = {
        cancel() {},
        cancelAutomatic() {},
        resolve(item, done) {
            pending.push({ done, item });
        },
        stableRequests: true,
    };
    function resolve(index = pending.length - 1) {
        const { item, done } = pending[index];
        done({ ...item, stream_url: "film-" + item.id + ".mp4" });
    }
    function end() {
        c.__ottClassicPlayback.command({ type: "stop" });
        c.__ottMedia.ended(c.__ottClassicPlayback.snapshot().generation);
    }
    return { c, end, pending, resolve };
}

// Real VPortal resolution must settle the bridge's owned loading transaction.
function setupVPortal() {
    const { c } = setup("vportal");
    vm.runInContext(
        sourceFunctions("src/plugins/vportal.ts", [
            "parseVPortalLink",
            "hostedVPortalRoute",
            "createVPortalClient",
        ]),
        c
    );
    const requests = [];
    c.$.ajax = (options) => {
        const request = {
            abort() {
                options.error({}, "abort");
                options.complete();
            },
            fail() {
                options.error({}, "error");
                options.complete();
            },
            receive(value) {
                options.success(value);
                options.complete();
            },
        };
        requests.push(request);
        return request;
    };
    c.providerMediaClient = c.createVPortalClient(
        "portal::[key:fixture]https://portal.example/api/"
    );
    c.alert = () => assert.fail("Channel playback reports a nonmodal failure");
    c.showShift = (text) => {
        assert.equal(
            c.elements["#dialogbox"].style.display,
            "none",
            "owned loading closes before showing a resolution error"
        );
        c.calls.push(["shift", text]);
    };
    return { c, requests };
}
for (const direct of [false, true]) {
    for (const failure of [
        "network",
        "throw",
        "null",
        "malformed",
        "missing",
    ]) {
        const { c, requests } = setupVPortal();
        if (direct)
            c.channels[101].__ottMediaItem = {
                __ottMediaOrigin: {
                    target: { request: { cmd: "season", id: 3 } },
                },
                __ottVPortalDirect: { id: { field: "id", value: "101" } },
                id: 101,
                stream_url: "https://cdn.example/expired.mp4",
                title: "Film 101",
            };
        const ajax = c.$.ajax;
        if (failure === "throw")
            c.$.ajax = () => {
                throw Error("fixture-private-key");
            };
        c._playChannel(0, 0);
        if (failure !== "throw") {
            assert.match(c.elements["#dialogbox"].innerHTML, /ott-spinner/);
            assert.equal(c.elements["#dialogbox"].style.display, "");
            if (failure === "network") requests[0].fail();
            else
                requests[0].receive(
                    failure === "null"
                        ? null
                        : {
                              items: [],
                              type:
                                  failure === "missing"
                                      ? "category"
                                      : "invalid",
                          }
                );
        }
        assert.equal(c.elements["#dialogbox"].style.display, "none");
        assert.equal(c.calls.filter(([kind]) => kind === "shift").length, 1);
        assert.equal(c.calls.filter(([kind]) => kind === "channels").length, 1);
        assert.equal(c.calls.filter(([kind]) => kind === "play").length, 0);
        c.$.ajax = ajax;
        c._playChannel(0, 0);
        const retry = requests.at(-1);
        if (requests.length > 1) {
            requests[0].fail();
            requests[0].receive({ url: "https://cdn.example/stale.mp4" });
            assert.equal(
                c.calls.filter(([kind]) => kind === "shift").length,
                1
            );
            assert.equal(c.elements["#dialogbox"].style.display, "");
        }
        retry.receive(
            direct
                ? {
                      items: [
                          {
                              id: 101,
                              type: "stream",
                              url: "https://cdn.example/retry.mp4",
                          },
                      ],
                      type: "category",
                  }
                : { url: "https://cdn.example/retry.mp4" }
        );
        assert.equal(c.elements["#dialogbox"].style.display, "none");
        assert.equal(c.calls.filter(([kind]) => kind === "play").length, 1);
        assert.equal(
            c.__ottMedia.current().payload.stream_url,
            "https://cdn.example/retry.mp4"
        );
    }
}
{
    const { c, requests } = setupVPortal();
    c._playChannel(0, 0);
    c.dialogBoxKeyHandler(c.keys.RETURN);
    c._playChannel(0, 1);
    requests[0].fail();
    requests[0].receive({ url: "https://cdn.example/cancelled.mp4" });
    assert.equal(c.calls.filter(([kind]) => kind === "shift").length, 0);
    assert.equal(c.calls.filter(([kind]) => kind === "play").length, 0);
    assert.equal(c.elements["#dialogbox"].style.display, "");
    requests[1].receive({ url: "https://cdn.example/current.mp4" });
    assert.equal(c.__ottMedia.current().payload.id, 102);
}
console.log(
    "PASS VPortal resolution failures close owned loading, retry, and ignore stale callbacks"
);

for (const provider of ["plex", "vportal"]) {
    const { c, pending, resolve, end } = setup(provider);
    assert.equal(c._playChannel(0, 1), true);
    assert.equal(pending.length, 1);
    assert.match(c.elements["#dialogbox"].innerHTML, /ott-spinner/);
    assert.equal(c.calls.filter(([kind]) => kind === "play").length, 0);
    resolve();
    assert.equal(c.elements["#dialogbox"].style.display, "none");
    assert.equal(c.primaryIndex, 1);
    assert.equal(c.curList[c.primaryIndex], 102);
    const state = c.__ottClassicPlayback.snapshot();
    assert.equal(state.target.kind, "vod");
    assert.equal(state.target.channelId, "provider:102");
    assert.equal(state.historyTarget.kind, "live");
    assert.equal(state.historyTarget.channelId, "102");
    assert.equal(c.playType, -99999999999);
    assert.equal(c.__ottMedia.kioskSelection(), null);
    vm.runInContext(
        sourceFunctions("src/key-handler/index.ts", [
            "handleMainKey",
            "keyFun",
            "toggleMainPlayback",
        ]),
        c
    );
    const seeks = [];
    c.shiftArchive = (seconds) => seeks.push(seconds);
    c.settings.alFun = 14;
    c.settings.arFun = 13;
    for (const key of [c.keys.LEFT, c.keys.RIGHT])
        c.handleMainKey(key, { preventDefault() {}, stopPropagation() {} });
    assert.deepEqual(seeks, [-10, 10]);

    // The same list owns reshuffling and incrementally published entries.
    c.cats.All = [102, 103, 101, 104];
    c.curList = c.cats.All;
    c.primaryIndex = 0;
    c.channels[104] = {
        __ottMediaItem: { id: 104, request: { id: 104 }, title: "Added film" },
    };
    c.handleMainKey(c.keys.UP, { preventDefault() {}, stopPropagation() {} });
    assert.equal(pending.at(-1).item.id, 103);
    resolve();
    assert.equal(c.primaryIndex, 1);
    c.handleMainKey(c.keys.DOWN, { preventDefault() {}, stopPropagation() {} });
    assert.equal(pending.at(-1).item.id, 102);
    resolve();
    c._playChannel(0, 2);
    resolve();
    c.isListVisible = true;
    const closes = c.calls.filter(([kind]) => kind === "close").length;
    end();
    assert.equal(
        c.calls.filter(([kind]) => kind === "close").length,
        closes,
        "natural completion leaves a reopened channel list open"
    );
    c.isListVisible = false;
    assert.equal(
        pending.at(-1).item.id,
        104,
        "EOS observes newly appended rows"
    );
    resolve();
    end();
    assert.equal(pending.at(-1).item.id, 102, "repeat all wraps current order");
    resolve();
    c.__ottMedia.cycleRepeat();
    assert.equal(c.__ottMedia.repeatMode(), "one");
    end();
    assert.equal(pending.at(-1).item.id, 102);
    resolve();
    c.__ottMedia.cycleRepeat();
    assert.equal(c.__ottMedia.repeatMode(), "off");
    c._playChannel(0, 3);
    resolve();
    const count = pending.length;
    end();
    assert.equal(pending.length, count, "repeat off stops at final row");
    console.log(
        "PASS " +
            provider +
            " channel playback, loading, selection, dynamic order and repeat"
    );
}

for (const provider of ["plex", "vportal"]) {
    for (const mode of ["all", "one", "off"]) {
        const { c, pending, resolve, end } = setup(provider);
        while (c.__ottMedia.repeatMode() !== mode) c.__ottMedia.cycleRepeat();
        c._playChannel(0, mode === "one" ? 2 : 0);
        resolve();
        c.isListVisible = true;
        const handler = () => {};
        const owner = c.__ottClassicScreenPort.setOwnedCallback(
            "dialog",
            handler
        ).owner;
        const ownedHandler = c.dialogBoxKeyHandler;
        c.$("#dialogbox").html("Actions").show();
        const closes = c.calls.filter(([kind]) => kind === "close").length;
        end();
        assert.equal(pending.length, 2);
        c.__ottMedia.cycleRepeat();
        assert.equal(
            pending.length,
            mode === "one" ? 2 : 3,
            "Repeat restarts pending EOS with its new mode, except Off at the final file"
        );
        resolve(1);
        assert.equal(
            c.calls.filter(([kind]) => kind === "play").length,
            1,
            "The cancelled pre-change resolver cannot start its old choice"
        );
        if (mode !== "one") {
            assert.equal(pending[2].item.id, mode === "all" ? 101 : 102);
            resolve(2);
            assert.equal(c.calls.filter(([kind]) => kind === "play").length, 2);
            assert.equal(
                c.__ottMedia.current().payload.id,
                mode === "all" ? 101 : 102
            );
        } else assert.equal(c.__ottClassicPlayback.snapshot().phase, "stopped");
        assert(
            owner.active() && owner.foreground(),
            "Actions keeps screen ownership"
        );
        assert.equal(c.dialogBoxKeyHandler, ownedHandler);
        assert.equal(c.elements["#dialogbox"].innerHTML, "Actions");
        assert.equal(
            c.calls.filter(([kind]) => kind === "close").length,
            closes
        );
    }
    console.log(
        "PASS " +
            provider +
            " repeat changes re-admit pending channel EOS without replacing Actions"
    );
}
for (const retire of ["cancel", "source", "manual"]) {
    const { c, pending, resolve, end } = setup();
    c._playChannel(0, 0);
    resolve();
    end();
    if (retire === "cancel") c.__ottMedia.cancelAuto();
    else if (retire === "manual") c._playChannel(0, 2);
    else
        c.providerMediaClient.cancelAutomatic = () => {
            c.p_pref = "changed";
            c.__ottActiveProviderDriver = { capabilities: {}, id: "changed" };
        };
    const count = pending.length;
    c.__ottMedia.cycleRepeat();
    assert.equal(
        pending.length,
        count,
        "A repeat change cannot re-admit a cancelled, replaced or foreign-source transition"
    );
    for (let index = 1; index < pending.length; index++) resolve(index);
    assert.equal(c.calls.filter(([kind]) => kind === "play").length, 1);
}
console.log(
    "PASS repeat changes preserve cancellation, source and manual-selection ownership"
);

{
    const { c, pending, resolve } = setup();
    c._playChannel(0, 0);
    c.dialogBoxKeyHandler(c.keys.RETURN);
    resolve();
    assert.equal(c.calls.filter(([kind]) => kind === "play").length, 0);
    assert(c.calls.some(([kind]) => kind === "channels"));
    c._playChannel(0, 1);
    c._playChannel(0, 2);
    resolve(1);
    assert.equal(c.calls.filter(([kind]) => kind === "play").length, 0);
    resolve(2);
    assert.equal(c.calls.filter(([kind]) => kind === "play").length, 1);
    assert.equal(c.__ottMedia.current().payload.id, 103);
    assert.equal(pending.length, 3);
    console.log(
        "PASS channel cancellation and replacement reject stale resolvers"
    );
}

{
    const { c, pending, resolve, end } = setup();
    c._playChannel(0, 0);
    resolve();
    c._playChannel(0, 1);
    end();
    assert.equal(
        pending.length,
        2,
        "old EOS does not replace pending selection"
    );
    resolve();
    assert.equal(c.__ottMedia.current().payload.id, 102);
    assert.equal(c.__ottClassicPlayback.snapshot().phase, "playing");
    console.log("PASS old decoder EOS preserves selected pending channel");
}

{
    const { c, resolve } = setup();
    c.parentalArray = [];
    const priorIndex = c.primaryIndex;
    assert.equal(
        c._playChannel(0, 1, true, () => c.primaryIndex === priorIndex),
        true
    );
    resolve();
    assert.equal(
        c.__ottMedia.current().payload.id,
        102,
        "relative command admission applies before committing its new selection"
    );
    console.log(
        "PASS relative channel admission is not reused after selection commits"
    );
}

{
    const { c, resolve, end, pending } = setup();
    c.__ottKiosk = {
        admit: (id) => id === 102,
        allowed: (id) => id === 102,
        allowedMedia: () => false,
        enabled: () => true,
        locked: () => true,
    };
    assert.equal(c._playChannel(0, 1), true);
    resolve();
    assert.equal(c.__ottMedia.current().payload.id, 102);
    assert.equal(c._playChannel(0, 0), undefined);
    end();
    assert.equal(
        pending.at(-1).item.id,
        102,
        "pinned channel loops without attempting another file"
    );
    resolve();
    assert.equal(c.__ottClassicPlayback.snapshot().phase, "playing");
    console.log("PASS channel kiosk admission and immediate pinned replay");
}

for (const provider of ["plex", "vportal"]) {
    const seed = setup(provider);
    const positions = [137.25, 248.5, 369.75];
    for (let index = 0; index < positions.length; index++) {
        seed.c._playChannel(0, index);
        seed.resolve();
        seed.c.__ottClassicPlayback.command({
            position: positions[index],
            type: "position",
        });
        seed.c.__ottMedia.checkpoint(
            seed.c.__ottMedia.current().ref,
            positions[index],
            true
        );
    }
    const cold = setup(provider);
    Object.assign(cold.c.stored, seed.c.stored);
    cold.c.commandChannelsReady = false;
    cold.c._playChannel(0, 1);
    cold.resolve();
    assert.equal(
        cold.c.calls.filter(([kind]) => kind === "play").at(-1)[2],
        positions[1],
        "startup resumes the selected file at its exact persisted position"
    );
    assert.equal(cold.c.calls.filter(([kind]) => kind === "confirm").length, 0);

    const kiosk = setup(provider);
    Object.assign(kiosk.c.stored, seed.c.stored);
    kiosk.c.commandChannelsReady = true;
    kiosk.c.__ottKiosk = {
        admit: (id) => id === 102,
        allowed: (id) => id === 102,
        allowedMedia: () => false,
        enabled: () => true,
        locked: () => true,
    };
    kiosk.c._playChannel(0, 1);
    kiosk.resolve();
    assert.equal(
        kiosk.c.calls.filter(([kind]) => kind === "play").at(-1)[2],
        positions[1],
        "kiosk recovery resumes its pinned file at the exact saved position"
    );
    assert.equal(
        kiosk.c.calls.filter(([kind]) => kind === "confirm").length,
        0
    );
    kiosk.end();
    kiosk.resolve();
    assert.equal(
        kiosk.c.calls.filter(([kind]) => kind === "play").at(-1)[2],
        0,
        "natural kiosk replay starts at zero instead of restoring position"
    );
    assert.equal(
        kiosk.c.calls.filter(([kind]) => kind === "confirm").length,
        0
    );

    const manual = setup(provider);
    Object.assign(manual.c.stored, seed.c.stored);
    manual.c.commandChannelsReady = true;
    let confirm;
    let prompts = 0;
    manual.c.confirmBox = (_message, yes) => {
        confirm = yes;
        prompts++;
    };
    manual.c._playChannel(0, 1);
    manual.resolve();
    assert.equal(prompts, 1, "ordinary selection retains Continue watching");
    confirm();
    assert.equal(
        manual.c.calls.filter(([kind]) => kind === "seek").at(-1)[1],
        manual.c.OttPlayCore.mediaResumePosition(positions[1], 60)
    );
    manual.c.__ottMedia.skip(1);
    manual.resolve();
    assert.equal(prompts, 1, "next file never opens a resume prompt");
    assert.equal(
        manual.c.calls.filter(([kind]) => kind === "play").at(-1)[2],
        0,
        "next file starts at zero despite its saved history"
    );
    manual.end();
    manual.resolve();
    assert.equal(prompts, 1, "natural completion never opens a resume prompt");
    assert.equal(
        manual.c.calls.filter(([kind]) => kind === "play").at(-1)[2],
        0
    );

    for (const natural of [true, false]) {
        const locked = setup(provider);
        Object.assign(locked.c.stored, seed.c.stored);
        locked.c.commandChannelsReady = false;
        locked.c._playChannel(0, 0);
        locked.resolve();
        locked.c.commandChannelsReady = true;
        locked.c.isListVisible = true;
        let unlock;
        locked.c.ifParentalAccessChId = (_id, next) => {
            unlock = next;
            return true;
        };
        const closes = locked.c.calls.filter(
            ([kind]) => kind === "close"
        ).length;
        if (natural) locked.end();
        else locked.c.__ottMedia.skip(1);
        assert.equal(locked.pending.length, 1, "PIN defers the next file");
        assert.equal(typeof unlock, "function");
        locked.c.ifParentalAccessChId = () => false;
        unlock();
        assert.equal(locked.pending.at(-1).item.id, 102);
        locked.resolve();
        assert.equal(
            locked.c.calls.filter(([kind]) => kind === "play").at(-1)[2],
            0,
            "PIN continuation preserves start-at-zero for the next file"
        );
        assert.equal(
            locked.c.calls.filter(([kind]) => kind === "confirm").length,
            0,
            "PIN continuation must not turn an advance into a resume prompt"
        );
        const after = locked.c.calls.filter(
            ([kind]) => kind === "close"
        ).length;
        if (natural)
            assert.equal(
                after,
                closes,
                "background advance keeps the list open after PIN"
            );
        else assert(after > closes, "arrow advance opens fullscreen after PIN");
    }
    console.log(
        "PASS " +
            provider +
            " exact startup resume, manual resume prompt, and fresh automatic/arrow playback"
    );
}

// Native/Browser Local sources use plain finite channels, without a media queue.
for (const mode of ["all", "one", "off"]) {
    const { c, end } = setup("offline");
    c.checkMedia = () => {};
    c.channels = Object.fromEntries(
        c.cats.All.map((id) => [id, { channel_name: "Local " + id }])
    );
    while (c.__ottMedia.repeatMode() !== mode) c.__ottMedia.cycleRepeat();
    c._playChannel(0, 2);
    const moves = [];
    c.playChannel = (...args) => moves.push(args);
    end();
    assert.equal(moves.length, mode === "off" ? 0 : 1);
    end();
    assert.equal(
        moves.length,
        mode === "off" ? 0 : 1,
        "duplicate EOF cannot advance twice"
    );
    if (moves.length) {
        assert.equal(moves[0][0], 0);
        assert.equal(moves[0][1], mode === "one" ? 2 : 0);
        assert.equal(
            moves[0][2],
            false,
            "natural completion keeps the list open"
        );
        assert.equal(moves[0][5], true);
        assert.equal(moves[0][6], true, "next Local file starts at zero");
        assert.equal(moves[0][3](), true, "current completion may start");
        c.__ottClassicPlayback.command({ channelId: 102, type: "live" });
        assert.equal(
            moves[0][3](),
            false,
            "late PIN completion cannot override a manual selection"
        );
    }
}
{
    const { c, end } = setup("offline");
    c.checkMedia = () => {};
    c.channels = Object.fromEntries(
        c.cats.All.map((id) => [id, { channel_name: "Local " + id }])
    );
    c._playChannel(0, 1);
    c.__ottKiosk = { allowed: (id) => id === 102, locked: () => true };
    const moves = [];
    c.playChannel = (...args) => moves.push(args);
    end();
    assert.equal(moves.length, 1);
    assert.equal(moves[0][1], 1, "pinned Local file loops itself");
}
console.log(
    "PASS Local finite-channel completion, repeat, kiosk and stale guards"
);
// Use the real library: numeric category positions can move during playback.
for (const action of [
    "move",
    "remove",
    "shuffle",
    "manual",
    "legacy",
    "unknown",
    "removed-channel",
]) {
    const c = fixture();
    c.p_pref = "offline";
    c.__ottActiveProviderDriver = { id: "offline" };
    c.channels = {
        101: { category: { name: "A" }, channel_name: "A1" },
        102: { category: { name: "A" }, channel_name: "A2" },
        103: { category: { name: "B" }, channel_name: "B1" },
    };
    c.cList = [101, 102, 103];
    c.__ottChannels.mount(c);
    c.__ottChannels.change("member", {
        action: "add",
        channelId: 101,
        groupId: "provider:B",
    });
    if (c.__ottChannels.index("provider:A") !== 1)
        assert(c.__ottChannels.change("move", "provider:A", -1));
    c.__ottParental = { needs: () => false };
    c.ifParentalAccessChId = () => false;
    c.getChannelUrl = (id) => "file-" + id + ".mp4";
    c.checkMedia = () => {};
    c.playChannel = c._playChannel;
    const category = c.__ottChannels.index("provider:A");
    assert.equal(category, 1);
    c._playChannel(category, 0);
    const capturedGroup = JSON.parse(
        JSON.stringify(c.__ottClassicPlayback.snapshot())
    ).historyTarget.payload.groupId;
    if (action === "move")
        assert(c.__ottChannels.change("move", "provider:A", 1));
    if (action === "remove")
        assert(c.__ottChannels.change("remove", "provider:A"));
    if (action === "move") {
        c.__ottClassicPlayback.checkpoint(
            c.__ottClassicPlayback.snapshot(),
            true
        );
        const journal = JSON.parse(c.stored.playbackJournal);
        assert.equal(
            journal.bookmark.groupId,
            "provider:A",
            "checkpoint retains group after reorder"
        );
    }
    if (action === "shuffle") {
        vm.runInContext("Math.random = function () { return 0; };", c);
        assert(c.__ottChannels.change("shuffle", "provider:A"));
    }
    c.__ottClassicPlayback.command({ type: "stop" });
    const generation = c.__ottClassicPlayback.snapshot().generation;
    if (action === "manual")
        c._playChannel(c.__ottChannels.index("provider:B"), 0);
    if (action === "removed-channel") delete c.channels[101];
    if (action === "legacy" || action === "unknown") {
        const snapshot = c.__ottClassicPlayback.snapshot;
        c.__ottClassicPlayback.snapshot = () => {
            const state = JSON.parse(JSON.stringify(snapshot()));
            if (action === "legacy") delete state.historyTarget.payload.groupId;
            else state.historyTarget.payload.groupId = "removed:unknown";
            return state;
        };
    }
    const programme = c.__ottClassicPlayback.programme();
    if (action === "removed-channel") assert.equal(programme, null);
    else if (action !== "manual") {
        assert.equal(
            programme.title,
            "A1",
            action + " retains the current file"
        );
        assert.equal(
            programme.collection,
            "A",
            action + " retains the containing folder"
        );
        assert.equal(
            programme.nextTitle,
            action === "move" || action === "shuffle" ? "A2" : "",
            action + " never guesses a successor from another group"
        );
    }
    const before = c.calls.filter(([kind]) => kind === "play").length;
    c.__ottMedia.ended(generation);
    const plays = c.calls.filter(([kind]) => kind === "play");
    if (action === "move" || action === "shuffle") {
        assert.equal(plays.length, before + 1);
        assert.equal(
            plays[plays.length - 1][1],
            "file-102.mp4",
            action + " retains the playing group instead of its old index"
        );
    } else {
        assert.equal(
            plays.length,
            before,
            action + " cannot redirect the completed group's playback"
        );
    }
    c.__ottMedia.ended(generation);
    assert.equal(
        c.calls.filter(([kind]) => kind === "play").length,
        plays.length,
        "duplicate EOF remains stale after " + action
    );
    assert.equal(
        capturedGroup,
        "provider:A",
        "Local playback captures serializable group identity at start"
    );
    if (action === "move") {
        const journal = JSON.parse(c.stored.playbackJournal);
        assert.equal(
            journal.history.find((entry) => entry.channelId === "101").groupId,
            "provider:A",
            "history serialization retains departing group"
        );
        c.__ottClassicPlayback.hydrate();
        const previous = c.prevArr.find((entry) => String(entry.ci) === "101");
        assert.equal(
            previous.groupId,
            "provider:A",
            "hydration preserves stable group on previous entry"
        );
        assert(c.__ottChannels.change("move", "provider:A", -1));
        vm.runInContext(
            sourceFunctions("src/key-handler/index.ts", ["onPrevSelect"]),
            c
        );
        c.onPrevSelect(c.prevArr.indexOf(previous));
        assert.equal(
            c.catIndex,
            c.__ottChannels.index("provider:A"),
            "manual previous uses stable group after another reorder"
        );
        assert.equal(c.curList[c.primaryIndex], 101);
    }
}
console.log("PASS Local EOF retains group identity across library edits");
{
    const { c, end } = setup("offline");
    c.checkMedia = () => {};
    c.channels = Object.fromEntries(
        c.cats.All.map((id) => [id, { channel_name: "Local " + id }])
    );
    c.sStopPlay = 1;
    c.parentalArray = [];
    c.__ottParental = { needs: () => false };
    let stops = 0;
    c.stbStop = () => {
        stops++;
        c.__ottMedia.cancelAuto();
        c.__ottClassicPlayback.cancel();
        c.__ottClassicPlayback.command({ type: "stop" });
    };
    c._playChannel(0, 0);
    const before = stops;
    end();
    assert.equal(
        stops,
        before,
        "EOF does not redundantly stop the retired decoder"
    );
    assert.equal(
        c.primaryIndex,
        1,
        "real channel transition survives stop-before-play"
    );
    assert.equal(c.__ottClassicPlayback.snapshot().phase, "playing");
}

// Footer is an observation of the playing source, never the open browser view.
{
    const { c, resolve } = setup("plex");
    c.channels[101].__ottMediaCollection = "Selected collection";
    c._playChannel(0, 0);
    resolve();
    let programme = c.__ottClassicPlayback.programme();
    assert.equal(programme.collection, "Selected collection");
    assert.equal(programme.title, "Film 101");
    assert.equal(programme.nextTitle, "Film 102");
    c.cats.All = [101, 103, 102];
    assert.equal(
        c.__ottClassicPlayback.programme().nextTitle,
        "Film 103",
        "shuffle uses the live list"
    );
    c.__ottMedia.cycleRepeat();
    assert.equal(
        c.__ottClassicPlayback.programme().nextTitle,
        "Film 101",
        "repeat one projects itself"
    );
    c.__ottMedia.cycleRepeat();
    c.cats.All = [102, 103, 101];
    assert.equal(
        c.__ottClassicPlayback.programme().nextTitle,
        "",
        "repeat off has no next item at the end"
    );
}
{
    const { c } = setup("offline");
    c.checkMedia = () => {};
    c.channels = Object.fromEntries(
        c.cats.All.map((id) => [
            id,
            {
                __ottMediaCollection: "Actual nested folder",
                channel_name: "Local " + id,
            },
        ])
    );
    let clock = 1000000;
    c.Date = class extends Date {
        static now() {
            return clock;
        }
    };
    c._playChannel(0, 0);
    c.__ottClassicPlayback.command({
        duration: 17.25,
        position: 2,
        type: "position",
    });
    let programme = c.__ottClassicPlayback.programme();
    assert.equal(programme.collection, "Actual nested folder");
    assert.equal(programme.title, "Local 101");
    assert.equal(programme.nextTitle, "Local 102");
    assert.equal(programme.startedAt, 1000);
    assert.equal(
        programme.nextStartedAt,
        1017.25,
        "uses full precise duration"
    );
    clock += 5000;
    c.__ottClassicPlayback.command({ type: "pause" });
    c.__ottClassicPlayback.command({ position: 12, type: "position" });
    c.__ottClassicPlayback.command({ type: "playing" });
    assert.equal(
        c.__ottClassicPlayback.programme().startedAt,
        1000,
        "pause, seek and recovery do not shift the clock"
    );
    const oldGeneration = c.__ottClassicPlayback.snapshot().generation;
    c.__ottClassicPlayback.command({ channelId: 101, type: "live" });
    c.__ottClassicPlayback.command({
        generation: oldGeneration,
        type: "playing",
    });
    assert.equal(
        c.__ottClassicPlayback.programme().startedAt,
        null,
        "stale playing cannot stamp a new file"
    );
    c.__ottClassicPlayback.command({ type: "playing" });
    assert.equal(c.__ottClassicPlayback.programme().startedAt, 1005);
    c._playChannel(0, 0);
    assert.equal(
        c.__ottClassicPlayback.programme().startedAt,
        1005,
        "a real restart of same file owns a new start clock"
    );
    assert.equal(
        c.__ottClassicPlayback.programme().nextStartedAt,
        null,
        "unknown new duration has no invented next clock"
    );
    c.primaryIndex = 1;
    c.__ottClassicPlayback.reconcile();
    assert.equal(
        c.__ottClassicPlayback.programme().startedAt,
        null,
        "reconciled source selection cannot inherit another file start clock"
    );
    c.__ottClassicPlayback.command({ type: "playing" });
    c.__ottKiosk = { allowed: () => true, locked: () => true };
    assert.equal(
        c.__ottClassicPlayback.programme().nextTitle,
        "",
        "legacy reconciliation without a captured group cannot guess a kiosk successor"
    );
}
console.log(
    "PASS finite programme collection, next-item ownership and anchored start clock"
);
{
    const { c, resolve } = setup("vportal");
    c.__ottClassicPlayback.reconcile();
    c.__ottMedia.playQueue(
        [
            { id: 201, request: { id: 201 }, title: "Queue first" },
            { id: 202, request: { id: 202 }, title: "Queue second" },
        ],
        "Remote collection",
        () => true,
        () => {}
    );
    resolve();
    const programme = c.__ottClassicPlayback.programme();
    assert.equal(programme.collection, "Remote collection");
    assert.equal(programme.title, "Queue first");
    assert.equal(
        programme.nextTitle,
        "Queue second",
        "remote queue uses its own successor, not channel list"
    );
    c.__ottMedia.open("", "Unrelated browser folder");
    assert.equal(
        c.__ottClassicPlayback.programme().collection,
        "Remote collection",
        "browsing cannot rename playing collection"
    );
}
{
    const { c, resolve } = setup("vportal");
    c.__ottClassicPlayback.reconcile();
    c.__ottMedia.playQueue(
        [
            {
                __ottMediaLabel: { key: "Untitled", value: "Untitled" },
                id: 301,
                request: { id: 301 },
                title: "Untitled",
            },
            {
                __ottMediaLabel: { key: "Untitled", value: "Untitled" },
                id: 302,
                request: { id: 302 },
                title: "Untitled",
            },
            { id: 303, request: { id: 303 }, title: "User filename.mp4" },
        ],
        "Collection",
        () => true,
        () => {}
    );
    resolve();
    c._ = (value) => (value === "Untitled" ? "Translated untitled" : value);
    let programme = c.__ottClassicPlayback.programme();
    assert.equal(programme.title, "Translated untitled");
    assert.equal(programme.nextTitle, "Translated untitled");
    c.__ottClassicPlayback.command({ type: "stop" });
    c.__ottMedia.ended(c.__ottClassicPlayback.snapshot().generation);
    resolve();
    programme = c.__ottClassicPlayback.programme();
    assert.equal(programme.title, "Translated untitled");
    assert.equal(
        programme.nextTitle,
        "User filename.mp4",
        "user supplied names are not translated"
    );
}
{
    const { c, end } = setup("offline");
    c.checkMedia = () => {};
    c.channels = Object.fromEntries(
        c.cats.All.map((id) => [id, { channel_name: "Local " + id }])
    );
    c._playChannel(0, 2);
    c.__ottKiosk = {
        allowed: (id) => id === 101 || id === 103,
        folderLoop: () => true,
        folderNext: (id) => (id === 103 ? 101 : 103),
        locked: () => true,
    };
    const moves = [];
    c.playChannel = (...args) => moves.push(args);
    end();
    assert.equal(moves.length, 1);
    assert.equal(moves[0][1], 0, "folder kiosk wraps from last file to first");
    assert.equal(moves[0][5], true);
    assert.equal(moves[0][6], true, "folder successor starts at zero");
}
console.log(
    "PASS Local folder kiosk natural completion wraps within the folder"
);
for (const folder of [false, true]) {
    const { c, end } = setup("offline");
    c.checkMedia = () => {};
    c.channels = Object.fromEntries(
        c.cats.All.map((id) => [id, { channel_name: "Local " + id }])
    );
    c._playChannel(0, 0);
    let asleep = true,
        deferred;
    c.__ottKiosk = {
        allowed: () => true,
        deferScreenEnd: (fn) => {
            deferred = fn;
        },
        folderLoop: () => folder,
        folderNext: () => 103,
        locked: () => folder,
        screenBlocked: () => asleep,
    };
    const moves = [];
    c.playChannel = (...args) => moves.push(args);
    end();
    assert.equal(
        moves.length,
        0,
        "screen-off EOF never opens another local file"
    );
    assert.equal(typeof deferred, "function");
    asleep = false;
    deferred();
    assert.equal(moves.length, 1, "wake advances deferred completion once");
    assert.equal(moves[0][1], folder ? 2 : 1);
    c.__ottMedia.ended(c.__ottClassicPlayback.snapshot().generation);
    assert.equal(moves.length, 1, "duplicate EOF cannot advance twice");
}
{
    const { c, end } = setup("offline");
    c.checkMedia = () => {};
    c.channels = Object.fromEntries(
        c.cats.All.map((id) => [id, { channel_name: "Local " + id }])
    );
    c._playChannel(0, 0);
    let asleep = false,
        deferred;
    c.__ottKiosk = {
        allowed: () => true,
        deferScreenEnd: (fn) => {
            deferred = fn;
        },
        locked: () => false,
        screenBlocked: () => asleep,
    };
    const moves = [];
    c.playChannel = (...args) => moves.push(args);
    end();
    assert.equal(moves.length, 1);
    asleep = true;
    assert.equal(
        moves[0][3](),
        false,
        "late async local admission blocked by screen off"
    );
    asleep = false;
    deferred();
    assert.equal(moves.length, 2);
    assert.equal(moves[1][3](), true, "wake retries the retired admission");
}
console.log(
    "PASS local EOF and delayed admission wait for screen wake with or without kiosk"
);
{
    const { c, end } = setup("offline");
    c.checkMedia = () => {};
    c.channels = Object.fromEntries(
        c.cats.All.map((id) => [id, { channel_name: "Local " + id }])
    );
    c._playChannel(0, 0);
    let asleep = true,
        deferred;
    c.__ottKiosk = {
        allowed: () => true,
        deferScreenEnd: (fn) => {
            deferred = fn;
        },
        locked: () => false,
        screenBlocked: () => asleep,
    };
    const moves = [];
    c.playChannel = (...args) => moves.push(args);
    end();
    c.__ottMedia.cancelAuto();
    asleep = false;
    deferred();
    assert.equal(
        moves.length,
        0,
        "cancelled EOF must not replace a newer navigation on wake"
    );
}
{
    const { c } = setup("offline");
    c.checkMedia = () => {};
    c.channels = Object.fromEntries(
        c.cats.All.map((id) => [id, { channel_name: "Local " + id }])
    );
    c._playChannel(0, 0);
    c.__ottKiosk = {
        allowed: (id) => id !== 102,
        folderLoop: () => true,
        folderNext: () => 103,
        locked: () => true,
    };
    c.__ottMedia.cycleRepeat();
    assert.equal(
        c.__ottClassicPlayback.programme().nextTitle,
        "Local 103",
        "folder footer skips unrelated file even with Repeat One saved"
    );
}
