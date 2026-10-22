const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const acorn = require("acorn");

function emit(file) {
    const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES5,
        },
    }).outputText;
    acorn.parse(code, { ecmaVersion: 5 });
    return code;
}
const plexContext = { exports: {} };
vm.runInNewContext(emit("src/commands/remote-plex.ts"), plexContext);
const favoritesContext = { exports: {} };
vm.runInNewContext(
    emit("src/commands/remote-favorites-contract.ts"),
    favoritesContext
);
const updateContext = {
    exports: {},
    require: () => ({
        resolveNativePlugin: () =>
            assert.fail("capabilities must not resolve an installer"),
    }),
};
vm.runInNewContext(emit("src/commands/remote-app-update.ts"), updateContext);
const context = {
    exports: {},
    require(name) {
        if (name === "./remote-app-update") return updateContext.exports;
        if (name === "./remote-favorites-contract")
            return favoritesContext.exports;
        assert.equal(name, "./remote-plex");
        return plexContext.exports;
    },
};
vm.runInNewContext(emit("src/commands/remote-restart.ts"), context);
const execute = context.exports.executeRemoteControl;
const doctorCapabilities = context.exports.remoteDoctorCapabilities;
const plain = (value) => JSON.parse(JSON.stringify(value));

{
    const play = () => {};
    const w = { __ottCoreTransport: { play }, stbPlay: play };
    let result;
    const restart = () =>
        context.exports.executeRemoteRestart(
            w,
            { target: "stream" },
            (reply) => {
                result = plain(reply);
            }
        );
    restart();
    assert.equal(
        result.status,
        "unsupported",
        "missing implementation remains unsupported"
    );
    let attempts = 0;
    w.__ottCoreBackend = () => ({
        restart: () => {
            attempts++;
            return null;
        },
    });
    restart();
    assert.equal(result.status, "rejected");
    assert.equal(result.data.reason, "no_restartable_stream");
    assert.equal(attempts, 1, "no automatic retry or player reload");
    w.__ottCoreBackend = () => ({
        restart: () => ({ accepted: true, dispatched: true, target: "stream" }),
    });
    restart();
    assert.equal(
        result.status,
        "ok",
        "the same runtime can restart once a stream is ready"
    );
}

function fixture() {
    const effects = [];
    let locked = false,
        kiosk = false,
        protectedSurface = false;
    let active = true,
        standby = false,
        revision = 0;
    let kind = "vod",
        phase = "playing";
    const handle = {
        active: () => active,
        pause: () => {
            effects.push("pause");
            phase = "paused";
        },
        resume: () => {
            effects.push("resume");
            phase = "playing";
        },
        seek: (position) => effects.push(["seek", position]),
        snapshot: () => ({ phase }),
    };
    const backend = {
        current: () => handle,
        restart: () => ({ accepted: true, dispatched: true, target: "stream" }),
    };
    const play = () => {};
    const w = {
        __ottClassicPlayback: { snapshot: () => ({ target: { kind } }) },
        __ottCoreBackend: () => backend,
        __ottCoreBackendPeek: () => backend,
        __ottCoreTransport: { play },
        __ottKiosk: { enabled: () => kiosk },
        __ottParental: { needs: () => locked },
        __ottRemoteLifecycle: {
            exit: () => effects.push("exit"),
            platform: "tauri",
            restart: () => effects.push("restart"),
        },
        $: () => ({ is: () => protectedSurface }),
        keyHandler: (event) => effects.push(["key", event.keyCode]),
        keys: {
            AUDIO: 83,
            DOWN: 40,
            ENTER: 13,
            LEFT: 37,
            MENU: 179,
            MUTE: 173,
            PLAY: 80,
            RETURN: 8,
            RIGHT: 39,
            STOP: 83,
            SUBTITLE: 76,
            UP: 38,
            VOL_DOWN: 174,
            VOL_UP: 175,
        },
        restart: () => effects.push("reload"),
        stbIsStandby: () => standby,
        stbPlay: play,
        stbToggleStandby: () => {
            standby = !standby;
            effects.push("standby");
        },
    };
    vm.runInNewContext(emit("src/ui/input-router.ts"), { window: w });
    const router = w.__ottInputRouter.create({ keys: () => w.keys });
    w.__ottClassicScreenPort = {
        normalize: router.normalize,
        revision: () => revision,
        screens: { current: () => null },
    };
    function run(action, params = {}, acknowledged = true) {
        let result, effect;
        execute(
            w,
            action,
            params,
            (value) => {
                result = plain(value);
            },
            acknowledged
                ? (value) => {
                      effect = value;
                  }
                : undefined
        );
        return { effect, result };
    }
    return {
        active: (value) => {
            active = value;
        },
        effects,
        handle,
        kind: (value) => {
            kind = value;
        },
        kiosk: (value) => {
            kiosk = value;
        },
        lock: (value) => {
            locked = value;
        },
        phase: (value) => {
            phase = value;
        },
        protect: (value) => {
            protectedSurface = value;
        },
        revise: () => revision++,
        run,
        w,
    };
}

{
    const f = fixture();
    const caps = f.run("capabilities").result.data;
    assert.equal(caps.version, 1);
    assert.deepEqual(caps.inspect, {
        sections: ["doctor", "snapshot", "operation"],
        version: 1,
    });
    assert.deepEqual(caps.player, plain(context.exports.remotePlayerInfo(f.w)));
    assert.equal(caps.player.platform, "tauri");
    assert.match(caps.player.runtime, /^[a-z0-9-]{1,64}$/);
    assert.equal(caps.player.version, "__OTTP_VERSION__");
    assert.deepEqual(caps.playback, ["pause", "resume", "seek"]);
    assert.ok(caps.lifecycle.includes("exit_app"));
    assert.ok(caps.lifecycle.includes("restart_app"));
    assert.ok(!caps.lifecycle.includes("reboot_device"));
    assert.ok(
        !caps.input.includes("audio"),
        "AUDIO/STOP collision cannot dispatch STOP"
    );
    assert.ok(
        !caps.input.includes("channels"),
        "missing hardware key is not claimed"
    );
    assert.equal(f.effects.length, 0, "capability reads have no effects");
    f.w.__ottRemoteLifecycle = { platform: "credentials@example.test" };
    const browser = f.run("capabilities").result.data;
    assert.equal(browser.player.platform, "browser");
    assert.equal(browser.player.runtime, caps.player.runtime);
    assert.ok(!browser.lifecycle.includes("exit_app"));
    assert.ok(!JSON.stringify(browser).includes("credentials"));
}

