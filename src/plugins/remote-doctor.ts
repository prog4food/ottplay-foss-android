/** A bounded observation of this document, never proof of the physical display. */
export type DoctorOwnerKind =
    | "list"
    | "about"
    | "dialog"
    | "editor"
    | "picker"
    | "unknown";
export type DoctorPaneKind = DoctorOwnerKind | "pin" | "launch" | "osd";
export type DoctorFocusKind = DoctorPaneKind | "player" | "body" | "other";
export type DoctorPhase =
    | "idle"
    | "loading"
    | "playing"
    | "paused"
    | "stopped"
    | "ended"
    | "error"
    | "unknown";
export type DoctorCapabilityName =
    | "screenshot"
    | "diagnostics"
    | "input"
    | "restart_stream"
    | "reload_player"
    | "restart_app"
    | "exit_app"
    | "reboot_device"
    | "standby"
    | "wake";
export type DoctorCapabilityReason =
    | "ready"
    | "not_implemented"
    | "producer_unavailable"
    | "remote_disconnected"
    | "source_selection_required"
    | "busy"
    | "no_active_media"
    | "current_state_unsupported"
    | "policy_restricted";
export type DoctorReason =
    | "producer_unavailable"
    | "producer_failed"
    | "invalid_sample"
    | "state_changed_during_snapshot"
    | "build_identity_partial"
    | "document_hidden"
    | "document_unfocused"
    | "owned_overlay_open"
    | "video_element_missing"
    | "video_css_hidden"
    | "video_zero_rect"
    | "decoder_not_ready"
    | "decoder_paused"
    | "decoder_ended"
    | "decoder_error"
    | "physical_display_unverified";
export interface DoctorRect {
    height: number;
    width: number;
    x: number;
    y: number;
}
export interface DoctorPane {
    cssVisible: boolean | null;
    exists: boolean;
    kind: DoctorPaneKind;
    rect: DoctorRect | null;
}
export interface DoctorVideo {
    cssVisible: boolean | null;
    ended: boolean | null;
    exists: boolean;
    networkState: number | null;
    paused: boolean | null;
    readyState: number | null;
    rect: DoctorRect | null;
    videoHeight: number | null;
    videoWidth: number | null;
}
export interface DoctorLane {
    duration: number | null;
    handleId: number | null;
    lane: "main" | "pip";
    phase: DoctorPhase;
    position: number | null;
    video: DoctorVideo;
}
export interface DoctorCapability {
    name: DoctorCapabilityName;
    reason: DoctorCapabilityReason;
    state: "available" | "unavailable" | "unknown";
}
export interface DoctorBuild {
    buildId: string | null;
    identity: "embedded" | "partial";
    sourceRevision: string | null;
    version: string;
}
export interface DoctorSnapshot {
    build: DoctorBuild;
    capabilities: DoctorCapability[];
    capturedAt: number;
    collectionMs: number | null;
    consistent: boolean;
    media: {
        generation: number | null;
        kind: "live" | "archive" | "vod" | "none" | "unknown";
        phase: DoctorPhase;
        lanes: DoctorLane[];
        displayEvidence: "unavailable";
    };
    reasons: DoctorReason[];
    runtime: string;
    ui: {
        documentVisibility: "visible" | "hidden" | "unknown";
        documentFocused: boolean | null;
        owner: { kind: DoctorOwnerKind; id: number } | null;
        revision: number | null;
        panes: DoctorPane[];
        focus: DoctorFocusKind;
    };
    version: 1;
}
/** Readers must be pure: do not sample/reconcile transport or create a backend. */
export interface RemoteDoctorReaders {
    readCapabilities?(): DoctorCapability[];
    // Compiled metadata of the loaded bundle, never a freshly fetched manifest.
    readIdentity(): {
        runtime: string;
        build: {
            version: string;
            sourceRevision?: string | null;
            buildId?: string | null;
        };
    };
    readLane?(lane: "main" | "pip"): {
        id: number;
        phase: string;
        position: number;
        duration?: number;
    } | null;
    readPlayback?(): {
        generation: number;
        phase: string;
        target: { kind: string } | null;
    };
    readUI?(): {
        owner: { kind: string; id: number } | null;
        revision: number;
    };
}

// All emitted strings are enums or bounded identity tokens. All fields are
// required, with null for unavailable scalar observations; no undefined values.
// Wire limits: 8192 UTF-8 bytes; 8 panes, 2 lanes, 10 capabilities, 16 reasons.
// Safe integers: 0..9007199254740991. Times in seconds: 0..315576000.
// Rect coordinates: -32768..32768, dimensions: 0..32768, integral CSS pixels.
// Collection duration: 0..60000 ms. Version <=64 chars; runtime/buildId <=96.
// Identity tokens: [A-Za-z0-9_.-]+; version also permits + for SemVer metadata.
// sourceRevision is exactly 40 lowercase hex.

