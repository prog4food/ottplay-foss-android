/**
 * Watch a native HLS attempt without changing working video playback.
 * WKWebView can accept HEVC in MPEG-TS as audio-only without raising an error.
 * A single prefetched HLS fragment distinguishes that case from actual radio.
 * Tauri also recovers sustained native frame loss without fetching a probe.
 */
export function watchAutoNativePlayback(
    media: HTMLVideoElement,
    url: string,
    HlsRef: any,
    options: {
        active: () => boolean;
        fallback: () => void;
        monitorDroppedFrames?: boolean;
        restore: () => void;
    }
): ((restoreNative?: boolean) => void) & { pending: () => boolean } {
    var disposed = false;
    var decided = false;
    var probing = false;
    var probe: any = null;
    var checkTimer: ReturnType<typeof setTimeout> | null = null;
    var probeTimer: ReturnType<typeof setTimeout> | null = null;
    var actionTimer: ReturnType<typeof setTimeout> | null = null;
    var cancelFrameWatch: (() => void) | null = null;
    var events = [
        "playing",
        "timeupdate",
        "loadedmetadata",
        "loadeddata",
        "resize",
    ];

    function removeListeners(): void {
        for (var i = 0; i < events.length; i++)
            media.removeEventListener(events[i], inspect);
        media.removeEventListener("error", onNativeError);
    }

    function clearWaits(): void {
        if (checkTimer !== null) clearTimeout(checkTimer);
        if (probeTimer !== null) clearTimeout(probeTimer);
        checkTimer = null;
        probeTimer = null;
    }

    function stopProbe(): void {
        var previous = probe;
        probe = null;
        probing = false;
        if (previous) {
            try {
                previous.destroy();
            } catch (_destroyError) {}
        }
    }

    function cancel(restoreNative?: boolean): void {
        if (disposed) return;
        // Changing engine preference can cancel a probe without replacing the
        // current stream. Renew that native session even when a probe result
        // was already queued; stop/channel-switch cancellation never renews it.
        var renewNative = restoreNative === true && probing && options.active();
        disposed = true;
        if (cancelFrameWatch) cancelFrameWatch();
        cancelFrameWatch = null;
        removeListeners();
        clearWaits();
        if (actionTimer !== null) clearTimeout(actionTimer);
        actionTimer = null;
        stopProbe();
        if (renewNative) options.restore();
    }

    function current(): boolean {
        if (disposed) return false;
        if (options.active()) return true;
        // A stale HLS event can arrive before its caller disposes the watcher.
        // Its controller must finish emitting before we destroy that probe.
        if (actionTimer === null) {
            actionTimer = setTimeout(function () {
                actionTimer = null;
                cancel();
            }, 0);
        }
        return false;
    }

    function finish(useFallback: boolean): void {
        if (!current() || decided) return;
        decided = true;
        removeListeners();
        clearWaits();
        // The transmuxer still uses its controllers after emitting track data.
        // Destroying it or replacing playback inside that event is reentrant.
        actionTimer = setTimeout(function () {
            actionTimer = null;
            var stillCurrent = !disposed && options.active();
            // Native video may finish loading during the probe or just after
            // its track event. Keep that now-working engine; renewing src is
            // still necessary for proxies that replaced their session.
            if (
                useFallback &&
                probing &&
                !media.error &&
                ((media as any).videoTracks
                    ? (media as any).videoTracks.length > 0
                    : media.videoWidth > 0)
            )
                useFallback = false;
            if (stillCurrent && !useFallback && options.monitorDroppedFrames) {
                // A late video track only resolves the audio-only probe. It
                // does not prove that the native decoder displays its frames.
                stopProbe();
                if (cancelFrameWatch) cancelFrameWatch();
                cancelFrameWatch = null;
            } else cancel();
            if (!stillCurrent) return;
            if (useFallback) options.fallback();
            else {
                options.restore();
                if (current()) startFrameWatch();
            }
        }, 0);
    }

    function audioWithoutVideo(): boolean {
        var tracks = media as any;
        // WKWebView may report nonzero dimensions while it has decoded only
        // audio. An available videoTracks list is stronger
        // evidence than those dimensions; no track API means no speculation.
        return (
            !media.paused &&
            media.readyState >= 2 &&
            !!tracks.audioTracks &&
            tracks.audioTracks.length > 0 &&
            !!tracks.videoTracks &&
            tracks.videoTracks.length === 0
        );
    }

    function startProbe(): void {
        if (!current() || decided || probing || !audioWithoutVideo()) return;
        if (!HlsRef || !HlsRef.isSupported || !HlsRef.isSupported()) return;
        probing = true;
        // Local HLS proxies may replace their playback session on every master
        // request. Always renew native src on an unknown result, radio, error or
        // timeout; leaving its old src would break radio. Keep native playing
        // while probing so play/pause controls still represent the user's intent.
        try {
            probe = new HlsRef({
                backBufferLength: 0,
                enableWorker: true,
                lowLatencyMode: false,
                maxBufferLength: 1,
                maxMaxBufferLength: 1,
                startFragPrefetch: true,
                startLevel: 0,
                testBandwidth: false,
            });
            probe.on(
                HlsRef.Events.FRAG_PARSING_INIT_SEGMENT,
                function (_event: any, data: any): void {
                    if (!current() || decided || !data || data.id !== "main")
                        return;
                    var tracks = data.tracks || {};
                    var track = tracks.video || tracks.audiovideo;
                    var metadata = track && track.metadata;
                    var hasVideo = !!(
                        track &&
                        (/(?:hvc1|hev1)(?:\.|$)/i.test(track.codec || "") ||
                            (metadata &&
                                metadata.width > 0 &&
                                metadata.height > 0))
                    );
                    // Real audio-only channels keep the native engine. A
                    // missing/unknown video track is not evidence of HEVC.
                    finish(hasVideo);
                }
            );
            probe.on(HlsRef.Events.ERROR, function (): void {
                finish(false);
            });
            probeTimer = setTimeout(function () {
                probeTimer = null;
                finish(false);
            }, 8000);
            // startFragPrefetch transmuxes the first fragment without attaching
            // any media element or opening another audible/visible decoder.
            probe.loadSource(url);
        } catch (_probeError) {
            finish(false);
        }
    }

    function inspect(): void {
        if (!current() || decided || probing) return;
        if (!audioWithoutVideo()) {
            if (checkTimer !== null) clearTimeout(checkTimer);
            checkTimer = null;
            return;
        }
        if (checkTimer !== null) return;
        checkTimer = setTimeout(function () {
            checkTimer = null;
            startProbe();
        }, 1500);
    }

    function onNativeError(): void {
        if (!current() || decided || probing) return;
        var error = media.error;
        // Network errors and stalled playback do not prove codec mismatch.
        if (error && (error.code === 3 || error.code === 4)) finish(true);
    }

    function startFrameWatch(): void {
        if (options.monitorDroppedFrames)
            cancelFrameWatch = watchNativeFrameDrops(media, function (): void {
                if (!current() || probing || actionTimer !== null) return;
                decided = false;
                finish(true);
            });
    }

    for (var i = 0; i < events.length; i++)
        media.addEventListener(events[i], inspect);
    media.addEventListener("error", onNativeError);
    startFrameWatch();
    // PiP can load the HLS library after native playback has already emitted
    // metadata or failed. Inspect that state as well as subsequent events.
    onNativeError();
    inspect();
    var watcher = cancel as typeof cancel & { pending: () => boolean };
    watcher.pending = function (): boolean {
        return !disposed && (probing || actionTimer !== null);
    };
    return watcher;
}

