/**
 * Transitional codec/effect boundary for the classic UI and provider ABI.
 * Numeric modes and positional records never enter the common playback model.
 * Remove this module when the remaining classic views consume typed state.
 */
var classicPlaybackController: any = null;
var classicPlaybackState: any = null;
var classicPlaybackProjection: any = null;
var classicPlaybackStartedAt: number | null = null;

function classicPlaybackHost(): any {
    return window as any;
}

function classicPlaybackSource(w: any): string {
    return w.__ottSourceIdentity.current(w);
}

function classicPlaybackSlot(w: any): number {
    var value = Number(w.m3uArr && w.m3uArr.active);
    return isFinite(value) && value >= 0 && Math.floor(value) === value
        ? value
        : 0;
}

function classicPlaybackSourceConfiguration(w: any): any {
    var slot =
        w.p_pref === "m3u" && w.m3uArr && w.m3uArr.M3Us
            ? w.m3uArr.M3Us[classicPlaybackSlot(w)]
            : null;
    return {
        activeMedia: w.playType === -1e11 ? w.medSourceId : null,
        media: w.playType === -1e11 && slot ? slot.medSourceId : null,
        slot: slot,
        url: slot && slot.www,
    };
}

function classicPlaybackConfigurationMatches(a: any, b: any): boolean {
    return (
        a.slot === b.slot &&
        a.url === b.url &&
        a.media === b.media &&
        a.activeMedia === b.activeMedia
    );
}

function classicPlaybackIdentity(value: any): boolean {
    return (
        (typeof value === "number" && isFinite(value)) ||
        (typeof value === "string" && value.trim().length > 0)
    );
}

function classicPlaybackChannel(w: any, category: number, index: number): any {
    var key = (w.catsArray || [])[category];
    return ((w.cats || {})[key] || [])[index];
}

/** Legacy input codec; invoked only when external scripts changed the projection. */
function classicPlaybackDecode(
    w: any,
    selection = false
): PlaybackVisit | null {
    var mode = Number(w.playType) || 0;
    if (!isFinite(mode)) mode = 0;
    var id = classicPlaybackChannel(w, w.catIndex, w.primaryIndex);
    if (mode < 0 && (!selection || mode === -1e11)) {
        var owned = mode === -1e11 && w.__ottMedia && w.__ottMedia.current();
        var media = owned ? owned.payload : null;
        return {
            channelId: String(
                (owned && owned.ref.itemId) ||
                    (classicPlaybackIdentity(id) ? "channel:" + id : "media")
            ),
            kind: "vod",
            payload: media,
            sourceId: owned ? owned.ref.sourceId : classicPlaybackSource(w),
        };
    }
    if (!classicPlaybackIdentity(id)) return null;
    return {
        archiveStart: mode > 0 ? mode : undefined,
        channelId: String(id),
        kind: mode > 0 ? "archive" : "live",
        payload: {
            c: w.catIndex,
            ci: id,
            e: w._prog100 && w._prog100.name,
            i: w.primaryIndex,
        },
        sourceId: classicPlaybackSource(w),
    };
}

function classicPlaybackOwnedState(): any {
    if (!classicPlaybackState)
        classicPlaybackState =
            classicPlaybackHost().__ottPlaybackSession.createState(function (
                snapshot: PlaybackStateSnapshot
            ): void {
                var api = classicPlaybackHost().__ottClassicPlayback;
                if (api && typeof api.checkpoint === "function")
                    api.checkpoint(snapshot);
            });
    return classicPlaybackState;
}

function classicPlaybackProjectionValue(w: any): any {
    var channel = classicPlaybackChannel(w, w.catIndex, w.primaryIndex);
    return {
        catalog: w.channels,
        channel: channel,
        configuration: classicPlaybackSourceConfiguration(w),
        media: w.__ottMedia && w.__ottMedia.current(),
        mode: w.playType,
        record: (w.channels || {})[channel],
        source: classicPlaybackSource(w),
    };
}

