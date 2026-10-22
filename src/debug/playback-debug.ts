/**
 * Playback realtime debug (opt-in). Concat module — no imports; exposes window.__ottDebug.
 * Zero cost when off: intervals/network/HUD only after isDebugEnabled() at boot.
 * HS5-safe: ES5 classic script, full-width wrapping HUD banner (no flex/gap/grid).
 * Multi-port: tags port/origin/playerId on every event; auto-enable via GET /debug/config.
 */

var OTT_DEBUG_RING_MAX = 800;
var OTT_DEBUG_RING_BYTES = 512 * 1024;
var OTT_DEBUG_EVENT_BYTES = 32 * 1024;
var OTT_DEBUG_INGEST_MS = 2000;
var OTT_DEBUG_HUD_MS = 1000;
var OTT_DEBUG_STALL_MS = 3000;
var OTT_DEBUG_STATS_MS = 30000;

function ottDebugIsEnabled(): boolean {
    try {
        if ((window as any).__OTT_DEBUG__ === true) return true;
        if (
            typeof localStorage !== "undefined" &&
            localStorage.getItem("ottplay_debug") === "1"
        )
            return true;
        var q = typeof location !== "undefined" ? location.search || "" : "";
        if (/(?:^\?|&)debug=(?:1|true)(?:&|$)/.test(q)) return true;
    } catch (_e) {}
    return false;
}

type OttDebugCat = "video" | "hls" | "net" | "stall" | "sys";

interface OttDebugEvent {
    cat: OttDebugCat;
    data?: any;
    msg: string;
    origin?: string;
    playerId?: string;
    port?: string;
    session: string;
    t: number;
    ua?: string;
}

var _ottDbgEnabled = false;
var _ottDbgRing: OttDebugEvent[] = [];
var _ottDbgRingSizes: number[] = [];
var _ottDbgRingBytes = 0;
var _ottDbgDropped = 0;
var _ottDbgSession = "";
var _ottDbgPlayerId = "";
var _ottDbgHudOn = true;
var _ottDbgHudEl: HTMLElement | null = null;
var _ottDbgHudTimer: ReturnType<typeof setInterval> | null = null;
var _ottDbgIngestTimer: ReturnType<typeof setInterval> | null = null;
var _ottDbgStatsTimer: ReturnType<typeof setInterval> | null = null;
var _ottDbgPending: OttDebugEvent[] = [];
var _ottDbgHls: any = null;
var _ottDbgVideo: HTMLVideoElement | null = null;
var _ottDbgStallTimer: ReturnType<typeof setTimeout> | null = null;
var _ottDbgStallSince = 0;
var _ottDbgLastError = "";
var _ottDbgLastDecodedBytes = 0;
var _ottDbgLastMbps = 0;

// Extended counters (flushed as periodic stats events)
var _ottDbgStallCount = 0;
var _ottDbgStallTotalMs = 0;
var _ottDbgStallMaxMs = 0;
var _ottDbgLastStallMs = 0;
var _ottDbgWaitingCount = 0;
var _ottDbgErrorCount = 0;
var _ottDbgRecoverCount = 0;
var _ottDbgSampleBufAhead = -1;
var _ottDbgSampleBw = -1;
var _ottDbgSampleLevel = -1;
var _ottDbgLocal = false;
var _ottDbgGeneration = 0;
var _ottDbgCleanup: (() => void)[] = [];
var _ottDbgXhrCleanup: (() => void)[] = [];
var _ottDbgHlsCleanup: (() => void) | null = null;
var _ottDbgCaptures: {
    event: (event: OttDebugEvent) => void;
    stopped?: () => void;
}[] = [];

function ottDebugListen(target: any, name: string, listener: any): void {
    if (!target || typeof target.addEventListener !== "function") return;
    target.addEventListener(name, listener, false);
    _ottDbgCleanup.push(function () {
        target.removeEventListener(name, listener, false);
    });
}

function ottDebugDetachHls(): void {
    var detach = _ottDbgHlsCleanup;
    _ottDbgHlsCleanup = null;
    _ottDbgHls = null;
    if (detach) detach();
    _ottDbgXhrCleanup.slice().forEach(function (dispose) {
        dispose();
    });
}

function ottDebugDeliver(event: OttDebugEvent): void {
    _ottDbgCaptures.slice().forEach(function (capture) {
        if (_ottDbgCaptures.indexOf(capture) < 0) return;
        try {
            // A consumer cannot mutate the local ring or another consumer's event.
            capture.event(JSON.parse(JSON.stringify(event)));
        } catch (_error) {}
    });
}

function ottDebugShortId(): string {
    return Math.random().toString(36).slice(2, 8);
}

function ottDebugPort(): string {
    try {
        if (typeof location === "undefined") return "";
        if (location.port) return String(location.port);
        if (location.protocol === "https:") return "443";
        if (location.protocol === "http:") return "80";
    } catch (_e) {}
    return "";
}

function ottDebugOrigin(): string {
    try {
        if (typeof location !== "undefined" && location.origin)
            return String(location.origin);
    } catch (_e) {}
    return "";
}

function ottDebugUaShort(): string {
    try {
        var ua =
            typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
        if (!ua) return "";
        // Keep short: browser family + OS hint
        var m = ua.match(/(Chrome|Firefox|Safari|Edg|OPR)\/[\d.]+/);
        var browser = m ? m[0] : ua.substring(0, 24);
        var os = "";
        if (ua.indexOf("Macintosh") !== -1) os = "mac";
        else if (ua.indexOf("Windows") !== -1) os = "win";
        else if (ua.indexOf("Android") !== -1) os = "and";
        else if (ua.indexOf("iPhone") !== -1 || ua.indexOf("iPad") !== -1)
            os = "ios";
        else if (ua.indexOf("Linux") !== -1) os = "linux";
        return os ? browser + "/" + os : browser;
    } catch (_e2) {
        return "";
    }
}

