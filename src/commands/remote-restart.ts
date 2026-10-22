import type {
    DoctorCapability,
    DoctorCapabilityName,
    DoctorCapabilityReason,
} from "../plugins/remote-doctor";
import { remoteAppUpdateAvailable } from "./remote-app-update";
import { remoteFavoritesCapability } from "./remote-favorites-contract";
import { remotePlexQueue } from "./remote-plex";

function remoteSettingsLocked(w: any): boolean {
    return w.__ottParental
        ? w.__ottParental.needs("providers") ||
              w.__ottParental.needs("settings")
        : !!(
              (w.sPSprovs || w.sPSoptions) &&
              w.parentPIN !== "*" &&
              !w.parentAccess
          );
}
function remoteCheckpoint(w: any): void {
    var playback = w.__ottClassicPlayback;
    if (!playback || !playback.snapshot || !playback.checkpoint) return;
    if (
        w.__ottCoreTransport &&
        w.stbPlay === w.__ottCoreTransport.play &&
        typeof w.__ottCoreBackend === "function"
    ) {
        var backend = w.__ottCoreBackend();
        var handle = backend && backend.current();
        if (handle && handle.active()) handle.sample();
    }
    playback.checkpoint(playback.snapshot(), true);
}

/** Restart the owned decoder, or acknowledge a page reload before dispatching it. */
export function executeRemoteRestart(
    w: any,
    params: any,
    done: (result: any) => void,
    afterReply?: (effect: () => void) => void
): void {
    function fail(status: string, message: string): void {
        done({ data: { error: message }, status: status });
    }
    if (
        !params ||
        typeof params !== "object" ||
        Array.isArray(params) ||
        Object.keys(params).some(function (key) {
            return key !== "target";
        }) ||
        (params.target !== undefined &&
            params.target !== "stream" &&
            params.target !== "player")
    ) {
        fail("rejected", "Use restart target stream or player.");
        return;
    }
    function locked(): boolean {
        return remoteSettingsLocked(w);
    }
    var target = params.target || "stream";
    var managed =
        w.__ottCoreTransport && w.stbPlay === w.__ottCoreTransport.play;
    if (target === "stream") {
        if (!managed || typeof w.__ottCoreBackend !== "function") {
            fail(
                "unsupported",
                "Stream restart is unavailable on this player."
            );
            return;
        }
        var backend = w.__ottCoreBackend();
        var result = backend && backend.restart && backend.restart();
        if (!result) {
            done({
                data: {
                    error: "There is no owned, restartable stream.",
                    reason: "no_restartable_stream",
                },
                status: "rejected",
            });
            return;
        }
        done({ data: result, status: "ok" });
        return;
    }
    if (locked()) {
        fail(
            "rejected",
            "Unlock player settings before restarting the player."
        );
        return;
    }
    if (!afterReply || typeof w.restart !== "function") {
        fail(
            "unsupported",
            "Player restart requires acknowledged command delivery."
        );
        return;
    }
    var restart = w.restart;
    afterReply(function () {
        // Settings can change while the response is awaiting its server ACK.
        if (locked() || w.restart !== restart) return;
        remoteCheckpoint(w);
        if (!locked() && w.restart === restart) restart.call(w);
    });
    done({
        data: {
            accepted: true,
            dispatched: false,
            effect: "reload-after-ack",
            target: "player",
        },
        status: "ok",
    });
}

// Public page identity: useful for observing a reload, never an authorization token.
var remoteRuntime =
    Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
export function remotePlayerInfo(w: any): any {
    var platform = w.__ottRemoteLifecycle && w.__ottRemoteLifecycle.platform;
    return {
        platform:
            typeof platform === "string" && /^[a-z0-9_-]{1,32}$/.test(platform)
                ? platform
                : "browser",
        runtime: remoteRuntime,
        standby: typeof w.stbIsStandby === "function" && !!w.stbIsStandby(),
        ...(w.__ottStandby ? { background: w.__ottStandby.snapshot() } : {}),
        version: "__OTTP_VERSION__",
    };
}