function classicPlaybackReconcile(): PlaybackStateSnapshot {
    var w = classicPlaybackHost();
    var store = classicPlaybackOwnedState();
    var value = classicPlaybackProjectionValue(w);
    var previous = classicPlaybackProjection;
    var sameConfiguration =
        previous &&
        classicPlaybackConfigurationMatches(
            value.configuration,
            previous.configuration
        );
    if (
        !previous ||
        value.source !== previous.source ||
        value.channel !== previous.channel ||
        value.record !== previous.record ||
        value.catalog !== previous.catalog ||
        value.mode !== previous.mode ||
        !sameConfiguration ||
        (value.mode === -1e11 && value.media !== previous.media)
    ) {
        var target = classicPlaybackDecode(w);
        var before = store.snapshot();
        var managed =
            w.__ottCoreTransport && w.stbPlay === w.__ottCoreTransport.play;
        var sameTarget =
            target &&
            before.target &&
            target.kind === before.target.kind &&
            target.sourceId === before.target.sourceId &&
            target.channelId === before.target.channelId &&
            target.archiveStart === before.target.archiveStart;
        if (
            managed &&
            sameTarget &&
            previous &&
            value.source === previous.source &&
            value.channel === previous.channel &&
            value.record === previous.record &&
            value.mode === previous.mode &&
            value.media === previous.media &&
            sameConfiguration
        ) {
            // Republishing the catalog does not replace this decoder or reset
            // its measured position, paused state or terminal stop.
            classicPlaybackProjection = value;
            return before;
        }
        classicPlaybackStartedAt = null;
        store.open(
            target,
            classicPlaybackDecode(w, true),
            target && target.kind === "archive" ? Number(w.playTime) || 0 : 0,
            false
        );
        // Only the managed decoder can confirm playback. Importing a changed
        // UI projection must not revive a stopped/failed source or invent play.
        if (!managed) store.phase("playing", false);
        classicPlaybackProjection = value;
    }
    return store.snapshot();
}

function classicPlaybackSnapshot(): PlaybackStateSnapshot {
    return classicPlaybackOwnedState().snapshot();
}

/** Explicit transport observation at action boundaries; snapshot stays a pure read. */
function classicPlaybackCapture(): void {
    var w = classicPlaybackHost();
    var state = classicPlaybackReconcile();
    var managed =
        w.__ottCoreTransport && w.stbPlay === w.__ottCoreTransport.play;
    if (managed) {
        var handle = w.__ottCoreBackend().current();
        if (handle) {
            handle.sample();
            return;
        }
    }
    if (
        state.target &&
        state.target.kind === "vod" &&
        (state.phase === "playing" || state.phase === "paused") &&
        typeof w.stbGetPosTime === "function"
    )
        classicPlaybackOwnedState().position(
            w.stbGetPosTime(),
            typeof w.stbGetLen === "function" ? w.stbGetLen() : undefined,
            false
        );
}

function classicPlaybackVisit(
    _w: any,
    selection = false
): PlaybackVisit | null {
    var snapshot = classicPlaybackSnapshot();
    return selection ? snapshot.historyTarget : snapshot.target;
}