function ottDebugEnsurePlayerId(): string {
    if (_ottDbgPlayerId) return _ottDbgPlayerId;
    try {
        if (typeof sessionStorage !== "undefined") {
            var existing = sessionStorage.getItem("ottplay_player_id");
            if (existing) {
                _ottDbgPlayerId = existing;
                return _ottDbgPlayerId;
            }
            var id = "p" + ottDebugShortId();
            sessionStorage.setItem("ottplay_player_id", id);
            _ottDbgPlayerId = id;
            return _ottDbgPlayerId;
        }
    } catch (_e) {}
    _ottDbgPlayerId = "p" + ottDebugShortId();
    return _ottDbgPlayerId;
}

function ottDebugTagEvent(ev: OttDebugEvent): OttDebugEvent {
    ev.port = ottDebugPort();
    ev.origin = ottDebugOrigin();
    ev.playerId = ottDebugEnsurePlayerId();
    var ua = ottDebugUaShort();
    if (ua) ev.ua = ua;
    return ev;
}

function ottDebugRedactText(text: string): string {
    if (text.length > 16384) return "[truncated]";
    // Paths may contain Xtream credentials, so retain only the authority.
    return text
        .replace(/(portal::(?:\[|%5b)key:)[\s\S]*?(\]|%5d)/gi, "$1[redacted]$2")
        .replace(/\b(?:https?|rtsp|rtmp):\/\/[^\s"'<>\\]+/gi, function (url) {
            var match = /^(https?):\/\/([^/?#]+)/i.exec(url);
            if (!match) return "[redacted URL]";
            return (
                match[1] + "://" + match[2].replace(/^.*@/, "") + "/[redacted]"
            );
        })
        .replace(
            /\b(?:username|user|password|passwd|pwd|token|access_token|refresh_token|secret|authorization|api[_-]?key)(?:=|%3d|:)\s*[^\s&"'<>]+/gi,
            "[redacted]"
        )
        .replace(/\b(?:Bearer|Basic)\s+[a-z0-9_~+./=-]+/gi, "[redacted]");
}

function ottDebugRedact(
    value: unknown,
    depth = 0,
    budget = { nodes: 256 }
): unknown {
    if (depth > 8 || budget.nodes-- <= 0) return "[truncated]";
    if (typeof value === "string")
        return ottDebugRedactText(value).slice(0, 2048);
    if (Array.isArray(value)) {
        return value.slice(0, 32).map(function (item) {
            return ottDebugRedact(item, depth + 1, budget);
        });
    }
    if (value && typeof value === "object") {
        var result: Record<string, unknown> = {};
        var keys = 0;
        for (var key in value) {
            if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
            if (++keys > 32 || budget.nodes <= 0) break;
            if (
                key.length > 80 ||
                key === "__proto__" ||
                key === "constructor" ||
                key === "toJSON"
            )
                continue;
            try {
                result[key] =
                    /^(user|pwd|cookie|setcookie|key|auth|credentials?|signature|sig)$|password|passwd|secret|token|authorization|username|apikey/i.test(
                        key.replace(/[-_]/g, "")
                    )
                        ? "[redacted]"
                        : ottDebugRedact(
                              (value as Record<string, unknown>)[key],
                              depth + 1,
                              budget
                          );
            } catch (_error) {
                result[key] = "[unavailable]";
            }
        }
        return result;
    }
    if (
        value === null ||
        typeof value === "boolean" ||
        (typeof value === "number" && isFinite(value))
    )
        return value;
    return "[unavailable]";
}

function ottDebugStore(event: OttDebugEvent): boolean {
    var bytes = ottDebugBodyBytes(JSON.stringify(event));
    if (bytes > OTT_DEBUG_EVENT_BYTES) {
        _ottDbgDropped++;
        return false;
    }
    while (
        _ottDbgRing.length &&
        (_ottDbgRing.length >= OTT_DEBUG_RING_MAX ||
            _ottDbgRingBytes + bytes > OTT_DEBUG_RING_BYTES)
    ) {
        _ottDbgRing.shift();
        _ottDbgRingBytes -= _ottDbgRingSizes.shift() || 0;
        _ottDbgDropped++;
    }
    _ottDbgRing.push(event);
    _ottDbgRingSizes.push(bytes);
    _ottDbgRingBytes += bytes;
    return true;
}

function ottDebugPush(cat: OttDebugCat, msg: string, data?: any): void {
    if (!_ottDbgEnabled) return;
    var ev: OttDebugEvent = ottDebugTagEvent({
        cat: cat,
        msg: ottDebugRedactText(msg).slice(0, 2048),
        session: _ottDbgSession || "-",
        t: Date.now(),
    });
    if (data !== undefined) ev.data = ottDebugRedact(data);
    if (!ottDebugStore(ev)) return;
    if (_ottDbgLocal) _ottDbgPending.push(ev);
    ottDebugDeliver(ev);
    if (
        cat === "stall" ||
        cat === "sys" ||
        msg === "error" ||
        msg === "stats" ||
        msg.indexOf("fatal") !== -1
    ) {
        ottDebugFlushIngest();
    }
}

function ottDebugDump(): string {
    var lines: string[] = [];
    for (var i = 0; i < _ottDbgRing.length; i++) {
        var e = _ottDbgRing[i];
        var extra = e.data !== undefined ? " " + JSON.stringify(e.data) : "";
        var tag =
            (e.port ? " :" + e.port : "") +
            (e.playerId ? " " + e.playerId : "");
        lines.push(
            e.t + " [" + e.session + tag + "] " + e.cat + " " + e.msg + extra
        );
    }
    return lines.join("\n");
}

function ottDebugClear(): void {
    _ottDbgRing = [];
    _ottDbgRingSizes = [];
    _ottDbgRingBytes = 0;
    _ottDbgDropped = 0;
    _ottDbgPending = [];
    _ottDbgLastError = "";
    _ottDbgStallSince = 0;
    _ottDbgStallCount = 0;
    _ottDbgStallTotalMs = 0;
    _ottDbgStallMaxMs = 0;
    _ottDbgLastStallMs = 0;
    _ottDbgWaitingCount = 0;
    _ottDbgErrorCount = 0;
    _ottDbgRecoverCount = 0;
}

function ottDebugSetHud(on: boolean): void {
    _ottDbgHudOn = !!on;
    try {
        if (typeof localStorage !== "undefined") {
            localStorage.setItem("ottplay_debug_hud", on ? "1" : "0");
        }
    } catch (_e) {}
    if (!_ottDbgEnabled) return;
    if (_ottDbgHudOn) {
        ottDebugEnsureHud();
        ottDebugUpdateHud();
    } else if (_ottDbgHudEl && _ottDbgHudEl.parentNode) {
        _ottDbgHudEl.parentNode.removeChild(_ottDbgHudEl);
        _ottDbgHudEl = null;
    }
}

function ottDebugEnsureHud(): void {
    if (_ottDbgHudEl || !_ottDbgHudOn) return;
    var el = document.createElement("div");
    el.id = "ott_debug_hud";
    // Full-width top banner; HS5-safe (no flex/gap/grid). Fields wrap as flowing text.
    el.style.cssText =
        "position:absolute;top:6px;left:4px;right:4px;width:auto;max-width:none;" +
        "z-index:99999;background:rgba(0,0,0,0.75);color:#0f0;" +
        "font:11px/1.35 monospace;padding:4px 8px;pointer-events:none;" +
        "white-space:normal;text-align:left;display:block;box-sizing:border-box;";
    el.innerHTML = "ottDebug…";
    var parent = document.body || document.documentElement;
    if (parent) parent.appendChild(el);
    _ottDbgHudEl = el;
}

function ottDebugBufferAhead(v: HTMLVideoElement): number {
    try {
        var buf = v.buffered;
        var t = v.currentTime || 0;
        var ahead = 0;
        for (var i = 0; i < buf.length; i++) {
            if (buf.start(i) <= t && buf.end(i) >= t) {
                ahead = buf.end(i) - t;
                break;
            }
            if (buf.start(i) > t) {
                ahead = Math.max(ahead, buf.end(i) - t);
            }
        }
        return Math.round(ahead * 100) / 100;
    } catch (_e) {
        return -1;
    }
}

function ottDebugDecodedMbps(v: HTMLVideoElement): number {
    var anyV = v as any;
    if (anyV.webkitVideoDecodedByteCount !== undefined) {
        var cur = anyV.webkitVideoDecodedByteCount || 0;
        if (_ottDbgLastDecodedBytes > 0 && cur >= _ottDbgLastDecodedBytes) {
            _ottDbgLastMbps =
                Math.round(
                    (((cur - _ottDbgLastDecodedBytes) * 8) / 1024 / 1024) * 100
                ) / 100;
        }
        _ottDbgLastDecodedBytes = cur;
        return _ottDbgLastMbps;
    }
    return -1;
}

function ottDebugDroppedFrames(v: HTMLVideoElement): number {
    try {
        if (typeof (v as any).getVideoPlaybackQuality === "function") {
            var q = (v as any).getVideoPlaybackQuality();
            if (q && typeof q.droppedVideoFrames === "number")
                return q.droppedVideoFrames;
        }
    } catch (_e) {}
    return -1;
}

function ottDebugRefreshSamples(): void {
    var v =
        _ottDbgVideo ||
        (document.getElementById("video") as HTMLVideoElement | null);
    if (v) _ottDbgSampleBufAhead = ottDebugBufferAhead(v);
    var hls = _ottDbgHls;
    if (hls) {
        _ottDbgSampleLevel =
            typeof hls.currentLevel === "number" ? hls.currentLevel : -1;
        _ottDbgSampleBw =
            hls.bandwidthEstimate != null
                ? Math.round(hls.bandwidthEstimate / 1000)
                : -1;
    }
}

function ottDebugCounters(): any {
    return {
        bufferAhead: _ottDbgSampleBufAhead,
        bwEstimate: _ottDbgSampleBw,
        errorCount: _ottDbgErrorCount,
        input: (window as any).__ottDebugInput
            ? (window as any).__ottDebugInput()
            : "",
        lastStallMs: _ottDbgLastStallMs,
        level: _ottDbgSampleLevel,
        recoverCount: _ottDbgRecoverCount,
        stallCount: _ottDbgStallCount,
        stallMaxMs: _ottDbgStallMaxMs,
        stallTotalMs: _ottDbgStallTotalMs,
        waitingCount: _ottDbgWaitingCount,
    };
}

function ottDebugPushStats(): void {
    if (!_ottDbgEnabled) return;
    ottDebugRefreshSamples();
    ottDebugPush("sys", "stats", ottDebugCounters());
}

function ottDebugUpdateHud(): void {
    if (!_ottDbgEnabled || !_ottDbgHudOn) return;
    ottDebugEnsureHud();
    if (!_ottDbgHudEl) return;
    var v =
        _ottDbgVideo ||
        (document.getElementById("video") as HTMLVideoElement | null);
    ottDebugRefreshSamples();
    // Flowing top-banner text (wraps horizontally); join with " · ", not <br/> per field.
    var parts: string[] = [];
    parts.push("ottDebug sess=" + (_ottDbgSession || "-"));
    parts.push(
        "port=" +
            (ottDebugPort() || "-") +
            " id=" +
            (ottDebugEnsurePlayerId() || "-") +
            " stalls=" +
            _ottDbgStallCount +
            " tot=" +
            Math.round(_ottDbgStallTotalMs / 1000) +
            "s max=" +
            Math.round(_ottDbgStallMaxMs / 1000) +
            "s"
    );
    if ((window as any).__ottDebugInput)
        parts.push((window as any).__ottDebugInput());
    if (!v) {
        parts.push("(no video)");
        _ottDbgHudEl.textContent = parts.join(" · ");
        return;
    }
    parts.push(
        (v.paused ? "paused" : "playing") +
            " rs=" +
            v.readyState +
            " ns=" +
            v.networkState
    );
    parts.push("bufAhead=" + ottDebugBufferAhead(v) + "s");
    parts.push(
        "video " +
            (v.videoWidth || 0) +
            "x" +
            (v.videoHeight || 0) +
            " mbps=" +
            ottDebugDecodedMbps(v)
    );
    var hls = _ottDbgHls;
    if (hls) {
        var lvls = hls.levels || [];
        parts.push(
            "hls lvl=" +
                hls.currentLevel +
                "/" +
                lvls.length +
                " bw=" +
                (hls.bandwidthEstimate != null
                    ? Math.round(hls.bandwidthEstimate / 1000) + "k"
                    : "-") +
                " cap=" +
                hls.autoLevelCapping
        );
    } else {
        parts.push("hls: -");
    }
    var stallAge =
        _ottDbgStallSince > 0
            ? Math.round((Date.now() - _ottDbgStallSince) / 1000) + "s"
            : "-";
    parts.push(
        "stallAge=" +
            stallAge +
            " err=" +
            ottDebugRedactText(_ottDbgLastError || "-")
    );
    var dropped = ottDebugDroppedFrames(v);
    if (dropped >= 0) parts.push("droppedFrames=" + dropped);
    parts.push("ring=" + _ottDbgRing.length + "/" + OTT_DEBUG_RING_MAX);
    _ottDbgHudEl.textContent = parts.join(" · ");
}

function ottDebugBuildIngestBody(batch: OttDebugEvent[]): string {
    return JSON.stringify({
        events: batch,
        origin: ottDebugOrigin(),
        playerId: ottDebugEnsurePlayerId(),
        port: ottDebugPort(),
        session: _ottDbgSession || "-",
        ua: ottDebugUaShort() || undefined,
    });
}

function ottDebugAuthToken(): string {
    try {
        var token = window.sessionStorage.getItem("ottplay_debug_token") || "";
        return /^[!-~]{32,}$/.test(token) ? token : "";
    } catch (_e) {
        return "";
    }
}

function ottDebugRetryBatch(batch: OttDebugEvent[]): void {
    if (_ottDbgEnabled)
        _ottDbgPending = batch
            .concat(_ottDbgPending)
            .slice(-OTT_DEBUG_RING_MAX);
}

function ottDebugBodyBytes(body: string): number {
    var bytes = 0;
    for (var i = 0; i < body.length; i++) {
        var code = body.charCodeAt(i);
        if (code < 128) bytes++;
        else if (code < 2048) bytes += 2;
        else if (
            code >= 0xd800 &&
            code <= 0xdbff &&
            body.charCodeAt(i + 1) >= 0xdc00 &&
            body.charCodeAt(i + 1) <= 0xdfff
        ) {
            bytes += 4;
            i++;
        } else bytes += 3;
    }
    return bytes;
}

function ottDebugTakeBatch(): OttDebugEvent[] {
    while (_ottDbgPending.length) {
        var count = Math.min(500, _ottDbgPending.length);
        while (count > 0) {
            var batch = _ottDbgPending.slice(0, count);
            // Stay below both the server body limit and fetch keepalive's 64 KiB budget.
            if (
                ottDebugBodyBytes(ottDebugBuildIngestBody(batch)) <=
                60 * 1024
            ) {
                _ottDbgPending.splice(0, count);
                return batch;
            }
            count = Math.floor(count / 2);
        }
        // A single oversize event remains inspectable in the local ring.
        _ottDbgPending.shift();
    }
    return [];
}

function ottDebugRetryStatus(status: number): boolean {
    return status === 0 || status === 429 || status >= 500;
}

function ottDebugFlushIngest(): void {
    if (!_ottDbgEnabled || !_ottDbgLocal || !_ottDbgPending.length) return;
    var generation = _ottDbgGeneration;
    function retry(batch: OttDebugEvent[]): void {
        if (generation === _ottDbgGeneration) ottDebugRetryBatch(batch);
    }
    var token = ottDebugAuthToken();
    if (!token) {
        _ottDbgPending = [];
        return;
    }
    var batch = ottDebugTakeBatch();
    if (!batch.length) return;
    var body = ottDebugBuildIngestBody(batch);
    try {
        if (typeof fetch === "function") {
            fetch("/debug/ingest", {
                body: body,
                headers: {
                    Authorization: "Bearer " + token,
                    "Content-Type": "application/json",
                },
                method: "POST",
            })
                .then(function (response) {
                    if (ottDebugRetryStatus(response.status)) retry(batch);
                })
                .catch(function () {
                    retry(batch);
                });
            return;
        }
    } catch (_e) {}
    try {
        var xhr = new XMLHttpRequest();
        xhr.open("POST", "/debug/ingest", true);
        xhr.setRequestHeader("Content-Type", "application/json");
        xhr.setRequestHeader("Authorization", "Bearer " + token);
        xhr.onreadystatechange = function () {
            if (xhr.readyState === 4 && ottDebugRetryStatus(xhr.status))
                retry(batch);
        };
        xhr.send(body);
    } catch (_e2) {
        retry(batch);
    }
}

/** Unload/hide flush with authentication; Beacon cannot carry the required header. */
function ottDebugFlushIngestUrgent(): void {
    if (!_ottDbgEnabled || !_ottDbgLocal || !_ottDbgPending.length) return;
    var generation = _ottDbgGeneration;
    function retry(batch: OttDebugEvent[]): void {
        if (generation === _ottDbgGeneration) ottDebugRetryBatch(batch);
    }
    var token = ottDebugAuthToken();
    if (!token) {
        _ottDbgPending = [];
        return;
    }
    var batch = ottDebugTakeBatch();
    if (!batch.length) return;
    var body = ottDebugBuildIngestBody(batch);
    var sent = false;
    try {
        if (typeof fetch === "function") {
            fetch("/debug/ingest", {
                body: body,
                headers: {
                    Authorization: "Bearer " + token,
                    "Content-Type": "application/json",
                },
                keepalive: true,
                method: "POST",
            })
                .then(function (response) {
                    if (ottDebugRetryStatus(response.status)) retry(batch);
                })
                .catch(function () {
                    retry(batch);
                });
            sent = true;
        }
    } catch (_e) {}
    if (!sent) {
        try {
            var xhr = new XMLHttpRequest();
            xhr.open("POST", "/debug/ingest", false);
            xhr.setRequestHeader("Content-Type", "application/json");
            xhr.setRequestHeader("Authorization", "Bearer " + token);
            xhr.send(body);
            if (ottDebugRetryStatus(xhr.status)) retry(batch);
            sent = true;
        } catch (_e2) {}
    }
    if (!sent) {
        retry(batch);
    }
}

function ottDebugClearStallTimer(): void {
    if (_ottDbgStallTimer !== null) {
        clearTimeout(_ottDbgStallTimer);
        _ottDbgStallTimer = null;
    }
}

function ottDebugEndStallIfAny(): void {
    if (!_ottDbgStallSince) return;
    var dur = Date.now() - _ottDbgStallSince;
    _ottDbgLastStallMs = dur;
    if (dur >= OTT_DEBUG_STALL_MS) {
        _ottDbgStallCount++;
        _ottDbgStallTotalMs += dur;
        if (dur > _ottDbgStallMaxMs) _ottDbgStallMaxMs = dur;
    }
    _ottDbgStallSince = 0;
}

function ottDebugOnVideoEvent(event: Event): void {
    if (!_ottDbgEnabled || !event || !event.type) return;
    var generation = _ottDbgGeneration;
    var t = event.type;
    if (
        t !== "waiting" &&
        t !== "stalled" &&
        t !== "playing" &&
        t !== "error" &&
        t !== "pause" &&
        t !== "play" &&
        t !== "canplay" &&
        t !== "emptied" &&
        t !== "abort" &&
        t !== "ended"
    ) {
        return;
    }
    var data: any = undefined;
    if (t === "error") {
        _ottDbgErrorCount++;
        var v =
            _ottDbgVideo ||
            (document.getElementById("video") as HTMLVideoElement | null);
        var me = v && v.error ? v.error : null;
        if (me) {
            data = { code: me.code, message: me.message };
            _ottDbgLastError =
                String(me.code) + (me.message ? " " + me.message : "");
        } else {
            _ottDbgLastError = "error";
        }
    }
    ottDebugPush("video", t, data);
    if (!_ottDbgEnabled || generation !== _ottDbgGeneration) return;
    if (t === "waiting" || t === "stalled") {
        _ottDbgWaitingCount++;
        if (!_ottDbgStallSince) _ottDbgStallSince = Date.now();
        ottDebugClearStallTimer();
        _ottDbgStallTimer = setTimeout(function () {
            if (!_ottDbgEnabled || generation !== _ottDbgGeneration) return;
            _ottDbgStallTimer = null;
            var v2 =
                _ottDbgVideo ||
                (document.getElementById("video") as HTMLVideoElement | null);
            if (v2 && !v2.paused && v2.readyState < 3) {
                ottDebugPush("stall", "waiting>3s", {
                    ageMs: Date.now() - (_ottDbgStallSince || Date.now()),
                    bufAhead: ottDebugBufferAhead(v2),
                    networkState: v2.networkState,
                    readyState: v2.readyState,
                });
            }
        }, OTT_DEBUG_STALL_MS);
    }
    if (t === "playing") {
        ottDebugClearStallTimer();
        ottDebugEndStallIfAny();
    }
}

function ottDebugBeginSession(_url?: string): void {
    if (!_ottDbgEnabled) return;
    _ottDbgSession = ottDebugShortId();
    ottDebugDetachHls();
    _ottDbgVideo = document.getElementById("video") as HTMLVideoElement | null;
    _ottDbgLastDecodedBytes = 0;
    _ottDbgLastMbps = 0;
    _ottDbgStallSince = 0;
    ottDebugClearStallTimer();
    ottDebugPush(
        "sys",
        "stbPlay",
        _url
            ? { url: ottDebugRedactText(String(_url)).substring(0, 120) }
            : undefined
    );
}

function ottDebugWrapXhrSetup(
    prevXhr?: any
): (xhr: XMLHttpRequest, url: string) => any {
    var generation = _ottDbgGeneration;
    return function (this: any, xhr: XMLHttpRequest, url: string) {
        var result =
            typeof prevXhr === "function"
                ? prevXhr.apply(this, arguments)
                : undefined;
        if (
            !_ottDbgEnabled ||
            generation !== _ottDbgGeneration ||
            !xhr ||
            typeof xhr.addEventListener !== "function" ||
            _ottDbgXhrCleanup.length >= 64
        )
            return result;
        var disposed = false;
        function loaded(): void {
            if (disposed || !_ottDbgEnabled || generation !== _ottDbgGeneration)
                return;
            if (xhr.status >= 400) {
                ottDebugPush("net", "xhr status", {
                    status: xhr.status,
                    url: ottDebugRedactText(String(url)).substring(0, 160),
                });
            }
        }
        function failed(): void {
            if (disposed || !_ottDbgEnabled || generation !== _ottDbgGeneration)
                return;
            ottDebugPush("net", "xhr error", {
                url: ottDebugRedactText(String(url)).substring(0, 160),
            });
        }
        function dispose(): void {
            if (disposed) return;
            disposed = true;
            xhr.removeEventListener("load", loaded);
            xhr.removeEventListener("error", failed);
            xhr.removeEventListener("loadend", dispose);
            var index = _ottDbgXhrCleanup.indexOf(dispose);
            if (index >= 0) _ottDbgXhrCleanup.splice(index, 1);
        }
        _ottDbgXhrCleanup.push(dispose);
        xhr.addEventListener("load", loaded);
        xhr.addEventListener("error", failed);
        xhr.addEventListener("loadend", dispose);
        return result;
    };
}

function ottDebugAttachHls(hls: any): void {
    if (!_ottDbgEnabled || !hls || hls === _ottDbgHls) return;
    ottDebugDetachHls();
    if (typeof hls.on !== "function" || typeof hls.off !== "function") return;
    _ottDbgHls = hls;
    var HlsRef = typeof Hls !== "undefined" ? Hls : (window as any).Hls;
    if (!HlsRef || !HlsRef.Events) return;
    var Ev = HlsRef.Events;
    var cleanup: (() => void)[] = [];
    var generation = _ottDbgGeneration;
    function current(): boolean {
        return (
            _ottDbgEnabled &&
            generation === _ottDbgGeneration &&
            _ottDbgHls === hls
        );
    }
    function listen(name: string, callback: any): void {
        if (!name) return;
        var guarded = function (event: any, data: any) {
            if (current()) callback(event, data);
        };
        hls.on(name, guarded);
        cleanup.push(function () {
            hls.off(name, guarded);
        });
    }
    function wrap(name: string): void {
        var previous = hls[name];
        if (typeof previous !== "function") return;
        var wrapped = function (this: any) {
            if (current()) {
                _ottDbgRecoverCount++;
                ottDebugPush("hls", name, {
                    recoverCount: _ottDbgRecoverCount,
                });
            }
            return previous.apply(this, arguments);
        };
        hls[name] = wrapped;
        cleanup.push(function () {
            if (hls[name] === wrapped) hls[name] = previous;
        });
    }
    _ottDbgHlsCleanup = function () {
        cleanup.forEach(function (dispose) {
            try {
                dispose();
            } catch (_error) {}
        });
    };
    wrap("recoverMediaError");
    wrap("startLoad");
    if (hls.config) {
        var previousXhr = hls.config.xhrSetup;
        var wrappedXhr = ottDebugWrapXhrSetup(previousXhr);
        hls.config.xhrSetup = wrappedXhr;
        cleanup.push(function () {
            if (hls.config.xhrSetup === wrappedXhr)
                hls.config.xhrSetup = previousXhr;
        });
    }

    listen(Ev.ERROR, function (_e: any, data: any) {
        var fatal = !!(data && data.fatal);
        if (fatal) {
            _ottDbgErrorCount++;
            _ottDbgLastError =
                "hls:" +
                String((data && data.type) || "") +
                "/" +
                String((data && data.details) || "");
        }
        ottDebugPush(fatal ? "hls" : "hls", fatal ? "ERROR fatal" : "ERROR", {
            details: data && data.details,
            fatal: fatal,
            level: data && data.level,
            type: data && data.type,
        });
    });

    listen(Ev.FRAG_LOADED, function (_e: any, data: any) {
        var frag = data && data.frag;
        var stats = data && data.stats;
        ottDebugPush("hls", "FRAG_LOADED", {
            level: frag && frag.level,
            loadMs:
                stats && stats.loading
                    ? stats.loading.end - stats.loading.start
                    : undefined,
            size: stats && (stats.total || stats.loaded),
            sn: frag && frag.sn,
        });
    });

    listen(Ev.LEVEL_SWITCHED, function (_e: any, data: any) {
        ottDebugPush("hls", "LEVEL_SWITCHED", { level: data && data.level });
    });

    listen(Ev.LEVEL_LOADED, function (_e: any, data: any) {
        ottDebugPush("hls", "LEVEL_LOADED", {
            details:
                data && data.details ? { live: data.details.live } : undefined,
            level: data && data.level,
        });
    });

    listen(Ev.MANIFEST_PARSED, function (_e: any, data: any) {
        var levels = (data && data.levels) || hls.levels || [];
        var summary: any[] = [];
        for (var i = 0; i < levels.length; i++) {
            var L = levels[i];
            summary.push({
                bw: L && L.bitrate,
                h: L && L.height,
                i: i,
            });
        }
        ottDebugPush("hls", "MANIFEST_PARSED", {
            levels: summary.length,
            summary: summary,
        });
    });
}

function ottDebugOnVisibilityFlush(): void {
    if (!_ottDbgEnabled || !_ottDbgLocal) return;
    try {
        // Final stats into pending without async auto-flush (ottDebugPush would
        // fire fetch for msg===stats); the urgent flush must carry the last batch.
        ottDebugRefreshSamples();
        var ev: OttDebugEvent = ottDebugTagEvent({
            cat: "sys",
            msg: "unload-stats",
            session: _ottDbgSession || "-",
            t: Date.now(),
        });
        ev.data = ottDebugCounters();
        if (!ottDebugStore(ev)) return;
        _ottDbgPending.push(ev);
        ottDebugFlushIngestUrgent();
    } catch (_e) {}
}

function ottDebugInstallFlushHooks(): void {
    ottDebugListen(document, "visibilitychange", function () {
        if (document.visibilityState === "hidden") ottDebugOnVisibilityFlush();
    });
    ottDebugListen(window, "pagehide", ottDebugOnVisibilityFlush);
    ottDebugListen(window, "beforeunload", ottDebugOnVisibilityFlush);
}

function ottDebugDeactivate(): void {
    if (!_ottDbgEnabled) return;
    _ottDbgEnabled = false;
    _ottDbgGeneration++;
    ottDebugDetachHls();
    ottDebugClearStallTimer();
    if (_ottDbgHudTimer !== null) clearInterval(_ottDbgHudTimer);
    if (_ottDbgIngestTimer !== null) clearInterval(_ottDbgIngestTimer);
    if (_ottDbgStatsTimer !== null) clearInterval(_ottDbgStatsTimer);
    _ottDbgHudTimer = _ottDbgIngestTimer = _ottDbgStatsTimer = null;
    var cleanup = _ottDbgCleanup;
    _ottDbgCleanup = [];
    cleanup.forEach(function (dispose) {
        try {
            dispose();
        } catch (_error) {}
    });
    _ottDbgXhrCleanup.slice().forEach(function (dispose) {
        try {
            dispose();
        } catch (_error) {}
    });
    _ottDbgXhrCleanup = [];
    if ((window as any).__ottDebugInputStop)
        (window as any).__ottDebugInputStop();
    if (_ottDbgHudEl && _ottDbgHudEl.parentNode)
        _ottDbgHudEl.parentNode.removeChild(_ottDbgHudEl);
    _ottDbgHudEl = null;
    _ottDbgPending = [];
    _ottDbgVideo = null;
    ottDebugClear();
    ottDebugInstallApi(false);
}

/** Stop all local and remote consumers without leaving instrumentation installed. */
function ottDebugDisable(): void {
    _ottDbgLocal = false;
    _ottDbgGeneration++;
    (window as any).__OTT_DEBUG__ = false;
    var captures = _ottDbgCaptures;
    _ottDbgCaptures = [];
    ottDebugDeactivate();
    captures.forEach(function (capture) {
        try {
            if (capture.stopped) capture.stopped();
        } catch (_error) {}
    });
}

/** Remote capture owns only its subscription; local opt-in survives its release. */
function ottDebugCapture(
    event: (event: OttDebugEvent) => void,
    stopped?: () => void
): () => void {
    if (
        typeof event !== "function" ||
        (stopped !== undefined && typeof stopped !== "function")
    ) {
        throw new Error("Invalid diagnostic consumer");
    }
    if (_ottDbgCaptures.length >= 4)
        throw new Error("Too many diagnostic consumers");
    var capture = { event: event, stopped: stopped };
    _ottDbgCaptures.push(capture);
    if (!_ottDbgEnabled) ottDebugActivate(false);
    return function () {
        var index = _ottDbgCaptures.indexOf(capture);
        if (index < 0) return;
        _ottDbgCaptures.splice(index, 1);
        if (!_ottDbgLocal && !_ottDbgCaptures.length) ottDebugDeactivate();
    };
}

function ottDebugSnapshot(): any {
    function number(value: any): number | null {
        return typeof value === "number" && isFinite(value) && value >= 0
            ? value
            : null;
    }
    var video = document.getElementById("video") as HTMLVideoElement | null;
    return {
        available: true,
        counters: _ottDbgEnabled
            ? {
                  dropped: _ottDbgDropped,
                  errors: _ottDbgErrorCount,
                  recoveries: _ottDbgRecoverCount,
                  stalls: _ottDbgStallCount,
                  waiting: _ottDbgWaitingCount,
              }
            : null,
        enabled: _ottDbgEnabled,
        video: video
            ? {
                  bufferAhead: number(ottDebugBufferAhead(video)),
                  currentTime: number(video.currentTime),
                  droppedFrames: number(ottDebugDroppedFrames(video)),
                  ended: video.ended === true,
                  errorCode: video.error ? number(video.error.code) : null,
                  networkState: number(video.networkState),
                  paused: video.paused === true,
                  readyState: number(video.readyState),
                  videoHeight: number(video.videoHeight),
                  videoWidth: number(video.videoWidth),
              }
            : null,
    };
}

function ottDebugInstallApi(enabled: boolean): void {
    function noop(): void {}
    (window as any).__ottDebug = {
        attachHls: enabled ? ottDebugAttachHls : noop,
        beginSession: enabled ? ottDebugBeginSession : noop,
        capture: ottDebugCapture,
        clear: enabled ? ottDebugClear : noop,
        disable: ottDebugDisable,
        dump: enabled
            ? ottDebugDump
            : function () {
                  return "";
              },
        enable: ottDebugEnable,
        enabled: enabled,
        isDebugEnabled: ottDebugIsEnabled,
        onVideoEvent: enabled ? ottDebugOnVideoEvent : noop,
        push: enabled ? ottDebugPush : noop,
        setHud: enabled ? ottDebugSetHud : noop,
        snapshot: ottDebugSnapshot,
        toggleHud: function () {
            // Menu opt-in lasts for this page; further toggles hide/show HUD.
            if (!_ottDbgLocal) ottDebugEnable();
            ottDebugSetHud(enabled ? !_ottDbgHudOn : true);
        },
        wrapXhrSetup: enabled
            ? ottDebugWrapXhrSetup
            : function (prev: any) {
                  return prev;
              },
    };
}

function ottDebugEnable(): void {
    _ottDbgLocal = true;
    (window as any).__OTT_DEBUG__ = true;
    if (_ottDbgEnabled) {
        ottDebugSetHud(true);
        return;
    }
    ottDebugActivate(true);
}

function ottDebugActivate(local: boolean): void {
    if (_ottDbgEnabled) return;
    _ottDbgEnabled = true;
    _ottDbgGeneration++;
    if ((window as any).__ottDebugInputInit)
        (window as any).__ottDebugInputInit();
    try {
        if (local) (window as any).__OTT_DEBUG__ = true;
    } catch (_e) {}
    ottDebugEnsurePlayerId();
    console.info(
        "[ottDebug] enabled port=" + ottDebugPort() + " id=" + _ottDbgPlayerId
    );
    _ottDbgHudOn = local;
    // Restore local HUD preference without persisting a remote session.
    try {
        if (local && typeof localStorage !== "undefined")
            _ottDbgHudOn = localStorage.getItem("ottplay_debug_hud") !== "0";
    } catch (_e) {}
    ottDebugEnsureHud();

    if (_ottDbgHudTimer === null) {
        _ottDbgHudTimer = setInterval(ottDebugUpdateHud, OTT_DEBUG_HUD_MS);
    }
    if (_ottDbgIngestTimer === null) {
        _ottDbgIngestTimer = setInterval(
            ottDebugFlushIngest,
            OTT_DEBUG_INGEST_MS
        );
    }
    if (_ottDbgStatsTimer === null) {
        _ottDbgStatsTimer = setInterval(ottDebugPushStats, OTT_DEBUG_STATS_MS);
    }
    ottDebugInstallFlushHooks();

    // D hotkey: toggle HUD strip. Installed once here so listener is only active
    // when debug is enabled. Safe on PC (keyCode 68 unused) and on MAG/Maple
    // (e.key avoids their PLAY/PREV=68 mapping).
    try {
        function _ottDbgOnKeyDown(e: KeyboardEvent) {
            var target = e.target as HTMLElement | null;
            if (
                target &&
                (target.tagName === "INPUT" ||
                    target.tagName === "TEXTAREA" ||
                    target.isContentEditable)
            ) {
                return;
            }
            // On-screen keyboard / list editor — let letters type into editvar.
            try {
                if (
                    typeof (window as any).$ !== "undefined" &&
                    (window as any).$("#listEdit").is(":visible")
                ) {
                    return;
                }
            } catch (_eVis) {}
            var match = false;
            if (e.key === "d" || e.key === "D") {
                match = true;
            } else if (e.keyCode === 68) {
                var k = (window as any).keys;
                // MAG/Maple map 68 to PLAY/PREV — do not steal those keys.
                if (!k || (k.PLAY !== 68 && k.PREV !== 68)) match = true;
            }
            if (match) {
                e.preventDefault();
                e.stopPropagation();
                ottDebugSetHud(!_ottDbgHudOn);
                console.info("[ottDebug] HUD " + (_ottDbgHudOn ? "on" : "off"));
            }
        }
        ottDebugListen(document, "keydown", _ottDbgOnKeyDown);
    } catch (_e3) {}

    ottDebugInstallApi(true);
    if ((window as any).__ottDebugAttachCurrent)
        (window as any).__ottDebugAttachCurrent();
    ottDebugUpdateHud();
    ottDebugPush("sys", "boot", {
        href: typeof location !== "undefined" ? location.href : "",
        origin: ottDebugOrigin(),
        playerId: _ottDbgPlayerId,
        port: ottDebugPort(),
    });
}

function ottDebugTryServerConfig(): void {
    try {
        if (typeof fetch !== "function") return;
        var token = ottDebugAuthToken();
        if (!token) return;
        var generation = _ottDbgGeneration;
        fetch("/debug/config", {
            headers: { Authorization: "Bearer " + token },
        })
            .then(function (r) {
                if (!r || !r.ok) return null;
                return r.json();
            })
            .then(function (cfg) {
                if (
                    generation === _ottDbgGeneration &&
                    cfg &&
                    cfg.enabled === true
                ) {
                    ottDebugEnable();
                }
            })
            .catch(function () {});
    } catch (_e) {}
}

function ottDebugBoot(): void {
    if (ottDebugIsEnabled()) {
        ottDebugEnable();
        return;
    }
    ottDebugInstallApi(false);
    // Auto-enable from server (OTTPLAY_DEBUG=1 or debug.enabled file) — silent fail.
    ottDebugTryServerConfig();
}

declare var Hls: any;

ottDebugBoot();