{
    const f = fixture();
    f.w.keys.MENU = 0;
    f.w.keys.TOOLS = 82;
    f.w.keys.SETUP = 82;
    assert(f.run("capabilities").result.data.input.includes("menu"));
    assert(!f.run("capabilities").result.data.input.includes("settings"));
    const request = f.run("input", { key: "menu" });
    assert.equal(request.result.status, "ok");
    assert.equal(f.effects.length, 0);
    request.effect();
    assert.deepEqual(f.effects, [["key", 82]]);
    const stale = f.run("input", { key: "menu" });
    f.kiosk(true);
    stale.effect();
    assert.equal(f.effects.length, 1, "kiosk still fences the Android alias");
}

for (const [action, invalid] of [
    ["capabilities", [{ unknown: true }, [], null, 5]],
    [
        "lifecycle",
        [{}, { operation: "exit" }, { js: "1", operation: "exit_app" }],
    ],
    [
        "input",
        [
            {},
            { key: "power" },
            { key: "exit" },
            { key: "stop" },
            { key: "1" },
            { key: "__proto__" },
            { key: "ok", repeat: 100 },
        ],
    ],
    [
        "playback",
        [
            {},
            { operation: "toggle" },
            { operation: "seek" },
            { operation: "seek", position: -1 },
            { operation: "seek", position: Infinity },
            { operation: "seek", position: "10" },
            { operation: "pause", position: 1 },
        ],
    ],
]) {
    for (const params of invalid) {
        const f = fixture();
        assert.equal(
            f.run(action, params).result.status,
            "rejected",
            action + JSON.stringify(params)
        );
        assert.equal(f.effects.length, 0);
    }
}

for (const operation of ["exit_app", "restart_app", "standby", "wake"]) {
    for (const changed of ["none", "lock", "kiosk", "replace", "missing-ack"]) {
        const f = fixture();
        const pending = f.run(
            "lifecycle",
            { operation },
            changed !== "missing-ack"
        );
        assert.equal(f.effects.length, 0, operation + " waits for ACK");
        if (changed === "missing-ack") {
            assert.equal(pending.result.status, "unsupported");
            assert.equal(pending.effect, undefined);
            continue;
        }
        assert.deepEqual(pending.result.data, {
            accepted: true,
            dispatched: false,
            effect: "lifecycle-after-ack",
            operation,
        });
        if (changed === "lock") f.lock(true);
        if (changed === "kiosk") f.kiosk(true);
        if (changed === "replace") {
            f.w.__ottRemoteLifecycle = { ...f.w.__ottRemoteLifecycle };
            f.w.stbToggleStandby = () => f.effects.push("replacement");
        }
        pending.effect();
        assert.equal(
            f.effects.length,
            operation !== "wake" &&
                (changed === "none" ||
                    (operation === "standby" &&
                        ["lock", "kiosk"].includes(changed)))
                ? 1
                : 0,
            operation + " " + changed
        );
    }
}
for (const changed of ["none", "lock", "kiosk", "replace"]) {
    const f = fixture();
    f.w.stbSetStandby = (value) => f.effects.push(["set-standby", value]);
    const pending = f.run("lifecycle", { operation: "standby" });
    assert.equal(
        f.effects.length,
        0,
        "standby setter waits for acknowledgement"
    );
    if (changed === "lock") f.lock(true);
    if (changed === "kiosk") f.kiosk(true);
    if (changed === "replace")
        f.w.stbSetStandby = () => f.effects.push("replacement");
    pending.effect();
    assert.deepEqual(
        f.effects,
        changed !== "replace" ? [["set-standby", true]] : []
    );
    if (changed === "none") {
        f.w.stbIsStandby = () => true;
        f.run("lifecycle", { operation: "standby" }).effect();
        assert.deepEqual(
            f.effects,
            [
                ["set-standby", true],
                ["set-standby", true],
            ],
            "repeated Stop reasserts teardown even when the standby flag is already set"
        );
    }
}
{
    const f = fixture();
    f.run("lifecycle", { operation: "standby" }).effect();
    f.run("lifecycle", { operation: "standby" }).effect();
    assert.deepEqual(f.effects, ["standby"], "standby is a state setter");
    f.run("lifecycle", { operation: "wake" }).effect();
    f.run("lifecycle", { operation: "wake" }).effect();
    assert.deepEqual(
        f.effects,
        ["standby", "standby"],
        "wake is a state setter"
    );
    assert.equal(
        f.run("lifecycle", { operation: "reboot_device" }).result.status,
        "unsupported"
    );
    const reload = f.run("lifecycle", { operation: "reload_player" });
    assert.equal(reload.result.data.effect, "lifecycle-after-ack");
    reload.effect();
    assert.equal(f.effects.at(-1), "reload");
    assert.equal(
        f.run("lifecycle", { operation: "restart_stream" }).result.data
            .dispatched,
        true
    );
}

for (const changed of [
    "none",
    "pin",
    "consent",
    "parental-editor",
    "revision",
    "handler",
    "key",
    "mapping",
    "kiosk",
]) {
    const f = fixture();
    const pending = f.run("input", { key: "ok" });
    assert.deepEqual(pending.result.data, {
        accepted: true,
        dispatched: false,
        effect: "input-after-ack",
        key: "ok",
    });
    assert.equal(f.effects.length, 0);
    if (changed === "pin" || changed === "consent") f.protect(true);
    if (changed === "parental-editor") {
        f.w.isListVisible = true;
        f.w.listArray = [{ editorAction: "parentalEnabled" }];
    }
    if (changed === "revision") f.revise();
    if (changed === "handler")
        f.w.keyHandler = () => f.effects.push("replacement");
    if (changed === "key") f.w.keys.ENTER = 27;
    if (changed === "mapping") f.w.__ottDevice = { eventToKeyCode: () => 83 };
    if (changed === "kiosk") f.kiosk(true);
    pending.effect();
    assert.deepEqual(
        f.effects,
        changed === "none" ? [["key", 13]] : [],
        changed
    );
}
{
    const f = fixture();
    f.protect(true);
    for (const key of ["up", "down", "left", "right", "ok", "mute"])
        assert.equal(
            f.run("input", { key }).result.status,
            "rejected",
            "local-only surface " + key
        );
    f.protect(false);
    f.lock(true);
    f.kiosk(true);
    assert.equal(f.run("input", { key: "ok" }).result.status, "rejected");
    assert.equal(f.run("input", { key: "mute" }).result.status, "ok");
    f.run("input", { key: "volume_up" }).effect();
    assert.deepEqual(
        f.effects,
        [["key", 175]],
        "volume remains available under settings/kiosk policy"
    );
    assert.equal(
        f.run("input", { key: "mute" }, false).result.status,
        "unsupported"
    );
}

