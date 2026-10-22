import { createSettingsEditor } from "../settings/editor";
import {
    hasTmdbService,
    metadataCssUrl,
    metadataHtml,
    metadataText,
} from "../utils/helpers";
/**
 * Channel management — data structures, navigation, favorites, parental control.
 */

import { clearPlayTimeInterval, stbIsPlaying } from "../core/index";
import {
    translate as _,
    formatLocaleDateTime,
    formatLocaleNumber,
} from "../localization";
import { preferredTrackIndex } from "../localization/media";
import { settings } from "../settings/index";
import { providerSetItem, storage } from "../storage/index";
import { getThumbnail, time2time } from "../utils/helpers";
import {
    activeFavoritesList,
    addFavoritesList,
    bindFavoritesViewRefresh,
    deleteFavoritesList,
    type FavoritesListsBlob,
    favoritesArray,
    favoritesListLabel,
    favoritesLists,
    getActiveFavoritesListName,
    listFavoritesLists,
    loadFavoritesLists,
    renameFavoritesList,
    saveFavoritesLists,
    setActiveFavoritesList,
    shuffleFavoritesList,
    syncFavoritesArrayFromActive,
} from "./favorites-lists";

export type { FavoritesListsBlob };
export {
    addFavoritesList,
    deleteFavoritesList,
    favoritesArray,
    favoritesLists,
    getActiveFavoritesListName,
    listFavoritesLists,
    renameFavoritesList,
    setActiveFavoritesList,
};

export interface Channel {
    adult?: number;
    category?: { name: string; class: string };
    ch_id: number;
    channel_name: string;
    cmd?: string;
    descr?: string;
    description?: string | (() => string);
    epg?: string | number;
    epg_external?: boolean;
    epg_manual?: boolean;
    epg_src?: string;
    epg_url?: string | number;
    icon?: string;
    logo_30x30?: string;
    name?: string;
    nextpr?: EPGEntry[] | null;
    number?: string;
    outdated?: boolean;
    playlist_url?: string;
    rec?: number;
    search_on?: boolean;
    stream_url?: string | (() => string);
    time?: number;
    time_request?: number;
    time_to?: number;
    title?: string;
    tn?: string;
    url?: string;
    xmltv_url?: string;
    xmltv_urls?: string[];
}

export interface EPGEntry {
    ch_id?: number;
    descr: string;
    icon?: string;
    name: string;
    time: number;
    time_to: number;
}

export interface PreviousChannel {
    c: number;
    ci: number;
    e?: string;
    i: number;
    t?: number;
}

interface PortChannelIdMigration {
    get: (key: string) => string | null;
    ids: Record<string, number | null>;
    record: (previous: number, current: number) => void;
    set: (key: string, value: string) => void;
}

/** Observe only hashes computed while this provider's channel list is loading. */
export function beginPortChannelIdMigration(): PortChannelIdMigration {
    var w = window as any;
    delete w.__ottLegacyChannelAliases;
    var state: PortChannelIdMigration = {
        get: w.providerGetItem,
        ids: {},
        record: function (previous: number, current: number): void {
            if (!Number.isInteger(previous) || !Number.isInteger(current))
                return;
            var key = String(previous);
            var known = state.ids[key];
            state.ids[key] =
                known === undefined || known === current ? current : null;
        },
        set: w.providerSetItem,
    };
    w.__ottRecordPortHash = state.record;
    return state;
}

/** Stop observing a departed provider, leaving its persisted data untouched. */
export function cancelPortChannelIdMigration(): void {
    delete (window as any).__ottRecordPortHash;
    delete (window as any).__ottLegacyChannelAliases;
}

/** Incremental migration: unknown IDs, existing channel IDs and ambiguous mappings stay intact. */
export function finishPortChannelIdMigration(
    state: PortChannelIdMigration
): void {
    var w = window as any;
    if (w.__ottRecordPortHash !== state.record) return;
    cancelPortChannelIdMigration();
    if (
        w.providerGetItem !== state.get ||
        w.providerSetItem !== state.set ||
        typeof state.get !== "function" ||
        typeof state.set !== "function"
    )
        return;
    // Versioned importers consume original records and the observed hash chain.
    // Keep this metadata readable only while the collecting source still owns it.
    var aliases: Record<string, number | null> = Object.create(null);
    Object.keys(state.ids).forEach(function (key) {
        aliases[key] = state.ids[key];
    });
    var identity = function () {
        return w.__ottSourceIdentity
            ? w.__ottSourceIdentity.current(w)
            : String(w.p_pref || "");
    };
    var aliasSource = identity();
    Object.defineProperty(w, "__ottLegacyChannelAliases", {
        configurable: true,
        get: function () {
            return w.providerGetItem === state.get &&
                w.providerSetItem === state.set &&
                aliasSource === identity()
                ? aliases
                : undefined;
        },
    });
    function owns(object: object, key: string): boolean {
        return Object.prototype.hasOwnProperty.call(object, key);
    }
    function migrateId(id: unknown): unknown {
        if (typeof id !== "number" && typeof id !== "string") return id;
        var key = String(id);
        if (!/^\d+$/.test(key) || owns(channels, key)) return id;
        var seen: Record<string, boolean> = {};
        while (!seen[key]) {
            seen[key] = true;
            var target = state.ids[key];
            if (typeof target !== "number") return id;
            if (owns(channels, String(target)))
                return typeof id === "string" ? String(target) : target;
            key = String(target);
        }
        return id;
    }
    function migrateArray(value: unknown): void {
        if (Array.isArray(value))
            value.forEach(function (id, index) {
                value[index] = migrateId(id);
            });
    }
    function migrateField(value: unknown, field: string): void {
        if (value && typeof value === "object" && !Array.isArray(value)) {
            var record = value as Record<string, unknown>;
            if (owns(record, field)) record[field] = migrateId(record[field]);
        }
    }
    var keys = [
        "cats",
        "parentalArray",
        "prevArr",
        "continueWatch",
        "playbackJournal",
        "epgTimers",
        "aAspects",
        "aZooms",
        "aAudios",
        "aSubs",
    ];
    keys.forEach(function (key) {
        try {
            var raw = state.get.call(w, key);
            if (!raw) return;
            var value = JSON.parse(raw);
            var before = JSON.stringify(value);
            if (key === "parentalArray") migrateArray(value);
            else if (key === "prevArr" || key === "epgTimers") {
                if (Array.isArray(value))
                    value.forEach(function (entry) {
                        migrateField(entry, "ci");
                    });
            } else if (key === "continueWatch")
                migrateField(value, "channelId");
            else if (key === "playbackJournal") {
                if (
                    value &&
                    value.version === 2 &&
                    w.__ottClassicPlayback &&
                    w.__ottClassicPlayback.canMigrateJournal()
                ) {
                    if (value.bookmark && value.bookmark.kind !== "vod")
                        migrateField(value.bookmark, "channelId");
                    if (Array.isArray(value.history))
                        value.history.forEach(function (entry: any) {
                            if (entry && entry.kind !== "vod")
                                migrateField(entry, "channelId");
                        });
                }
            } else if (key === "cats") {
                var lists = value;
                if (lists && typeof lists === "object" && !Array.isArray(lists))
                    Object.keys(lists).forEach(function (name) {
                        migrateArray(lists[name]);
                    });
            } else if (
                value &&
                typeof value === "object" &&
                !Array.isArray(value)
            ) {
                Object.keys(value).forEach(function (oldKey) {
                    var newKey = String(migrateId(oldKey));
                    // Preserve an already configured canonical channel instead of overwriting it.
                    if (newKey !== oldKey && !owns(value, newKey)) {
                        value[newKey] = value[oldKey];
                        delete value[oldKey];
                    }
                });
            }
            var migrated = JSON.stringify(value);
            if (migrated === before) return;
            state.set.call(w, key, migrated);
            // These values were read before the provider populated its channel set.
            if (key === "prevArr") {
                prevArr = value;
                w.prevArr = value;
            } else if (key === "aAspects") {
                aAspects = value;
                w.aAspects = value;
            } else if (key === "aZooms") {
                aZooms = value;
                w.aZooms = value;
            } else if (key === "aAudios") {
                aAudios = value;
                w.aAudios = value;
            } else if (key === "aSubs") {
                aSubs = value;
                w.aSubs = value;
            }
        } catch (_) {
            // Keep malformed/unsupported records, and retry failed storage writes next load.
        }
    });
}

/** Edem/VPortal passes request objects instead of playlist URLs. */
export interface MediaPortalTarget {
    a?: string;
    filters?: unknown[];
    items?: unknown[];
    mediaName?: string;
    request?: Record<string, unknown>;
}

/** Public provider ABI: URL, local history/favorites, or a VPortal request. */
export type MediaTarget = string | -1 | -2 | MediaPortalTarget;

/** Legacy callbacks remain callable with no arguments; built-ins can reject stale work earlier. */
interface MediaListCompletion {
    isCurrent?: () => boolean;
    (): void;
}

interface MediaLoadState {
    name: string;
    pending: boolean;
    provider: unknown;
    records: MediaHistoryEntry[];
    urls: MediaTarget[] | null;
}

export interface MediaHistoryEntry {
    adult?: number | string;
    ch_id?: number;
    current?: number;
    descr?: string;
    description?: string | (() => string);
    fav?: number;
    logo_30x30?: string;
    name?: string;
    playlist_name?: string;
    playlist_url?: MediaTarget;
    request?: Record<string, unknown>;
    search_on?: boolean | number | string;
    stream_url?: string | (() => string);
    submenu?: MediaHistoryEntry[];
    title?: string;
    vportalSource?: string;
}

/* ---------------------------------------------------------------------------
 * Module-level state — channels, categories, EPG, settings, UI strings
 * --------------------------------------------------------------------------- */

/** Map of channel ID → Channel object, populated from the provider. */
export let channels: Record<number, Channel> = {};
/** Map of channel ID → array of EPGEntry (program guide data). */
export let epg: Record<number, EPGEntry[]> = {};
/** Map of category name → array of channel IDs in that category. */
export let cats: Record<string, number[]> = {};
/** Ordered list of category names (display order). */
export let catsArray: string[] = [];
/** Channel-ID array for the currently active category. */
export let curList: number[] = [];
/** Provider prefix string (used for storage key scoping). */
export let providerPrefix = "";

/* ---- UI label strings (may contain HTML/icon markup) ---- */
export let strInfo = "INFO";
export let strEPG = "EPG";
export let strSubt = "";
export let strNew = ' <span style="color:red;font-size:60%;">NEW</span>';
export let strUP = '<span class="fontello">&#xe80b;</span>';
export let strDOWN = '<span class="fontello">&#xe80a;</span>';
export let strLEFT = '<span class="fontello">&#xe80c;</span>';
export let strRIGHT = '<span class="fontello">&#xe80d;</span>';
export let strSTOP = '<span class="fontello">&#xe812;</span>';
export let strPLAY = '<span class="fontello">&#xe811;</span>';
export let strPAUSE = '<span class="fontello">&#xe813;</span>';
export let strPlayPause = '<span class="fontello">&#xe811;&#xe813;</span>';
export let strRW = '<span class="fontello">&#xe803;</span>';
export let strFF = '<span class="fontello">&#xe802;</span>';
export let strPREV = '<span class="fontello">&#xe806;</span>';
export let strNEXT = '<span class="fontello">&#xe805;</span>';

/* Compatibility names are accessor views owned by SettingsStore. */
declare var sNoSmall: number;
declare var sStopPlay: number;
declare var sPipSize: number;
declare var sPipPos: number;
declare var sPageSize: number;
declare var sFontShift: number;
declare var sFont: number;
declare var sArrowFun: number;
declare var sRewFun: number;
declare var sPNFun: number;
declare var sRfun: number;
declare var sGfun: number;
declare var sYfun: number;
declare var sBfun: number;
declare var sALfun: number;
declare var sARfun: number;
declare var sAUfun: number;
declare var sADfun: number;
declare var sRWfun: number;
declare var sFFfun: number;
declare var sPREVfun: number;
declare var sNEXTfun: number;
declare var sEfun: number;
declare var sOkfun: number;
declare var s13dur: number;
declare var s46dur: number;
declare var s79dur: number;
declare var sNoColorKeys: number;
declare var sNoNumbersKeys: number;
declare var sTimezone: number;
declare var sSleepTimeout: number;
declare var sEpgRemindMinutes: number;
declare var sVolumeStep: number;
declare var sInfoTimeout: number;
declare var sInfoSlide: number;
declare var sInfoSwitch: number;
declare var sInfoChange: number;
declare var sInfoRew: number;
declare var sThumbnail: number;
declare var sOsdOpacity: number;
declare var sListPos: number;
declare var sEditor: number;
declare var sShowNum: number;
declare var sShowPikon: number;
declare var sShowName: number;
declare var sShowProgress: number;
declare var sShowArchive: number;
declare var sShowScroll: number;
declare var sShowDescr: number;
declare var sShowProgram: number;
declare var sPreview: number;
declare var sNextCountL: number;
declare var sFavorites: number;
declare var sPermanentTime: number;
declare var s10resum: number;
declare var sPrevCount: number;
declare var sMedCount: number;
declare var sPSchannels: number;
declare var sPSoptions: number;
declare var sPSprovs: number;
declare var sHDMIsupport: number;
declare var sAutorun: number;
declare var sPlayers: number;
declare var sBufSize: number;
declare var sGrapI: number;
declare var parentPIN: string;
declare var sHideMenus: string[];
declare var sSHLcolSel: string;
declare var sSHLcolor: string;
declare var sSHLcolorB: string;
declare var commandServerAddress: string;
declare var commandServerToken: string;
declare var sLocalCmdUrl: string;
declare var sLocalHttpEnabled: number;
declare var sLocalHttpDeviceCode: string;
declare var sSwopBaseUrl: string;
declare var sDeviceUuid: string;
declare var commandServerEnabled: number;

/* ---- Per-channel aspect/audio/subtitle/zoom records ---- */
export let aAspects: Record<string, number> = {};
export let aAudios: Record<string, number> = {};
export let aZooms: Record<string, number> = {};
export let aSubs: Record<string, number> = {};

/* ---- Navigation & history state ---- */
export let version = "",
    primaryIndex = 0,
    catIndex = -1;
export let cList: number[] = [],
    prevArr: PreviousChannel[] = [];
export let parentalArray: number[] = [];

/* Multi-favorites lists state + CRUD: src/channels/favorites-lists.ts (Phase D2). */
export let epgTimers: any[] = [],
    sSortAbc = 0;
export let medHistory: MediaHistoryEntry[] = [],
    medFavorites: MediaHistoryEntry[] = [];

/* ---- Playback & EPG state ---- */
export let playType = 0,
    playTime = 0;
export let _prog100: any = null,
    _tmedia: any = null;
export let epgCacheCapacity = 0;

/** Clear full schedules and reject responses from the previous provider/refresh. */
export function invalidateEpgCache(refetchPending = false): void {
    var w = window as any;
    w.__ottClassicGuide.invalidate(refetchPending);
    curEpgData = null;
    if (!refetchPending) epg_ch_id = null;
    else if (w.__ottClassicGuideScreen) w.__ottClassicGuideScreen.refresh();
}

export let epgListMode = 0,
    epgreturn = false,
    listChannel = 0,
    listEpgArray: EPGEntry[] = [],
    epg_ch_id: any = null;

export let curEpgData: EPGEntry[] | null = null;
export let epgArray: EPGEntry[] = [],
    curProg = -1;
export let mediaListArr: MediaHistoryEntry[] = [];
export let mediaUrls: MediaTarget[] | null = null;
export let mediaNames: string[] = [],
    mediaSelects: number[] = [];
export let mediaRecords: MediaHistoryEntry[] = [];
export let mediaRecordsPar: MediaHistoryEntry[] | null = null;
export let mediaName = "";

export let searchInput = "",
    searchTimeout: any = null;
export let archivePos = 0,
    archiveStart = 0,
    archiveEnd = 0;
export let fileArchive = false;

/** Classic view entrypoint; state/history decisions belong to the playback model. */
export function setCurrent(
    categoryIndex: number,
    channelIndex: number,
    isArchive?: boolean
): void {
    (window as any).__ottClassicPlayback.select(
        categoryIndex,
        channelIndex,
        isArchive
    );
}

/**
 * Restore continue-watching bookmark on startup.
 *
 * Reads the scoped playback journal. The same selected local file resumes
 * directly. TV archive bookmarks younger than seven days offer confirmation.
 * On Yes or after 10 seconds: plays archive at the saved position.
 * On No: starts normal live playback.
 *
 * Returns true if local resume started or archive confirmation was offered, false
 * otherwise (no bookmark / stale archive / channel missing / live TV) — the caller
 * should then run the normal `playChannel` path.
 *
 * Must be called after the playlist is populated.
 */
