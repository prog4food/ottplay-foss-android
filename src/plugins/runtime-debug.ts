/** Fixed, bounded observations owned by the enabled remote connection. */
interface DebugConfig {
    address: string;
    enabled: boolean;
    token: string;
}
interface DebugDependencies {
    getConfig(): DebugConfig;
    native?(): Promise<any>;
    runtime(): string;
}
const DEBUG_MAX = 9007199254740991;
const NATIVE_NUMBERS = (
    "uptimeMs systemUptimeMs residentBytes pssBytes footprintBytes heapUsedBytes " +
    "heapLimitBytes systemAvailableBytes systemTotalBytes thermalState logicalProcessors " +
    "nativeHlsSessions nativeHlsBytes nativeHlsErrors epgChannels epgProgrammes " +
    "epgMappings epgShifts requestsTotal requestsActive requestsFailed"
).split(" ");
const NATIVE_BOOLS = ["lowMemory", "foreground", "lowPower"];
function finite(value: any, max = DEBUG_MAX): boolean {
    return (
        typeof value === "number" &&
        isFinite(value) &&
        value >= 0 &&
        value <= max
    );
}
function debugInteger(value: any): boolean {
    return finite(value) && Math.floor(value) === value;
}
function playbackAttempt(value: any, retired = false): any {
    if (!value) return null;
    var result: any = {};
    var valid =
        "attachment engineStarts fatalErrors nativeFallbacks streamRetries"
            .split(" ")
            .every(function (key) {
                result[key] = value[key];
                return debugInteger(value[key]);
            });
    if (retired) {
        result.handleId = value.handleId;
        result.generation = value.generation;
        result.reason = value.reason;
        valid =
            valid &&
            debugInteger(value.handleId) &&
            (value.generation === null || debugInteger(value.generation)) &&
            ["ended", "disposed", "suspended"].indexOf(value.reason) >= 0;
    }
    return valid ? result : null;
}
function versionToken(value: any): string | null {
    var match =
        typeof value === "string" && value.match(/^[A-Za-z0-9_.+\-]{1,64}$/);
    return match && match[0] === value ? value : null;
}
/** Native values are untrusted too; never copy arbitrary objects into reports. */
export function projectNativeDebug(value: any): any {
    if (
        !value ||
        value.version !== 1 ||
        ["android", "ios", "tauri", "server"].indexOf(value.platform) < 0 ||
        !value.metrics ||
        typeof value.metrics !== "object" ||
        Array.isArray(value.metrics)
    )
        return null;
    var metrics: any = {};
    NATIVE_NUMBERS.forEach(function (key) {
        var sample = value.metrics[key];
        if (finite(sample)) metrics[key] = sample;
    });
    NATIVE_BOOLS.forEach(function (key) {
        var sample = value.metrics[key];
        if (typeof sample === "boolean") metrics[key] = sample;
    });
    return {
        appVersion: versionToken(value.appVersion),
        metrics: metrics,
        osVersion: versionToken(value.osVersion),
        platform: value.platform,
        version: 1,
        webviewVersion: versionToken(value.webviewVersion),
    };
}