{
    const f = fixture();
    for (const operation of ["pause", "pause", "resume", "resume"])
        assert.deepEqual(f.run("playback", { operation }).result.data, {
            dispatched: true,
            operation,
        });
    assert.deepEqual(
        f.run("playback", { operation: "seek", position: 20.5 }).result.data,
        { dispatched: true, operation: "seek", position: 20.5 }
    );
    assert.deepEqual(f.effects.at(-1), ["seek", 20.5]);
    f.kind("archive");
    assert.equal(
        f.run("playback", { operation: "seek", position: 5 }).result.status,
        "unsupported",
        "archive timeline uses domain-specific seek, not decoder seconds"
    );
    assert.equal(f.run("playback", { operation: "pause" }).result.status, "ok");
    f.kind("live");
    assert.deepEqual(f.run("capabilities").result.data.playback, []);
    assert.equal(
        f.run("playback", { operation: "resume" }).result.status,
        "unsupported"
    );
    f.kind("vod");
    f.active(false);
    assert.ok(
        !f.run("capabilities").result.data.lifecycle.includes("restart_stream")
    );
    assert.equal(
        f.run("playback", { operation: "pause" }).result.status,
        "unsupported"
    );
    f.active(true);
    f.phase("loading");
    assert.equal(
        f.run("playback", { operation: "pause" }).result.status,
        "unsupported"
    );
    f.phase("playing");
    f.w.stbPlay = () => {};
    assert.equal(
        f.run("playback", { operation: "resume" }).result.status,
        "unsupported"
    );
}
{
    const f = fixture();
    const order = [];
    f.handle.sample = () => order.push("sample");
    f.w.__ottClassicPlayback.checkpoint = (_state, force) => {
        assert.equal(force, true);
        order.push("checkpoint");
        f.lock(true);
    };
    const pending = f.run("lifecycle", { operation: "restart_app" });
    assert.deepEqual(order, []);
    pending.effect();
    assert.deepEqual(order, ["sample", "checkpoint"]);
    assert.deepEqual(
        f.effects,
        [],
        "policy change during persistence cancels native effect"
    );
}
console.log(
    "PASS remote controls: ES5 schemas, public identity, honest capabilities, native ACK fencing, kiosk/PIN/local consent, key collisions and owned playback"
);

function aspectFixture() {
    const f = fixture();
    let mode = "fit",
        savedMode = null,
        generation = 1,
        supported = true;
    f.w.captureAspectTarget = () => {
        if (!supported) return null;
        const captured = generation;
        const current = () => supported && captured === generation;
        return {
            current,
            mode,
            savedMode,
            set(value) {
                if (!current()) return false;
                mode = savedMode = value;
                f.effects.push(["aspect", value]);
                return true;
            },
        };
    };
    const runtime = f.run("capabilities").result.data.player.runtime;
    return Object.assign(f, {
        aspect(operation = "get", value) {
            return f.run("aspect", {
                operation,
                runtime,
                ...(value === undefined ? {} : { mode: value }),
            });
        },
        changeTarget: () => generation++,
        runtime,
        supported: (value) => {
            supported = value;
        },
    });
}
{
    const f = aspectFixture();
    f.w.Capacitor = {
        getPlatform: () => "android",
        isNativePlatform: () => true,
        isPluginAvailable: (name) => name === "AppUpdate",
    };
    const caps = f.run("capabilities").result.data;
    assert.deepEqual(caps.app_update, {
        operations: ["status", "prepare", "install"],
        version: 1,
    });
    assert.deepEqual(caps.aspect, {
        modes: ["fit", "fill"],
        operations: ["get", "set"],
        version: 1,
    });
    assert.equal(caps.player.runtime, f.runtime);
    assert.equal(f.aspect().result.data.runtime, f.runtime);
    f.w.Capacitor.getPlatform = () => "ios";
    assert.equal(f.run("capabilities").result.data.app_update, null);
    assert.deepEqual(f.run("capabilities").result.data.aspect, caps.aspect);
    assert.deepEqual(f.effects, []);
}
{
    const f = aspectFixture();
    f.w.__ottCoreBackend = () =>
        assert.fail("aspect must not create a decoder");
    assert.deepEqual(f.run("capabilities").result.data.aspect, {
        modes: ["fit", "fill"],
        operations: ["get", "set"],
        version: 1,
    });
    assert.deepEqual(f.aspect().result.data, {
        mode: "fit",
        operation: "get",
        persisted: false,
        runtime: f.runtime,
        saved_mode: null,
        version: 1,
    });
    const pending = f.aspect("set", "fill");
    assert.deepEqual(pending.result.data, {
        accepted: true,
        dispatched: false,
        effect: "aspect-after-ack",
        mode: "fill",
        operation: "set",
        runtime: f.runtime,
        version: 1,
    });
    assert.deepEqual(
        f.effects,
        [],
        "acceptance does not mutate presentation or storage"
    );
    assert.equal(f.aspect().result.data.mode, "fit");
    pending.effect();
    pending.effect();
    assert.deepEqual(f.effects, [["aspect", "fill"]], "effect is one-shot");
    assert.deepEqual(f.aspect().result.data, {
        mode: "fill",
        operation: "get",
        persisted: true,
        runtime: f.runtime,
        saved_mode: "fill",
        version: 1,
    });
    f.aspect("set", "fill").effect();
    assert.equal(
        f.aspect().result.data.mode,
        "fill",
        "explicit set never toggles"
    );
}
for (const params of [
    {},
    [],
    null,
    1,
    { operation: "get" },
    { operation: "get", runtime: "stale" },
    { operation: "toggle" },
    { mode: "stretch", operation: "set" },
    { mode: 1, operation: "set" },
    { mode: "fit", operation: "get" },
    { extra: true, operation: "get" },
]) {
    const f = aspectFixture();
    const input =
        params && !Array.isArray(params) && typeof params === "object"
            ? { runtime: f.runtime, ...params }
            : params;
    // The missing-runtime case is checked separately below.
    if (
        params &&
        Object.keys(params).join() === "operation" &&
        params.operation === "get"
    ) {
        assert.equal(f.run("aspect", params).result.status, "rejected");
        continue;
    }
    assert.equal(f.run("aspect", input).result.status, "rejected");
    assert.deepEqual(f.effects, []);
}
for (const policy of ["lock", "kiosk", "protect"]) {
    const f = aspectFixture();
    f[policy](true);
    assert.deepEqual(f.run("capabilities").result.data.aspect.operations, [
        "get",
    ]);
    assert.equal(
        f.aspect().result.status,
        "ok",
        "policy keeps read-only aspect available"
    );
    assert.equal(f.aspect("set", "fill").result.status, "rejected");
    assert.deepEqual(f.aspect("set", "fill").result.data, {
        error: "restricted",
        mode: "fill",
        operation: "set",
        runtime: f.runtime,
        version: 1,
    });
    assert.deepEqual(f.effects, []);
}
for (const change of [
    "lock",
    "kiosk",
    "protect",
    "target",
    "support",
    "producer",
    "throw",
]) {
    const f = aspectFixture();
    const pending = f.aspect("set", "fill");
    if (["lock", "kiosk", "protect"].includes(change)) f[change](true);
    if (change === "target") f.changeTarget();
    if (change === "support") f.supported(false);
    if (change === "producer") f.w.captureAspectTarget = () => null;
    if (change === "throw")
        f.w.__ottKiosk.enabled = () => {
            throw new Error("policy unavailable");
        };
    pending.effect();
    assert.deepEqual(f.effects, [], "ACK rechecks " + change);
    if (["lock", "kiosk", "protect"].includes(change)) f[change](false);
    pending.effect();
    assert.deepEqual(f.effects, [], "a cancelled ACK is never revived");
}
{
    const f = aspectFixture();
    assert.equal(
        f.run(
            "aspect",
            { mode: "fill", operation: "set", runtime: f.runtime },
            false
        ).result.status,
        "unsupported"
    );
    for (const capture of [
        undefined,
        () => null,
        () => {
            throw new Error("unavailable");
        },
        () => ({ mode: 2 }),
    ]) {
        f.w.captureAspectTarget = capture;
        assert.deepEqual(f.run("capabilities").result.data.aspect, {
            modes: [],
            operations: [],
            version: 1,
        });
        assert.equal(f.aspect().result.status, "unsupported");
        assert.deepEqual(f.aspect().result.data, {
            error: "unsupported",
            operation: "get",
            runtime: f.runtime,
            version: 1,
        });
        assert.equal(f.aspect("set", "fill").result.status, "unsupported");
    }
    assert.deepEqual(
        f.run("aspect", {
            mode: "fill",
            operation: "set",
            runtime: "stale-page",
        }).result.data,
        {
            error: "runtime_mismatch",
            mode: "fill",
            operation: "set",
            runtime: f.runtime,
            version: 1,
        },
        "negative receipts identify the actual runtime, never echo another page"
    );
}
console.log(
    "PASS remote aspect: strict runtime-bound schemas, pure read, honest capabilities, saved mode, one-shot ACK, policy and target fencing"
);