var remoteKeys: { [key: string]: string[] } = {
    aspect: ["ASPECT", "aspect"],
    audio: ["AUDIO", "audio"],
    back: ["RETURN", "back"],
    channel_down: ["CH_DOWN", "channel-down"],
    channel_up: ["CH_UP", "channel-up"],
    channels: ["CH_LIST", "channels"],
    down: ["DOWN", "down"],
    fullscreen: ["SUBTITLE", "subtitle"],
    guide: ["EPG", "guide"],
    info: ["INFO", "info"],
    left: ["LEFT", "left"],
    menu: ["MENU", "menu"],
    mute: ["MUTE", "mute"],
    ok: ["ENTER", "accept"],
    pip: ["PIP", "picture-in-picture"],
    play_pause: ["PLAY", "play"],
    right: ["RIGHT", "right"],
    settings: ["SETUP", "settings"],
    up: ["UP", "up"],
    volume_down: ["VOL_DOWN", "volume-down"],
    volume_up: ["VOL_UP", "volume-up"],
    zoom: ["ZOOM", "zoom"],
};
var remoteLifecycleMethods: { [operation: string]: string } = {
    exit_app: "exit",
    reboot_device: "reboot",
    restart_app: "restart",
};
function remoteKiosk(w: any): boolean {
    return !!(w.__ottKiosk && w.__ottKiosk.enabled());
}
function remoteProtectedInput(w: any): boolean {
    // These application-owned surfaces require local input, even after a PIN grant.
    try {
        var port = w.__ottClassicScreenPort;
        var owner = port && port.screens && port.screens.current();
        if (owner && owner.model && owner.model.localOnlyInput) return true;
        var list = port && port.listOwner && port.listOwner();
        if (list && list.model && list.model.localOnlyInput) return true;
        if (
            w.$ &&
            w
                .$(
                    "#pin, #remoteDiagnosticsToggle, #remoteDiagnosticsTrust, #remoteScreenshotToggle"
                )
                .is(":visible")
        )
            return true;
        return !!(
            w.isListVisible &&
            (w.listArray || []).some(function (row: any) {
                return (
                    row &&
                    (row.editorAction === "parentalEnabled" ||
                        /^(psChannels|psOptions|requirePinForProviderSelection)$/.test(
                            row.settingId
                        ))
                );
            })
        );
    } catch (_) {
        return true;
    }
}
function remoteInputCode(w: any, key: string): number {
    if (
        !Object.prototype.hasOwnProperty.call(remoteKeys, key) ||
        typeof w.keyHandler !== "function" ||
        !w.keys ||
        !w.__ottClassicScreenPort ||
        typeof w.__ottClassicScreenPort.normalize !== "function"
    )
        return 0;
    var pair = remoteKeys[key];
    // Android names its physical menu key TOOLS; both open the player menu.
    var menuAlias = key === "menu" && !w.keys.MENU;
    var code = w.keys[menuAlias ? "TOOLS" : pair[0]];
    if (typeof code !== "number" || !isFinite(code) || code <= 0) return 0;
    var mapped =
        w.__ottDevice && w.__ottDevice.eventToKeyCode
            ? w.__ottDevice.eventToKeyCode({ keyCode: code, which: code })
            : code;
    // Hardware key aliases can collide (for example AUDIO and STOP on a PC).
    if (
        w.__ottClassicScreenPort.normalize(mapped).id !==
        (menuAlias ? "tools" : pair[1])
    )
        return 0;
    if (key === "fullscreen" && w.__ottClassicScreenPort.screens.current())
        return 0;
    return code;
}
function remoteInputAllowed(w: any, key: string): boolean {
    if (remoteProtectedInput(w)) return false;
    return (
        (!remoteKiosk(w) && !remoteSettingsLocked(w)) ||
        /^(volume_up|volume_down|mute)$/.test(key)
    );
}
function remoteChannelStepAllowed(w: any): boolean {
    if (remoteProtectedInput(w) || remoteKiosk(w) || remoteSettingsLocked(w))
        return false;
    if (typeof w.stbIsStandby === "function" && w.stbIsStandby()) return false;
    var port = w.__ottClassicScreenPort;
    if (!port || !port.screens || typeof port.screens.current !== "function")
        return false;
    var owner = port.screens.current();
    // A channel change must not answer, dismiss or bypass a modal interaction.
    if (owner && owner.kind !== "list") return false;
    return !(
        w.$ && w.$("#dialogbox, #listAbout, #listEdit, #numprog").is(":visible")
    );
}