export function installRuntimeDebug(w: any, deps: DebugDependencies): any {
    var binding: DebugConfig | null = null;
    var epoch = 0;
    var disposed = false;
    var suspended = false;
    var timer: any = null;
    var started = 0;
    var previousTick = 0;
    var lastClock = 0;
    var sequence = 0;
    var dropped = 0;
    var events: any[] = [];
    var counters: any = {};
    var listeners: Array<() => void> = [];
    // The slot stays occupied until native completion, even after our deadline.
    var nativePending = false;
    var cancelRead: (() => void) | null = null;

    function clock(): number {
        var value: any;
        try {
            value = w.performance.now();
        } catch (_) {
            value = Date.now();
        }
        if (!finite(value)) value = lastClock;
        lastClock = Math.max(lastClock, value);
        return lastClock;
    }
    function platform(): string {
        try {
            if (w.__TAURI__) return "tauri";
            var cap = w.Capacitor;
            if (cap && (!cap.isNativePlatform || cap.isNativePlatform())) {
                var name = cap.getPlatform && cap.getPlatform();
                if (name === "android" || name === "ios")
                    return "capacitor-" + name;
            }
            if (w.ott_device === "lg/webos" || w.webOS) return "webos";
        } catch (_) {
            return "unknown";
        }
        return "browser";
    }
    function same(a: DebugConfig | null, b: DebugConfig | null): boolean {
        return (
            a === b ||
            !!(
                a &&
                b &&
                a.enabled === b.enabled &&
                a.address === b.address &&
                a.token === b.token
            )
        );
    }
    function config(): DebugConfig | null {
        try {
            var c = deps.getConfig();
            if (!disposed && c && c.enabled === true && c.address && c.token)
                return { address: c.address, enabled: true, token: c.token };
        } catch (_) {
            /* Disabled until a valid connection can be read. */
        }
        return null;
    }
    function clearTimer(): void {
        if (timer !== null) w.clearTimeout(timer);
        timer = null;
    }
    function retire(): void {
        epoch++;
        clearTimer();
        listeners.forEach(function (remove) {
            remove();
        });
        listeners = [];
        if (cancelRead) cancelRead();
        cancelRead = null;
        events = [];
        counters = {};
        sequence = dropped = 0;
        suspended = false;
        binding = null;
    }
    function record(code: string): void {
        if (!binding || !same(binding, config())) return;
        if (sequence === DEBUG_MAX) {
            dropped = Math.min(DEBUG_MAX, dropped + 1);
            return;
        }
        sequence++;
        events.push({
            code: code,
            elapsedMs: clock() - started,
            sequence: sequence,
        });
        if (events.length > 32) {
            events.shift();
            dropped = Math.min(DEBUG_MAX, dropped + 1);
        }
    }
    function count(key: string): void {
        counters[key] = Math.min(DEBUG_MAX, (counters[key] || 0) + 1);
    }
    function listen(
        target: any,
        type: string,
        action: (event: any) => void,
        capture = false
    ): void {
        if (!target || typeof target.addEventListener !== "function") return;
        target.addEventListener(type, action, capture);
        listeners.push(function () {
            target.removeEventListener(type, action, capture);
        });
    }
    function visible(): boolean {
        return !!(w.document && w.document.visibilityState === "visible");
    }
    function tick(): void {
        timer = null;
        var generation = epoch;
        if (!sync() || suspended || generation !== epoch) return;
        var now = clock();
        if (visible() && previousTick) {
            var delay = Math.max(0, now - previousTick - 1000);
            counters.loopDelayMs = delay;
            counters.loopMaxDelayMs = Math.max(
                counters.loopMaxDelayMs || 0,
                delay
            );
            count("loopSamples");
            if (delay >= 250) {
                count("loopLongDelays");
                record("loop_delay");
            }
        }
        previousTick = visible() ? now : 0;
        timer = w.setTimeout(tick, 1000);
    }
    function begin(): void {
        started = clock();
        previousTick = 0;
        counters = {
            errorCount: 0,
            loopLongDelays: 0,
            loopSamples: 0,
            rejectionCount: 0,
        };
        record("started");
        ["online", "offline", "focus", "blur"].forEach(function (type) {
            listen(w, type, function () {
                record(type);
            });
        });
        listen(w, "error", function () {
            count("errorCount");
            record("error");
        });
        listen(w, "unhandledrejection", function () {
            count("rejectionCount");
            record("unhandled_rejection");
        });
        listen(w.document, "visibilitychange", function () {
            previousTick = 0;
            record(visible() ? "visible" : "hidden");
        });
        listen(w, "pagehide", function () {
            record("suspended");
            suspended = true;
            previousTick = 0;
            clearTimer();
            if (cancelRead) cancelRead();
        });
        listen(w, "pageshow", function () {
            if (!sync()) return;
            suspended = false;
            previousTick = 0;
            record("resumed");
            clearTimer();
            timer = w.setTimeout(tick, 1000);
        });
        ["error", "waiting", "stalled", "playing", "ended"].forEach(
            function (type) {
                listen(
                    w.document,
                    type,
                    function (event: any) {
                        var target = event && event.target;
                        if (
                            target &&
                            (target === element("video") ||
                                target === element("videopip"))
                        )
                            record("media_" + type);
                    },
                    true
                );
            }
        );
        timer = w.setTimeout(tick, 1000);
    }
    function sync(): boolean {
        var next = config();
        if (!same(binding, next)) {
            retire();
            binding = next;
            if (binding) begin();
        }
        return !!binding;
    }
    function element(id: string): any {
        try {
            return w.document.getElementById(id);
        } catch (_) {
            return null;
        }
    }
    function put(out: any, key: string, value: any, max = DEBUG_MAX): void {
        if (finite(value, max)) out[key] = value;
    }
    function bool(out: any, key: string, value: any): void {
        if (typeof value === "boolean") out[key] = value;
    }
    function media(version: number): any[] {
        var result: any[] = [];
        ["main", "pip"].forEach(function (lane, index) {
            var node = element(index ? "videopip" : "video");
            if (!node) return;
            var metrics: any = {};
            var generation: number | null = null;
            var handleId: number | null = null;
            var engine: string | null = null;
            var attempt: any = null;
            var lastAttempt: any = null;
            try {
                var playback =
                    w.__ottClassicPlayback && w.__ottClassicPlayback.snapshot();
                if (
                    lane === "main" &&
                    playback &&
                    finite(playback.generation) &&
                    Math.floor(playback.generation) === playback.generation
                )
                    generation = playback.generation;
                var backend =
                    w.__ottCoreBackendPeek && w.__ottCoreBackendPeek();
                var handle = backend && backend.current(lane);
                if (
                    handle &&
                    finite(handle.id) &&
                    Math.floor(handle.id) === handle.id
                )
                    handleId = handle.id;
                var attached =
                    handle &&
                    handle.diagnosticEngine &&
                    handle.diagnosticEngine();
                if (
                    attached === "hls.js" ||
                    attached === "shaka" ||
                    attached === "html5"
                )
                    engine = attached;
                if (version === 3 && handle && handle.diagnosticAttempt) {
                    attempt = playbackAttempt(handle.diagnosticAttempt());
                }
                if (version === 3 && backend && backend.lastAttempt)
                    lastAttempt = playbackAttempt(
                        backend.lastAttempt(lane),
                        true
                    );
            } catch (_) {
                /* A missing owner does not prevent element observations. */
            }
            try {
                put(metrics, "positionSeconds", node.currentTime);
                put(metrics, "durationSeconds", node.duration);
                put(metrics, "videoWidth", node.videoWidth);
                put(metrics, "videoHeight", node.videoHeight);
                put(metrics, "readyState", node.readyState, 4);
                put(metrics, "networkState", node.networkState, 3);
                put(metrics, "volume", node.volume, 1);
                if (node.error)
                    put(metrics, "mediaErrorCode", node.error.code, 4);
                ["paused", "ended", "muted", "seeking"].forEach(function (key) {
                    bool(metrics, key, node[key]);
                });
                var quality =
                    node.getVideoPlaybackQuality &&
                    node.getVideoPlaybackQuality();
                if (quality) {
                    put(metrics, "totalFrames", quality.totalVideoFrames);
                    put(metrics, "droppedFrames", quality.droppedVideoFrames);
                    put(
                        metrics,
                        "corruptedFrames",
                        quality.corruptedVideoFrames
                    );
                } else {
                    put(metrics, "decodedFrames", node.webkitDecodedFrameCount);
                    put(metrics, "droppedFrames", node.webkitDroppedFrameCount);
                }
                var ranges = node.buffered;
                if (
                    ranges &&
                    finite(ranges.length, 256) &&
                    finite(node.currentTime)
                ) {
                    var ahead = 0;
                    for (var i = 0; i < ranges.length; i++)
                        if (
                            ranges.start(i) <= node.currentTime &&
                            ranges.end(i) >= node.currentTime
                        )
                            ahead = Math.max(
                                ahead,
                                ranges.end(i) - node.currentTime
                            );
                    put(metrics, "bufferAheadSeconds", ahead);
                }
            } catch (_) {
                /* Keep only fields already observed. */
            }
            var observation: any = {
                generation: generation,
                handleId: handleId,
                lane: lane,
                metrics: metrics,
            };
            if (version >= 2) observation.engine = engine;
            if (version === 3) {
                observation.attempt = attempt;
                observation.lastAttempt = lastAttempt;
            }
            result.push(observation);
        });
        return result;
    }
    function sample(version: number): any {
        var metrics: any = {};
        Object.keys(counters).forEach(function (key) {
            put(metrics, key, counters[key]);
        });
        put(metrics, "uptimeMs", clock() - started);
        try {
            var control =
                w.__ottCommandServer && w.__ottCommandServer.debugSnapshot();
            if (control) {
                [
                    "controlPendingRequests",
                    "controlPendingResponses",
                    "controlConsecutiveFailures",
                ].forEach(function (key) {
                    put(metrics, key, control[key]);
                });
                bool(metrics, "controlActive", control.controlActive);
            }
        } catch (_) {
            /* A legacy controller need not implement this producer. */
        }
        try {
            bool(metrics, "online", w.navigator.onLine);
            put(
                metrics,
                "hardwareConcurrency",
                w.navigator.hardwareConcurrency
            );
            put(metrics, "deviceMemoryGiB", w.navigator.deviceMemory);
        } catch (_) {
            /* Unavailable browser APIs stay absent. */
        }
        try {
            var memory = w.performance.memory;
            if (memory) {
                put(metrics, "jsHeapUsedBytes", memory.usedJSHeapSize);
                put(metrics, "jsHeapTotalBytes", memory.totalJSHeapSize);
                put(metrics, "jsHeapLimitBytes", memory.jsHeapSizeLimit);
            }
        } catch (_) {
            /* JS heap inspection is browser-specific. */
        }
        bool(metrics, "secureContext", w.isSecureContext);
        try {
            if (
                w.document.visibilityState === "visible" ||
                w.document.visibilityState === "hidden"
            )
                metrics.visible = visible();
            bool(metrics, "focused", w.document.hasFocus());
        } catch (_) {
            /* A missing document is not measured false. */
        }
        return {
            capturedAt: Date.now(),
            events: events.map(function (e) {
                return {
                    code: e.code,
                    elapsedMs: e.elapsedMs,
                    sequence: e.sequence,
                };
            }),
            eventsDropped: dropped,
            media: media(version),
            metrics: metrics,
            native: { data: null, state: "unsupported" },
            platform: platform(),
            runtime: deps.runtime(),
            version: version,
        };
    }
    function snapshot(version = 1): Promise<any> {
        if (version !== 1 && version !== 2 && version !== 3)
            return Promise.reject(new Error("invalid_request"));
        if (!sync() || suspended)
            return Promise.reject(new Error("unavailable"));
        var result = sample(version);
        var owner = epoch;
        var runtime = result.runtime;
        function resolved(): Promise<any> {
            return Promise.resolve(result).then(function (value) {
                if (
                    owner !== epoch ||
                    !same(binding, config()) ||
                    !binding ||
                    suspended ||
                    runtime !== deps.runtime()
                )
                    throw new Error("unavailable");
                return value;
            });
        }
        if (
            !deps.native ||
            (result.platform !== "tauri" &&
                result.platform.indexOf("capacitor-") !== 0)
        )
            return resolved();
        if (nativePending) {
            result.native.state = "unavailable";
            return resolved();
        }
        nativePending = true;
        return new Promise(function (resolve, reject) {
            var complete = false;
            var timeout: any = null;
            function finish(state: string, data: any): void {
                if (complete) return;
                complete = true;
                if (timeout !== null) w.clearTimeout(timeout);
                cancelRead = null;
                if (
                    owner !== epoch ||
                    !same(binding, config()) ||
                    runtime !== deps.runtime() ||
                    suspended
                ) {
                    reject(new Error("unavailable"));
                    return;
                }
                result.native = { data: data, state: state };
                resolve(result);
            }
            cancelRead = function () {
                finish("unavailable", null);
            };
            timeout = w.setTimeout(function () {
                finish("timeout", null);
            }, 1500);
            try {
                Promise.resolve(deps.native!()).then(
                    function (value) {
                        nativePending = false;
                        var projected: any = null;
                        try {
                            projected = projectNativeDebug(value);
                        } catch (_) {
                            /* Invalid producer. */
                        }
                        var expected =
                            result.platform === "tauri"
                                ? "tauri"
                                : result.platform.slice(10);
                        if (projected && projected.platform !== expected)
                            projected = null;
                        finish(projected ? "available" : "invalid", projected);
                    },
                    function () {
                        nativePending = false;
                        finish("unavailable", null);
                    }
                );
            } catch (_) {
                nativePending = false;
                finish("unavailable", null);
            }
        });
    }
    var api = {
        configurationChanged: sync,
        dispose: function () {
            disposed = true;
            retire();
        },
        snapshot: snapshot,
    };
    return api;
}