export function restoreContinueWatch(): boolean {
    try {
        var cw: any = (window as any).__ottClassicPlayback.bookmark();
        if (!cw || !cw.v || !cw.mode || cw.channelId == null) return false;
        var ageMs = Date.now() - (cw.updatedAt || 0);
        if (ageMs < -300000) return false;
        var host = window as any;
        if (
            host.__ottActiveProviderDriver?.id === "offline" &&
            (cw.mode === "live" || cw.mode === "vod") &&
            String(cw.channelId) === String(curList[primaryIndex]) &&
            typeof cw.playTime === "number" &&
            isFinite(cw.playTime) &&
            cw.playTime > 0
        ) {
            // Local files retain channel history, but resume their media clock.
            // Never use a prior cursor to replace a profile's selected file.
            return (
                window.playChannel(catIndex, primaryIndex, false, undefined, {
                    channelId: String(cw.channelId),
                    position: cw.playTime,
                    sourceId: host.__ottClassicPlayback.sourceId(),
                }) !== false
            );
        }
        if (ageMs > 7 * 24 * 60 * 60 * 1000) return false;
        // 1) Resume dialog = archive only (positive playType sentinel required).
        // VOD / live → return false so caller does live playback.
        if (
            !(
                cw.mode === "archive" &&
                typeof cw.playType === "number" &&
                cw.playType > 0
            )
        )
            return false;
        // 3) Category-aware channel lookup — track which list won so Yes callback can use it directly.
        var resumeCatIndex: number = -1;
        var resumeIdx: number = -1;
        if (
            cats &&
            catsArray &&
            typeof cw.catIndex === "number" &&
            cats[catsArray[cw.catIndex]]
        ) {
            resumeCatIndex = cw.catIndex;
            resumeIdx = cats[catsArray[cw.catIndex]].indexOf(cw.channelId);
        }
        if (resumeIdx === -1) {
            resumeCatIndex = catIndex;
            resumeIdx = curList.indexOf(cw.channelId);
        }
        if (resumeIdx === -1 && cats && cats[_("All")]) {
            var allIdx = cats[_("All")].indexOf(cw.channelId);
            if (allIdx !== -1) {
                resumeCatIndex = catsArray.indexOf(_("All"));
                resumeIdx = allIdx;
            }
        }
        if (resumeIdx === -1) return false; // channel no longer present
        // A PIN adds another asynchronous step. Keep it tied to the playlist
        // and provider that offered the bookmark, even when IDs are reused.
        var source = {
            categories: catsArray,
            cats: cats,
            channel: channels[cw.channelId],
            channels: channels,
            get: window.providerGetItem,
            list:
                (cats && catsArray && cats[catsArray[resumeCatIndex]]) ||
                curList,
            prefix: (window as any).p_pref,
            set: window.providerSetItem,
        };
        var isCurrent = function (): boolean {
            return (
                catsArray === source.categories &&
                cats === source.cats &&
                channels === source.channels &&
                channels[cw.channelId] === source.channel &&
                ((cats && catsArray && cats[catsArray[resumeCatIndex]]) ||
                    curList) === source.list &&
                window.providerGetItem === source.get &&
                window.providerSetItem === source.set &&
                (window as any).p_pref === source.prefix &&
                source.list.indexOf(cw.channelId) !== -1
            );
        };
        var playback = (window as any).__ottClassicPlayback;
        var generation = playback.snapshot().generation;
        var canRestore = function (): boolean {
            return isCurrent() && playback.snapshot().generation === generation;
        };
        var playLiveFallback = function (): boolean {
            if (!canRestore()) return false;
            try {
                window.playChannel(
                    resumeCatIndex,
                    source.list.indexOf(cw.channelId)
                );
                return true;
            } catch (_e) {
                console.error(_e);
                primaryIndex = 0;
                catIndex = sFavorites ? 1 : 0;
                try {
                    window.playChannel(catIndex, primaryIndex);
                } catch (e2) {
                    console.error(e2);
                }
                return false;
            }
        };
        var playSavedArchive = function (): void {
            if (!canRestore()) return;
            if (ifParentalAccessChId(cw.channelId, playSavedArchive)) return;
            // Avoid setCurrent: it would overwrite the archive bookmark with live mode.
            catIndex = resumeCatIndex;
            curList = source.list;
            primaryIndex = curList.indexOf(cw.channelId);
            window.catIndex = catIndex;
            window.curList = curList;
            window.primaryIndex = primaryIndex;
            if (typeof window.playArchive === "function") {
                window.playArchive(cw.playType);
                if (typeof cw.playTime === "number") {
                    setTimeout(
                        (window as any).__ottClassicPlayback.guard(function () {
                            if (
                                isCurrent() &&
                                curList === source.list &&
                                curList[primaryIndex] === cw.channelId &&
                                window.playType === Math.floor(cw.playType)
                            )
                                window.stbSetPosTime(cw.playTime);
                        }),
                        500
                    );
                }
            } else {
                playLiveFallback();
            }
        };

        if (typeof window.confirmBox === "function") {
            var restore = playback.guard(function (accept: boolean) {
                if (accept) playSavedArchive();
                else playLiveFallback();
            });
            window.confirmBox(
                _("Resume from archive?") +
                    "<br><br>" +
                    _(
                        "Bookmark age (days): %1",
                        formatLocaleNumber(
                            Math.max(0, Math.floor(ageMs / 86400000))
                        )
                    ),
                function () {
                    restore(true);
                },
                function () {
                    restore(false);
                },
                10000
            );
        } else {
            // No confirmBox available — skip archive, let caller play live.
            return false;
        }
        return true;
    } catch (_e) {
        // never block startup on bookmark restore
        return false;
    }
}

/**
 * Move to the next channel in the current category (wraps around to index 0).
 *
 * Side effects: Calls `window.playChannel` which triggers playback switch.
 */
export function nextChannel(): void {
    var nextIndex = (window as any).OttPlayCore.playbackChannelIndex(
        primaryIndex,
        curList.length,
        1,
        "classic"
    );
    if (typeof window.playChannel === "function")
        window.playChannel(catIndex, nextIndex);
}

/**
 * Move to the previous channel in the current category (wraps to the end).
 *
 * Side effects: Calls `window.playChannel` which triggers playback switch.
 */
export function prevChannel(): void {
    var prevIndex = (window as any).OttPlayCore.playbackChannelIndex(
        primaryIndex,
        curList.length,
        -1,
        "classic"
    );
    if (typeof window.playChannel === "function")
        window.playChannel(catIndex, prevIndex);
}

/**
 * Delegate a numeric key press to the global `numberProg` handler for channel-number input.
 *
 * @param digit - The pressed digit (0-9).
 *
 * Side effects: Calls `window.numberProg(digit)` if defined.
 */
export function handleNumberInput(digit: number): void {
    if (typeof window.numberProg === "function") window.numberProg(digit);
}

/**
 * Resolve a playable URL string from a Channel object or channel ID.
 * Checks `url`, then `cmd`, then `stream_url` in order.
 *
 * @param channelOrId - A Channel object or numeric channel ID.
 * @returns The resolved stream URL, or empty string if the channel is not found or has no URL.
 */
export function getChannelUrl(channelOrId: Channel | number): string {
    var ch: Channel;
    if (typeof channelOrId === "number") {
        ch = channels[channelOrId];
    } else {
        ch = channelOrId;
    }
    if (!ch) return "";
    return ch.url || ch.cmd || (ch.stream_url as string) || "";
}

/**
 * Add a channel ID to the favorites list if not already present.
 *
 * Side effects: Mutates `favoritesArray` in-memory (does NOT persist — call saveChannelsCats).
 */
export function addToFavorites(channelId: number): void {
    var lst = activeFavoritesList();
    (window as any).OttPlayCore.editFavoriteSelection(lst, channelId, "add");
    syncFavoritesArrayFromActive();
}

/**
 * Remove a channel ID from the favorites list if present.
 *
 * Side effects: Mutates `favoritesArray` in-memory (does NOT persist).
 */
export function removeFromFavorites(channelId: number): void {
    var lst = activeFavoritesList();
    (window as any).OttPlayCore.editFavoriteSelection(lst, channelId, "remove");
    syncFavoritesArrayFromActive();
}

/* ---- Multi-favorites lists CRUD: ./favorites-lists.ts ---- */

/**
 * If the user is currently viewing the Favorites category, rebind module
 * `curList` / `window.curList` to the freshly-synced `cats["Favorites"]`
 * array, clamp indices, and update `window.activeFavList`.
 * Called after every mutation that changes the active list content.
 */
function refreshFavoritesViewIfActive(): void {
    if (typeof window === "undefined") return;
    var w = window as any;
    if (!w._ || !catsArray || !cats) return;
    var favLabel = w._("Favorites");
    var ci = catsArray.indexOf(favLabel);
    if (ci === -1) return;
    if (w.catIndex !== ci) return;
    curList = cats[favLabel] || [];
    w.curList = curList;
    if (primaryIndex >= curList.length)
        primaryIndex = Math.max(0, curList.length - 1);
    if (primaryIndex < 0) primaryIndex = 0;
    w.primaryIndex = primaryIndex;
    if (typeof w.selIndex === "number" && w.selIndex >= curList.length) {
        w.selIndex = primaryIndex;
    }
    w.activeFavList = getActiveFavoritesListName();
}

bindFavoritesViewRefresh(refreshFavoritesViewIfActive);

/**
 * Multi-favorites list manager UI (proper #list menu, not showSelectBox OSD).
 * Pick a list to switch immediately; last row opens add/rename/delete.
 * Calls saveChannelsCats() after every mutation.
 */
export function popFavLists(): void {
    var w = window as any;
    var keys = w.keys;

    // Kill any leftover showSelectBox OSD from older builds.
    try {
        var numEl = document.getElementById("numprog");
        if (numEl) numEl.style.display = "none";
        w.selectBoxKeyHandler = null;
    } catch (_) {}

    function switchTo(listName: string): void {
        setActiveFavoritesList(listName);
        saveChannelsCats();
        refreshFavoritesViewIfActive();
        w.showShift(
            (w._ ? w._("Active list") : "Active list") +
                ": " +
                favoritesListLabel(listName)
        );
    }

    function addNewList(): void {
        w.editCaption = w._ ? w._("New list name") : "New list name";
        w.editvar = "";
        w.setEdit = function () {
            var name = (w.editvar || "").trim();
            if (name && addFavoritesList(name)) {
                switchTo(name);
                w.showShift(w._ ? w._("List created") : "List created");
                showMain();
            }
            w.setEdit = function () {};
        };
        if (typeof w.showEditKey === "function") {
            w.showEditKey(w.keys.ENTER);
        }
    }

    function showEditActions(listName: string): void {
        var names = listFavoritesLists();
        var canDelete = names.length > 1;
        var rows: string[] = [];
        rows.push(w._ ? w._("Rename") : "Rename");
        if (canDelete) rows.push(w._ ? w._("Delete") : "Delete");
        rows.push(w._ ? w._("Cancel") : "Cancel");

        w.selIndex = 0;
        w.listArray = rows;
        w.listDataArray = rows;
        w.getListItemFn = function (item: string): string {
            return "&nbsp;&nbsp;" + metadataText(item);
        };
        w.detailListActionFn = function () {};
        w.listKeyHandlerFn = function (key: number): boolean {
            if (!keys) return false;
            switch (key) {
                case keys.RETURN:
                    showManage();
                    return true;
                case keys.ENTER: {
                    var idx = w.selIndex | 0;
                    if (idx === 0) {
                        w.editCaption =
                            (w._ ? w._("Rename to") : "Rename to") +
                            ": " +
                            favoritesListLabel(listName);
                        w.editvar = favoritesListLabel(listName);
                        w.setEdit = function () {
                            var newName = (w.editvar || "").trim();
                            if (
                                newName &&
                                newName !== favoritesListLabel(listName) &&
                                renameFavoritesList(listName, newName)
                            ) {
                                switchTo(newName);
                                w.showShift(
                                    w._ ? w._("List renamed") : "List renamed"
                                );
                                showMain();
                            }
                            w.setEdit = function () {};
                        };
                        if (typeof w.showEditKey === "function") {
                            w.showEditKey(w.keys.ENTER);
                        }
                    } else if (idx === 1 && canDelete) {
                        w.confirmBox(
                            (w._ ? w._("Delete list") : "Delete list") +
                                ": " +
                                favoritesListLabel(listName) +
                                "?",
                            function () {
                                deleteFavoritesList(listName);
                                saveChannelsCats();
                                refreshFavoritesViewIfActive();
                                w.showShift(
                                    w._ ? w._("List deleted") : "List deleted"
                                );
                                showMain();
                            }
                        );
                    } else {
                        showManage();
                    }
                    return true;
                }
            }
            return false;
        };
        var cap = document.getElementById("listCaption");
        if (cap)
            cap.textContent =
                (w._ ? w._("Favorite lists") : "Favorite lists") +
                ": " +
                favoritesListLabel(listName);
        var footerElement = document.getElementById("listPodval");
        if (footerElement && typeof w.renderButtonHint === "function") {
            footerElement.innerHTML = w.renderButtonHint(
                keys.RETURN,
                w.strRETURN,
                "Close"
            );
        }
        try {
            if (typeof $ !== "undefined") $("#listPopUp").hide();
        } catch (_) {}
        if (typeof w.showPage === "function") w.showPage();
    }

    function showManage(): void {
        var names = listFavoritesLists();
        var activeName = getActiveFavoritesListName();
        var rows = names.map(function (n: string) {
            return n === activeName
                ? "\u2713 " +
                      favoritesListLabel(n) +
                      (w._ ? " (" + w._("current") + ")" : " (current)")
                : favoritesListLabel(n);
        });
        rows.push(w._ ? w._("Add new list") : "Add new list");

        w.selIndex = Math.max(0, names.indexOf(activeName));
        w.listArray = rows;
        w.listDataArray = rows;
        w.getListItemFn = function (item: string): string {
            return "&nbsp;&nbsp;" + metadataText(item);
        };
        w.detailListActionFn = function () {};
        w.listKeyHandlerFn = function (key: number): boolean {
            if (!keys) return false;
            switch (key) {
                case keys.RETURN:
                    showMain();
                    return true;
                case keys.ENTER: {
                    var idx = w.selIndex | 0;
                    if (idx === names.length) {
                        addNewList();
                    } else if (idx >= 0 && idx < names.length) {
                        showEditActions(names[idx]);
                    }
                    return true;
                }
            }
            return false;
        };
        var cap = document.getElementById("listCaption");
        if (cap)
            cap.innerHTML = w._
                ? w._("Add / rename / delete\u2026")
                : "Add / rename / delete\u2026";
        var footerElement = document.getElementById("listPodval");
        if (footerElement && typeof w.renderButtonHint === "function") {
            footerElement.innerHTML = w.renderButtonHint(
                keys.RETURN,
                w.strRETURN,
                "Close"
            );
        }
        try {
            if (typeof $ !== "undefined") $("#listPopUp").hide();
        } catch (_) {}
        if (typeof w.showPage === "function") w.showPage();
    }

    function showMain(): void {
        var names = listFavoritesLists();
        var activeName = getActiveFavoritesListName();
        var rows = names.map(function (n: string) {
            return (n === activeName ? "\u2713 " : "") + favoritesListLabel(n);
        });
        rows.push(
            w._
                ? w._("Add / rename / delete\u2026")
                : "Add / rename / delete\u2026"
        );

        w.selIndex = Math.max(0, names.indexOf(activeName));
        w.listArray = rows;
        w.listDataArray = rows;
        w.getListItemFn = function (item: string): string {
            return "&nbsp;&nbsp;" + metadataText(item);
        };
        w.detailListActionFn = function () {};
        w.listKeyHandlerFn = function (key: number): boolean {
            if (!keys) return false;
            switch (key) {
                case keys.RETURN:
                    if (typeof w.popupList === "function") w.popupList();
                    else if (typeof w.closeList === "function") w.closeList();
                    return true;
                case keys.ENTER: {
                    var idx = w.selIndex | 0;
                    if (idx === names.length) {
                        showManage();
                    } else if (idx >= 0 && idx < names.length) {
                        switchTo(names[idx]);
                        showMain();
                    }
                    return true;
                }
            }
            return false;
        };
        var cap = document.getElementById("listCaption");
        if (cap) cap.innerHTML = w._ ? w._("Favorite lists") : "Favorite lists";
        var footerElement = document.getElementById("listPodval");
        if (footerElement && typeof w.renderButtonHint === "function") {
            footerElement.innerHTML =
                w.renderButtonHint(keys.RETURN, w.strRETURN, "Close") +
                w.renderButtonHint(
                    keys.ENTER,
                    "Ok",
                    w._ ? w._("Switch") : "Switch"
                );
        }
        try {
            if (typeof $ !== "undefined") $("#listPopUp").hide();
        } catch (_) {}
        if (typeof w.showPage === "function") w.showPage();
    }

    showMain();
}

