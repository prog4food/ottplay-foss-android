import { commandEndpointBase, validDeviceId } from "../shared/wire-contracts";
import type {
    CommandServerRequest,
    CommandServerResponse,
} from "./command-server";
import { createDiagnosticBuffer } from "./diagnostic-buffer";

export interface RemoteDiagnosticsConfig {
    address: string;
    bootId: string;
    consentEpoch: string;
    enabled: boolean;
    instanceId: string;
    reportedUuid?: string;
    token: string;
}
export type RemoteRepairAction = "restart_stream" | "reload_player";
export type RemoteRepairStatus =
    | "applied"
    | "accepted"
    | "rejected"
    | "unsupported";
export interface RemoteDiagnosticsOptions {
    capabilities?: string[];
    capture: (event: (event: any) => void, stopped: () => void) => () => void;
    clearTimeout: (timer: any) => void;
    epgSnapshot?: () => any;
    executeRepair?: (
        action: RemoteRepairAction,
        complete: (status: RemoteRepairStatus) => void,
        afterAck: (effect: () => void) => void
    ) => void | (() => void);
    inputSnapshot?: () => any;
    now: () => number;
    onStatus?: (status: any) => void;
    send: (
        request: CommandServerRequest,
        complete: (response?: CommandServerResponse) => void
    ) => () => void;
    /** Only the final bounded consent=false poll may retire an inactive runtime. */
    sendRevocation?: RemoteDiagnosticsOptions["send"];
    setTimeout: (callback: () => void, delay: number) => any;
    snapshot: () => any;
}

var DIAGNOSTIC_PATH = "/api/v2/diagnostics";
var SAFE_INTEGER = 9007199254740991;
function diagnosticInteger(value: any, maximum: number, minimum = 0): boolean {
    return (
        typeof value === "number" &&
        isFinite(value) &&
        Math.floor(value) === value &&
        value >= minimum &&
        value <= maximum
    );
}
function diagnosticLabel(value: any): boolean {
    return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(value);
}
function diagnosticToken(value: any): boolean {
    return typeof value === "string" && /^[A-Za-z0-9_-]{32,256}$/.test(value);
}
function diagnosticObject(
    value: any,
    keys: string[],
    required: string[] = keys
): boolean {
    return (
        !!value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value).every(function (key) {
            return keys.indexOf(key) >= 0;
        }) &&
        required.every(function (key) {
            return Object.prototype.hasOwnProperty.call(value, key);
        })
    );
}
function diagnosticBytes(text: string): number {
    try {
        return encodeURIComponent(text).replace(/%[0-9a-f]{2}/gi, "x").length;
    } catch (_) {
        return SAFE_INTEGER;
    }
}

/** JSON.parse alone silently accepts duplicate security/control fields. */
function diagnosticParse(text: string): any {
    if (
        typeof text !== "string" ||
        text.length > 8192 ||
        diagnosticBytes(text) > 8192
    )
        throw new Error("Invalid response");
    var offset = 0;
    function whitespace(): void {
        while (/[ \t\r\n]/.test(text.charAt(offset)) && offset < text.length)
            offset++;
    }
    function string(): string {
        var start = offset++;
        while (offset < text.length) {
            var ch = text.charAt(offset++);
            if (ch === "\\") offset++;
            else if (ch === '"') return JSON.parse(text.slice(start, offset));
        }
        throw new Error("Invalid response");
    }
    function value(depth: number): any {
        if (depth > 8) throw new Error("Invalid response");
        whitespace();
        var ch = text.charAt(offset);
        if (ch === '"') return string();
        if (ch === "{" || ch === "[") {
            var object = ch === "{";
            var result: any = object ? Object.create(null) : [];
            var end = object ? "}" : "]";
            offset++;
            whitespace();
            if (text.charAt(offset) === end) {
                offset++;
                return result;
            }
            while (offset < text.length) {
                whitespace();
                if (object) {
                    if (text.charAt(offset) !== '"')
                        throw new Error("Invalid response");
                    var key = string();
                    if (Object.prototype.hasOwnProperty.call(result, key))
                        throw new Error("Invalid response");
                    whitespace();
                    if (text.charAt(offset++) !== ":")
                        throw new Error("Invalid response");
                    result[key] = value(depth + 1);
                } else result.push(value(depth + 1));
                whitespace();
                ch = text.charAt(offset++);
                if (ch === end) return result;
                if (ch !== ",") throw new Error("Invalid response");
            }
        }
        var token =
            /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
                text.slice(offset)
            );
        if (!token) throw new Error("Invalid response");
        offset += token[0].length;
        return JSON.parse(token[0]);
    }
    var parsed = value(0);
    whitespace();
    if (offset !== text.length) throw new Error("Invalid response");
    return parsed;
}