// Doctor uses the same predicates as execution, without creating a decoder or
// entering effectful screenshot.status()/snapshot() configuration synchronization.
{
    const f = fixture();
    const forbidden = () => {
        throw new Error("must not run during doctor");
    };
    f.w.__ottCoreBackend = forbidden;
    f.handle.sample = forbidden;
    f.w.__ottRemoteScreenshot = {
        peek: () => ({
            busy: false,
            connected: true,
            known: true,
            needsSourceSelection: true,
            ready: false,
            source: null,
            state: "permission_required",
            supported: true,
        }),
        snapshot: forbidden,
        status: forbidden,
    };
    const generic = f.run("capabilities").result.data;
    assert.deepEqual(generic.screenshot, {
        source: null,
        state: "permission_required",
    });
    f.w.__ottRemoteDiagnostics = {
        status: () => ({
            enabled: true,
            runtimeId: "diag-runtime",
            state: "ready",
            trusted: true,
        }),
    };
    const caps = plain(doctorCapabilities(f.w));
    assert.equal(caps.length, 10);
    assert.equal(
        caps.find((x) => x.name === "screenshot").reason,
        "source_selection_required"
    );
    assert.equal(caps.find((x) => x.name === "diagnostics").reason, "ready");
    for (const operation of [
        "restart_stream",
        "reload_player",
        "restart_app",
        "exit_app",
        "reboot_device",
        "standby",
        "wake",
    ])
        assert.equal(
            caps.find((x) => x.name === operation).state === "available",
            generic.lifecycle.includes(operation)
        );
    assert.equal(f.effects.length, 0);
    f.w.__ottRemoteScreenshot.peek = () => ({
        source: "https://private.example/token",
        state: "ready",
    });
    assert.deepEqual(f.run("capabilities").result.data.screenshot, {
        source: null,
        state: "unsupported",
    });
    delete f.w.__ottCoreBackendPeek;
    assert.deepEqual(
        plain(doctorCapabilities(f.w).find((x) => x.name === "restart_stream")),
        {
            name: "restart_stream",
            reason: "producer_unavailable",
            state: "unknown",
        }
    );
}
{
    const f = fixture();
    const capability = (name) =>
        plain(doctorCapabilities(f.w).find((x) => x.name === name));
    f.lock(true);
    assert.equal(capability("restart_app").reason, "policy_restricted");
    assert.equal(
        capability("input").reason,
        "ready",
        "volume remains allowed under settings lock"
    );
    f.protect(true);
    assert.equal(capability("input").reason, "policy_restricted");
    f.protect(false);
    f.lock(false);
    f.kiosk(true);
    assert.equal(capability("restart_app").reason, "policy_restricted");
    assert.equal(capability("reload_player").reason, "ready");
    f.kiosk(false);
    f.active(false);
    assert.equal(capability("restart_stream").reason, "no_active_media");
    f.active(true);
    f.phase("loading");
    assert.equal(
        capability("restart_stream").reason,
        "current_state_unsupported"
    );
    f.kind("live");
    for (const phase of ["loading", "error"]) {
        f.phase(phase);
        assert.equal(capability("restart_stream").reason, "ready");
        assert.ok(
            f
                .run("capabilities")
                .result.data.lifecycle.includes("restart_stream")
        );
        assert.equal(
            f.run("lifecycle", { operation: "restart_stream" }).result.status,
            "ok"
        );
        assert.equal(
            f.run("playback", { operation: "pause" }).result.status,
            "unsupported"
        );
    }
    f.phase("stopped");
    assert.equal(
        capability("restart_stream").reason,
        "current_state_unsupported"
    );
    assert.equal(
        f.run("lifecycle", { operation: "restart_stream" }).result.status,
        "unsupported"
    );
}
{
    const f = fixture();
    const capability = (name) =>
        plain(doctorCapabilities(f.w).find((x) => x.name === name));
    for (const [facts, expected] of [
        [{ connected: false }, "remote_disconnected"],
        [{ connected: true, known: false }, "producer_unavailable"],
        [{ connected: true, known: true, supported: false }, "not_implemented"],
        [
            {
                busy: true,
                connected: true,
                known: true,
                ready: true,
                supported: true,
            },
            "busy",
        ],
        [
            { connected: true, known: true, ready: true, supported: true },
            "ready",
        ],
    ]) {
        f.w.__ottRemoteScreenshot = { peek: () => facts };
        assert.equal(capability("screenshot").reason, expected);
    }
    for (const [facts, expected] of [
        [{ trusted: false }, "remote_disconnected"],
        [
            { enabled: true, state: "ready", trusted: true },
            "producer_unavailable",
        ],
        [
            { enabled: false, state: "unavailable", trusted: true },
            "current_state_unsupported",
        ],
        [
            {
                enabled: true,
                runtimeId: "runtime",
                state: "active",
                trusted: true,
            },
            "ready",
        ],
    ]) {
        f.w.__ottRemoteDiagnostics = { status: () => facts };
        assert.equal(capability("diagnostics").reason, expected);
    }
    f.w.__ottRemoteScreenshot = {
        peek: () => {
            throw new Error("secret");
        },
    };
    assert.deepEqual(capability("screenshot"), {
        name: "screenshot",
        reason: "producer_unavailable",
        state: "unknown",
    });
}
console.log(
    "PASS doctor capabilities: pure reads, shared lifecycle reasons, live repair eligibility and explicit inspect advertisement"
);

