/**
 * Core STB player — video element management, playback control,
 * fullscreen, PiP, aspect ratio, audio/subtitle tracks.
 *
 * Ported from devices/legacy-core.js.
 */

declare var Hls: any;
declare var shaka: any;
declare var $: any;
declare function showSelectBox(
    current: number,
    items: string[],
    callback: (val: number) => void,
    exitKey?: number
): void;
declare function showShift(msg: string): void;
declare function _(key: string, ...args: any[]): string;
declare function saveChannelPreference(key: string, val: number): boolean;
declare function captureChannelPreference(key: string): any;
declare function applyChannelPreference(
    key: string,
    callback: (val: number) => void
): void;

import {
    portableSettingsSnapshot,
    providerHasItemValue,
    restoreLocalSettingsSnapshot,
} from "../storage/index";
import { listPreviewRect } from "../utils/helpers";
import { watchAutoNativePlayback } from "./auto-playback";
import { createNativeHlsTransport, isNativeHlsUrl } from "./native-hls";

/** Reference to the primary <video> DOM element. */
export var video: HTMLVideoElement | null = null;
/** Reference to the PiP (picture-in-picture) <video> DOM element. */
export var videoPip: HTMLVideoElement | null = null;
/**
 * Active playback engine mode:
 * 0 = native HTML5, 1 = hls.js, 2 = shaka-player, 3 = per-stream Auto.
 */
export var playerMode = 0;

/**
 * Set the playback engine mode.
 * @param v - 0 (HTML5), 1 (hls.js), 2 (shaka), or 3 (Auto).
 * webOS always uses Auto without rewriting the stored provider preference.
 */
export function setPlayerMode(v: number): void {
    var nextMode = normalizePlayerMode(v);
    if (nextMode !== playerMode) cancelCoreAutoPlayback(true);
    playerMode = nextMode;
    console.log("[setPlayerMode] playerMode=" + playerMode);
}
/** Human-readable labels for each playerMode value. */
export var playerModeNames =
    getDefaultPlayerMode() === 3
        ? ["html5", "hls.js", "shaka", "auto"]
        : ["html5", "hls.js", "shaka"];

/** Identify only the standalone Android TV test host, never a native app shell. */
export function isOttplayTestWebView(): boolean {
    if (typeof window === "undefined") return false;
    var w = window as any;
    try {
        if (
            w.ott_device !== "android" ||
            typeof w.Capacitor !== "undefined" ||
            typeof w.__ottNativeRuntime !== "undefined" ||
            typeof w.Android !== "undefined" ||
            typeof w.__TAURI__ !== "undefined" ||
            typeof w.__TAURI_INTERNALS__ !== "undefined"
        )
            return false;
        var ua = w.navigator && w.navigator.userAgent;
        return (
            typeof ua === "string" &&
            /(?:^|\s)OttplayTestWebView\/1\.0(?=\s|$)/.test(ua)
        );
    } catch (_bridgeError) {
        return false;
    }
}

/** Auto handles stream formats on webOS, Tauri and the marked Android test host. */
export function getDefaultPlayerMode(): number {
    if (typeof window === "undefined") return 0;
    return (window as any).OttPlayCore.classicPlaybackDefaultMode(
        (window as any).ott_device === "lg/webos",
        !!((window as any).__TAURI__ || (window as any).__TAURI_INTERNALS__),
        isOttplayTestWebView
    );
}

/** Decode capability probes are lazy: unused engines must not be initialized. */
export function normalizePlayerMode(mode: number): number {
    return (window as any).OttPlayCore.classicPlaybackMode(
        mode,
        (window as any).ott_device === "lg/webos",
        function () {
            return getDefaultPlayerMode() === 3;
        },
        function () {
            return (
                !video ||
                typeof video.canPlayType !== "function" ||
                !!video.canPlayType("application/vnd.apple.mpegurl")
            );
        },
        function () {
            return typeof Hls !== "undefined" && Hls.isSupported();
        }
    );
}
/** Available preload buffer sizes (indexes into a numeric range). */
export var bufferSizes = [
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "10",
];

/** Button label for the Exit key. */
export var strEXIT = "Esc";
/** Button label for the Enter key. */
export var strENTER = "ENTER";
/** Button label for the Tools key (wrench icon). */
export var strTools = '<span class="fontello">&#xe808;</span>';
/** Button label for the Info key. */
export var strInfo = '<span class="fontello">&#xe810;</span>';
/** Button label for the EPG key (empty by default). */
export var strEPG = "";
/** Button label for the PiP key. */
export var strPip = "W";
/** Button label for the Aspect Ratio key. */
export var strAspect = "A";
/** Button label for the Zoom key. */
export var strZoom = "E";
/** Button label for the Audio track key. */
export var strAudio = "S";
/** Button label for the Pre-Channel key. */
export var strPRECH = "?";
/** Button label for the Return key (left arrow icon). */
export var strRETURN = '<span class="fontello">&#xe804;</span>';
/** Button label for the Setup key. */
export var strSETUP = "§";
/** Button label for the Language key. */
export var strLANG = "SHIFT";

/** Active hls.js instance for the main video!. */
var hlsInstance: any = null;
// True only after this core attached a native source to the owned element.
var coreNativeAttached = false;
var corePipNativeAttached = false;
// Late opt-in attaches to the active engine without restarting playback.
(window as any).__ottDebugAttachCurrent = function (): void {
    if (window.__ottDebug && window.__ottDebug.enabled) {
        window.__ottDebug.attachHls(hlsInstance);
    }
};
/** Identifies the current user-requested playback session. */
var _playSession = 0;
/** The previous Shaka must release this video before another engine attaches. */
var _coreShakaTeardown: PromiseLike<unknown> | null = null;
var _corePendingSeek: (() => void) | null = null;
var _corePendingSeekPosition: number | null = null;
var _coreAutoCancel: ReturnType<typeof watchAutoNativePlayback> | null = null;
var _coreAutoHlsUsed = false;
var _corePlaybackMode = 0;
/** A temporary diagnostic owns the main decoder, independently of the Demo provider. */
var _coreTransientPlayback = false;
var _coreNativeHls: ReturnType<typeof createNativeHlsTransport> = null;
var _coreNativeAttempt = 0;
var _coreNativeHlsCleanup: (() => void) | null = null;

function cancelCoreNativeHls(): void {
    _coreNativeAttempt++;
    if (_coreNativeHls) _coreNativeHls.cancel();
    _coreNativeHls = null;
    if (_coreNativeHlsCleanup) _coreNativeHlsCleanup();
    _coreNativeHlsCleanup = null;
}
/** Demo autoplay is temporarily muted; never persist it as the user's choice. */
var _coreDemoMute: { media: HTMLVideoElement; muted: boolean } | null = null;

function cancelCoreAutoPlayback(modeChange?: boolean): void {
    if (_coreAutoCancel) _coreAutoCancel(modeChange);
    _coreAutoCancel = null;
    if (modeChange) {
        if (_corePipAutoCancel) _corePipAutoCancel(true);
        _corePipAutoCancel = null;
    }
}

function coreAutoMode(url: string, media: HTMLVideoElement | null): number {
    return (window as any).OttPlayCore.classicPlaybackAutoMode(
        url,
        function () {
            return (
                !media || !!media.canPlayType("application/vnd.apple.mpegurl")
            );
        },
        isOttplayTestWebView,
        function () {
            return typeof Hls !== "undefined" && Hls.isSupported();
        }
    );
}

/** A resolved Plex format belongs to this catalog item, never to the next channel. */
function corePlexPlaybackHint(url: string): "file" | "mse" | null {
    var library = (window as any).__ottMedia;
    var current =
        library && typeof library.current === "function"
            ? library.current()
            : null;
    var payload = current && current.payload;
    if (!payload || payload.stream_url !== url || !payload.__ottPlexPlayback)
        return null;
    var hint = payload.__ottPlexPlayback;
    if (hint.type === "file") return "file";
    return hint.type === "hls" && hint.engine === "mse" ? "mse" : null;
}

function setCoreDemoMute(enabled: boolean): void {
    enabled = enabled && !_coreTransientPlayback;
    if (_coreDemoMute && (!enabled || _coreDemoMute.media !== video)) {
        _coreDemoMute.media.muted = _coreDemoMute.muted;
        _coreDemoMute = null;
    }
    if (enabled && video) {
        if (!_coreDemoMute)
            _coreDemoMute = { media: video, muted: video.muted };
        video.muted = true;
    }
}

/** Restore the user's mute choice when leaving demo, including paused media. */
export function restoreDemoMute(): void {
    setCoreDemoMute(false);
}

function isCoreThenable(value: unknown): value is PromiseLike<unknown> {
    return (
        !!value && typeof (value as PromiseLike<unknown>).then === "function"
    );
}

/** Older WebKit play() returns void; modern autoplay failures must be consumed. */
function playCoreMedia(media: HTMLVideoElement): void {
    if (media === video)
        setCoreDemoMute((window as any).ottplayDemoActive === true);
    try {
        var result = media.play();
        if (isCoreThenable(result)) {
            result.then(undefined, function (error) {
                console.log("[video] play() rejected:", error);
            });
        }
    } catch (error) {
        console.log("[video] play() failed:", error);
    }
}

function cancelCoreSeek(): void {
    if (_corePendingSeek) _corePendingSeek();
    _corePendingSeek = null;
    _corePendingSeekPosition = null;
}

/** Some STB engines reject currentTime until loadedmetadata has arrived. */
function seekCoreMedia(
    position: number,
    session: number,
    startup = false
): void {
    if (
        !video ||
        session !== _playSession ||
        !isFinite(position) ||
        position < 0
    )
        return;
    cancelCoreSeek();
    if (hlsInstance) {
        hlsInstance.config.startPosition = position;
        if (!hlsInstance.hasEnoughToStart) {
            hlsInstance.startLoad(position);
            return;
        }
    }
    var media = video;
    function apply(): boolean {
        if (session !== _playSession || video !== media) return true;
        try {
            var duration = media.duration;
            media.currentTime =
                startup &&
                (window as any).__ottActiveProviderDriver?.id === "offline" &&
                isFinite(duration) &&
                duration > 0 &&
                position >= duration
                    ? 0
                    : position;
            return true;
        } catch (_notReady) {
            return false;
        }
    }
    var applied = apply();
    if (
        (!applied || media.readyState === 0) &&
        typeof media.addEventListener === "function"
    ) {
        var clear = function (): void {
            media.removeEventListener("loadedmetadata", onMetadata);
            if (_corePendingSeek === clear) {
                _corePendingSeek = null;
                _corePendingSeekPosition = null;
            }
        };
        var onMetadata = function (): void {
            apply();
            clear();
        };
        _corePendingSeek = clear;
        _corePendingSeekPosition = position;
        media.addEventListener("loadedmetadata", onMetadata);
        if (hlsInstance) hlsInstance.startLoad(position);
    }
}

function destroyCoreShaka(): void {
    var player = window.player;
    window.player = null;
    if (!player || typeof player.destroy !== "function") return;
    try {
        var pending = player.destroy();
        if (isCoreThenable(pending)) {
            if (window.__ottStandby) window.__ottStandby.observe(pending, true);
            _coreShakaTeardown = pending;
            var clear = function (): void {
                if (_coreShakaTeardown === pending) _coreShakaTeardown = null;
            };
            pending.then(clear, function (error) {
                clear();
                console.error("[Shaka] destroy failed:", error);
            });
        }
    } catch (error) {
        if (window.__ottStandby) window.__ottStandby.failed();
        console.error("[Shaka] destroy failed:", error);
    }
}

/**
 * Compatibility hook for retained archive callers. The backend owns timing.
 */
export function clearPlayTimeInterval(): void {
    // No per-stream timer to clear.
}
/** Active hls.js instance for the PiP video!. */
var hlsPipInstance: any = null;
var _corePipSession = 0;
var _corePipAutoCancel: ((restoreNative?: boolean) => void) | null = null;
/** Whether the player is currently in fullscreen mode. */
var isFullscreen = true;
/**
 * Current aspect ratio index: 0 = "contain" (letterbox), 1 = "cover" (crop).
 * Default contain matches OTT companion / classic PC stb — whole frame visible
 * (bars OK). Toggle Aspect Ratio still switches contain|cover; per-channel
 * aAspects overrides when set.
 */
var aspectRatio = 0;
var aspectGeneration = 0;
/**
 * Digital zoom index for HTML5: 0 = 100%, 1 = 125%, 2 = 150%, 3 = 175%.
 * Persisted per-channel in aZooms. Legacy only toggled body.stb-zoom with no CSS.
 */
var zoomLevel = 0;
var zoomScales = [1, 1.25, 1.5, 1.75];
var zoomLabels = ["100%", "125%", "150%", "175%"];

/** Active PiP size preset index (0 = small, 1 = medium, 2 = large). */
export var pipSize = 0;
/** Active PiP corner position index (0 = top-right, 1 = bottom-right, 2 = bottom-left, 3 = top-left). */
export var pipPosition = 0;
/** Whether the channel list is positioned on the right side (1) or left (0). */
export var listPos = 0;
/** Editor mode flag (1 = edit enabled, 0 = disabled). */
export var editorMode = 1;
/** Desired buffer size preference (string parsed from settings). */
export var bufSize: any = 0;
/** Encoded bytes per second of media, independent of download/playback speed. */
var prevDecodedBytes = -1;
var prevDecodedMediaTime = -1;
var _coreNativeMbps = 0;
var _coreHlsBitrate: ReturnType<typeof createCoreHlsBitrateMeter> | null = null;

function resetCoreNativeBitrate(): void {
    prevDecodedBytes = -1;
    prevDecodedMediaTime = -1;
    _coreNativeMbps = 0;
}