/**
 * Persist the active favorites lists and refresh the channel-library projection.
 * Channel/group/parental edits persist through their own library operations;
 * this retained compatibility hook does not serialize the projected arrays.
 *
 * Side effects: Writes favorites storage and republishes the current library view.
 */
export function saveChannelsCats(): void {
    if (typeof providerSetItem === "function") {
        // `favoritesArray` mirrors the active list (back-compat alias).
        syncFavoritesArrayFromActive();
        saveFavoritesLists();
        (window as any).__ottChannels.refresh();
    }
}

/**
 * Check whether a channel has an active parental lock.
 *
 * @param channelId - The channel ID to check.
 * @returns `true` if the channel ID is in the `parentalArray`.
 */
export function hasParentalLock(channelId: number): boolean {
    return parentalArray.indexOf(channelId) !== -1;
}

/**
 * Guard function: if parental control is enabled and not yet authorised,
 * prompt the user to enter their PIN before proceeding.
 *
 * @param callback - Function to execute once access is granted.
 * @returns `true` if a PIN prompt was shown (access was blocked), `false` if access is free.
 *
 * Side effects: May call `window.enterPinAndSetAccess`, which shows a PIN dialog.
 */
export function ifParentalAccess(callback: () => void): boolean {
    return (window as any).__ottParental.require("channels", callback);
}

/**
 * Guard function combining `hasParentalLock` and `ifParentalAccess`.
 * Only shows the PIN prompt if the specific channel is locked.
 *
 * @param channelId - The channel to test for parental lock.
 * @param callback  - Function to execute once access is granted.
 * @returns `true` if a PIN prompt was shown, `false` otherwise.
 */
export function ifParentalAccessChId(
    channelId: number,
    callback: () => void
): boolean {
    if (hasParentalLock(channelId))
        return ifParentalAccess(
            (window as any).__ottParental.guard(channelId, callback)
        );
    return false;
}

/**
 * Timezone hours for Mode B get_epg. NEVER use channel.rec — that is archive
 * depth (M3U rechours / catchup-days), not timezone. Pass 0 so Rust applies
 * time_shift_by_epg from match_channels; tvg-shift (ch.ts, seconds) is applied
 * client-side after fetch like Mode A m3u getChannelEpg.
 */
export function epgTimezoneHours(_ch: any): number {
    return 0;
}

