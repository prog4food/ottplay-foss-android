import { executeRemoteRestart } from "../commands/remote-restart";
import {
    type CommandServerRequest,
    type CommandServerResponse,
    normalizeCommandServerAddress,
} from "./command-server";
import type { DiagnosticsPermissionStore } from "./diagnostics-permission";
import {
    createRemoteDiagnostics,
    type RemoteDiagnosticsOptions,
} from "./remote-diagnostics";

export interface DiagnosticsControllerStatus {
    enabled: boolean;
    message: string;
    pending: boolean;
    remainingMs?: number;
    runtimeId?: string;
    sessionId?: string;
    state: string;
    trusted: boolean;
}

interface ControllerConfig {
    address: string;
    enabled: boolean;
    token: string;
}

interface ControllerDependencies {
    clientFactory?: typeof createRemoteDiagnostics;
    getConfig: () => ControllerConfig;
    onStatus?: (status: DiagnosticsControllerStatus) => void;
    /** Legacy injection retained for callers; connection policy never reads or writes it. */
    permissionStore?: DiagnosticsPermissionStore;
    runtimeLabel?: string;
    send: (
        request: CommandServerRequest,
        complete: (response?: CommandServerResponse) => void
    ) => () => void;
}

const MAX_NUMBER = 9007199254740991;