function diagnosticBase(address: string): string {
    var url = new URL(address);
    if (url.protocol !== "https:" || url.username || url.password || url.hash)
        throw new Error("Invalid controller");
    if (url.search && !/^\?device_id=[A-Za-z0-9._:%-]+$/.test(url.search))
        throw new Error("Invalid controller");
    var path = url.pathname.replace(/\/+$/, "");
    path = commandEndpointBase(path);
    if (path.slice(-DIAGNOSTIC_PATH.length) === DIAGNOSTIC_PATH)
        path = path.slice(0, -DIAGNOSTIC_PATH.length);
    return url.protocol + "//" + url.host + path + DIAGNOSTIC_PATH;
}

/** Separate runtime credential, control loop and upload lane; never the v1 command queue. */
export function createRemoteDiagnostics(options: RemoteDiagnosticsOptions) {
    var config: RemoteDiagnosticsConfig | null = null;
    var base = "";
    var generation = 0;
    var lastClock = -1;
    var blockedEpoch = "";
    var state = "disabled";
    var reason = "";
    var runtimeId = "";
    var runtimeCredential = "";
    var serverEpoch = "";
    var revision = 0;
    var pollSequence = 0;
    var controlSignature = "";
    var controlFailures = 0;
    var registrationFailures = 0;
    var lastPoll = 0;
    var pendingResult = "";
    var resultFailures = 0;
    var eventFailures = 0;
    var revoke: { cancel: () => void; timer: any } | null = null;
    var timers: Record<string, any> = Object.create(null);
    var lanes: Record<
        string,
        { cancel: () => void; timer: any; done: boolean }
    > = Object.create(null);
    var capabilities = (
        options.capabilities || ["playback", "network"]
    ).slice();
    if (typeof options.executeRepair === "function") {
        if (capabilities.indexOf("repairs") < 0) capabilities.push("repairs");
    } else
        capabilities = capabilities.filter(function (name) {
            return name !== "repairs";
        });
    interface Repair {
        action: RemoteRepairAction;
        cancel: (() => void) | null;
        deadline: number;
        effect: (() => void) | null;
        failures: number;
        id: string;
        result: string;
    }
    var repair: Repair | null = null;
    var repairLoopStarted = false;
    var repairHistory: Record<string, RemoteRepairAction> = Object.create(null);
    var repairCount = 0;
    var limits = { batch: 32, body: 16384, event: 1024, session: 600000 };
    var session: {
        id: string;
        request: string;
        revision: number;
        started: number;
        deadline: number;
        release: (() => void) | null;
        buffer: ReturnType<typeof createDiagnosticBuffer>;
        acknowledged: number;
        batch: string;
        batchLast: number;
        startResult: string;
        confirmed: boolean;
    } | null = null;

    function snapshot(): any {
        return {
            available: typeof options.now === "function",
            controlRevision: revision,
            enabled: !!config && config.enabled,
            reason: reason || null,
            requiresGrant: !!blockedEpoch,
            runtimeId: runtimeId || null,
            serverEpoch: serverEpoch || null,
            sessionId: session ? session.id : null,
            state: state,
        };
    }
    function notify(next: string, code = ""): void {
        state = next;
        reason = code;
        if (options.onStatus) {
            try {
                options.onStatus(snapshot());
            } catch (_) {}
        }
    }
    function time(): number | null {
        try {
            var value = options.now();
            if (
                typeof value !== "number" ||
                !isFinite(value) ||
                value < 0 ||
                value < lastClock
            )
                return null;
            lastClock = value;
            return value;
        } catch (_) {
            return null;
        }
    }
    function clearTimer(name: string): void {
        if (Object.prototype.hasOwnProperty.call(timers, name))
            options.clearTimeout(timers[name]);
        delete timers[name];
    }
    function later(name: string, callback: () => void, delay: number): void {
        clearTimer(name);
        var current = generation;
        timers[name] = options.setTimeout(
            function () {
                delete timers[name];
                if (current === generation) callback();
            },
            Math.max(0, delay)
        );
    }
    function cancelLane(name: string): void {
        var lane = lanes[name];
        if (!lane) return;
        delete lanes[name];
        lane.done = true;
        options.clearTimeout(lane.timer);
        try {
            lane.cancel();
        } catch (_) {}
    }
    function clearSession(): void {
        var previous = session;
        session = null;
        ["sample", "events", "deadline"].forEach(clearTimer);
        cancelLane("events");
        eventFailures = 0;
        if (previous) {
            previous.buffer.clear();
            if (previous.release) {
                try {
                    previous.release();
                } catch (_) {}
            }
        }
    }
    function cancelRevoke(): void {
        var previous = revoke;
        revoke = null;
        if (!previous) return;
        options.clearTimeout(previous.timer);
        try {
            previous.cancel();
        } catch (_) {}
    }
    function revokeConsent(
        address: string,
        credential: string,
        id: string,
        lastRevision: number,
        sequence: number
    ): void {
        cancelRevoke();
        // This independent best-effort request cannot retain capture, retry, or change client state.
        var owned = { cancel: function () {}, timer: null as any };
        revoke = owned;
        function finish(): void {
            if (revoke !== owned) return;
            revoke = null;
            options.clearTimeout(owned.timer);
            try {
                owned.cancel();
            } catch (_) {}
        }
        owned.timer = options.setTimeout(finish, 1000);
        try {
            var cancel = (options.sendRevocation || options.send)(
                {
                    body: JSON.stringify({
                        consent: { granted: false },
                        last_control_revision: lastRevision,
                        poll_seq: sequence,
                        runtime_id: id,
                    }),
                    headers: {
                        Authorization: "Bearer " + credential,
                        "Content-Type": "application/json",
                    },
                    method: "POST",
                    secureControl: true,
                    timeoutMs: 1000,
                    url: address + "/poll",
                },
                finish
            );
            if (revoke === owned) owned.cancel = cancel;
            else {
                try {
                    cancel();
                } catch (_) {}
            }
        } catch (_) {
            finish();
        }
    }
    function stop(code = "local_stop"): void {
        // No cleanup waits for an upload/result/v1 operation or for the network.
        var credential = runtimeCredential;
        var id = runtimeId;
        var epoch = config ? config.consentEpoch : "";
        if (epoch) blockedEpoch = epoch;
        if (config) config.enabled = false;
        runtimeCredential = "";
        pendingResult = "";
        generation++;
        Object.keys(timers).forEach(clearTimer);
        Object.keys(lanes).forEach(cancelLane);
        clearSession();
        clearRepair();
        if (credential && id && epoch)
            revokeConsent(base, credential, id, revision, ++pollSequence);
        notify("stopped", code);
    }
    function requireGrant(code: string): void {
        stop(code);
        notify("regrant_required", code);
    }
    function clock(): number | null {
        var value = time();
        if (value === null) requireGrant("unsupported");
        return value;
    }
    function send(
        name: string,
        path: string,
        body: string,
        credential: string,
        complete: (response?: CommandServerResponse) => void
    ): void {
        if (lanes[name] || !config || !config.enabled) return;
        var current = generation;
        var lane = { cancel: function () {}, done: false, timer: null as any };
        lanes[name] = lane;
        function finish(response?: CommandServerResponse): void {
            if (lane.done || current !== generation || lanes[name] !== lane)
                return;
            lane.done = true;
            delete lanes[name];
            options.clearTimeout(lane.timer);
            complete(response);
        }
        lane.timer = options.setTimeout(function () {
            if (lane.done) return;
            try {
                lane.cancel();
            } catch (_) {}
            finish();
        }, 4000);
        try {
            var cancel = options.send(
                {
                    body: body,
                    headers: {
                        Authorization: "Bearer " + credential,
                        "Content-Type": "application/json",
                    },
                    method: "POST",
                    secureControl: true,
                    timeoutMs: 4000,
                    url: base + path,
                },
                finish
            );
            if (!lane.done) lane.cancel = cancel;
        } catch (_) {
            finish();
        }
    }
    function response(
        value?: CommandServerResponse,
        conflicts: string[] = []
    ): any {
        if (!value || !value.status) return null;
        var data: any;
        try {
            data = diagnosticParse(value.body);
        } catch (_) {
            if (value.status >= 500 || value.status === 429) return null;
            requireGrant(
                value.status === 404 ? "unsupported" : "invalid_control"
            );
            return null;
        }
        if (
            !data ||
            data.diagnostics_protocol !== 2 ||
            !diagnosticLabel(data.server_epoch)
        ) {
            requireGrant("invalid_control");
            return null;
        }
        if (serverEpoch && data.server_epoch !== serverEpoch) {
            requireGrant("server_restarted");
            return null;
        }
        if (value.status >= 200 && value.status < 300) return data;
        if (
            !diagnosticObject(data, [
                "diagnostics_protocol",
                "server_epoch",
                "error",
            ]) ||
            !diagnosticObject(data.error, ["code"]) ||
            typeof data.error.code !== "string"
        ) {
            requireGrant("invalid_control");
            return null;
        }
        if (value.status === 409 && conflicts.indexOf(data.error.code) >= 0)
            return data;
        if (value.status === 429 || value.status >= 500) return null;
        requireGrant(
            value.status === 401 || value.status === 403
                ? "consent_revoked"
                : value.status === 404
                  ? "unsupported"
                  : "invalid_control"
        );
        return null;
    }
    function backoff(failures: number): number {
        return Math.min(4000, 500 * Math.pow(2, Math.min(4, failures)));
    }
    function validLimits(value: any): boolean {
        return (
            diagnosticObject(value, [
                "session_lease_ms_max",
                "event_bytes_max",
                "events_body_bytes",
                "events_per_batch",
                "poll_after_ms",
            ]) &&
            diagnosticInteger(value.session_lease_ms_max, 600000, 1000) &&
            diagnosticInteger(value.event_bytes_max, 1024, 128) &&
            diagnosticInteger(value.events_body_bytes, 16384, 1024) &&
            diagnosticInteger(value.events_per_batch, 32, 1) &&
            diagnosticInteger(value.poll_after_ms, 3000, 1)
        );
    }
    function register(): void {
        if (!config || !config.enabled || clock() === null) return;
        notify("registering");
        if (!config || !config.enabled) return;
        var body: any = {
            boot_id: config.bootId,
            capabilities: capabilities,
            consent: { epoch: config.consentEpoch, granted: true },
            instance_id: config.instanceId,
        };
        if (config.reportedUuid) body.reported_uuid = config.reportedUuid;
        send(
            "register",
            "/runtimes",
            JSON.stringify(body),
            config.token,
            function (reply) {
                var data = response(reply);
                if (!config || !config.enabled) return;
                if (!data) {
                    if (++registrationFailures >= 3) {
                        requireGrant("disconnected");
                        return;
                    }
                    later("control", register, backoff(registrationFailures));
                    return;
                }
                if (
                    reply!.status !== 201 ||
                    !diagnosticObject(data, [
                        "diagnostics_protocol",
                        "server_epoch",
                        "device_id",
                        "runtime_id",
                        "runtime_credential",
                        "runtime_ttl_ms",
                        "limits",
                    ]) ||
                    typeof data.device_id !== "string" ||
                    !validDeviceId(data.device_id) ||
                    !diagnosticLabel(data.runtime_id) ||
                    !diagnosticToken(data.runtime_credential) ||
                    !diagnosticInteger(data.runtime_ttl_ms, 600000, 1000) ||
                    !validLimits(data.limits)
                ) {
                    requireGrant("invalid_control");
                    return;
                }
                runtimeId = data.runtime_id;
                runtimeCredential = data.runtime_credential;
                serverEpoch = data.server_epoch;
                limits = {
                    batch: data.limits.events_per_batch,
                    body: data.limits.events_body_bytes,
                    event: data.limits.event_bytes_max,
                    session: data.limits.session_lease_ms_max,
                };
                notify("idle");
                if (config && config.enabled) later("control", poll, 0);
            }
        );
    }
    function record(control: any, status: string, error?: string): void {
        if (!config || !config.enabled || !runtimeCredential) return;
        var body: any = {
            control_revision: revision,
            request_id: control.request_id,
            runtime_id: runtimeId,
            session_id: control.session_id,
            status: status,
        };
        if (error) body.error_code = error;
        pendingResult = JSON.stringify(body);
        if (session && control.action === "start" && status === "applied")
            session.startResult = pendingResult;
        resultFailures = 0;
        cancelLane("result");
        clearTimer("result");
        flushResult();
    }
    function retireOperation(): void {
        // The operator may have stopped while a start ACK or upload was in flight.
        // Release capture now; keep this runtime so the independent poll can ACK stop.
        clearSession();
        pendingResult = "";
        resultFailures = 0;
        cancelLane("result");
        clearTimer("result");
        notify("idle");
        if (config && config.enabled) later("control", poll, 0);
    }
    function flushResult(): void {
        if (!pendingResult || !runtimeCredential) return;
        var body = pendingResult;
        send("result", "/results", body, runtimeCredential, function (reply) {
            var data = response(reply, ["stale_control", "session_terminal"]);
            if (!config || !config.enabled || body !== pendingResult) return;
            if (data && reply!.status === 409) {
                retireOperation();
                return;
            }
            if (!data) {
                later("result", flushResult, backoff(++resultFailures));
                return;
            }
            if (
                reply!.status !== 200 ||
                !diagnosticObject(data, [
                    "diagnostics_protocol",
                    "server_epoch",
                    "status",
                ]) ||
                data.status !== "recorded"
            ) {
                requireGrant("invalid_control");
                return;
            }
            pendingResult = "";
            if (session && session.startResult === body) {
                session.confirmed = true;
                later("events", flushEvents, 0);
            }
        });
    }
    function checkDeadline(): boolean {
        var now = clock();
        if (now === null) return false;
        if (!session) return true;
        var deadline = Math.min(session.deadline, lastPoll + 10000);
        if (now >= deadline) {
            requireGrant(
                now >= session.deadline ? "lease_expired" : "disconnected"
            );
            return false;
        }
        later(
            "deadline",
            function () {
                checkDeadline();
            },
            deadline - now
        );
        return true;
    }
    function metric(target: any, name: string, value: any): void {
        if (
            name === "paused" ||
            name === "ended" ||
            name === "available" ||
            name === "enabled"
        ) {
            if (typeof value === "boolean") target[name] = value;
        } else if (
            typeof value === "number" &&
            isFinite(value) &&
            value >= 0 &&
            value <= SAFE_INTEGER
        )
            target[name] = value;
    }
    function append(kind: string, code: string, metrics: any): void {
        if (!session || !checkDeadline()) return;
        var now = time();
        if (now === null || !session) return;
        var elapsed = Math.max(0, now - session.started);
        if (elapsed > 600000) return;
        session.buffer.append(
            JSON.stringify({
                code: code,
                elapsed_ms: elapsed,
                kind: kind,
                metrics: metrics,
            })
        );
    }
    function event(value: any): void {
        if (!session || !value || typeof value !== "object") return;
        var metrics: any = {};
        var data =
            value.data && typeof value.data === "object" ? value.data : {};
        if (
            value.cat === "video" &&
            /^(waiting|playing|stalled|ended|error|canplay)$/.test(value.msg)
        ) {
            metric(metrics, "errorCode", data.code);
            append(
                "playback",
                value.msg === "canplay" ? "ready" : value.msg,
                metrics
            );
        } else if (
            value.cat === "hls" &&
            /^(ERROR|ERROR fatal)$/.test(value.msg)
        )
            append("playback", "error", metrics);
        else if (
            capabilities.indexOf("network") >= 0 &&
            value.cat === "net" &&
            /^(xhr status|xhr error)$/.test(value.msg)
        ) {
            metric(metrics, "httpStatus", data.status);
            append("network", "error", metrics);
        } else if (
            capabilities.indexOf("network") >= 0 &&
            value.cat === "hls" &&
            value.msg === "FRAG_LOADED"
        ) {
            metric(metrics, "loadedBytes", data.size);
            metric(metrics, "latencyMs", data.loadMs);
            append("network", "sample", metrics);
        }
    }
    function sample(): void {
        if (!session || !checkDeadline()) return;
        var owned = session;
        try {
            var value = options.snapshot();
            var metrics: any = {};
            if (value && typeof value === "object") {
                ["available", "enabled"].forEach(function (key) {
                    metric(metrics, key, value[key]);
                });
                var counters = value.counters || {};
                [
                    "errors",
                    "dropped",
                    "recoveries",
                    "stalls",
                    "waiting",
                ].forEach(function (key) {
                    metric(metrics, key, counters[key]);
                });
                var video = value.video || {};
                [
                    "bufferAhead",
                    "currentTime",
                    "droppedFrames",
                    "errorCode",
                    "networkState",
                    "readyState",
                    "paused",
                    "ended",
                ].forEach(function (key) {
                    metric(metrics, key, video[key]);
                });
                metric(metrics, "height", video.videoHeight);
                metric(metrics, "width", video.videoWidth);
            }
            if (session === owned) append("playback", "sample", metrics);
        } catch (_) {}
        function sampleOptional(
            kind: string,
            read: (() => any) | undefined,
            keys: string[]
        ): void {
            if (!read || capabilities.indexOf(kind) < 0 || session !== owned)
                return;
            try {
                var value = read();
                if (!value || typeof value !== "object") return;
                var metrics: any = {};
                keys.forEach(function (key) {
                    metric(metrics, key, value[key]);
                });
                if (session === owned) append(kind, "sample", metrics);
            } catch (_) {}
        }
        sampleOptional("input", options.inputSnapshot, [
            "available",
            "enabled",
            "inputEvents",
            "inputListeners",
        ]);
        sampleOptional("epg", options.epgSnapshot, [
            "available",
            "enabled",
            "epgEntries",
            "epgPending",
            "epgErrors",
        ]);
        if (session === owned) later("sample", sample, 1000);
    }
    function flushEvents(): void {
        if (!session || !session.confirmed || !checkDeadline()) return;
        var owned = session;
        if (!owned.batch) {
            var prefix =
                '{"runtime_id":' +
                JSON.stringify(runtimeId) +
                ',"session_id":' +
                JSON.stringify(owned.id) +
                ',"first_seq":';
            var overhead =
                diagnosticBytes(prefix) +
                String(SAFE_INTEGER).length +
                ',"events":[]}'.length;
            var page = owned.buffer.read(
                owned.acknowledged,
                limits.batch,
                limits.body - overhead - limits.batch
            );
            if (!page.entries.length) {
                later("events", flushEvents, 2000);
                return;
            }
            owned.batch =
                prefix +
                page.entries[0].sequence +
                ',"events":[' +
                page.entries
                    .map(function (entry) {
                        return entry.payload;
                    })
                    .join(",") +
                "]}";
            owned.batchLast = page.entries[page.entries.length - 1].sequence;
            if (diagnosticBytes(owned.batch) > limits.body) {
                requireGrant("invalid_control");
                return;
            }
        }
        send(
            "events",
            "/events",
            owned.batch,
            runtimeCredential,
            function (reply) {
                var data = response(reply, [
                    "session_inactive",
                    "session_terminal",
                ]);
                if (session !== owned || !config || !config.enabled) return;
                if (data && reply!.status === 409) {
                    retireOperation();
                    return;
                }
                if (!data) {
                    later("events", flushEvents, backoff(++eventFailures));
                    return;
                }
                if (
                    reply!.status !== 200 ||
                    !diagnosticObject(data, [
                        "diagnostics_protocol",
                        "server_epoch",
                        "accepted_through_seq",
                        "dropped_total",
                    ]) ||
                    data.accepted_through_seq !== owned.batchLast ||
                    !diagnosticInteger(data.dropped_total, SAFE_INTEGER)
                ) {
                    requireGrant("invalid_control");
                    return;
                }
                owned.acknowledged = owned.batchLast;
                owned.batch = "";
                eventFailures = 0;
                later("events", flushEvents, 2000);
            }
        );
    }
    function apply(data: any, issued: number): void {
        if (!config || !config.enabled) return;
        if (
            !diagnosticObject(data, [
                "diagnostics_protocol",
                "server_epoch",
                "runtime_id",
                "poll_after_ms",
                "control_revision",
                "control",
            ]) ||
            data.runtime_id !== runtimeId ||
            !diagnosticInteger(data.poll_after_ms, 3000, 1) ||
            !diagnosticInteger(data.control_revision, SAFE_INTEGER) ||
            data.control_revision < revision
        ) {
            requireGrant("invalid_control");
            return;
        }
        var control = data.control;
        if (control === null) {
            if (data.control_revision !== revision)
                requireGrant("invalid_control");
            return;
        }
        if (
            !diagnosticObject(
                control,
                [
                    "request_id",
                    "session_id",
                    "action",
                    "consent_epoch",
                    "lease_ms",
                    "profile",
                ],
                [
                    "request_id",
                    "session_id",
                    "action",
                    "consent_epoch",
                    "lease_ms",
                ]
            ) ||
            !diagnosticLabel(control.request_id) ||
            !diagnosticLabel(control.session_id) ||
            control.consent_epoch !== config.consentEpoch ||
            (control.action !== "start" && control.action !== "stop") ||
            !diagnosticInteger(control.lease_ms, limits.session) ||
            (control.action === "start" && control.profile !== "standard") ||
            (control.profile !== undefined && control.profile !== "standard")
        ) {
            requireGrant("invalid_control");
            return;
        }
        var signature = JSON.stringify([
            control.request_id,
            control.session_id,
            control.action,
            control.consent_epoch,
            control.profile || "",
        ]);
        if (data.control_revision === revision) {
            if (signature !== controlSignature) requireGrant("invalid_control");
            return; // Replay confirms connectivity, never renews the original lease.
        }
        revision = data.control_revision;
        controlSignature = signature;
        clearSession();
        if (control.action === "stop") {
            notify("idle");
            record(control, "applied");
            return;
        }
        var now = clock();
        if (now === null) return;
        if (issued + control.lease_ms <= now) {
            record(control, "rejected", "lease_expired");
            requireGrant("lease_expired");
            return;
        }
        var owned = {
            acknowledged: 0,
            batch: "",
            batchLast: 0,
            buffer: createDiagnosticBuffer({
                maxBytes: 256 * 1024,
                maxEntries: 256,
                maxEventBytes: limits.event,
            }),
            confirmed: false,
            deadline: issued + control.lease_ms,
            id: control.session_id,
            release: null as (() => void) | null,
            request: control.request_id,
            revision: revision,
            started: issued,
            startResult: "",
        };
        session = owned;
        try {
            var release = options.capture(
                function (value) {
                    if (session === owned) event(value);
                },
                function () {
                    if (session === owned) requireGrant("local_stop");
                }
            );
            if (session !== owned) {
                release();
                return;
            }
            owned.release = release;
        } catch (_) {
            clearSession();
            record(control, "unsupported", "unsupported");
            requireGrant("unsupported");
            return;
        }
        append("lifecycle", "start", {});
        sample();
        if (session !== owned || !config || !config.enabled) return;
        notify("active");
        record(control, "applied");
    }
    function poll(): void {
        if (
            !config ||
            !config.enabled ||
            !runtimeCredential ||
            !checkDeadline()
        )
            return;
        if (pollSequence >= SAFE_INTEGER - 1) {
            requireGrant("invalid_control");
            return;
        }
        var issued = clock();
        if (issued === null) return;
        var issuedAt: number = issued;
        send(
            "poll",
            "/poll",
            JSON.stringify({
                consent: { epoch: config.consentEpoch, granted: true },
                last_control_revision: revision,
                poll_seq: ++pollSequence,
                runtime_id: runtimeId,
            }),
            runtimeCredential,
            function (reply) {
                if (!checkDeadline()) return;
                var data = response(reply);
                if (!config || !config.enabled) return;
                if (!data) {
                    later("control", poll, backoff(++controlFailures));
                    return;
                }
                if (reply!.status !== 200) {
                    requireGrant("invalid_control");
                    return;
                }
                var now = clock();
                if (now === null) return;
                lastPoll = now;
                if (repair) repairLive(repair);
                if (!config || !config.enabled) return;
                if (
                    !repairLoopStarted &&
                    capabilities.indexOf("repairs") >= 0
                ) {
                    repairLoopStarted = true;
                    later("repairPoll", pollRepair, 0);
                }
                controlFailures = 0;
                apply(data, issuedAt);
                if (!config || !config.enabled || !checkDeadline()) return;
                later(
                    "control",
                    poll,
                    session
                        ? Math.min(1000, data.poll_after_ms)
                        : Math.min(3000, data.poll_after_ms)
                );
            }
        );
    }
    function clearRepair(): void {
        var previous = repair;
        repair = null;
        clearTimer("repairDeadline");
        clearTimer("repairResult");
        cancelLane("repairResult");
        if (!previous) return;
        previous.effect = null;
        previous.result = "";
        if (previous.cancel) {
            try {
                previous.cancel();
            } catch (_) {}
        }
    }
    function repairLive(owned: Repair): boolean {
        if (
            repair !== owned ||
            !config ||
            !config.enabled ||
            !runtimeCredential
        )
            return false;
        var now = clock();
        if (now === null || repair !== owned) return false;
        if (now >= owned.deadline) {
            clearRepair();
            return false;
        }
        if (now >= lastPoll + 10000) {
            requireGrant("disconnected");
            return false;
        }
        later(
            "repairDeadline",
            function () {
                repairLive(owned);
            },
            Math.min(owned.deadline, lastPoll + 10000) - now
        );
        return true;
    }
    function flushRepairResult(): void {
        var candidate = repair;
        if (!candidate || !candidate.result || !repairLive(candidate)) return;
        var owned: Repair = candidate;
        var body = owned.result;
        send(
            "repairResult",
            "/repairs/results",
            body,
            runtimeCredential,
            function (reply) {
                if (!repairLive(owned)) return;
                var data = response(reply, ["repair_terminal"]);
                if (!repairLive(owned)) return;
                if (data && reply!.status === 409) {
                    clearRepair();
                    return;
                }
                if (!data) {
                    later(
                        "repairResult",
                        flushRepairResult,
                        backoff(++owned.failures)
                    );
                    return;
                }
                if (
                    reply!.status !== 200 ||
                    !diagnosticObject(data, [
                        "diagnostics_protocol",
                        "server_epoch",
                        "status",
                    ]) ||
                    data.status !== "recorded"
                ) {
                    requireGrant("invalid_control");
                    return;
                }
                // Remove the callback before invoking it. A synchronous stop/re-entry cannot repeat it.
                var effect = owned.effect;
                owned.effect = null;
                if (effect && repairLive(owned)) {
                    try {
                        effect();
                    } catch (_) {}
                }
                if (repair === owned) clearRepair();
            }
        );
    }
    function applyRepair(value: any, issued: number): void {
        if (!config || !config.enabled) return;
        if (value === null) return;
        if (
            !diagnosticObject(value, [
                "repair_id",
                "action",
                "consent_epoch",
                "lease_ms",
            ]) ||
            !diagnosticLabel(value.repair_id) ||
            value.consent_epoch !== config.consentEpoch ||
            (value.action !== "restart_stream" &&
                value.action !== "reload_player") ||
            !diagnosticInteger(value.lease_ms, 30000)
        ) {
            requireGrant("invalid_control");
            return;
        }
        var seen = repairHistory[value.repair_id];
        if (seen) {
            if (seen !== value.action) {
                requireGrant("invalid_control");
                return;
            }
            if (repair && repair.id === value.repair_id) {
                repair.deadline = Math.min(
                    repair.deadline,
                    issued + value.lease_ms
                );
                repairLive(repair);
            }
            return;
        }
        // Retired IDs are never evicted while their runtime credential remains valid.
        if (repairCount >= 256) {
            requireGrant("disconnected");
            return;
        }
        // The server can accept the next repair after recording a result whose
        // HTTP ACK has not reached us. Retire its unconfirmed intent (especially
        // a deferred reload), retain its ID, and never execute it on a late ACK.
        if (repair) clearRepair();
        repairHistory[value.repair_id] = value.action;
        repairCount++;
        var owned: Repair = {
            action: value.action,
            cancel: null,
            deadline: issued + value.lease_ms,
            effect: null,
            failures: 0,
            id: value.repair_id,
            result: "",
        };
        repair = owned;
        if (!repairLive(owned)) return;
        function complete(status: RemoteRepairStatus): void {
            if (!repairLive(owned) || owned.result) return;
            if (
                status !== "rejected" &&
                status !== "unsupported" &&
                !(owned.action === "restart_stream" && status === "applied") &&
                !(
                    owned.action === "reload_player" &&
                    status === "accepted" &&
                    owned.effect
                )
            ) {
                // An invalid local receipt cannot prove whether an effect occurred.
                clearRepair();
                return;
            }
            if (status !== "accepted") owned.effect = null;
            owned.result = JSON.stringify({
                repair_id: owned.id,
                runtime_id: runtimeId,
                status: status,
            });
            flushRepairResult();
        }
        try {
            var cancel = options.executeRepair!(
                owned.action,
                complete,
                function (effect) {
                    if (
                        repairLive(owned) &&
                        owned.action === "reload_player" &&
                        !owned.result &&
                        !owned.effect &&
                        typeof effect === "function"
                    )
                        owned.effect = effect;
                }
            );
            if (typeof cancel === "function") {
                if (repair === owned) owned.cancel = cancel;
                else {
                    try {
                        cancel();
                    } catch (_) {}
                }
            }
        } catch (_) {
            // Execution may have partially happened. Preserve deduplication and let
            // the server deadline express an unconfirmed outcome, never replay it.
            if (repair === owned) clearRepair();
        }
    }
    function pollRepair(): void {
        if (
            !config ||
            !config.enabled ||
            !runtimeCredential ||
            capabilities.indexOf("repairs") < 0
        )
            return;
        var issued = clock();
        if (issued === null) return;
        if (issued >= lastPoll + 10000) {
            requireGrant("disconnected");
            return;
        }
        var issuedAt: number = issued;
        send(
            "repairPoll",
            "/repairs/poll",
            JSON.stringify({ runtime_id: runtimeId }),
            runtimeCredential,
            function (reply) {
                var data = response(reply);
                if (!config || !config.enabled) return;
                if (data) {
                    if (
                        reply!.status !== 200 ||
                        !diagnosticObject(data, [
                            "diagnostics_protocol",
                            "server_epoch",
                            "repair",
                        ])
                    ) {
                        requireGrant("invalid_control");
                        return;
                    }
                    applyRepair(data.repair, issuedAt);
                }
                if (config && config.enabled)
                    later("repairPoll", pollRepair, 3000);
            }
        );
    }
    function configure(next: RemoteDiagnosticsConfig): void {
        var old = config;
        if (
            old &&
            old.enabled &&
            next.enabled &&
            old.address === next.address &&
            old.token === next.token &&
            old.consentEpoch === next.consentEpoch &&
            old.instanceId === next.instanceId &&
            old.bootId === next.bootId &&
            old.reportedUuid === next.reportedUuid
        )
            return;
        if (old && old.enabled) stop("consent_revoked");
        else {
            generation++;
            Object.keys(timers).forEach(clearTimer);
            Object.keys(lanes).forEach(cancelLane);
            clearSession();
        }
        config = null;
        runtimeId =
            runtimeCredential =
            serverEpoch =
            controlSignature =
            pendingResult =
                "";
        repairLoopStarted = false;
        repairHistory = Object.create(null);
        repairCount = 0;
        clearRepair();
        revision =
            pollSequence =
            controlFailures =
            registrationFailures =
            resultFailures =
                0;
        if (!next.enabled) {
            notify("disabled");
            return;
        }
        if (
            !diagnosticLabel(next.consentEpoch) ||
            next.consentEpoch === blockedEpoch ||
            !diagnosticLabel(next.instanceId) ||
            !diagnosticLabel(next.bootId) ||
            (next.reportedUuid !== undefined &&
                !diagnosticLabel(next.reportedUuid)) ||
            !diagnosticToken(next.token) ||
            !capabilities.length ||
            capabilities.length > 5 ||
            capabilities.some(function (item, index) {
                return (
                    ["playback", "network", "input", "epg", "repairs"].indexOf(
                        item
                    ) < 0 || capabilities.indexOf(item) !== index
                );
            })
        ) {
            notify("regrant_required", "consent_revoked");
            return;
        }
        try {
            base = diagnosticBase(next.address);
        } catch (_) {
            notify("regrant_required", "unsupported");
            return;
        }
        config = {
            address: next.address,
            bootId: next.bootId,
            consentEpoch: next.consentEpoch,
            enabled: true,
            instanceId: next.instanceId,
            token: next.token,
        };
        if (next.reportedUuid !== undefined)
            config.reportedUuid = next.reportedUuid;
        blockedEpoch = "";
        if (clock() === null) return;
        register();
    }
    return { configure: configure, snapshot: snapshot, stop: stop };
}
