// Cross-repository acceptance: actual Go server, TS transport/queries and Python CLI.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawn } = require("node:child_process");
const { promisify } = require("node:util");
const execFile = promisify(require("node:child_process").execFile);
const net = require("node:net");
const http = require("node:http");
const { performance } = require("node:perf_hooks");

// Pace dispatch, never HTTP completion: player long-polls must not block replies.
// These gaps leave headroom below Go's fixed-minute admin240/device120 buckets.
function requestPacer(
    intervals,
    now = () => performance.now(),
    later = setTimeout,
    clear = clearTimeout
) {
    const queues = new Map(
        [...intervals].map(([key, interval]) => [
            key,
            { interval, next: 0, pending: [] },
        ])
    );
    let timer = null,
        closed = false;
    function schedule() {
        if (timer !== null) clear(timer);
        timer = null;
        if (closed) return;
        const ready = [...queues.values()].filter(
            (queue) => queue.pending.length
        );
        if (ready.length)
            timer = later(
                dispatch,
                Math.max(
                    0,
                    Math.min(...ready.map((queue) => queue.next)) - now()
                )
            );
    }
    function dispatch() {
        timer = null;
        if (closed) return;
        for (const queue of queues.values()) {
            if (!queue.pending.length || queue.next > now()) continue;
            const forward = queue.pending.shift();
            // A late timer gets one slot, not a catch-up burst of overdue slots.
            queue.next = now() + queue.interval;
            forward();
        }
        schedule();
    }
    return {
        close() {
            closed = true;
            if (timer !== null) clear(timer);
            timer = null;
            for (const queue of queues.values()) queue.pending.length = 0;
        },
        enqueue(key, forward) {
            assert(!closed, "request pacer is closed");
            const queue = queues.get(key);
            assert(queue, "unexpected test credential");
            queue.pending.push(forward);
            schedule();
            return () => {
                const index = queue.pending.indexOf(forward);
                if (index >= 0) queue.pending.splice(index, 1);
                schedule();
            };
        },
    };
}

function testRequestPacing() {
    let clock = 0,
        sequence = 0;
    const timers = new Map(),
        sent = [];
    const pace = requestPacer(
        new Map([
            ["admin", 300],
            ["first", 600],
            ["second", 600],
        ]),
        () => clock,
        (run, delay) => {
            timers.set(++sequence, { at: clock + delay, run });
            return sequence;
        },
        (id) => timers.delete(id)
    );
    function advance(to, stalled = false) {
        if (stalled) clock = to;
        for (;;) {
            const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
            if (!next || next[1].at > to) break;
            timers.delete(next[0]);
            clock = Math.max(clock, next[1].at);
            next[1].run();
        }
        clock = to;
    }
    function enqueue(key) {
        return pace.enqueue(key, () => sent.push({ key, time: clock }));
    }
    enqueue("admin");
    enqueue("admin");
    enqueue("first");
    enqueue("first");
    advance(0);
    assert.deepEqual(
        sent.map((item) => item.key),
        ["admin", "first"],
        "another credential does not wait for a long-poll response"
    );
    advance(299);
    assert.equal(sent.length, 2);
    advance(300);
    assert.equal(sent.length, 3);
    advance(599);
    assert.equal(sent.length, 3);
    advance(600);
    assert.equal(sent.length, 4);
    for (let i = 0; i < 500; i++) {
        enqueue("admin");
        enqueue("first");
        enqueue("second");
    }
    const beforeStall = sent.length;
    advance(10000, true);
    assert.equal(
        sent.length,
        beforeStall + 3,
        "late timers cannot release a burst"
    );
    advance(400000);
    for (const [key, limit, gap] of [
        ["admin", 240, 300],
        ["first", 120, 600],
        ["second", 120, 600],
        [null, 480, 0],
    ]) {
        const events = sent.filter((item) => key === null || item.key === key);
        let start = -Infinity,
            count = 0;
        events.forEach((event, index) => {
            if (event.time - start >= 60000) {
                start = event.time;
                count = 0;
            }
            assert(
                ++count <= limit,
                "real fixed-minute credential/aggregate budget"
            );
            if (index) assert(event.time - events[index - 1].time >= gap);
        });
    }
    const cancel = pace.enqueue("admin", () =>
        assert.fail("cancelled request dispatched")
    );
    cancel();
    assert.equal(timers.size, 0);
    pace.enqueue("first", () => assert.fail("closed pacer dispatched"));
    const lateCallback = [...timers.values()][0].run;
    pace.close();
    assert.equal(timers.size, 0);
    lateCallback();
    console.log(
        "PASS smoke pacing: fixed-minute budgets, independent credentials, late timers, cancellation and teardown"
    );
}
testRequestPacing();
if (process.argv.includes("--test-pacing")) process.exit(0);

const offlineProfilesOnly = process.argv.includes("--offline-profiles-only");
assert(
    [undefined, "unsupported-controller"].includes(
        process.env.OTT_OFFLINE_PROFILES
    ),
    "OTT_OFFLINE_PROFILES only accepts unsupported-controller; default checks require support"
);
const binary = process.env.OTT_CONTROL_BINARY,
    cli = process.env.OTT_CLI;