function sourceFunction(file, name) {
    const ast = ts.createSourceFile(
        file,
        fs.readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true
    );
    return ast.statements
        .find(
            (node) => ts.isFunctionDeclaration(node) && node.name?.text === name
        )
        .getText(ast);
}
function isolated(source, globals) {
    const code = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES5,
        },
    }).outputText;
    acorn.parse(code, { ecmaVersion: 5 });
    const context = { ...globals, exports: {} };
    vm.runInNewContext(code, context);
    return context.exports;
}

// The actual UI exit producer marks its owned confirmation as local-only.
{
    const f = fixture();
    const owner = { model: {} };
    let confirmation;
    f.w.stbExit = () => f.effects.push("legacy-exit");
    f.w.__ottClassicScreenPort.owner = () => owner;
    const { exitPortal } = isolated(
        sourceFunction("src/ui/index.ts", "exitPortal"),
        {
            _: (value) => value,
            confirmBox: (_message, yes) => {
                confirmation = yes;
            },
            window: f.w,
        }
    );
    f.w.keyHandler = exitPortal;
    f.run("input", { key: "back" }).effect();
    assert.equal(
        confirmation,
        undefined,
        "remote Back cannot create a native exit route"
    );
    assert.equal(f.w.__ottRemoteInputActive, undefined);
    exitPortal();
    assert.equal(owner.model.localOnlyInput, true);
    f.w.__ottClassicScreenPort.screens.current = () => owner;
    assert.equal(
        f.run("input", { key: "ok" }).result.status,
        "rejected",
        "remote OK cannot consume a local exit confirmation"
    );
    f.w.__ottRemoteInputActive = true;
    confirmation();
    assert.deepEqual(
        f.effects,
        [],
        "exit continuation independently rejects remote provenance"
    );
    f.w.__ottRemoteInputActive = false;
    confirmation();
    assert.deepEqual(
        f.effects,
        ["legacy-exit"],
        "local confirmation still works"
    );
}

// Direct language-cancel, menu-restart and native legacy sinks cannot bypass
// typed capability dispatch, including native exits that start async work.
const indexAst = ts.createSourceFile(
    "index.ts",
    fs.readFileSync("src/index.ts", "utf8"),
    ts.ScriptTarget.Latest,
    true
);
const nativeAssignments = [];
function collectNative(node) {
    if (
        ts.isBinaryExpression(node) &&
        node.left.getText(indexAst) === "window.stbExit" &&
        ts.isFunctionExpression(node.right)
    )
        nativeAssignments.push(node.getText(indexAst));
    ts.forEachChild(node, collectNative);
}
collectNative(indexAst);
assert.equal(nativeAssignments.length, 2);
const sinkSources = [
    sourceFunction("src/core/index.ts", "stbExit"),
    sourceFunction("src/provider/index.ts", "restart"),
    ...nativeAssignments,
    "export " + sourceFunction("devices/legacy-core.js", "stbExit"),
];
const webosAst = ts.createSourceFile(
    "webos.js",
    fs.readFileSync("devices/lg/webos/device.js", "utf8"),
    ts.ScriptTarget.Latest,
    true
);
sinkSources.push(
    webosAst.statements
        .find(
            (node) =>
                ts.isExpressionStatement(node) &&
                ts.isBinaryExpression(node.expression) &&
                node.expression.left.getText(webosAst) === "window.stbExit"
        )
        .getText(webosAst)
);
for (const [index, source] of sinkSources.entries()) {
    const f = fixture();
    const unexpected = () => f.effects.push("lifecycle");
    f.w.close = unexpected;
    f.w.stbStop = unexpected;
    f.w.setTimeout = unexpected;
    f.w.location = { href: "https://player.example", reload: unexpected };
    f.w.Capacitor = {
        Plugins: {
            App: {
                exitApp: () => {
                    unexpected();
                    return Promise.resolve();
                },
            },
        },
    };
    const api = isolated(source, {
        _baseWebosExit: unexpected,
        _webosBackActive: true,
        _webosBackDepth: 3,
        body_onUnload: unexpected,
        console,
        setCoreDemoMute: unexpected,
        stbStop: unexpected,
        tauriInvoke: () => {
            unexpected();
            return { catch() {} };
        },
        window: f.w,
    });
    f.w.keyHandler = api.stbExit || api.restart || f.w.stbExit;
    f.run("input", { key: "up" }).effect();
    assert.deepEqual(
        f.effects,
        [],
        "actual lifecycle sink " + index + " blocks remote key provenance"
    );
    assert.equal(f.w.__ottRemoteInputActive, undefined);
    f.w.keyHandler();
    assert.ok(
        f.effects.length > 0,
        "local lifecycle sink " + index + " remains functional"
    );
}
{
    const f = fixture();
    f.w.keyHandler = () => {
        assert.equal(f.w.__ottRemoteInputActive, true);
        throw new Error("UI failure");
    };
    assert.throws(f.run("input", { key: "up" }).effect, /UI failure/);
    assert.equal(
        f.w.__ottRemoteInputActive,
        undefined,
        "throw cannot retain remote provenance"
    );
    f.lock(true);
    assert.equal(f.run("input", { key: "menu" }).result.status, "rejected");
    assert.equal(f.run("input", { key: "volume_down" }).result.status, "ok");
}
console.log(
    "PASS real lifecycle sinks: local-only exit confirmation, language cancel, menu restart, Tauri/Capacitor/LG/legacy exit fencing and exception-safe provenance"
);