/** Semantic commands own normal playback state; old fields are output projection. */
function classicPlaybackCommand(command: any): void {
    var w = classicPlaybackHost();
    var state = classicPlaybackSnapshot();
    var store = classicPlaybackOwnedState();
    if (
        command.generation !== undefined &&
        command.generation !== state.generation
    )
        return;
    var type = command.type;
    if (type === "playing" && state.target && classicPlaybackStartedAt === null)
        classicPlaybackStartedAt = Date.now() / 1000;
    if (
        type === "live" ||
        type === "archive" ||
        type === "vod" ||
        type === "finite-channel"
    ) {
        // Local catalog entries use channel navigation, but their decoder is
        // finite media from the outset. Do not wait for the one-shot metadata
        // probe: a slow disk can supply duration only after that probe ran.
        var localChannel =
            type === "live" && w.__ottActiveProviderDriver?.id === "offline";
        var finiteChannel = type === "finite-channel" || localChannel;
        var mediaChannel = type === "vod" && command.channelSelection != null;
        var id =
            command.channelId !== undefined
                ? command.channelId
                : classicPlaybackChannel(w, w.catIndex, w.primaryIndex);
        if (type === "vod")
            id =
                command.channelId !== undefined
                    ? command.channelId
                    : command.item && command.item.stream_url;
        if (!classicPlaybackIdentity(id)) return;
        if (
            type === "archive" &&
            (typeof command.archiveStart !== "number" ||
                !isFinite(command.archiveStart) ||
                command.archiveStart <= 0)
        )
            return;
        if (
            type === "finite-channel" &&
            (!state.target ||
                state.target.kind !== "live" ||
                state.phase === "stopped")
        )
            return;
        var history: PlaybackVisit = {
            archiveStart:
                type === "archive"
                    ? Math.floor(command.archiveStart)
                    : undefined,
            channelId: String(id),
            kind:
                type === "archive"
                    ? "archive"
                    : type === "vod"
                      ? "vod"
                      : "live",
            payload:
                type === "vod"
                    ? command.item
                    : {
                          c: w.catIndex,
                          ci: id,
                          e:
                              typeof command.label === "string"
                                  ? command.label
                                  : w._prog100 && w._prog100.name,
                          i: w.primaryIndex,
                      },
            sourceId:
                type === "vod" && w.__ottMedia
                    ? command.sourceId || w.__ottMedia.sourceId()
                    : classicPlaybackSource(w),
        };
        // Category positions can change while this Local file is playing.
        if (localChannel)
            history.payload.groupId = w.__ottChannels?.group(w.catIndex);
        var target: PlaybackVisit = finiteChannel
            ? {
                  channelId: "channel:" + id,
                  kind: "vod",
                  sourceId: history.sourceId,
              }
            : history;
        if (mediaChannel) {
            // Resolve and checkpoint the real media ID, while the channel
            // list retains its ordinary stable selection and history.
            history = {
                channelId: String(command.channelSelection),
                kind: "live",
                payload: {
                    c: w.catIndex,
                    ci: command.channelSelection,
                    i: w.primaryIndex,
                },
                sourceId: classicPlaybackSource(w),
            };
        }
        w.playType =
            type === "archive"
                ? history.archiveStart
                : type === "vod"
                  ? mediaChannel
                      ? -99999999999
                      : -1e11
                  : finiteChannel
                    ? -99999999999
                    : 0;
        w.playTime =
            typeof command.position === "number" &&
            isFinite(command.position) &&
            command.position >= 0
                ? command.position
                : 0;
        classicPlaybackProjection = classicPlaybackProjectionValue(w);
        if (classicPlaybackController) classicPlaybackController.cancel();
        if (w.__ottMedia && w.__ottMedia.playbackStop)
            w.__ottMedia.playbackStop(state.target);
        if (type !== "finite-channel") classicPlaybackStartedAt = null;
        if (type === "finite-channel")
            store.classify(target, history, command.duration);
        else store.open(target, history, w.playTime);
        return;
    }
    if (type === "position") {
        if (state.phase === "stopped") return;
        store.position(command.position, command.duration);
        var measured = store.snapshot();
        if (measured.target) w.playTime = measured.position;
    } else if (
        type === "stop" ||
        type === "pause" ||
        type === "resume" ||
        type === "loading" ||
        type === "playing"
    ) {
        if (type === "stop") {
            if (classicPlaybackController) classicPlaybackController.cancel();
            if (w.__ottMedia && w.__ottMedia.playbackStop)
                w.__ottMedia.playbackStop(state.target);
        }
        store.phase(
            type === "stop"
                ? "stopped"
                : type === "pause"
                  ? "paused"
                  : type === "resume"
                    ? "playing"
                    : type
        );
    }
    classicPlaybackProjection = classicPlaybackProjectionValue(w);
}

function classicPlaybackObservation(): PlaybackObservation & {
    isCurrentSource(): boolean;
    isCurrentBackend(): boolean;
} {
    var w = classicPlaybackHost();
    var snapshot = classicPlaybackSnapshot();
    var target = snapshot.phase === "stopped" ? null : snapshot.target;
    var id =
        snapshot.historyTarget && snapshot.historyTarget.kind !== "vod"
            ? snapshot.historyTarget.channelId
            : classicPlaybackChannel(w, w.catIndex, w.primaryIndex);
    var channel = (w.channels || {})[id];
    var catalog = w.channels;
    var mode = w.playType;
    var categoryIndex = w.catIndex;
    var selectionIndex = w.primaryIndex;
    var categories = w.catsArray;
    var lists = w.cats;
    var list = (lists || {})[(categories || [])[w.catIndex]];
    var get = w.providerGetItem;
    var set = w.providerSetItem;
    var prefix = w.p_pref;
    var source = classicPlaybackSource(w);
    var configuration = classicPlaybackSourceConfiguration(w);
    var media = w.__ottMedia && w.__ottMedia.current();
    var retention = Number(channel && channel.rec) || 0;
    var now = Date.now() / 1000;
    var playbackIdentity = snapshot.historyTarget || snapshot.target;
    function isCurrentSource(): boolean {
        var current = classicPlaybackSnapshot();
        var identity = current.historyTarget || current.target;
        return (
            ((!playbackIdentity && !identity) ||
                (!!playbackIdentity &&
                    !!identity &&
                    playbackIdentity.sourceId === identity.sourceId &&
                    playbackIdentity.channelId === identity.channelId)) &&
            channel === (w.channels || {})[id] &&
            get === w.providerGetItem &&
            set === w.providerSetItem &&
            prefix === w.p_pref &&
            source === classicPlaybackSource(w) &&
            classicPlaybackConfigurationMatches(
                configuration,
                classicPlaybackSourceConfiguration(w)
            ) &&
            media === (w.__ottMedia && w.__ottMedia.current())
        );
    }
    function isCurrentBackend(): boolean {
        return (
            isCurrentSource() &&
            snapshot.generation === classicPlaybackSnapshot().generation
        );
    }
    return {
        archiveAvailable:
            retention > 0 || (!!target && target.kind === "archive"),
        archiveEarliest:
            retention > 0 ? Math.max(0, now - retention * 3600) : undefined,
        duration: snapshot.duration,
        isCurrent: function (): boolean {
            return (
                isCurrentBackend() &&
                catalog === w.channels &&
                categoryIndex === w.catIndex &&
                selectionIndex === w.primaryIndex &&
                categories === w.catsArray &&
                lists === w.cats &&
                list === (w.cats || {})[(w.catsArray || [])[w.catIndex]] &&
                mode === w.playType
            );
        },
        isCurrentBackend: isCurrentBackend,
        isCurrentSource: isCurrentSource,
        now: now,
        position: snapshot.position,
        target: target,
    };
}