function createCoreHlsBitrateMeter(): {
    add: (data: any) => void;
    mbps: () => number;
} {
    var samples: {
        fragment: string;
        part: number;
        bytes: number;
        seconds: number;
    }[] = [];
    return {
        add: function (data: any): void {
            var frag = data && data.frag;
            var part = data && data.part;
            if (
                !frag ||
                frag.type !== "main" ||
                typeof frag.sn !== "number" ||
                frag.bitrateTest
            )
                return;
            var stats = (part ? part.stats : frag.stats) || data.stats;
            if (stats && stats.aborted) return;
            var bytes = stats && stats.loaded;
            if (!(bytes > 0) && data.payload) bytes = data.payload.byteLength;
            var seconds = part ? part.duration : frag.duration;
            if (
                typeof bytes !== "number" ||
                !(bytes > 0) ||
                !isFinite(bytes) ||
                typeof seconds !== "number" ||
                !(seconds > 0) ||
                !isFinite(seconds)
            )
                return;
            var fragment = [frag.level, frag.cc, frag.sn].join(":");
            var partIndex = part ? part.index : -1;
            for (var i = samples.length - 1; i >= 0; i--) {
                var sample = samples[i];
                if (sample.fragment !== fragment) continue;
                // A complete segment supersedes its LL-HLS parts. Retries
                // replace an existing observation rather than counting twice.
                if (part && sample.part === -1) return;
                if (!part || sample.part === partIndex) samples.splice(i, 1);
            }
            samples.push({
                bytes: bytes,
                fragment: fragment,
                part: partIndex,
                seconds: seconds,
            });
            if (samples.length > 8) samples.shift();
        },
        mbps: function (): number {
            var bytes = 0;
            var seconds = 0;
            for (var i = 0; i < samples.length; i++) {
                bytes += samples[i].bytes;
                seconds += samples[i].seconds;
            }
            return seconds > 0 ? (bytes * 8) / seconds / 1e6 : 0;
        },
    };
}

export function updateCoreVideoInfo(): void {
    if ((window as any).__ottStandby?.blocked()) return;
    if (!video || !video.videoWidth || video.error) return;
    var res = "<br/>" + video.videoWidth + "x" + video.videoHeight;
    var mbps = 0;
    if (hlsInstance) {
        // bandwidthEstimate is network throughput, which can reach hundreds
        // of Mbps on localhost. Manifest BANDWIDTH may also be a placeholder.
        // Measure the main media segments (including muxed audio/container).
        if (_coreHlsBitrate) mbps = _coreHlsBitrate.mbps();
    } else {
        var decoded = (video as any).webkitVideoDecodedByteCount;
        var position = video.currentTime;
        if (typeof decoded === "number" && decoded >= 0 && isFinite(decoded)) {
            if (
                video.seeking ||
                decoded < prevDecodedBytes ||
                position < prevDecodedMediaTime
            ) {
                _coreNativeMbps = 0;
                prevDecodedBytes = decoded;
                prevDecodedMediaTime = position;
            } else if (prevDecodedBytes < 0) {
                prevDecodedBytes = decoded;
                prevDecodedMediaTime = position;
            } else if (
                decoded > prevDecodedBytes &&
                position > prevDecodedMediaTime
            ) {
                _coreNativeMbps =
                    ((decoded - prevDecodedBytes) * 8) /
                    (position - prevDecodedMediaTime) /
                    1e6;
                // Decoder counters update in batches. Keep the full media-time
                // interval when another UI refresh observes no additional bytes.
                prevDecodedBytes = decoded;
                prevDecodedMediaTime = position;
            }
            mbps = _coreNativeMbps;
        }
        if (_coreNativeHls) {
            _coreNativeHls.poll();
            if (!mbps) mbps = _coreNativeHls.mbps();
        }
    }
    // An unknown bitrate is omitted, never replaced by a network estimate.
    $("#video_res").html(
        res +
            (mbps > 0 && isFinite(mbps)
                ? "<br/>" + Math.round(mbps * 100) / 100 + " Mbps"
                : "")
    );
}
/** PiP dimension presets in pixels: [small, medium, large]. */
var pipPresets = [
    { x: 256, y: 144 },
    { x: 384, y: 216 },
    { x: 512, y: 288 },
];

/**
 * Check whether the browser is currently NOT in fullscreen mode.
 * Uses vendor-prefixed fullscreen properties for cross-browser support.
 *
 * @returns `true` if no fullscreen API is active, `false` if in fullscreen.
 *          Returns `true` on error (defensive fallback).
 */
export function isNormalScreen(): boolean {
    try {
        return !(
            document.fullscreen ||
            (document as any).mozFullScreen ||
            (document as any).webkitFullScreen ||
            (document as any).msRequestFullscreen
        );
    } catch (e) {
        return true;
    }
}

/**
 * Request fullscreen on the entire document element.
 * Tries every vendor-prefixed API (standard, Moz, WebKit, MS).
 *
 * Side effects: Requests fullscreen from the browser; user gesture may be required.
 */
export function openFullscreen(): void {
    var elem = document.documentElement as any;
    if (elem.requestFullscreen) elem.requestFullscreen();
    else if (elem.mozRequestFullScreen) elem.mozRequestFullScreen();
    else if (elem.webkitRequestFullscreen) elem.webkitRequestFullscreen();
    else if (elem.msRequestFullscreen) elem.msRequestFullscreen();
}

/**
 * Exit fullscreen mode.
 * Uses the same vendor-prefixed strategy as openFullscreen.
 *
 * Side effects: Exits fullscreen; may trigger a resize event.
 */
export function closeFullscreen(): void {
    var doc = document as any;
    if (doc.exitFullscreen) doc.exitFullscreen();
    else if (doc.mozCancelFullScreen) doc.mozCancelFullScreen();
    else if (doc.webkitExitFullscreen) doc.webkitExitFullscreen();
    else if (doc.msExitFullscreen) doc.msExitFullscreen();
}

/** Execute native calls immediately, adopting their result without an ES5 generator. */
function runTauriFullscreenCall(action: () => any): Promise<any> {
    return new Promise(function (resolve) {
        resolve(action());
    });
}

function reportTauriFullscreenError(message: string, error?: any): void {
    try {
        if (error === undefined) console.warn(message);
        else console.warn(message, error);
    } catch (_) {}
}

/** Both public commands publish the native result before collapsing the list. */
function publishTauriFullscreen(next: boolean): void {
    var w = window as any;
    w.__ottTauriNativeFs = next;
    try {
        if (next && typeof w.closeList === "function") {
            var visible = !!w.isListVisible;
            try {
                if (
                    typeof w.$ !== "undefined" &&
                    (w.$("#list_window").is(":visible") ||
                        w.$("#list_osd").is(":visible"))
                )
                    visible = true;
            } catch (_) {}
            if (visible) w.closeList();
        }
    } catch (_) {}
}

/** Toggle uses core, then internals, then the older probe/set window contract. */
export function stbToggleTauriNativeFullscreen(): Promise<void> {
    var w = window as any,
        error: any = null;
    function fallback(): Promise<boolean | null> {
        return runTauriFullscreenCall(function () {
            var api = w.__TAURI__,
                tw = api && api.window;
            var current =
                tw && typeof tw.getCurrentWindow === "function"
                    ? tw.getCurrentWindow()
                    : tw && typeof tw.getCurrent === "function"
                      ? tw.getCurrent()
                      : null;
            if (!current) {
                var updated = w.__TAURI__,
                    webview = updated && updated.webviewWindow;
                if (webview && typeof webview.getCurrent === "function")
                    current = webview.getCurrent();
            }
            var cached = !!w.__ottTauriNativeFs;
            function set(probed: any): any {
                var want = !(typeof probed === "boolean" ? probed : cached);
                var latest = w.__TAURI__,
                    core = latest && latest.core;
                if (core && typeof core.invoke === "function")
                    return runTauriFullscreenCall(function () {
                        return core.invoke("set_fullscreen", {
                            fullscreen: want,
                        });
                    }).then(function () {
                        return want;
                    });
                if (current && typeof current.setFullscreen === "function")
                    return runTauriFullscreenCall(function () {
                        return current.setFullscreen(want);
                    }).then(function () {
                        return want;
                    });
                return null;
            }
            var probed: any = cached;
            if (current && typeof current.isFullscreen === "function") {
                try {
                    probed = current.isFullscreen();
                    if (probed && typeof probed.then === "function")
                        return Promise.resolve(probed).then(set, function () {
                            return set(cached);
                        });
                } catch (_) {
                    probed = cached;
                }
            }
            return set(probed);
        }).then(undefined, function (caught) {
            error = caught;
            return null;
        });
    }
    function request(index: number): Promise<boolean | null> {
        if (index === 2) return fallback();
        var api: any;
        try {
            var tauri = index === 0 ? w.__TAURI__ : null;
            api = index === 0 ? tauri && tauri.core : w.__TAURI_INTERNALS__;
            if (!api || typeof api.invoke !== "function")
                return request(index + 1);
        } catch (caught) {
            error = caught;
            return request(index + 1);
        }
        return runTauriFullscreenCall(function () {
            return api.invoke("toggle_fullscreen");
        })
            .then(function (result) {
                return result && typeof result.fullscreen === "boolean"
                    ? result.fullscreen
                    : !w.__ottTauriNativeFs;
            })
            .then(undefined, function (caught) {
                error = caught;
                return request(index + 1);
            });
    }
    return request(0)
        .then(function (next) {
            if (next === null)
                reportTauriFullscreenError(
                    "[Tauri] toggle_fullscreen failed:",
                    error || "no invoke path"
                );
            else publishTauriFullscreen(next);
        })
        .then(undefined, function (caught) {
            reportTauriFullscreenError(
                "[Tauri] L fullscreen toggle failed:",
                caught
            );
        });
}

/** Explicit set selects an invoke owner once; command rejection must not toggle or retry. */
export function stbSetTauriNativeFullscreen(want: boolean): Promise<void> {
    var w = window as any,
        api: any = null;
    try {
        var tauri = w.__TAURI__,
            core = tauri && tauri.core;
        if (core && typeof core.invoke === "function") api = core;
    } catch (_) {}
    if (!api) {
        try {
            var internals = w.__TAURI_INTERNALS__;
            if (internals && typeof internals.invoke === "function")
                api = internals;
        } catch (_) {}
    }
    if (!api) {
        reportTauriFullscreenError("[Tauri] set_fullscreen: no invoke path");
        return Promise.resolve();
    }
    return runTauriFullscreenCall(function () {
        return api.invoke("set_fullscreen", { fullscreen: !!want });
    })
        .then(function (result) {
            publishTauriFullscreen(
                result && typeof result.fullscreen === "boolean"
                    ? result.fullscreen
                    : !!want
            );
        })
        .then(undefined, function (caught) {
            reportTauriFullscreenError(
                "[Tauri] set_fullscreen failed:",
                caught
            );
        });
}

/**
 * Process a raw key event to toggle fullscreen when keyCode === 76 ('L').
 *
 * @param event - A raw keyboard event object (or null/undefined).
 * @returns The numeric keyCode from the event, or 0 if the key was consumed
 *          by fullscreen handling or if no event.
 *
 * Side effects: Toggles fullscreen when 'L' is pressed and prevents the
 *               default browser action (typing 'l' in input fields).
 */

/**
 * Tauri/macOS: native <video> often keeps focus in full-video mode so
 * window.onkeydown never sees L/Escape, while the channel list (no video
 * focus) still does. Capture-phase document listener toggles/exits simple
 * fullscreen without any global KeyL shortcut.
 */
export function installTauriFsKeyCapture(): void {
    if (typeof window === "undefined") return;
    if (typeof (window as any).__TAURI__ === "undefined") return;
    if ((window as any).__ottTauriFsKeyCapture) return;
    (window as any).__ottTauriFsKeyCapture = true;
    document.addEventListener(
        "keydown",
        function (ev: KeyboardEvent) {
            try {
                var t = ev.target as HTMLElement | null;
                if (
                    t &&
                    (t.tagName === "INPUT" ||
                        t.tagName === "TEXTAREA" ||
                        t.isContentEditable)
                ) {
                    return;
                }
                // The native editor owns Escape on its remote-input button,
                // just as it does while its text field has focus.
                if (t && t.id === "editRemoteInput") {
                    var port = (window as any).__ottClassicScreenPort;
                    var editor = port && port.owner("editor");
                    if (editor && editor.foreground()) return;
                }
            } catch (_t) {}
            var key = ev.key || "";
            var code = ev.code || "";
            var kc =
                typeof ev.keyCode === "number" && ev.keyCode
                    ? ev.keyCode
                    : typeof ev.which === "number" && ev.which
                      ? ev.which
                      : 0;
            var isL =
                kc === 76 || key === "l" || key === "L" || code === "KeyL";
            var isEsc = kc === 27 || key === "Escape" || code === "Escape";
            if (!isL && !isEsc) return;

            if (isL) {
                var editing = false;
                try {
                    if (
                        typeof (window as any).$ !== "undefined" &&
                        (window as any).$("#listEdit").is(":visible")
                    )
                        editing = true;
                } catch (_e) {}
                if (editing) return;
                // Rust toggle_fullscreen is the source of truth (simple FS
                // flag + geometry). Always toggle — do not guess from JS.
                void stbToggleTauriNativeFullscreen();
                if (ev.preventDefault) ev.preventDefault();
                if (ev.stopPropagation) ev.stopPropagation();
                if (typeof (ev as any).stopImmediatePropagation === "function")
                    (ev as any).stopImmediatePropagation();
                return;
            }

            // Escape: force exit simple FS when flagged; otherwise let
            // keyHandler run (list close / exitPortal).
            if (isEsc && (window as any).__ottTauriNativeFs) {
                void stbSetTauriNativeFullscreen(false);
                if (ev.preventDefault) ev.preventDefault();
                if (ev.stopPropagation) ev.stopPropagation();
                if (typeof (ev as any).stopImmediatePropagation === "function")
                    (ev as any).stopImmediatePropagation();
            }
        },
        true
    );
}

