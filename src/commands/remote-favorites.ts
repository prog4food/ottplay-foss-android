import {
    checkProviderUrl,
    isProviderAllowed,
    providerIds,
    selectProviderByIndex,
} from "../provider";
import { caselessKey } from "../utils/caseless";
import { remoteFavoritesCapability } from "./remote-favorites-contract";
import { remotePlexQueue } from "./remote-plex";
import { handleRemoteProfiles } from "./remote-profiles";

var favoriteRequestActive = false;
var favoriteSequence = 0;
var favoriteStorageKey = "remoteFavorites.v1";

function favoriteText(value: any, limit: number, blank = false): boolean {
    try {
        return (
            typeof value === "string" &&
            (blank || !!value.trim()) &&
            !/[\u0000-\u001f\u007f]/.test(value) &&
            encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, "x").length <=
                limit
        );
    } catch (_) {
        return false;
    }
}
function favoriteLabel(value: any, limit: number): string {
    var text = String(value || "")
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .trim();
    while (text && !favoriteText(text, limit, true)) text = text.slice(0, -1);
    return text;
}
function favoriteProfile(w: any): any {
    var driver = w.__ottActiveProviderDriver;
    if (!driver || !/^[a-z0-9][a-z0-9_.\/-]{0,63}$/.test(driver.id))
        return null;
    var config = driver.configuration && driver.configuration();
    var rows = config && (driver.id === "m3u" ? config.M3Us : config.portals);
    var number =
        rows && typeof config.active === "number" ? config.active + 1 : null;
    if (
        number !== null &&
        (number < 1 ||
            number > 15 ||
            Math.floor(number) !== number ||
            !rows[number - 1])
    )
        return null;
    return {
        profile_name:
            number === null ? "" : favoriteLabel(rows[number - 1].name, 256),
        profile_number: number,
        provider: driver.id,
    };
}
function favoritePublic(entry: any): any {
    return {
        id: entry.id,
        kind: entry.kind,
        name: entry.name,
        profile_name: entry.profile_name,
        profile_number: entry.profile_number,
        provider: entry.provider,
        title: entry.title,
    };
}
function favoriteValid(entry: any): boolean {
    return (
        !!entry &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        /^fav-[a-z0-9-]{1,60}$/.test(entry.id) &&
        favoriteText(entry.name, 160) &&
        favoriteText(entry.title, 512) &&
        favoriteText(entry.profile_name, 256, true) &&
        /^[a-z0-9][a-z0-9_.\/-]{0,63}$/.test(entry.provider) &&
        (entry.profile_number === null ||
            (typeof entry.profile_number === "number" &&
                entry.profile_number >= 1 &&
                entry.profile_number <= 15 &&
                Math.floor(entry.profile_number) === entry.profile_number)) &&
        /^(live|vod)$/.test(entry.kind) &&
        favoriteText(entry.source, 256) &&
        entry.ref &&
        favoriteText(entry.ref.itemId, 8192) &&
        (entry.kind === "live" || favoriteText(entry.ref.sourceId, 256)) &&
        (entry.plex_id === undefined ||
            /^[1-9][0-9]{0,19}$/.test(entry.plex_id))
    );
}
function favoriteRead(w: any): any[] {
    if (typeof w.stbGetPersistedItem !== "function") throw new Error();
    var raw = w.stbGetPersistedItem(favoriteStorageKey);
    if (w.stbGetItem(favoriteStorageKey) !== raw) throw new Error();
    if (!raw) return [];
    if (typeof raw !== "string" || raw.length > 1500000) throw new Error();
    var parsed = JSON.parse(raw);
    if (
        !parsed ||
        parsed.version !== 1 ||
        !Array.isArray(parsed.entries) ||
        parsed.entries.length > 100 ||
        !parsed.entries.every(favoriteValid)
    )
        throw new Error();
    var ids: Record<string, boolean> = Object.create(null);
    parsed.entries.forEach(function (entry: any) {
        if (ids[entry.id]) throw new Error();
        ids[entry.id] = true;
    });
    return parsed.entries;
}
function favoriteWrite(w: any, entries: any[]): void {
    var text = JSON.stringify({ entries: entries, version: 1 });
    if (typeof w.stbGetPersistedItem !== "function") throw new Error();
    w.stbSetItem(favoriteStorageKey, text);
    if (
        w.stbGetPersistedItem(favoriteStorageKey) !== text ||
        w.stbGetItem(favoriteStorageKey) !== text
    )
        throw new Error();
}
function favoriteLocked(w: any): boolean {
    return !!(
        (w.__ottKiosk && w.__ottKiosk.enabled()) ||
        (w.__ottParental
            ? w.__ottParental.needs("providers") ||
              w.__ottParental.needs("settings")
            : (w.sPSprovs || w.sPSoptions) &&
              w.parentPIN !== "*" &&
              !w.parentAccess)
    );
}