function classicPlaybackAnnounce(intent: PlaybackIntent): void {
    var w = classicPlaybackHost();
    if (w.sInfoRew && typeof w.showChannelInfo === "function")
        w.showChannelInfo(1);
    if (typeof w.showShift !== "function") return;
    if (intent.intent === "begin")
        w.showShift(w._ ? w._("To begining") : "To beginning");
    else if (typeof w.formatSeekOffset === "function")
        w.showShift(w.formatSeekOffset(intent.value || 0));
}

function classicPlaybackRuntime(): any {
    if (classicPlaybackController) return classicPlaybackController;
    var w = classicPlaybackHost();
    classicPlaybackController = w.__ottPlaybackSession.create(w.OttPlayCore, {
        apply: function (plan: any, intent: PlaybackIntent): void {
            if (plan.action === "seek") {
                if (typeof w.stbSetPosTime === "function")
                    w.stbSetPosTime(plan.position);
                classicPlaybackAnnounce(intent);
            } else if (plan.action === "open-archive") {
                if (
                    classicPlaybackSnapshot().target?.kind === "live" &&
                    typeof w.replayFromLiveOffset === "function"
                )
                    w.replayFromLiveOffset(
                        Math.max(0, Date.now() / 1000 - plan.archiveStart)
                    );
                else {
                    classicPlaybackAnnounce(intent);
                    w.playArchive(plan.archiveStart);
                }
            } else if (plan.action === "go-live" || plan.action === "restart") {
                if (typeof w.showShift === "function") {
                    var message =
                        plan.action === "go-live" ? "Live" : "Restart stream";
                    w.showShift(w._ ? w._(message) : message);
                }
                w.playChannel(w.catIndex, w.primaryIndex);
            }
        },
        observe: classicPlaybackObservation,
        preview: classicPlaybackAnnounce,
        schedule: function (callback: () => void, delay: number): any {
            return setTimeout(callback, delay);
        },
        unschedule: function (timer: any): void {
            clearTimeout(timer);
        },
    });
    return classicPlaybackController;
}