assert(binary && cli, "Set OTT_CONTROL_BINARY and OTT_CLI");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ott-remote-test-"));
const emitted = path.join(dir, "player");
function moduleOf(file, requireFn, window) {
    const context = {
        console,
        Date,
        exports: {},
        require: requireFn,
        URL,
        window,
    };
    vm.createContext(context);
    require("../tests/helpers/shared-core-runtime.cjs")(context, {
        vendorOnly: true,
    });
    const built = path.join(
        emitted,
        file.replace(/^src\//, "").replace(/\.ts$/, ".js")
    );
    vm.runInContext(fs.readFileSync(built, "utf8"), context, {
        filename: built,
    });
    return context.exports;
}
(async () => {
    // Exercise actual project compiler output, not independent unchecked
    // transpileModule fragments. Keep it private so concurrent builds are safe.
    await execFile(process.execPath, [
        require.resolve("typescript/bin/tsc"),
        "--project",
        "tsconfig.json",
        "--module",
        "commonjs",
        "--outDir",
        emitted,
    ]);
    // Pure search modules keep their real transitive Unicode tables. The VM
    // stubs below are only for host/provider ports, not the search algorithm.
    const caseless = require(path.join(emitted, "utils/caseless.js"));
    const listener = net.createServer();
    await new Promise((r) => listener.listen(0, "127.0.0.1", r));
    const port = listener.address().port;
    await new Promise((r) => listener.close(r));
    const serverConfig = {
        admin_token: "a".repeat(32),
        devices: [
            { id: "dev_test", token: "b".repeat(32) },
            { id: "dev_second", token: "c".repeat(32) },
        ],
        listen: "127.0.0.1:" + port,
    };
    fs.writeFileSync(
        path.join(dir, "server.json"),
        JSON.stringify(serverConfig),
        { mode: 0o600 }
    );
    const server = spawn(
        binary,
        ["serve", "--config", path.join(dir, "server.json")],
        { stdio: "ignore" }
    );
    const controllers = [];
    const prefix = "/ott-control";
    const submissions = [];
    let lostStepSubmission = null;
    const pace = requestPacer(
        new Map([
            ["Bearer " + serverConfig.admin_token, 300],
            ...serverConfig.devices.map((device) => [
                "Bearer " + device.token,
                600,
            ]),
        ])
    );
    const proxy = http.createServer((request, response) => {
        if (!request.url.startsWith(prefix + "/")) {
            response.writeHead(404).end();
            return;
        }
        const cancel = pace.enqueue(request.headers.authorization, () => {
            if (request.destroyed || response.destroyed) return;
            const requestChunks = [];
            request.on("data", (chunk) => requestChunks.push(chunk));
            const upstream = http.request(
                "http://127.0.0.1:" + port + request.url.slice(prefix.length),
                { headers: request.headers, method: request.method },
                (incoming) => {
                    if (
                        request.method === "POST" &&
                        request.url.startsWith(prefix + "/api/requests?")
                    ) {
                        const body = JSON.parse(Buffer.concat(requestChunks));
                        submissions.push({
                            action: body.action,
                            device: new URL(
                                request.url,
                                addressForProxy()
                            ).searchParams.get("device_id"),
                            operation: body.params.operation,
                            ...(body.params.offset === undefined
                                ? {}
                                : { offset: body.params.offset }),
                        });
                        if (
                            lostStepSubmission &&
                            !lostStepSubmission.dropped &&
                            body.action === "playback" &&
                            body.params.operation ===
                                lostStepSubmission.operation
                        ) {
                            assert.equal(incoming.statusCode, 202);
                            lostStepSubmission.dropped = true;
                            incoming.resume();
                            response.destroy();
                            return;
                        }
                    }
                    response.writeHead(incoming.statusCode, incoming.headers);
                    incoming.pipe(response);
                }
            );
            upstream.on("error", () => response.writeHead(502).end());
            request.pipe(upstream);
        });
        request.on("aborted", cancel);
        response.on("close", cancel);
    });
    function addressForProxy() {
        return "http://127.0.0.1:" + proxy.address().port;
    }
    try {
        await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
        const address = "http://127.0.0.1:" + proxy.address().port + prefix;
        fs.writeFileSync(
            path.join(dir, "cli.json"),
            JSON.stringify({
                players: { mac: "dev_second", tv: "dev_test" },
                server: address,
                server_config: path.join(dir, "server.json"),
            })
        );
        for (let i = 0; i < 40; i++) {
            try {
                if ((await fetch("http://127.0.0.1:" + port + "/readyz")).ok)
                    break;
            } catch {}
            await new Promise((r) => setTimeout(r, 50));
        }
        // This fixture supplies only the display/storage port. Browser tests
        // separately exercise the real core geometry and durable library.
        const aspectPreferences = new Map();
        const favoriteStores = new Map();
        const favoriteConfigurations = new Map();
        const offlineStores = new Map();
        function player(
            device,
            token,
            initialVolume,
            native = false,
            favoritesMode = false
        ) {
            let volume = initialVolume,
                dispatches = 0,
                dropped = false,
                playlistLoads = 0,
                reloads = 0,
                streamRestarts = 0,
                droppedReload = false;
            let standby = false,
                playbackKind = "live",
                phase = "playing",
                position = 0,
                paused = 0,
                resumed = 0,
                seeks = 0,
                backendAccesses = 0,
                nativeExits = 0,
                nativeRestarts = 0,
                channelSteps = 0,
                dropStepReceipt = false,
                droppedStepReceipt = false,
                protectedInput = false,
                pendingAck = null;
            let aspectMode = aspectPreferences.get(device) || "fit",
                aspectChanges = 0,
                aspectGeneration = 0,
                aspectSupported = true,
                reloadOnAspect = false;
            const keysReceived = [],
                controlsReceived = [],
                receipts = [];
            let configuration = {
                active: 0,
                M3Us: Array.from({ length: 15 }, (_, index) => ({
                    medUrl: "",
                    name: "Profile " + (index + 1),
                    rechours: 0,
                    www: index === 0 ? "https://example.com/one.m3u" : "",
                })),
            };
            const clone = (value) => JSON.parse(JSON.stringify(value));
            if (favoritesMode) {
                configuration.M3Us[1].www = "https://example.com/two.m3u";
                if (favoriteConfigurations.has(device))
                    configuration = clone(favoriteConfigurations.get(device));
            }
            let favoriteGeneration = 1;
            let favoriteTarget = {
                channelId: "101",
                kind: "live",
                sourceId: "m3u:" + configuration.active,
            };
            const favoritePlays = [];
            const host = {
                __ottActiveProviderDriver: {
                    configuration: () => clone(configuration),
                    fixedSlot: () => -1,
                    id: "m3u",
                    saveConfiguration: (value) => {
                        value.M3Us.forEach((slot, index) => {
                            if (
                                slot.medUrl !== configuration.M3Us[index].medUrl
                            )
                                slot.medSourceId = "test-media-source-" + index;
                        });
                        configuration = clone(value);
                        if (favoritesMode)
                            favoriteConfigurations.set(
                                device,
                                clone(configuration)
                            );
                        return true;
                    },
                },
                __ottClassicGuide: {
                    peek: (id) =>
                        id === "a"
                            ? [
                                  {
                                      name: "НОВОСТИ",
                                      time: Date.now() / 1000 - 60,
                                      time_to: Date.now() / 1000 + 600,
                                  },
                              ]
                            : [],
                    request: (id, cb) => {
                        cb(id, []);
                        return () => {};
                    },
                    source: () => "demo",
                },
                captureAspectTarget: () => {
                    if (!aspectSupported) return null;
                    const generation = aspectGeneration;
                    const current = () =>
                        aspectSupported && aspectGeneration === generation;
                    return {
                        current,
                        mode: aspectMode,
                        savedMode: aspectPreferences.get(device) || null,
                        set(mode) {
                            if (!current()) return false;
                            aspectPreferences.set(device, mode);
                            aspectMode = mode;
                            aspectGeneration++;
                            aspectChanges++;
                            return true;
                        },
                    };
                },
                catIndex: 0,
                cats: { one: ["a", "b"] },
                catsArray: ["one"],
                channels: {
                    a: { channel_name: "Первый" },
                    b: { channel_name: "Кино" },
                },
                cList: ["a", "b"],
                clearTimeout,
                commandChannelsReady: true,
                curList: ["a", "b"],
                deviceUUID: device,
                ifParentalAccessChId: () => false,
                loadPlaylist: () => playlistLoads++,
                location: { protocol: "http:" },
                parentalArray: [],
                playChannel: () => {},
                primaryIndex: 0,
                restart: () => reloads++,
                setTimeout,
                stbGetItem: () => "demo",
                stbGetVolume: () => volume,
            };
            host.curList = host.cats.one;
            host.keys = {
                CH_UP: 427,
                ENTER: 13,
                RETURN: 27,
                SUBTITLE: 72,
                UP: 38,
                VOL_DOWN: 174,
            };
            host.$ = () => ({ is: () => protectedInput });
            host.stbIsStandby = () => standby;
            host.stbToggleStandby = () => {
                standby = !standby;
            };
            moduleOf("src/ui/input-router.ts", () => {}, host);
            const router = host.__ottInputRouter.create({
                keys: () => host.keys,
            });
            host.__ottClassicScreenPort = {
                normalize: router.normalize,
                screens: { current: () => null },
            };
            host.keyHandler = (event) => keysReceived.push(event.keyCode);
            host.__ottClassicPlayback = {
                checkpoint: () => {},
                snapshot: () =>
                    favoritesMode
                        ? {
                              generation: favoriteGeneration,
                              phase: "playing",
                              target: clone(favoriteTarget),
                          }
                        : { target: { kind: playbackKind } },
            };
            host.__ottParental = { needs: () => false };
            if (native)
                host.__TAURI__ = {
                    core: {
                        invoke: async (command) => {
                            if (command === "lifecycle_capabilities")
                                return {
                                    exit: true,
                                    reboot: false,
                                    restart: true,
                                };
                            if (command === "exit_app") nativeExits++;
                            else if (command === "restart_app")
                                nativeRestarts++;
                            else throw new Error("Unexpected native command");
                        },
                    },
                };
            moduleOf(
                "src/plugins/remote-lifecycle.ts",
                () => {},
                host
            ).installRemoteLifecycle(host, { prepare: () => {} });
            host.stbPlay = () => {};
            host.__ottCoreTransport = { play: host.stbPlay };
            const backend = {
                current: () => ({
                    active: () => true,
                    pause: () => {
                        phase = "paused";
                        paused++;
                    },
                    resume: () => {
                        phase = "playing";
                        resumed++;
                    },
                    sample: () => {},
                    seek: (value) => {
                        position = value;
                        seeks++;
                    },
                    snapshot: () => ({ phase, position }),
                }),
                restart: () => {
                    streamRestarts++;
                    return {
                        accepted: true,
                        dispatched: true,
                        target: "stream",
                    };
                },
            };
            host.__ottCoreBackend = () => {
                backendAccesses++;
                return backend;
            };
            // An active player has an existing backend. Capability discovery
            // peeks at it without calling the potentially initializing getter.
            host.__ottCoreBackendPeek = () => backend;
            const kioskStorage = favoritesMode
                ? favoriteStores.get(device) || {}
                : {};
            if (favoritesMode) favoriteStores.set(device, kioskStorage);
            host.stbGetItem = (key) =>
                kioskStorage[key] || (key === "ottplayprov" ? "demo" : null);
            host.stbSetItem = (key, value) => {
                kioskStorage[key] = value;
            };
            host.setInterval = () => 1;
            host.stbGetPosTime = () => 1;
            host.stbIsPlaying = () => true;
            host.__ottSourceIdentity = {
                current: () => "m3u:" + configuration.active,
            };
            if (favoritesMode) {
                host.__ottCommandChannelLoad = {};
                host.stbGetPersistedItem = host.stbGetItem;
                host.providerGetItem = (key) =>
                    kioskStorage["provider:" + key] || null;
                host.providerGetPersistedItem = host.providerGetItem;
                let addedChannel;
                host.addToFavorites = (id) => {
                    addedChannel = id;
                };
                host.saveChannelsCats = () => {
                    kioskStorage[
                        "provider:favoritesLibrary:m3u:" + configuration.active
                    ] = JSON.stringify({
                        itemId: host.channels[addedChannel].itemId,
                    });
                };
                const catalog = () => {
                    host.channels = {
                        101: {
                            channel_name: "News",
                            itemId: "news:" + configuration.active,
                        },
                        102: {
                            channel_name: "Cinema",
                            itemId: "cinema:" + configuration.active,
                        },
                    };
                    host.cats = { one: [101, 102] };
                    host.catsArray = ["one"];
                    host.cList = [101, 102];
                    host.curList = host.cats.one;
                    host.catIndex = host.primaryIndex = 0;
                };
                host.loadPlaylist = () => {
                    playlistLoads++;
                    host.__ottCommandChannelLoad = {};
                    host.commandChannelsReady = false;
                    catalog();
                    setTimeout(() => {
                        host.commandChannelsReady = true;
                    }, 75);
                };
                catalog();
                moduleOf("src/channels/channel-references.ts", () => {}, host);
            }
            host.__ottKiosk = moduleOf(
                "src/plugins/kiosk.ts",
                (name) =>
                    name.includes("strict-kiosk")
                        ? moduleOf(
                              "src/plugins/strict-kiosk-input.ts",
                              () => {},
                              host
                          )
                        : name.includes("kiosk-video-progress")
                          ? moduleOf(
                                "src/plugins/kiosk-video-progress.ts",
                                () => {},
                                host
                            )
                          : caseless,
                host
            ).createKiosk(host);
            host.__ottKiosk.init();
            host.playChannel = (c, i, _remote, admission) => {
                if (admission && !admission()) return false;
                const id = host.cats[host.catsArray[c]][i];
                if (!host.__ottKiosk.admit(id)) return false;
                host.catIndex = c;
                host.curList = host.cats[host.catsArray[c]];
                host.primaryIndex = i;
                if (admission) channelSteps++;
                if (favoritesMode) {
                    assert.equal(
                        host.commandChannelsReady,
                        true,
                        "favorite playback waits for the loaded catalog"
                    );
                    favoriteGeneration++;
                    favoriteTarget = {
                        channelId: String(id),
                        kind: "live",
                        sourceId: "m3u:" + configuration.active,
                    };
                    favoritePlays.push({
                        itemId: host.channels[id].itemId,
                        profile: configuration.active,
                    });
                }
                return true;
            };
            const dispatch = (command) => {
                dispatches++;
                if (command.volume_step !== undefined)
                    volume = Math.max(
                        0,
                        Math.min(100, volume + command.volume_step)
                    );
                else if (command.volume !== undefined) volume = command.volume;
                return "accepted";
            };
            let restartModule;
            const dependencies = (name) =>
                name === "./remote-favorites" ||
                name === "./remote-favorites-contract"
                    ? moduleOf(
                          "src/commands/" + name.slice(2) + ".ts",
                          dependencies,
                          host
                      )
                    : name === "../provider"
                      ? {
                            checkProviderUrl: () => true,
                            isProviderAllowed: () => true,
                            providerIds: ["demo", "m3u"],
                            providerLabels: null,
                            selectProviderByIndex: () => true,
                        }
                      : name === "./remote-profiles"
                        ? moduleOf(
                              "src/commands/remote-profiles.ts",
                              dependencies,
                              host
                          )
                        : name === "../plugins/vportal"
                          ? moduleOf(
                                "src/plugins/vportal.ts",
                                dependencies,
                                host
                            )
                          : name === "./remote-plex"
                            ? moduleOf(
                                  "src/commands/remote-plex.ts",
                                  dependencies,
                                  host
                              )
                            : name === "./remote-restart" ||
                                name === "../commands/remote-restart"
                              ? restartModule ||
                                (restartModule = moduleOf(
                                    "src/commands/remote-restart.ts",
                                    dependencies,
                                    host
                                ))
                              : name === "./remote-app-update"
                                ? moduleOf(
                                      "src/commands/remote-app-update.ts",
                                      dependencies,
                                      host
                                  )
                                : name === "./remote-doctor"
                                  ? moduleOf(
                                        "src/plugins/remote-doctor.ts",
                                        dependencies,
                                        host
                                    )
                                  : name === "../utils/caseless"
                                    ? caseless
                                    : { handleCommand: dispatch };
            let execute, inspection;
            let offlineLoaded = [];
            function activateOffline(initialIndex = 0) {
                offlineLoaded = [];
                if (!offlineStores.has(device))
                    offlineStores.set(device, new Map());
                const saved = offlineStores.get(device);
                const sourceId = "private-source-" + device;
                const catalog = {
                    items: ["episode01.mp4", "episode02.mp4"].map(
                        (name, index) => ({
                            available: true,
                            id: "private-item-" + device + "-" + index,
                            name,
                            sourceId,
                            url: "blob:private-playback-" + index,
                        })
                    ),
                    sources: [{ id: sourceId, kind: "folder", name: "Videos" }],
                };
                host.crypto = require("node:crypto").webcrypto;
                host.__ottActiveProviderDriver = { id: "offline" };
                saved.set("ottplayprov", "offline");
                host.stbGetItem = (key) => saved.get(key) ?? null;
                host.stbSetItem = (key, value) => saved.set(key, String(value));
                host.stbDelItem = (key) => saved.delete(key);
                const profiles = moduleOf(
                    "src/offline/profiles.ts",
                    (name) => {
                        assert.equal(name, "../settings/store");
                        return moduleOf(
                            "src/settings/store.ts",
                            () => {},
                            host
                        );
                    },
                    host
                ).installOfflineProfiles(host, {
                    libraryIdentity: () => "fixture-library-" + device,
                    snapshot: async () => clone(catalog),
                });
                host.curList = catalog.items.map((item) => "local-" + item.id);
                host.primaryIndex = initialIndex;
                // Production offline profiles use the generic channel loader;
                // loadPlaylist is an M3U-only hook and may be absent or stale.
                host.loadChannels = () => {
                    playlistLoads++;
                    const filtered = profiles.filter(clone(catalog));
                    offlineLoaded = filtered.items.map((item) => item.name);
                    host.curList = filtered.items.map(
                        (item) => "local-" + item.id
                    );
                    host.primaryIndex = host.curList.indexOf(
                        profiles.selection()
                    );
                };
            }
            function loadRuntime() {
                restartModule = undefined;
                execute = moduleOf(
                    "src/commands/remote-requests.ts",
                    dependencies,
                    host
                ).executeRemoteRequest;
                inspection = moduleOf(
                    "src/plugins/remote-inspect.ts",
                    dependencies,
                    host
                ).installRemoteInspection(host);
            }
            loadRuntime();
            const transport = moduleOf(
                "src/plugins/command-server.ts",
                () => require("../tests/load-wire.cjs")(),
                host
            );
            const send = (request, complete) => {
                let aborted = false;
                fetch(request.url, {
                    body: request.body,
                    headers: request.headers,
                    method: request.method,
                }).then(
                    async (response) => {
                        const body = await response.text();
                        if (aborted) return;
                        if (request.url.endsWith("/api/responses")) {
                            const receipt = JSON.parse(request.body);
                            receipts.push(receipt);
                            if (
                                dropStepReceipt &&
                                !droppedStepReceipt &&
                                receipt.data &&
                                receipt.data.operation === dropStepReceipt
                            ) {
                                assert.equal(response.status, 200);
                                droppedStepReceipt = true;
                                complete();
                                return;
                            }
                            if (
                                pendingAck &&
                                receipt.data &&
                                receipt.data.effect === pendingAck.effect &&
                                receipt.data[pendingAck.field] ===
                                    pendingAck.value
                            ) {
                                const gate = pendingAck;
                                assert.equal(
                                    response.status,
                                    200,
                                    "Go must accept the exact control receipt"
                                );
                                gate.bodies.push(request.body);
                                if (!gate.dropped) {
                                    gate.dropped = true;
                                    complete();
                                } else {
                                    gate.finish = () => {
                                        pendingAck = null;
                                        gate.delivered = true;
                                        complete({
                                            body,
                                            status: response.status,
                                        });
                                    };
                                    if (gate.released) gate.finish();
                                }
                                return;
                            }
                        }
                        if (
                            request.url.endsWith("/api/responses") &&
                            request.body.includes(
                                '"effect":"reload-after-ack"'
                            ) &&
                            !droppedReload
                        ) {
                            assert.equal(
                                reloads,
                                0,
                                "reload must wait for response delivery acknowledgement"
                            );
                            droppedReload = true;
                            complete();
                            return;
                        }
                        if (
                            request.url.endsWith("/api/responses") &&
                            request.body.includes('"volume":35') &&
                            !dropped
                        ) {
                            dropped = true;
                            complete();
                            return;
                        }
                        complete({ body, status: response.status });
                    },
                    () => {
                        if (!aborted) complete();
                    }
                );
                return () => (aborted = true);
            };
            const controller = transport.createCommandServer(
                host,
                send,
                () => {},
                dispatch,
                (request, done, afterReply) => {
                    controlsReceived.push(clone(request));
                    if (reloadOnAspect && request.action === "aspect") {
                        reloadOnAspect = false;
                        // A real page reload retires its old transport too. The
                        // new runtime must leave the old request for its owner.
                        controller.configure({
                            address: "",
                            enabled: false,
                            token: "",
                        });
                        loadRuntime();
                        controller.configure({ address, enabled: true, token });
                        return;
                    }
                    return inspection.execute(
                        request,
                        done,
                        afterReply,
                        (item, reply, defer) =>
                            item.action === "kiosk"
                                ? host.__ottKiosk.request(item.params, reply)
                                : execute(item, reply, defer)
                    );
                },
                (request) => inspection.accept(request)
            );
            controller.configure({
                address,
                enabled: true,
                token,
            });
            controllers.push(controller);
            return () => ({
                aspectChanges,
                aspectMode,
                aspectSaved: aspectPreferences.get(device) || null,
                aspectSupported: (value) => {
                    aspectSupported = value;
                },
                backendAccesses,
                changeAspectTarget: () => aspectGeneration++,
                channelSteps,
                configuration: clone(configuration),
                controlsReceived: clone(controlsReceived),
                defer: (action, value) => {
                    assert.equal(
                        pendingAck,
                        null,
                        "previous ACK must finish before creating a new gate"
                    );
                    const gate = {
                        bodies: [],
                        delivered: false,
                        dropped: false,
                        effect: action + "-after-ack",
                        field: action === "input" ? "key" : "operation",
                        release() {
                            gate.released = true;
                            if (gate.finish) gate.finish();
                        },
                        released: false,
                        value,
                    };
                    pendingAck = gate;
                    return gate;
                },
                dispatches,
                dropNextStepReceipt: (operation = "next_channel") => {
                    dropStepReceipt = operation;
                    droppedStepReceipt = false;
                },
                dropped,
                droppedReload,
                droppedStepReceipt,
                favoritePlays: clone(favoritePlays),
                keysReceived: keysReceived.slice(),
                kiosk: host.__ottKiosk.snapshot(),
                nativeExits,
                nativeRestarts,
                offline: activateOffline,
                offlineLoaded: clone(offlineLoaded),
                paused,
                playback: (kind) => {
                    playbackKind = kind;
                },
                playlistLoads,
                position,
                protectInput: (value) => {
                    protectedInput = value;
                },
                receipts: clone(receipts),
                reloadOnAspect: () => {
                    reloadOnAspect = true;
                },
                reloads,
                rename: (id, name) => {
                    host.channels[id].channel_name = name;
                },
                resumed,
                seeks,
                select: host.playChannel,
                selectedChannel: host.curList[host.primaryIndex],
                standby,
                stepCategory: () => {
                    host.channels.c = { channel_name: "Спорт" };
                    host.channels.x = {
                        channel_name: "Outside active category",
                    };
                    host.cList = ["a", "x", "b", "c"];
                    host.cats.steps = ["c", "a", "b"];
                    host.catsArray = ["one", "steps"];
                    host.catIndex = 1;
                    host.curList = host.cats.steps;
                    host.primaryIndex = 0;
                },
                stop: () =>
                    controller.configure({
                        address: "",
                        enabled: false,
                        token: "",
                    }),
                streamRestarts,
                volume,
            });
        }
        let television = player("dev_test", "b".repeat(32), 30);
        const desktop = player("dev_second", "c".repeat(32), 70, true);
        async function runOn(name, ...args) {
            return execFile("python3", [
                cli,
                "--config",
                path.join(dir, "cli.json"),
                "--timeout",
                "8",
                name,
                ...args,
            ]);
        }
        const run = (...args) => runOn("tv", ...args);
        async function jsonOn(name, ...args) {
            const result = await execFile("python3", [
                cli,
                "--config",
                path.join(dir, "cli.json"),
                "--timeout",
                "8",
                "--json",
                name,
                ...args,
            ]);
            assert.equal(result.stderr, "");
            return JSON.parse(result.stdout);
        }
        async function eventually(read, predicate, message) {
            for (let attempt = 0; attempt < 80; attempt++) {
                if (predicate(read())) return;
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            assert.fail(message);
        }
        async function checkOfflineProfiles() {
            television().offline(1);
            desktop().offline();
            const offlineCaps = (await jsonOn("tv", "caps")).offline_profiles;
            assert(
                offlineCaps,
                "the current CLI retains the player capabilities"
            );
            assert.deepEqual(offlineCaps.operations, [
                "list",
                "load",
                "save",
                "export",
                "import",
            ]);
            if (process.env.OTT_OFFLINE_PROFILES === "unsupported-controller") {
                // The old server forwards capabilities, but rejects the newer
                // profile actions. The old CLI merely hid this metadata.
                const stored = [...offlineStores.get("dev_test")];
                const selected = television().selectedChannel;
                const submitted = submissions.filter(
                    (request) => request.action === "profile_save"
                ).length;
                await assert.rejects(
                    run("profile", "save", "1", "Rejected"),
                    (error) => {
                        assert.equal(error.stdout, "");
                        assert.match(
                            error.stderr,
                            /This controller does not accept Local videos profile requests/
                        );
                        assert.match(
                            error.stderr,
                            /The request was not repeated/
                        );
                        return true;
                    }
                );
                assert.equal(
                    submissions.filter(
                        (request) => request.action === "profile_save"
                    ).length,
                    submitted + 1,
                    "the rejected action is submitted once without replay"
                );
                assert.equal(
                    television().controlsReceived.filter(
                        (request) => request.action === "profile_save"
                    ).length,
                    0,
                    "the old server never delivers an unsupported action"
                );
                assert.deepEqual([...offlineStores.get("dev_test")], stored);
                assert.equal(television().selectedChannel, selected);
                console.log(
                    "PASS current CLI reports legacy controller rejection of local profile writes without replay or mutation"
                );
                return;
            }
            const emptyOffline = await jsonOn("tv", "profiles");
            assert.equal(emptyOffline.provider, "offline");
            assert.equal(
                emptyOffline.profiles.filter((row) => row.active).length,
                0
            );
            const savedOffline = await jsonOn(
                "tv",
                "profile",
                "save",
                "1",
                "Cartoons"
            );
            assert.equal(savedOffline.saved, true);
            assert.equal(savedOffline.profile.selected_name, "episode02.mp4");
            assert.equal(savedOffline.binding_required, false);
            const portablePath = path.join(dir, "local-videos.json");
            await jsonOn("tv", "profile", "export", "1", portablePath);
            const portableBytes = fs.readFileSync(portablePath, "utf8");
            assert(
                !/private-|blob:|fixture-library-/.test(portableBytes),
                "export excludes device bindings and playback URLs"
            );
            assert.equal(fs.statSync(portablePath).mode & 0o777, 0o600);
            await assert.rejects(run("profile", "export", "1", portablePath));
            assert.equal(fs.readFileSync(portablePath, "utf8"), portableBytes);
            const importedOffline = await jsonOn(
                "tv",
                "profile",
                "import",
                "2",
                portablePath
            );
            assert.equal(importedOffline.binding_required, false);
            television().offline();
            assert.equal(
                television().selectedChannel,
                "local-private-item-dev_test-0"
            );
            await jsonOn("tv", "profile", "load", "2");
            assert.deepEqual(television().offlineLoaded, [
                "episode01.mp4",
                "episode02.mp4",
            ]);
            assert.equal(
                television().selectedChannel,
                "local-private-item-dev_test-1"
            );
            // Recreate the store to prove this depends on saved bindings, not closures.
            television().offline();
            assert.deepEqual(television().offlineLoaded, []);
            await jsonOn("tv", "profile", "load", "2");
            assert.deepEqual(television().offlineLoaded, [
                "episode01.mp4",
                "episode02.mp4",
            ]);
            assert.equal(
                television().selectedChannel,
                "local-private-item-dev_test-1"
            );
            const foreignOffline = await jsonOn(
                "mac",
                "profile",
                "import",
                "2",
                portablePath
            );
            assert.equal(foreignOffline.binding_required, true);
            const foreignLoad = await jsonOn("mac", "profile", "load", "2");
            assert.equal(foreignLoad.binding_required, true);
            assert.deepEqual(
                desktop().offlineLoaded,
                [],
                "matching source names on another device grant no playback authority"
            );
            assert.equal(desktop().selectedChannel, undefined);
            console.log(
                "PASS Local videos profiles through real Go + compiled TS store/transport + Python CLI: save/export/import/load, private binding exclusion, no overwrite, same-device restart and cross-device binding requirement"
            );
        }
        if (offlineProfilesOnly) {
            await checkOfflineProfiles();
            return;
        }
        assert.equal((await run("v")).stdout.trim(), "30%");
        assert.equal((await run("v", "+5")).stdout.trim(), "35%");
        assert.equal(television().dispatches, 1);
        assert(television().dropped, "must exercise a lost response");
        assert.equal((await run("v", "-3")).stdout.trim(), "32%");
        assert.equal((await run("s", "ПЕРВ")).stdout.trim(), "1: Первый");
        assert.equal(
            (await run("p", "новости")).stdout.trim(),
            "Первый — НОВОСТИ"
        );
        assert.match((await run("2")).stdout, /Кино/);
        assert.match((await run("первый")).stdout, /Первый/);
        assert.match((await run("providers")).stdout, /demo/);
        const pair = await Promise.all([
            runOn("TV", "v", "+2"),
            runOn("MaC", "v", "-10"),
        ]);
        assert.equal(pair[0].stdout.trim(), "34%");
        assert.equal(pair[1].stdout.trim(), "60%");
        assert.equal(television().volume, 34);
        assert.equal(desktop().volume, 60);
        assert.equal(desktop().dispatches, 1);
        const original = television().configuration;
        const settingsFile = path.join(dir, "profile.json");
        fs.writeFileSync(
            settingsFile,
            JSON.stringify({
                history_hours: 72,
                name: "Movies",
                playlist: "https://example.com/two.m3u?token=TEST_ONLY_TOKEN",
            }),
            { mode: 0o600 }
        );
        const configured = await run("profile-config", "2", settingsFile);
        assert(
            !/TEST_ONLY/.test(configured.stdout + configured.stderr),
            "configuration replies must not expose credentials"
        );
        assert.equal(television().configuration.active, 0);
        assert.equal(
            television().playlistLoads,
            0,
            "editing another profile must not reload playback"
        );
        assert.deepEqual(television().configuration.M3Us[0], original.M3Us[0]);
        assert.deepEqual(
            television().configuration.M3Us.slice(2),
            original.M3Us.slice(2)
        );
        assert.equal(television().configuration.M3Us[1].rechours, 72);
        const listed = await run("profiles");
        assert.match(listed.stdout, /Movies/);
        assert(!/vportal/i.test(listed.stdout));
        assert(!/TEST_ONLY/.test(listed.stdout + listed.stderr));
        await assert.rejects(
            run(
                "profile",
                "2",
                "vportal",
                "portal::[key:TEST_ONLY_KEY]https://example.com/api/v1/"
            )
        );
        assert.equal(television().configuration.M3Us[1].medUrl || "", "");
        await run("profile", "2");
        assert.equal(television().configuration.active, 1);
        assert.equal(television().playlistLoads, 1);
        await run("profile", "2", "name", "Cinema");
        assert.equal(
            television().playlistLoads,
            1,
            "renaming must not reload playback"
        );
        assert.equal(television().configuration.M3Us[1].name, "Cinema");
        assert.equal(
            desktop().configuration.active,
            0,
            "profile commands must remain device-scoped"
        );
        assert.deepEqual(desktop().configuration.M3Us[1], original.M3Us[1]);
        await run("restart", "stream");
        assert.equal(television().streamRestarts, 1);
        const restart = await run("restart", "player");
        assert.match(restart.stdout, /accepted/);
        for (let attempt = 0; attempt < 30 && !television().reloads; attempt++)
            await new Promise((resolve) => setTimeout(resolve, 100));
        assert(
            television().droppedReload,
            "must exercise a lost reload receipt acknowledgement"
        );
        assert.equal(
            television().reloads,
            1,
            "a retried receipt must deliver the reload effect once"
        );
        assert.equal(desktop().reloads, 0);
        assert.equal(desktop().streamRestarts, 0);
        assert.match((await run("kiosk", "on")).stdout, /waiting/);
        assert.equal(television().kiosk.state, "waiting");
        television().select(0, 1);
        assert.equal(television().kiosk.channel.id, "b");
        assert.match((await run("kiosk", "status")).stdout, /Кино/);
        assert.match(
            (await run("kiosk", "on", "--strict")).stdout,
            /Strict kiosk/
        );
        assert.equal(television().kiosk.strict, true);
        assert.equal(television().kiosk.channel.id, "b");
        await assert.rejects(run("provider", "demo"));
        await assert.rejects(run("profile", "1"));
        await assert.rejects(run("play", "1"));
        await run("kiosk", "set", "Первый");
        assert.equal(television().kiosk.channel.id, "a");
        assert.equal(television().kiosk.strict, true);
        assert.equal(desktop().kiosk.state, "off");
        await run("kiosk", "off");
        assert.equal(television().kiosk.state, "off");
        assert.equal(television().kiosk.strict, false);
        await run("kiosk", "on", "2");
        assert.equal(television().kiosk.channel.id, "b");
        await run("kiosk", "off");
        television().rename("a", "Новости HD");
        television().rename("b", "Новости");
        assert.match(
            (await run("kiosk", "on", "НОВОСТИ")).stdout,
            /Новости HD/
        );
        assert.equal(television().kiosk.channel.id, "a");
        await run("kiosk", "set", "2");
        await run("kiosk", "set", "ВоСт");
        assert.equal(television().kiosk.channel.id, "a");
        await run("kiosk", "off");
        television().stepCategory();
        const isolatedSteps = desktop().channelSteps;
        const isolatedSelection = desktop().selectedChannel;
        const isolatedRequests = desktop().controlsReceived.length;
        async function step(alias, operation, id, name, number, offset) {
            const before = television();
            const posted = submissions.length;
            const params = {
                operation,
                ...(offset === undefined ? {} : { offset }),
            };
            assert.deepEqual(await jsonOn("tv", alias), {
                channel: { id, name, number },
                dispatched: true,
                ...params,
            });
            const after = television();
            assert.equal(after.selectedChannel, id);
            assert.equal(after.channelSteps, before.channelSteps + 1);
            assert.deepEqual(
                after.controlsReceived
                    .slice(before.controlsReceived.length)
                    .map(({ action, params }) => ({ action, params })),
                [{ action: "playback", params }],
                "a relative step is one typed request, never an input fallback"
            );
            assert.deepEqual(submissions.slice(posted), [
                { action: "playback", device: "dev_test", ...params },
            ]);
            assert.deepEqual(after.keysReceived, before.keysReceived);
        }
        // The active category is c,a,b, while ott s numbers are a,x,b,c.
        // Neither adjacency nor wrap may visit x outside the current category.
        await step("prev", "previous_channel", "b", "Новости", 3);
        await step("previous", "previous_channel", "a", "Новости HD", 1);
        await step("next", "next_channel", "b", "Новости", 3);
        await step("NeXt", "next_channel", "c", "Спорт", 4);
        const receiptStart = television().receipts.length;
        television().dropNextStepReceipt();
        await step("next", "next_channel", "a", "Новости HD", 1);
        await eventually(
            () =>
                television()
                    .receipts.slice(receiptStart)
                    .filter(
                        (receipt) => receipt.data.operation === "next_channel"
                    ),
            (receipts) => receipts.length >= 2,
            "lost channel-step receipt ACK must be retried"
        );
        const stepReceipts = television()
            .receipts.slice(receiptStart)
            .filter((receipt) => receipt.data.operation === "next_channel");
        assert(television().droppedStepReceipt);
        assert(
            stepReceipts.every(
                (receipt) =>
                    JSON.stringify(receipt) === JSON.stringify(stepReceipts[0])
            )
        );
        assert.equal(television().channelSteps, 5);
        assert.equal(television().selectedChannel, "a");

        // Lose the successful POST response before the CLI knows the request ID.
        // The submitted relative action can still happen, so it must not replay.
        const uncertainBefore = television();
        const uncertainPosted = submissions.length;
        lostStepSubmission = { dropped: false, operation: "previous_channel" };
        await assert.rejects(jsonOn("tv", "previous"), (error) => {
            assert.equal(error.stdout, "");
            return true;
        });
        assert(lostStepSubmission.dropped);
        await eventually(
            television,
            (state) => state.channelSteps === uncertainBefore.channelSteps + 1,
            "the accepted step with a lost POST response must reach its player"
        );
        assert.equal(television().selectedChannel, "c");
        assert.deepEqual(submissions.slice(uncertainPosted), [
            {
                action: "playback",
                device: "dev_test",
                operation: "previous_channel",
            },
        ]);
        assert.equal(
            television().controlsReceived.length,
            uncertainBefore.controlsReceived.length + 1
        );
        lostStepSubmission = null;
        for (const [offset, id, name, number] of [
            [15, "c", "Спорт", 4],
            [-15, "c", "Спорт", 4],
            [4, "a", "Новости HD", 1],
            [-5, "b", "Новости", 3],
            [9007199254740991, "c", "Спорт", 4],
            [-9007199254740991, "b", "Новости", 3],
        ])
            await step(
                (offset > 0 ? "+" : "") + offset,
                "step_channel",
                id,
                name,
                number,
                offset
            );
        const offsetReceiptStart = television().receipts.length;
        television().dropNextStepReceipt("step_channel");
        await step("+4", "step_channel", "c", "Спорт", 4, 4);
        await eventually(
            () =>
                television()
                    .receipts.slice(offsetReceiptStart)
                    .filter(
                        (receipt) => receipt.data.operation === "step_channel"
                    ),
            (receipts) => receipts.length >= 2,
            "lost offset receipt ACK must resend only the original receipt"
        );
        const offsetReceipts = television()
            .receipts.slice(offsetReceiptStart)
            .filter((receipt) => receipt.data.operation === "step_channel");
        assert(
            offsetReceipts.every(
                (receipt) =>
                    JSON.stringify(receipt) ===
                    JSON.stringify(offsetReceipts[0])
            )
        );
        const offsetUncertainBefore = television();
        const offsetUncertainPosted = submissions.length;
        lostStepSubmission = { dropped: false, operation: "step_channel" };
        await assert.rejects(jsonOn("tv", "-4"), (error) => {
            assert.equal(error.stdout, "");
            return true;
        });
        assert(lostStepSubmission.dropped);
        await eventually(
            television,
            (state) =>
                state.channelSteps === offsetUncertainBefore.channelSteps + 1,
            "a lost offset POST response must not cause a second channel switch"
        );
        assert.equal(television().selectedChannel, "b");
        assert.deepEqual(submissions.slice(offsetUncertainPosted), [
            {
                action: "playback",
                device: "dev_test",
                offset: -4,
                operation: "step_channel",
            },
        ]);
        assert.equal(
            television().controlsReceived.length,
            offsetUncertainBefore.controlsReceived.length + 1
        );
        lostStepSubmission = null;
        const invalidOffsetPosted = submissions.length;
        const invalidOffsetSteps = television().channelSteps;
        for (const value of ["+0", "-0", "+1.5", "+9007199254740992"])
            await assert.rejects(jsonOn("tv", value));
        assert.equal(submissions.length, invalidOffsetPosted);
        assert.equal(television().channelSteps, invalidOffsetSteps);
        assert.equal(desktop().channelSteps, isolatedSteps);
        assert.equal(desktop().selectedChannel, isolatedSelection);
        assert.equal(desktop().controlsReceived.length, isolatedRequests);

        const browserCaps = await jsonOn("tv", "CAPS");
        const nativeCaps = await jsonOn("mac", "capabilities");
        assert.equal(browserCaps.version, 1);
        assert.equal(browserCaps.player.platform, "browser");
        assert.equal(nativeCaps.player.platform, "tauri");
        assert.notEqual(browserCaps.player.runtime, nativeCaps.player.runtime);
        assert(browserCaps.lifecycle.includes("reload_player"));
        for (const operation of ["exit_app", "restart_app", "reboot_device"])
            assert(!browserCaps.lifecycle.includes(operation));
        assert(nativeCaps.lifecycle.includes("exit_app"));
        assert(nativeCaps.lifecycle.includes("restart_app"));
        assert(!nativeCaps.lifecycle.includes("reboot_device"));
        assert.deepEqual(browserCaps.playback, [
            "previous_channel",
            "next_channel",
            "step_channel",
        ]);
        assert(browserCaps.input.includes("ok"));

        const aspectBefore = television();
        assert.deepEqual(browserCaps.aspect, {
            modes: ["fit", "fill"],
            operations: ["get", "set"],
            version: 1,
        });
        assert.deepEqual(await jsonOn("tv", "aspect"), {
            mode: "fit",
            operation: "get",
            persisted: false,
            runtime: browserCaps.player.runtime,
            saved_mode: null,
            version: 1,
        });
        assert.equal(
            television().backendAccesses,
            aspectBefore.backendAccesses
        );
        for (const [alias, mode] of [
            ["fill", "fill"],
            ["Fit to screen", "fit"],
            ["Fill screen", "fill"],
            ["fill", "fill"],
        ]) {
            const before = await deferred(
                "tv",
                television,
                ["aspect", alias],
                "aspect",
                "set",
                () => television().aspectChanges,
                undefined,
                { mode, runtime: browserCaps.player.runtime, version: 1 }
            );
            assert.equal(television().aspectChanges, before + 1);
            assert.deepEqual(await jsonOn("tv", "aspect", "get"), {
                mode,
                operation: "get",
                persisted: true,
                runtime: browserCaps.player.runtime,
                saved_mode: mode,
                version: 1,
            });
        }
        assert.equal(
            desktop().aspectMode,
            "fit",
            "aspect persists only for the selected player"
        );
        assert.equal(desktop().aspectSaved, null);
        assert.deepEqual(
            television().keysReceived,
            aspectBefore.keysReceived,
            "typed aspect never injects menu keys"
        );
        const invalidAspectPosted = submissions.length;
        await assert.rejects(jsonOn("tv", "aspect", "stretch"));
        assert.equal(submissions.length, invalidAspectPosted);
        for (const policy of ["unsupported", "protected"]) {
            if (policy === "unsupported") television().aspectSupported(false);
            else television().protectInput(true);
            const before = television();
            assert.deepEqual((await jsonOn("tv", "caps")).aspect, {
                modes: policy === "unsupported" ? [] : ["fit", "fill"],
                operations: policy === "unsupported" ? [] : ["get"],
                version: 1,
            });
            await assert.rejects(jsonOn("tv", "aspect", "fit"), (error) => {
                assert.equal(error.stdout, "");
                assert.match(error.stderr, /No aspect command was sent/);
                return true;
            });
            assert(
                television()
                    .controlsReceived.slice(before.controlsReceived.length)
                    .every((request) => request.action === "capabilities")
            );
            assert.equal(television().aspectChanges, before.aspectChanges);
            if (policy === "protected")
                assert.equal((await jsonOn("tv", "aspect")).mode, "fill");
            television().aspectSupported(true);
            television().protectInput(false);
        }
        for (const change of [
            () => television().changeAspectTarget(),
            () => television().protectInput(true),
        ]) {
            const before = await deferred(
                "tv",
                television,
                ["aspect", "fit"],
                "aspect",
                "set",
                () => television().aspectChanges,
                change,
                { mode: "fit", runtime: browserCaps.player.runtime, version: 1 }
            );
            assert.equal(
                television().aspectChanges,
                before,
                "a stale target or new protected surface cancels the accepted write"
            );
            assert.equal(television().aspectMode, "fill");
            television().protectInput(false);
        }
        const staleAspectBefore = television();
        television().reloadOnAspect();
        await assert.rejects(jsonOn("tv", "aspect", "fit"), (error) => {
            assert.equal(error.stdout, "");
            assert.match(error.stderr, /did not respond/);
            return true;
        });
        assert.equal(
            television().aspectChanges,
            staleAspectBefore.aspectChanges
        );
        assert.deepEqual(
            television()
                .controlsReceived.slice(
                    staleAspectBefore.controlsReceived.length
                )
                .map((request) => request.action),
            ["capabilities", "aspect"],
            "runtime mismatch never falls back or retries"
        );
        const replacedAspect = await jsonOn("tv", "aspect");
        assert.notEqual(replacedAspect.runtime, browserCaps.player.runtime);
        assert.equal(replacedAspect.mode, "fill");
        assert.equal(replacedAspect.persisted, true);

        async function unsupported(name, get, args, action, params) {
            const before = get().controlsReceived.length;
            await assert.rejects(runOn(name, ...args), (error) => {
                assert.equal(error.stdout, "");
                assert.match(error.stderr, /unsupported by this player/);
                return true;
            });
            const requests = get().controlsReceived.slice(before);
            assert.equal(
                requests.length,
                1,
                "unsupported controls must never retry through a legacy fallback"
            );
            assert.equal(requests[0].action, action);
            assert.deepEqual(requests[0].params, params);
        }
        await unsupported("tv", television, ["EXIT"], "lifecycle", {
            operation: "exit_app",
        });
        await unsupported("tv", television, ["restart", "app"], "lifecycle", {
            operation: "restart_app",
        });
        for (const [name, get] of [
            ["tv", television],
            ["mac", desktop],
        ])
            await unsupported(name, get, ["reboot", "device"], "lifecycle", {
                operation: "reboot_device",
            });
        await unsupported("tv", television, ["pause"], "playback", {
            operation: "pause",
        });
        assert.equal(
            television().nativeExits +
                desktop().nativeExits +
                desktop().nativeRestarts,
            0
        );

        async function deferred(
            name,
            get,
            args,
            action,
            value,
            readEffect,
            afterIntent,
            fields = {}
        ) {
            const gate = get().defer(action, value);
            const before = readEffect();
            const receipt = await jsonOn(name, ...args);
            assert.deepEqual(receipt, {
                [action === "input" ? "key" : "operation"]: value,
                accepted: true,
                dispatched: false,
                effect: action + "-after-ack",
                ...fields,
            });
            assert(
                gate.dropped,
                "must lose the first successful Go response ACK"
            );
            assert.equal(
                readEffect(),
                before,
                "CLI acceptance must precede the control effect"
            );
            if (afterIntent) afterIntent();
            gate.release();
            await eventually(
                () => gate.delivered,
                Boolean,
                "retried exact receipt was not acknowledged"
            );
            assert(
                gate.bodies.length >= 2,
                "must exercise receipt retry, not only delay"
            );
            assert(
                gate.bodies.every((body) => body === gate.bodies[0]),
                "retry must preserve exact receipt bytes"
            );
            return before;
        }
        for (const [alias, key, code] of [
            ["ENTER", "ok", 13],
            ["ch+", "channel_up", 427],
            ["vol-", "volume_down", 174],
        ]) {
            const before = await deferred(
                "tv",
                television,
                ["KEY", alias],
                "input",
                key,
                () => television().keysReceived.length
            );
            assert.equal(television().keysReceived.length, before + 1);
            assert.equal(television().keysReceived.at(-1), code);
        }
        const protectedBefore = await deferred(
            "tv",
            television,
            ["input", "ok"],
            "input",
            "ok",
            () => television().keysReceived.length,
            () => television().protectInput(true)
        );
        assert.equal(
            television().keysReceived.length,
            protectedBefore,
            "new PIN/support surface cancels already accepted input"
        );
        television().protectInput(false);
        assert.deepEqual(desktop().keysReceived, []);
        for (const [args, operation, read, expected] of [
            [["reload"], "reload_player", () => television().reloads, 2],
            [["standby"], "standby", () => television().standby, true],
            [["wake"], "wake", () => television().standby, false],
        ]) {
            await deferred(
                "tv",
                television,
                args,
                "lifecycle",
                operation,
                read
            );
            assert.equal(read(), expected);
        }
        await deferred(
            "mac",
            desktop,
            ["restart", "APPLICATION"],
            "lifecycle",
            "restart_app",
            () => desktop().nativeRestarts
        );
        assert.equal(desktop().nativeRestarts, 1);
        assert.equal(
            desktop().reloads,
            0,
            "native app restart must not become a page reload"
        );
        await deferred(
            "mac",
            desktop,
            ["quit"],
            "lifecycle",
            "exit_app",
            () => desktop().nativeExits
        );
        assert.equal(desktop().nativeExits, 1);
        assert.equal(television().nativeExits + television().nativeRestarts, 0);

        television().playback("vod");
        const beforeCapabilities = television().backendAccesses;
        assert.deepEqual((await jsonOn("tv", "caps")).playback, [
            "pause",
            "resume",
            "seek",
            "previous_channel",
            "next_channel",
            "step_channel",
        ]);
        assert.equal(
            television().backendAccesses,
            beforeCapabilities,
            "capability discovery must only peek at the existing backend"
        );
        for (const operation of ["pause", "resume"])
            assert.deepEqual(await jsonOn("tv", operation), {
                dispatched: true,
                operation,
            });
        assert.deepEqual(await jsonOn("tv", "seek", "12.5"), {
            dispatched: true,
            operation: "seek",
            position: 12.5,
        });
        assert.equal(television().paused, 1);
        assert.equal(television().resumed, 1);
        assert.equal(television().position, 12.5);
        assert.equal(television().seeks, 1);
        television().playback("archive");
        assert.deepEqual((await jsonOn("tv", "caps")).playback, [
            "pause",
            "resume",
            "previous_channel",
            "next_channel",
            "step_channel",
        ]);
        await unsupported("tv", television, ["seek", "1"], "playback", {
            operation: "seek",
            position: 1,
        });
        assert.equal(desktop().paused + desktop().resumed + desktop().seeks, 0);

        const malformed = [
            { action: "aspect", params: { operation: "get" } },
            {
                action: "aspect",
                params: {
                    mode: "fit",
                    operation: "get",
                    runtime: replacedAspect.runtime,
                },
            },
            {
                action: "aspect",
                params: {
                    mode: "stretch",
                    operation: "set",
                    runtime: replacedAspect.runtime,
                },
            },
            {
                action: "aspect",
                params: {
                    force: true,
                    mode: "fit",
                    operation: "set",
                    runtime: replacedAspect.runtime,
                },
            },
            {
                action: "aspect",
                params: { mode: "fit", operation: "set", runtime: "INVALID" },
            },
            { action: "capabilities", params: { all: true } },
            {
                action: "lifecycle",
                params: { force: true, operation: "exit_app" },
            },
            { action: "input", params: { key: "power" } },
            { action: "input", params: { key: "ok", repeat: 2 } },
            { action: "playback", params: { operation: "pause", position: 0 } },
            {
                action: "playback",
                params: { operation: "previous_channel", position: null },
            },
            {
                action: "playback",
                params: { operation: "next_channel", repeat: 2 },
            },
            { action: "playback", params: { operation: null } },
            { action: "playback", params: { operation: "next_chanel" } },
            { action: "playback", params: { operation: "prev" } },
            { action: "playback", params: { operation: "step_channel" } },
            {
                action: "playback",
                params: { offset: 0, operation: "step_channel" },
            },
            {
                action: "playback",
                params: { offset: 1.5, operation: "step_channel" },
            },
            {
                action: "playback",
                params: { offset: 9007199254740992, operation: "step_channel" },
            },
            {
                action: "playback",
                params: { offset: 15, operation: "step_channel", repeat: 2 },
            },
            { action: "input", params: { key: "previous_channel" } },
            {
                action: "playback",
                params: { operation: "seek", position: 9007199254740992 },
            },
        ];
        const malformedStepCount = television().channelSteps;
        const malformedAspectCount = television().aspectChanges;
        for (const payload of malformed) {
            const result = await fetch(
                address + "/api/requests?device_id=dev_test",
                {
                    body: JSON.stringify(payload),
                    headers: {
                        Authorization: "Bearer " + serverConfig.admin_token,
                        "Content-Type": "application/json",
                    },
                    method: "POST",
                }
            );
            assert.equal(
                result.status,
                400,
                "Go must reject an ambiguous control before queue admission"
            );
        }
        assert.equal(television().channelSteps, malformedStepCount);
        assert.equal(television().aspectChanges, malformedAspectCount);
        const priorAspectRuntime = (await jsonOn("tv", "aspect")).runtime;
        television().stop();
        television = player("dev_test", "b".repeat(32), 30);
        const restoredAspect = await jsonOn("tv", "aspect");
        assert.notEqual(restoredAspect.runtime, priorAspectRuntime);
        assert.equal(restoredAspect.mode, "fill");
        assert.equal(restoredAspect.saved_mode, "fill");
        assert.equal(restoredAspect.persisted, true);
        assert.equal(
            television().aspectChanges,
            0,
            "fixture restart restores saved mode without a remote write"
        );
        // Use the actual favorites module, channel-reference codec, profile
        // handler, transport and CLI. Only the catalog/storage/display ports
        // are fixtures; no fake favorites reply can bypass Go/CLI validation.
        television().stop();
        television = player("dev_test", "b".repeat(32), 30, false, true);
        const emptyFavorites = await jsonOn("tv", "fav");
        assert.deepEqual(emptyFavorites.entries, []);
        const firstFavorite = await jsonOn("tv", "fav", "add", "First profile");
        assert.equal(firstFavorite.created, true);
        assert.equal(firstFavorite.entry.profile_number, 1);
        assert.equal(firstFavorite.entry.kind, "live");
        assert.deepEqual(Object.keys(firstFavorite.entry).sort(), [
            "id",
            "kind",
            "name",
            "profile_name",
            "profile_number",
            "provider",
            "title",
        ]);
        const repeatedFavorite = await jsonOn("tv", "favorites", "current");
        assert.equal(repeatedFavorite.created, false);
        assert.equal(repeatedFavorite.entry.id, firstFavorite.entry.id);
        await run("profile", "2");
        await eventually(
            television,
            (state) => state.configuration.active === 1,
            "second profile must load"
        );
        await run("play", "1");
        const secondFavorite = await jsonOn(
            "tv",
            "favourite",
            "add",
            "Second profile"
        );
        assert.equal(secondFavorite.entry.profile_number, 2);
        assert.notEqual(secondFavorite.entry.id, firstFavorite.entry.id);
        const firstPlay = await jsonOn(
            "tv",
            "fav",
            "play",
            firstFavorite.entry.id
        );
        assert.equal(firstPlay.state, "dispatched");
        assert.equal(firstPlay.dispatched, true);
        assert.equal(firstPlay.entry.id, firstFavorite.entry.id);
        assert.equal(television().configuration.active, 0);
        assert.deepEqual(television().favoritePlays.at(-1), {
            itemId: "news:0",
            profile: 0,
        });
        const loads = television().playlistLoads;
        await jsonOn("tv", "fav", "First profile");
        assert.equal(
            television().playlistLoads,
            loads,
            "same-profile favorite does not reload its catalog"
        );
        assert.deepEqual(television().favoritePlays.at(-1), {
            itemId: "news:0",
            profile: 0,
        });
        const priorFavoriteRuntime = firstPlay.runtime;
        television().stop();
        television = player("dev_test", "b".repeat(32), 30, false, true);
        const restoredFavorites = await jsonOn("tv", "fav");
        assert.notEqual(restoredFavorites.runtime, priorFavoriteRuntime);
        assert.deepEqual(
            restoredFavorites.entries.map((entry) => entry.id),
            [firstFavorite.entry.id, secondFavorite.entry.id]
        );
        await jsonOn("tv", "fav", "play", "Second profile");
        assert.deepEqual(television().favoritePlays, [
            { itemId: "news:1", profile: 1 },
        ]);
        assert.equal(television().configuration.active, 1);
        const removedFavorite = await jsonOn(
            "tv",
            "fav",
            "rm",
            firstFavorite.entry.id
        );
        assert.equal(removedFavorite.removed, true);
        assert.equal(removedFavorite.entry.id, firstFavorite.entry.id);
        const beforeMissing = television().favoritePlays.length;
        await assert.rejects(
            run("fav", "play", firstFavorite.entry.id),
            (error) => {
                assert.equal(error.stdout, "");
                assert.match(error.stderr, /No favorite matches/);
                return true;
            }
        );
        assert.equal(television().favoritePlays.length, beforeMissing);
        await jsonOn("tv", "fav", "remove", secondFavorite.entry.id);
        assert.deepEqual((await jsonOn("tv", "fav")).entries, []);
        await checkOfflineProfiles();
        console.log(
            "PASS favorites via real Go + compiled TS + Python: current capture, aliases, deduplication, same/cross-profile exact selection, loaded-catalog gating, restart persistence, redacted metadata and bound not-found rejection"
        );
        console.log(
            "PASS aspect via real Go + compiled TS + Python: fit/fill aliases, truthful pre-ACK acceptance, exact lost-ACK retries, idempotent setting, readback, device isolation, unsupported/read-only gating, protected/target/runtime fences and restored saved state"
        );
        console.log(
            "PASS previous/prev/next and signed offsets through real Go + compiled TS + Python: category wraps, exact safe-integer offsets, catalogue receipts, one mutation, device isolation, malformed rejection and no replay after lost POST/receipt responses"
        );
        console.log(
            "PASS real Go + compiled TS + Python controls: capability identities, CLI key aliases, exact after-ACK effects/retries, protected-input cancellation, native/browser lifecycle distinctions and owned playback shapes"
        );
        console.log(
            "PASS kiosk CLI/server/player: arm, capture, set, block ordinary switching, status, disable and device isolation"
        );
        console.log(
            "PASS real Go + TS + Python through reverse-proxy prefix: device isolation, lost-response deduplication, searches, providers, atomic M3U profile edits, secret-free replies and acknowledged restarts"
        );
    } finally {
        pace.close();
        for (const controller of controllers)
            controller.configure({ address: "", enabled: false, token: "" });
        proxy.closeAllConnections();
        await new Promise((resolve) => proxy.close(resolve));
        server.kill();
        fs.rmSync(dir, { force: true, recursive: true });
    }
})().catch((error) => {
    fs.rmSync(dir, { force: true, recursive: true });
    console.error(error);
    process.exitCode = 1;
});