/** Bind relative movement to the playing category, never the browsing cursor. */
function remoteChannelStep(w: any, offset: number, probe?: boolean): any {
    try {
        var list = w.curList;
        var category = w.catIndex;
        var position = w.primaryIndex;
        var categories = w.catsArray;
        var groups = w.cats;
        var channels = w.channels;
        var catalogue = w.cList || list;
        var identity = w.__ottSourceIdentity;
        var play = w.playChannel;
        if (
            !remoteChannelStepAllowed(w) ||
            w.commandChannelsReady !== true ||
            !Array.isArray(list) ||
            !list.length ||
            !Array.isArray(categories) ||
            typeof category !== "number" ||
            !isFinite(category) ||
            category % 1 ||
            category < 0 ||
            category >= categories.length ||
            !groups ||
            groups[categories[category]] !== list ||
            typeof position !== "number" ||
            !isFinite(position) ||
            position % 1 ||
            position < 0 ||
            position >= list.length ||
            !channels ||
            !channels[list[position]] ||
            !Array.isArray(catalogue) ||
            !Array.isArray(w.parentalArray) ||
            !w.__ottParental ||
            typeof w.__ottParental.needs !== "function" ||
            typeof w.ifParentalAccessChId !== "function" ||
            !identity ||
            typeof identity.current !== "function" ||
            typeof play !== "function"
        )
            return null;
        // Capabilities inspect only shared selection readiness. No destination
        // or full-catalogue scan is needed for an arbitrary future offset.
        if (probe) return true;
        // Reduce first: adding a safe-integer offset to the cursor can overflow.
        var index =
            (position + (offset % list.length) + list.length) % list.length;
        var id = list[index];
        var row = channels[id];
        var validId =
            (typeof id === "string" && id.trim() && id.length <= 512) ||
            (typeof id === "number" &&
                isFinite(id) &&
                id % 1 === 0 &&
                Math.abs(id) <= 9007199254740991);
        if (
            !validId ||
            !row ||
            typeof row.channel_name !== "string" ||
            !row.channel_name.trim() ||
            row.channel_name.length > 16384
        )
            return null;
        // Reject malformed Unicode before dispatching a receipt the CLI cannot read.
        encodeURIComponent(String(id));
        encodeURIComponent(row.channel_name);
        var seen: Record<string, boolean> = Object.create(null);
        var number = 0;
        var selectedNumber = 0;
        catalogue.forEach(function (value: any) {
            if (seen[String(value)] || !channels[value]) return;
            seen[String(value)] = true;
            number++;
            if (String(value) === String(id)) selectedNumber = number;
        });
        if (!selectedNumber) return null;
        var source = identity.current(w);
        var load = w.__ottCommandChannelLoad;
        var oldId = list[position];
        var oldRow = channels[oldId];
        var listOrder = list.slice();
        var name = row.channel_name;
        var order = catalogue.slice();
        var categoryName = categories[category];
        var current = function (): boolean {
            try {
                // Admission is read-only: never queue a PIN continuation for a step.
                if (
                    !remoteChannelStepAllowed(w) ||
                    !Array.isArray(w.parentalArray) ||
                    !w.__ottParental ||
                    (w.parentalArray.some(function (value: any) {
                        return String(value) === String(id);
                    }) &&
                        w.__ottParental.needs("channels")) ||
                    identity.current(w) !== source
                )
                    return false;
                return (
                    w.commandChannelsReady === true &&
                    w.__ottCommandChannelLoad === load &&
                    w.__ottSourceIdentity === identity &&
                    w.playChannel === play &&
                    w.curList === list &&
                    w.cats === groups &&
                    w.catsArray === categories &&
                    categories[category] === categoryName &&
                    groups[categoryName] === list &&
                    w.catIndex === category &&
                    w.primaryIndex === position &&
                    list[position] === oldId &&
                    list[index] === id &&
                    list.length === listOrder.length &&
                    listOrder.every(function (value: any, at: number) {
                        return list[at] === value;
                    }) &&
                    w.channels === channels &&
                    channels[oldId] === oldRow &&
                    channels[id] === row &&
                    row.channel_name === name &&
                    (w.cList || w.curList) === catalogue &&
                    catalogue.length === order.length &&
                    order.every(function (value: any, at: number) {
                        return catalogue[at] === value;
                    })
                );
            } catch (_) {
                return false;
            }
        };
        return current()
            ? {
                  category: category,
                  channel: { id: id, name: name, number: selectedNumber },
                  current: current,
                  index: index,
                  play: play,
              }
            : null;
    } catch (_) {
        return null;
    }
}
function remotePlaybackProbe(w: any, readonly = false): any {
    if (!w.__ottCoreTransport || w.stbPlay !== w.__ottCoreTransport.play)
        return { owned: null, reason: "not_implemented" };
    var getBackend = readonly ? w.__ottCoreBackendPeek : w.__ottCoreBackend;
    if (
        typeof getBackend !== "function" ||
        !w.__ottClassicPlayback ||
        typeof w.__ottClassicPlayback.snapshot !== "function"
    )
        return { owned: null, reason: "producer_unavailable" };
    var backend = getBackend.call(w);
    if (!backend) return { owned: null, reason: "no_active_media" };
    if (typeof backend.current !== "function")
        return { owned: null, reason: "producer_unavailable" };
    var handle = backend.current();
    if (!handle) return { owned: null, reason: "no_active_media" };
    if (
        typeof handle.active !== "function" ||
        typeof handle.snapshot !== "function"
    )
        return { owned: null, reason: "producer_unavailable" };
    if (!handle.active()) return { owned: null, reason: "no_active_media" };
    var state = w.__ottClassicPlayback.snapshot();
    if (!state || !state.target)
        return { owned: null, reason: "no_active_media" };
    if (["live", "vod", "archive"].indexOf(state.target.kind) < 0)
        return { owned: null, reason: "current_state_unsupported" };
    var snapshot = handle.snapshot();
    return {
        owned: {
            backend: backend,
            handle: handle,
            kind: state.target.kind,
            phase: snapshot && snapshot.phase,
        },
        reason: "ready",
    };
}
function remoteOwnedPlayback(w: any, readonly = false): any {
    var owned = remotePlaybackProbe(w, readonly).owned;
    return owned && ["playing", "paused"].indexOf(owned.phase) >= 0
        ? owned
        : null;
}
function remoteCapability(
    name: DoctorCapabilityName,
    reason: DoctorCapabilityReason
): DoctorCapability {
    return {
        name: name,
        reason: reason,
        state:
            reason === "ready"
                ? "available"
                : reason === "producer_unavailable"
                  ? "unknown"
                  : "unavailable",
    };
}
function remoteLifecycleCapability(
    w: any,
    operation: DoctorCapabilityName,
    readonly = false
): DoctorCapability {
    function result(reason: DoctorCapabilityReason): DoctorCapability {
        return remoteCapability(operation, reason);
    }
    if (operation === "restart_stream") {
        var probe = remotePlaybackProbe(w, readonly);
        var owned = probe.owned;
        if (!owned) return result(probe.reason);
        if (typeof owned.backend.restart !== "function")
            return result("not_implemented");
        // Live repair can be attempted while loading or recovering from error.
        // The backend still validates engine readiness and ownership at dispatch.
        var phases =
            owned.kind === "live"
                ? ["loading", "playing", "paused", "error", "ended"]
                : ["playing", "paused"];
        return result(
            phases.indexOf(owned.phase) >= 0
                ? "ready"
                : "current_state_unsupported"
        );
    }
    if (operation === "standby" || operation === "wake")
        return result(
            typeof w.stbToggleStandby === "function" &&
                typeof w.stbIsStandby === "function"
                ? "ready"
                : "not_implemented"
        );
    if (remoteSettingsLocked(w)) return result("policy_restricted");
    if (operation === "reload_player")
        return result(
            typeof w.restart === "function" ? "ready" : "not_implemented"
        );
    if (remoteKiosk(w)) return result("policy_restricted");
    var hooks = w.__ottRemoteLifecycle;
    return result(
        hooks &&
            Object.prototype.hasOwnProperty.call(
                remoteLifecycleMethods,
                operation
            ) &&
            typeof hooks[remoteLifecycleMethods[operation]] === "function"
            ? "ready"
            : "not_implemented"
    );
}