function classicPlaybackSelect(
    category: number,
    index: number,
    archive?: boolean
): void {
    var w = classicPlaybackHost();
    classicPlaybackCapture();
    var observation = classicPlaybackObservation();
    var id = classicPlaybackChannel(w, category, index);
    if (w.__ottChannels && classicPlaybackIdentity(id))
        w.__ottChannels.select(category, id);
    var next: PlaybackVisit | null =
        index === -1 || !classicPlaybackIdentity(id)
            ? null
            : {
                  archiveStart: archive
                      ? observation.target &&
                        observation.target.kind === "archive"
                          ? observation.target.archiveStart
                          : observation.now
                      : undefined,
                  channelId: String(id),
                  kind: archive ? "archive" : "live",
                  sourceId: classicPlaybackSource(w),
              };
    var history: PlaybackVisit[] = [];
    (Array.isArray(w.prevArr) ? w.prevArr : []).forEach(function (
        entry: any
    ): void {
        if (
            !entry ||
            typeof entry !== "object" ||
            !classicPlaybackIdentity(entry.ci)
        )
            return;
        if (
            entry.t !== undefined &&
            (typeof entry.t !== "number" || !isFinite(entry.t) || entry.t < 0)
        )
            return;
        history.push({
            archiveStart: entry.t,
            channelId: String(entry.ci),
            kind: entry.t !== undefined ? "archive" : "live",
            payload: entry,
            sourceId: classicPlaybackSource(w),
        });
    });
    var limit =
        [1, 5, 10, 15, 20][w.settings ? w.settings.prevCount : w.sPrevCount] ||
        10;
    var result = classicPlaybackRuntime().transition(
        classicPlaybackVisit(w, true),
        next,
        history,
        observation.position,
        limit,
        ["live", "archive"]
    );
    w.prevArr = result.history.map(function (visit: PlaybackVisit): any {
        var record: any = {};
        Object.keys(visit.payload || {}).forEach(function (key: string): void {
            if (key !== "t") record[key] = visit.payload[key];
        });
        if (visit.kind === "archive") record.t = visit.archiveStart;
        return record;
    });
    result.effects.forEach(function (effect: any): void {
        if (
            effect.type !== "save-position" ||
            classicPersistenceSuspended ||
            !w.__ottMedia
        )
            return;
        w.__ottMedia.checkpoint(
            {
                itemId: effect.target.channelId,
                sourceId: effect.target.sourceId,
            },
            effect.position,
            true
        );
    });
    // A departure-only call does not change the classic selection or bookmark.
    if (index === -1) return;
    w.catIndex = category;
    w.curList = (w.cats || {})[(w.catsArray || [])[category]] || [];
    w.primaryIndex = index;
    var journal = classicPlaybackJournal();
    if (classicPersistenceSuspended || (journal && !journal.read().writable))
        return;
    w.providerSetItem("primaryIndex", String(index));
    w.providerSetItem("catIndex", String(category));
    w.providerSetItem("prevArr", JSON.stringify(w.prevArr));
    if (journal)
        journal.update({
            history: result.history.map(function (
                visit: PlaybackVisit
            ): PlaybackJournalEntry {
                var payload = visit.payload || {};
                return {
                    archiveStart: visit.archiveStart,
                    channelHint:
                        payload.channelHint ||
                        classicPlaybackChannelHint(visit.channelId),
                    channelId: visit.channelId,
                    groupId:
                        payload.groupId ||
                        (w.__ottChannels && w.__ottChannels.group(payload.c)) ||
                        (w.catsArray || [])[payload.c],
                    kind: visit.kind,
                    label: payload.e,
                };
            }),
        });
    try {
        // Preserve the v1 persistence contract until the versioned importer ships.
        var mode = w.playType > 0 ? "archive" : w.playType < 0 ? "vod" : "live";
        var bookmark: any = {
            catIndex: category,
            channelId: w.curList[index],
            channelIndex: index,
            mode: mode,
            updatedAt: Date.now(),
            v: 1,
        };
        if (mode !== "live") {
            bookmark.playType = w.playType;
            bookmark.playTime = w.playTime;
        }
        w.providerSetItem("continueWatch", JSON.stringify(bookmark));
    } catch (_error) {
        /* Bookmark persistence must not interrupt playback. */
    }
}

/** Storage access belongs to the compatibility edge, never to the domain store. */
var classicPersistenceSuspended = false;
var classicCheckpointSignature = "";
var classicCheckpointTime = 0;
// References imported from numeric/hash mirrors retain their origin. A collision
// is persisted unresolved instead of silently selecting a different station.
function classicPlaybackImportJournalValue(key: string, raw: any): any {
    var w = classicPlaybackHost();
    if (!raw || !w.__ottChannelReferences) return raw;
    try {
        var value = JSON.parse(raw);
        var codec: any = null;
        function reference(id: any): any {
            if (typeof id !== "string" && typeof id !== "number") return id;
            if (String(id).indexOf("channel-ref:") === 0) return id;
            if (!codec)
                codec = w.__ottChannelReferences.create(
                    w.channels || {},
                    w.__ottLegacyChannelAliases
                );
            return "channel-ref:" + JSON.stringify(codec.resolve(id, "raw"));
        }
        if (key === "playbackJournal") {
            if (!value || value.version !== 2 || value.channelReferences === 1)
                return raw;
            if (value.bookmark && value.bookmark.kind !== "vod")
                value.bookmark.channelId = reference(value.bookmark.channelId);
            if (Array.isArray(value.history))
                value.history.forEach(function (row: any): void {
                    if (row && row.kind !== "vod")
                        row.channelId = reference(row.channelId);
                });
        } else if (key === "prevArr" && Array.isArray(value)) {
            value.forEach(function (row: any): void {
                if (row) row.ci = reference(row.ci);
            });
        } else if (key === "continueWatch" && value) {
            if (
                value.mode === "vod" &&
                value.playType === -99999999999 &&
                w.__ottActiveProviderDriver?.id === "offline"
            )
                value.mode = "live";
            if (value.mode === "vod") return raw;
            value.channelId = reference(value.channelId);
        } else return raw;
        return JSON.stringify(value);
    } catch (_) {
        return raw;
    }
}