/** Configured catchup/history hours from channel.rec (M3U settings / tags). */
export function epgArchiveHours(ch: any): number {
    if (!ch || ch.rec == null) return 0;
    var n = Number(ch.rec);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Apply tvg-shift (ch.ts seconds) to EPG entries in-place — Mode A parity. */
export function applyChannelTvgShift(
    ch: any,
    rows: EPGEntry[] | null
): EPGEntry[] | null {
    var shift = Number(ch && ch.ts) || 0;
    if (!Array.isArray(rows)) return null;
    return rows.map(function (row) {
        return {
            ...row,
            time: Number(row.time) + shift,
            time_to: Number(row.time_to) + shift,
        };
    });
}

/** Only the built-in M3U companion uses native XMLTV. Other providers own EPG. */
export function usesNativeXmltv(ch: Channel | undefined): boolean {
    var w = window as any;
    return (
        !!(w.Capacitor || w.__TAURI__) &&
        w.p_pref === "m3u" &&
        !!ch &&
        !ch.epg_external &&
        (!ch.epg_src || ch.epg_src === "local")
    );
}

/** Preserve playlist source order and schemes, never interpret a companion hash as a URL. */
export function channelXmltvUrls(ch: Channel | undefined): string[] {
    var sources =
        ch && ch.xmltv_urls && ch.xmltv_urls.length
            ? ch.xmltv_urls
            : ch && ch.xmltv_url
              ? [ch.xmltv_url]
              : [];
    return sources.filter(function (source, index) {
        return (
            typeof source === "string" &&
            /^https?:\/\//i.test(source) &&
            sources.indexOf(source) === index
        );
    });
}

/** Provider/native transport port. Ownership and caching live in GuideService. */
export function fetchChannelGuide(
    channelId: number,
    callback: (id: number, rows: EPGEntry[] | null) => void
): () => void {
    var admission = (window as any).__ottStandby;
    var generation = admission ? admission.generation() : 0;
    if (admission && admission.blocked()) {
        callback(channelId, null);
        return function () {};
    }
    var active = true,
        cancel: any = null;
    function finish(id: number, rows: EPGEntry[] | null): void {
        if (!active || (admission && !admission.current(generation))) return;
        active = false;
        callback(id, rows);
    }
    function dispatch(): void {
        try {
            // Mode B (Capacitor mobile): use native XMLTV EPG plugin.
            if (
                typeof (window as any).Capacitor !== "undefined" &&
                usesNativeXmltv(channels[channelId])
            ) {
                var ch = channels[channelId];
                // Native XMLTV resolves raw tvg-id/name; epg_url is a companion hash.
                var hash = ch && ch.epg != null ? String(ch.epg) : "";
                var timeShiftHours = epgTimezoneHours(ch);
                var archiveHours = epgArchiveHours(ch);
                var xmltvUrls = channelXmltvUrls(ch);
                (window as any).Capacitor.Plugins.MobileXmltvEpg.getEpg({
                    archive_hours: archiveHours,
                    ch: ch?.epg_manual
                        ? ""
                        : ch?.channel_name || ch?.name || "",
                    channel_id: String(channelId),
                    hash: hash,
                    time_shift_hours: timeShiftHours,
                    tvg_name: (ch && ch.tn) || "",
                    xmltv_url: xmltvUrls[0] || "",
                    xmltv_urls: xmltvUrls,
                })
                    .then(function (result: any) {
                        // Accept both raw EPG array and {epg_data: [...]} (same as Tauri).
                        var epgData = Array.isArray(result)
                            ? result
                            : result && Array.isArray(result.epg_data)
                              ? result.epg_data
                              : null;
                        epgData = applyChannelTvgShift(ch, epgData);
                        // Never cache [] — empty is truthy in JS and would permanently
                        // skip re-fetch after a cold-XMLTV miss (Mode B warm race).
                        if (epgData && epgData.length > 0) {
                            finish(channelId, epgData);
                        } else {
                            finish(channelId, null);
                        }
                    })
                    .catch(function (_err: any) {
                        finish(channelId, null);
                    });
                return;
            }
            // Mode B (Tauri desktop): in-process Rust EPG via invoke() (not HTTP).
            // Pass playlist channel name + epg_url hash so resolve_xmltv_id can match
            // (numeric channelId alone almost never equals an XMLTV id).
            if (
                typeof (window as any).__TAURI__ !== "undefined" &&
                usesNativeXmltv(channels[channelId])
            ) {
                var ch = channels[channelId];
                var channelName =
                    ch && ch.epg_manual
                        ? ""
                        : (ch && (ch.channel_name || ch.name)) || "";
                var hash =
                    ch && (ch as any).epg_url != null
                        ? String((ch as any).epg_url)
                        : "";
                var timeShiftHours = epgTimezoneHours(ch);
                var archiveHours = epgArchiveHours(ch);
                var coreApi = (window as any).__TAURI__.core;
                var invokeFn =
                    coreApi && typeof coreApi.invoke === "function"
                        ? function (cmd: string, args: any) {
                              return coreApi.invoke(cmd, args);
                          }
                        : typeof (window as any).__TAURI__.invoke === "function"
                          ? function (cmd: string, args: any) {
                                return (window as any).__TAURI__.invoke(
                                    cmd,
                                    args
                                );
                            }
                          : null;
                if (!invokeFn) {
                    finish(channelId, null);
                    return;
                }
                // Tauri 2 command args are camelCase (channel_id → channelId).
                // timeShiftHours = timezone only (0 → Rust uses time_shift_by_epg).
                // archiveHours = configured catchup/history depth (channel.rec).
                invokeFn("get_epg", {
                    archiveHours: archiveHours,
                    ch: channelName,
                    channelId: String(channelId),
                    hash: hash,
                    timeShiftHours: timeShiftHours,
                    tvgId: ch && ch.epg != null ? String(ch.epg) : "",
                    tvgName: (ch && ch.tn) || "",
                    xmltvUrls: channelXmltvUrls(ch),
                })
                    .then(function (result: any) {
                        // Accept both raw EPG array and {epg_data: [...]} wrapper.
                        var epgData = Array.isArray(result)
                            ? result
                            : result && Array.isArray(result.epg_data)
                              ? result.epg_data
                              : null;
                        epgData = applyChannelTvgShift(ch, epgData);
                        // Never cache [] — see Capacitor branch (cold XMLTV miss).
                        if (epgData && epgData.length > 0) {
                            finish(channelId, epgData);
                        } else {
                            finish(channelId, null);
                        }
                    })
                    .catch(function (_err: any) {
                        finish(channelId, null);
                    });
                return;
            }
            // Fall through to provider fetch (Mode A / browser / STB)
            var w = window as any;
            if (typeof w.getChannelEpg === "function") {
                var result = w.getChannelEpg(channelId, finish);
                if (typeof result === "function") cancel = result;
            } else {
                finish(channelId, null);
            }
        } catch (_err) {
            finish(channelId, null);
        }
    }
    dispatch();
    return function () {
        active = false;
        if (cancel) {
            var stop = cancel;
            cancel = null;
            stop();
        }
    };
}
/**
 * Request a detached full schedule from the owned guide service.
 * A cache hit may call back synchronously; a miss joins the serial request queue.
 * Returns cancellation for this consumer, not a cached schedule. Capacity zero
 * disables retention but still permits provider/native requests and projections.
 */
export function getChannelEpgCached(
    channelId: number,
    callback: (id: number, rows: EPGEntry[] | null) => void
): () => void {
    return (window as any).__ottClassicGuide.request(channelId, callback);
}

/**
 * Read a detached schedule after source, row-token, capacity and expiry checks.
 * This source implementation updates cache recency without fetching. Startup
 * replaces its public compatibility property with the current-guide transport;
 * callers needing cache-only access use getEpgFromCache or __ottClassicGuide.peek.
 *
 * @param channelId - Channel ID.
 * @returns The EPGEntry[] or null if unavailable.
 */
export function getCachedChannelEpg(channelId: number): EPGEntry[] | null {
    return (window as any).__ottClassicGuide.peek(channelId);
}

/**
 * Read a detached schedule from the shared GuideService cache.
 * The historical secondary-cache entrypoint uses the same owner.
 *
 * @param channelId - Channel ID.
 * @returns The EPGEntry[] or null.
 */
export function getEpgFromCache(channelId: number): EPGEntry[] | null {
    return (window as any).__ottClassicGuide.peek(channelId);
}

/**
 * Observe now/next updates and report whether a current programme is available.
 * The guide service owns one consumer per channel in the active source/catalog;
 * repeated calls retain that consumer until its reference is retired.
 *
 * @param channelId - Channel ID to observe.
 * @param callback - Queued after projection changes, with the channel ID.
 * @returns Whether the current snapshot contains a programme airing now.
 * The callback is asynchronous and is not implied by a true return value.
 */
export function observeCurrentProgramme(
    channelId: number,
    callback: (id: number) => void
): boolean {
    return (window as any).__ottClassicGuide.current(channelId, callback);
}

/**
 * Update a channel's now/next display from a full schedule or a nextpr slice.
 * Full-schedule caching belongs to getChannelEpgCached, never this UI helper.
 *
 * @param channelId - Channel ID to associate the data with.
 * @param rows      - Programmes used to update the current channel display.
 * @param callback  - Optional function called after publishing.
 *
 * Side effects: Updates channel now/next fields and invokes the callback.
 */
export function publishChannelProgrammeRows(
    channelId: number,
    rows: EPGEntry[] | null,
    callback?: ((id: number) => void) | (() => void)
): void {
    if (
        !isFinite(Number(channelId)) ||
        Math.floor(Number(channelId)) !== Number(channelId)
    )
        return;
    (window as any).__ottClassicGuide.publish(Number(channelId), rows);
    if (callback) callback(Number(channelId));
}

/**
 * Callback invoked once the full channel list has been loaded from the provider.
 *
 * Responsibilities:
 * - Saves the pending provider ID to storage.
 * - Loads persisted category/favorites/parental data from storage.
 * - If no categories exist, builds them from the `category` field on each channel.
 * - Prepends the "All" and optionally "Favorites" virtual categories.
 * - Starts playback via `window.playChannel`.
 * - Loads EPG timers.
 * - If the channel list is empty, shows a configuration popup so the user can
 *   select a playlist/provider.
 *
 * Side effects:
 * - DOM mutations on #dialogbox, #launch, #buffering (hides them).
 * - Writes to STB storage (provider ID).
 * - Reads from STB storage (catsArray, cats, favoritesArray, parentalArray).
 * - Calls `window.playChannel` (starts playback).
 * - Calls `window.loadEpgTimers`.
 * - Console log "player ready!".
 */
export function onChannelsLoaded(): void {
    if ((window as any).__ottStandby?.blocked()) return;
    console.log("[onChanelsLoaded] cList.length=" + cList.length);
    // Dismiss the old loading dialog before playback can open a PIN or resume
    // prompt. Hiding it afterwards would close the newly created prompt.
    $("#dialogbox").hide();
    var localRecovery: any = null;
    var mediaRecovery: any = null;
    try {
        var driver = (window as any).__ottActiveProviderDriver;
        var libraryOnly = Boolean(
            driver &&
                driver.capabilities.libraryOnly &&
                typeof driver.libraryReady === "function" &&
                driver.libraryReady() &&
                (window as any).providerMediaClient &&
                typeof (window as any).getMediaArray === "function"
        );
        if (cList.length || libraryOnly) {
            // Save pending provider to storage on success
            if (
                window._pendingProvId &&
                typeof window.stbSetItem === "function"
            ) {
                window.stbSetItem("ottplayprov", window._pendingProvId);
                var id = window._pendingProvId;
                var arr = window.providerIds;
                if (arr && arr.indexOf(id) > arr.indexOf("")) {
                    var recentProviders: any[] = [];
                    try {
                        recentProviders = JSON.parse(
                            window.stbGetItem("ottplayprovs") || "[]"
                        );
                    } catch (_) {}
                    var rIdx: number = recentProviders.indexOf(id);
                    if (rIdx !== -1) recentProviders.splice(rIdx, 1);
                    recentProviders.push(id);
                    window.stbSetItem(
                        "ottplayprovs",
                        JSON.stringify(recentProviders)
                    );
                }

                window._pendingProvId = "";
            }
            if (libraryOnly) {
                // Media-only providers still own shared aspect/zoom preferences.
                (window as any).__ottChannels.mount(window);
                window.playType = 0;
                var host = window as any;
                var media = host.__ottMedia;
                var libraryClient = host.providerMediaClient;
                var libraryLoad = host.__ottCommandChannelLoad;
                if (media && media.useSource) media.useSource(null);
                var librarySource = media && media.sourceId();
                var currentLibrary = function (): boolean {
                    return (
                        driver === host.__ottActiveProviderDriver &&
                        libraryClient === host.providerMediaClient &&
                        libraryLoad === host.__ottCommandChannelLoad &&
                        driver.libraryReady() &&
                        (!media || librarySource === media.sourceId())
                    );
                };
                var openLibrary = function (): void {
                    if (host.__ottKiosk && host.__ottKiosk.locked()) return;
                    if (currentLibrary()) host.popMedia();
                };
                // Resolve the saved media ID immediately. A delayed startup
                // timer could otherwise override the user's first selection.
                if (
                    currentLibrary() &&
                    (driver.id !== "plex" ||
                        !media ||
                        typeof media.restoreLast !== "function" ||
                        !media.restoreLast(openLibrary))
                )
                    openLibrary();
            } else {
                loadFavoritesLists();
                (window as any).__ottChannels.mount(window);
                (window as any).__ottClassicPlayback.hydrate();
                var preferred = (window as any).__ottCatalogSelectedId;
                var localFallback =
                    driver?.id === "offline" &&
                    preferred != null &&
                    cList.indexOf(preferred) >= 0;
                if (
                    driver?.capabilities.mediaPlaylist &&
                    (window as any).__ottMissingCatalogSelection &&
                    !localFallback
                ) {
                    mediaRecovery = driver;
                }
                var localProfiles = (window as any).__ottOfflineProfiles;
                if (driver?.capabilities.mediaPlaylist && preferred != null) {
                    for (var group = 0; group < catsArray.length; group++) {
                        var preferredIndex = (
                            cats[catsArray[group]] || []
                        ).indexOf(preferred);
                        if (preferredIndex >= 0) {
                            window.setCurrent(group, preferredIndex);
                            break;
                        }
                    }
                }
                if (driver && driver.id === "offline" && localProfiles) {
                    var selectedLocal = localProfiles.selection();
                    if (selectedLocal !== null) {
                        var localIndex = cList.indexOf(selectedLocal);
                        if (localIndex < 0 && !localFallback)
                            localRecovery = driver;
                        else if (localIndex >= 0)
                            window.setCurrent(0, localIndex);
                    }
                }
                if (!localRecovery && !mediaRecovery) {
                    // Start playback: restore continue-watching bookmark if available.
                    // If no archive bookmark is offered, fall back to the normal
                    // live playChannel path (live bookmarks are already encoded in
                    // catIndex/primaryIndex persisted by setCurrent).
                    var el = document.getElementById("launch");
                    if (el) el.innerHTML += "<br/>Start playback...";
                    if (!restoreContinueWatch()) {
                        try {
                            window.playChannel(catIndex, primaryIndex);
                        } catch (e) {
                            console.error(e);
                            primaryIndex = 0;
                            catIndex = sFavorites ? 1 : 0;
                            try {
                                window.playChannel(catIndex, primaryIndex);
                            } catch (e2) {
                                console.error(e2);
                            }
                        }
                    }
                    try {
                        window.loadEpgTimers();
                    } catch (e) {
                        console.error(e);
                    }
                }
                // List must be hidden so main key handler gets events (ENTER, Q, C, etc.)
                window.isListVisible = false;
            }
        } else {
            // Empty channel list — show popup so user can configure provider (e.g., enter playlist URL)
            window.playType = 0;
            // A local source may only be waiting for renewed browser permission.
            // Selecting a nonexistent first channel would overwrite the saved
            // selection before access is restored and the catalog is reloaded.
            if (!driver || driver.id !== "offline")
                setCurrent(sFavorites ? 1 : 0, 0);
            var launchEl = document.getElementById("launch");
            if (launchEl && (!driver || driver.id !== "offline"))
                launchEl.innerHTML += "<br/>Channel list not received !!!";
            // Reset pending provider so user can retry without hitting savedProvId === id
            window._pendingProvId = "";
            window.launch_id = "#launch";
            // The offline driver owns source recovery; only remote providers
            // need the generic playlist configuration popup here.
            try {
                if (
                    (!driver || driver.id !== "offline") &&
                    typeof window.popupList === "function"
                ) {
                    var pActions = window.popupActions;
                    if (pActions && pActions.length) {
                        window.popupList();
                    }
                }
            } catch (e) {
                console.error(e);
            }
        }
    } catch (e) {
        console.error(e);
    }
    // Loading overlays can close now; keep any new playback prompt visible.
    $("#launch").hide();
    $("#buffering").hide();
    if (typeof (window as any).clearBootHide === "function")
        (window as any).clearBootHide();
    console.log("player ready!");
    if (
        localRecovery &&
        localRecovery === (window as any).__ottActiveProviderDriver
    )
        (window as any).__ottLocalMedia.resume(true);
    if (
        mediaRecovery &&
        mediaRecovery === (window as any).__ottActiveProviderDriver &&
        !(window as any).__ottKiosk?.locked()
    ) {
        window.channelsList(sFavorites ? 1 : 0, 0);
        window.infoBox(window._("Channel is not available!!!"));
    }
}

/**
 * Format a numeric timestamp (Unix seconds or milliseconds) into a "HH:MM" string.
 *
 * @param timestamp - Unix timestamp (seconds). Values > 1e12 are treated as milliseconds.
 * @returns Formatted time string like "14:05", or "--:--" if the input is invalid.
 */
export function formatEpgTime(timestamp: number): string {
    if (typeof timestamp !== "number" || isNaN(timestamp)) return "--:--";
    // Heuristic: if timestamp > 1e12 it's probably milliseconds → convert to seconds
    var ts = timestamp > 1e12 ? Math.floor(timestamp / 1000) : timestamp;
    var d = new Date(ts * 1000);
    if (isNaN(d.getTime())) return "--:--";
    return (
        (d.getHours() < 10 ? "0" : "") +
        d.getHours() +
        ":" +
        (d.getMinutes() < 10 ? "0" : "") +
        d.getMinutes()
    );
}

/**
 * Render an EPG list item as an HTML string for display in the channel/EPG list.
 * Highlights the currently-airing program and shows record/archive indicators.
 *
 * @param item  - The EPG entry to render.
 * @param index - Unused index (kept for callback signature compatibility).
 * @returns HTML string suitable for injection into a list container.
 */
export function itemEPG(item: EPGEntry, index: number): string {
    var w = window as any;
    var name = metadataText(item.name);
    var now =
        w.playType > 0 &&
        w.primaryIndex !== undefined &&
        w.curList &&
        w.listArray &&
        w.listArray[w.selIndex] == w.curList[w.primaryIndex]
            ? w.playType + w.playTime
            : Math.floor(Date.now() / 1000);
    var selected = w.OttPlayCore.guideScheduleSelection(
        (listEpgArray || []).map(function (row: any) {
            return { end: row.time_to, row: row, start: row.time };
        }),
        now,
        0
    ).current;
    var isCurrent =
        !!selected && selected.row.programmeId === (item as any).programmeId;

    if (isCurrent) {
        name =
            '<span style="color:' +
            (w.curColor || "#fff") +
            ';">' +
            name +
            "</span>";
    }

    var ch = (channels[epg_ch_id] || {}) as Channel;
    var prefix = "";
    // Use the same clock as isCurrent (live or archive playhead). time_to
    // marks ended programmes so the current row is not also tagged past —
    // wrong past styling after EPG page-up was easy to miss when rows clipped.
    var isPast = item.time_to <= now;
    if (ch.rec && isPast)
        prefix +=
            '<div class="btn green">&nbsp;</div> ' +
            '<span class="epg-archive-tag">' +
            (w._ ? w._("Archive") : "Archive") +
            "</span> ";
    if (isCurrent) prefix += '<div class="btn red">&nbsp;</div> ';

    return (
        "&nbsp;&nbsp;" +
        prefix +
        formatEpgTime(item.time) +
        " - " +
        formatEpgTime(item.time_to) +
        " " +
        (name || "")
    );
}

/**
 * Fetch EPG data for a single channel and update the local cache.
 * If `mode` is truthy, shows a loading spinner in #listPopUp.
 *
 * @param mode      - If non-zero, display a buffering spinner while loading.
 * @param catIdx    - Category index (passed through for context).
 * @param chIdx     - Channel index (passed through for context).
 * @param channelId - The channel ID (or provider channel ID) to fetch EPG for.
 * @param callback  - Called with `channelId` once EPG data is ready (or fails).
 *
 * Side effects:
 * - Mutates `epgListMode` flag (prevents concurrent EPG fetches).
 * - Sets `epg_ch_id`, `curEpgData`.
 * - Shows/hides #listPopUp spinner.
 * - Calls `window.getChannelEpgCached` (provider API) and `window.publishChannelProgrammeRows` on success.
 */
export function loadEpgListData(
    mode: number,
    category: number,
    index: number,
    returnToList: any,
    callback: (id: any) => void
): void {
    var w = window as any;
    w.__ottClassicGuideScreen.open(
        mode,
        category,
        index,
        !!returnToList,
        undefined,
        function () {
            if (callback) callback(w.epg_ch_id);
        }
    );
}

/** Retained renderer: model filtering, selection and lifetimes belong to GuideScreen. */
export function renderGuideView(
    mode: number,
    channelId: number,
    model: any,
    returnToList: boolean,
    position: [number, number]
): void {
    var w = window as any,
        codec = w.__ottClassicGuide,
        ch = (w.channels || {})[channelId] || {};
    epgListMode = w.epgListMode = mode;
    epgreturn = w.epgreturn = returnToList;
    epg_ch_id = w.epg_ch_id = channelId;
    w.listCatIndex = position[0];
    w.listChannel = position[1];
    curEpgData = w.curEpgData = codec.encodeRows(model.schedule);
    listEpgArray = w.listEpgArray = curEpgData || [];
    var rows = codec.encodeRows(model.rows) || [];
    w.listArray = w.listDataArray = rows;
    w.selIndex = Math.max(
        0,
        rows.findIndex(function (row: any) {
            return row.programmeId === model.selectedId;
        })
    );
    w.getListItem = w.getListItemFn =
        mode === 0
            ? function (row: any) {
                  return "&nbsp;&nbsp;" + metadataText(row.name);
              }
            : itemEPG;
    w.detailListAction = w.detailListActionFn = function () {
        detailEPG(channelId);
    };
    w.listKeyHandler = w.listKeyHandlerFn = epgKeyHandler;
    var caption = document.getElementById("listCaption");
    if (caption)
        caption.innerHTML = metadataText(
            w._(
                mode === 0 ? "Archive. Channel: " : "EPG and archive. Channel: "
            ) + (ch.channel_name || "")
        );
    renderEpgFooter();
    $("#listPopUp").hide();
    if (!rows.length && w.infoBox) w.infoBox(w._("Channel has no EPG"));
    if (w.showPage) w.showPage();
}
export function publishGuideReminders(rows: any[]): void {
    epgTimers = rows;
    (window as any).epgTimers = rows;
}

export function epgList(
    category: number,
    index: number,
    returnToList: boolean
): void {
    (window as any).__ottClassicGuideScreen.open(
        1,
        category,
        index,
        !!returnToList
    );
}

/**
 * Handle selection of an EPG list item.
 * - If the program is in the future or channel has no archive, show program info.
 * - If the program has archive (rec > 0), play the archive from the start time,
 *   after checking parental access.
 *
 * Side effects:
 * - Calls `window.showProgramInfo` for future/non-archive entries.
 * - Calls `ifParentalAccessChId` for locked channels.
 * - Calls `window.closeList`, `setCurrent`, `playArchive`.
 * - Sets `window.epgArray`.
 */
export function selectEpg(): void {
    (window as any).__ottClassicGuideScreen.select();
}

/**
 * Render the EPG list footer with button-hint icons for
 * Return, Enter, Red (Description), Green (Set timer), Yellow (TMDb).
 *
 * Side effects: Injects innerHTML into #listPodval.
 */
export function renderEpgFooter(): void {
    var w = window as any;
    var footerElement = document.getElementById("listPodval");
    if (!footerElement) return;
    // Legacy stbPlayer.js:6528-6531
    var ch = (channels[epg_ch_id] || {}) as Channel;
    var redLabel =
        epgListMode == 2
            ? ch.rec
                ? "Records"
                : "By time"
            : epgListMode
              ? "By alphabet"
              : "By time";
    var yellowExtra =
        w.sArrowFun == 2
            ? w.strLEFT
            : w.sRewFun == 1
              ? w.strRW
              : w.sPNFun == 1
                ? w.strPREV
                : "";
    var descExtra =
        w.sArrowFun == 2
            ? w.strRIGHT
            : w.sRewFun == 1
              ? w.strFF
              : w.sPNFun == 1
                ? w.strNEXT
                : "";
    footerElement.innerHTML =
        w.renderButtonHint(w.keys.RED, "", redLabel, w.strSTOP, "0") +
        w.renderButtonHint(w.keys.BLUE, "", "Category", w.strPlayPause, "1") +
        w.renderButtonHint(
            w.keys.YELLOW,
            "",
            "Channel list",
            "3",
            yellowExtra
        ) +
        w.renderButtonHint(
            w.keys.N2,
            w.strInfo,
            "Description",
            "2",
            descExtra
        ) +
        '<span id="bTimer" style="display:none;">' +
        w.renderButtonHint(w.keys.GREEN, "", "Timer", w.strTools, "8") +
        "</span>" +
        (ch.rec
            ? '<span class="epg-footer-archive">' +
              (w._
                  ? w._("Archive: ENTER on past programs")
                  : "Archive: ENTER on past programs") +
              "</span>"
            : "");
}

/**
 * Key handler for the EPG list view.
 * Keys: ENTER (play/select), RED/INFO (program info), GREEN (set timer),
 * YELLOW (TMDb search), RETURN (close list).
 *
 * @param keyCode - The pressed key code.
 * @returns `true` if the key was handled, `false` to bubble up.
 *
 * Side effects: Delegates to `selectEpg`, `setEpgTimer`, `showProgramInfo`,
 * `w.TMDb.search`, or `w.closeList`.
 */
export function epgKeyHandler(keyCode: number): boolean {
    var w = window as any;
    var keys = w.keys;
    // Navigation remains available when EPG is empty or selection is stale.
    switch (keyCode) {
        case keys.LEFT:
            if (w.sArrowFun !== 2) return false;
        // fallthrough
        case keys.N3:
        case keys.CH_LIST:
        case keys.YELLOW:
            if (typeof w.channelsList === "function")
                w.channelsList(w.listCatIndex, w.listChannel);
            return true;
        case keys.RETURN:
            // Legacy: if (!epgreturn) closeList(); else channelsList(...)
            if (!w.epgreturn) {
                if (typeof w.closeList === "function") w.closeList();
            } else if (typeof w.channelsList === "function") {
                w.channelsList(w.listCatIndex, w.listChannel);
            }
            return true;
        case keys.N1:
        case keys.PLAY:
        case keys.PAUSE:
        case keys.BLUE:
            if (typeof w.bucketsList === "function")
                w.bucketsList(w.listCatIndex);
            return true;
        case keys.RW:
            if (w.sRewFun !== 1) return false;
            if (typeof w.channelsList === "function")
                w.channelsList(w.listCatIndex, w.listChannel);
            return true;
        case keys.PREV:
            if (w.sPNFun !== 1) return false;
            if (typeof w.channelsList === "function")
                w.channelsList(w.listCatIndex, w.listChannel);
            return true;
        case keys.N0:
        case keys.EPG:
        case keys.STOP:
        case keys.RED:
            switch (epgListMode) {
                case 0:
                    if (typeof w.epgList === "function")
                        w.epgList(
                            w.listCatIndex,
                            w.listChannel,
                            w.epgreturn || false
                        );
                    return true;
                case 1:
                    if (typeof w.epgListAlpha === "function")
                        w.epgListAlpha(
                            w.listCatIndex,
                            w.listChannel,
                            w.epgreturn || false
                        );
                    return true;
                case 2:
                    if (
                        channels[epg_ch_id] &&
                        channels[epg_ch_id].rec &&
                        typeof w.recordsList === "function"
                    )
                        w.recordsList(
                            w.listCatIndex,
                            w.listChannel,
                            w.epgreturn || false
                        );
                    else if (typeof w.epgList === "function")
                        w.epgList(
                            w.listCatIndex,
                            w.listChannel,
                            w.epgreturn || false
                        );
                    return true;
            }
            return true;
    }
    var item = w.listArray[w.selIndex];
    if (!item) return false;

    switch (keyCode) {
        case keys.ENTER:
            selectEpg();
            return true;
        case keys.RIGHT:
            if (w.sArrowFun !== 2) return false;
        // fallthrough
        case keys.N2:
            if (typeof w.showProgramInfo === "function")
                w.showProgramInfo(item.name);
            return true;
        case keys.FF:
            if (w.sRewFun !== 1) return false;
            if (typeof w.showProgramInfo === "function")
                w.showProgramInfo(item.name);
            return true;
        case keys.NEXT:
            if (w.sPNFun !== 1) return false;
            if (typeof w.showProgramInfo === "function")
                w.showProgramInfo(item.name);
            return true;
        case keys.N8:
        case keys.TOOLS:
        case keys.GREEN:
            if (typeof setEpgTimer === "function") setEpgTimer();
            return true;
        case keys.INFO:
            if (typeof w.showProgramInfo === "function")
                w.showProgramInfo(item.name);
            return true;
        case keys.N5:
            searchEpgByTitle();
            return true;
    }
    return false;
}

/**
 * Render the detail/info panel for the currently selected EPG item in #listDetail.
 * Shows program name, time range, duration, elapsed time, and description/icon.
 *
 * @param channelId - The channel ID (used for context, but detail is from `window.listArray`).
 *
 * Side effects: Injects innerHTML into #listDetail, sets #_prd height, starts scroll.
 */
export function detailEPG(channelId: number): void {
    var w = window as any;
    var item = w.listArray[w.selIndex];
    var detailEl = w.listDetailElement || document.getElementById("listDetail");
    if (!(item && detailEl)) return;

    // Legacy stbPlayer.js:6507-6516
    detailEl.innerHTML =
        '<div id="_name"><div style="color:' +
        (w.curColor || "") +
        ';">' +
        metadataText(item.name) +
        '</div><div style="font-size:smaller;">' +
        (typeof w.formatProgramDateTime === "function"
            ? w.formatProgramDateTime(item.time)
            : formatEpgTime(item.time)) +
        " - " +
        (typeof w.time2time === "function"
            ? w.time2time(item.time_to)
            : formatEpgTime(item.time_to)) +
        " (" +
        Math.round((item.time_to - item.time) / 60) +
        " " +
        w._("min") +
        ")</div></div>" +
        '<div id="_descr" style="font-size:smaller;overflow:hidden;"><div id="_prd">' +
        (typeof w.getThumbnail === "function"
            ? w.getThumbnail(item.icon)
            : "") +
        metadataHtml(item.descr) +
        "</div></div>";

    var t = ($("#listDetail").height() || 0) - ($("#_name").height() || 0);
    $("#_descr").height(t);
    t = ($("#_prd").height() || 0) + 10 - t;
    if (typeof w.scrollUp === "function") w.scrollUp("_prd", t, 5000);
    if (item.time > Date.now() / 1000) $("#bTimer").show();
    else $("#bTimer").hide();
}

/**
 * Import a legacy programme reminder into the source-scoped reminder owner.
 *
 * @param timer - Timer object with properties:
 *   `t` (start Unix seconds), `te` (end), `ci` (channel ID),
 *   `c` (category index), `i` (channel index), `n` (program name).
 *
 * The owner resolves stable channel/programme identities, persists accepted
 * records and schedules their prompts. It does not reuse or store a timer
 * handle on the supplied legacy record.
 */
export function importGuideReminder(timer: any): void {
    (window as any).__ottClassicReminders.importRecord(timer);
}

/**
 * Restore provider timers (with legacy STB fallback), retaining valid future
 * entries and scheduling only channels present in the current provider.
 * Saved data is not rewritten: missing channels may return on a later load.
 */
export function loadEpgTimers(): void {
    (window as any).__ottClassicReminders.load();
}

/**
 * Toggle an EPG timer for the currently-selected program.
 * If a timer already exists for this channel+program, remove it;
 * otherwise, create and start a new timer.
 *
 * @param channelId - Channel ID for the timer.
 * @param time      - Program start timestamp (used to identify the EPG entry).
 *
 * Side effects:
 * - Shows a confirm dialog (`window.confirmBox`).
 * - On confirmation, mutates `epgTimers` array.
 * - Persists updated timers to STB storage (`stbSetItem`).
 */
export function setEpgTimer(_channelId?: any, _time?: number): void {
    (window as any).__ottClassicReminders.toggle();
}

/**
 * Alphabetical EPG list (mode=2). vs gold player.js:6602.
 * Not an alias — delegates to loadEpgListData(2, ...) then sorts by name.
 *
 * @param catIdx - Category index.
 * @param chIdx  - Channel index within the category.
 * @param force  - If true, forces EPG refresh.
 *
 * Side effects: Same as loadEpgListData + sets listArray/listDataArray/listKeyHandler.
 */
export function epgListAlpha(
    category: number | EPGEntry[],
    index?: number,
    returnToList?: boolean
): void {
    if (typeof category === "number")
        (window as any).__ottClassicGuideScreen.open(
            2,
            category,
            index,
            !!returnToList
        );
}

/**
 * Render an array of record items as a simple HTML list (each item shows name or title).
 *
 * @param records - Array of record objects, each expected to have `name` or `title`.
 * @returns Concatenated HTML string, or empty string if records is empty/null.
 */
export function recordsList(
    category: number,
    index: number,
    returnToList: boolean
): void {
    (window as any).__ottClassicGuideScreen.open(
        0,
        category,
        index,
        !!returnToList
    );
}

/**
 * Render the detail panel for the currently selected record item.
 * Populates #listDetail with the media description.
 *
 * Side effects: Injects innerHTML into #listDetail.
 */
export function detailREC(): void {
    var w = window as any;
    var detailEl = document.getElementById("listDetail");
    if (detailEl) detailEl.innerHTML = getMediaDescr(w.listArray[w.selIndex]);
}

/** Open the selected category's EPG recordings through the owned guide screen. */
export function openSelectedChannelRecordings(categoryIndex: number): void {
    (window as any).__ottClassicGuideScreen.openCategory(categoryIndex);
}

/** Render category recordings; selection remains owned by the common guide screen. */
export function renderCategoryRecordings(
    categoryIndex: number,
    model: any
): void {
    var w = window as any,
        group = (w.catsArray || [])[categoryIndex],
        rows = w.__ottClassicGuide.encodeRows(model.rows) || [];
    rows.forEach(function (row: any) {
        row.ch_id = model.channelIds[row.programmeId];
    });
    epgListMode = w.epgListMode = 3;
    epg_ch_id = w.epg_ch_id = null;
    curEpgData = w.curEpgData = null;
    listEpgArray = w.listEpgArray = [];
    w.listCatIndex = categoryIndex;
    w.listArray = w.listDataArray = rows;
    w.selIndex = Math.max(
        0,
        rows.findIndex(function (row: any) {
            return row.programmeId === model.selectedId;
        })
    );
    w.getListItem = w.getListItemFn = function (row: any): string {
        var channel = (w.channels || {})[row.ch_id] || {};
        return (
            "&nbsp;&nbsp;" +
            metadataText(row.name) +
            " [" +
            metadataText(channel.channel_name || "") +
            "] " +
            formatEpgTime(row.time)
        );
    };
    w.detailListAction = w.detailListActionFn = function () {
        var row = (w.listArray || [])[w.selIndex];
        if (row) detailEPG(row.ch_id);
    };
    w.listKeyHandler = w.listKeyHandlerFn = function (key: number): boolean {
        if (key === w.keys.RETURN || key === w.keys.EXIT) {
            var category = (w.catsArray || []).indexOf(group);
            if (category >= 0) bucketsList(category);
            else if (w.closeList) w.closeList();
            return true;
        }
        if (key === w.keys.ENTER) {
            selectEpg();
            return true;
        }
        if (key === w.keys.INFO || key === w.keys.N2) {
            var row = (w.listArray || [])[w.selIndex];
            if (row && w.showProgramInfo) w.showProgramInfo(row.name);
            return true;
        }
        return false;
    };
    var caption = document.getElementById("listCaption");
    if (caption) caption.textContent = w._("Records") + ": " + group;
    var footer = document.getElementById("listPodval");
    if (footer)
        footer.innerHTML =
            w.renderButtonHint(w.keys.RETURN, w.strRETURN, "Close") +
            w.renderButtonHint(w.keys.ENTER, w.strENTER, "Play") +
            w.renderButtonHint(w.keys.INFO, w.strInfo, "Description");
    $("#listPopUp").hide();
    if (w.showPage) w.showPage();
    if (!rows.length && w.infoBox) w.infoBox(w._("Records library is empty"));
}

// The legacy bundle links this renderer from ui/index.ts.
declare function showMediaList1(): void;

/** Keep the last accepted view separate from globals mutated by provider callbacks. */
export function rememberMediaView(_pending = false): void {}

/** Closing/reloading while fetching must not reopen a departed VOD view. */
export function cancelMediaLoad(): void {
    var w = window as any;
    if (w.__ottMedia) w.__ottMedia.cancel();
    else if (w.providerMediaClient) w.providerMediaClient.cancel();
}

/** Providers write mediaRecords/mediaName before their no-argument completion callback. */
export function requestMediaList(target: MediaTarget): void {
    (window as any).__ottMedia.open(target);
}

/** Return to the parent VOD folder, retaining its selected row. */
function mediaBack(): void {
    (window as any).__ottMedia.back();
}

/** Route remote buttons within VOD, including parent-folder navigation. */
export function mediaKeyHandler(keyCode: number): boolean {
    var w = window as any;
    var keys = w.keys;
    var item: MediaHistoryEntry | undefined = w.listArray[w.selIndex];
    function forward(): void {
        if (item && item.playlist_url) selectMedia(w.selIndex);
        else if (typeof w.infoMedia === "function") w.infoMedia();
    }
    if (w.sArrowFun === 2) {
        switch (keyCode) {
            case keys.LEFT:
                mediaBack();
                return true;
            case keys.RIGHT:
                forward();
                return true;
            case keys.RETURN:
                w.closeList();
                return true;
        }
    }
    switch (keyCode) {
        case keys.RETURN:
            mediaBack();
            return true;
        case keys.N0:
        case keys.RED:
        case keys.PRECH:
        case keys.EXIT:
            w.closeList();
            return true;
        case keys.ENTER:
            selectMedia(w.selIndex);
            return true;
        case keys.BLUE:
            w.__ottMedia.filter();
            return true;
        case keys.N5:
            w.__ottMedia.toggleShuffle();
            return true;
        case keys.PLAY:
            w.__ottMedia.shufflePlay();
            return true;
        case keys.N9:
            w.__ottMedia.cycleRepeat();
            return true;
        case keys.N2:
        case keys.INFO:
            if (typeof w.infoMedia === "function") w.infoMedia();
            return true;
        case keys.RW:
            if (w.sRewFun !== 1) return false;
            mediaBack();
            return true;
        case keys.PREV:
            if (w.sPNFun !== 1) return false;
            mediaBack();
            return true;
        case keys.FF:
            if (w.sRewFun !== 1) return false;
            forward();
            return true;
        case keys.NEXT:
            if (w.sPNFun !== 1) return false;
            forward();
            return true;
        case keys.N8:
        case keys.TOOLS:
        case keys.GREEN:
            if (
                w.sFavorites !== -1 &&
                w.__ottMedia.snapshot().frames.length > 1 &&
                item
            )
                addToMedFavorites(item);
            return true;
        case keys.YELLOW:
            if (
                item &&
                !(item as any).__ottMediaFilter &&
                hasTmdbService() &&
                w.TMDb &&
                typeof w.TMDb.search === "function"
            )
                w.TMDb.search(item.title || item.name || "");
            return true;
    }
    return false;
}

/** Add the selected movie/folder, or delete it while viewing favorites. */
export function addToMedFavorites(item: MediaHistoryEntry): void {
    (window as any).__ottMedia.favorite(item);
}

/** Select a media entry using the provider's VOD hierarchy and PIN contract. */
export function selectMedia(index?: number): void {
    var w = window as any;
    w.__ottMedia.select(index === undefined ? w.selIndex : index);
}

/** Provider completion callback: render populated mediaRecords without refetching. */
export function showMediaList(): void {
    (window as any).__ottMedia.show();
}

/** Descriptions may be lazy functions in legacy provider records. */
export function getMediaDescr(item?: MediaHistoryEntry): string {
    var text = (item && (item.description || item.descr)) || "";
    if (typeof text === "function") text = text();
    var media = (window as any).__ottMedia;
    if (media && media.description) text = media.description(item, text);
    return metadataHtml(text);
}

/** Decode the classic entrypoint; archive decisions belong to its controller. */
export function playArchive(epoch: number): void {
    (window as any).__ottClassicArchive.open(epoch);
}

/**
 * Populate OSD with archive playback info at a given playback position.
 *
 * Called both from playArchive (on seek/start) and from the periodic
 * tick in uiInit() (every second during archive playback).
 *
 * @param position - Archive position in seconds (Unix timestamp).
 *
 * Side effects:
 * - Updates `archivePos`, `curProg`, `_prog100`.
 * - Populates DOM: #programm_name, #programm_name2, #programm_duration,
 *   #begin_time, #end_time, #nprogramm_name, #nbegin_time, #nend_time,
 *   #programm_descr, #progress, #progress_r, #progress_div background.
 * - Calls `window.updateChannelInfo` to refresh the OSD.
 * - Calls `getChannelEpgCached` if seek crossed the EPG program window.
 */
export function updateArchiveInfo(position: number): void {
    (window as any).__ottClassicArchive.update(position);
}

/** Render the coordinator's immutable selection; rendering never requests media or EPG. */
function renderArchiveInfo(model: ArchiveView): void {
    var position = model.position;
    archivePos = position;
    var w = window as any;
    var channelId = model.context.host.id;
    // The archive adapter already projected this schedule and selection.
    epgArray = w.epgArray;
    curProg = w.curProg;
    var prog: EPGEntry = model.current
        ? model.current.payload
        : {
              descr: "",
              name: "",
              time: model.window.start,
              time_to: model.window.end,
          };
    playType = w.playType;
    playTime = w.playTime;

    // Update channel header info
    var chEl = document.getElementById("channel_name");
    if (chEl && channels[channelId]) {
        chEl.textContent = channels[channelId].channel_name || "";
    }
    var piconEl = document.getElementById("picon");
    if (piconEl && typeof w.getChannelPicon === "function") {
        piconEl.style.backgroundImage =
            'url("' + metadataCssUrl(w.getChannelPicon(channelId)) + '")';
    }
    var chNumEl = document.getElementById("channel_number");
    if (chNumEl) chNumEl.innerHTML = "" + (primaryIndex + 1);

    _prog100 = prog;
    w._prog100 = prog;

    // Program name
    var progNameEl = document.getElementById("programm_name");
    if (progNameEl) progNameEl.textContent = prog ? prog.name : "";
    var progName2El = document.getElementById("programm_name2");
    if (progName2El) progName2El.textContent = prog ? prog.name : "";

    // Progress bar
    var progressEl = document.getElementById("progress");
    var progressREl = document.getElementById("progress_r");
    var progressDivEl = document.getElementById("progress_div");
    var duration = prog ? prog.time_to - prog.time : 1;
    var elapsed = position - (prog ? prog.time : position);
    var pct = Math.min(100, Math.max(0, (elapsed / duration) * 100));
    if (progressEl) progressEl.style.width = pct + "%";
    var nowSec = Date.now() / 1000;
    // remainingPct: use archive position (not clock time) since prog.time may be synthetic
    var remainingPct =
        prog && prog.time_to > position
            ? Math.min(
                  100,
                  Math.max(0, ((prog.time_to - position) / duration) * 100)
              )
            : 0;
    if (progressREl) progressREl.style.width = remainingPct + "%";
    if (progressDivEl) progressDivEl.style.backgroundColor = "#600";

    // Time labels
    var beginTimeEl = document.getElementById("begin_time");
    if (beginTimeEl && prog) beginTimeEl.textContent = time2time(prog.time);
    var endTimeEl = document.getElementById("end_time");
    if (endTimeEl && prog)
        endTimeEl.textContent =
            "+" + Math.round((prog.time_to - position) / 60);
    else if (endTimeEl) endTimeEl.textContent = "";

    // Duration / current time
    var progStartStr = metadataText(
        formatLocaleDateTime(prog ? prog.time : position)
    );
    var durationEl = document.getElementById("programm_duration");
    if (durationEl && prog) {
        var arcTime = time2time(position);
        var elapsedMin = Math.round((position - prog.time) / 60);
        var totalMin = Math.round((prog.time_to - prog.time) / 60);
        durationEl.innerHTML =
            '<span id="arc_time" style="color:#a00;">' +
            arcTime +
            "</span> " +
            progStartStr +
            " - " +
            time2time(prog.time_to) +
            ' (<span id="cur_time">' +
            (elapsedMin > 0 ? elapsedMin + "/" : "") +
            "</span>" +
            totalMin +
            " " +
            (typeof _ === "function" ? _("min") : "min") +
            ")";
    } else if (durationEl) {
        durationEl.innerHTML = "";
    }

    // Description
    var descrEl = document.getElementById("programm_descr");
    if (descrEl && prog) {
        var thumb = "";
        if (typeof getThumbnail === "function") {
            thumb = getThumbnail(prog.icon || "");
        }
        descrEl.innerHTML = thumb + metadataHtml(prog.descr);
    } else if (descrEl) {
        descrEl.innerHTML = "";
    }

    // The controller supplies the next programme independently of array indices.
    var nextProg = model.next ? model.next.payload : null;
    var nextProgramNameElement = document.getElementById("nprogramm_name");
    var nbeginTimeEl = document.getElementById("nbegin_time");
    var nendTimeEl = document.getElementById("nend_time");
    if (nextProg) {
        if (nextProgramNameElement)
            nextProgramNameElement.textContent = nextProg.name;
        if (nbeginTimeEl) nbeginTimeEl.textContent = time2time(nextProg.time);
        if (nendTimeEl)
            nendTimeEl.textContent =
                "" + Math.round((nextProg.time_to - nextProg.time) / 60);
    } else {
        if (nextProgramNameElement) nextProgramNameElement.innerHTML = "  ";
        if (nbeginTimeEl) nbeginTimeEl.textContent = "";
        if (nendTimeEl) nendTimeEl.textContent = "";
    }

    if (w.sInfoChange && model.changed && !$("#info1").is(":visible")) {
        w.showChannelInfo(1);
    }
}
if (typeof window !== "undefined")
    (window as any).__ottRenderArchive = renderArchiveInfo;

/**
 * Pause live playback at the current broadcast time for archive resume.
 * Requires a playing decoder and archive retention on the selected channel.
 * Guide completion and parental access are checked before entering a paused
 * archive target; this does not open a new stream or return archive playback live.
 *
 * Side effects: Requests guide data, updates playback state/UI and pauses decoder.
 */
export function pauseLivePlayback(): void {
    if (!stbIsPlaying()) return;
    (window as any).__ottClassicArchive.pauseLive();
}

/** Decode the existing remote action at the compatibility boundary. */
export function shiftArchive(delta: number): void {
    (window as any).__ottClassicPlayback.shift(delta);
}

/**
 * Format a shift delta (seconds) as a localized ">> mm:ss / << mm:ss" string.
 *
 * @param e - Delta in seconds.
 * Side effects: Reads global window._ for localization.
 */
function formatSeekOffset(e: number): string {
    if (!e) return "&nbsp;";
    var abs = Math.abs(e);
    var m = Math.floor(abs / 60);
    var s = abs % 60;
    var w = window as any;
    var _ =
        (w._ && w._.bind(w)) ||
        function (s: string) {
            return s;
        };
    var prefix = e > 0 ? ">> " : "<< ";
    return prefix + (m ? m + _(" m ") : "") + (s ? s + _(" s") : "");
}

/**
 * Interactive OSD for a manual playback offset.
 * Opens a live/archive/VOD offset dialog; number/direction keys accumulate seconds.
 * Enter or three seconds of inactivity submits to the mode-aware seek controller.
 * Return/Exit cancels. Session replacement rejects even an already queued timer.
 *
 * @param initialDelta - Initial signed offset in seconds.
 * Side effects: Owns a dialog handler/timer and submits through shiftArchive().
 */
export function showPlaybackSeekDialog(initialDelta: number): void {
    var w = window as any;
    // Legacy stbPlayer.js:6205-6304
    var chId = curList[primaryIndex];
    var ch = channels[chId];
    if (!playType && !(ch && ch.rec)) return;
    var i = 0;
    var t: any = null;
    var keys = w.keys || {};
    var context = w.__ottClassicPlayback.context();
    var finished = false;
    var revision = 0;
    var submit = w.__ottClassicPlayback.guard(function (): void {
        shiftArchive(i);
    });
    function finish(apply: boolean): void {
        if (finished) return;
        finished = true;
        revision++;
        clearTimeout(t);
        // A retired dialog cannot seek or hide a replacement dialog.
        if (w.dialogBoxKeyHandler !== handler || !context.isCurrent()) return;
        $("#dialogbox").hide();
        if (w.tooltip) w.tooltip.style.display = "";
        if (apply) submit();
        else if (typeof w.infoBarHide === "function") w.infoBarHide();
        if (w.dialogBoxKeyHandler === handler) w.dialogBoxKeyHandler = null;
    }
    function r(delta: number): void {
        if (finished || w.dialogBoxKeyHandler !== handler) return;
        clearTimeout(t);
        i += delta;
        var stepEl = document.getElementById("step");
        if (stepEl && typeof w.formatSeekOffset === "function")
            stepEl.innerHTML = w.formatSeekOffset(i);
        var expected = ++revision;
        t = setTimeout(function () {
            if (expected === revision) finish(true);
        }, 3000);
    }
    var renderButtonHint = w.renderButtonHint;
    $("#dialogbox")
        .html(
            w._("Rewind") +
                ':<br/><span id="step" style="font-size: 150%;"></span><br/>' +
                '<br><div class="btn" onclick="_doKey(keys.UP);">' +
                (w.strUP || "") +
                '</div>&nbsp;<div class="btn" onclick="_doKey(keys.DOWN);">' +
                (w.strDOWN || "") +
                "</div>&nbsp;+/- " +
                w._("1 minute") +
                "&nbsp;&nbsp;" +
                '<div class="btn" onclick="_doKey(keys.LEFT);">' +
                (w.strLEFT || "") +
                '</div>&nbsp;<div class="btn" onclick="_doKey(keys.RIGHT);">' +
                (w.strRIGHT || "") +
                "</div>&nbsp;+/- " +
                w._("10 Seconds") +
                "<br/>" +
                (typeof renderButtonHint === "function"
                    ? renderButtonHint(keys.ENTER, w.strENTER, "Go to") +
                      renderButtonHint(keys.RETURN, w.strRETURN, "Close")
                    : "")
        )
        .show();
    if (w.sInfoRew && typeof w.showChannelInfo === "function")
        w.showChannelInfo(1);
    var handler = function (e: number): void {
        if (finished || w.dialogBoxKeyHandler !== handler) return;
        switch (e) {
            case keys.N1:
                r(-(w.s13dur || 0));
                return;
            case keys.N3:
                r(w.s13dur || 0);
                return;
            case keys.N4:
                r(-(w.s46dur || 0));
                return;
            case keys.N6:
                r(w.s46dur || 0);
                return;
            case keys.N7:
                r(-(w.s79dur || 0));
                return;
            case keys.N9:
                r(w.s79dur || 0);
                return;
            case keys.FF:
            case keys.UP:
                r(60);
                return;
            case keys.RW:
            case keys.DOWN:
                r(-60);
                return;
            case keys.RIGHT:
                r(10);
                return;
            case keys.LEFT:
                r(-10);
                return;
            case keys.EXIT:
            case keys.RETURN:
                finish(false);
                return;
            case keys.ENTER:
                finish(true);
                return;
            default:
                return;
        }
    };
    w.dialogBoxKeyHandler = handler;
    r(initialDelta);
}

/**
 * Replay archive content relative to the current live broadcast time.
 * Positive seconds select now minus offset; zero selects the airing programme's
 * start, not the live edge. Negative/nonfinite values are rejected by the owner.
 * Guide, access and retention checks may complete after this function returns.
 */
export function replayFromLiveOffset(offset: number): void {
    (window as any).__ottClassicArchive.rewind(offset);
}

/**
 * Show the channel list for a category and channel index.
 * Default implementation: refresh page display.
 * Overwritten at provider init with `_channelsList()` from
 * `src/provider/index.ts` (full legacy port).
 *
 * @param _catIdx     - Category index (used by provider override).
 * @param _channelIdx - Channel index within the category (used by provider override).
 * Side effects: Calls `window.showPage`.
 */
export function channelsList(_catIdx: number, _channelIdx: number): void {
    if (typeof window.showPage === "function") window.showPage();
}
/**
 * Open the category list ("buckets" / bucket selection) view.
 * Supports category management (create, rename, copy, delete, move) via popup actions.
 *
 * @param catIdx      - Category index to pre-select (defaults to 0).
 * @param _channelIdx - Unused (kept for call-site compatibility).
 *
 * Side effects:
 * - Sets `window.listArray`, `window.listDataArray`, `window.getListItemFn`, etc.
 * - Updates #listCaption, #listPodval, #listPopUp DOM.
 * - Calls `window.showPage`.
 */
/**
 * Index of the currently playing channel inside category `catIdx`, or 0.
 * Used when opening a category so Category: All highlights the live channel
 * instead of row 0 (invisible / wrong cursor).
 */
function playingChannelIdxInCategory(catIdx: number): number {
    try {
        var list = (cats && catsArray && cats[catsArray[catIdx]]) || [];
        if (!list.length) return 0;
        if (
            catIdx === catIndex &&
            typeof primaryIndex === "number" &&
            primaryIndex >= 0 &&
            primaryIndex < list.length
        ) {
            return primaryIndex;
        }
        var curList = (cats && catsArray && cats[catsArray[catIndex]]) || [];
        var curId = curList[primaryIndex];
        if (curId != null) {
            var i = list.indexOf(curId);
            if (i >= 0) return i;
        }
    } catch (_e) {}
    return 0;
}

export function bucketsList(catIdx: number, _channelIdx?: number): void {
    var w = window as any;
    var catsList = catsArray || [];

    w.selIndex =
        typeof catIdx === "number" && catIdx >= 0 && catIdx < catsList.length
            ? catIdx
            : 0;
    w.listArray = catsList;
    w.listDataArray = catsList;
    w.getListItemFn = function (item: string, idx: number): string {
        return (
            "&nbsp;&nbsp;" +
            (settings.noNumbersKeys || idx > 8
                ? ""
                : '<div class="btn">' + (idx + 1) + "</div>&nbsp;") +
            metadataText(item)
        );
    };

    var detailEl = document.getElementById("listDetail");
    if (detailEl) detailEl.innerHTML = "";

    w.detailListActionFn = function () {};
    w.listKeyHandlerFn = bucketsKeyHandler;

    var captionEl = document.getElementById("listCaption");
    if (captionEl) captionEl.innerHTML = w._("Category selection");

    var footerElement = document.getElementById("listPodval");
    if (footerElement) {
        var html = w.renderButtonHint(
            w.keys.RED,
            "",
            w._(w.strPlayPause || strPlayPause),
            w.strPRECH
        );
        if (!sFavorites) {
            html += w.renderButtonHint(w.keys.YELLOW, "", w._(w.strTools), "0");
        }
        footerElement.innerHTML = html;
    }

    if (!sFavorites) {
        var popupHtml =
            w.renderButtonHint(w.keys.N1, "1", w._("Move category up")) +
            "<br/>" +
            w.renderButtonHint(w.keys.N7, "7", w._("Move category down")) +
            "<br/>" +
            w.renderButtonHint(w.keys.N3, "3", w._("Create category")) +
            "<br/>" +
            w.renderButtonHint(w.keys.N6, "6", w._("Rename category")) +
            "<br/>" +
            w.renderButtonHint(w.keys.N9, "9", w._("Copy category")) +
            "<br/>" +
            w.renderButtonHint(w.keys.N8, "8", w._("Delete category"));
        $("#listPopUp").html(popupHtml);
    }
    $("#listPopUp").hide();

    if (typeof w.showPage === "function") w.showPage();
}

/**
 * Key handler for the category list (buckets) view.
 * Supports:
 * - Number keys 1-9 for direct category jump.
 * - LEFT/RIGHT → shared list paging (one visible page).
 * - RW/PREV → popup list or close.
 * - ENTER → open channels list for selected category.
 * - FF/NEXT → next category.
 * - RED/PLAY/PAUSE/PRECH → records list for category.
 * - RETURN → close.
 * - With popup visible: N1/N7 (move), N3 (create), N6 (rename), N9 (copy), N8 (delete).
 *
 * @param keyCode - The pressed key code.
 * @returns `true` if handled, `false` to bubble up.
 *
 * Side effects: Delegates to moveSelectedChannelOrCategory, saveChannelsCats, showPage, etc.
 */
export function bucketsKeyHandler(keyCode: number): boolean {
    var w = window as any;
    var keys = w.keys;
    if (!keys) return false;

    // Popup actions for category management
    if ($("#listPopUp").is(":visible")) {
        switch (keyCode) {
            case keys.RETURN:
            case keys.EXIT:
            case keys.N0:
            case keys.YELLOW:
            case keys.TOOLS:
                $("#listPopUp").hide();
                return true;
            case keys.N1:
                moveSelectedChannelOrCategory(-1);
                return true;
            case keys.N7:
                moveSelectedChannelOrCategory(1);
                return true;
            case keys.N3: {
                var name = prompt(w._("Enter category name"));
                if (name && name.trim()) {
                    name = name.trim();
                    if (!w.__ottChannels.change("create", name)) return true;
                    w.listArray = catsArray;
                    w.listDataArray = catsArray;
                    w.selIndex = catsArray.length - 1;
                    if (typeof w.showPage === "function") w.showPage();
                }
                return true;
            }
            case keys.N6: {
                var oldName = catsArray[w.selIndex];
                if (!oldName) return true;
                var newName = prompt(w._("Enter new category name"), oldName);
                if (newName && newName.trim() && newName.trim() !== oldName) {
                    newName = newName.trim();
                    if (
                        !w.__ottChannels.change(
                            "rename",
                            w.__ottChannels.group(w.selIndex),
                            newName
                        )
                    )
                        return true;
                    w.listArray = catsArray;
                    w.listDataArray = catsArray;
                    if (typeof w.showPage === "function") w.showPage();
                }
                return true;
            }
            case keys.N9: {
                var srcName = catsArray[w.selIndex];
                if (!srcName) return true;
                var copyName = prompt(
                    w._("Enter new category name"),
                    srcName + " (copy)"
                );
                if (copyName && copyName.trim()) {
                    copyName = copyName.trim();
                    if (
                        !w.__ottChannels.change(
                            "create",
                            copyName,
                            w.__ottChannels.group(w.selIndex)
                        )
                    )
                        return true;
                    w.listArray = catsArray;
                    w.listDataArray = catsArray;
                    w.selIndex = catsArray.length - 1;
                    if (typeof w.showPage === "function") w.showPage();
                }
                return true;
            }
            case keys.N8: {
                if (catsArray.length <= 1) {
                    if (typeof w.showShift === "function")
                        w.showShift(w._("Cannot delete the last category"));
                    return true;
                }
                var delName = catsArray[w.selIndex];
                if (
                    delName &&
                    confirm(w._("Delete category") + ' "' + delName + '"?')
                ) {
                    if (
                        !w.__ottChannels.change(
                            "remove",
                            w.__ottChannels.group(w.selIndex)
                        )
                    )
                        return true;
                    if (w.selIndex >= catsArray.length)
                        w.selIndex = catsArray.length - 1;
                    saveChannelsCats();
                    w.listArray = catsArray;
                    w.listDataArray = catsArray;
                    if (typeof w.showPage === "function") w.showPage();
                }
                return true;
            }
        }
        return true;
    }

    switch (keyCode) {
        case keys.N0:
        case keys.YELLOW:
        case keys.TOOLS:
            $("#listPopUp").toggle();
            return true;

        case keys.N1:
        case keys.N2:
        case keys.N3:
        case keys.N4:
        case keys.N5:
        case keys.N6:
        case keys.N7:
        case keys.N8:
        case keys.N9: {
            var idx = keyCode - keys.N1;
            if (
                idx >= 0 &&
                idx < catsArray.length &&
                typeof w.channelsList === "function"
            ) {
                w.channelsList(idx, playingChannelIdxInCategory(idx));
            }
            return true;
        }

        case keys.RW:
        case keys.PREV:
            if (typeof w.popupList === "function") {
                w.popupList();
            } else if (typeof w.closeList === "function") {
                w.closeList();
            }
            return true;

        case keys.ENTER:
            if (typeof w.channelsList === "function") {
                w.channelsList(
                    w.selIndex,
                    playingChannelIdxInCategory(w.selIndex)
                );
            }
            return true;

        case keys.FF:
        case keys.NEXT: {
            var nextCat =
                w.selIndex < catsArray.length - 1 ? w.selIndex + 1 : 0;
            if (typeof w.channelsList === "function") {
                w.channelsList(nextCat, playingChannelIdxInCategory(nextCat));
            }
            return true;
        }

        case keys.RED:
        case keys.PLAY:
        case keys.PAUSE:
        case keys.PRECH:
            if (typeof w.openSelectedChannelRecordings === "function") {
                w.openSelectedChannelRecordings(w.selIndex);
            }
            return true;

        case keys.RETURN:
            if (typeof w.closeList === "function") w.closeList();
            return true;

        default:
            return false;
    }
}
/**
 * Search EPG programmes by title across the in-memory `epg` cache
 * (per-channel programmes already fetched by getChannelEpgCached).
 * No network fetch — only the loaded window is searched.
 *
 * Flow:
 * 1. Prompt via the same `showEditKey` UX as searchChannel (caption "Search programme").
 * 2. Filter `epg[ch_id]` entries by case-insensitive substring on `name`.
 * 3. Render results as a list with `channel_name + programme + time`.
 * 4. ENTER on a result → open EPG for that channel and select the programme.
 *
 * Side effects:
 * - Mutates `window.editCaption`, `window.editvar`, `window.setEdit`,
 *   `window.listArray`, `window.listDataArray`, `window.listKeyHandlerFn`,
 *   `window.getListItemFn`, `window.selIndex`, `_crData.selIndex`.
 * - Reads/writes `epgSearch` via stbGetItem/stbSetItem.
 * - Updates #listCaption and #listPodval innerHTML; hides #listPopUp.
 * - Calls `window.showPage` and `window.showShift`.
 */
export function searchEpgByTitle(): void {
    var w = window as any;
    var source = w.__ottClassicGuide.source();
    $("#listPopUp").hide();

    function runSearch(query: string): void {
        if (source !== w.__ottClassicGuide.source()) return;
        var q = query || "";
        if (!q) {
            if (typeof w.showShift === "function")
                w.showShift(w._("Not found"));
            return;
        }
        var results: any[] = w.__ottClassicGuide.search(q).map(function (
            item: any
        ) {
            var ch = channels[item.ch_id] || {};
            item.ch_name = ch.channel_name || "";
            item.rec = ch.rec || 0;
            return item;
        });

        if (!results.length) {
            if (typeof w.showShift === "function")
                w.showShift(w._("Not found"));
            return;
        }

        var caption =
            w._("Search programme") +
            ':"' +
            query +
            '" (' +
            results.length +
            ")";

        function renderItem(item: any, _idx: number): string {
            return (
                "&nbsp;&nbsp;" +
                (channels[item.ch_id] &&
                channels[item.ch_id].rec &&
                item.time < Date.now() / 1000
                    ? '<div class="btn green">&nbsp;</div> '
                    : "") +
                formatEpgTime(item.time) +
                " - " +
                formatEpgTime(item.time_to) +
                " " +
                (item.ch_name ? "[" + metadataText(item.ch_name) + "] " : "") +
                metadataText(item.name)
            );
        }

        function openForChannel(item: any): void {
            if (item.sourceId !== w.__ottClassicGuide.source()) return;
            var ref = w.__ottClassicGuide.reference(item.ch_id),
                position = w.__ottClassicGuideScreen.position(item.ch_id);
            if (!ref || ref.channelId !== item.channelId || !position) return;
            w.__ottClassicGuideScreen.open(
                1,
                position[0],
                position[1],
                false,
                item.programmeId,
                function () {
                    selectEpg();
                }
            );
        }

        w.listArray = results;
        w.listDataArray = results;
        w.selIndex = 0;
        w.getListItem = renderItem;
        w.getListItemFn = renderItem;
        w.detailListAction = function (): void {};
        w.detailListActionFn = w.detailListAction;
        w.listKeyHandler = function (k: number): boolean {
            if (k === w.keys.EXIT || k === w.keys.RETURN) {
                if (typeof w.closeList === "function") w.closeList();
                return true;
            }
            if (k === w.keys.ENTER) {
                var sel = (w.listArray as any[])[w.selIndex];
                if (sel) openForChannel(sel);
                return true;
            }
            return false;
        };
        w.listKeyHandlerFn = w.listKeyHandler;

        var captionEl = document.getElementById("listCaption");
        if (captionEl) captionEl.textContent = caption;

        var footerElement = document.getElementById("listPodval");
        if (footerElement) {
            footerElement.innerHTML =
                (typeof w.renderButtonHint === "function"
                    ? w.renderButtonHint(
                          w.keys.RETURN,
                          w.strRETURN,
                          "Close",
                          ""
                      )
                    : "") +
                (typeof w.renderButtonHint === "function"
                    ? w.renderButtonHint(w.keys.ENTER, "", "Open", "")
                    : "");
        }

        if (typeof w.showPage === "function") w.showPage();
    }

    var editCaption = w._("Search programme");
    var saved =
        typeof w.stbGetItem === "function"
            ? w.stbGetItem("epgSearch") || ""
            : "";
    var editvar = saved;
    var setEdit = function (): void {
        var inputEl = document.getElementById("editvar");
        var inputVal = (inputEl && (inputEl as HTMLInputElement).value) || "";
        var submitted = window.editvar || "";
        if (!inputVal && !submitted) return;
        saved = inputVal || submitted;
        window.editvar = saved;
        if (typeof w.stbSetItem === "function")
            w.stbSetItem("epgSearch", saved);
        runSearch(saved);
    };
    w.editCaption = editCaption;
    w.editvar = editvar;
    w.setEdit = setEdit;
    if (typeof w.showEditKey === "function") w.showEditKey();
}

/** Keep the public device entry point; the search owner resolves stable targets. */
export function searchChannel(): void {
    (window as any).__ottChannelSearch.open();
}

/**
 * Show the on-screen Actions dialog used when sNoNumbersKeys is set.
 *
 * channelsKeyHandler: a 3×3 table of arrow-key action buttons (UP=move
 * channel up, DOWN=move channel down, LEFT=delete-or-sort,
 * RIGHT=parental-or-empty, ENTER=add-to-bucket) plus a YELLOW/TOOLS
 * "Search" button. Each arrow ENTER also routes through the same
 * dialogBoxKeyHandler installed for the duration of the dialog, so PC
 * users without a number pad can reach Move/Delete/Sort/Add/Parental
 * without needing N0/N3/N6/N7/N8/N9 — the same actions the popup N-keys
 * trigger.
 *
 * Side effects: writes innerHTML to #dialogbox, shows it, installs
 * window.dialogBoxKeyHandler, hides it on RETURN.
 */
export function shuffleChannelList(reset = false): void {
    var w = window as any;
    if (
        w.listArray === w.catsArray ||
        !w.listArray ||
        w.listArray.length < 2 ||
        (w.__ottKiosk && w.__ottKiosk.locked())
    )
        return;
    var selected = w.listArray[w.selIndex];
    var playing = w.curList && w.curList[w.primaryIndex];
    var group = w.__ottChannels.group(w.listCatIndex);
    if (group === "system:favorites") {
        if (!shuffleFavoritesList(reset)) return;
        w.__ottChannels.refresh();
    } else if (
        !group ||
        !w.__ottChannels.change(reset ? "resetShuffle" : "shuffle", group)
    )
        return;
    w.sSortAbc = 0;
    if (typeof w.sortChannels === "function") w.sortChannels(0);
    if (typeof w.providerSetItem === "function")
        w.providerSetItem("sSortAbc", 0);
    w.listArray = w.cats[w.catsArray[w.listCatIndex]] || [];
    w.listDataArray = w.listArray;
    w.selIndex = Math.max(0, w.listArray.indexOf(selected));
    var at = w.curList ? w.curList.indexOf(playing) : -1;
    if (at >= 0) w.primaryIndex = at;
    if (typeof w.showPage === "function") w.showPage();
}

export function showActionsDialog(): void {
    var w = window as any;
    var mediaPlaylist =
        w.__ottActiveProviderDriver?.capabilities?.mediaPlaylist &&
        !(w.__ottKiosk && w.__ottKiosk.locked()) &&
        w.__ottMedia;
    var t =
        !w.sFavorites && w.listCatIndex
            ? true
            : !!(w.sFavorites && !w.listCatIndex);
    var e = '<td align="center" valign="top" width="30%">';
    var dialog = document.getElementById("dialogbox");
    if (!dialog) return;
    dialog.innerHTML =
        '<table style="font-size:inherit" width="100%">' +
        "<tr><td></td>" +
        e +
        (typeof w.renderButtonHint === "function"
            ? w.renderButtonHint(
                  w.keys.UP,
                  w.strUP,
                  t ? "<br>Up<br>" : "<br><br>"
              )
            : "") +
        "</td><td></td></tr>" +
        "<tr>" +
        e +
        (typeof w.renderButtonHint === "function"
            ? w.renderButtonHint(
                  w.keys.LEFT,
                  w.strLEFT,
                  t
                      ? "<br>Delete"
                      : "<br>" +
                            w._("Sort channels") +
                            ":<br>" +
                            w._(w.sSortAbc ? '"As Is"' : "By alphabet")
              )
            : "") +
        "</td>" +
        e +
        (typeof w.renderButtonHint === "function"
            ? w.renderButtonHint(
                  w.keys.ENTER,
                  w.strENTER,
                  !w.sFavorites || w.listCatIndex
                      ? "<br>Add<br>to " +
                            (w.sFavorites ? "favorites" : "category")
                      : "<br><br>"
              )
            : "") +
        "</td>" +
        e +
        (typeof w.renderButtonHint === "function"
            ? w.renderButtonHint(
                  w.keys.RIGHT,
                  w.strRIGHT,
                  w.sPSchannels && w.parentPIN != "*"
                      ? "<br>Parental<br>Control"
                      : "<br>"
              )
            : "") +
        "</td></tr>" +
        "<tr><td></td>" +
        e +
        (typeof w.renderButtonHint === "function"
            ? w.renderButtonHint(
                  w.keys.DOWN,
                  w.strDOWN,
                  t ? "<br>Down<br>" : "<br><br>"
              )
            : "") +
        "</td><td></td></tr>" +
        "</table>" +
        (typeof w.renderButtonHint === "function"
            ? w.renderButtonHint(w.keys.RETURN, w.strRETURN, "Close")
            : "") +
        (typeof w.renderButtonHint === "function"
            ? w.renderButtonHint(w.keys.YELLOW, "", "Search", w.strTools)
            : "") +
        (w.listArray !== w.catsArray &&
        w.listArray &&
        w.listArray.length > 1 &&
        !(w.__ottKiosk && w.__ottKiosk.locked()) &&
        typeof w.renderButtonHint === "function"
            ? w.renderButtonHint(w.keys.N2, "2", "Shuffle") +
              w.renderButtonHint(w.keys.N5, "5", "Reset order")
            : "") +
        (mediaPlaylist && typeof w.renderButtonHint === "function"
            ? w.renderButtonHint(
                  w.keys.PLAY,
                  "▶",
                  mediaPlaylist.repeatMode() === "one"
                      ? "Repeat: One"
                      : mediaPlaylist.repeatMode() === "off"
                        ? "Repeat: Off"
                        : "Repeat: All"
              )
            : "");
    $(dialog!).show();
    w.dialogBoxKeyHandler = function (ev: number): boolean {
        switch (ev) {
            case w.keys.PLAY:
                if (!mediaPlaylist) return false;
                mediaPlaylist.cycleRepeat();
                showActionsDialog();
                return true;
            case w.keys.N2:
            case w.keys.N5:
                $(dialog!).hide();
                w.__ottClassicScreenPort.close("dialog");
                shuffleChannelList(ev === w.keys.N5);
                return true;
            case w.keys.ENTER:
                $(dialog!).hide();
                if (typeof w.addChannel2bucket === "function")
                    w.addChannel2bucket();
                return true;
            case w.keys.UP:
                if (typeof w.moveSelectedChannelOrCategory === "function")
                    w.moveSelectedChannelOrCategory(-1);
                return true;
            case w.keys.DOWN:
                if (typeof w.moveSelectedChannelOrCategory === "function")
                    w.moveSelectedChannelOrCategory(1);
                return true;
            case w.keys.LEFT:
                if (t) {
                    if (
                        typeof w.removeSelectedChannelFromCategory ===
                        "function"
                    )
                        w.removeSelectedChannelFromCategory();
                } else {
                    $(dialog!).hide();
                    if (typeof w.sortChannelsAction === "function")
                        w.sortChannelsAction();
                }
                return true;
            case w.keys.RIGHT:
                w.parentChannel();
                return true;
            case w.keys.RETURN:
                $(dialog!).hide();
                return true;
            case w.keys.YELLOW:
            case w.keys.TOOLS:
                $(dialog!).hide();
                // Search must belong to the list, not the hidden Actions modal.
                w.__ottClassicScreenPort.close("dialog");
                w.listChannel = w.selIndex;
                searchChannel();
                return true;
        }
        return false;
    };
}

/**
 * caption "String for search" seeded from stbGetItem("medSearch"); on submit
 * persists the new query, sets window.mediaName to e.title, unshifts 0 into
 * window.mediaSelects, and reloads the playlist with the search query
 * appended to e.playlist_url.
 *
 * Side effects:
 *  - Writes "medSearch" to stb storage on submit.
 *  - Mutates window.mediaName and window.mediaSelects.
 *  - Calls window.mediaList with the search-suffixed playlist URL.
 *
 * Caller: selectMedia() in player.js — invoked only when
 * `e.search_on` is truthy.
 */

export function searchMedia(e: MediaHistoryEntry): void {
    var w = window as any;
    if (typeof e.playlist_url !== "string") return;
    var target = e.playlist_url;
    var sourceList = w.listArray;
    var admitted = w.__ottMedia.capture();
    w.editCaption = w._("String for search");
    var t =
        (typeof w.stbGetItem === "function" ? w.stbGetItem("medSearch") : "") ||
        "";
    w.editvar = t;
    w.setEdit = function (): void {
        if (w.listArray !== sourceList || !admitted()) return;
        var inputEl = document.getElementById("editvar");
        var inputVal = (inputEl && (inputEl as HTMLInputElement).value) || "";
        var submitted = window.editvar || "";
        if (!inputVal && !submitted) return;
        t = inputVal || submitted;
        if (typeof w.stbSetItem === "function") w.stbSetItem("medSearch", t);

        if (typeof w.mediaList === "function") {
            w.__ottMedia.open(
                target +
                    (target.indexOf("?") === -1 ? "?" : "&") +
                    "search=" +
                    encodeURIComponent(t),
                e.title
            );
        }
    };
    if (typeof w.showEditKey === "function") w.showEditKey();
}

/**
 * Set the channel sort mode.
 * @param mode - 0 = default (no sort), 1 = alphabetical (A-Z).
 * Side effects: Sets `sSortAbc`.
 */
export function sortChannels(mode: number): void {
    sSortAbc = mode;
}

/* ---------------------------------------------------------------------------
 * Channel-array helpers (aAspects, aAudios, aSubs, aZooms per-channel storage)
 * --------------------------------------------------------------------------- */

/**
 * Resolve the current channel ID (as a string key) for per-channel array lookups.
 * Special case: when playType is negative (media mode) and the array is for aspects or zooms,
 * returns the fixed key "-1media".
 *
 * @param arrayName - The name of the array being accessed (used for media-mode logic).
 * @returns String key for the current channel, or null if unavailable.
 */
function channelPreferenceTarget(arrayName: string): number | null | undefined {
    if (playType < 0)
        return arrayName === "aAspects" || arrayName === "aZooms"
            ? null
            : undefined;
    return curList[primaryIndex];
}

export function getChannelPreference(arrayName: string): number {
    var target = channelPreferenceTarget(arrayName);
    if (target === undefined) return 0;
    var value = (window as any).__ottChannels.preference(arrayName, target);
    return value === undefined ? 0 : value;
}

/** Capture a preference owner without creating a catalog or writing storage. */
export function captureChannelPreference(arrayName: string): any {
    var target = channelPreferenceTarget(arrayName);
    var adapter = (window as any).__ottChannels;
    var capture =
        target !== undefined && adapter && adapter.capturePreference
            ? adapter.capturePreference(arrayName, target)
            : null;
    if (!capture) return null;
    var active = capture.active;
    capture.active = function () {
        return (
            adapter === (window as any).__ottChannels &&
            target === channelPreferenceTarget(arrayName) &&
            active()
        );
    };
    return capture;
}

export function applyChannelPreference(
    arrayName: string,
    callback: (value: number) => void
): void {
    if (typeof callback !== "function") return;
    var w = window as any;
    var target = channelPreferenceTarget(arrayName);
    var value =
        target === undefined
            ? undefined
            : w.__ottChannels.preference(arrayName, target);
    if (
        value === undefined &&
        (arrayName === "aAudios" || arrayName === "aSubs")
    ) {
        var kind = arrayName === "aAudios" ? "audio" : "subtitle";
        var backend =
            typeof w.__ottCoreBackend === "function" && w.__ottCoreBackend();
        var owner = backend && backend.current();
        if (
            owner &&
            owner.active() &&
            !(owner.__ottExplicitTracks && owner.__ottExplicitTracks[kind])
        ) {
            value = preferredTrackIndex(
                kind,
                kind === "audio"
                    ? settings.preferredAudioLanguage
                    : settings.preferredSubtitleLanguage,
                owner.tracks(kind)
            );
        }
    }
    if (
        value === undefined &&
        (target === undefined ||
            (arrayName !== "aAspects" && arrayName !== "aZooms"))
    )
        return;
    try {
        callback(value === undefined ? 0 : value);
    } catch (error) {
        console.error(error);
    }
}

export function saveChannelPreference(
    arrayName: string,
    value: number | undefined | null
): boolean {
    var target = channelPreferenceTarget(arrayName);
    return (
        target !== undefined &&
        (window as any).__ottChannels.setPreference(
            arrayName,
            target,
            value
        ) === true
    );
}

/* ---------------------------------------------------------------------------
 * Channel list key handler
 * --------------------------------------------------------------------------- */

/**
 * Key handler for the channel list view.
 * Supports: RETURN (close), ENTER (select + play), STOP/PIP (PiP),
 * RED/EPG (EPG), BLUE/PLAY/PAUSE (categories), YELLOW/TOOLS (popup),
 * INFO (program info), RW/PREV (prev category), FF/NEXT (next category),
 * and popup keys (move, delete, add, parental, sort, search).
 *
 * @param keyCode - The pressed key code.
 * @returns `true` if handled, `false` to bubble up.
 *
 * Side effects: Delegates to playChannel, stbPlayPip, epgList, bucketsList,
 * showActionsDialog, showProgramInfo, moveSelectedChannelOrCategory, removeSelectedChannelFromCategory, etc.
 */
export function channelsKeyHandler(keyCode: number): boolean {
    var keys = window.keys;
    if (!keys) return false;
    var host = window as any;
    if (
        keyCode === keys.PLAY &&
        $("#listPopUp").is(":visible") &&
        host.__ottActiveProviderDriver?.capabilities?.mediaPlaylist &&
        !(host.__ottKiosk && host.__ottKiosk.locked()) &&
        host.__ottMedia
    ) {
        host.__ottMedia.cycleRepeat();
        $("#listPopUp").hide();
        showActionsDialog();
        return true;
    }
    if (
        (keyCode === keys.N2 || keyCode === keys.N5) &&
        $("#listPopUp").is(":visible")
    ) {
        shuffleChannelList(keyCode === keys.N5);
        return true;
    }

    switch (keyCode) {
        case keys.RETURN:
            if (typeof window.closeList === "function") window.closeList();
            return true;

        case keys.ENTER: {
            if (typeof window.closeList === "function") {
                window.closeList();
            }
            var selChId = window.listArray
                ? window.listArray[window.selIndex]
                : undefined;
            var curChId = window.curList
                ? window.curList[window.primaryIndex]
                : undefined;
            if (selChId) {
                // The list selection is committed before media resolution.
                // After Cancel/error it may still point at an unplayed file.
                var retryMedia = false;
                if (
                    host.__ottActiveProviderDriver?.capabilities?.mediaPlaylist
                ) {
                    var media = host.__ottMedia?.current();
                    var state = host.__ottClassicPlayback?.snapshot();
                    var channel = media?.sequence?.channel;
                    retryMedia = !(
                        media &&
                        channel?.list.active() &&
                        String(channel.id) === String(selChId) &&
                        state &&
                        state.phase !== "idle" &&
                        state.phase !== "stopped" &&
                        state.target?.kind === "vod" &&
                        state.target.sourceId === media.ref.sourceId &&
                        state.target.channelId === media.ref.itemId &&
                        state.historyTarget?.kind === "live" &&
                        String(state.historyTarget.channelId) ===
                            String(selChId)
                    );
                }
                if (selChId !== curChId || retryMedia) {
                    if (typeof window.playChannel === "function") {
                        window.playChannel(
                            window.listCatIndex,
                            window.selIndex
                        );
                    }
                } else if (!window.playType) {
                    // Same channel in live mode — show info bar (matches old stbPlayer behavior)
                    if (typeof window.setCurrent === "function") {
                        window.setCurrent(window.listCatIndex, window.selIndex);
                    }
                    var chId = window.curList
                        ? window.curList[window.primaryIndex]
                        : undefined;
                    if (typeof window.updateChannelInfo === "function") {
                        window.updateChannelInfo(chId);
                    }
                    if (
                        typeof window.showChannelInfo === "function" &&
                        window.sInfoSwitch
                    ) {
                        window.showChannelInfo(window.settings.infoTimeout);
                    }
                    window.playType = 0;
                }
            }
            return true;
        }

        case keys.N5:
        case keys.STOP:
        case keys.PIP:
            if (typeof window.playPipChannel === "function")
                window.playPipChannel(
                    window.listCatIndex,
                    window.selIndex,
                    true
                );
            return true;

        case keys.RED:
        case window.keys ? window.keys.EPG : undefined:
            if (typeof window.epgList === "function") {
                window.epgList(window.listCatIndex, window.selIndex, true);
            }
            return true;

        case keys.BLUE:
        case keys.PLAY:
        case keys.PAUSE:
            if (typeof window.bucketsList === "function") {
                window.bucketsList(window.listCatIndex);
            }
            return true;

        case keys.N0:
        case keys.YELLOW:
        case keys.TOOLS:
            if (window.sNoNumbersKeys) {
                showActionsDialog();
            } else {
                $("#listPopUp").toggle();
            }
            return true;

        case keys.N2:
        case keys.INFO: {
            var ch = window.channels[window.listArray[window.selIndex]];
            if (
                ch &&
                typeof ch.name !== "undefined" &&
                typeof window.showProgramInfo === "function"
            ) {
                window.showProgramInfo(ch.name);
            }
            return true;
        }

        case keys.RW:
        case keys.PREV: {
            var rwFn = keyCode === keys.RW ? window.sRewFun : window.sPNFun;
            if (rwFn === 1 && typeof window.bucketsList === "function") {
                window.bucketsList(window.listCatIndex);
                return true;
            }
            if (rwFn === 2) {
                var newCat =
                    window.listCatIndex > 0
                        ? window.listCatIndex - 1
                        : (window.catsArray || []).length - 1;
                if (typeof window.channelsList === "function") {
                    window.channelsList(
                        newCat,
                        window.catIndex !== newCat ? 0 : window.primaryIndex
                    );
                }
                return true;
            }
            return false;
        }

        case keys.FF:
        case keys.NEXT: {
            var ffFn = keyCode === keys.FF ? window.sRewFun : window.sPNFun;
            if (ffFn === 1 && typeof window.epgList === "function") {
                window.epgList(window.listCatIndex, window.selIndex, true);
                return true;
            }
            if (ffFn === 2) {
                var newCat2 =
                    window.listCatIndex < (window.catsArray || []).length - 1
                        ? window.listCatIndex + 1
                        : 0;
                if (typeof window.channelsList === "function") {
                    window.channelsList(
                        newCat2,
                        window.catIndex !== newCat2 ? 0 : window.primaryIndex
                    );
                }
                return true;
            }
            return false;
        }
    }

    // Popup key handling
    if ($("#listPopUp").is(":visible")) {
        switch (keyCode) {
            case keys.N1:
                moveSelectedChannelOrCategory(-1);
                return true;
            case keys.N7:
                moveSelectedChannelOrCategory(1);
                return true;
            case keys.N8:
                removeSelectedChannelFromCategory();
                return true;
            case keys.N3:
                if (typeof window.addChannel2bucket === "function") {
                    window.addChannel2bucket();
                }
                return true;
            case keys.N4:
                if (typeof window.parentChannel === "function") {
                    window.parentChannel();
                }
                return true;
            case keys.N9: {
                var newSort = window.sSortAbc == 1 ? 0 : 1;
                window.sSortAbc = newSort;
                if (typeof window.providerSetItem === "function") {
                    window.providerSetItem("sSortAbc", newSort);
                }
                if (typeof window.sortChannels === "function") {
                    window.sortChannels(newSort);
                }
                if (typeof window.showPage === "function") window.showPage();
                return true;
            }
            case keys.N6:
                window.listChannel = window.selIndex;
                searchChannel();
                return true;
        }
    }

    return false;
}

/**
 * Reorder the selected category or channel membership with wraparound.
 * Favorites use the active favorites list; other edits go through ChannelsService.
 *
 * @param delta - +1 (move down / later position), -1 (move up / earlier position).
 *
 * Side effects:
 * - Persists the reordered category, membership or active favorites list.
 * - Refreshes projected rows while keeping the moved item selected.
 */
function moveSelectedChannelOrCategory(delta: number): void {
    var w = window as any;
    var selected = w.listArray && w.listArray[w.selIndex];
    var categories = w.listArray === catsArray;
    var groupId = w.__ottChannels.group(
        categories ? w.selIndex : w.listCatIndex
    );
    if (!groupId || selected === undefined) return;
    if (groupId === "system:favorites" && !categories) {
        var list = activeFavoritesList();
        var at = list.indexOf(selected);
        if (at < 0 || !list.length) return;
        list.splice(at, 1);
        list.splice(
            (at + delta + list.length + 1) % (list.length + 1),
            0,
            selected
        );
        saveChannelsCats();
    } else if (
        !w.__ottChannels.change(
            categories ? "move" : "member",
            categories
                ? groupId
                : {
                      action: "move",
                      channelId: selected,
                      delta: delta,
                      groupId: groupId,
                  },
            delta
        )
    )
        return;
    w.listArray = categories
        ? catsArray
        : cats[catsArray[w.listCatIndex]] || [];
    w.listDataArray = w.listArray;
    w.selIndex = w.listArray.indexOf(selected);
    if (typeof w.showPage === "function") w.showPage();
}

/** Remove membership from the selected category; keep the channel in the catalog. */
function removeSelectedChannelFromCategory(): void {
    var w = window as any;
    var selected = w.listArray && w.listArray[w.selIndex];
    var groupId = w.__ottChannels.group(w.listCatIndex);
    if (!groupId || selected === undefined) return;
    if (groupId === "system:favorites") {
        removeFromFavorites(selected);
        saveChannelsCats();
    } else if (
        !w.__ottChannels.change("member", {
            action: "remove",
            channelId: selected,
            groupId: groupId,
        })
    )
        return;
    w.listArray = cats[catsArray[w.listCatIndex]] || [];
    w.listDataArray = w.listArray;
    w.selIndex = Math.max(0, Math.min(w.selIndex, w.listArray.length - 1));
    if (typeof w.showPage === "function") w.showPage();
}

/* ---------------------------------------------------------------------------
 * Parental control — PIN code entry
 * --------------------------------------------------------------------------- */

/**
 * Show an on-screen PIN-pad dialog with digit buttons 0-9.
 * Supports navigation via arrow keys, digit entry via number keys,
 * ENTER to select the highlighted digit, RETURN to cancel.
 *
 * @param promptText - The message displayed above the PIN pad.
 * @param callback   - Called with the entered 4-digit PIN string,
 *                     or empty string if cancelled.
 *
 * Side effects:
 * - Creates/replaces content of #dialogbox.
 * - Registers `window.dialogBoxKeyHandler` for the duration of the dialog.
 * - Highlights digit buttons via DOM style mutations.
 */
export function _enterPinCode(
    promptText: string,
    callback: (pin: string) => void
): void {
    (window as any).__ottParental.pin(promptText, callback);
}

/**
 * Public convenience wrapper around `_enterPinCode`.
 *
 * @param promptText - Prompt message for the PIN dialog.
 * @param callback   - Receives the entered PIN (or empty on cancel).
 *
 * Side effects: See `_enterPinCode`.
 */
export function enterPinCode(
    promptText: string,
    callback: (pin: string) => void
): void {
    _enterPinCode(promptText, callback);
}

/* ---------------------------------------------------------------------------
 * Parental access management
 * --------------------------------------------------------------------------- */

/**
 * Grant or revoke parental access.
 * When granted, access auto-expires after 1 hour (setTimeout).
 * When denied, shows a "Wrong parental code" notification.
 *
 * @param granted  - `true` if the correct PIN was entered, `false` otherwise.
 * @param callback - Invoked only when access is granted.
 *
 * Side effects:
 * - Sets `window.parentAccess` flag.
 * - Shows on-screen notification on failure.
 */
export function setParentAccess(granted: boolean, callback: () => void): void {
    (window as any).__ottParental.setAccess(granted, callback);
}

/**
 * Prompt the user to enter their parental PIN, then grant or deny access.
 *
 * @param callback - Called on successful PIN entry.
 * @param onRejected - Optional completion for cancellation or denied access.
 *
 * Side effects: Shows PIN dialog; calls `setParentAccess`.
 */
export function enterPinAndSetAccess(
    callback: () => void,
    onRejected?: () => void
): void {
    (window as any).__ottParental.request(callback, onRejected);
}

/* ---------------------------------------------------------------------------
 * Parental control settings menu
 * --------------------------------------------------------------------------- */

/**
 * Open the parental control settings screen.
 * Lists options: enable/disable parental control, protect adult channels,
 * protect settings, protect provider switching.
 *
 * If parental control is locked (`parentPIN !== '*'` and no `parentAccess`),
 * prompts for PIN first before showing settings.
 *
 * @see {@link saveSettings} Inner function that persists changes.
 *
 * Side effects:
 * - May show PIN dialog.
 * - Sets `window.listArray` with settings items.
 * - Updates #listCaption.
 * - Calls `window._setSetup` and `window.optionsList`.
 */
export function parentControlSetup(): void {
    if ((window as any).__ottParental.needs("control")) {
        enterPinAndSetAccess(parentControlSetup);
        return;
    }

    /**
     * Persist the current parental control settings to STB storage.
     * Handles enabling/disabling the PIN (asks for new PIN + confirmation).
     *
     * Side effects:
     * - Writes to STB storage (`stbSetItem`).
     * - Shows on-screen notification.
     * - Closes the current list and re-opens the options list.
     * - On PIN change, may show PIN entry dialogs.
     */
    function saveSettings(): void {
        if (!editor.active()) return;
        function finish(pin: string, current?: () => boolean): void {
            var enabling = editor.get("parentPin") === "*" && pin !== "*";
            if (
                !editor.active() ||
                !editor.set("parentPin", pin) ||
                !editor.save()
            )
                return;
            if (enabling && current && current() && window.parentPIN === pin)
                setParentAccess(true, function () {});
            if (typeof window.showShift === "function")
                window.showShift(window._("Settings saved"));
            if (typeof window.closeList === "function") window.closeList();
            if (typeof window.optionsList === "function")
                window.optionsList(parentControlSetup);
        }
        var pin = editor.get("parentPin");
        if (
            !rows.filter(function (row: any) {
                return row.editorAction === "parentalEnabled";
            })[0].val
        ) {
            finish("*");
            return;
        }
        if (pin !== "*") {
            finish(pin);
            return;
        }
        enterPinCode(window._("Set parental code"), function (first: string) {
            if (!editor.active() || !first) return;
            enterPinCode(
                window._("Repeat parental code"),
                function (repeat: string) {
                    if (!editor.active() || !repeat) return;
                    if (repeat === first) {
                        var security = (window as any).__ottPinSecurity;
                        if (!security) return;
                        var unchanged = (
                            window as any
                        ).__ottParental.checkpoint();
                        var previous = window.parentPIN;
                        var current = function (): boolean {
                            return (
                                editor.active() &&
                                unchanged() &&
                                window.parentPIN === previous &&
                                editor.get("parentPin") === pin &&
                                !!rows.filter(function (row: any) {
                                    return (
                                        row.editorAction === "parentalEnabled"
                                    );
                                })[0].val
                            );
                        };
                        if (typeof window.showShift === "function")
                            window.showShift(
                                window._("Loading. Please wait...")
                            );
                        security.create(
                            first,
                            current,
                            function (encoded: string | null) {
                                if (!current()) return;
                                if (encoded) finish(encoded, unchanged);
                                else if (typeof window.showShift === "function")
                                    window.showShift(
                                        window._("Settings could not be saved")
                                    );
                            }
                        );
                    } else if (typeof window.showShift === "function")
                        window.showShift(window._("Wrong parental code !!!"));
                }
            );
        });
    }

    var yesNo = [window._("no") || "no", window._("yes") || "yes"];
    window.listArray = [
        {
            editorAction: "parentalEnabled",
            name: window._("Parental control") || "Parental control",
            val: window.parentPIN !== "*" ? 1 : 0,
            values: yesNo,
        },
        {
            name:
                window._("Protect Adult Channels") || "Protect Adult Channels",
            settingId: "psChannels",
            val: window.sPSchannels,
            values: yesNo,
        },
        {
            name: window._("Protect Settings") || "Protect Settings",
            settingId: "psOptions",
            val: window.sPSoptions,
            values: yesNo,
        },
        {
            name:
                window._("Protect Change Provider") ||
                "Protect Change Provider",
            settingId: "requirePinForProviderSelection",
            val: window.sPSprovs,
            values: yesNo,
        },
        { cur: "", name: "", val: 0, values: window.noop || [] },
        {
            cur: "",
            name:
                '<div class="btn">' +
                (window._("Save Settings") || "Save Settings") +
                "</div>",
            val: 0,
            values: saveSettings,
        },
    ];
    if (
        typeof window.findOptionIndex === "function" &&
        typeof window.showProviderSelection !== "undefined" &&
        window.findOptionIndex(window.showProviderSelection) === -1
    ) {
        window.listArray.splice(3, 1);
    }
    var rows = window.listArray;
    var editor = createSettingsEditor(window, rows);
    var captionEl = document.getElementById("listCaption");
    if (captionEl)
        captionEl.innerHTML =
            window._("Parental control") || "Parental control";
    if (typeof window._setSetup === "function") {
        window._setSetup(saveSettings, function () {
            editor.cancel();
            if (typeof window.optionsList === "function")
                window.optionsList(parentControlSetup);
        });
    }
    editor.attach();
}