/** Installation-wide index; provider journals retain their existing source-owned references. */
export function executeRemoteFavorites(
    w: any,
    runtime: string,
    request: any,
    done: (result: any) => void
): (() => void) | void {
    var params = request.params || {};
    var op = params.op;
    var complete = false;
    var timer: any = null;
    var poll: any = null;
    var inner: any = null;
    var owns = false;
    function finish(error?: string, data?: any): void {
        if (complete) return;
        complete = true;
        w.clearTimeout(timer);
        w.clearTimeout(poll);
        var cancel = inner;
        inner = null;
        if (error && cancel) {
            try {
                cancel();
            } catch (_) {}
        }
        if (owns) favoriteRequestActive = false;
        var value: any = {
            op: op,
            runtime: runtime,
            state: error ? "error" : op === "play" ? "dispatched" : "ready",
            version: 1,
        };
        if (error) value.error = error;
        else
            Object.keys(data || {}).forEach(function (key) {
                value[key] = data[key];
            });
        done({ data: value, status: error ? "rejected" : "ok" });
    }
    function stop(): void {
        if (complete) return;
        finish("cancelled");
    }
    var keys = Object.keys(params).sort().join(",");
    if (
        params.runtime !== runtime ||
        (request.expires_at !== undefined &&
            (typeof request.expires_at !== "number" ||
                !isFinite(request.expires_at))) ||
        remoteFavoritesCapability.operations.indexOf(op) < 0 ||
        (op === "list" && keys !== "op,runtime") ||
        (op === "add" && keys !== "op,runtime" && keys !== "name,op,runtime") ||
        (op === "add" &&
            params.name !== undefined &&
            !favoriteText(params.name, 160)) ||
        ((op === "play" || op === "remove") &&
            !(
                (keys === "id,op,runtime" &&
                    typeof params.id === "string" &&
                    /^fav-[a-z0-9-]{1,60}$/.test(params.id)) ||
                (keys === "op,query,runtime" && favoriteText(params.query, 160))
            ))
    ) {
        finish("invalid_request");
        return;
    }
    if (favoriteRequestActive) {
        finish("busy");
        return;
    }
    favoriteRequestActive = owns = true;
    var entries: any[];
    try {
        entries = favoriteRead(w);
    } catch (_) {
        finish("storage_unavailable");
        return;
    }
    if (op === "list") {
        finish(undefined, { entries: entries.map(favoritePublic) });
        return;
    }
    if (favoriteLocked(w) || w.sFavorites === -1) {
        finish("policy_denied");
        return;
    }
    var selected: any;
    if (op !== "add") {
        var query = params.query && caselessKey(params.query.trim());
        var matches = entries.filter(function (row) {
            return params.id
                ? row.id === params.id
                : caselessKey(row.name) === query;
        });
        if (!matches.length && query)
            matches = entries.filter(function (row) {
                return caselessKey(row.name).indexOf(query) >= 0;
            });
        if (matches.length !== 1) {
            finish(
                matches.length ? "ambiguous_favorite" : "favorite_not_found"
            );
            return;
        }
        selected = matches[0];
        if (op === "remove") {
            try {
                favoriteWrite(
                    w,
                    entries.filter(function (row) {
                        return row.id !== selected.id;
                    })
                );
                finish(undefined, {
                    entry: favoritePublic(selected),
                    removed: true,
                });
            } catch (_) {
                finish("storage_unavailable");
            }
            return;
        }
    }
    var profile: any;
    var source: string;
    var load: any;
    try {
        profile = favoriteProfile(w);
        source = w.__ottSourceIdentity.current(w);
        load = w.__ottCommandChannelLoad;
    } catch (_) {
        profile = null;
        source = "";
        load = w.__ottCommandChannelLoad;
    }
    if (op === "add" && (!profile || w.commandChannelsReady !== true)) {
        finish("profile_unavailable");
        return;
    }
    function sourceCurrent(): boolean {
        var next = favoriteProfile(w);
        return (
            !complete &&
            !favoriteLocked(w) &&
            w.commandChannelsReady === true &&
            w.__ottCommandChannelLoad === load &&
            source === w.__ottSourceIdentity.current(w) &&
            next &&
            next.provider === profile.provider &&
            next.profile_number === profile.profile_number
        );
    }
    if (op === "add") {
        try {
            var state =
                w.__ottClassicPlayback && w.__ottClassicPlayback.snapshot();
            if (
                !state ||
                !state.target ||
                state.phase === "idle" ||
                state.phase === "stopped"
            ) {
                finish("no_current_item");
                return;
            }
            var target = state.target;
            var entry: any = Object.assign({}, profile, { source: source });
            if (target.kind === "live") {
                if (target.sourceId !== source) {
                    finish("context_changed");
                    return;
                }
                var codec = w.__ottChannelReferences.create(
                    w.channels,
                    w.__ottLegacyChannelAliases
                );
                var ref = /^-?\d+$/.test(String(target.channelId))
                    ? codec.resolve(target.channelId, "canonical")
                    : { itemId: target.channelId };
                var id = codec.project(ref);
                if (id === null) {
                    finish("item_unavailable");
                    return;
                }
                if (!favoriteText(w.channels[id].itemId, 8192)) {
                    finish("unsupported_item");
                    return;
                }
                if (
                    typeof w.hasParentalLock === "function" &&
                    w.hasParentalLock(id) &&
                    (w.__ottParental
                        ? w.__ottParental.needs("channels")
                        : w.sPSchannels &&
                          w.parentPIN !== "*" &&
                          !w.parentAccess)
                ) {
                    finish("policy_denied");
                    return;
                }
                entry.kind = "live";
                entry.ref = ref;
                entry.title = favoriteLabel(
                    w.channels[id].channel_name || "Channel",
                    512
                );
                if (
                    typeof w.addToFavorites !== "function" ||
                    typeof w.saveChannelsCats !== "function" ||
                    typeof w.providerGetPersistedItem !== "function"
                ) {
                    finish("unsupported");
                    return;
                }
                w.addToFavorites(id);
                w.saveChannelsCats();
                var libraryKey = "favoritesLibrary:" + source;
                if (
                    !w.providerGetItem(libraryKey) ||
                    w.providerGetPersistedItem(libraryKey) !==
                        w.providerGetItem(libraryKey)
                ) {
                    finish("storage_unavailable");
                    return;
                }
            } else if (target.kind === "vod") {
                var playing = w.__ottMedia && w.__ottMedia.current();
                if (
                    !playing ||
                    playing.ref.sourceId !== target.sourceId ||
                    playing.ref.itemId !== target.channelId
                ) {
                    finish("no_current_item");
                    return;
                }
                if (
                    Number(playing.payload.adult) === 1 &&
                    (w.__ottParental
                        ? w.__ottParental.needs("channels")
                        : w.sPSchannels &&
                          w.parentPIN !== "*" &&
                          !w.parentAccess)
                ) {
                    finish("policy_denied");
                    return;
                }
                if (
                    /^catalog:/.test(playing.ref.itemId) ||
                    (!playing.payload.request &&
                        !playing.payload.__ottMediaOrigin)
                ) {
                    finish("unsupported_item");
                    return;
                }
                if (typeof w.__ottMedia.captureFavorite !== "function") {
                    finish("unsupported");
                    return;
                }
                var plex = playing.payload.plexSource;
                if (plex) {
                    var match =
                        playing.payload.request &&
                        /^\/library\/metadata\/([1-9][0-9]{0,19})$/.exec(
                            playing.payload.request.path
                        );
                    if (
                        !match ||
                        !w.__ottPlex ||
                        w.__ottPlex.configuredSource(
                            w,
                            w.stbGetItem("plexcfg")
                        ) !== target.sourceId
                    ) {
                        finish("profile_changed");
                        return;
                    }
                    entry.plex_id = match[1];
                } else if (
                    playing.context ||
                    target.sourceId !== w.__ottSourceIdentity.media(w)
                ) {
                    finish("unsupported_item");
                    return;
                }
                var media =
                    w.__ottMedia.captureFavorite &&
                    w.__ottMedia.captureFavorite();
                if (!media) {
                    finish("storage_unavailable");
                    return;
                }
                entry.kind = "vod";
                entry.ref = media.ref;
                entry.title = favoriteLabel(media.title, 512) || "Media";
            } else {
                finish("unsupported_item");
                return;
            }
            if (
                !sourceCurrent() ||
                w.__ottClassicPlayback.snapshot().generation !==
                    state.generation
            ) {
                finish("context_changed");
                return;
            }
            var existing = entries.filter(function (row) {
                return (
                    row.provider === entry.provider &&
                    row.profile_number === entry.profile_number &&
                    row.source === entry.source &&
                    row.kind === entry.kind &&
                    JSON.stringify(row.ref) === JSON.stringify(entry.ref)
                );
            })[0];
            if (!existing && entries.length >= 100) {
                finish("too_many_favorites");
                return;
            }
            entry.id = existing
                ? existing.id
                : "fav-" +
                  Date.now().toString(36) +
                  "-" +
                  (++favoriteSequence).toString(36) +
                  "-" +
                  Math.random().toString(36).slice(2, 10);
            entry.name =
                params.name !== undefined
                    ? params.name.trim()
                    : existing
                      ? existing.name
                      : favoriteLabel(entry.title, 160) || "Favorite";
            if (!favoriteValid(entry)) {
                finish("unsupported_item");
                return;
            }
            if (existing) entries[entries.indexOf(existing)] = entry;
            else entries.push(entry);
            favoriteWrite(w, entries);
            if (!sourceCurrent()) {
                finish("context_changed");
                return;
            }
            finish(undefined, {
                created: !existing,
                entry: favoritePublic(entry),
            });
        } catch (_) {
            finish("storage_unavailable");
        }
        return;
    }
    var deadline = Math.min(
        Date.now() + 35000,
        typeof request.expires_at === "number"
            ? request.expires_at * 1000
            : Infinity
    );
    if (deadline <= Date.now()) {
        finish("timeout");
        return;
    }
    timer = w.setTimeout(
        function () {
            finish("timeout");
        },
        Math.max(1, deadline - Date.now())
    );
    var expectedDriver = w.__ottActiveProviderDriver;
    var stage = "provider";
    var previousDriver = expectedDriver;
    var switched = !profile || profile.provider !== selected.provider;
    var changedProfile = false;
    function schedule(): void {
        if (!complete) poll = w.setTimeout(advance, 50);
    }
    function fail(error: string): void {
        finish(error);
    }
    function advance(): void {
        if (complete) return;
        if (Date.now() >= deadline) {
            fail("timeout");
            return;
        }
        if (favoriteLocked(w)) {
            fail("policy_denied");
            return;
        }
        try {
            var driver = w.__ottActiveProviderDriver;
            if (stage === "provider") {
                if (!driver || (switched && driver === previousDriver)) {
                    schedule();
                    return;
                }
                if (driver.id !== selected.provider) {
                    fail("context_changed");
                    return;
                }
                expectedDriver = driver;
                var at = favoriteProfile(w);
                if (!at) {
                    fail("profile_unavailable");
                    return;
                }
                changedProfile = at.profile_number !== selected.profile_number;
                if (changedProfile) {
                    if (
                        selected.profile_number === null ||
                        (driver.fixedSlot &&
                            driver.fixedSlot() >= 0 &&
                            driver.fixedSlot() !== selected.profile_number - 1)
                    ) {
                        fail("policy_denied");
                        return;
                    }
                    if (driver.id === "m3u" || driver.id === "vportal") {
                        var result: any;
                        handleRemoteProfiles(
                            {
                                action: "profile",
                                params: { number: selected.profile_number },
                            },
                            function (value) {
                                result = value;
                            }
                        );
                        if (!result || result.status !== "ok") {
                            fail("profile_unavailable");
                            return;
                        }
                    } else if (
                        driver.id === "stalker" &&
                        driver.configuration &&
                        driver.saveConfiguration &&
                        typeof w.loadChannels === "function"
                    ) {
                        var config = driver.configuration();
                        var before = JSON.stringify(config);
                        config.active = selected.profile_number - 1;
                        var slot =
                            config.portals && config.portals[config.active];
                        if (
                            !slot ||
                            !slot.portal ||
                            !checkProviderUrl(slot.portal)
                        ) {
                            fail("profile_unavailable");
                            return;
                        }
                        if (
                            w.__ottActiveProviderDriver !== driver ||
                            JSON.stringify(driver.configuration()) !== before ||
                            favoriteLocked(w)
                        ) {
                            fail("context_changed");
                            return;
                        }
                        if (
                            driver.saveConfiguration(config) !== true ||
                            w.__ottActiveProviderDriver !== driver ||
                            JSON.stringify(driver.configuration()) !==
                                JSON.stringify(config)
                        ) {
                            fail("profile_unavailable");
                            return;
                        }
                        w.loadChannels();
                    } else {
                        fail("profile_unavailable");
                        return;
                    }
                }
                load = w.__ottCommandChannelLoad;
                stage = "ready";
            }
            if (
                w.__ottActiveProviderDriver !== expectedDriver ||
                w.__ottCommandChannelLoad !== load
            ) {
                fail("context_changed");
                return;
            }
            if (w.commandChannelsReady !== true) {
                schedule();
                return;
            }
            var now = favoriteProfile(w);
            if (
                !now ||
                now.provider !== selected.provider ||
                now.profile_number !== selected.profile_number ||
                w.__ottSourceIdentity.current(w) !== selected.source
            ) {
                fail("profile_changed");
                return;
            }
            profile = now;
            source = selected.source;
            var generation = w.__ottClassicPlayback.snapshot().generation;
            var valid = function (): boolean {
                return (
                    sourceCurrent() &&
                    Date.now() < deadline &&
                    w.__ottClassicPlayback.snapshot().generation === generation
                );
            };
            var dispatched = function (ok: boolean): void {
                if (!ok) {
                    fail("playback_failed");
                    return;
                }
                if (!sourceCurrent()) {
                    fail("context_changed");
                    return;
                }
                w.clearTimeout(w.previewTimer);
                w.previewChan = null;
                if (typeof w.closeList === "function") w.closeList(false);
                if (!sourceCurrent()) {
                    fail("context_changed");
                    return;
                }
                finish(undefined, {
                    dispatched: true,
                    entry: favoritePublic(selected),
                });
            };
            stage = "playing";
            if (selected.kind === "live") {
                var codec = w.__ottChannelReferences.create(
                    w.channels,
                    w.__ottLegacyChannelAliases
                );
                var id = codec.project(selected.ref);
                if (id === null) {
                    fail("item_unavailable");
                    return;
                }
                if (
                    typeof w.hasParentalLock === "function" &&
                    w.hasParentalLock(id) &&
                    w.__ottParental &&
                    w.__ottParental.needs("channels")
                ) {
                    fail("policy_denied");
                    return;
                }
                for (var c = 0; c < (w.catsArray || []).length; c++) {
                    var list = w.cats[w.catsArray[c]] || [];
                    for (var i = 0; i < list.length; i++)
                        if (String(list[i]) === String(id)) {
                            if (
                                !valid() ||
                                typeof w.playChannel !== "function"
                            ) {
                                fail("playback_failed");
                                return;
                            }
                            var admitted = w.playChannel(c, i, true, valid);
                            if (
                                w.channels[id].__ottMediaItem &&
                                expectedDriver.capabilities &&
                                expectedDriver.capabilities.mediaPlaylist
                            ) {
                                // Finite channel media resolves asynchronously.
                                // Match the regular channel command's dispatch
                                // receipt without closing its owned loading UI.
                                if (
                                    admitted === true &&
                                    sourceCurrent() &&
                                    String(
                                        (w.curList || [])[w.primaryIndex]
                                    ) === String(id)
                                )
                                    finish(undefined, {
                                        dispatched: true,
                                        entry: favoritePublic(selected),
                                    });
                                else fail("playback_failed");
                                return;
                            }
                            var after = w.__ottClassicPlayback.snapshot();
                            dispatched(
                                admitted === true &&
                                    after.generation !== generation &&
                                    !!after.target &&
                                    after.target.kind === "live" &&
                                    after.target.sourceId === selected.source &&
                                    (after.target.channelId ===
                                        selected.ref.itemId ||
                                        String(after.target.channelId) ===
                                            String(id))
                            );
                            return;
                        }
                }
                fail("item_unavailable");
            } else if (selected.plex_id) {
                if (
                    w.__ottPlex &&
                    w.__ottPlex.configuredSource(w, w.stbGetItem("plexcfg")) !==
                        selected.ref.sourceId
                ) {
                    fail("profile_changed");
                    return;
                }
                inner = remotePlexQueue(w, runtime).execute(
                    {
                        action: "plex_queue",
                        expires_at: deadline / 1000,
                        favorite_source: selected.ref.sourceId,
                        params: {
                            ids: [selected.plex_id],
                            op: "play",
                            runtime: runtime,
                        },
                    },
                    function (result: any) {
                        dispatched(
                            result &&
                                result.status === "ok" &&
                                result.data &&
                                result.data.state !== "error"
                        );
                    }
                );
            } else {
                if (
                    w.__ottSourceIdentity.media(w) !== selected.ref.sourceId ||
                    !w.__ottMedia ||
                    !w.__ottMedia.playFavorite
                ) {
                    fail("profile_changed");
                    return;
                }
                if (typeof w.__ottMedia.useSource === "function")
                    w.__ottMedia.useSource(null);
                if (
                    !w.__ottMedia.playFavorite(selected.ref, valid, dispatched)
                ) {
                    fail("item_unavailable");
                    return;
                }
                inner = function () {
                    if (
                        w.__ottMedia &&
                        w.__ottActiveProviderDriver === expectedDriver &&
                        w.__ottCommandChannelLoad === load
                    )
                        w.__ottMedia.cancelAuto();
                };
            }
        } catch (_) {
            fail("playback_failed");
        }
    }
    if (!isProviderAllowed(selected.provider)) {
        finish("policy_denied");
        return;
    }
    if (switched) {
        var index = providerIds.indexOf(selected.provider);
        if (index < 0 || !selectProviderByIndex(index)) {
            finish("profile_unavailable");
            return;
        }
    }
    advance();
    return stop;
}