{
    const f = fixture();
    const owner = { model: {} };
    f.w._ = (value) => value;
    f.w.__ottClassicScreenPort.listOwner = () => owner;
    f.w.showPage = () => {
        f.w.isListVisible = true;
    };
    const manage = indexAst.statements.find(
        (node) =>
            ts.isExpressionStatement(node) &&
            ts.isBinaryExpression(node.expression) &&
            node.expression.left.getText(indexAst) === "window.settingsManage"
    );
    isolated(manage.getText(indexAst), {
        accessMediaPlugin: () => null,
        document: { getElementById: () => null },
        isPlayDistribution: () => false,
        window: f.w,
    });
    f.w.settingsManage();
    assert.equal(
        owner.model.localOnlyInput,
        true,
        "actual Manage settings producer owns local-only admission"
    );
    f.w.__ottClassicScreenPort.screens.current = () => ({ model: {} });
    assert.equal(
        f.run("input", { key: "ok" }).result.status,
        "rejected",
        "a modal confirmation above local-only management cannot be consumed remotely"
    );
}
for (const name of ["exportSettingsUI", "importSettingsUI"]) {
    const f = fixture();
    f.w.exportSettings = f.w.importSettings = () =>
        assert.fail("private settings cannot be transferred remotely");
    const api = isolated(sourceFunction("src/settings/transfer-ui.ts", name), {
        window: f.w,
    });
    f.w.keyHandler = api[name];
    f.run("input", { key: "ok" }).effect();
    assert.equal(f.w.__ottRemoteInputActive, undefined);
}
console.log(
    "PASS private transfer boundaries: real Manage settings owner protects child dialogs and import/export refuse remote initiation"
);

// Execute the real channel admission/playback boundary, not a synthetic key path.
function channelStepFixture() {
    const f = fixture();
    const w = f.w;
    const needs = w.__ottParental.needs;
    f.source = "provider-one";
    f.owner = null;
    f.pinCalls = 0;
    f.channelLocked = false;
    w.__ottSourceIdentity = { current: () => f.source };
    w.__ottCommandChannelLoad = {};
    w.__ottClassicScreenPort.screens.current = () => f.owner;
    w.__ottClassicScreenPort.listOwner = () => f.owner;
    w.__ottParental.needs = (kind) =>
        kind === "channels" ? f.channelLocked : needs(kind);
    Object.assign(w.__ottKiosk, { admit: () => true, allowed: () => true });
    w.channels = {
        1: { channel_name: "Первый", url: "https://private.example/1" },
        2: { channel_name: "Второй", url: "https://private.example/2" },
        3: {
            channel_name: "Outside category",
            url: "https://private.example/3",
        },
        4: { channel_name: "Четвёртый", url: "https://private.example/4" },
    };
    w.cList = [1, 3, 4, 2];
    w.cats = { All: w.cList, Favourites: [2, 1, 4], Other: [3] };
    w.catsArray = ["All", "Favourites", "Other"];
    w.catIndex = 1;
    w.curList = w.cats.Favourites;
    w.primaryIndex = 0;
    w.parentalArray = [];
    w.commandChannelsReady = true;
    w.ifParentalAccessChId = (_id, callback) => {
        f.pinCalls++;
        if (!f.channelLocked) return false;
        f.pinContinuation = callback;
        return true;
    };
    const globals = {
        _: (text) => text,
        checkMedia() {},
        clearTimeout: (timer) => f.effects.push(["clear", timer]),
        closeList() {
            assert.equal(
                w.previewChan,
                null,
                "preview cannot restore the old stream"
            );
            f.effects.push("close-list");
            w.isListVisible = false;
            f.owner = null;
            if (f.onClose) f.onClose();
        },
        console: { log() {} },
        exports: {},
        ifParentalAccessChId: (...args) => w.ifParentalAccessChId(...args),
        infoBox: () =>
            assert.fail("a validated category cannot open an error dialog"),
        playChannel: (...args) => w.playChannel(...args),
        providerGetJson: () => ({}),
        sendClientFeedback: () => assert.fail("no unsolicited error feedback"),
        setCurrent(category, index) {
            f.effects.push(["select", category, index]);
            w.catIndex = category;
            w.curList = w.cats[w.catsArray[category]];
            w.primaryIndex = index;
        },
        setTimeout: () => 1,
        settings: { infoSwitch: false, stopPlay: false },
        showChannelInfo() {},
        stbPlay: (url) => f.effects.push(["play", url]),
        stbStop: () => f.effects.push("stop"),
        updateChannelInfo() {},
        window: w,
    };
    for (const name of [
        "cats",
        "catsArray",
        "channels",
        "curList",
        "primaryIndex",
    ])
        Object.defineProperty(globals, name, { get: () => w[name] });
    vm.runInNewContext(
        ts.transpileModule(
            sourceFunction("src/channels/index.ts", "getChannelUrl") +
                "\n" +
                sourceFunction("src/index.ts", "_playChannel") +
                "\nexports.play = _playChannel;",
            { compilerOptions: { target: ts.ScriptTarget.ES5 } }
        ).outputText,
        globals
    );
    w.playChannel = globals.exports.play;
    f.globals = globals;
    f.played = () => f.effects.filter((effect) => effect[0] === "play");
    f.kind("live");
    // An adjacent live channel does not require a decoder owned by the new backend.
    w.stbPlay = () => {};
    return f;
}