export function stbEventToKeyCode(event: any): number {
    if (!event) return 0;

    // Prefer classic keyCode/which; some hosts (incl. Tauri webview) report 0.
    var keyCode =
        typeof event.keyCode === "number" && event.keyCode
            ? event.keyCode
            : typeof event.which === "number" && event.which
              ? event.which
              : 0;
    var key = event.key || "";
    var code = event.code || "";
    var digit = /^[0-9]$/.test(key) ? Number(key) : -1;
    var deviceKeys = (window as any).keys || {};
    // Firefox uses 61/173 for these keyboard keys. Require keyboard identity:
    // bare 173 is also a remote-control mute code on some platforms.
    if (
        (!keyCode || keyCode === 61 || keyCode === 187) &&
        (code === "Equal" || key === "=" || key === "+")
    )
        keyCode = deviceKeys.CH_UP || 187;
    else if (
        (!keyCode || keyCode === 173 || keyCode === 189) &&
        (code === "Minus" || key === "-" || key === "_")
    )
        keyCode = deviceKeys.CH_DOWN || 189;
    // NumLock/Shift can report a navigation legacy code with a numeric DOM key.
    if (digit >= 0 && (/^Numpad[0-9]$/.test(code) || event.location === 3))
        keyCode = deviceKeys["N" + digit] || 48 + digit;
    if (
        keyCode >= 96 &&
        keyCode <= 105 &&
        (!key || key === "Unidentified" || digit >= 0)
    ) {
        // Bare TV codes can overlap DOM numpad codes (Maple INFO is 99).
        // Explicit keyboard identity wins; otherwise retain declared hardware keys.
        var hardware =
            !/^Numpad[0-9]$/.test(code) &&
            event.location !== 3 &&
            Object.keys(deviceKeys).some(function (name) {
                return deviceKeys[name] === keyCode;
            });
        if (!hardware) {
            var number = keyCode - 96;
            keyCode = deviceKeys["N" + number] || 48 + number;
        }
    }

    if (!keyCode) {
        var physicalDigit = /^Digit([0-9])$/.exec(code);
        if (!physicalDigit && (!key || key === "Unidentified" || digit >= 0))
            physicalDigit = /^Numpad([0-9])$/.exec(code);
        if (digit < 0 && physicalDigit) digit = Number(physicalDigit[1]);
        // Map common keys when keyCode/which is missing (sync; no Tauri invoke).
        if (digit >= 0) keyCode = deviceKeys["N" + digit] || 48 + digit;
        else if (key === "ArrowLeft" || code === "ArrowLeft") keyCode = 37;
        else if (key === "ArrowUp" || code === "ArrowUp") keyCode = 38;
        else if (key === "ArrowRight" || code === "ArrowRight") keyCode = 39;
        else if (key === "ArrowDown" || code === "ArrowDown") keyCode = 40;
        else if (key === "Enter" || code === "Enter" || code === "NumpadEnter")
            keyCode = 13;
        else if (key === "Escape" || code === "Escape") keyCode = 27;
        else if (key === " " || key === "Spacebar" || code === "Space")
            keyCode = 32;
        else if (key === "Backspace" || code === "Backspace") keyCode = 8;
        else if (key === "Delete" || code === "Delete") keyCode = 46;
        else if (key === "PageUp" || code === "PageUp") keyCode = 33;
        else if (key === "PageDown" || code === "PageDown") keyCode = 34;
        else if (key === "Home" || code === "Home") keyCode = 36;
        else if (key === "End" || code === "End") keyCode = 35;
        else if (key === "AudioVolumeMute" || code === "AudioVolumeMute")
            keyCode = 173; // keys.MUTE
        else if (key === "AudioVolumeDown" || code === "AudioVolumeDown")
            keyCode = 174; // keys.VOL_DOWN
        else if (key === "AudioVolumeUp" || code === "AudioVolumeUp")
            keyCode = 175; // keys.VOL_UP
        else if (
            key === "MediaPlayPause" ||
            code === "MediaPlayPause" ||
            key === "MediaPlay" ||
            code === "MediaPlay" ||
            key === "MediaPause" ||
            code === "MediaPause"
        )
            keyCode = 80; // keys.PLAY / keys.PAUSE
        else if (key === "MediaStop" || code === "MediaStop")
            keyCode = 83; // keys.STOP
        else if (key === "GoBack" || code === "GoBack" || key === "BrowserBack")
            keyCode = 27; // keys.EXIT (menu/back remotes; Android BACK parity)
        else if (key === "l" || key === "L" || code === "KeyL") keyCode = 76;
    }

    // Escape while Tauri native/simple fullscreen → force EXIT (not toggle).
    // Do not open exitPortal. Relies on macOS simple fullscreen so Escape
    // reaches the webview; never register a system-wide letter shortcut.
    if (keyCode === 27) {
        var inTauriEsc = typeof (window as any).__TAURI__ !== "undefined";
        if (inTauriEsc && (window as any).__ottTauriNativeFs) {
            void stbSetTauriNativeFullscreen(false);
            if (event.preventDefault) event.preventDefault();
            if (event.stopPropagation) event.stopPropagation();
            return 0;
        }
    }

    if (keyCode === 76) {
        // L/l/KeyL — fullscreen toggle on non-Tauri platforms.
        // On Tauri the capture-phase document listener in
        // installTauriFsKeyCapture owns L (stopImmediatePropagation
        // keeps window.onkeydown from running), so do NOT toggle here.
        var inTauri = typeof (window as any).__TAURI__ !== "undefined";
        if (!inTauri) {
            if (isNormalScreen()) openFullscreen();
            else closeFullscreen();
            if (event.preventDefault) event.preventDefault();
            if (event.stopPropagation) event.stopPropagation();
            return 0; // Indicate key was consumed
        }
    }
    return keyCode;
}

/**
 * Start playback of a given URL on the main video element.
 * Supports three engine modes: native HTML5, hls.js, and shaka-player.
 *
 * Playback start timing (exactly once per stream start):
 * - HLS path:    play() is invoked from the MANIFEST_PARSED event.
 * - Shaka path:  play() is invoked immediately after player.load().
 * - Native path: play() is invoked at the end of stbPlay().
 *
 * @param url      - Stream URL to play.
 * @param position - Optional start offset in seconds. Used as `#t=` fragment for
 *                   HLS (browser handles it on attach), and as a direct
 *                   currentTime assignment for native HTML5 (shaka does not
 *                   need it; Shaka receives it as its load startTime).
 *
 * Side effects:
 * - Destroys any previous hls.js or shaka instance.
 * - Attaches hls.js or shaka to the video element if that engine is active.
 * - Calls video!.play() exactly once.
 * - Automatically restores previous audio/subtitle track settings via applyChannelPreference.
 */
interface CoreStreamAttempt {
    dispose(): void;
    fail(kind: string, status?: number, position?: number): void;
    pause(): void;
    resume(): boolean;
}
var coreStreamAttempt: CoreStreamAttempt | null = null;
// Retained for the whole engine lease: an internal retry must not erase history.
var coreAttemptCounters: {
    engineStarts: number;
    fatalErrors: number;
    nativeFallbacks: number;
    streamRetries: number;
};
function countCoreAttempt(
    session: number,
    key: keyof typeof coreAttemptCounters
): void {
    if (session === _playSession)
        coreAttemptCounters[key] = Math.min(
            9007199254740991,
            coreAttemptCounters[key] + 1
        );
}
function cancelCoreStreamAttempt(): void {
    if (coreStreamAttempt) coreStreamAttempt.dispose();
    coreStreamAttempt = null;
}
function createCoreStreamAttempt(
    session: number,
    primary: string,
    restart: (url: string, position?: number) => void
): CoreStreamAttempt {
    var policy = (window as any).__ottStreamPolicy;
    var owner = policy && policy.capture();
    if (policy) policy.reset();
    var endpoints = policy ? policy.endpoints(primary) : [primary];
    var resumePosition: number | undefined;
    var endpoint = 0,
        attempts = 0,
        retries = 0,
        parseRetried = false;
    var timer: any = null,
        pending = false,
        disposed = false,
        ended = false;
    function active(): boolean {
        return (
            !disposed && session === _playSession && (!owner || owner.active())
        );
    }
    function report(state: string): void {
        if (policy)
            policy.report({
                attempts: attempts,
                endpoint: endpoint,
                state: state,
            });
    }
    function clear(): void {
        if (timer !== null) clearTimeout(timer);
        timer = null;
    }
    function schedule(): void {
        if (!active() || !pending || (window as any).forcePlay === false)
            return;
        clear();
        timer = setTimeout(
            function () {
                timer = null;
                if (
                    !active() ||
                    !pending ||
                    (window as any).forcePlay === false
                )
                    return;
                pending = false;
                attempts++;
                countCoreAttempt(session, "streamRetries");
                report("retrying");
                restart(endpoints[endpoint], resumePosition);
            },
            Math.min(2000, 500 * Math.max(1, attempts + 1))
        );
    }
    return {
        dispose: function () {
            disposed = true;
            clear();
        },
        fail: function (kind: string, status?: number, position?: number) {
            if (!active() || ended) return;
            var denied = status === 401 || status === 403 || kind === "auth";
            var parsing = kind === "parse";
            var recoverable =
                kind === "network" || kind === "decode" || parsing;
            // Parallel requests may report denial/DRM after a transient failure.
            // Terminal errors cancel that scheduled retry and any future attempts.
            if (pending && !denied && recoverable) return;
            resumePosition =
                position !== undefined
                    ? position
                    : video &&
                        video.readyState > 0 &&
                        isFinite(video.currentTime)
                      ? video.currentTime
                      : undefined;
            var transient =
                !status || status === 408 || status === 429 || status >= 500;
            if (
                !denied &&
                transient &&
                retries < 2 &&
                (kind === "network" || (parsing && !parseRetried))
            ) {
                retries++;
                parseRetried = parseRetried || parsing;
            } else if (
                !denied &&
                recoverable &&
                endpoint + 1 < endpoints.length
            )
                endpoint++;
            else {
                clear();
                pending = false;
                ended = true;
                report(denied ? "access-denied" : "failed");
                $("#buffering").hide();
                showShift(
                    denied
                        ? _("Source sign-in required")
                        : kind === "quality"
                          ? _("No stream meets the quality limits")
                          : _("Stream could not be played")
                );
                return;
            }
            pending = true;
            report("waiting");
            showShift(_("Reconnecting…"));
            schedule();
        },
        pause: clear,
        resume: function () {
            if (ended) return true;
            if (!pending) return false;
            schedule();
            return true;
        },
    };
}
function coreStreamFailure(
    kind: string,
    status?: number,
    position?: number
): void {
    if (_corePendingSeekPosition !== null) position = _corePendingSeekPosition;
    else if (
        hlsInstance &&
        !hlsInstance.hasEnoughToStart &&
        hlsInstance.config.startPosition >= 0
    )
        position = hlsInstance.config.startPosition;
    if (coreStreamAttempt) coreStreamAttempt.fail(kind, status, position);
}
var coreSourcePreparationCancel: (() => void) | null = null;
function cancelCoreSourcePreparation(): void {
    var cancel = coreSourcePreparationCancel;
    coreSourcePreparationCancel = null;
    if (cancel) cancel();
}

function startCoreEngine(
    url: string,
    position?: number,
    observe?: () => void,
    paused = false,
    sourceUrl = url,
    transient = false
): void {
    cancelCoreStreamAttempt();
    coreNativeAttached = false;
    _coreTransientPlayback = transient;
    setCoreDemoMute(!transient && (window as any).ottplayDemoActive === true);
    if (video)
        video.loop = !transient && (window as any).ottplayDemoActive === true;
    _playSession++;
    coreAttemptCounters = {
        engineStarts: 0,
        fatalErrors: 0,
        nativeFallbacks: 0,
        streamRetries: 0,
    };
    _coreAutoHlsUsed = false;
    cancelCoreSourcePreparation();
    cancelCoreAutoPlayback();
    cancelCoreNativeHls();
    // Set intent before source preparation, HLS manifests or Shaka attachment.
    (window as any).forcePlay = !paused;
    if (video && paused) video.autoplay = false;
    var session = _playSession;
    var plexHint = corePlexPlaybackHint(url);
    if (hlsInstance) {
        hlsInstance.destroy();
        hlsInstance = null;
    }
    cancelCoreSeek();
    destroyCoreShaka();
    clearPlayTimeInterval();
    if (
        window.__ottDebug &&
        window.__ottDebug.enabled &&
        typeof window.__ottDebug.beginSession === "function"
    ) {
        window.__ottDebug.beginSession(url);
    }
    // Shaka detach is asynchronous and may otherwise clear the next engine's src.
    var revision = 0;
    var start = function (): void {
        if (session !== _playSession || (streamOwner && !streamOwner.active()))
            return;
        var currentRevision = ++revision;
        var settled = false;
        var ready = function (playbackUrl: string): void {
            if (
                session !== _playSession ||
                currentRevision !== revision ||
                (streamOwner && !streamOwner.active())
            )
                return;
            settled = true;
            coreSourcePreparationCancel = null;
            if (observe) {
                observe();
                observe = undefined;
            }
            startCorePlayback(
                playbackUrl,
                position,
                session,
                url,
                transient ||
                    plexHint === "file" ||
                    !!(
                        (window as any).__ottLocalMedia &&
                        (window as any).__ottLocalMedia.isPlaybackUrl(url)
                    ),
                !transient && plexHint === "mse"
            );
        };
        function prepare(resolved: string): void {
            if (
                session !== _playSession ||
                currentRevision !== revision ||
                (streamOwner && !streamOwner.active())
            )
                return;
            if (!coreDeviceEffects.prepareSource) {
                ready(resolved);
                return;
            }
            var cancel = coreDeviceEffects.prepareSource(
                resolved,
                ready,
                function () {
                    if (
                        session !== _playSession ||
                        currentRevision !== revision
                    )
                        return;
                    settled = true;
                    coreSourcePreparationCancel = null;
                    coreStreamFailure("auth");
                }
            );
            if (!settled && typeof cancel === "function")
                coreSourcePreparationCancel = cancel;
        }
        if (url.indexOf("ottplay-stalker:") === 0) {
            var driver = (window as any).__ottActiveProviderDriver;
            if (!driver || !driver.resolveStream) {
                coreStreamFailure("auth");
                return;
            }
            var resolving = true;
            var cancelResolve = driver.resolveStream(
                url,
                function (resolved: string | null) {
                    resolving = false;
                    if (
                        session !== _playSession ||
                        currentRevision !== revision
                    )
                        return;
                    coreSourcePreparationCancel = null;
                    if (resolved) prepare(resolved);
                    else coreStreamFailure("auth");
                }
            );
            if (resolving) coreSourcePreparationCancel = cancelResolve;
        } else prepare(url);
    };
    var streamPolicy = transient ? null : (window as any).__ottStreamPolicy;
    var streamOwner = streamPolicy && streamPolicy.capture();
    coreStreamAttempt = transient
        ? null
        : createCoreStreamAttempt(
              session,
              sourceUrl,
              function (next: string, savedPosition?: number) {
                  var resumePosition =
                      _corePendingSeekPosition !== null
                          ? _corePendingSeekPosition
                          : savedPosition;
                  revision++;
                  cancelCoreSourcePreparation();
                  cancelCoreAutoPlayback();
                  cancelCoreNativeHls();
                  cancelCoreSeek();
                  coreNativeAttached = false;
                  if (hlsInstance) {
                      hlsInstance.destroy();
                      hlsInstance = null;
                  }
                  destroyCoreShaka();
                  if (video) {
                      // Read before destroy(): decoder teardown may reset currentTime.
                      // Live endpoints always start at their own live edge.
                      if (!streamOwner || !streamOwner.live)
                          position =
                              resumePosition !== undefined
                                  ? resumePosition
                                  : position;
                      video.pause();
                      video.removeAttribute("src");
                  }
                  url = next;
                  _coreAutoHlsUsed = false;
                  if (_coreShakaTeardown) _coreShakaTeardown.then(start, start);
                  else start();
              }
          );
    if (_coreShakaTeardown) _coreShakaTeardown.then(start, start);
    else start();
    window.playType = window.playType ?? 0;
    window.playTime = window.playTime ?? 0;
}