function classicPlaybackJournal(): any {
    var w = classicPlaybackHost();
    if (
        classicPersistenceSuspended ||
        !w.__ottPlaybackJournal ||
        typeof w.providerGetItem !== "function" ||
        typeof w.providerSetItem !== "function"
    )
        return null;
    var get = w.providerGetItem;
    var set = w.providerSetItem;
    var source = classicPlaybackSource(w);
    var legacy = w.__ottSourceIdentity.legacy(w);
    var localProfile = /^offline:\d+$/.test(legacy);
    var storageKey =
        source === legacy && !localProfile
            ? "playbackJournal"
            : "playbackJournal:" + source;
    function current(): boolean {
        return (
            source === classicPlaybackSource(w) &&
            get === w.providerGetItem &&
            set === w.providerSetItem
        );
    }
    function read(key: string): any {
        if (!current()) throw new Error("Playback source replaced");
        var value = get.call(w, key);
        if (!current()) throw new Error("Playback source replaced");
        return value;
    }
    var allowLegacy = false;
    try {
        var claim = read("playbackJournalSource");
        var canClaim = !localProfile;
        if (localProfile && !claim) {
            // A slot must not claim an older unprofiled or another slot's data.
            var previous = read("playbackJournal");
            canClaim = !!previous && JSON.parse(previous).sourceId === source;
        }
        if (!claim && canClaim) {
            set.call(w, "playbackJournalSource", source);
        }
        allowLegacy =
            ((!claim && canClaim) || claim === source) &&
            read("playbackJournalSource") === source;
    } catch (_) {}
    return w.__ottPlaybackJournal.create({
        channelReferences: 1,
        get: function (key: string): any {
            if (key === "playbackJournal") {
                var value = read(storageKey);
                if (
                    value == null &&
                    allowLegacy &&
                    storageKey !== "playbackJournal"
                )
                    value = read("playbackJournal");
                return classicPlaybackImportJournalValue(key, value);
            }
            return allowLegacy
                ? classicPlaybackImportJournalValue(key, read(key))
                : null;
        },
        importSourceId: allowLegacy
            ? legacy === "ottclub" && w.p_pref === ""
                ? "classic"
                : legacy
            : undefined,
        isCurrent: current,
        now: function (): number {
            return Date.now();
        },
        set: function (key: string, value: string): void {
            if (!current()) throw new Error("Playback source replaced");
            set.call(w, key === "playbackJournal" ? storageKey : key, value);
        },
        sourceId: source,
    });
}