/** Shared predicates, read-only producers, no backend creation or native probes. */
export function remoteDoctorCapabilities(w: any): DoctorCapability[] {
    var names: DoctorCapabilityName[] = [
        "screenshot",
        "diagnostics",
        "input",
        "restart_stream",
        "reload_player",
        "restart_app",
        "exit_app",
        "reboot_device",
        "standby",
        "wake",
    ];
    return names.map(function (name): DoctorCapability {
        try {
            if (name === "screenshot") {
                var hook = w.__ottRemoteScreenshot;
                if (!hook || typeof hook.peek !== "function")
                    return remoteCapability(name, "producer_unavailable");
                var shot = hook.peek();
                if (!shot || typeof shot.connected !== "boolean")
                    return remoteCapability(name, "producer_unavailable");
                if (!shot.connected)
                    return remoteCapability(name, "remote_disconnected");
                if (shot.known !== true)
                    return remoteCapability(name, "producer_unavailable");
                if (shot.supported === false)
                    return remoteCapability(name, "not_implemented");
                if (shot.busy === true) return remoteCapability(name, "busy");
                if (shot.ready === true) return remoteCapability(name, "ready");
                return remoteCapability(
                    name,
                    shot.needsSourceSelection === true
                        ? "source_selection_required"
                        : "producer_unavailable"
                );
            }
            if (name === "diagnostics") {
                var diagnostics = w.__ottRemoteDiagnostics;
                if (!diagnostics || typeof diagnostics.status !== "function")
                    return remoteCapability(name, "producer_unavailable");
                var status = diagnostics.status();
                if (!status || typeof status.trusted !== "boolean")
                    return remoteCapability(name, "producer_unavailable");
                if (!status.trusted)
                    return remoteCapability(name, "remote_disconnected");
                if (status.state === "unavailable")
                    return remoteCapability(name, "current_state_unsupported");
                if (
                    status.enabled === true &&
                    (status.state === "ready" || status.state === "active") &&
                    typeof status.runtimeId === "string" &&
                    status.runtimeId.length > 0
                )
                    return remoteCapability(name, "ready");
                return remoteCapability(name, "producer_unavailable");
            }
            if (name === "input") {
                if (
                    typeof w.keyHandler !== "function" ||
                    !w.keys ||
                    !w.__ottClassicScreenPort ||
                    typeof w.__ottClassicScreenPort.normalize !== "function"
                )
                    return remoteCapability(name, "producer_unavailable");
                var keys = Object.keys(remoteKeys);
                var supported = false;
                for (var i = 0; i < keys.length; i++) {
                    if (!remoteInputCode(w, keys[i])) continue;
                    supported = true;
                    if (remoteInputAllowed(w, keys[i]))
                        return remoteCapability(name, "ready");
                }
                return remoteCapability(
                    name,
                    supported
                        ? "policy_restricted"
                        : "current_state_unsupported"
                );
            }
            return remoteLifecycleCapability(w, name, true);
        } catch (_) {
            return remoteCapability(name, "producer_unavailable");
        }
    });
}