/**
 * Start main-video playback using hls.js, Shaka, or native HTML5.
 * Configure transport, resume seeking, and session-scoped Auto HLS fallback.
 *
 * @param url - Prepared media URL to load.
 * @param position - Optional playback start offset in seconds.
 * @param session - Playback session identifier used to ignore stale callbacks.
 * @param originalUrl - Original stream URL retained for recovery.
 * @param nativeFile - Use native playback for a prepared local file.
 * @param forceMse - Prefer hls.js when Media Source Extensions are supported.
 */
function startCorePlayback(
    url: string,
    position: number | undefined,
    session: number,
    originalUrl: string = url,
    nativeFile = false,
    forceMse = false
): void {
    countCoreAttempt(session, "engineStarts");
    cancelCoreNativeHls();
    _coreHlsBitrate = null;
    resetCoreNativeBitrate();
    forceMse = forceMse && typeof Hls !== "undefined" && Hls.isSupported();
    var auto =
        !nativeFile &&
        !forceMse &&
        playerMode === 3 &&
        getDefaultPlayerMode() === 3;
    var mode = forceMse
        ? 1
        : auto
          ? _coreAutoHlsUsed
              ? 1
              : coreAutoMode(url, video)
          : playerMode;
    // Decode-fail: try hls.js first, drop failing level, recover once; native only if Safari
    // Demo includes an MP4 as well as HLS. HLS auto-selection must not send
    // the MP4 into the manifest loader, or alter the saved engine preference.
    var _forceNative =
        nativeFile ||
        ((window as any).ottplayDemoActive === true &&
            /\/demo\/pattern\.mp4(?:[?#]|$)/i.test(url));
    var _pm =
        mode === 1 &&
        !_forceNative &&
        typeof Hls !== "undefined" &&
        Hls.isSupported()
            ? "hls.js"
            : mode === 2 && !_forceNative
              ? "shaka"
              : "html5";
    console.log("[stbPlay] playerMode=" + playerMode + " (" + _pm + ")");
    var useHls =
        mode === 1 &&
        !_forceNative &&
        typeof Hls !== "undefined" &&
        Hls.isSupported();
    _corePlaybackMode = useHls ? 1 : mode === 2 && !_forceNative ? 2 : 0;
    coreNativeAttached = false;
    var streamPolicy = (window as any).__ottStreamPolicy;
    var limits = streamPolicy
        ? streamPolicy.begin(_pm, _corePlaybackMode !== 0)
        : { maxBitrate: 0, maxHeight: 0 };
    if (useHls) {
        // #167 retry caps are archive-only: live FHD fragments are large and a
        // single timeout was aborting the stream (then video error 3 DECODE).
        var _isArchive =
            (position && position > 0) ||
            (typeof window.playType === "number" && window.playType > 0);
        var hlsConfig: any = {
            backBufferLength: 90,
            capLevelToPlayerSize: false,
            enableWorker: true,
            lowLatencyMode: false,
            maxBufferLength: 30,
            maxBufferSize: 120000000,
            maxMaxBufferLength: 600,
            overrideNative: false,
            startLevel: -1,
        };
        if (limits.maxHeight || limits.maxBitrate)
            hlsConfig.autoStartLoad = false;
        // HLS owns the initial seek after its first fragment is buffered.
        // Seeking at manifest/metadata time can stall WebKit's MSE decoder.
        if (position && isFinite(position) && position > 0)
            hlsConfig.startPosition = position;
        if (_isArchive) {
            hlsConfig.fragLoadingMaxRetry = 1;
            hlsConfig.levelLoadingMaxRetry = 1;
            hlsConfig.manifestLoadingMaxRetry = 1;
        }
        hlsInstance = new Hls(hlsConfig);
        var playbackHls = hlsInstance;
        var bitrateMeter = createCoreHlsBitrateMeter();
        _coreHlsBitrate = bitrateMeter;
        hlsInstance.on(
            Hls.Events.FRAG_LOADED,
            function (_event: any, data: any) {
                if (session !== _playSession || hlsInstance !== playbackHls)
                    return;
                bitrateMeter.add(data);
            }
        );
        if (
            window.__ottDebug &&
            window.__ottDebug.enabled &&
            typeof window.__ottDebug.attachHls === "function"
        ) {
            window.__ottDebug.attachHls(hlsInstance);
        }
        var recovery = new window.OttPlayCore.PlaybackRecovery(2);
        hlsInstance.loadSource(url);
        hlsInstance.attachMedia(video);
        hlsInstance.on(Hls.Events.ERROR, function (_event: any, data: any) {
            if (session !== _playSession || hlsInstance !== playbackHls) return;
            if (data.fatal) {
                countCoreAttempt(session, "fatalErrors");
                console.error("[HLS] fatal error:", data.type, data.details);
                var httpStatus = data.response && Number(data.response.code);
                if (httpStatus === 401 || httpStatus === 403) {
                    coreStreamFailure("auth", httpStatus);
                    hlsInstance.destroy();
                    hlsInstance = null;
                    return;
                }
                if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                    // Recovery reattaches media and may reset currentTime.
                    // Preserve pending user seeks before sampling the decoder.
                    if (hlsInstance.hasEnoughToStart && !_corePendingSeek)
                        hlsInstance.config.startPosition = video!.currentTime;
                    var lvls = hlsInstance.levels || [];
                    var failed =
                        data.frag && typeof data.frag.level === "number"
                            ? data.frag.level
                            : typeof data.level === "number"
                              ? data.level
                              : hlsInstance.currentLevel;
                    if (lvls.length > 1 && failed > 0) {
                        var cap = failed - 1;
                        console.log(
                            "[HLS] MEDIA_ERROR: drop level " +
                                failed +
                                " cap=" +
                                cap
                        );
                        hlsInstance.autoLevelCapping = cap;
                        if (typeof hlsInstance.removeLevel === "function") {
                            hlsInstance.removeLevel(failed);
                            hlsInstance.startLoad(
                                _corePendingSeek ||
                                    !hlsInstance.hasEnoughToStart
                                    ? hlsInstance.config.startPosition
                                    : -1
                            );
                            return;
                        }
                        hlsInstance.currentLevel = cap;
                    } else {
                        // hls-proxy always exposes a single STREAM-INF, so
                        // drop-level never runs for proxied live channels.
                        console.log(
                            "[HLS] MEDIA_ERROR: skip drop level (levels=" +
                                lvls.length +
                                " failed=" +
                                failed +
                                ")"
                        );
                    }
                    if (recovery.media()) {
                        console.log(
                            "[HLS] trying recoverMediaError" +
                                (data.details ? " (" + data.details + ")" : "")
                        );
                        cancelCoreSeek();
                        hlsInstance.recoverMediaError();
                        if (
                            session === _playSession &&
                            hlsInstance === playbackHls &&
                            hlsInstance.config.startPosition >= 0
                        )
                            hlsInstance.startLoad(
                                hlsInstance.config.startPosition
                            );
                    } else {
                        // Chrome/Edge MSE cannot play HLS natively. Setting
                        // video.src to an .m3u8 only yields SRC_NOT_SUPPORTED
                        // and hides the real cause (often mp2/ac3 audio on
                        // "HD Orig" streams — use remuxed "HD" / AAC instead).
                        var canNative = false;
                        try {
                            canNative = !!(
                                video &&
                                typeof video.canPlayType === "function" &&
                                video.canPlayType(
                                    "application/vnd.apple.mpegurl"
                                )
                            );
                        } catch (_e) {
                            canNative = false;
                        }
                        var det = String((data && data.details) || "");
                        var appendFail =
                            det.indexOf("bufferAppend") !== -1 ||
                            det.indexOf("bufferAppendError") !== -1;
                        // destroy() clears currentTime. Preserve the requested/resumed
                        // VOD position before moving from MSE to native HLS.
                        var nativePosition = hlsInstance.config.startPosition;
                        var failedPosition =
                            video && video.readyState > 0
                                ? video.currentTime
                                : nativePosition;
                        hlsInstance.destroy();
                        hlsInstance = null;
                        // Auto already tried native. Never loop back to the
                        // decoder that silently dropped this stream's video.
                        if (
                            canNative &&
                            !auto &&
                            !limits.maxHeight &&
                            !limits.maxBitrate
                        ) {
                            console.log(
                                "[HLS] MEDIA_ERROR twice, fallback native HTML5"
                            );
                            _corePlaybackMode = 0;
                            countCoreAttempt(session, "nativeFallbacks");
                            countCoreAttempt(session, "engineStarts");
                            if (streamPolicy)
                                streamPolicy.begin("html5", false);
                            video!.src = url;
                            if (session === _playSession)
                                coreNativeAttached = true;
                            if (nativePosition > 0)
                                seekCoreMedia(nativePosition, session);
                            if ((window as any).forcePlay !== false)
                                playCoreMedia(video!);
                        } else {
                            console.log(
                                "[HLS] MEDIA_ERROR twice, no native HLS" +
                                    (det ? " details=" + det : "") +
                                    (appendFail
                                        ? " (HD Orig often mp2/ac3 + strict Chrome decode)"
                                        : "")
                            );
                            coreStreamFailure(
                                "decode",
                                undefined,
                                failedPosition >= 0 ? failedPosition : undefined
                            );
                            $("#buffering").hide();
                            $("#video_res").html(
                                "<br/>error DECODE" +
                                    (appendFail ? " (HD Orig)" : "") +
                                    " — try HD remux / AAC"
                            );
                        }
                    }
                } else if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                    // levelParsingError / manifest parse are not transient —
                    // startLoad() would loop forever (no-EPG archive bad URL,
                    // purged segments, proxy HTML error pages).
                    var det = String((data && data.details) || "");
                    if (!recovery.network(det)) {
                        console.log(
                            "[HLS] unrecoverable network/parse, destroying"
                        );
                        coreStreamFailure(
                            window.OttPlayCore.playbackParsingFailure(det)
                                ? "parse"
                                : "network",
                            httpStatus
                        );
                        hlsInstance.destroy();
                        hlsInstance = null;
                    } else {
                        console.log("[HLS] trying startLoad");
                        hlsInstance.startLoad(
                            _corePendingSeek || !hlsInstance.hasEnoughToStart
                                ? hlsInstance.config.startPosition
                                : -1
                        );
                    }
                } else {
                    console.log("[HLS] unrecoverable, destroying");
                    coreStreamFailure("decode");
                    hlsInstance.destroy();
                    hlsInstance = null;
                }
            }
        });
        hlsInstance.on(Hls.Events.MANIFEST_PARSED, function () {
            if (session !== _playSession || hlsInstance !== playbackHls) return;
            if (streamPolicy && !streamPolicy.hls(playbackHls, limits)) {
                playbackHls.destroy();
                hlsInstance = null;
                coreStreamFailure("quality");
                return;
            }
            if (limits.maxHeight || limits.maxBitrate)
                playbackHls.startLoad(
                    position && isFinite(position) && position > 0
                        ? position
                        : -1
                );
            if ((window as any).forcePlay !== false) {
                playCoreMedia(video!);
            }
        });
        hlsInstance.on(
            Hls.Events.AUDIO_TRACKS_UPDATED,
            function (_e: any, d: any) {
                if (session !== _playSession || hlsInstance !== playbackHls)
                    return;
                applyChannelPreference("aAudios", function (i: number) {
                    if (hlsInstance) hlsInstance.audioTrack = i;
                });
                if (typeof (window as any).refreshAudioBadge === "function")
                    (window as any).refreshAudioBadge();
            }
        );
        hlsInstance.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, function () {
            if (session !== _playSession || hlsInstance !== playbackHls) return;
            applyChannelPreference("aSubs", setSubtitleTrack);
        });
        applyChannelPreference("aSubs", function (i: number) {
            if (hlsInstance) hlsInstance.subtitleTrack = i - 1;
        });
    } else if (
        mode === 2 &&
        !_forceNative &&
        typeof shaka !== "undefined" &&
        shaka.Player &&
        shaka.Player.isBrowserSupported()
    ) {
        var modernShaka = !!(window as any).__ottNativeRuntime;
        var playbackShaka = modernShaka
            ? new shaka.Player()
            : new shaka.Player(video);
        window.player = playbackShaka;
        if (
            typeof playbackShaka.configure === "function" &&
            (limits.maxHeight || limits.maxBitrate)
        )
            playbackShaka.configure({
                restrictions: {
                    maxBandwidth: limits.maxBitrate || Infinity,
                    maxHeight: limits.maxHeight || Infinity,
                },
            });
        var loaded = function (): void {
            if (
                session === _playSession &&
                window.player === playbackShaka &&
                (window as any).forcePlay !== false
            ) {
                playCoreMedia(video!);
            }
        };
        var failed = function (error: unknown): void {
            if (session !== _playSession || window.player !== playbackShaka)
                return;
            console.error("[Shaka] load failed:", error);
            var detail: any = error;
            if (detail && (detail.code === 7000 || detail.code === 7001))
                return;
            var status =
                detail && detail.code === 1001 && detail.data
                    ? Number(detail.data[1])
                    : undefined;
            coreStreamFailure(
                detail && detail.code === 4012
                    ? "quality"
                    : detail && detail.category === 1
                      ? "network"
                      : detail && detail.category === 6
                        ? "drm"
                        : "decode",
                status
            );
        };
        if (typeof playbackShaka.addEventListener === "function")
            playbackShaka.addEventListener("error", function (event: any) {
                if (event.detail && event.detail.severity === 2)
                    failed(event.detail);
            });
        var loadShaka = function (): void {
            // attach() in current Shaka is asynchronous. A stop/channel switch
            // during attachment must not load an obsolete stream afterwards.
            if (session !== _playSession || window.player !== playbackShaka)
                return;
            try {
                var loading = playbackShaka.load(
                    url,
                    position && position > 0 ? position : undefined
                );
                if (isCoreThenable(loading)) loading.then(loaded, failed);
                else loaded();
            } catch (error) {
                failed(error);
            }
        };
        try {
            if (modernShaka) {
                var attached = playbackShaka.attach(video);
                if (isCoreThenable(attached)) attached.then(loadShaka, failed);
                else loadShaka();
            } else loadShaka();
        } catch (error) {
            failed(error);
        }
    } else {
        var media = video!;
        var attempt = _coreNativeAttempt;
        var nativeAttached = false;
        var active = function (): boolean {
            return (
                session === _playSession &&
                video === media &&
                attempt === _coreNativeAttempt
            );
        };
        var resumePosition = function (): number | undefined {
            // Native live and MSE timelines need not share an origin.
            return position || (window as any).playType
                ? media.currentTime || position
                : undefined;
        };
        var attachNative = function (sourceUrl: string): void {
            if (!active()) return;
            nativeAttached = true;
            media.src = sourceUrl;
            if (active()) coreNativeAttached = true;
            if (position && position > 0)
                seekCoreMedia(position, session, true);
            if (sourceUrl !== url) {
                // An unsupported relay response must not take away a stream
                // that the platform could play directly. Retry direct once.
                var directFallback = function (): void {
                    if (!active()) return;
                    position = resumePosition();
                    cancelCoreAutoPlayback();
                    cancelCoreSeek();
                    if (_coreNativeHls) _coreNativeHls.cancel();
                    _coreNativeHls = null;
                    if (_coreNativeHlsCleanup) _coreNativeHlsCleanup();
                    _coreNativeHlsCleanup = null;
                    resetCoreNativeBitrate();
                    attachNative(url);
                };
                media.addEventListener("error", directFallback);
                _coreNativeHlsCleanup = function (): void {
                    media.removeEventListener("error", directFallback);
                };
            }
            if (
                auto &&
                !_coreAutoHlsUsed &&
                (/\.m3u8(?:[?#]|$)/i.test(url) || isNativeHlsUrl(url)) &&
                typeof Hls !== "undefined" &&
                Hls.isSupported()
            ) {
                _coreAutoCancel = watchAutoNativePlayback(
                    media,
                    sourceUrl,
                    Hls,
                    {
                        active: function () {
                            return active() && playerMode === 3;
                        },
                        fallback: function () {
                            _coreAutoCancel = null;
                            _coreAutoHlsUsed = true;
                            var nextPosition = resumePosition();
                            cancelCoreSeek();
                            media.pause();
                            coreNativeAttached = false;
                            media.removeAttribute("src");
                            console.log(
                                "[Auto] native HLS incompatible, using hls.js"
                            );
                            startCorePlayback(
                                url,
                                nextPosition,
                                session,
                                originalUrl
                            );
                        },
                        monitorDroppedFrames: !!(
                            (window as any).__TAURI__ ||
                            (window as any).__TAURI_INTERNALS__
                        ),
                        restore: function () {
                            var nextPosition = resumePosition();
                            cancelCoreSeek();
                            // A codec probe may replace the upstream session.
                            // Reload through the same transport, preserving native.
                            media.src = sourceUrl;
                            if (nextPosition)
                                seekCoreMedia(nextPosition, session);
                            if ((window as any).forcePlay !== false)
                                playCoreMedia(media);
                        },
                    }
                );
            }
            if ((window as any).forcePlay !== false) playCoreMedia(media);
        };
        // Prepare the transport before assigning src: only the player's actual
        // requests fetch playlists/segments, never an extra statistics probe.
        _coreNativeHls = nativeFile
            ? null
            : createNativeHlsTransport(url, {
                  active: active,
                  changed: updateCoreVideoInfo,
                  failed: function (): void {
                      attachNative(url);
                  },
                  ready: attachNative,
              });
        if (!_coreNativeHls) attachNative(url);
        else if (!nativeAttached) {
            media.pause();
            media.removeAttribute("src");
        }
    }
}

/**
 * Stop playback: pause, remove the src attribute, and destroy the hls.js instance.
 * Side effects: Mutates video element; may free decoder resources.
 */
function stopCoreEngine(): void {
    coreNativeAttached = false;
    if (video) video.loop = false;
    _coreTransientPlayback = false;
    cancelCoreStreamAttempt();
    var policy = (window as any).__ottStreamPolicy;
    if (policy) policy.report({ state: "stopped" });
    _playSession++;
    cancelCoreSourcePreparation();
    cancelCoreSeek();
    cancelCoreAutoPlayback();
    cancelCoreNativeHls();
    _coreHlsBitrate = null;
    resetCoreNativeBitrate();
    (window as any).forcePlay = false;
    video!.pause();
    video!.removeAttribute("src");
    setCoreDemoMute(false);
    destroyCoreShaka();
    if (hlsInstance) {
        hlsInstance.destroy();
        hlsInstance = null;
    }
    // Removing src alone can leave the selected native resource buffering.
    // Reset it after detaching engines so Stop also aborts its network fetch.
    try {
        if (typeof video!.load === "function") video!.load();
    } catch (_) {
        console.warn("[Stop] Could not reset the main media resource.");
    }
    clearPlayTimeInterval();
}
/**
 * Pause playback.
 * Side effects: Sets video!.pause().
 */
/** Device ABI delegates to the backend's current lease. */
export function stbPlay(url: string, position?: number): void {
    if (stbIsStandby()) return;
    var playback = (window as any).__ottClassicPlayback;
    if (playback) playback.importLegacy();
    getCoreMediaBackend().open({ position: position, url: url });
}
export function stbStop(): void {
    var media = (window as any).__ottMedia;
    if (media && media.cancelAuto) media.cancelAuto();
    if ((window as any).__ottClassicPlayback)
        (window as any).__ottClassicPlayback.cancel();
    getCoreMediaBackend().stop();
}
export function stbPause(): void {
    var handle = getCoreMediaBackend().current();
    if (handle) handle.pause();
}
/** Explicit Play must not toggle a loading or already playing lease to pause. */
export function stbResume(): void {
    if (stbIsStandby()) return;
    var handle = getCoreMediaBackend().current();
    if (handle) handle.resume();
}
export function stbContinue(): void {
    if (stbIsStandby()) return;
    var handle = getCoreMediaBackend().current();
    if (!handle) return;
    if (video && video.paused) handle.resume();
    else handle.pause();
}
export function stbIsPlaying(): boolean {
    // A diagnostic clip is not the live channel: do not enter its catch-up path.
    if (coreAvTest && coreAvTest.active()) return false;
    var handle = getCoreMediaBackend().current();
    return (
        !!handle &&
        !!video &&
        !video.paused &&
        (handle.snapshot().phase !== "loading" || video.readyState >= 2)
    );
}
/**
 * Toggle the muted state on the video element.
 * Side effects: Flips video!.muted.
 */
export function stbToggleMute(): void {
    if (_coreDemoMute && (window as any).ottplayDemoActive === true) {
        video!.muted = true;
        return;
    }
    setCoreDemoMute(false);
    video!.muted = !video!.muted;
}
/**
 * Get the current volume level as a percentage.
 * @returns Volume in range 0–100.
 */
export function stbGetVolume(): number {
    return video!.volume * 100;
}
/**
 * Set the volume level.
 * @param v - Volume in range 0–100 (will be divided by 100 for the video element).
 * Side effects: Sets video!.volume.
 */
export function stbSetVolume(v: number): void {
    video!.volume = v / 100;
    if (coreDeviceEffects.volume) coreDeviceEffects.volume(v);
}
/**
 * Get the current playback position.
 * @returns Current time in seconds.
 */
export function stbGetPosTime(): number {
    return video!.currentTime;
}
/**
 * Seek to a specific playback position.
 * @param v - Target time in seconds.
 * Side effects: Sets video!.currentTime.
 */
export function stbSetPosTime(v: number): void {
    getCoreMediaBackend().seek(v);
    if (
        (window as any).playType < 0 &&
        typeof (window as any).updateMediaInfo === "function"
    )
        (window as any).updateMediaInfo();
}
/**
 * Get the total duration of the loaded media.
 * @returns Duration in seconds (may be NaN or Infinity for live streams).
 */
export function stbGetLen(): number {
    return video!.duration;
}

/**
 * Expand the video container to fill the entire viewport (in-page fullscreen,
 * not browser fullscreen API). Sets the isFullscreen flag and reapplies
 * the aspect ratio CSS.
 *
 * Side effects: Mutates #video and #vdiv element positions/sizes via jQuery.
 */
export function stbToFullScreen(): void {
    if (coreDeviceEffects.fullscreen) coreDeviceEffects.fullscreen(true);
    isFullscreen = true;
    // Pin #vdiv to the visible viewport edges (not height/width 100% of an
    // oversized body — same failure mode as the 1.1.28 info-band bug). Flex
    // centers letterboxed frames when aspect is contain (WKWebView object-position
    // on <video> is unreliable).
    $("#vdiv").css({
        "align-items": "center",
        bottom: 0,
        display: "flex",
        height: "auto",
        "justify-content": "center",
        left: 0,
        position: "absolute",
        right: 0,
        top: 0,
        width: "auto",
    });
    try {
        var box = document.getElementById("vdiv");
        if (box) void (box as HTMLElement).offsetWidth;
    } catch (_reflow) {}
    applyAspectRatio();
    applyZoom();
}

/**
 * Shrink the video to a small window (picture-in-window) rather than fullscreen.
 * Position is calculated relative to a 1280×720 design canvas.
 *
 * Side effects: Mutates #video and #vdiv CSS dimensions; sets isFullscreen to false.
 */
export function stbSetWindow(): void {
    if (coreDeviceEffects.fullscreen) coreDeviceEffects.fullscreen(false);
    isFullscreen = false;
    var h = window.innerHeight / 720,
        w = window.innerWidth / 1280;
    var preview = listPreviewRect(
        (window as any).sInterfaceTheme,
        window.sListPos
    );
    $("#vdiv").css({
        "align-items": "center",
        bottom: "auto",
        display: "flex",
        height: preview.height * h + "px",
        "justify-content": "center",
        left: preview.left * w + "px",
        position: "absolute",
        right: "auto",
        top: preview.top * h + "px",
        width: preview.width * w + "px",
    });
    applyAspectRatio();
    applyZoom();
}

/**
 * Append local diagnostic info to the #listAbout element.
 *
 * Full also looks up the public IP; Play removes that request at build time.
 */
export function stbInfo(): void {
    $("#listAbout").append("<br/>userAgent: " + navigator.userAgent);
    var devId =
        typeof localStorage !== "undefined"
            ? localStorage.getItem("deviceId")
            : null;
    if (devId) $("#listAbout").append("<br/>Device ID: " + devId);
    var localUrl =
        typeof localStorage !== "undefined"
            ? localStorage.getItem("local_poll_url")
            : null;
    if (localUrl) $("#listAbout").append("<br/>Local Poll URL: " + localUrl);
    // OTTPLAY_FULL_ONLY_BEGIN
    $.get("http://api.ipify.org", function (d: any) {
        $("#listAbout").append("<br/>Ip address: " + d);
    });
    // OTTPLAY_FULL_ONLY_END
}

/**
 * Set the aspect ratio index and immediately apply it to the video element.
 * @param v - 0 = "contain" (letterbox), 1 = "cover" (crop/fill).
 * Side effects: Calls applyAspectRatio which mutates video CSS object-fit.
 */
export function setAspect(v: number): void {
    aspectRatio = v === 1 ? 1 : 0;
    aspectGeneration++;
    applyAspectRatio();
    applyZoom();
}

/** Observe the current main-video aspect and capture a fenced durable setter. */
export function captureAspectTarget(): any {
    var media = video;
    var backend = coreMediaBackend;
    var owner = backend && backend.current();
    var transport = (window as any).__ottCoreTransport;
    var play = transport && transport.play;
    var preference =
        typeof captureChannelPreference === "function"
            ? captureChannelPreference("aAspects")
            : null;
    var generation = aspectGeneration;
    function active(): boolean {
        var element = document.getElementById("video");
        return !!(
            preference &&
            preference.active() &&
            media &&
            media === video &&
            element &&
            (element === media || element.contains(media)) &&
            transport &&
            transport === (window as any).__ottCoreTransport &&
            transport.play === play &&
            play === window.stbPlay &&
            backend === coreMediaBackend &&
            owner &&
            owner.active() &&
            backend.current() === owner &&
            generation === aspectGeneration
        );
    }
    if (!active()) return null;
    var initial = preference.get();
    var saved = preference.saved();
    function current(): boolean {
        return active() && preference.get() === initial;
    }
    return {
        current: current,
        mode: aspectRatio === 1 ? "fill" : "fit",
        savedMode: saved === 1 ? "fill" : saved === 0 ? "fit" : null,
        set: function (mode: string): boolean {
            if ((mode !== "fit" && mode !== "fill") || !current()) return false;
            var value = mode === "fill" ? 1 : 0;
            if (!preference.set(value) || !active()) return false;
            setAspect(value);
            return true;
        },
    };
}

/**
 * Apply the current aspectRatio to the #video element's CSS `object-fit` property.
 * Index 0 → "contain", index 1 → "cover".
 *
 * Side effects: Direct DOM CSS mutation on #video!.
 */
export function applyAspectRatio(): void {
    var fit = ["contain", "cover"][aspectRatio] || "contain";
    var box = document.getElementById("vdiv");
    // Optional engines may put #video on a wrapper; intrinsic dimensions
    // always belong to the retained media element. CSS still sizes #video.
    var vEl = video;
    // Force layout after stbToFullScreen / resize CSS so client* is not stale
    // (1.1.29 explicit px geometry otherwise froze the previous crop size).
    if (box) void (box as HTMLElement).offsetWidth;
    var cw = 0;
    var ch = 0;
    if (isFullscreen) {
        // Viewport is the plane in full-video; more reliable than client* right
        // after inset:0 is applied on resize.
        cw = window.innerWidth || 0;
        ch = window.innerHeight || 0;
    } else if (box) {
        cw = box.clientWidth;
        ch = box.clientHeight;
    }
    var vw = vEl && vEl.videoWidth ? vEl.videoWidth : 0;
    var vh = vEl && vEl.videoHeight ? vEl.videoHeight : 0;
    // Explicit geometry: WKWebView often top-aligns letterboxed <video> frames
    // despite object-position:center. Size the element to the fitted frame and
    // let flex (#vdiv) center it (contain) or absolute-center the cover crop.
    if (cw > 0 && ch > 0 && vw > 0 && vh > 0) {
        var scale =
            fit === "contain"
                ? Math.min(cw / vw, ch / vh)
                : Math.max(cw / vw, ch / vh);
        var w = Math.max(1, Math.round(vw * scale));
        var h = Math.max(1, Math.round(vh * scale));
        if (fit === "contain") {
            $("#video").css({
                bottom: "",
                height: h + "px",
                left: "",
                "max-height": "100%",
                "max-width": "100%",
                "object-fit": "fill",
                "object-position": "center center",
                position: "relative",
                right: "",
                top: "",
                width: w + "px",
            });
        } else {
            $("#video").css({
                bottom: "",
                height: h + "px",
                left: Math.round((cw - w) / 2) + "px",
                "max-height": "",
                "max-width": "",
                "object-fit": "fill",
                "object-position": "center center",
                position: "absolute",
                right: "",
                top: Math.round((ch - h) / 2) + "px",
                width: w + "px",
            });
        }
        return;
    }
    // Fallback before metadata: CSS contain max-box / cover fill + flex center.
    if (fit === "contain") {
        $("#video").css({
            bottom: "",
            height: "auto",
            left: "",
            "max-height": "100%",
            "max-width": "100%",
            "object-fit": "contain",
            "object-position": "center center",
            position: "relative",
            right: "",
            top: "",
            width: "auto",
        });
    } else {
        $("#video").css({
            bottom: 0,
            height: "100%",
            left: 0,
            "max-height": "",
            "max-width": "",
            "object-fit": "cover",
            "object-position": "center center",
            position: "absolute",
            right: 0,
            top: 0,
            width: "100%",
        });
    }
}

/**
 * Open a selection box to let the user toggle between "contain" and "cover" aspect ratios.
 * On selection, persists the choice via saveChannelPreference.
 *
 * Side effects: Shows a select-box UI; writes to per-channel storage (aAspects).
 */
export function stbToggleAspectRatio(): void {
    showSelectBox(
        aspectRatio,
        [_("Fit to screen"), _("Fill screen")],
        function (v: number) {
            setAspect(v);
            saveChannelPreference("aAspects", v);
        }
    );
}

/**
 * Check whether more than one audio track is available (hls.js or native).
 * @returns `true` if multiple audio tracks exist.
 */
export function stbAudioTracksExists(): boolean {
    var v = hlsInstance || video;
    return v && v.audioTracks ? v.audioTracks.length > 1 : false;
}

/**
 * True when a native textTrack looks like a real, selectable subtitle/caption
 * (not metadata, and not an anonymous WebKit placeholder with no label/lang).
 */
function isUsableNativeSubtitleTrack(t: any): boolean {
    var kind = (t && t.kind) || "";
    if (kind && kind !== "subtitles" && kind !== "captions") return false;
    return !!(t && (t.label || t.name || t.language || t.lang));
}

/**
 * Count available subtitle tracks worth offering in the Menu / picker.
 * hls.js: EXT-X-MEDIA subtitleTracks (0 when muxed remux has none — Chrome path).
 * Native HTML5 (Tauri/WKWebView): only subtitles/captions with label or language;
 * anonymous WebKit placeholders must not surface as "Switch subtitle".
 * @returns Number of usable subtitle/text tracks.
 */
export function stbSubtitleExists(): number {
    if (hlsInstance) return (hlsInstance.subtitleTracks || []).length;
    var tt = (video && video.textTracks) || [];
    var n = 0;
    for (var i = 0; i < tt.length; i++) {
        if (isUsableNativeSubtitleTrack(tt[i])) n++;
    }
    return n;
}

/**
 * Start PiP (picture-in-picture) playback for a given stream URL.
 * Supports hls.js when playerMode === 1.
 *
 * @param url - Stream URL for the PiP window.
 *
 * Side effects: Shows #videopip; attaches hls.js or native src; calls videoPip!.play().
 */
function startCorePipEngine(url: string): void {
    corePipNativeAttached = false;
    videoPip!.loop = (window as any).ottplayDemoActive === true;
    var demoMp4 =
        ((window as any).ottplayDemoActive === true &&
            /\/demo\/pattern\.mp4(?:[?#]|$)/i.test(url)) ||
        !!(
            (window as any).__ottLocalMedia &&
            (window as any).__ottLocalMedia.isPlaybackUrl(url)
        );
    var session = ++_corePipSession;
    if (_corePipAutoCancel) _corePipAutoCancel();
    _corePipAutoCancel = null;
    if (hlsPipInstance) {
        hlsPipInstance.destroy();
        hlsPipInstance = null;
    }
    var auto = playerMode === 3 && getDefaultPlayerMode() === 3;
    var canHls = typeof Hls !== "undefined" && Hls.isSupported();
    var mode = auto ? coreAutoMode(url, videoPip) : playerMode;
    var startHls = function (): void {
        var pipHls = new Hls();
        hlsPipInstance = pipHls;
        pipHls.on(Hls.Events.MANIFEST_PARSED, function () {
            if (session === _corePipSession && hlsPipInstance === pipHls)
                playCoreMedia(videoPip!);
        });
        pipHls.loadSource(url);
        pipHls.attachMedia(videoPip);
    };
    if (!demoMp4 && mode === 1 && canHls) {
        startHls();
    } else {
        videoPip!.src = url;
        if (session === _corePipSession) corePipNativeAttached = true;
        if (
            auto &&
            (/\.m3u8(?:[?#]|$)/i.test(url) || isNativeHlsUrl(url)) &&
            canHls
        ) {
            var media = videoPip!;
            _corePipAutoCancel = watchAutoNativePlayback(media, url, Hls, {
                active: function () {
                    return (
                        session === _corePipSession &&
                        videoPip === media &&
                        playerMode === 3
                    );
                },
                fallback: function () {
                    _corePipAutoCancel = null;
                    media.pause();
                    corePipNativeAttached = false;
                    media.removeAttribute("src");
                    startHls();
                },
                restore: function () {
                    _corePipAutoCancel = null;
                    media.src = url;
                    if (session === _corePipSession)
                        corePipNativeAttached = true;
                    playCoreMedia(media);
                },
            });
        }
        playCoreMedia(videoPip!);
    }
    $("#videopip").show();
    setPipPosition();
}

/** Stop PiP, cancel its callbacks, and release the decoder and buffering OSD. */
function stopCorePipEngine(): void {
    corePipNativeAttached = false;
    videoPip!.loop = false;
    _corePipSession++;
    if (_corePipAutoCancel) _corePipAutoCancel();
    _corePipAutoCancel = null;
    videoPip!.pause();
    if (hlsPipInstance) {
        hlsPipInstance.destroy();
        hlsPipInstance = null;
    }
    videoPip!.removeAttribute("src");
    try {
        if (typeof videoPip!.load === "function") videoPip!.load();
    } catch (_) {
        console.warn("[Stop] Could not reset the PiP media resource.");
    }
    $("#videopip").hide();
    $("#pip_buffering").hide();
}
/**
 * Reposition and resize the PiP overlay based on the current pipSize and pipPosition
 * settings. All coordinates are computed relative to a 1280×720 design canvas.
 *
 * Positions: 0 = top-right, 1 = bottom-right, 2 = bottom-left, 3 = top-left.
 *
 * Side effects: Positions #videopip and its compact, centered buffering indicator.
 */
export function setPipPosition(): void {
    if (coreDeviceEffects.pipBounds) coreDeviceEffects.pipBounds();
    // Legacy setPipPosBuf reads sPipSize / sPipPos globals — keep in sync.
    var win = window as any;
    function num(v: any, fallback: number): number {
        var n = typeof v === "number" ? v : parseInt(v, 10);
        return isNaN(n) ? fallback : n;
    }
    if (win.sPipSize !== undefined) pipSize = num(win.sPipSize, pipSize);
    if (win.sPipPos !== undefined) pipPosition = num(win.sPipPos, pipPosition);
    pipSize = Math.max(0, Math.min(pipPresets.length - 1, pipSize | 0));
    pipPosition = (((pipPosition | 0) % 4) + 4) % 4;

    var m = Math.min(window.innerWidth / 1280, window.innerHeight / 720);
    // Legacy: set all four sides (auto clears the opposite corner).
    var css: any = {
        bottom: pipPosition == 1 || pipPosition == 2 ? 20 * m + "px" : "auto",
        height: pipPresets[pipSize].y * m + "px",
        left: pipPosition > 1 ? 20 * m + "px" : "auto",
        right: pipPosition < 2 ? 20 * m + "px" : "auto",
        top: pipPosition == 0 || pipPosition == 3 ? 20 * m + "px" : "auto",
        width: pipPresets[pipSize].x * m + "px",
    };
    $("#videopip").css(css);
    // The indicator's percentage-sized blobs must use a compact square, not
    // the full video rectangle. Keep both opposite edges cleared on every move.
    var bufferX = (20 + (pipPresets[pipSize].x - 30) / 2) * m + "px";
    var bufferY = (20 + (pipPresets[pipSize].y - 30) / 2) * m + "px";
    $("#pip_buffering").css({
        bottom: pipPosition == 1 || pipPosition == 2 ? bufferY : "auto",
        height: 30 * m + "px",
        left: pipPosition > 1 ? bufferX : "auto",
        right: pipPosition < 2 ? bufferX : "auto",
        top: pipPosition == 0 || pipPosition == 3 ? bufferY : "auto",
        width: 30 * m + "px",
    });
}

/**
 * Configure the video preload behaviour based on the stored buffer size setting.
 * If a positive buffer size is found, sets `preload = "auto"`.
 *
 * Side effects: Sets video!.preload attribute (may trigger early buffering).
 */
export function stbSetBuffer(): void {
    try {
        var b = Number.parseInt(
            (bufSize as any) || window.stbGetItem("sBufSize"),
            10
        );
        if (!isNaN(b) && b > 0 && video) {
            video!.preload = "auto";
        }
    } catch (e) {
        console.error("[stb] stbSetBuffer error:", e);
    }
}

/**
 * Inject custom CSS stored in STB settings (key `stb_custom_css`) into the document head.
 *
 * Side effects: Creates and appends a <style> element to document.head if CSS exists.
 */
export function stbCSS(): void {
    if (typeof window.stbGetItem !== "function") return;
    var css = window.stbGetItem("stb_custom_css");
    if (css) {
        var s = document.createElement("style");
        s.textContent = css;
        document.head.appendChild(s);
    }
}

/**
 * webOS always selects the engine per stream. Elsewhere, preserve explicit
 * provider preferences; choose Auto in Tauri/the Android test host, or hls.js
 * when native HLS is absent.
 *
 * Side effects: May update `playerMode`; never changes the stored preference.
 */
export function setPlayer(): void {
    if (
        typeof window !== "undefined" &&
        (window as any).ott_device === "lg/webos"
    ) {
        setPlayerMode(3);
        return;
    }
    if (!providerHasItemValue("sPlayers") && getDefaultPlayerMode() === 3) {
        playerMode = 3;
        return;
    }
    if (
        video &&
        !providerHasItemValue("sPlayers") &&
        !video!.canPlayType("application/vnd.apple.mpegurl") &&
        typeof Hls !== "undefined" &&
        Hls.isSupported()
    ) {
        playerMode = 1;
    }
}

/**
 * Close the current browser window/tab (standard STB exit behaviour).
 */
export function stbExit(): void {
    if ((window as any).__ottRemoteInputActive) return;
    setCoreDemoMute(false);
    window.close();
}

/** Keep remote input working when an embedding host replaces window.onkeydown. */
export function stbBindKeyHandler(): void {
    var w = window as any;
    if (typeof w.__ottKeydownListener !== "function") {
        w.__ottKeydownListener = function (event: KeyboardEvent): void {
            if (typeof w.keyHandler === "function") w.keyHandler(event);
        };
    }
    // Initialization historically replaced the property handler. Clear it so
    // an earlier property binding cannot deliver the same key a second time.
    w.onkeydown = null;
    if (typeof w.addEventListener === "function") {
        // Reusing this callback makes repeated initialization idempotent.
        w.addEventListener("keydown", w.__ottKeydownListener, false);
    } else {
        w.onkeydown = w.__ottKeydownListener;
    }
}

var _viewportSizeTimer: ReturnType<typeof setTimeout> | null = null;
var _viewportSizeElement: HTMLElement | null = null;

/** Briefly show the live viewport dimensions while the player window is resized. */
function showViewportSizeIndicator(): void {
    try {
        var el = _viewportSizeElement;
        if (!el || !el.parentNode) {
            el = document.getElementById(
                "ott_viewport_size"
            ) as HTMLElement | null;
            if (!el) {
                el = document.createElement("div");
                el.id = "ott_viewport_size";
                el.setAttribute("aria-hidden", "true");
                el.style.cssText =
                    "position:fixed;top:10px;right:10px;z-index:2147483000;" +
                    "padding:6px 9px;border:1px solid rgba(255,255,255,0.18);" +
                    "border-radius:5px;background:rgba(72,72,72,0.41);color:#fff;" +
                    "box-shadow:0 2px 8px rgba(0,0,0,0.3);font:600 13px/1.2 monospace;" +
                    "letter-spacing:0.2px;white-space:nowrap;pointer-events:none;" +
                    "user-select:none;-webkit-user-select:none;";
                (document.body || document.documentElement).appendChild(el);
            }
            _viewportSizeElement = el;
        }
        el.textContent =
            Math.round(window.innerWidth || 0) +
            " × " +
            Math.round(window.innerHeight || 0) +
            " px";
        el.style.display = "block";
        if (_viewportSizeTimer) clearTimeout(_viewportSizeTimer);
        _viewportSizeTimer = setTimeout(function () {
            if (_viewportSizeElement)
                _viewportSizeElement.style.display = "none";
            _viewportSizeTimer = null;
        }, 900);
    } catch (_e) {}
}

/**
 * Initialise the STB player: inject video DOM elements, attach event handlers,
 * go fullscreen, and set the global key handler.
 *
 * This is the bootstrap entry point for the player UI, also used after standby.
 * Reuse listeners on existing nodes and replace the owned information timer.
 *
 * Side effects:
 * - Creates #vdiv, #video, and #videopip elements in the DOM if they do not exist.
 * - Sets up event listeners on the main video element (waiting, loadstart, canplay, error, etc.).
 * - Shows/hides #buffering and #video_res on playback events.
 * - Starts a 1-second interval to calculate and display decoded bitrate.
 * - Calls stbToFullScreen().
 * - Installs the remote key listener through stbBindKeyHandler().
 */
export function stbInit(): void {
    var host = window as any;
    $("body").css({ "background-color": "#111" });
    if (!host.__ottCoreResizeListener)
        host.__ottCoreResizeListener = function () {
            showViewportSizeIndicator();
            if (typeof window.setFontSize === "function") window.setFontSize();
            if (typeof window.setListPos === "function") window.setListPos();
            if (typeof window.setColor === "function") window.setColor();
            // Re-apply video fit/center after layout — sync path alone left explicit
            // px sizes from 1.1.29 stuck at the pre-resize crop.
            var refreshVideo = function () {
                if (isFullscreen) stbToFullScreen();
                else {
                    applyAspectRatio();
                    applyZoom();
                }
            };
            refreshVideo();
            try {
                requestAnimationFrame(function () {
                    requestAnimationFrame(refreshVideo);
                });
            } catch (_raf) {
                refreshVideo();
            }
        };
    window.addEventListener("resize", host.__ottCoreResizeListener);
    try {
        if (!document.getElementById("vdiv")) {
            $("body").prepend(
                '<div id="vdiv" style="position: absolute; overflow: hidden; background-color: black; display: flex; align-items: center; justify-content: center;"><video id="video" playsinline style="object-fit: contain; object-position: center center; max-width: 100%; max-height: 100%;"></video></div><video id="videopip" playsinline muted style="position: absolute; display: none; background-color: black; object-fit: cover; object-position: center center;"></video>'
            );
        }
        video = document.getElementById("video") as HTMLVideoElement;
        // Suppress Android WebView's default play icon, including the PiP surface.
        $("video").attr(
            "poster",
            "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAkQBADs="
        );
        if (!(video as any).__ottCoreEventsBound) {
            try {
                // Intrinsic size arrives async; re-center contain letterbox once known.
                video!.addEventListener("loadedmetadata", function () {
                    applyAspectRatio();
                    applyZoom();
                });
            } catch (_meta) {}
            try {
                // Keep focus off native <video> so L/Escape reach the document
                // key path in full-video mode (list overlay already did).
                video!.setAttribute("tabindex", "-1");
                var _blurVid = function () {
                    try {
                        video!.blur();
                    } catch (_b) {}
                };
                video!.addEventListener("playing", _blurVid);
                video!.addEventListener("click", _blurVid);
            } catch (_tab) {}
            video!.addEventListener("waiting", function () {
                $("#buffering").show();
                $("#video_res").text(_("Connecting..."));
            });
            video!.addEventListener("loadstart", function () {
                $("#buffering").show();
                $("#video_res").text(_("Loading..."));
            });
            video!.addEventListener("loadeddata", function () {
                console.log("Event: loadeddata");
            });
            video!.addEventListener("loadedmetadata", function () {
                console.log("Event: loadedmetadata");
            });
            video!.addEventListener("canplay", function () {
                $("#buffering").hide();
                $("#video_res").text("");
                updateCoreVideoInfo();
                if (typeof applyChannelPreference === "function") {
                    applyChannelPreference("aAspects", setAspect);
                    applyChannelPreference("aZooms", setZoom);
                    applyChannelPreference("aSubs", setSubtitleTrack);
                    applyChannelPreference("aAudios", setAudioTrack);
                }
            });
            video!.addEventListener("playing", function () {
                $("#buffering").hide();
            });
            video!.addEventListener("error", function () {
                var _p =
                    coreDeviceEffects.engineName ||
                    (_corePlaybackMode === 1
                        ? "hls.js"
                        : _corePlaybackMode === 2
                          ? "shaka"
                          : "html5");
                var err = video?.error;
                var me = [
                    "",
                    "ABORTED",
                    "NETWORK",
                    "DECODE",
                    "SRC_NOT_SUPPORTED",
                ];
                var errName = err?.code ? me[err.code] || String(err.code) : "";
                console.log(
                    "video > error: " +
                        (err?.code || "") +
                        (errName ? "-" + errName : "") +
                        (err?.message ? " (" + err.message + ")" : "") +
                        " player=" +
                        _p
                );
                $("#buffering").hide();
                $("#video_res").html(
                    "<br/>error " +
                        (err?.code ?? 0) +
                        (errName ? " " + errName : "") +
                        " (" +
                        _p +
                        ")"
                );
            });
            video!.addEventListener("resize", function () {
                updateCoreVideoInfo();
            });
            // Seeks may finish between footer ticks; discard any sample spanning one.
            video!.addEventListener("seeking", resetCoreNativeBitrate);
            video!.addEventListener("seeked", resetCoreNativeBitrate);
            [
                "waiting",
                "loadstart",
                "loadeddata",
                "loadedmetadata",
                "durationchange",
                "canplay",
                "canplaythrough",
                "playing",
                "error",
                "progress",
                "ratechange",
                "ended",
                "suspend",
                "emptied",
                "stalled",
                "abort",
                "play",
                "pause",
                "resize",
            ].forEach(function (e) {
                video!.addEventListener(e, videoEvent);
            });
            (video as any).__ottCoreEventsBound = true;
        }
        var previousTimer = host.__ottCoreVideoInfoTimer;
        if (previousTimer) clearInterval(previousTimer.id);
        var infoTimer: any = (host.__ottCoreVideoInfoTimer = { id: null });
        var startInfoTimer = function (): void {
            if (host.__ottCoreVideoInfoTimer !== infoTimer || stbIsStandby())
                return;
            infoTimer.id = setInterval(function () {
                if (
                    host.__ottCoreVideoInfoTimer !== infoTimer ||
                    stbIsStandby()
                )
                    return;
                updateCoreVideoInfo();
            }, 1000);
        };
        if (host.__ottStandby && typeof host.__ottStandby.ready === "function")
            host.__ottStandby.ready(startInfoTimer);
        else startInfoTimer();
        videoPip = document.getElementById("videopip") as HTMLVideoElement;
        if (!(videoPip as any).__ottCoreEventsBound) {
            videoPip!.addEventListener("loadstart", function () {
                if (videoPip!.style.display != "none")
                    $("#pip_buffering").show();
            });
            videoPip!.addEventListener("playing", function () {
                $("#pip_buffering").hide();
            });
            (videoPip as any).__ottCoreEventsBound = true;
        }
    } catch (e) {
        console.error(e);
    }
    stbToFullScreen();
    stbBindKeyHandler();
    try {
        installTauriFsKeyCapture();
    } catch (_fsKey) {}
}

/**
 * Log all video events to the console for debugging.
 * On 'error' events, also logs the MediaError code and message.
 *
 * @param event - Raw video DOM event.
 *
 * Side effects: Console output.
 */
function videoEvent(event: Event): void {
    if (event && event.type) {
        console.log("[video] event: " + event.type);
        if (event.type === "error") {
            var me = video ? video!.error : null;
            if (me)
                console.error(
                    "[video] MediaError: code=" + me.code + " msg=" + me.message
                );
        }
        if (
            window.__ottDebug &&
            window.__ottDebug.enabled &&
            typeof window.__ottDebug.onVideoEvent === "function"
        ) {
            window.__ottDebug.onVideoEvent(event);
        }
    }
}

/**
 * Switch to a specific audio track.
 * For hls.js, sets hlsInstance.audioTrack directly.
 * For native HTML5, iterates video!.audioTracks and enables only the target index.
 *
 * @param index - Zero-based audio track index.
 *
 * Side effects: Mutates hlsInstance.audioTrack or video!.audioTracks[i].enabled.
 */
function setAudioTrack(index: number): void {
    if (hlsInstance) {
        if (hlsInstance.audioTrack !== index) hlsInstance.audioTrack = index;
        return;
    }
    var tracks = (video && (video as any).audioTracks) || [];
    for (var i = 0; i < tracks.length; i++) tracks[i].enabled = i === index;
}

/**
 * Open a selection box listing all available audio tracks.
 * On selection, switches to the chosen track and persists the choice via saveChannelPreference.
 *
 * Side effects: Shows a select-box UI; calls setAudioTrack; writes to aAudios storage.
 */
export function stbToggleAudioTrack(): void {
    chooseCoreTrack("audio");
}

function chooseCoreTrack(kind: string): void {
    var owner = getCoreMediaBackend().current();
    var tracks = owner ? owner.tracks(kind) : [];
    var labels: string[] =
        kind === "subtitle" ? [_(tracks.length ? "Off" : "Not found")] : [];
    var ids: number[] = kind === "subtitle" ? [0] : [];
    var current = 0;
    tracks.forEach(function (track: any, index: number) {
        if (track.selected) current = labels.length;
        ids.push(track.id);
        labels.push(
            index +
                1 +
                "/" +
                tracks.length +
                " (" +
                track.name +
                "/" +
                track.language +
                ")"
        );
    });
    if (!tracks.length) {
        showSelectBox(0, [_("Not found")], function () {}, 1500);
        return;
    }
    showSelectBox(
        current,
        labels,
        function (choice: number) {
            if (!owner.active() || ids[choice] === undefined) return;
            // Track-list events must not override an explicit choice in this session,
            // including media playback where no per-channel preference is stored.
            if (!(owner as any).__ottExplicitTracks)
                (owner as any).__ottExplicitTracks = {};
            (owner as any).__ottExplicitTracks[kind] = true;
            if (choice !== current) owner.selectTrack(kind, ids[choice]);
            saveChannelPreference(
                kind === "audio" ? "aAudios" : "aSubs",
                ids[choice]
            );
        },
        -1
    );
}

/**
 * Switch to a specific subtitle track.
 * For hls.js, sets hlsInstance.subtitleTrack (subtract 1 because index 0 = "Off").
 * For native HTML5, sets textTracks[i].mode to "showing" or "disabled".
 *
 * @param index - 1-based subtitle track index (0 = "Off" / disabled).
 *
 * Side effects: Mutates hlsInstance.subtitleTrack or video!.textTracks[i].mode.
 */
function setSubtitleTrack(index: number): void {
    if (hlsInstance) {
        hlsInstance.subtitleTrack = index - 1;
        return;
    }
    var tracks = (video && video.textTracks) || [];
    for (var i = 0; i < tracks.length; i++)
        (tracks[i] as any).mode = i === index - 1 ? "showing" : "disabled";
}

/**
 * Open a selection box listing all available subtitle tracks (including "Off").
 * On selection, switches to the chosen track and persists via saveChannelPreference.
 *
 * Side effects: Shows a select-box UI; calls setSubtitleTrack; writes to aSubs storage.
 */
export function stbToggleSubtitle(): void {
    chooseCoreTrack("subtitle");
}

/**
 * Apply the current zoomLevel to #video (CSS transform scale) and body.stb-zoom.
 * Overflow crop is on #vdiv (see styles/player.css). HS5-safe: also sets -webkit-transform.
 */
export function applyZoom(): void {
    var scale = zoomScales[zoomLevel] || 1;
    var el = document.getElementById("video") as HTMLElement | null;
    if (el) {
        var t = scale === 1 ? "" : "scale(" + scale + ")";
        el.style.transform = t;
        (el.style as any).webkitTransform = t;
        el.style.transformOrigin = "center center";
        (el.style as any).webkitTransformOrigin = "center center";
    }
    if (scale > 1) document.body.classList.add("stb-zoom");
    else document.body.classList.remove("stb-zoom");
}

/** Set zoom index and apply immediately. */
export function setZoom(v: number): void {
    zoomLevel = v;
    applyZoom();
}

/**
 * Open a selection box for digital zoom (100–175%). Persists via saveChannelPreference(aZooms).
 * Replaces the old body.stb-zoom toggle that had no CSS and looked like a no-op.
 */
export function stbToggleZoom(): void {
    showSelectBox(zoomLevel, zoomLabels, function (v: number) {
        setZoom(v);
        saveChannelPreference("aZooms", v);
    });
}

/** Internal standby state flag. */
var _standby = false;

/** Report shared standby state without toggling playback or native wake locks. */
export function stbIsStandby(): boolean {
    return (window as any).__ottStandby
        ? (window as any).__ottStandby.isStandby()
        : _standby;
}

/**
 * Set standby mode (black screen + stopped playback).
 *
 * When entering standby: stops video, closes all lists, sets background to black,
 * and shows a "STANDBY" message in #launch.
 * Repeated standby is idempotent; new playback remains blocked until wake.
 * When exiting standby: restores background and calls startPlayer once.
 *
 * Side effects: DOM mutations, video stop, global key handler may be affected.
 */
export function stbSetStandby(standby: boolean): void {
    if (!standby && !stbIsStandby()) return;
    var w = window as any;
    function attempt(effect: () => void): void {
        try {
            effect();
        } catch (_) {
            if (w.__ottStandby) w.__ottStandby.failed();
            console.warn("[Standby] A cleanup step failed.");
        }
    }
    if (w.__ottStandby && !standby) {
        w.__ottStandby.set(false, function () {
            _standby = false;
            attempt(function () {
                if (coreDeviceEffects.standby) coreDeviceEffects.standby(false);
            });
            document.body.style.backgroundColor = "";
            if (typeof w.startPlayer === "function") w.startPlayer();
            if (typeof w.setSleepTimeout === "function") w.setSleepTimeout();
        });
        return;
    }
    _standby = standby;
    if (w.__ottStandby) w.__ottStandby.set(standby);
    attempt(function () {
        if (coreDeviceEffects.standby) coreDeviceEffects.standby(_standby);
    });
    if (_standby) {
        var infoTimer = w.__ottCoreVideoInfoTimer;
        w.__ottCoreVideoInfoTimer = null;
        if (infoTimer) clearInterval(infoTimer.id);
        // Closing a browsing overlay must not restore its preview or PiP stream.
        clearTimeout(w.previewTimer);
        w.previewChan = null;
        w.pipIndex = null;
        attempt(function () {
            if (typeof w.closeList === "function") w.closeList(false);
        });
        attempt(function () {
            var queue = w.__ottPlexQueue;
            if (queue && typeof queue.stop === "function") queue.stop();
        });
        attempt(function () {
            if (typeof stbStop === "function") stbStop();
        });
        attempt(function () {
            if (typeof stbStopPip === "function") stbStopPip();
        });
        document.body.style.backgroundColor = "#000";
        var launchEl = document.getElementById("launch");
        if (launchEl) {
            launchEl.style.display = "block";
            launchEl.innerHTML =
                '<div style="text-align:center;padding-top:40%;color:#666;font-size:200%;">' +
                (window.standbyText || "STANDBY") +
                "</div>";
        }
    } else {
        document.body.style.backgroundColor = "";
        if (typeof window.startPlayer === "function") window.startPlayer();
    }
    if (typeof window.setSleepTimeout === "function") window.setSleepTimeout();
}

/** Toggle standby; remote Stop can reassert teardown without waking. */
export function stbToggleStandby(): void {
    stbSetStandby(!stbIsStandby());
}

/** Convenience wrapper for stbToggleStandby. */
export function toggleStandby(): void {
    stbToggleStandby();
}

/** Safely invoke stbToggleAspectRatio if it exists. */
export function toggleAspectRatio(): void {
    if (typeof stbToggleAspectRatio === "function") stbToggleAspectRatio();
}

/** Safely invoke stbToggleZoom if it exists. */
export function toggleZoom(): void {
    if (typeof stbToggleZoom === "function") stbToggleZoom();
}

/** Safely invoke stbToggleAudioTrack if it exists. */
export function toggleAudioTrack(): void {
    if (typeof stbToggleAudioTrack === "function") stbToggleAudioTrack();
}

/** Safely invoke stbToggleSubtitle if it exists. */
export function toggleSubtitle(): void {
    if (typeof stbToggleSubtitle === "function") stbToggleSubtitle();
}

/**
 * Back up portable STB preferences locally, excluding credentials, consent and nested backups.
 *
 * Side effects: Writes to localStorage; calls showShift on success.
 */
export function saveAllOptions(): void {
    try {
        var items = portableSettingsSnapshot(window.stbGetAllItems());
        localStorage.setItem("stb_settings_backup", JSON.stringify(items));
        window.showShift(_("Settings saved to storage"));
    } catch (e) {}
}

/**
 * Restore ordinary preferences from a local backup (created by saveAllOptions).
 * Preserves local credentials and disconnects outbound command delivery.
 *
 * Side effects: Reads from localStorage; calls stbClearAllItems and stbSetItem for each key.
 */
export function loadAllOptions(): void {
    try {
        var d = localStorage.getItem("stb_settings_backup");
        if (!d) {
            window.showShift(_("No saved settings found"));
            return;
        }
        restoreLocalSettingsSnapshot(JSON.parse(d));
        window.showShift(_("Settings loaded from storage"));
    } catch (e) {}
}

/**
 * Scale the entire body element to fit within the viewport while maintaining
 * the design canvas aspect ratio (1280×720 by default).
 *
 * Side effects: Sets CSS `transform: scale(...)` on <body>.
 */
export function setTransform(): void {
    var wi = window.wi || 1280;
    var hi = window.hi || 720;
    $("body").css(
        "transform",
        "scale(" +
            Math.min(window.innerWidth / wi, window.innerHeight / hi) +
            ")"
    );
}

/** Cleanup handler: stop playback on page unload. */
export function unload(): void {
    stbStop();
}

/**
 * Auto-start the player if the `stb_autorun` setting is "1".
 * Called on page load to check whether to begin playback immediately.
 *
 * Side effects: Calls startPlayer() if autorun is enabled.
 */
export function setAutorun(): void {
    var autorun = window.stbGetItem ? window.stbGetItem("stb_autorun") : null;
    if (autorun === "1" && typeof window.startPlayer === "function") {
        window.startPlayer();
    }
}

/** On DOM ready, set a pointer cursor on the body (touch/STB UI convention). */
if (typeof document !== "undefined" && document.body) {
    document.body.style.cursor = "pointer";
}

/** Modern browser engines are ports; the backend owns the request and observations. */
var coreMediaBackend: any = null;
var coreDeviceEffects: any = {};
export function getCoreMediaBackend(): any {
    if (coreMediaBackend) return coreMediaBackend;
    coreMediaBackend = (window as any).__ottMediaBackend.create({
        admitted: function () {
            return !stbIsStandby();
        },
        clearInterval: function (timer: any) {
            clearInterval(timer);
        },
        context: function () {
            var playback = (window as any).__ottClassicPlayback;
            if (!playback) return null;
            var state = playback.snapshot();
            var owner = playback.context();
            return state.target
                ? {
                      active: owner.isCurrentBackend,
                      generation: state.generation,
                      kind: state.target.kind,
                      position: state.position,
                      sourceActive: owner.isCurrentSource,
                  }
                : null;
        },
        emit: function (
            context: any,
            type: string,
            position: number,
            duration: number
        ) {
            var playback = (window as any).__ottClassicPlayback;
            if (playback) {
                playback.command({
                    duration: duration,
                    generation: context.generation,
                    position: position,
                    type: type === "ended" ? "stop" : type,
                });
                var media = (window as any).__ottMedia;
                if (type === "ended" && context.kind === "vod" && media)
                    media.ended(context.generation + 1);
            }
        },
        open: openCoreEngineLease,
        resolve: function (url: string, done: (url: string | null) => void) {
            var driver = (window as any).__ottActiveProviderDriver;
            if (url.indexOf("ottplay-stalker:") === 0) {
                if (driver && driver.resolveStream)
                    return driver.resolveStream(url, done);
                done(null);
            } else done(url);
            return function () {};
        },
        setInterval: function (callback: () => void, delay: number) {
            return setInterval(callback, delay);
        },
    });
    return coreMediaBackend;
}
function openCoreEngineLease(
    request: any,
    event: (type: string) => void,
    cssOnly = false
): MediaEngineLease {
    var pip = request.lane === "pip";
    if (!pip && typeof applyChannelPreference === "function") {
        applyChannelPreference("aAspects", setAspect);
        applyChannelPreference("aZooms", setZoom);
    }
    if (pip && coreDeviceEffects.pip && !cssOnly) {
        stopCorePipEngine();
        return coreDeviceEffects.pip.open(
            request,
            function (playbackUrl: string) {
                // Keep request identity on the original source while the fallback
                // decoder uses the same authenticated transport as native PiP.
                var fallbackRequest =
                    playbackUrl === request.url
                        ? request
                        : Object.assign({}, request, { url: playbackUrl });
                return openCoreEngineLease(fallbackRequest, event, true);
            }
        );
    }
    var media = pip ? videoPip : video;
    // Optional device engines retain the same request ownership and UI commands.
    if (coreDeviceEffects.engine) {
        if (!pip) {
            setCoreDemoMute((window as any).ottplayDemoActive === true);
            resetCoreNativeBitrate();
            var policy = (window as any).__ottStreamPolicy;
            if (policy) {
                policy.reset();
                policy.begin("native", false);
            }
        }
        var optionalEngine = coreDeviceEffects.engine(request, event, media);
        var disposeEngine = optionalEngine.dispose;
        optionalEngine.dispose = function (replaced?: boolean) {
            disposeEngine(replaced);
            if (!pip) setCoreDemoMute(false);
        };
        return optionalEngine;
    }
    var listeners: Array<{ name: string; callback: () => void }> = [];
    var trackListeners: Array<{ target: any; callback: () => void }> = [];
    var session = pip ? _corePipSession + 1 : _playSession + 1;
    function active() {
        return (
            session === (pip ? _corePipSession : _playSession) &&
            media === (pip ? videoPip : video)
        );
    }
    function observe() {
        if (media && typeof media.addEventListener === "function")
            [
                "playing",
                "pause",
                "timeupdate",
                "ended",
                "error",
                "loadedmetadata",
            ].forEach(function (name) {
                var callback = function () {
                    if (active()) event(name);
                    if (!pip && name === "playing" && active()) {
                        var policy = (window as any).__ottStreamPolicy;
                        if (policy) policy.report({ state: "playing" });
                    }
                    if (!pip && name === "error" && active()) {
                        setTimeout(function () {
                            if (
                                active() &&
                                _corePlaybackMode === 0 &&
                                !(
                                    _coreAutoCancel && _coreAutoCancel.pending()
                                ) &&
                                media &&
                                media.error
                            )
                                coreStreamFailure(
                                    media.error.code === 2
                                        ? "network"
                                        : "decode"
                                );
                        }, 0);
                    }
                };
                listeners.push({ callback: callback, name: name });
                media!.addEventListener(name, callback);
            });
    }
    if (!pip && media) {
        ["audio", "subtitle"].forEach(function (kind) {
            var list =
                kind === "audio"
                    ? (media as any).audioTracks
                    : media!.textTracks;
            if (
                !list ||
                typeof list.addEventListener !== "function" ||
                typeof list.removeEventListener !== "function"
            )
                return;
            var callback = function () {
                if (!active()) return;
                applyChannelPreference(
                    kind === "audio" ? "aAudios" : "aSubs",
                    kind === "audio" ? setAudioTrack : setSubtitleTrack
                );
            };
            list.addEventListener("addtrack", callback);
            trackListeners.push({ callback: callback, target: list });
        });
    }
    var lease: MediaEngineLease = {
        diagnosticAttempt: function () {
            return active() && !pip
                ? Object.assign({}, coreAttemptCounters)
                : null;
        },
        diagnosticEngine: function () {
            if (!active() || !media) return null;
            var hls = pip ? hlsPipInstance : hlsInstance;
            if (hls && hls.media === media) return "hls.js";
            var shaka = !pip && window.player;
            if (
                shaka &&
                shaka.getMediaElement &&
                shaka.getMediaElement() === media
            )
                return "shaka";
            return (pip ? corePipNativeAttached : coreNativeAttached)
                ? "html5"
                : null;
        },
        dispose: function () {
            listeners.forEach(function (listener) {
                if (media && typeof media.removeEventListener === "function")
                    media.removeEventListener(listener.name, listener.callback);
            });
            listeners = [];
            trackListeners.forEach(function (listener) {
                listener.target.removeEventListener(
                    "addtrack",
                    listener.callback
                );
            });
            trackListeners = [];
            if (!active()) return;
            if (pip) stopCorePipEngine();
            else stopCoreEngine();
        },
        pause: function () {
            if (!active() || !media) return;
            (window as any).forcePlay = false;
            if (!pip && coreStreamAttempt) coreStreamAttempt.pause();
            media.pause();
        },
        resume: function () {
            if (!active() || !media) return;
            (window as any).forcePlay = true;
            if (!pip && coreStreamAttempt && coreStreamAttempt.resume()) return;
            playCoreMedia(media);
        },
        sample: function () {
            return {
                duration: media ? media.duration : NaN,
                paused: !media || media.paused,
                position: media ? media.currentTime : 0,
                ready: media ? media.readyState : 0,
            };
        },
        seek: function (position: number) {
            if (active() && !pip) seekCoreMedia(position, session);
        },
        selectTrack: function (kind: string, index: number) {
            if (!active()) return;
            if (kind === "audio") setAudioTrack(index);
            else if (kind === "subtitle") setSubtitleTrack(index);
        },
        supportsPausedStart: !pip,
        tracks: function (kind: string) {
            if (!active() || !media) return [];
            var source =
                kind === "audio"
                    ? hlsInstance
                        ? hlsInstance.audioTracks
                        : (media as any).audioTracks
                    : hlsInstance
                      ? hlsInstance.subtitleTracks
                      : media.textTracks;
            var rows: any[] = [];
            for (var i = 0; source && i < source.length; i++) {
                var track = source[i];
                if (
                    kind === "subtitle" &&
                    !hlsInstance &&
                    !isUsableNativeSubtitleTrack(track)
                )
                    continue;
                rows.push({
                    id: kind === "audio" ? i : i + 1,
                    language:
                        track.language ||
                        track.lang ||
                        (kind === "audio" ? undefined : "?"),
                    name:
                        track.label ||
                        track.name ||
                        (kind === "audio" ? undefined : "#" + (i + 1)),
                    selected: hlsInstance
                        ? (kind === "audio"
                              ? hlsInstance.audioTrack
                              : hlsInstance.subtitleTrack) === i
                        : kind === "audio"
                          ? !!track.enabled
                          : track.mode === "showing",
                });
            }
            return rows;
        },
    };
    try {
        if (pip) {
            observe();
            startCorePipEngine(request.url);
        } else
            startCoreEngine(
                request.url,
                request.position,
                observe,
                request.paused === true,
                request.sourceUrl || request.url,
                request.transient === true
            );
    } catch (error) {
        lease.dispose();
        throw error;
    }
    return lease;
}

var coreAvTest: any = null;
var coreAvTestTimer: any = null;
function finishCoreAvTest(): void {
    if (coreAvTest) coreAvTest.finish();
}
function startCoreAvTest(): boolean {
    if (!video || coreDeviceEffects.engine || stbIsStandby()) return false;
    if (coreAvTest && coreAvTest.active()) return true;
    var media = video,
        muted = _coreDemoMute ? _coreDemoMute.muted : media.muted;
    var test = getCoreMediaBackend().preview(
        "https://mantra-basin-76mq.here.now/diagnostics/av-v1.mp4",
        function (reason: string) {
            if (reason === "error") showShift(_("Stream could not be played"));
            if (coreAvTestTimer !== null) clearTimeout(coreAvTestTimer);
            coreAvTestTimer = null;
            coreAvTest = null;
            if (video === media && !media.muted) media.muted = muted;
        }
    );
    if (!test) return false;
    if (test.active()) {
        coreAvTest = test;
        media.muted = false;
        // A failed/missing end event must not leave the diagnostic decoder forever.
        coreAvTestTimer = setTimeout(function () {
            test.finish();
        }, 15000);
    }
    return true;
}
(window as any).__ottAvTest = {
    start: startCoreAvTest,
    stop: finishCoreAvTest,
};

export function stbPlayPip(url: string): void {
    if (stbIsStandby()) return;
    if ((window as any).__ottKiosk && (window as any).__ottKiosk.enabled())
        return;
    getCoreMediaBackend().open({ lane: "pip", url: url });
}
export function stbStopPip(): void {
    getCoreMediaBackend().stop("pip");
}
if (typeof window !== "undefined") {
    (window as any).__ottCoreBackend = getCoreMediaBackend;
    // Observers must not create a backend or trigger transport reconciliation.
    (window as any).__ottCoreBackendPeek = function () {
        return coreMediaBackend;
    };
    (window as any).__ottCoreTransport = {
        configure: function (effects: any) {
            Object.keys(effects).forEach(function (key) {
                coreDeviceEffects[key] = effects[key];
            });
        },
        play: stbPlay,
    };
}