// Use the real list/PiP cleanup: a channel step must not open an unrelated PIN.
{
    const f = channelStepFixture();
    const w = f.w;
    const g = f.globals;
    Object.assign(g, {
        $: () => ({ hide() {}, toggle() {} }),
        cancelMediaLoad() {},
        listElement: null,
    });
    g.console.error = (error) => {
        throw error;
    };
    Object.defineProperty(g, "isListVisible", {
        get: () => w.isListVisible,
        set: (value) => {
            w.isListVisible = value;
        },
    });
    w.__ottClassicScreenPort.closeList = () => {
        f.owner = null;
    };
    vm.runInNewContext(
        ts.transpileModule(
            ["withPipChannelAccess", "playPipChannel", "closeList"]
                .map((name) => sourceFunction("src/ui/index.ts", name))
                .join("\n"),
            { compilerOptions: { target: ts.ScriptTarget.ES5 } }
        ).outputText,
        g
    );
    w.isListVisible = true;
    f.owner = { kind: "list", model: {} };
    w.pipCatIndex = 2;
    w.pipIndex = 0;
    w.stbPlayPip = () =>
        assert.fail("a remote channel step must not restore PiP");
    w.parentalArray = [3];
    f.channelLocked = true;
    w.ifParentalAccessChId = (id, continuation) => {
        f.pinCalls++;
        if (id !== 3) return false;
        f.pinContinuation = continuation;
        return true;
    };
    assert.equal(
        f.run("playback", { operation: "next_channel" }).result.status,
        "ok"
    );
    assert.equal(w.isListVisible, false);
    assert.deepEqual(f.played(), [["play", "https://private.example/1"]]);
    assert.equal(
        f.pinCalls,
        0,
        "closing the real list does not open a PiP PIN"
    );
    assert.equal(f.pinContinuation, undefined);
    g.closeList();
    assert.equal(
        f.pinCalls,
        1,
        "ordinary list close retains its PiP admission"
    );
    assert.equal(typeof f.pinContinuation, "function");
}

for (const [operation, start, expected, number] of [
    ["next_channel", 0, 1, 1],
    ["next_channel", 2, 0, 4],
    ["previous_channel", 0, 2, 3],
    ["previous_channel", 2, 1, 1],
]) {
    const f = channelStepFixture();
    f.w.primaryIndex = start;
    f.w.isListVisible = true;
    f.owner = { kind: "list", model: {} };
    f.w.listCatIndex = 2;
    f.w.listArray = [3];
    f.w.selIndex = 0;
    f.w.previewChan = { ch_id: 3 };
    f.w.previewTimer = 123;
    assert.deepEqual(f.run("capabilities").result.data.playback, [
        "previous_channel",
        "next_channel",
        "step_channel",
    ]);
    assert.deepEqual(
        f.effects,
        [],
        "capability reads have no playback/UI effects"
    );
    const pending = f.run("playback", { operation });
    const id = f.w.curList[expected];
    assert.deepEqual(pending.result, {
        data: {
            channel: { id, name: f.w.channels[id].channel_name, number },
            dispatched: true,
            operation,
        },
        status: "ok",
    });
    assert.equal(
        pending.effect,
        undefined,
        "relative steps are not replayed after ACK"
    );
    assert.equal(f.w.primaryIndex, expected);
    assert.equal(
        f.w.catIndex,
        1,
        "browsing another category does not select its order"
    );
    assert.equal(f.w.isListVisible, false);
    assert.ok(f.effects.includes("close-list"));
    assert.deepEqual(f.played(), [["play", "https://private.example/" + id]]);
    assert.equal(
        f.pinCalls,
        0,
        "remote admission cannot enqueue a PIN callback"
    );
    assert.ok(!JSON.stringify(pending.result).includes("private.example"));
}

for (const [name, mutate] of Object.entries({
    "changed active list": (f) => (f.w.curList = [2, 1]),
    "empty category": (f) => f.w.curList.splice(0),
    "empty channel name": (f) => (f.w.channels[1].channel_name = " "),
    "infinite category": (f) => (f.w.catIndex = Infinity),
    "invalid target ID": (f) => (f.w.curList[1] = {}),
    "invalid Unicode name": (f) => (f.w.channels[1].channel_name = "\ud800"),
    kiosk: (f) => f.kiosk(true),
    "local-only list": (f) =>
        (f.owner = { kind: "list", model: { localOnlyInput: true } }),
    "missing current channel": (f) => delete f.w.channels[2],
    "missing full catalogue target": (f) => (f.w.cList = [2, 3]),
    "missing parental policy": (f) => delete f.w.parentalArray,
    "missing target channel": (f) => delete f.w.channels[1],
    "modal confirmation": (f) => (f.owner = { kind: "dialog", model: {} }),
    "NaN current index": (f) => (f.w.primaryIndex = NaN),
    "negative current index": (f) => (f.w.primaryIndex = -1),
    "out-of-range current index": (f) => (f.w.primaryIndex = 3),
    "PIN or support screen": (f) => f.protect(true),
    "protected target": (f) => {
        f.channelLocked = true;
        f.w.parentalArray = [1];
    },
    "settings lock": (f) => f.lock(true),
    standby: (f) => (f.w.stbIsStandby = () => true),
    "text editor": (f) => (f.owner = { kind: "editor", model: {} }),
    "unready catalogue": (f) => (f.w.commandChannelsReady = false),
})) {
    for (const params of [
        { operation: "next_channel" },
        { offset: 1, operation: "step_channel" },
    ]) {
        const f = channelStepFixture();
        mutate(f);
        assert.ok(
            !f
                .run("capabilities")
                .result.data.playback.includes("next_channel"),
            name + " is not advertised"
        );
        // Arbitrary offsets share readiness guards, but a bad adjacent target
        // cannot hide the operation: another requested destination may be valid.
        assert.equal(
            f.run("capabilities").result.data.playback.includes("step_channel"),
            [
                "empty channel name",
                "invalid target ID",
                "invalid Unicode name",
                "missing full catalogue target",
                "missing target channel",
                "protected target",
            ].includes(name),
            name + " has the expected arbitrary-offset capability"
        );
        assert.equal(f.run("playback", params).result.status, "rejected", name);
        assert.deepEqual(f.effects, [], name + " has no UI/playback effects");
        assert.equal(
            f.pinCalls,
            0,
            name + " does not queue a delayed PIN continuation"
        );
    }
}

for (const mutate of [
    (f) => (f.source = "provider-two"),
    (f) => (f.w.__ottCommandChannelLoad = {}),
    (f) => (f.w.primaryIndex = 1),
    (f) => (f.w.curList[1] = 3),
    (f) => f.w.curList.push(3),
    (f) => f.w.cList.reverse(),
    (f) => f.lock(true),
    (f) => f.kiosk(true),
    (f) => f.protect(true),
    (f) => {
        f.channelLocked = true;
        f.w.parentalArray = [1];
    },
]) {
    for (const params of [
        { operation: "next_channel" },
        { offset: -2, operation: "step_channel" },
    ]) {
        const f = channelStepFixture();
        f.w.isListVisible = true;
        f.owner = { kind: "list", model: {} };
        f.w.previewChan = { ch_id: 3 };
        f.onClose = () => mutate(f);
        assert.equal(f.run("playback", params).result.status, "rejected");
        assert.deepEqual(
            f.played(),
            [],
            "UI cleanup cannot redirect a bound channel step"
        );
        assert.equal(f.pinCalls, 0);
        assert.equal(f.pinContinuation, undefined);
    }
}

