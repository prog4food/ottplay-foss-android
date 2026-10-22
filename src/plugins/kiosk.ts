import { caselessKey } from "../utils/caseless";
import { createKioskVideoProgress } from "./kiosk-video-progress";
import { createStrictKioskInput } from "./strict-kiosk-input";

/** Device-local policy. Only the authenticated command-server dispatcher mutates it. */
export function createKiosk(w: any): any {
    var key = "__ottKioskV1";
    var policy: any = null;
    var timer: any = null;
    var lastProgress = 0;
    var lastPosition: number | null = null;
    var retries = 0;
    var recoveryAttempts = 0;
    var health = "idle";
    var lastSaved = 0;
    var lastMediaId = "";
    var mediaStarting = false;
    var screenAwake = true;
    var sleepingHandle: any = null;
    var sleepingPolicy: any = null;
    var sleepingSource: string | null = null;
    var screenEnd: (() => void) | null = null;
    var deferredPolicy: any = null;
    var sleepBackend: any = null;
    var sleepUnsubscribe: any = null;
    var applyingScreenPause = false;
    var frameRecovery = false;
    var frameHealthySince: number | null = null;
    var folderRecovery: any = null;
    var videoProgress = createKioskVideoProgress(w);
    var strictInput = createStrictKioskInput(w, strict);
    function now(): number {
        return w.performance && typeof w.performance.now === "function"
            ? w.performance.now()
            : Date.now();
    }
    function source(): string {
        return w.__ottSourceIdentity.current(w);
    }
    function provider(): string {
        return String((w.__ottActiveProviderDriver || {}).id || w.p_pref || "");
    }
    function enabled(): boolean {
        return !!policy;
    }
    function locked(): boolean {
        return !!(policy && (policy.channel || policy.media));
    }
    function strict(): boolean {
        return locked() && policy.strict === true;
    }
    function mediaPlaylistChannel(): boolean {
        if (!policy || !policy.channel) return false;
        var driver = w.__ottActiveProviderDriver;
        // A restored policy may precede provider asset loading on a cold start.
        if (!driver)
            return policy.provider === "plex" || policy.provider === "vportal";
        return !!(
            driver.id === policy.provider &&
            driver.capabilities &&
            driver.capabilities.mediaPlaylist &&
            source() === policy.source
        );
    }
    function reset(): void {
        videoProgress.reset();
        frameRecovery = false;
        frameHealthySince = null;
        recoveryAttempts = 0;
        lastPosition = null;
        lastProgress = now();
        lastSaved = lastProgress;
        lastMediaId = "";
        mediaStarting = !!(policy && policy.media) || mediaPlaylistChannel();
        health = locked() ? "starting" : policy ? "waiting" : "idle";
        strictInput.sync();
    }
    function save(next: any): boolean {
        try {
            var value = JSON.stringify(next);
            w.stbSetItem(key, value);
            if (w.stbGetItem(key) !== value) return false;
        } catch (_) {
            return false;
        }
        policy = next;
        reset();
        if (typeof w.setSleepTimeout === "function") w.setSleepTimeout();
        return true;
    }
    function currentSource(): boolean {
        return (
            !!policy &&
            provider() === policy.provider &&
            (policy.media
                ? !!w.__ottMedia && w.__ottMedia.sourceId() === policy.source
                : source() === policy.source)
        );
    }
    function screenManaged(): boolean {
        return locked() || provider() === "offline";
    }
    function screenBlocked(): boolean {
        return !screenAwake && screenManaged();
    }
    function pauseForScreen(): void {
        if (!screenBlocked() || applyingScreenPause) return;
        applyingScreenPause = true;
        try {
            // The native initial sleep state may precede provider startup.
            if (sleepingSource === null && provider() === "offline")
                sleepingSource = source();
            var backend = w.__ottCoreBackendPeek && w.__ottCoreBackendPeek();
            if (backend !== sleepBackend) {
                if (sleepUnsubscribe) sleepUnsubscribe();
                sleepBackend = backend;
                sleepUnsubscribe =
                    backend && backend.subscribe
                        ? backend.subscribe(pauseForScreen)
                        : null;
            }
            var handle = backend && backend.current();
            if (
                handle &&
                handle.active() &&
                ["playing", "loading", "paused"].indexOf(
                    handle.snapshot().phase
                ) >= 0
            ) {
                if (handle.snapshot().phase !== "paused") {
                    sleepingHandle = handle;
                    sleepingPolicy = policy;
                }
                // Pausing the video element alone leaves HLS and native fetches
                // running. Suspend releases the transport without losing its cursor.
                if (typeof handle.suspend === "function") handle.suspend();
                else if (handle.snapshot().phase !== "paused") handle.pause();
            }
            health = "waiting";
        } finally {
            applyingScreenPause = false;
        }
    }
    function setScreenAwake(awake: boolean): void {
        if (screenAwake === awake) return;
        screenAwake = awake;
        if (!awake) {
            sleepingSource = provider() === "offline" ? source() : null;
            var currentBackend =
                w.__ottCoreBackendPeek && w.__ottCoreBackendPeek();
            var currentHandle = currentBackend && currentBackend.current();
            deferredPolicy =
                !currentHandle || currentHandle.snapshot().phase === "stopped"
                    ? policy
                    : null;
            // Checkpoint the current episode before pausing, even between polls.
            lastSaved = -Infinity;
            tick();
            return;
        }
        var handle = sleepingHandle;
        var selected = sleepingPolicy;
        var deferred = deferredPolicy;
        var selectedSource = sleepingSource;
        var end = screenEnd;
        screenEnd = null;
        sleepingSource = null;
        sleepingHandle = sleepingPolicy = deferredPolicy = null;
        reset();
        if (
            w.__ottStandby?.blocked() ||
            !(
                (locked() && currentSource()) ||
                (provider() === "offline" && source() === selectedSource)
            )
        )
            return;
        if (end) {
            end();
            return;
        }
        var backend = w.__ottCoreBackendPeek && w.__ottCoreBackendPeek();
        if (locked() && policy === deferred) {
            play();
        } else if (
            handle &&
            policy === selected &&
            backend &&
            backend.current() === handle &&
            handle.active() &&
            handle.snapshot().phase === "paused"
        ) {
            // Providers may issue expiring URLs before the backend resolver.
            // Resolve a live channel through its provider again after sleep.
            var state =
                w.__ottClassicPlayback && w.__ottClassicPlayback.snapshot();
            if (
                policy &&
                policy.channel &&
                state &&
                state.target &&
                state.target.kind === "live"
            )
                play();
            else handle.resume();
        }
    }
    function snapshot(): any {
        return {
            channel:
                policy && policy.channel
                    ? { id: policy.channel.id, name: policy.channel.name }
                    : null,
            ...(policy && policy.media
                ? {
                      media: {
                          index: policy.media.index,
                          title: policy.media.records[policy.media.index].title,
                          total: policy.media.records.length,
                      },
                  }
                : {}),
            ...((policy && policy.media) || mediaPlaylistChannel()
                ? { startup_grace_seconds: 60 }
                : {}),
            ...(folderLoop()
                ? {
                      folder: {
                          name: policy.folder.name,
                          total: Object.keys(w.channels || {}).filter(allowed)
                              .length,
                      },
                  }
                : {}),
            enabled: enabled(),
            health: health,
            provider: policy ? policy.provider : null,
            retries: retries,
            retry_seconds: 10,
            screen_suspended: screenBlocked(),
            state: locked() ? "locked" : policy ? "waiting" : "off",
            strict: !!(policy && policy.strict),
            video_progress: videoProgress.snapshot(),
        };
    }
    function folderLoop(): boolean {
        return !!(policy && policy.folder && policy.provider === "offline");
    }
    function allowed(id: any): boolean {
        if (!locked()) return true;
        if (folderLoop()) {
            var row = (w.channels || {})[String(id)];
            return !!(
                currentSource() &&
                row &&
                row.__ottLocalSource === policy.folder.id
            );
        }
        return (
            !!policy.channel &&
            source() === policy.source &&
            String(id) === policy.channel.id
        );
    }
    function folderNext(id: any, members: any[]): any {
        if (!folderLoop() || !currentSource()) return null;
        var index = members.map(String).indexOf(String(id));
        if (index < 0) return null;
        for (var step = 1; step <= members.length; step++) {
            var next = members[(index + step) % members.length];
            if (allowed(next)) return next;
        }
        return null;
    }
    function validMedia(value: any): boolean {
        try {
            return (
                !!value &&
                typeof value.source === "string" &&
                (value.queueId === undefined ||
                    (typeof value.queueId === "string" &&
                        value.queueId.length <= 100)) &&
                Array.isArray(value.records) &&
                value.records.length > 0 &&
                value.records.length <= 1000 &&
                typeof value.index === "number" &&
                Math.floor(value.index) === value.index &&
                value.index >= 0 &&
                value.index < value.records.length &&
                typeof value.position === "number" &&
                isFinite(value.position) &&
                value.position >= 0 &&
                JSON.stringify(value).length <= 500000 &&
                value.records.every(function (row: any) {
                    return (
                        row &&
                        typeof row.title === "string" &&
                        row.request &&
                        typeof row.request === "object" &&
                        !Array.isArray(row.request) &&
                        row.__ottMediaRef &&
                        row.__ottMediaRef.sourceId === value.source &&
                        typeof row.__ottMediaRef.itemId === "string" &&
                        !!row.__ottMediaRef.itemId &&
                        !row.stream_url
                    );
                })
            );
        } catch (_) {
            return false;
        }
    }
    function allowedMedia(ref: any): boolean {
        return (
            !locked() ||
            !!(
                policy.media &&
                ref &&
                w.__ottMedia &&
                w.__ottMedia.sourceId() === policy.source &&
                ref.sourceId === policy.source &&
                policy.media.records.some(function (row: any) {
                    return row.__ottMediaRef.itemId === ref.itemId;
                })
            )
        );
    }
    function admit(id: any): boolean {
        if (!allowed(id)) return false;
        if (folderLoop() && policy.channel.id !== String(id)) {
            if (
                !save({
                    ...policy,
                    channel: {
                        id: String(id),
                        name: String(w.channels[id].channel_name || ""),
                    },
                })
            )
                return false;
        }
        if (policy && !policy.channel && !policy.media) {
            // Arming does not capture the already playing channel or a boot callback.
            if (w.commandChannelsReady !== true || source() !== policy.source)
                return false;
            if (
                !save({
                    channel: {
                        id: String(id),
                        name: String(w.channels[id].channel_name || ""),
                    },
                    provider: policy.provider,
                    source: policy.source,
                    strict: policy.strict === true,
                })
            )
                return false;
            closeControls();
        }
        return true;
    }
    function locate(id: string): number[] | null {
        var categories = w.catsArray || [];
        for (var c = 0; c < categories.length; c++) {
            var list = (w.cats || {})[categories[c]] || [];
            for (var i = 0; i < list.length; i++)
                if (String(list[i]) === id) return [c, i];
        }
        return null;
    }
    function closeControls(): void {
        if (typeof w.closeList === "function") w.closeList();
        if (typeof w.stbStopPip === "function") w.stbStopPip();
        w.pipIndex = null;
        if (w.__ottMedia && w.__ottMedia.cancelRequest)
            w.__ottMedia.cancelRequest();
    }
    function play(): void {
        if (w.__ottStandby?.blocked()) return;
        if (!locked() || w.commandChannelsReady !== true) return;
        if (!screenAwake) {
            deferredPolicy = policy;
            pauseForScreen();
            return;
        }
        videoProgress.reset();
        frameHealthySince = null;
        if (policy.media) {
            var selected = policy;
            if (!w.__ottMedia || w.__ottMedia.sourceId() !== selected.source) {
                health = "source-unavailable";
                return;
            }
            mediaStarting = true;
            lastProgress = now();
            if (
                !w.__ottMedia.restoreKiosk(selected.media, function () {
                    return (
                        screenAwake &&
                        policy === selected &&
                        w.__ottMedia.sourceId() === selected.source
                    );
                })
            )
                health = "error";
            return;
        }
        if (source() !== policy.source) {
            health = "source-unavailable";
            return;
        }
        var indices = locate(policy.channel.id);
        if (!indices || !(w.channels || {})[policy.channel.id]) {
            health = "channel-unavailable";
            if (
                folderLoop() &&
                !folderRecovery &&
                w.__ottLocalMedia &&
                typeof w.__ottLocalMedia.snapshot === "function"
            ) {
                // Missing catalog membership alone is not deletion: direct
                // lookup must confirm it, otherwise wait for the final catalog.
                var selected = policy;
                folderRecovery = selected;
                Promise.resolve()
                    .then(function () {
                        var media = w.__ottLocalMedia;
                        if (
                            media.preferredState &&
                            media.preferredState(
                                String(selected.channel.id).replace(
                                    /^local-/,
                                    ""
                                )
                            ) === "missing"
                        )
                            return;
                        return media.snapshot();
                    })
                    .then(function () {
                        if (
                            policy !== selected ||
                            !currentSource() ||
                            !screenAwake ||
                            w.__ottStandby?.blocked() ||
                            w.commandChannelsReady !== true ||
                            (locate(selected.channel.id) &&
                                (w.channels || {})[selected.channel.id])
                        )
                            return;
                        var ids = w.cList || w.curList || [];
                        for (var i = 0; i < ids.length; i++) {
                            var replacement =
                                allowed(ids[i]) && locate(String(ids[i]));
                            if (replacement) {
                                w.playChannel(replacement[0], replacement[1]);
                                break;
                            }
                        }
                    })
                    .catch(function () {})
                    .then(function () {
                        if (folderRecovery === selected) folderRecovery = null;
                    });
            }
            return;
        }
        if (mediaPlaylistChannel()) {
            mediaStarting = true;
            lastProgress = now();
            lastPosition = null;
        }
        // Resolve the channel again, including expiring provider URLs. Never reuse
        // an old stream URL, list position, or a different provider's identical ID.
        w.playChannel(indices[0], indices[1]);
    }
    function restartPlayer(): boolean {
        if (w.__ottStandby?.blocked()) return false;
        try {
            if (
                typeof w.restart !== "function" ||
                typeof w.stbGetPersistedItem !== "function" ||
                provider() !== policy.provider ||
                (policy.media
                    ? !w.__ottMedia || w.__ottMedia.sourceId() !== policy.source
                    : source() !== policy.source)
            )
                return false;
            // Reserve a durable cooldown before reloading so a broken source cannot
            // create a boot loop. Keep soft stream recovery available throughout.
            var reloadKey = "__ottKioskReloadV1";
            var time = Date.now();
            var previous = Number(w.stbGetPersistedItem(reloadKey) || 0);
            if (previous > 0 && time - previous < 600000) return false;
            var stored = JSON.stringify(policy);
            w.stbSetItem(key, stored);
            if (w.stbGetPersistedItem(key) !== stored) return false;
            w.stbSetItem(reloadKey, String(time));
            if (w.stbGetPersistedItem(reloadKey) !== String(time)) return false;
            w.restart();
            recoveryAttempts = 0;
            return true;
        } catch (_) {
            return false;
        }
    }
    function tick(): void {
        if (w.__ottStandby?.blocked()) return;
        if (!locked()) {
            pauseForScreen();
            return;
        }
        var time = now();
        if (time < lastProgress) lastProgress = time;
        var mediaAdmitted = false;
        try {
            if (!mediaStarting && mediaPlaylistChannel()) {
                var channelMedia = w.__ottMedia && w.__ottMedia.current();
                var channelSequence = channelMedia && channelMedia.sequence;
                if (
                    channelMedia &&
                    channelMedia.ended &&
                    channelSequence &&
                    channelSequence.channel &&
                    String(channelSequence.channel.id) === policy.channel.id
                ) {
                    mediaStarting = true;
                    lastProgress = time;
                    lastPosition = null;
                }
            }
        } catch (_) {
            health = "error";
        }
        if (policy.media) {
            try {
                // Health polling reads the current identity/position, never copies the queue.
                var selection = w.__ottMedia && w.__ottMedia.current();
                var state =
                    w.__ottClassicPlayback && w.__ottClassicPlayback.snapshot();
                if (
                    selection &&
                    state &&
                    state.target &&
                    state.target.kind === "vod" &&
                    selection.ref.sourceId === policy.source &&
                    state.target.sourceId === policy.source &&
                    state.target.channelId === selection.ref.itemId
                ) {
                    var selectedRef = selection.ref;
                    mediaAdmitted = allowedMedia(selectedRef);
                    if (mediaAdmitted) {
                        // Natural EOF may resolve the next episode asynchronously on slow devices.
                        if (selection.ended && !mediaStarting) {
                            mediaStarting = true;
                            lastProgress = time;
                            lastPosition = null;
                        }
                        if (lastMediaId !== selectedRef.itemId) {
                            frameRecovery = false;
                            frameHealthySince = null;
                            lastMediaId = selectedRef.itemId;
                            lastPosition = null;
                            lastProgress = time;
                            mediaStarting = true;
                        }
                        var sequence = selection.sequence;
                        var cursor = sequence && sequence.index;
                        var exactCursor =
                            sequence &&
                            sequence.queueId === policy.media.queueId &&
                            typeof cursor === "number" &&
                            Math.floor(cursor) === cursor &&
                            cursor >= 0 &&
                            cursor < policy.media.records.length &&
                            policy.media.records[cursor].__ottMediaRef
                                .itemId === selectedRef.itemId;
                        for (var i = 0; i < policy.media.records.length; i++) {
                            if (
                                policy.media.records[i].__ottMediaRef.itemId ===
                                    selectedRef.itemId &&
                                (!exactCursor || i === cursor)
                            ) {
                                policy.media.index = i;
                                policy.media.position =
                                    !selection.ended &&
                                    typeof state.position === "number" &&
                                    isFinite(state.position) &&
                                    state.position >= 0
                                        ? state.position
                                        : 0;
                                break;
                            }
                        }
                        if (time - lastSaved >= 5000) {
                            try {
                                var stored = JSON.stringify(policy);
                                w.stbSetItem(key, stored);
                                if (w.stbGetItem(key) === stored)
                                    lastSaved = time;
                            } catch (_) {
                                // Keep the live cursor for recovery. A failed checkpoint
                                // does not describe decoder health; retry in five seconds.
                                lastSaved = time;
                            }
                        }
                    }
                }
            } catch (_) {
                health = "error";
            }
        }
        if (!screenAwake) {
            pauseForScreen();
            return;
        }
        try {
            var frames = videoProgress.sample(
                time,
                w.__ottClassicPlayback && w.__ottClassicPlayback.snapshot()
            );
            if (frames.state === "stalled") frameRecovery = true;
            if (frameRecovery) {
                if (
                    frames.state === "progressing" &&
                    frames.frame_age_ms <= 2000
                ) {
                    if (frameHealthySince === null) frameHealthySince = time;
                    if (time - frameHealthySince >= 10000) {
                        frameRecovery = false;
                        frameHealthySince = null;
                    }
                } else frameHealthySince = null;
            }
            var id = (w.curList || [])[w.primaryIndex];
            var position = w.stbGetPosTime();
            var valid =
                typeof position === "number" &&
                isFinite(position) &&
                position >= 0;
            if (
                (policy.media ? mediaAdmitted : allowed(id)) &&
                w.stbIsPlaying() &&
                frames.state !== "stalled" &&
                !(frameRecovery && frames.state === "warming") &&
                valid &&
                lastPosition !== null &&
                position > lastPosition
            ) {
                lastProgress = time;
                health = "playing";
                mediaStarting = false;
                if (!frameRecovery && frames.state !== "warming")
                    recoveryAttempts = 0;
            }
            lastPosition = valid ? position : null;
        } catch (_) {
            lastPosition = null;
            health = "error";
        }
        if (
            time - lastProgress <
            (mediaStarting ||
            (frameRecovery && frames && frames.state === "warming")
                ? 60000
                : 10000)
        )
            return;
        lastProgress = time;
        lastPosition = null;
        health = "retrying";
        if (w.navigator && w.navigator.onLine === false && !folderLoop())
            return;
        if (recoveryAttempts >= 3 && restartPlayer()) return;
        retries++;
        recoveryAttempts++;
        try {
            play();
        } catch (_) {
            health = "error";
        }
    }
    function validQuery(query: string): boolean {
        try {
            return (
                !/[\x00-\x1f\x7f]/.test(query) &&
                encodeURIComponent(query).replace(/%[0-9A-F]{2}/g, "x")
                    .length <= 1024
            );
        } catch (_) {
            return false;
        }
    }
    function request(params: any, done: (result: any) => void): void {
        function fail(message: string): void {
            done({ data: { error: message }, status: "rejected" });
        }
        var mode = params && params.mode;
        if (
            !params ||
            typeof params !== "object" ||
            Array.isArray(params) ||
            Object.keys(params).some(function (name) {
                return name !== "mode" && name !== "query" && name !== "strict";
            }) ||
            (params.strict !== undefined &&
                typeof params.strict !== "boolean") ||
            ((mode === "off" || mode === "status") &&
                params.strict !== undefined) ||
            ["status", "on", "off", "set"].indexOf(mode) < 0 ||
            (params.query !== undefined &&
                (typeof params.query !== "string" ||
                    !params.query.trim() ||
                    !validQuery(params.query))) ||
            ((mode === "off" || mode === "status") &&
                params.query !== undefined) ||
            (mode === "set" && params.query === undefined)
        ) {
            fail("Use kiosk status, on [CHANNEL], set CHANNEL or off.");
            return;
        }
        if (mode === "status") {
            done({ data: snapshot(), status: "ok" });
            return;
        }
        if (mode === "off") {
            if (!save(null)) {
                fail("Could not save kiosk policy.");
                return;
            }
        } else {
            if (mode === "set" && !enabled()) {
                fail("Enable kiosk mode first.");
                return;
            }
            if (mode === "on" && enabled() && params.query === undefined) {
                if (
                    params.strict !== undefined &&
                    params.strict !== !!policy.strict
                ) {
                    var previous = policy;
                    if (!save({ ...policy, strict: params.strict })) {
                        fail("Could not save kiosk policy.");
                        return;
                    }
                    // Input policy changed, but the paused/deferred playback did
                    // not. Preserve its wake-up ownership across the new object.
                    if (sleepingPolicy === previous) sleepingPolicy = policy;
                    if (deferredPolicy === previous) deferredPolicy = policy;
                    if (locked()) closeControls();
                }
                done({ data: snapshot(), status: "ok" });
                return;
            }
            var driver = w.__ottActiveProviderDriver;
            var currentMedia =
                w.__ottMedia && w.__ottMedia.current && w.__ottMedia.current();
            var mediaPlaylist =
                driver &&
                driver.capabilities &&
                driver.capabilities.mediaPlaylist;
            // Selected roots use ordinary channel policy. An explicitly
            // launched media queue keeps its independent queue kiosk policy.
            if (
                (provider() === "vportal" || provider() === "plex") &&
                (!mediaPlaylist ||
                    (currentMedia &&
                        !(
                            currentMedia.sequence &&
                            currentMedia.sequence.channel
                        )))
            ) {
                if (params.query !== undefined) {
                    fail(
                        "Start the required media playback, then use kiosk on without a channel query."
                    );
                    return;
                }
                if (
                    w.__ottParental &&
                    (w.__ottParental.needs("providers") ||
                        w.__ottParental.needs("settings"))
                ) {
                    fail("Unlock player settings before enabling kiosk mode.");
                    return;
                }
                var selection = w.__ottMedia && w.__ottMedia.kioskSelection();
                if (
                    w.commandChannelsReady !== true ||
                    !validMedia(selection) ||
                    selection.source !== w.__ottMedia.sourceId()
                ) {
                    fail("Start media playback before enabling kiosk mode.");
                    return;
                }
                if (
                    w.sPSchannels &&
                    w.parentPIN !== "*" &&
                    !w.parentAccess &&
                    selection.records.some(function (row: any) {
                        return Number(row.adult) === 1;
                    })
                ) {
                    fail(
                        "Unlock parental access before locking this media queue."
                    );
                    return;
                }
                if (
                    !save({
                        channel: null,
                        media: selection,
                        provider: provider(),
                        source: selection.source,
                        strict:
                            params.strict !== undefined
                                ? params.strict
                                : !!(policy && policy.strict),
                    })
                ) {
                    fail("Could not save kiosk policy.");
                    return;
                }
                retries = 0;
                w.__ottMedia.keepKioskLoop();
                closeControls();
                done({ data: snapshot(), status: "ok" });
                return;
            }
            if (
                w.commandChannelsReady !== true ||
                !(w.cList || w.curList || []).length ||
                !w.__ottSourceIdentity ||
                typeof w.playChannel !== "function" ||
                typeof w.stbIsPlaying !== "function" ||
                typeof w.stbGetPosTime !== "function"
            ) {
                fail("Wait for a player with channel playback to be ready.");
                return;
            }
            if (
                w.__ottParental &&
                (w.__ottParental.needs("providers") ||
                    w.__ottParental.needs("settings"))
            ) {
                fail(
                    "Unlock player settings before enabling or changing kiosk mode."
                );
                return;
            }
            var selected: any = null;
            var folder: any = null;
            if (
                provider() === "offline" &&
                typeof params.query === "string" &&
                params.query.indexOf("folder:") === 0
            ) {
                var folderName = caselessKey(params.query.slice(7).trim());
                var connected = w.__ottLocalMedia?.completedSources?.();
                if (!connected) {
                    fail(
                        "Wait for the local media scan to finish before locking a folder."
                    );
                    return;
                }
                var sources = connected.filter(function (source: any) {
                    return (
                        source.kind === "folder" &&
                        caselessKey(String(source.name || "")) === folderName
                    );
                });
                if (!folderName || sources.length !== 1) {
                    fail(
                        "Select one uniquely named local folder with playable videos."
                    );
                    return;
                }
                var ids = (w.cList || w.curList || []).filter(function (
                    id: any
                ) {
                    var row = (w.channels || {})[id];
                    return row && row.__ottLocalSource === sources[0].id;
                });
                if (!ids.length) {
                    fail(
                        "Select one uniquely named local folder with playable videos."
                    );
                    return;
                }
                if (
                    ids.some(function (id: any) {
                        return Number(w.channels[id].adult) === 1;
                    }) &&
                    w.sPSchannels &&
                    w.parentPIN !== "*" &&
                    !w.parentAccess
                ) {
                    fail("Unlock parental access before locking this folder.");
                    return;
                }
                var currentId = (w.curList || [])[w.primaryIndex];
                var first = ids.indexOf(currentId) >= 0 ? currentId : ids[0];
                selected = {
                    id: String(first),
                    name: String(w.channels[first].channel_name || ""),
                };
                folder = {
                    id: sources[0].id,
                    name: String(sources[0].name),
                };
            } else if (params.query !== undefined) {
                var text = params.query.trim();
                var rows = (w.cList || w.curList || [])
                    .filter(function (id: any, i: number, ids: any[]) {
                        return ids.indexOf(id) === i && (w.channels || {})[id];
                    })
                    .map(function (id: any, i: number) {
                        return {
                            id: String(id),
                            name: String(w.channels[id].channel_name || ""),
                            number: i + 1,
                        };
                    });
                var search = caselessKey(text);
                // Keep catalogue order, even when a later row is an exact name match.
                var matches = rows.filter(function (row: any) {
                    return /^\d+$/.test(text)
                        ? row.number === Number(text)
                        : caselessKey(row.name).indexOf(search) !== -1;
                });
                if (!matches.length || !locate(matches[0].id)) {
                    fail(
                        "No matching channel is available in the current categories."
                    );
                    return;
                }
                selected = { id: matches[0].id, name: matches[0].name };
                if (
                    typeof w.ifParentalAccessChId === "function" &&
                    w.ifParentalAccessChId(selected.id, function () {})
                ) {
                    fail(
                        "Unlock the channel before selecting it for kiosk mode."
                    );
                    return;
                }
            }
            if (
                !save({
                    channel: selected,
                    ...(folder ? { folder: folder } : {}),
                    provider: provider(),
                    source: source(),
                    strict:
                        params.strict !== undefined
                            ? params.strict
                            : !!(policy && policy.strict),
                })
            ) {
                fail("Could not save kiosk policy.");
                return;
            }
            retries = 0;
            if (selected) {
                closeControls();
                try {
                    play();
                } catch (_) {
                    health = "error";
                }
            }
        }
        done({ data: snapshot(), status: "ok" });
    }
    function init(): void {
        try {
            var saved = JSON.parse(w.stbGetItem(key) || "null");
            if (
                saved &&
                typeof saved.source === "string" &&
                typeof saved.provider === "string" &&
                (saved.strict === undefined ||
                    typeof saved.strict === "boolean") &&
                (saved.folder === undefined ||
                    (saved.provider === "offline" &&
                        saved.channel &&
                        typeof saved.folder.id === "string" &&
                        saved.folder.id.length > 0 &&
                        saved.folder.id.length <= 1024 &&
                        typeof saved.folder.name === "string" &&
                        saved.folder.name.length <= 1024)) &&
                (saved.media
                    ? (saved.provider === "vportal" ||
                          saved.provider === "plex") &&
                      saved.channel === null &&
                      validMedia(saved.media) &&
                      saved.media.source === saved.source
                    : saved.channel === null ||
                      (saved.channel &&
                          typeof saved.channel.id === "string" &&
                          typeof saved.channel.name === "string"))
            )
                policy = saved;
        } catch (_) {}
        reset();
        if (timer === null) timer = w.setInterval(tick, 1000);
    }
    function stopDiagnostics(): boolean {
        if (!locked()) return false;
        try {
            var controller = w.__ottRemoteDiagnostics;
            if (
                !controller ||
                typeof controller.status !== "function" ||
                typeof controller.stopSession !== "function"
            )
                return false;
            var state = controller.status();
            if (
                !state ||
                state.state !== "active" ||
                typeof state.sessionId !== "string" ||
                !/^[A-Za-z0-9_.:-]{1,80}$/.test(state.sessionId)
            )
                return false;
            // Stop only this capture; connection authority and kiosk playback stay intact.
            controller.stopSession();
            return true;
        } catch (_) {
            return false;
        }
    }
    // A local footer gesture may seek only the episode/decoder it started on.
    function beginSeek(): any {
        try {
            var selected = policy;
            var playback = w.__ottClassicPlayback;
            var media = w.__ottMedia;
            var backend = w.__ottCoreBackendPeek && w.__ottCoreBackendPeek();
            var handle = backend && backend.current();
            if (
                !strict() ||
                !selected.media ||
                !playback ||
                !media ||
                !handle ||
                typeof handle.seek !== "function" ||
                typeof handle.active !== "function"
            )
                return null;
            var initial = playback.snapshot();
            var generation = initial.generation;
            var itemId = initial.target && initial.target.channelId;
            var duration = handle.snapshot().duration;
            if (
                typeof duration !== "number" ||
                !isFinite(duration) ||
                duration <= 1
            )
                return null;
            var current = function (): boolean {
                var state = playback.snapshot();
                var item = media.current();
                var phase = handle.snapshot().phase;
                return (
                    strict() &&
                    policy === selected &&
                    provider() === selected.provider &&
                    w.__ottClassicPlayback === playback &&
                    w.__ottMedia === media &&
                    w.__ottCoreTransport &&
                    w.stbPlay === w.__ottCoreTransport.play &&
                    w.__ottCoreBackendPeek() === backend &&
                    backend.current() === handle &&
                    handle.active() &&
                    (phase === "playing" || phase === "paused") &&
                    media.sourceId() === selected.source &&
                    item &&
                    !item.ended &&
                    state.generation === generation &&
                    state.target &&
                    initial.target &&
                    state.target.kind === "vod" &&
                    state.target.sourceId === selected.source &&
                    state.target.channelId === itemId &&
                    item.ref.sourceId === selected.source &&
                    item.ref.itemId === state.target.channelId &&
                    allowedMedia(item.ref) &&
                    handle.snapshot().duration === duration
                );
            };
            if (!current()) return null;
            return function (fraction: number): boolean {
                try {
                    if (
                        typeof fraction !== "number" ||
                        !isFinite(fraction) ||
                        !current()
                    )
                        return false;
                    var position = Math.min(
                        duration - 1,
                        Math.max(0, fraction * duration)
                    );
                    handle.seek(position);
                    // Do not let an intentional seek look like a playback stall.
                    videoProgress.reset();
                    frameHealthySince = null;
                    lastPosition = null;
                    lastProgress = now();
                    mediaStarting = true;
                    selected.media.position = position;
                    return true;
                } catch (_) {
                    return false;
                }
            };
        } catch (_) {
            return null;
        }
    }
    function diagnosticsStopTarget(event: any): boolean {
        var doc = w.document;
        if (!doc || typeof doc.getElementById !== "function") return false;
        var button = doc.getElementById("remoteDiagnosticsIndicator");
        return (
            !!button &&
            button.nodeName === "BUTTON" &&
            button.ownerDocument === doc &&
            event.target === button
        );
    }
    function blockInput(event: any): void {
        if (!locked()) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        // Consume the activation here: neither a DOM onclick nor a delegated
        // settings handler may run through this exception to kiosk input locking.
        if (
            ["click", "pointerdown", "mousedown", "touchstart"].indexOf(
                event.type
            ) >= 0 &&
            diagnosticsStopTarget(event)
        )
            stopDiagnostics();
    }
    function stopDiagnosticsKey(event: any): void {
        if (
            !locked() ||
            !diagnosticsStopTarget(event) ||
            (event.key !== "Enter" &&
                event.key !== " " &&
                event.keyCode !== 13 &&
                event.keyCode !== 32)
        )
            return;
        event.preventDefault();
        event.stopImmediatePropagation();
        stopDiagnostics();
    }
    if (w.document && w.document.addEventListener) {
        // Catch delayed autoplay/decoder recovery while the screen is still off.
        w.document.addEventListener("play", pauseForScreen, true);
        w.document.addEventListener("playing", pauseForScreen, true);
        w.document.addEventListener("keydown", stopDiagnosticsKey, true);
        [
            "click",
            "dblclick",
            "pointerdown",
            "mousedown",
            "touchstart",
            "wheel",
        ].forEach(function (name) {
            w.document.addEventListener(name, blockInput, {
                capture: true,
                passive: false,
            });
        });
    }
    return {
        admit: admit,
        allowed: allowed,
        allowedMedia: allowedMedia,
        beginSeek: beginSeek,
        deferScreenEnd: function (end: () => void): void {
            if (screenBlocked()) screenEnd = end;
        },
        enabled: enabled,
        folderLoop: folderLoop,
        folderNext: folderNext,
        init: init,
        locked: locked,
        request: request,
        restoreMedia: function (): boolean {
            if (!locked() || !policy.media) return false;
            reset();
            play();
            return true;
        },
        screenBlocked: screenBlocked,
        setScreenAwake: setScreenAwake,
        snapshot: snapshot,
        stopDiagnostics: stopDiagnostics,
        strict: strict,
        strictKey: strictInput.key,
    };
}