function remoteScreenshotSnapshot(w: any): any {
    var fallback = { source: null, state: "unsupported" };
    try {
        var hook = w.__ottRemoteScreenshot;
        if (!hook || typeof hook.peek !== "function") return fallback;
        var view = hook.peek();
        var source = view && view.source;
        var state = view && view.state;
        if (
            ["ready", "permission_required", "unsupported"].indexOf(state) <
                0 ||
            (source !== null &&
                [
                    "player-view",
                    "player-window",
                    "browser-tab",
                    "window",
                    "display",
                ].indexOf(source) < 0) ||
            (state === "ready" && source === null)
        )
            return fallback;
        return { source: source, state: state };
    } catch (_) {
        return fallback;
    }
}

function remoteAspectTarget(w: any): any {
    try {
        if (typeof w.captureAspectTarget !== "function") return null;
        var target = w.captureAspectTarget();
        return target &&
            (target.mode === "fit" || target.mode === "fill") &&
            (target.savedMode === null ||
                target.savedMode === "fit" ||
                target.savedMode === "fill") &&
            typeof target.current === "function" &&
            typeof target.set === "function" &&
            target.current()
            ? target
            : null;
    } catch (_) {
        return null;
    }
}
function remoteAspectAllowed(w: any): boolean {
    try {
        return (
            !remoteProtectedInput(w) &&
            !remoteKiosk(w) &&
            !remoteSettingsLocked(w)
        );
    } catch (_) {
        return false;
    }
}
function remoteAspectCapabilities(w: any): any {
    var target = remoteAspectTarget(w);
    return {
        modes: target ? ["fit", "fill"] : [],
        operations: target
            ? remoteAspectAllowed(w)
                ? ["get", "set"]
                : ["get"]
            : [],
        version: 1,
    };
}