var ownerKinds = ["list", "about", "dialog", "editor", "picker", "unknown"];
var phases = [
    "idle",
    "loading",
    "playing",
    "paused",
    "stopped",
    "ended",
    "error",
    "unknown",
];
var capabilityNames = [
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
var capabilityReasons = [
    "ready",
    "not_implemented",
    "producer_unavailable",
    "remote_disconnected",
    "source_selection_required",
    "busy",
    "no_active_media",
    "current_state_unsupported",
    "policy_restricted",
];
var paneIds: Array<[DoctorPaneKind, string]> = [
    ["list", "list"],
    ["about", "listAbout"],
    ["dialog", "dialogbox"],
    ["editor", "listEdit"],
    ["picker", "numprog"],
    ["pin", "pin"],
    ["launch", "launch"],
    ["osd", "info1"],
];

/** Does not call transport, capability probes, storage, or asynchronous APIs. */
export function collectRemoteDoctor(
    w: any,
    readers: RemoteDoctorReaders
): DoctorSnapshot {
    var reasons: DoctorReason[] = [];
    function reason(value: DoctorReason): void {
        if (reasons.indexOf(value) < 0) reasons.push(value);
    }
    function safely<T>(read: () => T, fallback: T): T {
        try {
            return read();
        } catch (_) {
            reason("producer_failed");
            return fallback;
        }
    }
    function read(callback: any): any {
        if (typeof callback !== "function") {
            reason("producer_unavailable");
            return null;
        }
        return safely(function () {
            return callback();
        }, null);
    }
    function number(
        value: any,
        max: number,
        integer = false,
        min = 0
    ): number | null {
        if (value === null || value === undefined) return null;
        if (
            typeof value !== "number" ||
            !isFinite(value) ||
            value < min ||
            value > max ||
            (integer && Math.floor(value) !== value)
        ) {
            reason("invalid_sample");
            return null;
        }
        return value;
    }
    function boolean(value: any): boolean | null {
        if (value === null || value === undefined) return null;
        if (typeof value === "boolean") return value;
        reason("invalid_sample");
        return null;
    }
    function choice(value: any, choices: string[], fallback: string): string {
        if (typeof value === "string" && choices.indexOf(value) >= 0)
            return value;
        reason("invalid_sample");
        return fallback;
    }
    function token(value: any, max: number, version = false): string | null {
        if (value === null || value === undefined) return null;
        if (
            typeof value === "string" &&
            value.length > 0 &&
            value.length <= max &&
            !(version ? /[^A-Za-z0-9_.+-]/ : /[^A-Za-z0-9_.-]/).test(value)
        )
            return value;
        reason("invalid_sample");
        return null;
    }
    function clock(): number | null {
        return safely(function () {
            var perf = w && w.performance;
            return perf && typeof perf.now === "function"
                ? number(perf.now(), 9007199254740991)
                : null;
        }, null);
    }
    var start = clock();
    var capturedAt =
        safely(function () {
            return number(Date.now(), 9007199254740991, true);
        }, null) || 0;
    if (!capturedAt) reason("invalid_sample");
    var identity = safely(
        function () {
            var raw = read(readers.readIdentity);
            var build = raw && raw.build;
            var version = token(build && build.version, 64, true);
            var revision = build && build.sourceRevision;
            if (
                revision !== null &&
                revision !== undefined &&
                (typeof revision !== "string" ||
                    revision.length !== 40 ||
                    !/^[a-f0-9]{40}$/.test(revision))
            ) {
                reason("invalid_sample");
                revision = null;
            }
            return {
                build: {
                    buildId: token(build && build.buildId, 96),
                    identity: version && revision ? "embedded" : "partial",
                    sourceRevision: revision || null,
                    version: version || "unknown",
                } as DoctorBuild,
                runtime: token(raw && raw.runtime, 96) || "unknown",
            };
        },
        {
            build: {
                buildId: null,
                identity: "partial",
                sourceRevision: null,
                version: "unknown",
            } as DoctorBuild,
            runtime: "unknown",
        }
    );
    if (identity.build.identity === "partial") reason("build_identity_partial");

    function uiState(): {
        owner: DoctorSnapshot["ui"]["owner"];
        revision: number | null;
    } {
        return safely(
            function () {
                var raw = read(readers.readUI);
                var owner = raw && raw.owner;
                var id = number(owner && owner.id, 9007199254740991, true);
                return {
                    owner:
                        owner && id !== null
                            ? {
                                  id: id,
                                  kind: choice(
                                      owner.kind,
                                      ownerKinds,
                                      "unknown"
                                  ) as DoctorOwnerKind,
                              }
                            : null,
                    revision: number(
                        raw && raw.revision,
                        9007199254740991,
                        true
                    ),
                };
            },
            { owner: null, revision: null }
        );
    }
    function playbackState(): {
        generation: number | null;
        kind: DoctorSnapshot["media"]["kind"];
        phase: DoctorPhase;
    } {
        return safely(
            function () {
                var raw = read(readers.readPlayback);
                return {
                    generation: number(
                        raw && raw.generation,
                        9007199254740991,
                        true
                    ),
                    kind: !raw
                        ? "unknown"
                        : raw.target === null
                          ? "none"
                          : (choice(
                                raw.target && raw.target.kind,
                                ["live", "archive", "vod"],
                                "unknown"
                            ) as DoctorSnapshot["media"]["kind"]),
                    phase: raw
                        ? (choice(raw.phase, phases, "unknown") as DoctorPhase)
                        : "unknown",
                };
            },
            { generation: null, kind: "unknown", phase: "unknown" }
        );
    }
    var ui = uiState();
    var playback = playbackState();
    var doc = safely(function () {
        return w && w.document;
    }, null);
    function element(id: string): any {
        if (!doc || typeof doc.getElementById !== "function") {
            reason("producer_unavailable");
            return null;
        }
        return safely(function () {
            return doc.getElementById(id);
        }, null);
    }
    function rect(el: any): DoctorRect | null {
        if (!el || typeof el.getBoundingClientRect !== "function") return null;
        return safely(function () {
            var box = el.getBoundingClientRect();
            var x = number(box.left, 32768, false, -32768);
            var y = number(box.top, 32768, false, -32768);
            var width = number(
                box.width === undefined ? box.right - box.left : box.width,
                32768
            );
            var height = number(
                box.height === undefined ? box.bottom - box.top : box.height,
                32768
            );
            return x === null || y === null || width === null || height === null
                ? null
                : {
                      height: Math.ceil(height),
                      width: Math.ceil(width),
                      x: Math.round(x),
                      y: Math.round(y),
                  };
        }, null);
    }
    function cssVisible(el: any): boolean | null {
        if (!el) return null;
        return safely(function () {
            if (!w || typeof w.getComputedStyle !== "function") return null;
            var node = el;
            // A fixed ancestry budget also bounds work on malformed/cyclic hosts.
            for (var depth = 0; node && depth < 32; depth++) {
                var style = w.getComputedStyle(node);
                if (!style) return null;
                if (
                    style.display === "none" ||
                    style.opacity === "0" ||
                    (node === el &&
                        (style.visibility === "hidden" ||
                            style.visibility === "collapse"))
                )
                    return false;
                node = node.parentElement;
            }
            return node ? null : true;
        }, null);
    }
    var nodes: any[] = [];
    var panes = paneIds.map(function (entry): DoctorPane {
        var el = element(entry[1]);
        nodes.push(el);
        return {
            cssVisible: cssVisible(el),
            exists: !!el,
            kind: entry[0],
            rect: rect(el),
        };
    });
    var videoNodes = [element("video"), element("videopip")];
    function video(el: any): DoctorVideo {
        var blank: DoctorVideo = {
            cssVisible: null,
            ended: null,
            exists: !!el,
            networkState: null,
            paused: null,
            readyState: null,
            rect: null,
            videoHeight: null,
            videoWidth: null,
        };
        if (!el) return blank;
        return safely(function () {
            return {
                cssVisible: cssVisible(el),
                ended: boolean(el.ended),
                exists: true,
                networkState: number(el.networkState, 3, true),
                paused: boolean(el.paused),
                readyState: number(el.readyState, 4, true),
                rect: rect(el),
                videoHeight: number(el.videoHeight, 32768, true),
                videoWidth: number(el.videoWidth, 32768, true),
            };
        }, blank);
    }
    function laneState(lane: "main" | "pip"): Omit<DoctorLane, "video"> {
        return safely(
            function () {
                var raw = read(
                    typeof readers.readLane === "function"
                        ? function () {
                              return readers.readLane!(lane);
                          }
                        : null
                );
                return {
                    duration: number(raw && raw.duration, 315576000),
                    handleId: number(raw && raw.id, 9007199254740991, true),
                    lane: lane,
                    phase: raw
                        ? (choice(raw.phase, phases, "unknown") as DoctorPhase)
                        : "unknown",
                    position: number(raw && raw.position, 315576000),
                };
            },
            {
                duration: null,
                handleId: null,
                lane: lane,
                phase: "unknown",
                position: null,
            }
        );
    }
    var lanes: DoctorLane[] = (["main", "pip"] as Array<"main" | "pip">).map(
        function (name, index) {
            var state = laneState(name);
            var view = video(videoNodes[index]);
            if (state.handleId !== null) {
                if (!view.exists) reason("video_element_missing");
                if (view.cssVisible === false) reason("video_css_hidden");
                if (
                    view.rect &&
                    (view.rect.width === 0 || view.rect.height === 0)
                )
                    reason("video_zero_rect");
                if (
                    view.readyState !== null &&
                    view.readyState < 2 &&
                    (state.phase === "loading" || state.phase === "playing")
                )
                    reason("decoder_not_ready");
                if (view.paused === true || state.phase === "paused")
                    reason("decoder_paused");
                if (view.ended === true || state.phase === "ended")
                    reason("decoder_ended");
                if (state.phase === "error") reason("decoder_error");
            }
            return {
                duration: state.duration,
                handleId: state.handleId,
                lane: name,
                phase: state.phase,
                position: state.position,
                video: view,
            };
        }
    );
    var visibility = safely(
        function (): DoctorSnapshot["ui"]["documentVisibility"] {
            if (!doc) return "unknown";
            var value = doc.visibilityState;
            if (value === "hidden" || value === "visible") return value;
            var hidden = doc.hidden;
            return typeof hidden === "boolean"
                ? hidden
                    ? "hidden"
                    : "visible"
                : "unknown";
        },
        "unknown" as DoctorSnapshot["ui"]["documentVisibility"]
    );
    var focused = safely(function () {
        return doc && typeof doc.hasFocus === "function"
            ? boolean(doc.hasFocus())
            : null;
    }, null);
    var focus = safely(function (): DoctorFocusKind {
        var active = doc && doc.activeElement;
        if (!active) return "unknown";
        if (active === doc.body || active === doc.documentElement)
            return "body";
        for (var depth = 0; active && depth < 32; depth++) {
            if (active === videoNodes[0] || active === videoNodes[1])
                return "player";
            var index = nodes.indexOf(active);
            if (index >= 0) return paneIds[index][0];
            active = active.parentElement;
        }
        return active ? "unknown" : "other";
    }, "unknown" as DoctorFocusKind);
    if (visibility === "hidden") reason("document_hidden");
    if (focused === false) reason("document_unfocused");
    if (ui.owner && ui.owner.kind !== "list" && ui.owner.kind !== "unknown")
        reason("owned_overlay_open");

    var capabilities = safely(function (): DoctorCapability[] {
        var raw = read(readers.readCapabilities);
        if (raw === null) return [];
        if (!Array.isArray(raw)) {
            reason("invalid_sample");
            return [];
        }
        if (raw.length > 10) reason("invalid_sample");
        var result: DoctorCapability[] = [];
        var seen: string[] = [];
        for (var i = 0; i < Math.min(raw.length, 10); i++) {
            var item = raw[i];
            var name = item && item.name;
            var state = item && item.state;
            var why = item && item.reason;
            if (
                !item ||
                typeof name !== "string" ||
                capabilityNames.indexOf(name) < 0 ||
                ["available", "unavailable", "unknown"].indexOf(state) < 0 ||
                capabilityReasons.indexOf(why) < 0 ||
                seen.indexOf(name) >= 0 ||
                (state === "available") !== (why === "ready")
            ) {
                reason("invalid_sample");
                continue;
            }
            seen.push(name);
            result.push({
                name: name as DoctorCapabilityName,
                reason: why,
                state: state,
            });
        }
        return result;
    }, []);
    var afterUI = uiState();
    var afterPlayback = playbackState();
    var afterRuntime = safely(function () {
        var raw = read(readers.readIdentity);
        return token(raw && raw.runtime, 96);
    }, null);
    var consistent =
        capturedAt > 0 &&
        identity.runtime !== "unknown" &&
        afterRuntime === identity.runtime &&
        ui.revision !== null &&
        afterUI.revision === ui.revision &&
        playback.generation !== null &&
        afterPlayback.generation === playback.generation;
    var laneChanged = false;
    lanes.forEach(function (lane) {
        if (laneState(lane.lane).handleId !== lane.handleId) {
            consistent = false;
            laneChanged = true;
        }
    });
    if (
        !consistent &&
        (laneChanged ||
            ui.revision !== afterUI.revision ||
            playback.generation !== afterPlayback.generation ||
            (afterRuntime !== null && afterRuntime !== identity.runtime))
    )
        reason("state_changed_during_snapshot");
    reason("physical_display_unverified");
    var end = clock();
    var elapsed =
        start === null || end === null ? null : number(end - start, 60000);
    return {
        build: identity.build,
        capabilities: capabilities,
        capturedAt: capturedAt,
        collectionMs: elapsed,
        consistent: consistent,
        media: {
            displayEvidence: "unavailable",
            generation: playback.generation,
            kind: playback.kind,
            lanes: lanes,
            phase: playback.phase,
        },
        reasons: reasons,
        runtime: identity.runtime,
        ui: {
            documentFocused: focused,
            documentVisibility: visibility,
            focus: focus,
            owner: ui.owner,
            panes: panes,
            revision: ui.revision,
        },
        version: 1,
    };
}