/** The enabled command-server connection authorizes diagnostics; captures retain bounded leases. */
export function installDiagnosticsController(
    w: any,
    deps: ControllerDependencies
): any {
    var enabled = false;
    var authority: ControllerConfig | null = null;
    var connectionGeneration = 0;
    var retry: any = null;
    var failures = 0;
    var pageSuspended = false;
    var generation = 0;
    var client: any = null;
    var timer: any = null;
    var removeListeners: (() => void) | null = null;
    var releaseCapture: (() => void) | null = null;
    var subscriber: ((status: DiagnosticsControllerStatus) => void) | null =
        null;
    var saved: ControllerConfig | null = null;
    var lastNow = 0;
    var sequence = 0;
    var view: Omit<
        DiagnosticsControllerStatus,
        "enabled" | "trusted" | "pending"
    > = {
        message: "Connect remote control to enable diagnostics.",
        state: "disabled",
    };

    function status(): DiagnosticsControllerStatus {
        var result: DiagnosticsControllerStatus = {
            enabled: enabled,
            message: view.message,
            pending: false,
            state: view.state,
            trusted: !!authority,
        };
        if (view.runtimeId) result.runtimeId = view.runtimeId;
        if (view.sessionId) result.sessionId = view.sessionId;
        if (view.remainingMs !== undefined)
            result.remainingMs = view.remainingMs;
        return result;
    }

    function notify(): void {
        if (deps.onStatus) {
            try {
                deps.onStatus(status());
            } catch (_error) {}
        }
        if (subscriber) {
            try {
                subscriber(status());
            } catch (_error) {}
        }
    }

    function number(value: any): number | null {
        return typeof value === "number" &&
            isFinite(value) &&
            value >= 0 &&
            value <= MAX_NUMBER
            ? value
            : null;
    }

    function clock(): number {
        if (!w.performance || typeof w.performance.now !== "function")
            throw new Error("Monotonic clock unavailable");
        var value = w.performance.now();
        if (number(value) === null || (enabled && value < lastNow))
            throw new Error("Monotonic clock unavailable");
        lastNow = value;
        return value;
    }

    function online(): boolean {
        return !w.navigator || w.navigator.onLine !== false;
    }

    function config(value?: ControllerConfig): ControllerConfig | null {
        try {
            var next = value === undefined ? deps.getConfig() : value;
            if (
                !next ||
                next.enabled !== true ||
                typeof next.address !== "string" ||
                typeof next.token !== "string" ||
                !/^[A-Za-z0-9_-]{32,256}$/.test(next.token.trim())
            )
                return null;
            return {
                address: normalizeCommandServerAddress(next.address),
                enabled: true,
                token: next.token.trim(),
            };
        } catch (_error) {
            return null;
        }
    }

    function same(
        a: ControllerConfig | null,
        b: ControllerConfig | null
    ): boolean {
        return !!(
            a &&
            b &&
            a.address === b.address &&
            a.token === b.token &&
            a.enabled === b.enabled
        );
    }

    function identifier(): string {
        sequence++;
        try {
            var bytes = new Uint8Array(16);
            if (!w.crypto || typeof w.crypto.getRandomValues !== "function")
                throw new Error("No random source");
            w.crypto.getRandomValues(bytes);
            var output = "";
            for (var i = 0; i < bytes.length; i++)
                output += (bytes[i] + 256).toString(16).slice(1);
            return output + "-" + sequence;
        } catch (_error) {
            // Labels are not credentials; the server issues authenticated runtime IDs.
            return (
                "page-" +
                Math.floor(lastNow).toString(36) +
                "-" +
                sequence +
                "-" +
                Math.random().toString(36).slice(2, 18)
            );
        }
    }

    function clearRetry(): void {
        if (retry !== null) w.clearTimeout(retry);
        retry = null;
    }

    function detachCapture(): void {
        var release = releaseCapture;
        releaseCapture = null;
        if (release) {
            try {
                release();
            } catch (_error) {}
        }
    }

    function stopRuntime(reason = "local_stop"): void {
        enabled = false;
        var current = ++generation;
        var oldTimer = timer;
        var oldCapture = releaseCapture;
        var oldClient = client;
        // Detach ownership before callbacks can establish another connection/runtime.
        timer = null;
        releaseCapture = null;
        client = null;
        saved = null;
        view = {
            message: authority
                ? "Remote control authorizes diagnostics. Waiting to reconnect."
                : "Connect remote control to enable diagnostics.",
            state: authority ? "suspended" : "disabled",
        };
        if (oldTimer !== null) w.clearTimeout(oldTimer);
        if (oldCapture) {
            try {
                oldCapture();
            } catch (_error) {}
        }
        if (oldClient) {
            try {
                oldClient.stop(reason);
            } catch (_error) {}
        }
        if (current === generation) notify();
    }

    /** Controller teardown, not a persisted permission preference. */
    function stop(reason = "local_stop"): void {
        connectionGeneration++;
        authority = null;
        clearRetry();
        var remove = removeListeners;
        removeListeners = null;
        if (remove) remove();
        stopRuntime(reason);
    }

    function unavailable(): void {
        var current = connectionGeneration;
        clearRetry();
        stopRuntime("unsupported");
        if (current !== connectionGeneration || enabled) return;
        view = {
            message: "Remote diagnostics is unavailable on this player.",
            state: "unavailable",
        };
        notify();
    }

    function schedule(delay: number): void {
        clearRetry();
        if (!authority || enabled || pageSuspended || !online()) return;
        var current = connectionGeneration;
        var owned = w.setTimeout(function () {
            if (
                current !== connectionGeneration ||
                !authority ||
                retry !== owned
            )
                return;
            retry = null;
            if (!same(authority, config())) configurationChanged();
            else startRuntime();
        }, delay);
        retry = owned;
    }

    function suspend(reason: string, retryAllowed = true): void {
        var current = connectionGeneration;
        clearRetry();
        stopRuntime(reason);
        if (current !== connectionGeneration || !authority || enabled) return;
        if (retryAllowed)
            schedule(
                Math.min(30000, 1000 * Math.pow(2, Math.min(5, failures++)))
            );
    }

    function stopSession(): void {
        var current = connectionGeneration;
        clearRetry();
        stopRuntime("local_stop");
        if (current === connectionGeneration && !enabled) schedule(0);
    }

    function installListeners(): boolean {
        if (removeListeners) return true;
        if (
            !w.document ||
            typeof w.document.addEventListener !== "function" ||
            typeof w.document.removeEventListener !== "function" ||
            typeof w.addEventListener !== "function" ||
            typeof w.removeEventListener !== "function"
        )
            return false;
        var current = connectionGeneration;
        function hidden(): void {
            if (current !== connectionGeneration) return;
            pageSuspended = true;
            suspend("suspended", false);
        }
        function shown(): void {
            if (current !== connectionGeneration) return;
            pageSuspended = false;
            schedule(0);
        }
        function offline(): void {
            if (current === connectionGeneration)
                suspend("disconnected", false);
        }
        function onlineAgain(): void {
            if (current === connectionGeneration) schedule(0);
        }
        // Background counters remain available; actual OS/page suspension retires the runtime.
        w.document.addEventListener("freeze", hidden, false);
        w.document.addEventListener("resume", shown, false);
        w.addEventListener("pagehide", hidden, false);
        w.addEventListener("pageshow", shown, false);
        w.addEventListener("offline", offline, false);
        w.addEventListener("online", onlineAgain, false);
        removeListeners = function () {
            w.document.removeEventListener("freeze", hidden, false);
            w.document.removeEventListener("resume", shown, false);
            w.removeEventListener("pagehide", hidden, false);
            w.removeEventListener("pageshow", shown, false);
            w.removeEventListener("offline", offline, false);
            w.removeEventListener("online", onlineAgain, false);
        };
        return true;
    }

    function configurationChanged(value?: ControllerConfig): void {
        var next = config(value);
        if (next && next.address.slice(0, 8) !== "https://") next = null;
        if (same(authority, next)) {
            if (!enabled) schedule(0);
            return;
        }
        var current = ++connectionGeneration;
        authority = next;
        failures = 0;
        clearRetry();
        var remove = removeListeners;
        removeListeners = null;
        if (remove) remove();
        stopRuntime("consent_revoked");
        if (current !== connectionGeneration) return;
        if (!next) {
            if (config(value))
                view = {
                    message:
                        "Use an HTTPS command server for remote diagnostics.",
                    state: "unavailable",
                };
            notify();
            return;
        }
        if (!installListeners()) {
            unavailable();
            return;
        }
        // The command-server save callback may still be committing its settings.
        schedule(0);
    }

    /** Historical setters no longer change connection authority; false stops the current capture only. */
    function setEnabled(value: boolean): void {
        if (value === true) configurationChanged();
        else stopSession();
    }

    function validGrant(current: number): boolean {
        if (!enabled || current !== generation) return false;
        if (!same(saved, config()) || !same(saved, authority)) {
            configurationChanged();
            return false;
        }
        if (!online() || pageSuspended) {
            suspend("suspended", false);
            return false;
        }
        try {
            clock();
        } catch (_error) {
            unavailable();
            return false;
        }
        return true;
    }
    function field(value: any, key: string): any {
        try {
            return value &&
                typeof value === "object" &&
                Object.prototype.hasOwnProperty.call(value, key)
                ? value[key]
                : undefined;
        } catch (_error) {
            return undefined;
        }
    }

    function safeMetrics(value: any, keys: string[]): any {
        var result: any = {};
        if (!value || typeof value !== "object") return result;
        keys.forEach(function (key) {
            var metric = field(value, key);
            if (number(metric) !== null) result[key] = metric;
        });
        return result;
    }

    function snapshot(): any {
        var logger = w.__ottDebug;
        if (!logger || typeof logger.snapshot !== "function") return {};
        var raw: any;
        try {
            raw = logger.snapshot();
        } catch (_error) {
            return {};
        }
        if (!raw || typeof raw !== "object") return {};
        var counters = safeMetrics(field(raw, "counters"), [
            "dropped",
            "errors",
            "recoveries",
            "stalls",
            "waiting",
        ]);
        var rawVideo = field(raw, "video");
        var video: any = null;
        if (rawVideo && typeof rawVideo === "object") {
            video = safeMetrics(rawVideo, [
                "bufferAhead",
                "currentTime",
                "droppedFrames",
                "errorCode",
                "networkState",
                "readyState",
                "videoHeight",
                "videoWidth",
            ]);
            var paused = field(rawVideo, "paused");
            var ended = field(rawVideo, "ended");
            if (typeof paused === "boolean") video.paused = paused;
            if (typeof ended === "boolean") video.ended = ended;
        }
        return {
            available: field(raw, "available") === true,
            counters: counters,
            enabled: field(raw, "enabled") === true,
            video: video,
        };
    }

    function adapterSnapshot(adapter: () => any, input: boolean): any {
        var raw: any;
        try {
            raw = adapter();
        } catch (_error) {
            return { available: false, enabled: false };
        }
        var result: any = {
            available: field(raw, "available") === true,
            enabled: field(raw, "enabled") === true,
        };
        if (input && result.available && result.enabled) {
            var keys = ["move", "down", "click", "wheel"];
            var total = 0;
            for (var i = 0; i < keys.length; i++) {
                var count = field(raw, keys[i]);
                if (
                    number(count) === null ||
                    Math.floor(count) !== count ||
                    total > MAX_NUMBER - count
                )
                    return result;
                total += count;
            }
            result.inputEvents = total;
        }
        return result;
    }

    function capture(
        current: number,
        emit: (event: any) => void,
        stopped?: () => void
    ): () => void {
        if (!validGrant(current)) return function () {};
        var logger = w.__ottDebug;
        if (!logger || typeof logger.capture !== "function")
            throw new Error("Diagnostic capture unavailable");
        detachCapture();
        if (!validGrant(current)) return function () {};
        var release = logger.capture(
            function (event: any) {
                if (!validGrant(current) || !event) return;
                var category = field(event, "cat");
                var message = field(event, "msg");
                if (typeof category !== "string" || typeof message !== "string")
                    return;
                var valid =
                    (category === "video" &&
                        /^(waiting|playing|stalled|ended|error|canplay)$/.test(
                            message
                        )) ||
                    (category === "net" &&
                        /^(xhr status|xhr error)$/.test(message)) ||
                    (category === "hls" &&
                        /^(ERROR|ERROR fatal|FRAG_LOADED)$/.test(message));
                if (!valid) return;
                var data = safeMetrics(field(event, "data"), [
                    "code",
                    "status",
                    "size",
                    "loadMs",
                ]);
                // Raw text, URLs, stack traces and logger payloads never cross this boundary.
                if (validGrant(current))
                    emit({ cat: category, data: data, msg: message });
            },
            function () {
                if (!enabled || current !== generation) return;
                stopSession();
                if (stopped) stopped();
            }
        );
        if (typeof release !== "function")
            throw new Error("Diagnostic capture unavailable");
        if (!enabled || current !== generation) {
            release();
            return function () {};
        }
        var released = false;
        var owned = function () {
            if (released) return;
            released = true;
            if (releaseCapture === owned) releaseCapture = null;
            release();
        };
        releaseCapture = owned;
        return owned;
    }

    function update(current: number, next: any): void {
        if (!enabled || current !== generation || !next || !validGrant(current))
            return;
        if (
            next.state === "disabled" ||
            next.state === "unavailable" ||
            next.state === "regrant-needed" ||
            next.state === "regrant_required" ||
            next.state === "stopped" ||
            next.requiresGrant === true ||
            next.state === "error"
        ) {
            var reason =
                next.reason ||
                (next.state === "unavailable" ? "unsupported" : "disconnected");
            if (reason === "unsupported") unavailable();
            else suspend(reason);
            return;
        }
        var active = next.state === "active";
        if (next.runtimeId) failures = 0;
        view = {
            message: active
                ? "Remote diagnostics is collecting for this connection (up to 10 minutes per session)."
                : "Remote control authorizes diagnostics. Ready for an operator.",
            state: active ? "active" : "ready",
        };
        if (
            typeof next.runtimeId === "string" &&
            /^[A-Za-z0-9_.:-]{1,80}$/.test(next.runtimeId)
        )
            view.runtimeId = next.runtimeId;
        if (
            active &&
            typeof next.sessionId === "string" &&
            /^[A-Za-z0-9_.:-]{1,80}$/.test(next.sessionId)
        )
            view.sessionId = next.sessionId;
        notify();
    }

    function watch(current: number): void {
        if (!validGrant(current)) return;
        timer = w.setTimeout(function () {
            if (!enabled || current !== generation) return;
            timer = null;
            watch(current);
        }, 1000);
    }

    function startRuntime(): void {
        if (enabled || !authority || pageSuspended || !online()) return;
        var next = config();
        if (!same(authority, next)) {
            configurationChanged();
            return;
        }
        var logger = w.__ottDebug;
        if (
            !logger ||
            typeof logger.capture !== "function" ||
            typeof logger.snapshot !== "function"
        ) {
            unavailable();
            return;
        }
        try {
            lastNow = clock();
        } catch (_error) {
            unavailable();
            return;
        }
        enabled = true;
        saved = next;
        var current = ++generation;
        view = {
            message:
                "Connecting remote diagnostics for the enabled remote control connection.",
            state: "ready",
        };
        notify();
        if (!enabled || current !== generation) return;
        try {
            var factory = deps.clientFactory || createRemoteDiagnostics;
            var options: RemoteDiagnosticsOptions = {
                capabilities: ["playback", "network"],
                capture: function (
                    emit: (event: any) => void,
                    stopped?: () => void
                ) {
                    return capture(current, emit, stopped);
                },
                clearTimeout: function (handle: any): void {
                    w.clearTimeout(handle);
                },
                executeRepair: function (action, complete, afterAck) {
                    if (!validGrant(current)) {
                        complete("rejected");
                        return;
                    }
                    var canceled = false;
                    executeRemoteRestart(
                        w,
                        {
                            target:
                                action === "reload_player"
                                    ? "player"
                                    : "stream",
                        },
                        function (result) {
                            if (canceled || !validGrant(current)) return;
                            complete(
                                result.status === "ok"
                                    ? action === "reload_player"
                                        ? "accepted"
                                        : "applied"
                                    : result.status === "unsupported"
                                      ? "unsupported"
                                      : "rejected"
                            );
                        },
                        function (effect) {
                            afterAck(function () {
                                if (!canceled && validGrant(current)) effect();
                            });
                        }
                    );
                    return function () {
                        canceled = true;
                    };
                },
                now: clock,
                onStatus: function (value: any) {
                    update(current, value);
                },
                send: function (request, complete) {
                    if (!validGrant(current)) return function () {};
                    return deps.send(request, function (response) {
                        if (validGrant(current)) complete(response);
                    });
                },
                sendRevocation: deps.send,
                setTimeout: function (
                    callback: () => void,
                    delay: number
                ): any {
                    return w.setTimeout(callback, delay);
                },
                snapshot: function () {
                    if (!validGrant(current)) return {};
                    var value = snapshot();
                    return validGrant(current) ? value : {};
                },
            };
            if (typeof w.__ottDebugInputSnapshot === "function") {
                options.capabilities!.push("input");
                options.inputSnapshot = function () {
                    if (!validGrant(current)) return {};
                    var value = adapterSnapshot(
                        w.__ottDebugInputSnapshot,
                        true
                    );
                    return validGrant(current) ? value : {};
                };
            }
            if (
                w.__ottHostedEpg &&
                typeof w.__ottHostedEpg.remoteSnapshot === "function"
            ) {
                options.capabilities!.push("epg");
                options.epgSnapshot = function () {
                    if (!validGrant(current)) return {};
                    var value = adapterSnapshot(function () {
                        return w.__ottHostedEpg.remoteSnapshot();
                    }, false);
                    return validGrant(current) ? value : {};
                };
            }
            var created = factory(options);
            if (!enabled || current !== generation) {
                created.stop("consent_revoked");
                return;
            }
            client = created;
            client.configure({
                address: next!.address,
                bootId: identifier(),
                consentEpoch: identifier(),
                enabled: true,
                instanceId:
                    (typeof deps.runtimeLabel === "string" &&
                    /^[A-Za-z0-9_.:-]{1,40}$/.test(deps.runtimeLabel)
                        ? deps.runtimeLabel + "."
                        : "") + identifier().slice(0, 39),
                token: next!.token,
            });
            watch(current);
        } catch (_error) {
            if (current === generation) unavailable();
        }
    }

    // Ignore legacy diagnostics-permission storage entirely: a stored grant or denial
    // cannot override the active connection, and no user profile migration is needed.
    configurationChanged();

    return {
        configurationChanged: configurationChanged,
        setEnabled: setEnabled,
        setTrusted: setEnabled,
        status: status,
        stop: stop,
        stopSession: stopSession,
        subscribe: function (listener: any): void {
            subscriber = typeof listener === "function" ? listener : null;
            if (subscriber) {
                try {
                    subscriber(status());
                } catch (_error) {}
            }
        },
    };
}