{
    const f = channelStepFixture();
    f.w.curList.splice(1);
    assert.equal(
        f.run("playback", { operation: "previous_channel" }).result.status,
        "ok"
    );
    assert.deepEqual(
        f.played(),
        [["play", "https://private.example/2"]],
        "one-channel category wraps to itself"
    );
}
{
    const f = channelStepFixture();
    for (const params of [
        { operation: "next_channel", position: 0 },
        { operation: "previous_channel", position: undefined },
        { count: 2, operation: "next_channel" },
        { offset: 1, operation: "next_channel" },
        { offset: undefined, operation: "previous_channel" },
    ])
        assert.equal(f.run("playback", params).result.status, "rejected");
    assert.deepEqual(f.effects, []);
    f.channelLocked = true;
    f.w.playChannel(1, 1, true);
    assert.equal(
        f.pinCalls,
        1,
        "ordinary playback retains its PIN prompt flow"
    );
    assert.equal(typeof f.pinContinuation, "function");
    f.channelLocked = false;
    f.pinContinuation();
    assert.deepEqual(f.played(), [["play", "https://private.example/1"]]);
}
console.log(
    "PASS adjacent channels: real playback admission, category order/wrap, list/preview close, modal/PIN/kiosk guards and stale cleanup fencing"
);

function hundredChannelFixture(start) {
    const f = channelStepFixture();
    const list = Array.from({ length: 100 }, (_, index) => index + 1);
    f.w.channels = {};
    for (const id of [...list, 101])
        f.w.channels[id] = {
            channel_name: "Channel " + id,
            url: "https://private.example/" + id,
        };
    f.w.cList = [...list, 101];
    f.w.cats = { All: f.w.cList, Favourites: list, Other: [101] };
    f.w.curList = list;
    f.w.primaryIndex = start - 1;
    return f;
}

// Exact numeric expectations also catch precision loss before the modulo.
for (const [start, offset, id] of [
    [100, 15, 15],
    [1, -15, 86],
    [5, -15, 90],
    [100, 115, 15],
    [1, -115, 86],
    [100, 9007199254740991, 91],
    [100, -9007199254740991, 9],
    [5, 100, 5],
    [5, -100, 5],
]) {
    const f = hundredChannelFixture(start);
    f.w.isListVisible = true;
    f.owner = { kind: "list", model: {} };
    f.w.listCatIndex = 2;
    f.w.listArray = [101];
    f.w.previewChan = { ch_id: 101 };
    const pending = f.run("playback", { offset, operation: "step_channel" });
    assert.deepEqual(pending.result, {
        data: {
            channel: { id, name: "Channel " + id, number: id },
            dispatched: true,
            offset,
            operation: "step_channel",
        },
        status: "ok",
    });
    assert.equal(pending.effect, undefined);
    assert.equal(f.w.catIndex, 1);
    assert.equal(f.w.primaryIndex, id - 1);
    assert.equal(f.w.isListVisible, false);
    assert.equal(f.w.previewChan, null);
    assert.deepEqual(f.played(), [["play", "https://private.example/" + id]]);
    assert.equal(
        f.effects.filter((effect) => effect[0] === "select").length,
        1
    );
    assert.equal(f.pinCalls, 0);
    assert.ok(!JSON.stringify(pending.result).includes("private.example"));
}

// Favourites order differs from global catalogue numbering.
{
    const f = channelStepFixture();
    const result = f.run("playback", { offset: 2, operation: "step_channel" });
    assert.deepEqual(result.result.data.channel, {
        id: 4,
        name: "Четвёртый",
        number: 3,
    });
    assert.deepEqual(f.played(), [["play", "https://private.example/4"]]);
}

// A generic capability promises valid selection state, not a PIN-free neighbour.
{
    const f = hundredChannelFixture(5);
    f.channelLocked = true;
    f.w.parentalArray = [4, 5, 6];
    assert.deepEqual(f.run("capabilities").result.data.playback, [
        "step_channel",
    ]);
    assert.deepEqual(f.effects, []);
    assert.equal(
        f.run("playback", { offset: 15, operation: "step_channel" }).result
            .status,
        "ok"
    );
    assert.deepEqual(f.played(), [["play", "https://private.example/20"]]);
    assert.equal(f.pinCalls, 0);
}
{
    const f = hundredChannelFixture(5);
    f.channelLocked = true;
    f.w.parentalArray = [20];
    assert.ok(
        f.run("capabilities").result.data.playback.includes("step_channel")
    );
    assert.equal(
        f.run("playback", { offset: 15, operation: "step_channel" }).result
            .status,
        "rejected"
    );
    assert.deepEqual(f.effects, []);
    assert.equal(f.pinCalls, 0);
}
{
    const f = channelStepFixture();
    f.w.curList.splice(1);
    assert.equal(
        f.run("playback", {
            offset: -9007199254740991,
            operation: "step_channel",
        }).result.status,
        "ok"
    );
    assert.deepEqual(f.played(), [["play", "https://private.example/2"]]);
}
{
    const f = channelStepFixture();
    for (const offset of [
        undefined,
        null,
        true,
        false,
        "15",
        0,
        -0,
        0.5,
        -1.5,
        NaN,
        Infinity,
        -Infinity,
        9007199254740992,
        -9007199254740992,
    ])
        assert.equal(
            f.run("playback", { offset, operation: "step_channel" }).result
                .status,
            "rejected"
        );
    for (const params of [
        { operation: "step_channel" },
        { offset: 15, operation: "step_channel", position: 0 },
        { count: 1, offset: 15, operation: "step_channel" },
        { offset: 15, operation: "pause" },
        { offset: undefined, operation: "resume" },
        { offset: 1, operation: "seek", position: 1 },
    ])
        assert.equal(f.run("playback", params).result.status, "rejected");
    assert.deepEqual(f.effects, []);
    assert.equal(f.pinCalls, 0);
}
console.log(
    "PASS channel offsets: exact safe integers, positive/negative wrap, one selection, bounded receipt, target PIN and shared stale-state guards"
);

for (const mode of ["lock", "kiosk"]) {
    const f = fixture();
    f[mode](true);
    for (const operation of ["standby", "wake"]) {
        assert.equal(
            doctorCapabilities(f.w).find((x) => x.name === operation).state,
            "available"
        );
        const request = f.run("lifecycle", { operation });
        assert.equal(request.result.status, "ok", mode + " " + operation);
        request.effect();
    }
    assert.equal(
        f.run("lifecycle", { operation: "exit_app" }).result.status,
        "rejected"
    );
}