/** M3U stream addresses can rotate even when the station metadata is unchanged. */
function classicPlaybackChannelHint(id: string): any {
    var w = classicPlaybackHost();
    var channel = (w.channels || {})[id];
    if (w.p_pref !== "m3u" || !channel) return undefined;
    var name = String(channel.channel_name || "");
    var guideId = String(channel.epg || "");
    var route =
        typeof channel.url === "string" ? channel.url.split(/[?#]/)[0] : "";
    return name || guideId
        ? {
              group: String((channel.category || {}).name || ""),
              guideId: guideId,
              name: name,
              routeId:
                  route && typeof w.murmurhash3_32_gc === "function"
                      ? String(w.murmurhash3_32_gc(route, 10))
                      : undefined,
          }
        : undefined;
}

function classicPlaybackLocate(
    id: string,
    groupId?: string,
    channelHint?: PlaybackJournalEntry["channelHint"]
): any {
    var w = classicPlaybackHost();
    if (id.indexOf("channel-ref:") === 0) {
        try {
            var ref = JSON.parse(id.slice("channel-ref:".length));
            var codec = w.__ottChannelReferences.create(
                w.channels || {},
                w.__ottLegacyChannelAliases
            );
            if (!ref.itemId && !ref.ambiguous && ref.legacyId !== undefined)
                ref = codec.resolve(ref.legacyId, ref.origin);
            if (ref.ambiguous) return null;
            var projected = codec.project(ref);
            if (projected !== null) id = String(projected);
        } catch (_) {
            return null;
        }
    }
    var groups = w.catsArray || [];
    var preferred = w.__ottChannels ? w.__ottChannels.index(groupId) : -1;
    if (preferred < 0) preferred = groups.indexOf(groupId);
    if (
        preferred < 0 &&
        typeof w.catIndex === "number" &&
        w.catIndex >= 0 &&
        w.catIndex < groups.length
    )
        preferred = w.catIndex;
    var order: number[] = [];
    if (preferred >= 0) order.push(preferred);
    for (var g = 0; g < groups.length; g++) if (g !== preferred) order.push(g);
    for (var at = 0; at < order.length; at++) {
        var category = order[at];
        var list = (w.cats || {})[groups[category]];
        if (!Array.isArray(list)) continue;
        for (var index = 0; index < list.length; index++) {
            if (String(list[index]) === id)
                return {
                    category: category,
                    id: list[index],
                    index: index,
                    list: list,
                };
        }
    }
    if (channelHint && w.p_pref === "m3u") {
        var channels = w.channels || {};
        var available = Object.keys(channels);
        var candidates = channelHint.guideId
            ? available.filter(function (key) {
                  return (
                      String(channels[key].epg || "") === channelHint.guideId
                  );
              })
            : [];
        // A unique guide ID survives renaming. Otherwise require an exact,
        // unambiguous station name and provider group; never guess by position.
        if (candidates.length !== 1)
            candidates = (candidates.length ? candidates : available).filter(
                function (key) {
                    var row = channels[key];
                    return (
                        !!channelHint.name &&
                        String(row.channel_name || "") === channelHint.name &&
                        String((row.category || {}).name || "") ===
                            channelHint.group
                    );
                }
            );
        if (candidates.length > 1 && channelHint.routeId)
            candidates = candidates.filter(function (key) {
                var hint = classicPlaybackChannelHint(key);
                return hint && hint.routeId === channelHint.routeId;
            });
        if (candidates.length === 1)
            return classicPlaybackLocate(candidates[0], groupId);
    }
    return null;
}

function classicPlaybackHydrate(): void {
    var w = classicPlaybackHost();
    classicPersistenceSuspended = false;
    classicCheckpointSignature = "";
    var journal = classicPlaybackJournal();
    if (!journal) return;
    var loaded = journal.read();
    if (!journal.active()) return;
    if (!loaded.writable) {
        w.prevArr = [];
        return;
    }
    var document = loaded.document;
    w.prevArr = document.history
        .filter(function (entry: PlaybackJournalEntry): boolean {
            return entry.kind !== "vod";
        })
        .map(function (entry: PlaybackJournalEntry): any {
            var found = classicPlaybackLocate(
                entry.channelId,
                entry.groupId,
                entry.channelHint
            );
            var result: any = {
                c: found ? found.category : -1,
                channelHint: entry.channelHint,
                ci: found ? found.id : entry.channelId,
                e: entry.label,
                groupId: entry.groupId,
                i: found ? found.index : -1,
            };
            if (entry.kind === "archive") result.t = entry.archiveStart;
            return result;
        });
    var bookmark = document.bookmark;
    if (bookmark && bookmark.kind === "live") {
        var selected = classicPlaybackLocate(
            bookmark.channelId,
            bookmark.groupId,
            bookmark.channelHint
        );
        if (selected) {
            w.catIndex = selected.category;
            w.primaryIndex = selected.index;
            w.curList = selected.list;
        }
    }
}

function classicPlaybackBookmark(): any {
    var journal = classicPlaybackJournal();
    if (!journal) return null;
    var loaded = journal.read();
    if (!journal.active() || !loaded.writable || !loaded.document.bookmark)
        return null;
    var item = loaded.document.bookmark;
    var found = classicPlaybackLocate(
        item.channelId,
        item.groupId,
        item.channelHint
    );
    if (!found) return null;
    return {
        catIndex: found.category,
        channelId: found.id,
        mode: item.kind,
        playTime: item.position,
        playType: item.archiveStart,
        updatedAt: loaded.document.updatedAt,
        v: 2,
    };
}

function classicPlaybackCheckpoint(snapshot: any, force = false): void {
    var w = classicPlaybackHost();
    var target = snapshot && (snapshot.historyTarget || snapshot.target);
    if (
        target &&
        target.kind === "vod" &&
        !classicPersistenceSuspended &&
        w.__ottMedia
    ) {
        w.__ottMedia.checkpoint(
            { itemId: target.channelId, sourceId: target.sourceId },
            snapshot.position,
            force || snapshot.phase !== "playing"
        );
        return;
    }
    if (!target || target.sourceId !== classicPlaybackSource(w)) return;
    var journal = classicPlaybackJournal();
    if (!journal) return;
    var signature = JSON.stringify([
        target.sourceId,
        target.channelId,
        target.kind,
        target.archiveStart,
        snapshot.phase,
    ]);
    var now = Date.now();
    if (
        !force &&
        snapshot.phase === "playing" &&
        signature === classicCheckpointSignature &&
        now - classicCheckpointTime < 5000
    )
        return;
    var payload = target.payload || {};
    var position = snapshot.position;
    if (
        w.__ottActiveProviderDriver?.id === "offline" &&
        snapshot.target?.kind === "vod" &&
        snapshot.duration > 0 &&
        isFinite(snapshot.duration) &&
        position >= snapshot.duration - 0.25
    )
        position = 0;
    var saved = journal.update({
        bookmark: {
            archiveStart: target.archiveStart,
            channelHint: classicPlaybackChannelHint(target.channelId),
            channelId: target.channelId,
            groupId:
                payload.groupId ||
                (w.__ottChannels && w.__ottChannels.group(payload.c)) ||
                (w.catsArray || [])[payload.c],
            kind: target.kind,
            position: position,
        },
    });
    if (saved) {
        classicCheckpointSignature = signature;
        classicCheckpointTime = now;
    }
}

/** Read-only programme timing; seeks and buffering never move the start clock. */
function classicPlaybackProgramme(): any {
    var w = classicPlaybackHost();
    var state = classicPlaybackSnapshot();
    if (state.target?.kind !== "vod" || !w.__ottMedia?.programme) return null;
    var metadata = w.__ottMedia.programme();
    if (!metadata) return null;
    var duration =
        typeof state.duration === "number" &&
        isFinite(state.duration) &&
        state.duration > 0
            ? state.duration
            : null;
    return {
        collection: metadata.collection,
        duration: duration,
        nextStartedAt:
            metadata.nextTitle &&
            duration !== null &&
            classicPlaybackStartedAt !== null
                ? classicPlaybackStartedAt + duration
                : null,
        nextTitle: metadata.nextTitle,
        position: state.position,
        startedAt: classicPlaybackStartedAt,
        title: metadata.title,
    };
}

(window as any).__ottClassicPlayback = {
    bookmark: classicPlaybackBookmark,
    cancel: function (): void {
        if (classicPlaybackController) classicPlaybackController.cancel();
        var archive = classicPlaybackHost().__ottClassicArchive;
        if (archive) archive.cancel();
    },
    canMigrateJournal: function (): boolean {
        var journal = classicPlaybackJournal();
        return !!journal && journal.read().writable;
    },
    checkpoint: classicPlaybackCheckpoint,
    command: classicPlaybackCommand,
    context: function (): any {
        var observation = classicPlaybackObservation();
        return {
            isCurrent: observation.isCurrent,
            isCurrentBackend: observation.isCurrentBackend,
            isCurrentSource: observation.isCurrentSource,
            sourceId: classicPlaybackSource(classicPlaybackHost()),
        };
    },
    guard: function (
        callback: (...args: any[]) => void
    ): (...args: any[]) => void {
        return classicPlaybackRuntime().guard(callback);
    },
    hydrate: classicPlaybackHydrate,
    importLegacy: classicPlaybackReconcile,
    programme: classicPlaybackProgramme,
    reconcile: classicPlaybackReconcile,
    select: classicPlaybackSelect,
    shift: function (delta: number): void {
        classicPlaybackCapture();
        classicPlaybackRuntime().request(
            delta === -6e6
                ? { intent: "begin" }
                : { intent: "offset", value: delta }
        );
    },
    snapshot: classicPlaybackSnapshot,
    sourceId: function (): string {
        return classicPlaybackSource(classicPlaybackHost());
    },
    suspendPersistence: function (): void {
        classicPersistenceSuspended = true;
        classicCheckpointSignature = "";
        if (classicPlaybackController) classicPlaybackController.cancel();
    },
};