/** Detect sustained decoder failure, never infer failure from a low frame rate. */
function watchNativeFrameDrops(
    media: HTMLVideoElement,
    failed: () => void
): () => void {
    var target = media as any;
    if (
        typeof target.getVideoPlaybackQuality !== "function" &&
        typeof target.webkitDecodedFrameCount !== "number"
    )
        return function (): void {};
    var doc = media.ownerDocument || document;
    var disposed = false;
    var timer: ReturnType<typeof setTimeout> | null = null;
    var baseline: {
        time: number;
        position: number;
        total: number;
        dropped: number;
    } | null = null;
    var warmup = true;
    var badWindows = 0;
    var resetEvents = ["pause", "seeking", "waiting", "emptied", "ratechange"];

    function reset(): void {
        baseline = null;
        warmup = true;
        badWindows = 0;
    }

    function cancel(): void {
        disposed = true;
        if (timer !== null) clearTimeout(timer);
        timer = null;
        for (var i = 0; i < resetEvents.length; i++)
            media.removeEventListener(resetEvents[i], reset);
        doc.removeEventListener("visibilitychange", reset);
    }

    function check(): void {
        if (disposed) return;
        timer = setTimeout(check, 1000);
        try {
            if (
                media.paused ||
                media.seeking ||
                media.ended ||
                media.error ||
                media.readyState < 3 ||
                media.playbackRate !== 1 ||
                !media.videoWidth ||
                !media.videoHeight ||
                (target.videoTracks && !target.videoTracks.length) ||
                doc.visibilityState !== "visible"
            ) {
                reset();
                return;
            }
            var position = media.currentTime;
            var buffered = media.buffered;
            var ahead = 0;
            for (var i = 0; i < buffered.length; i++)
                if (
                    buffered.start(i) <= position &&
                    buffered.end(i) >= position
                )
                    ahead = buffered.end(i) - position;
            if (ahead < 2) {
                reset();
                return;
            }
            var quality =
                typeof target.getVideoPlaybackQuality === "function"
                    ? target.getVideoPlaybackQuality()
                    : null;
            var total = quality
                ? quality.totalVideoFrames
                : target.webkitDecodedFrameCount;
            var dropped = quality
                ? quality.droppedVideoFrames
                : target.webkitDroppedFrameCount;
            if (
                typeof total !== "number" ||
                typeof dropped !== "number" ||
                !isFinite(total) ||
                !isFinite(dropped) ||
                dropped < 0 ||
                total < dropped
            ) {
                reset();
                return;
            }
            var sample = {
                dropped: dropped,
                position: position,
                time: Date.now(),
                total: total,
            };
            if (!baseline) {
                baseline = sample;
                return;
            }
            var elapsed = (sample.time - baseline.time) / 1000;
            var played = position - baseline.position;
            var decoded = total - baseline.total;
            var lost = dropped - baseline.dropped;
            // A throttled timer, seek or reset counter starts a fresh warmup.
            if (
                elapsed <= 0 ||
                elapsed > 6 ||
                decoded < 0 ||
                lost < 0 ||
                lost > decoded ||
                played < elapsed * 0.75 ||
                played > elapsed * 1.25
            ) {
                reset();
                return;
            }
            // Ignore the first four seconds of uninterrupted playback, then
            // evaluate complete four-second windows rather than timer ticks.
            if (elapsed < 4) return;
            baseline = sample;
            if (warmup) {
                warmup = false;
                return;
            }
            // Two four-second windows must contain video-rate input, >=80%
            // lost frames and <=3 displayed fps. Real 1fps video is healthy.
            badWindows =
                decoded >= played * 10 &&
                lost >= decoded * 0.8 &&
                decoded - lost <= played * 3
                    ? badWindows + 1
                    : 0;
            if (badWindows >= 2) {
                cancel();
                failed();
            }
        } catch (_qualityError) {
            reset();
        }
    }

    for (var i = 0; i < resetEvents.length; i++)
        media.addEventListener(resetEvents[i], reset);
    doc.addEventListener("visibilitychange", reset);
    timer = setTimeout(check, 1000);
    return cancel;
}