/** Typed, bounded controls share the command transport's exact-result ACK fence. */
export function executeRemoteControl(
    w: any,
    action: string,
    params: any,
    done: (result: any) => void,
    afterReply?: (effect: () => void) => void,
    expiresAt?: number
): (() => void) | void {
    function fail(status: string, error: string): void {
        done({ data: { error: error }, status: status });
    }
    function reply(data: any): void {
        done({ data: data, status: "ok" });
    }
    var fields =
        action === "lifecycle"
            ? ["operation"]
            : action === "input"
              ? ["key"]
              : action === "playback"
                ? ["operation", "position", "offset"]
                : action === "aspect"
                  ? ["operation", "runtime", "mode"]
                  : [];
    if (
        !params ||
        typeof params !== "object" ||
        Array.isArray(params) ||
        Object.keys(params).some(function (key) {
            return fields.indexOf(key) < 0;
        })
    ) {
        fail("rejected", "Invalid control parameters.");
        return;
    }
    if (action === "aspect") {
        var runtime = remotePlayerInfo(w).runtime;
        var setting = params.operation === "set";
        var aspectFail = function (status: string, code: string): void {
            var data: any = {
                error: code,
                operation: params.operation,
                runtime: runtime,
                version: 1,
            };
            if (setting) data.mode = params.mode;
            done({ data: data, status: status });
        };
        if (
            (params.operation !== "get" && !setting) ||
            Object.keys(params).sort().join(",") !==
                (setting ? "mode,operation,runtime" : "operation,runtime") ||
            typeof params.runtime !== "string" ||
            !/^[a-z0-9-]{1,64}$/.test(params.runtime) ||
            (setting && params.mode !== "fit" && params.mode !== "fill")
        ) {
            fail(
                "rejected",
                "Use aspect get or set for the current player runtime."
            );
            return;
        }
        if (params.runtime !== runtime) {
            aspectFail("rejected", "runtime_mismatch");
            return;
        }
        if (setting && !remoteAspectAllowed(w)) {
            aspectFail("rejected", "restricted");
            return;
        }
        var target = remoteAspectTarget(w);
        if (!target || (setting && !afterReply)) {
            aspectFail("unsupported", "unsupported");
            return;
        }
        if (!setting) {
            reply({
                mode: target.mode,
                operation: "get",
                persisted:
                    target.savedMode !== null &&
                    target.savedMode === target.mode,
                runtime: runtime,
                saved_mode: target.savedMode,
                version: 1,
            });
            return;
        }
        var capture = w.captureAspectTarget;
        var mode = params.mode;
        var consumed = false;
        afterReply!(function (): boolean {
            if (consumed) return false;
            consumed = true;
            try {
                if (
                    w.captureAspectTarget === capture &&
                    remotePlayerInfo(w).runtime === runtime &&
                    remoteAspectAllowed(w) &&
                    target.current()
                )
                    return target.set(mode) === true;
            } catch (_) {}
            return false;
        });
        reply({
            accepted: true,
            dispatched: false,
            effect: "aspect-after-ack",
            mode: mode,
            operation: "set",
            runtime: runtime,
            version: 1,
        });
        return;
    }
    var hooks = w.__ottRemoteLifecycle;
    var owned = remoteOwnedPlayback(w, action === "capabilities");
    function lifecycleAvailable(operation: string): boolean {
        return (
            remoteLifecycleCapability(
                w,
                operation as DoctorCapabilityName,
                action === "capabilities"
            ).state === "available"
        );
    }
    var playback =
        owned && owned.kind !== "live" && !remoteKiosk(w)
            ? ["pause", "resume"].concat(owned.kind === "vod" ? ["seek"] : [])
            : [];
    if (action === "capabilities") {
        var plexQueue = remotePlexQueue(w, remotePlayerInfo(w).runtime);
        if (plexQueue.retained() || remoteChannelStep(w, -1))
            playback.push("previous_channel");
        if (plexQueue.retained() || remoteChannelStep(w, 1))
            playback.push("next_channel");
        // Generic availability describes the selection state, not the PIN
        // policy of either neighbour. Every requested destination is checked.
        if (remoteChannelStep(w, 0, true)) playback.push("step_channel");
        reply({
            app_update: remoteAppUpdateAvailable(w)
                ? { operations: ["status", "prepare", "install"], version: 1 }
                : null,
            aspect: remoteAspectCapabilities(w),
            debug: w.__ottRuntimeDebug ? { version: 1 } : undefined,
            debug_versions: w.__ottRuntimeDebug ? [1, 2] : undefined,
            favorites: remoteFavoritesCapability,
            input: Object.keys(remoteKeys).filter(function (key) {
                return remoteInputAllowed(w, key) && !!remoteInputCode(w, key);
            }),
            inspect: {
                sections: ["doctor", "snapshot", "operation"],
                version: 1,
            },
            lifecycle: [
                "restart_stream",
                "reload_player",
                "restart_app",
                "standby",
                "wake",
                "exit_app",
                "reboot_device",
            ].filter(lifecycleAvailable),
            offline_profiles: w.__ottOfflineProfiles
                ? w.__ottOfflineProfiles.capabilities()
                : null,
            playback: playback,
            player: remotePlayerInfo(w),
            plex_library: plexQueue.libraryCapability,
            plex_queue: plexQueue.capability,
            screenshot: remoteScreenshotSnapshot(w),
            version: 1,
        });
        return;
    }
    if (action === "playback") {
        var operation = params.operation;
        var relative = operation === "step_channel";
        if (
            operation === "previous_channel" ||
            operation === "next_channel" ||
            relative
        ) {
            if (
                relative
                    ? Object.keys(params).length !== 2 ||
                      typeof params.offset !== "number" ||
                      !isFinite(params.offset) ||
                      params.offset % 1 !== 0 ||
                      params.offset === 0 ||
                      Math.abs(params.offset) > 9007199254740991
                    : Object.keys(params).length !== 1
            ) {
                fail(
                    "rejected",
                    relative
                        ? "Use step_channel with a nonzero safe integer offset."
                        : "Channel movement accepts only an operation."
                );
                return;
            }
            if (!relative) {
                var queue = remotePlexQueue(w, remotePlayerInfo(w).runtime);
                if (queue.retained()) {
                    return queue.execute(
                        {
                            expires_at: expiresAt,
                            params: {
                                op:
                                    operation === "next_channel"
                                        ? "next"
                                        : "previous",
                                runtime: remotePlayerInfo(w).runtime,
                            },
                        },
                        function (result: any) {
                            if (result.status !== "ok") {
                                done(result);
                                return;
                            }
                            reply({
                                dispatched: true,
                                operation: operation,
                                plex_queue: result.data,
                            });
                        }
                    );
                }
            }
            var selected = remoteChannelStep(
                w,
                relative
                    ? params.offset
                    : operation === "previous_channel"
                      ? -1
                      : 1
            );
            if (!selected) {
                fail(
                    "rejected",
                    "The requested channel is unavailable or requires local input."
                );
                return;
            }
            if (
                !selected.current() ||
                selected.play.call(
                    w,
                    selected.category,
                    selected.index,
                    true,
                    selected.current
                ) !== true
            ) {
                fail(
                    "rejected",
                    "The player did not admit the channel change."
                );
                return;
            }
            var selection: any = {
                channel: selected.channel,
                dispatched: true,
                operation: operation,
            };
            if (relative) selection.offset = params.offset;
            reply(selection);
            return;
        }
        if (
            ["pause", "resume", "seek"].indexOf(operation) < 0 ||
            Object.prototype.hasOwnProperty.call(params, "offset") ||
            (operation === "seek"
                ? typeof params.position !== "number" ||
                  !isFinite(params.position) ||
                  params.position < 0
                : params.position !== undefined)
        ) {
            fail(
                "rejected",
                "Use pause, resume or seek with a nonnegative position."
            );
            return;
        }
        if (!owned || playback.indexOf(operation) < 0) {
            fail(
                "unsupported",
                "Playback control requires a compatible owned stream."
            );
            return;
        }
        if (operation === "seek") owned.handle.seek(params.position);
        else owned.handle[operation]();
        var result: any = { dispatched: true, operation: operation };
        if (operation === "seek") result.position = params.position;
        reply(result);
        return;
    }
    if (action === "input") {
        var key = params.key;
        if (
            typeof key !== "string" ||
            !Object.prototype.hasOwnProperty.call(remoteKeys, key)
        ) {
            fail("rejected", "Use a named input key.");
            return;
        }
        if (!remoteInputAllowed(w, key)) {
            fail("rejected", "This surface requires local input.");
            return;
        }
        var code = remoteInputCode(w, key);
        if (!afterReply || !code) {
            fail(
                "unsupported",
                "This key requires supported acknowledged input."
            );
            return;
        }
        var handler = w.keyHandler;
        var port = w.__ottClassicScreenPort;
        var revision =
            typeof port.revision === "function" ? port.revision() : 0;
        afterReply(function () {
            if (
                w.keyHandler !== handler ||
                w.__ottClassicScreenPort !== port ||
                (port.revision && port.revision() !== revision) ||
                !remoteInputAllowed(w, key) ||
                remoteInputCode(w, key) !== code
            )
                return;
            // UI keys may reach legacy lifecycle sinks; only explicit typed
            // lifecycle operations may invoke those platform effects remotely.
            var previous = w.__ottRemoteInputActive;
            w.__ottRemoteInputActive = true;
            try {
                handler({
                    keyCode: code,
                    preventDefault: function () {},
                    stopPropagation: function () {},
                    which: code,
                });
            } finally {
                w.__ottRemoteInputActive = previous;
            }
        });
        reply({
            accepted: true,
            dispatched: false,
            effect: "input-after-ack",
            key: key,
        });
        return;
    }
    var operation = params.operation;
    if (
        [
            "restart_stream",
            "reload_player",
            "restart_app",
            "standby",
            "wake",
            "exit_app",
            "reboot_device",
        ].indexOf(operation) < 0
    ) {
        fail("rejected", "Use a named lifecycle operation.");
        return;
    }
    if (operation === "restart_stream" || operation === "reload_player") {
        var capability = remoteLifecycleCapability(w, operation);
        if (capability.state !== "available") {
            fail(
                capability.reason === "policy_restricted"
                    ? "rejected"
                    : "unsupported",
                "This lifecycle operation is unavailable."
            );
            return;
        }
        executeRemoteRestart(
            w,
            { target: operation === "restart_stream" ? "stream" : "player" },
            function (result) {
                if (result.status === "ok" && operation === "reload_player")
                    result.data = {
                        accepted: true,
                        dispatched: false,
                        effect: "lifecycle-after-ack",
                        operation: operation,
                    };
                else if (result.status === "ok")
                    result.data = {
                        accepted: true,
                        dispatched: true,
                        operation: operation,
                    };
                done(result);
            },
            afterReply
        );
        return;
    }
    var standby = operation === "standby" || operation === "wake";
    if (!standby && (remoteSettingsLocked(w) || remoteKiosk(w))) {
        fail(
            "rejected",
            "Unlock player settings and kiosk before this operation."
        );
        return;
    }
    if (!afterReply || !lifecycleAvailable(operation)) {
        fail("unsupported", "This lifecycle operation is unavailable.");
        return;
    }
    var method = remoteLifecycleMethods[operation];
    var setStandby =
        standby && typeof w.stbSetStandby === "function"
            ? w.stbSetStandby
            : null;
    var effect = standby ? setStandby || w.stbToggleStandby : hooks[method];
    var readStandby = w.stbIsStandby;
    afterReply(function () {
        if (!standby && (remoteSettingsLocked(w) || remoteKiosk(w))) return;
        if (standby) {
            if (w.stbIsStandby !== readStandby) return;
            if (setStandby) {
                if (w.stbSetStandby === effect)
                    effect.call(w, operation === "standby");
            } else if (
                w.stbToggleStandby === effect &&
                !!readStandby() !== (operation === "standby")
            )
                effect.call(w);
        } else if (
            w.__ottRemoteLifecycle === hooks &&
            hooks[method] === effect
        ) {
            remoteCheckpoint(w);
            if (
                !remoteSettingsLocked(w) &&
                !remoteKiosk(w) &&
                w.__ottRemoteLifecycle === hooks &&
                hooks[method] === effect
            )
                effect.call(hooks);
        }
    });
    reply({
        accepted: true,
        dispatched: false,
        effect: "lifecycle-after-ack",
        operation: operation,
    });
}
