import { favoritesListLabel } from "../channels/favorites-lists";
import { loadProviderSettings } from "../settings";
import { metadataCssUrl, metadataHtml, metadataText } from "../utils/helpers";
/**
 * Provider management — load, parse, and manage IPTV service providers.
 * Preserves the original player's provider loading, selection, setup and
 * channel-fetch callback contracts.
 *
 * This module handles:
 * - Mounting registered provider drivers with owned request lifetimes
 * - Full-only dealer extensions via serialized provider scripts (provider.js)
 * - Provider selection UI (list of known IPTV providers)
 * - Channel list rendering and interaction
 * - Popup menu state for the OSD action menu
 * - Dealer code entry (provider activation codes)
 * - First-run setup wizard
 */

import {
    beginPortChannelIdMigration,
    cancelMediaLoad,
    cancelPortChannelIdMigration,
    finishPortChannelIdMigration,
    invalidateEpgCache,
} from "../channels";
import {
    getDefaultPlayerMode,
    normalizePlayerMode,
    restoreDemoMute,
    setPlayerMode,
    toggleAspectRatio,
    toggleAudioTrack,
    toggleSubtitle,
    toggleZoom,
} from "../core";
import {
    exitPortal,
    infoList,
    popBuckets,
    popEpg,
    popMedia,
    popPause,
    popPrevProg,
    popRecords,
    popShift,
    popStop,
    popStopPip,
    popTogglePip,
} from "../ui";

// ─── Provider list ────────────────────────────────────────────────────────────

// The build replaces this literal and removes FULL_ONLY regions for Play.
// This policy never comes from imported settings, URLs, or provider storage.
var providerDistribution: string = "full"; // OTTPLAY_DISTRIBUTION

export function isPlayDistribution(): boolean {
    return providerDistribution === "play";
}

/** Explain unsupported remote cleartext input before attempting a Play request. */
export function checkProviderUrl(url: string): boolean {
    if (!isPlayDistribution() || !/^@?http:\/\//i.test(String(url || "")))
        return true;
    if (
        /^@?http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[\/?#]|$)/i.test(
            url
        )
    )
        return true;
    alert(
        _(
            "This Play app requires HTTPS. Ask your provider for an HTTPS playlist or server URL."
        )
    );
    return false;
}

export function isProviderAllowed(id: string): boolean {
    return (
        !isPlayDistribution() ||
        id === "m3u" ||
        id === "stalker" ||
        id === "xtream" ||
        id === "plex" ||
        id === "vportal" ||
        id === "demo" ||
        id === "offline"
    );
}

export var providerIds = [
    "m3u",
    "stalker",
    "xtream",
    "plex",
    "vportal",
    "",
    "demo",
    "offline",
    // OTTPLAY_FULL_ONLY_BEGIN
    "ottclub",
    "edem",
    "shura",
    "itv",
    "tvteam",
    "ottg",
    "great",
    "top",
    "shara.club",
    "shara-tv",
    "bestlist",
    "bestlist/stalker",
    "all4you",
    "ipstream",
    "korona",
    "antifriz",
    "kb-team",
    "fox",
    "iptv-ott.ru",
    "dosug",
    "topiptv",
    "1ott",
    "newlook",
    "polmedia",
    "dragon",
    "only4",
    "ottprime",
    "shocktv",
    "diamondtv",
    "fabryka",
    "russkoetv",
    "ultifl1x",
    "tvclub",
    "vidok",
    "cbilling",
    "",
    "drvao",
    "d/maxtv",
    "moidom",
    "sharavoz",
    "raduga",
    "prost",
    "fxml",
    "rd",
    "tabox",
    // OTTPLAY_FULL_ONLY_END
];

export var providerLabels: string[] | null = null;

// ─── Storage keys for provider data ──────────────────────────────────────────

var providerScopedStorageKeys: string[] = [
    "catsArray",
    "cats",
    "favoritesArray",
    "parentalArray",
    "catIndex",
    "primaryIndex",
    "prevArr",
    "playbackJournal",
    "continueWatch",
    "epgTimers",
    "aAspects",
    "aZooms",
    "aAudios",
    "aSubs",
    "sSortAbc",
    "sPlayers",
    "medHistory",
    "medFavorites",
];

// ─── Popup menu state ──────────────────────────────────────────────────────────
// Initialised with full defaults (matching original) so the menu works even
// when loadProv is not called (e.g. PC/browser without a provider script).

export var noop = function () {};

import { popupActions, popupArray, popupDetail } from "../app/state";

/**
 * Copy `window[name]` back into `target` in place, but ONLY when the global
 * is a different array object than `target`.
 *
 * The popup arrays must stay the same objects for their whole lifetime
 * (`src/app/state.ts` documents the mutation contract; ~47 providers/*\/provider.js
 * plugins splice into them and locate the provider-settings action through
 * its stable compatibility identity). Because we publish those same
 * objects on `window` before handing control to a provider script, the
 * common case is `window[name] === target` and there is nothing to copy —
 * copying anyway (clear + spread self) empties the array and blanks the
 * menu. When a plugin does replace the global outright, adopt its contents
 * and re-point the global back at the canonical array.
 */
function syncFromWindow(target: any[], name: string): void {
    var src = (window as any)[name];
    if (!Array.isArray(src) || src === target) return;
    target.length = 0;
    for (var i = 0; i < src.length; i++) target.push(src[i]);
    (window as any)[name] = target;
}

// ─── External declarations (set by other modules at runtime) ───────────────────

declare var $: any;
declare var host: string;
declare var __cv: string;
declare var __av: string;
declare var __test: string;
declare var host_ott: string;
declare var host_ott_proto: string;
var launch_id = "#launch";
var savedPopup: {
    ver: string;
    popupActions: any[];
    popupArray: string[];
    popupDetail: string[];
} = { popupActions: [], popupArray: [], popupDetail: [], ver: "" };
declare var channelsList: any;
declare var stbIsPlaying: () => boolean;
declare var stbStop: () => void;
declare var stbSetItem: (key: string, val: string) => void;
declare var stbGetItem: (key: string) => string;
declare var stbPlayPip: (url: string) => void;
declare var getChannelEpg: (
    chId: string,
    cb: (id: string, data: any[]) => void
) => void;
declare var getChannelEpgCached: (
    chId: string,
    cb: (id: string, data: any[]) => void
) => void;
declare var epgCacheCapacity: number;
declare var observeCurrentProgramme: (
    chId: string,
    cb: (chId: string) => void
) => boolean;
declare var getChannelPicon: (chId: string) => string;
declare var channelsKeyHandler: (key: number) => boolean;
/**
 * Update a single channel row in the rendered channel list.
 * Refreshes the program name element (#pn{chId}) and the progress bar width
 * (#pr{chId}) based on elapsed time. Also re-renders the detail panel if the
 * updated channel is currently selected.
 *
 * @param chId - The channel ID to update.
 *
 * Side effects: DOM mutations to #pn{chId}, #pr{chId}.
 * Called as the EPG callback from observeCurrentProgramme.
 */
function updateChannelListRow(chId: string): void {
    var ch = channels[chId as any];
    if (!ch && (window as any).channels) ch = (window as any).channels[chId];
    if (!ch && (window as any).channels) ch = (window as any).channels[chId];
    if (!ch) return;
    var pn = document.getElementById("pn" + chId);
    if (pn) pn.textContent = ch.name || "";
    if (ch.time_to && ch.time_to > ch.time) {
        $("#pr" + chId).css(
            "width",
            ((Date.now() / 1e3 - ch.time) / (ch.time_to - ch.time)) * 100 + "%"
        );
    }
    if (listArray[selIndex] == chId) detailProg();
}
(window as any).updateChannelListRow = updateChannelListRow;
/**
 * Render the detail/program info panel for the currently selected channel.
 * Shows current program name, time range, elapsed/total duration, description
 * thumbnail, upcoming programs, and auto-scrolls long descriptions.
 * Optionally triggers a video preview (sPreview == 1).
 *
 * Reads global state: selIndex, listArray, channels, curColor, sShowDescr,
 * sNextCountL, sPreview.
 *
 * Side effects: DOM writes to #listDetail, #_descr, auto-scroll via scrollUp().
 * Calls previewChId() on window if sPreview is enabled.
 *
 * Edge case: Returns early if channels[listArray[selIndex]] is undefined or if
 * the program has already ended (time_to < now).
 */
function detailProg(): void {
    var e = channels[listArray[selIndex]];
    if (e === undefined) return;
    var wdet = window as any;
    var showDescr = wdet.settings.showDescription;
    var nextCountL = wdet.settings.nextCountList;
    var previewMode = wdet.settings.preview;
    var accent =
        (typeof curColor === "string" && curColor) || wdet.curColor || "gold";
    if (e.time_to && e.time_to >= Date.now() / 1e3) {
        var t = Math.round((Date.now() / 1e3 - e.time) / 60);
        // Title yellow (OTT); time on next line; descr clipped; next on yellow line.
        var r =
            '<div id="_name"><div class="ott-channel-detail-accent">' +
            metadataText(e.name) +
            '</div><div class="ott-channel-detail-time">' +
            time2time(e.time) +
            " - " +
            time2time(e.time_to) +
            " (" +
            (t > 0 ? t + "/" : "") +
            Math.round((e.time_to - e.time) / 60) +
            " " +
            _("min") +
            ")</div></div>" +
            '<div id="_descr" class="ott-channel-description"><div id="_prd">' +
            (wdet.sThumbnail && metadataCssUrl(e.icon)
                ? '<div class="img ott-channel-thumbnail"></div>'
                : "") +
            metadataHtml(e.descr) +
            "</div></div>";
        if (e.nextpr && nextCountL) {
            // Gold: absolute to listDetail bottom (yellow footer border).
            r +=
                '<div id="_nextpr" class="ott-channel-next' +
                (showDescr ? " ott-channel-next-overlay" : "") +
                '"><div id="_nextitems">';
            e.nextpr.forEach(function (n: any, i: number) {
                if (i < nextCountL)
                    r +=
                        time2time(n.time) +
                        ' <span class="ott-channel-detail-accent">' +
                        metadataText(n.name) +
                        "</span></br>";
            });
            r += "</div></div>";
        }
        listDetail.innerHTML = r;
        // Only app-owned elements receive styles; metadataHtml strips classes
        // and styles from provider descriptions before they enter this tree.
        var accents = listDetail.querySelectorAll(".ott-channel-detail-accent");
        for (var ai = 0; ai < accents.length; ai++)
            (accents[ai] as HTMLElement).style.color = accent;
        var thumbnail = listDetail.querySelector(
            ".ott-channel-thumbnail"
        ) as HTMLElement | null;
        if (thumbnail) {
            var thumbnailWidth = Math.floor(133 * getViewportWidthScale());
            thumbnail.style.width = thumbnailWidth + "px";
            thumbnail.style.height =
                Math.floor(200 * getViewportHeightScale()) + "px";
            thumbnail.style.margin = Math.floor(thumbnailWidth / 15) + "px";
            thumbnail.style.backgroundImage =
                'url("' + metadataCssUrl(e.icon) + '")';
        }
        $("#_nextpr").css({
            "max-height":
                Math.max(
                    0,
                    ($("#listDetail").height() || 0) -
                        ($("#_name").outerHeight(true) || 0)
                ) + "px",
            overflow: "auto",
        });
        // Prefer outerHeight so padding counts.
        var nextH = 0;
        try {
            var $np = $("#_nextpr");
            nextH = ($np.outerHeight && $np.outerHeight()) || $np.height() || 0;
        } catch (_nh) {
            nextH = $("#_nextpr").height() || 0;
        }
        var s = showDescr
            ? ($("#listDetail").height() || 0) -
              ($("#_name").outerHeight(true) || 0) -
              nextH
            : 0;
        if (!(s > 0)) s = 0;
        $("#_descr").css({
            height: s + "px",
            overflow: "hidden",
            position: "relative",
        });
        s = ($("#_prd").height() || 0) + 10 - s;
        var nextOverflow =
            ($("#_nextitems").height() || 0) - ($("#_nextpr").height() || 0);
        scrollUp(
            nextOverflow > 0 ? "_nextitems" : "_prd",
            nextOverflow > 0 ? nextOverflow : s,
            5000
        );
    } else {
        listDetail.innerHTML = "";
    }
    if (previewMode == 1 && typeof wdet.previewChId === "function")
        wdet.previewChId(listArray[selIndex]);
}

function setPopupChannels(): void {
    if ((!sFavorites && listCatIndex) || (sFavorites && !listCatIndex)) {
        $("#listPopUp").html(
            renderButtonHint(keys.N1, "1", "Move channel up") +
                "<br/>" +
                renderButtonHint(keys.N7, "7", "Move channel down") +
                "<br/>" +
                renderButtonHint(keys.N8, "8", "Delete channel") +
                (sFavorites
                    ? ""
                    : "<br/>" +
                      renderButtonHint(keys.N3, "3", "Add channel to category"))
        );
    } else {
        $("#listPopUp").html(
            renderButtonHint(
                keys.N3,
                "3",
                "Add channel to " + (sFavorites ? "favorites" : "category")
            ) +
                "<br/>" +
                renderButtonHint(
                    keys.N9,
                    "9",
                    _("Sort channels") +
                        ": " +
                        _(sSortAbc ? '"As Is"' : "By alphabet")
                )
        );
    }
    if (sPSchannels && parentPIN != "*") {
        $("#listPopUp").append(
            "<br/>" + renderButtonHint(keys.N4, "4", "Channel parental control")
        );
    }
    $("#listPopUp").append("<br/>" + renderButtonHint(keys.N6, "6", "Search"));
    if (
        listArray &&
        listArray.length > 1 &&
        !((window as any).__ottKiosk && (window as any).__ottKiosk.locked())
    )
        $("#listPopUp").append(
            "<br/>" +
                renderButtonHint(keys.N2, "2", "Shuffle") +
                "<br/>" +
                renderButtonHint(keys.N5, "5", "Reset order")
        );
    var host = window as any;
    if (
        host.__ottActiveProviderDriver?.capabilities?.mediaPlaylist &&
        !(host.__ottKiosk && host.__ottKiosk.locked()) &&
        host.__ottMedia
    )
        $("#listPopUp").append(
            "<br/>" +
                renderButtonHint(
                    keys.PLAY,
                    "▶",
                    host.__ottMedia.repeatMode() === "one"
                        ? "Repeat: One"
                        : host.__ottMedia.repeatMode() === "off"
                          ? "Repeat: Off"
                          : "Repeat: All"
                )
        );
}
declare var sPreview: number;
declare var previewChan: any;
declare var sNoColorKeys: number;
declare var sNoNumbersKeys: number;
declare var sArrowFun: number;
declare var sRewFun: number;
declare var sPNFun: number;
declare var sPSprovs: number;
declare var parentPIN: string;
declare var parentAccess: boolean;
declare var enterPinAndSetAccess: (fn: () => void) => void;
declare var selIndex: number;
declare var listArray: any[];
declare var listDetail: HTMLElement;
declare var listCaptionElement: HTMLElement;
var listFooter: HTMLElement | null = null;
declare var channelListItemWidth: number;
declare var pageSize: number;
declare var bodyColor: string;
declare var curColor: string;
declare var sShowNum: number;
declare var sShowPikon: number;
declare var sShowName: number;
declare var sShowProgram: number;
declare var sShowProgress: number;
declare var sShowArchive: number;
declare var sShowDescr: number;
declare var sShowScroll: number;
declare var catIndex: number;
declare var primaryIndex: number;
declare var catsArray: string[];
declare var cats: Record<string, string[]>;
declare var parentalArray: string[];
declare var favoritesArray: string[];
declare var getActiveFavoritesListName: () => string;
declare var prevArr: any[];
declare var cList: string[];
declare var channels: Record<string, any>;
declare var epg: any;
declare var curList: string[];
declare var aAspects: Record<string, any>;
declare var aAudios: Record<string, any>;
declare var aZooms: Record<string, any>;
declare var aSubs: Record<string, any>;
declare var mediaUrls: string[] | null;
declare var listCatIndex: number;
declare var getListItem: (item: any, idx: number) => string;
declare var detailListAction: () => void;
declare var listKeyHandler: (key: number) => boolean;
declare var listKeyHandlerFn: (key: number) => boolean;
declare var showPage: () => void;
declare var closeList: () => void;
declare var renderButtonHint: (
    key: number,
    label: string,
    desc: string,
    num?: string,
    extra?: string
) => string;
declare var strRETURN: string;
declare var strInfo: string;
declare var strEPG: string;
declare var strTools: string;
declare var strLEFT: string;
declare var strRIGHT: string;
declare var strRW: string;
declare var strFF: string;
declare var strPREV: string;
declare var strNEXT: string;
declare var strPlayPause: string;
declare var strSTOP: string;
declare var strPip: string;
declare var strUP: string;
declare var strDOWN: string;
declare var strENTER: string;
declare var strAudio: string;
declare var strSubt: string;
declare var strZoom: string;
declare var strAspect: string;
declare var strSETUP: string;
declare var strPRECH: string;
declare var keys: any;
declare var editCaption: string;
declare var editvar: string;
declare var editKey: (key: number) => boolean;
declare var setEdit: () => void;
declare var showEditKey: (initKeys?: number[]) => void;
declare var getScriptDOM: (
    url: string,
    onSuccess: () => void,
    onError: (e?: any) => void
) => void;
/**
 * Process a "dealer" (provider activation) code string.
 * Parses the code as "key:value", and if the key is "d" or "data",
 * stores the value in provider storage under 'dealerData'.
 *
 * @param code - The raw code string (e.g. "d:someEncodedData").
 *
 * Side effects: Calls providerSetItem('dealerData', ...) on match.
 * Logs to console for debugging.
 */
function doDealer(code: string): void {
    console.log("[dealer] code:", code);
    try {
        if (typeof code === "string") {
            var parts = code.split(":");
            if (parts.length >= 2) {
                var key = parts[0],
                    val = parts.slice(1).join(":");
                if (key === "d" || key === "data")
                    providerSetItem("dealerData", val);
            }
        }
    } catch (r) {
        console.error("[dealer]", r);
    }
}
declare var providerGetItem: (key: string) => string;
declare var providerGetNum: (key: string, def: number) => number;
declare var providerGetJson: (key: string, def: any) => any;
declare var providerSetItem: (key: string, val: string) => void;
declare var providerHasItem: (key: string) => boolean;
declare var providerHasItemValue: (key: string) => boolean;
declare var providerDelItem: (key: string) => void;
declare var _providerGetItem: (key: string) => string;
declare var _providerHasItem: (key: string) => boolean;
declare var _providerHasItemValue: (key: string) => boolean;
declare var _providerSetItem: (key: string, val: string) => void;
declare var _providerDelItem: (key: string) => void;
declare var _playChannel: (catIdx: number, chIdx: number) => void;
declare var _bucketsList: (catIdx: number) => void;
declare var _playMedia: (item: any) => void;
declare var playChannel: (catIdx: number, chIdx: number) => void;
declare var bucketsList: (catIdx: number) => void;
declare var playMedia: (item: any) => void;
declare var onChannelsLoaded: () => void;
declare var sendClientFeedback: (msg: string) => void;
declare var infoBox: (msg: string) => void;
/**
 * Show the Settings list (optionsArr) as a navigable list UI.
 * Each entry in optionsArr is rendered as a row; ENTER triggers its action.
 * Optionally selects a specific entry if `fn` matches an action.
 * Checks parental PIN gate (sPSoptions / parentPIN).
 *
 * @param fn - Optional action function to pre-select in the list.
 *
 * Side effects: Populates listDataArray, listArray, installs getListItemFn /
 * detailListActionFn / listKeyHandlerFn; writes to listCaptionElement,
 * listFooter, hides #listPopUp; calls showPage() to render.
 *
 * Edge case: If sNoNumbersKeys is falsy, appends a "9" shortcut button
 * for showProviderSelection. Always appends strTools button for showProviderSelection.
 */
export function optionsList(fn?: () => void): void {
    if ((window as any).__ottParental.needs("settings")) {
        if (typeof (window as any).enterPinAndSetAccess === "function") {
            (window as any).enterPinAndSetAccess(optionsList as any);
        }
        return;
    }
    if (isPlayDistribution()) {
        for (
            var optionIndex = optionsArr.length - 1;
            optionIndex >= 0;
            optionIndex--
        ) {
            if (
                optionsArr[optionIndex].action === edit_dealer ||
                optionsArr[optionIndex].action === edit_dealer_remote
            )
                optionsArr.splice(optionIndex, 1);
        }
    }
    var viewOptions = optionsArr.slice();
    if ((window as any).__ottLocalMedia)
        viewOptions.unshift({
            action: (window as any).popLocalMedia,
            name: (window as any).__ottLocalMedia.title(),
        });
    listDataArray = [];
    viewOptions.forEach(function (opt: any) {
        listDataArray.push(_(opt.name || ""));
    });
    listArray = listDataArray;
    if (!sNoNumbersKeys)
        prependMenuButtonHint(viewOptions, showProviderSelection, "9");
    prependMenuButtonHint(viewOptions, showProviderSelection, strTools);
    selIndex = 0;
    if (typeof fn !== "undefined") {
        for (var t = 0; t < viewOptions.length; t++) {
            if (viewOptions[t].action == fn) {
                selIndex = t;
                break;
            }
        }
    }
    getListItemFn = function (item: any, _idx: number) {
        return "&nbsp;&nbsp;" + item;
    };
    detailListActionFn = function () {
        listDetail.innerHTML = _(
            viewOptions[selIndex].desc || viewOptions[selIndex].name || ""
        );
        if (viewOptions[selIndex].action == toggleProviderSelectionVisibility)
            providerSelectionUnlockCount = 0;
    };
    listKeyHandlerFn = function (key: number): boolean {
        console.log(
            "DBG optionsList handler: key=" +
                key +
                " keys.ENTER=" +
                keys.ENTER +
                " selIndex=" +
                selIndex +
                " action=" +
                (viewOptions[selIndex]
                    ? typeof viewOptions[selIndex].action
                    : "undefined")
        );
        switch (key) {
            case keys.RETURN:
                // Legacy stbPlayer.js:4329: popupList(optionsList) pre-selects Settings
                popupList(optionsList);
                return true;
            case keys.ENTER:
                if (viewOptions[selIndex].action)
                    viewOptions[selIndex].action();
                return true;
            case keys.TOOLS:
            case keys.N9:
                if (findOptionIndex(showProviderSelection) > -1)
                    showProviderSelection();
                return true;
        }
        return false;
    };
    listCaptionElement.innerHTML = _("Settings");
    listFooter!.innerHTML = renderButtonHint(keys.RETURN, strRETURN, "Close");
    $("#listPopUp").hide();
    showPage();
}
declare var selectLang: () => void;
declare var loadSettings: () => void;
declare var loadOpt: (() => void) | undefined;
declare var removeOption: (fn: () => void) => void;
// popupActions/popupArray/popupDetail defined as export let above

var providerSelectionUnlockCount = 0,
    providerSettingsUnlockCount = 0,
    _clearAll = 0;

/**
 * Toggle the "Show providers?" / "Hide providers?" setting.
 * Requires 7 rapid invocations (providerSelectionUnlockCount counter) before the confirmation
 * dialog appears — a hidden/secret access pattern.
 * Checks parental PIN gate (sPSprovs).
 *
 * Side effects: Writes 'noSelProv' to stb storage, then calls restart().
 */
export function toggleProviderSelectionVisibility(): void {
    if (++providerSelectionUnlockCount < 7) return;
    if ((window as any).__ottParental.needs("providers")) {
        if (typeof (window as any).enterPinAndSetAccess === "function") {
            (window as any).enterPinAndSetAccess(
                toggleProviderSelectionVisibility
            );
        }
        return;
    }
    var e = Number.parseInt(stbGetItem("noSelProv")) || 0;
    confirmBox(e ? "Show providers?" : "Hide providers?", function () {
        stbSetItem("noSelProv", e ? "0" : "1");
        restart();
    });
    providerSelectionUnlockCount = 0;
}

/**
 * Toggle the "Show provider settings?" / "Hide provider settings?" flag.
 * Requires 7 rapid invocations (providerSettingsUnlockCount counter) before confirmation —
 * same hidden-access pattern as toggleProviderSelectionVisibility.
 * Checks parental PIN gate (sPSoptions).
 *
 * Side effects: Writes 'noProvParam' to stb storage, then calls restart().
 */
export function toggleProviderSettingsVisibility(): void {
    if (++providerSettingsUnlockCount < 7) return;
    if ((window as any).__ottParental.needs("settings")) {
        if (typeof (window as any).enterPinAndSetAccess === "function") {
            (window as any).enterPinAndSetAccess(
                toggleProviderSettingsVisibility
            );
        }
        return;
    }
    var e = Number.parseInt(stbGetItem("noProvParam")) || 0;
    confirmBox(
        e ? "Show provider settings?" : "Hide provider settings?",
        function () {
            stbSetItem("noProvParam", e ? "0" : "1");
            restart();
        }
    );
    providerSettingsUnlockCount = 0;
}

/**
 * Hard-restart the player: stop any active playback, then reload the page
 * (both via href assignment and location.reload() for compatibility).
 *
 * Side effects: Calls stbStop(), then window.location.href = self and reload.
 */
export function restart(): void {
    if ((window as any).__ottRemoteInputActive) return;
    stbStop();
    window.location.href = window.location.href;
    window.location.reload();
}
declare var setPlayer: () => void;
declare var getCurrentChannelEpg:
    | ((chId: string, cb: (id: string, data: any[]) => void) => void)
    | null;
declare var getMediaArray:
    | ((url: string, cb: (data: any[]) => void) => void)
    | null;
declare var sNextCount: number;
declare var sNextCountL: number;
declare var sPlayers: number;
declare var medHistory: any[];
declare var medFavorites: any[];
declare var _prog100: any;
declare var playType: number;
declare var playTime: number;
declare var sStopPlay: number;
declare var sInfoSwitch: number;
declare var sInfoChange: number;
declare var sInfoRew: number;
declare var sInfoTimeout: number;
declare var sInfoSlide: number;
declare var sVolumeStep: number;
declare var sPermanentTime: number;
declare var sGrapI: number;
declare var s10resum: number;
declare var sPrevCount: number;
declare var sMedCount: number;
declare var sPSchannels: number;
declare var sPSoptions: number;
declare var sNoSmall: number;
declare var sListPos: number;
declare var sFontShift: number;
declare var sFont: number;
declare var sTimezone: number;
declare var sSleepTimeout: number;
declare var sOsdOpacity: number;
declare var sSHLcolor: string;
declare var sSHLcolSel: string;
declare var sSHLcolorB: string;
declare var eSHLcolor: string;
declare var eSHLcolSel: string;
declare var eSHLcolorB: string;
declare var sEditor: number;
declare var sSortAbc: number;
declare var sFavorites: number;
declare var sALfun: number;
declare var sARfun: number;
declare var sAUfun: number;
declare var sADfun: number;
declare var sRWfun: number;
declare var sFFfun: number;
declare var sPREVfun: number;
declare var sNEXTfun: number;
declare var sRfun: number;
declare var sGfun: number;
declare var sYfun: number;
declare var sBfun: number;
declare var sEfun: number;
declare var sOkfun: number;
declare var s13dur: number;
declare var s46dur: number;
declare var s79dur: number;
declare var sHideMenus: string[];
declare var sBufSize: number;
declare var sAutorun: number;
declare var sThumbnail: number;
declare var p_pref: string;
declare var providerEpgBaseUrl: string;
declare var ott_event: any;
declare var keyStrings: Record<string, string>;
declare function _(key: string, ...args: any[]): string;
declare function getViewportWidthScale(): number;
declare function getViewportHeightScale(): number;
declare var aboutKeyHandler: (key: number) => boolean;
declare var saveListPanelState: () => void;
declare var restoreListPanelState: () => void;
declare var stbExit: () => void;
declare var version: string;
declare var s: string;
declare var time2time: (timestamp: number) => string;
declare var getThumbnail: (url: string) => string;
declare var scrollUp: (el: string, px: number, delay: number) => void;
declare var listDataArray: any[];
declare var optionsArr: { action: any; name?: string; desc?: string }[];
declare var prependMenuButtonHint: (
    arr: any[],
    action: any,
    label: string
) => void;
declare var getListItemFn: (item: any, idx: number) => string;
declare var detailListActionFn: () => void;
declare var popupList: (i?: any) => void;
declare var findOptionIndex: (action: any) => number;
declare var confirmBox: (
    message: string,
    onYes: () => void,
    onNo?: () => void
) => void;

// ─── Load provider ────────────────────────────────────────────────────────────

/**
 * Mount a registered provider instance or load its retained compatibility script.
 * Resets global function overrides (playChannel, channelsList, etc.) to
 * internal implementations and restores base popup state. Full dealer extensions
 * outside the built-in inventory keep their external /prov/{id}/prov.js contract. A missing built-in
 * driver fails closed, since its historical script is excluded from packages.
 *
 * Flow:
 * 1. Resolve provider ID from URL query string or stb storage.
 * 2. Clear out provider callback overrides (playChannel, etc.).
 * 3. Restore savedPopup state (popupActions/Array/Detail).
 * 4. Mount the instance or load its script, then call duneAddSettings → loadChannels.
 * 5. On failure call onError → firstRun().
 *
 * Side effects: DOM mutations to #launch / #dialogbox, calls stbStop() if
 * playing, calls closeList(), writes to provider storage for 'ottplayprov'.
 * Logs extensively to console.
 *
 * Edge case: The stored "noSelProv" flag hides the provider-selection action.
 * The stored "noProvParam" flag hides provider settings in popup arrays.
 */
export function loadProv(providerId?: string): void {
    if ((window as any).__ottStandby?.blocked()) return;
    var kiosk = (window as any).__ottKiosk;
    if (kiosk && kiosk.enabled()) {
        if ((window as any).__ottActiveProviderDriver) return;
        providerId = kiosk.snapshot().provider;
    }
    var commandLoad = {};
    (window as any).__ottCommandChannelLoad = commandLoad;
    (window as any).commandChannelsReady = false;
    (window as any).__ottMissingCatalogSelection = false;
    (window as any).__ottCatalogSelectedId = undefined;
    (window as any).__ottParental.revoke();
    if ((window as any).__ottCommandChannelLoad !== commandLoad) return;
    if ((window as any).__ottClassicPlayback)
        (window as any).__ottClassicPlayback.cancel();
    if ((window as any).__ottCommandChannelLoad !== commandLoad) return;
    var providerRuntime = (window as any).__ottProviderRuntime.classic;
    var previousDriver = (window as any).__ottActiveProviderDriver;
    if (previousDriver) {
        // Abort can synchronously select another source. Detach this instance
        // before teardown, then let the newer selection keep all published state.
        (window as any).__ottActiveProviderDriver = null;
        if ((window as any).__ottClassicScreenPort)
            (window as any).__ottClassicScreenPort.invalidate();
        previousDriver.dispose();
        if ((window as any).__ottCommandChannelLoad !== commandLoad) return;
    }
    // Legacy scripts execute into shared globals. Delay the next reset until
    // any previously requested script has finished evaluating, then run only
    // the latest selection. Session disposal is immediate, before that wait.
    providerRuntime.replace(function (providerSession: any) {
        if ((window as any).__ottCommandChannelLoad !== commandLoad) return;
        if (!isProviderAllowed((window as any)._pendingProvId || ""))
            (window as any)._pendingProvId = "";
        // An explicit choice made from Demo wins for this load only. The stored
        // URL and stored provider-visibility restrictions still apply on reload.
        var demoProviderSelection =
            (window as any).ottplayDemoActive === true && providerId
                ? providerId
                : "";
        // A provider switch retires demo playback before any asynchronous load.
        if ((window as any).ottplayDemoActive === true) {
            var demoMenuIndex = popupActions.indexOf(showProviderSelection);
            if (demoMenuIndex !== -1) {
                popupActions.splice(demoMenuIndex, 1);
                popupArray.splice(demoMenuIndex, 1);
                popupDetail.splice(demoMenuIndex, 1);
            }
            // Native PiP lives outside these DOM video elements. Use the public
            // shell hook so its decoder/looper and pending startup are retired too.
            (window as any).pipIndex = null;
            if (typeof window.stbStopPip === "function") {
                try {
                    window.stbStopPip();
                } catch (error) {
                    console.warn("[loadProv] demo PiP stop failed:", error);
                }
            }
        }
        (window as any).ottplayDemoActive = false;
        restoreDemoMute();
        for (var demoVideoIndex = 0; demoVideoIndex < 2; demoVideoIndex++) {
            var demoVideo = document.getElementById(
                demoVideoIndex ? "videopip" : "video"
            ) as HTMLVideoElement | null;
            if (demoVideo) demoVideo.loop = false;
        }
        cancelPortChannelIdMigration();
        cancelMediaLoad();
        if ((window as any).providerMediaClient) {
            (window as any).providerMediaClient.dispose();
            (window as any).providerMediaClient = null;
        }
        invalidateEpgCache();
        /**
         * Handle provider script load failure.
         * Clears the pending provider, alerts the error (unless 'no' provider),
         * and falls back to firstRun().
         *
         * Side effects: Alert dialog; DOM append to launch_id; hides the element.
         */
        function onError(): void {
            if (!providerSession.active()) return;
            if ((window as any).__ottCommandChannelLoad !== commandLoad) return;
            (window as any)._pendingProvId = "";
            if (s !== "no") {
                alert(_("Failed to load!") + " (" + s + ")");
            }
            $(launch_id)
                .append("<br/><b>" + _("Failed to load!") + "</b>")
                .hide();
            firstRun();
        }

        if (!$("#launch").is(":visible")) {
            if (stbIsPlaying()) stbStop();
            $("#dialogbox")
                .html(
                    '<div class="ott-spinner" aria-hidden="true"><span class="blob"></span><span class="blob"></span><span class="blob"></span><span class="blob"></span></div>'
                )
                .show();
            launch_id = "#dialogbox";
            closeList();
        }

        version = savedPopup.ver;
        getCurrentChannelEpg = null;
        getMediaArray = null;
        // Assign provider callback stubs (ported from original)
        if (typeof _playChannel !== "undefined") playChannel = _playChannel;
        if (typeof _channelsList !== "undefined") channelsList = _channelsList;
        if (typeof _bucketsList !== "undefined") bucketsList = _bucketsList;
        if (typeof _playMedia !== "undefined") playMedia = _playMedia;
        if (typeof _providerGetItem !== "undefined")
            providerGetItem = _providerGetItem;
        if (typeof _providerHasItem !== "undefined")
            providerHasItem = _providerHasItem;
        if (typeof _providerHasItemValue !== "undefined")
            providerHasItemValue = _providerHasItemValue;
        if (typeof _providerSetItem !== "undefined")
            providerSetItem = _providerSetItem;
        if (typeof _providerDelItem !== "undefined")
            providerDelItem = _providerDelItem;

        // Restore base popup state (saved before any provider script ran)
        if (savedPopup.popupActions.length) {
            popupActions.splice(
                0,
                popupActions.length,
                ...savedPopup.popupActions
            );
            popupArray.splice(0, popupArray.length, ...savedPopup.popupArray);
            popupDetail.splice(
                0,
                popupDetail.length,
                ...savedPopup.popupDetail
            );
        } else {
            // Fallback when savedPopup was never snapshotted: reuse the single
            // concat allocator published on window.* by src/index.ts. Do not
            // hardcode a second 20-label table here (HS5 / provider.js depend on
            // one shared popupActions/popupArray/popupDetail identity).
            var wPop = window as any;
            if (wPop.popupActions && wPop.popupActions.length) {
                popupActions.splice(
                    0,
                    popupActions.length,
                    ...wPop.popupActions
                );
                popupArray.splice(0, popupArray.length, ...wPop.popupArray);
                popupDetail.splice(0, popupDetail.length, ...wPop.popupDetail);
            } else {
                console.warn(
                    "[loadProv] popup fallback: window.popupActions empty; menu may be wrong"
                );
            }
        }

        var matchResult =
            kiosk && kiosk.enabled()
                ? null
                : window.location.search.match(/\?([^&]+)/);
        // Keep an explicitly selected demo after restarting a URL-pinned player.
        // The existing ?clear reset must still be able to clear that selection.
        if (
            demoProviderSelection ||
            providerId === "demo" ||
            (stbGetItem("ottplayprov") === "demo" &&
                (!matchResult || matchResult[1].replace(/!/g, "") !== "clear"))
        )
            matchResult = null;
        s = "";
        if (matchResult !== null) {
            s = matchResult[1].replace(/!/g, "");
            if (s === "clear") {
                stbSetItem("ottplayprov", "");
                stbSetItem("noSelProv", "0");
                s = "";
            }
            if (s.indexOf("*") > -1 && !stbGetItem("ottplayprov")) {
                s = s.replace(/\*/g, "");
                if (isProviderAllowed(s) && providerIds.indexOf(s) > -1) {
                    stbSetItem("ottplayprov", s);
                    stbSetItem("noSelProv", "1");
                    s = "";
                }
            }
            if (!isProviderAllowed(s) || providerIds.indexOf(s) === -1) s = "";
        }
        if (s) removeOption(showProviderSelection);
        else
            s =
                (kiosk && kiosk.enabled() ? kiosk.snapshot().provider : "") ||
                demoProviderSelection ||
                (providerId === "demo"
                    ? "demo"
                    : stbGetItem("ottplayprov") || s);
        if (!isProviderAllowed(s) || providerIds.indexOf(s) === -1) s = "";
        if (!s) {
            s = "no";
            onError();
            return;
        }
        if (Number.parseInt(stbGetItem("noSelProv") || "0"))
            removeOption(showProviderSelection);
        else {
            $(launch_id).append("<br/>");
            $(launch_id).append(
                document.createTextNode("Loading provider " + s + " script ...")
            );
            removeOption(edit_dealer);
        }
        var driverRegistry = (window as any).__ottProviderDrivers;
        var usesDriver = driverRegistry.registry.has(s);
        // Built-in scripts are not shipped. Only Full dealer-added selections
        // outside the managed inventory may use the compatibility loader.
        if (
            !usesDriver &&
            (isPlayDistribution() ||
                (window as any).__ottProviderDriverProfiles.some(function (
                    profile: any
                ) {
                    return profile.id === s;
                }))
        ) {
            onError();
            return;
        }
        function providerReady() {
            if ((window as any).__ottCommandChannelLoad !== commandLoad) return;
            // OTTPLAY_FULL_ONLY_BEGIN
            // Future guide/media/stream requests keep their provider ownership even when
            // invoked later from UI callbacks. Catalog fetches have a separate
            // reload lifetime below, so do not bind getChannelsArray here.
            if (!usesDriver)
                providerRuntime.bind(providerSession, [
                    "getEPGchanel",
                    "getEPGchanelCur",
                    "getMediaArray",
                    "getChannelUrl",
                    "getArchiveUrl",
                ]);
            // OTTPLAY_FULL_ONLY_END
            try {
                if (typeof duneAddSettings === "function") {
                    $(launch_id).append("<br/>Loading settings...");
                    // Sync working arrays to window globals so the provider
                    // script sees the current popup state (it mutates
                    // window.popupActions/popupArray/popupDetail directly).
                    (window as any).popupActions = popupActions;
                    (window as any).popupArray = popupArray;
                    (window as any).popupDetail = popupDetail;
                    var idx =
                        popupActions.indexOf(toggleProviderSettingsVisibility) +
                        1;
                    duneAddSettings(idx);
                    // Sync the window globals back into the working arrays so
                    // a provider's modifications become the new popup state.
                    //
                    // GUARDED ON PURPOSE. The three assignments above alias
                    // window.popupActions/popupArray/popupDetail to the very
                    // same array objects, and every providers/*/provider.js plugin
                    // mutates them in place (.splice()/.push(), never
                    // `= [...]`), so the working arrays are already current
                    // here. The previous unguarded version did
                    //     popupActions.length = 0;
                    //     popupActions.push(...(window as any).popupActions);
                    // which cleared the array and then spread that same,
                    // now-empty array back into itself — leaving all three
                    // arrays at length 0 and rendering the popup ("Menu")
                    // completely blank. Only copy when a plugin genuinely
                    // replaced the global with a different array object.
                    syncFromWindow(popupActions, "popupActions");
                    syncFromWindow(popupArray, "popupArray");
                    syncFromWindow(popupDetail, "popupDetail");
                    if (Number.parseInt(stbGetItem("noProvParam") || "0")) {
                        var count = popupActions.indexOf(optionsList) - idx;
                        popupArray.splice(idx, count);
                        popupDetail.splice(idx, count);
                        popupActions.splice(idx, count);
                    }
                    if (s === "demo") {
                        // Demo has no provider settings of its own. Keep an
                        // explicit exit in the main menu, after normal provider
                        // settings have been filtered, without changing locks.
                        var demoExit = popupActions.indexOf(optionsList);
                        if (demoExit < 0) demoExit = popupActions.length;
                        if (
                            popupActions.indexOf(showProviderSelection) === -1
                        ) {
                            popupActions.splice(
                                demoExit,
                                0,
                                showProviderSelection
                            );
                            popupArray.splice(
                                demoExit,
                                0,
                                _("Change provider")
                            );
                            popupDetail.splice(
                                demoExit,
                                0,
                                _("Choose provider")
                            );
                        }
                        if (findOptionIndex(showProviderSelection) === -1)
                            optionsArr.push({
                                action: showProviderSelection,
                                name: "Change provider",
                            });
                    }
                    if (
                        !isPlayDistribution() &&
                        s !== "demo" &&
                        Number.parseInt(stbGetItem("noSelProv") || "0") +
                            Number.parseInt(
                                stbGetItem("noProvParam") || "0"
                            ) !==
                            2
                    ) {
                        const img = $("<img>");
                        img.attr(
                            "src",
                            host +
                                (usesDriver ? "/providers/" : "/prov/") +
                                s +
                                (s === "plex" || s === "vportal"
                                    ? "/logo.svg?"
                                    : "/logo.png?") +
                                __av
                        );
                        img.attr("alt", " ");
                        img.css("position", "absolute");
                        if (launch_id !== "#dialogbox") {
                            img.css("top", "100px");
                            img.css("right", "100px");
                            img.css("max-width", "25%");
                            img.css("max-height", "25%");
                        } else {
                            img.css("top", "6px");
                            img.css("right", "6px");
                            img.attr("height", "40");
                        }
                        img.on("error", function () {
                            (this as HTMLImageElement).width = 0;
                        });
                        $(launch_id).append(img);
                    }
                    if (typeof getCurrentChannelEpg !== "function")
                        getCurrentChannelEpg = epgCacheCapacity
                            ? getChannelEpgCached
                            : getChannelEpg;
                    // Retained current-guide transport ABI; owned display requests use GuideService.
                    (window as any).getCachedChannelEpg = getCurrentChannelEpg;
                    loadChannels();
                } else {
                    console.error("duneAddSettings is not a function");
                    onError();
                }
            } catch (e) {
                console.error(e);
                (window as any)._pendingProvId = "";
                $(launch_id).append(
                    "<br/><br/><b>Exception:</b> name " +
                        metadataText((e as any).name) +
                        ", message " +
                        metadataText((e as any).message) +
                        ", typeof " +
                        typeof e
                );
            }
        }
        function mountDriver(): void {
            if (!providerSession.active()) return;
            if ((window as any).__ottCommandChannelLoad !== commandLoad) return;
            driverRegistry.mount(window, s, providerSession);
            if (providerSession.active()) providerReady();
        }
        if (usesDriver) {
            var assets = (window as any).__ottProviderAssets;
            if (assets) {
                var profile = (
                    window as any
                ).__ottProviderDriverProfiles.filter(function (value: any) {
                    return value.id === s;
                })[0];
                assets.classic.ensure(
                    profile ? profile.kind : "",
                    host,
                    __cv,
                    providerSession,
                    mountDriver,
                    function (error: any) {
                        if (!providerSession.active()) return;
                        if (
                            (window as any).__ottCommandChannelLoad !==
                            commandLoad
                        )
                            return;
                        console.error(error);
                        onError();
                    }
                );
            } else {
                // Source-module consumers may preload all driver implementations.
                mountDriver();
            }
        } else {
            // OTTPLAY_FULL_ONLY_BEGIN
            providerRuntime.loadScript(
                providerSession,
                getScriptDOM,
                host + "/prov/" + s + "/prov.js?" + __cv,
                providerReady,
                function (e: any) {
                    console.error(e);
                    onError();
                }
            );
            // OTTPLAY_FULL_ONLY_END
        }
    }, true);
}

// ─── Load channels ────────────────────────────────────────────────────────────

/**
 * Load channels via the provider's getChannelsArray callback.
 * Resets all channel/category/EPG state to defaults, then restores
 * persisted values from provider storage (catIndex, aAspects, etc.).
 *
 * Side effects: Clears channels, epg, catsArray, cats, favoritesArray,
 * parentalArray, etc. Writes to DOM (#launch / #dialogbox). Calls
 * getChannelsArray(onChannelsLoaded) to trigger the actual provider fetch.
 * Calls setPlayerMode() and setPlayer().
 *
 * Edge case: Stops any active playback before loading.
 */
export function loadChannels(): void {
    if ((window as any).__ottStandby?.blocked()) return;
    if ((window as any).__ottClassicScreenPort)
        (window as any).__ottClassicScreenPort.invalidate();
    if ((window as any).__ottClassicPlayback)
        (window as any).__ottClassicPlayback.cancel();
    if ((window as any).__ottChannels) (window as any).__ottChannels.reset();
    var driver = (window as any).__ottActiveProviderDriver;
    var driverOwned = !!driver;
    var libraryOnly = !!(driver && driver.capabilities.libraryOnly);
    // A restored local folder can take time to enumerate. Its catalog still
    // produces channels, but boot must reveal the normal loading UI before
    // waiting for filesystem access, just as for a remote media library.
    var libraryLoading =
        libraryOnly ||
        !!(
            driver &&
            (driver.id === "offline" || driver.capabilities.mediaPlaylist)
        );
    var catalogSession = (
        window as any
    ).__ottProviderRuntime.classic.beginCatalog(driverOwned);
    var commandLoad = {};
    (window as any).__ottCommandChannelLoad = commandLoad;
    (window as any).commandChannelsReady = false;
    var idMigration = beginPortChannelIdMigration();
    if (libraryLoading || !$("#launch").is(":visible")) {
        if (stbIsPlaying()) stbStop();
        $("#dialogbox")
            .html(
                '<center><div class="ott-spinner" aria-hidden="true"><span class="blob"></span><span class="blob"></span><span class="blob"></span><span class="blob"></span></div></center>'
            )
            .show();
        launch_id = "#dialogbox";
        closeList();
        if (libraryLoading) {
            $("#launch").hide();
            if (typeof (window as any).clearBootHide === "function")
                (window as any).clearBootHide();
        }
    }

    primaryIndex = providerGetNum("primaryIndex", 0);
    cList = [];
    // Clear channel data in-place to keep window.channels and channels references in sync
    for (var _ck in channels) {
        delete channels[_ck];
    }
    invalidateEpgCache();
    curList = [];
    catsArray = [];
    cats = {};
    parentalArray = [];
    favoritesArray = [];
    prevArr = providerGetJson("prevArr", []);
    medHistory = providerGetJson("medHistory", []);
    medFavorites = providerGetJson("medFavorites", []);
    mediaUrls = null;
    catIndex = providerGetNum("catIndex", 0);
    aAspects = providerGetJson("aAspects", {});
    aAudios = providerGetJson("aAudios", {});
    aZooms = providerGetJson("aZooms", {});
    aSubs = providerGetJson("aSubs", {});
    loadProviderSettings(getDefaultPlayerMode());
    (window as any).settings.players = normalizePlayerMode(
        (window as any).settings.players
    );
    setPlayerMode((window as any).settings.players);
    if (typeof setPlayer === "function") setPlayer();

    $(launch_id).append(
        libraryLoading
            ? "<br/>" + _("Loading. Please wait...") + "<br/>"
            : "<br/>Loading channel list..."
    );
    var loadTimer: ReturnType<typeof setTimeout> | number = -1;
    function dismissLoading(): void {
        if (!loadTimer) return;
        clearTimeout(loadTimer);
        loadTimer = 0;
        if ((window as any).__ottCommandChannelLoad !== commandLoad) return;
        $("#dialogbox,#buffering,#launch").hide();
        if (typeof (window as any).clearBootHide === "function")
            (window as any).clearBootHide();
    }
    // Managed drivers settle explicitly, including credential editors. Only
    // dealer scripts that may omit their callback need the compatibility timer.
    if (!driverOwned) loadTimer = setTimeout(dismissLoading, 3000);
    catalogSession.own(dismissLoading);
    catalogSession.run(function () {
        getChannelsArray(
            catalogSession.guard(function () {
                dismissLoading();
                if ((window as any).__ottCommandChannelLoad !== commandLoad)
                    return;
                finishPortChannelIdMigration(idMigration);
                onChannelsLoaded();
                // Startup callbacks may synchronously switch provider or reload channels.
                if ((window as any).__ottCommandChannelLoad === commandLoad) {
                    (window as any).commandChannelsReady = true;
                    var kiosk = (window as any).__ottKiosk;
                    if (kiosk && typeof kiosk.restoreMedia === "function")
                        kiosk.restoreMedia();
                }
            }),
            dismissLoading
        );
    });
}

// ─── Provider selection UI ────────────────────────────────────────────────────

/** Select a provider from the current registry without bypassing parental or distribution policy. */
export function selectProviderByIndex(index: number): boolean {
    if ((window as any).__ottKiosk && (window as any).__ottKiosk.enabled())
        return false;
    if (
        typeof index !== "number" ||
        !isFinite(index) ||
        index < 0 ||
        Math.floor(index) !== index
    )
        return false;
    var id = providerIds[index];
    if (!id || !isProviderAllowed(id)) return false;
    if ((window as any).__ottParental.needs("providers")) {
        enterPinAndSetAccess(function (): void {
            selectProviderByIndex(providerIds.indexOf(id));
        });
        return false;
    }
    if (stbGetItem("ottplayprov") === id) return true;
    var recent: string[] = [];
    try {
        recent = JSON.parse(stbGetItem("ottplayprovs") || "[]");
    } catch (_error) {}
    if (!Array.isArray(recent)) recent = [];
    if (index > providerIds.indexOf("")) {
        var previous = recent.indexOf(id);
        if (previous !== -1) recent.splice(previous, 1);
        recent.push(id);
        stbSetItem("ottplayprovs", JSON.stringify(recent));
    }
    stbSetItem("ottplayprov", id);
    loadProv(
        id === "demo" || (window as any).ottplayDemoActive === true
            ? id
            : undefined
    );
    return true;
}

/**
 * Show the provider selection list UI.
 * Builds providerLabels with display names for each known provider, reorders
 * recently used providers to the top, handles PIN parental gate, and
 * installs list handlers for navigation and selection.
 *
 * Contains two inner functions:
 * - showAbout(): Loads and displays the provider's about HTML description.
 * - selectProv(id): Persists the chosen provider and calls loadProv().
 *
 * Side effects: Reorders providerIds and providerLabels based on recent
 * usage; writes 'ottplayprov' to stb storage; writes to DOM elements
 * (#listCaption, #listPodval, #listDetail, etc.); calls showPage().
 *
 * Edge cases:
 * - If cbkey is absent, removes 'cbilling' from the provider list.
 * - If sNoNumbersKeys, hides number-key shortcuts.
 * - RETURN from a non-dune setup calls firstRun(); otherwise calls optionsList.
 */
export function showProviderSelection(): void {
    if ((window as any).__ottParental.needs("providers")) {
        enterPinAndSetAccess(showProviderSelection);
        return;
    }
    if (isPlayDistribution()) {
        // Imported/recent Full selections cannot expand this registry.
        providerIds = [
            "m3u",
            "stalker",
            "xtream",
            "plex",
            "vportal",
            "",
            "demo",
            "offline",
        ];
        providerLabels = null;
    }
    if (!providerLabels || providerLabels.some((p) => typeof p !== "string"))
        providerLabels = [
            (sNoColorKeys ? "" : '<div class="btn red">&nbsp;</div>&nbsp;') +
                _("m3u-m3u8 playlists"),
            (sNoColorKeys ? "" : '<div class="btn green">&nbsp;</div>&nbsp;') +
                _("Stalker portals"),
            (sNoColorKeys ? "" : '<div class="btn yellow">&nbsp;</div>&nbsp;') +
                "Xtream-codes",
            (sNoColorKeys ? "" : '<div class="btn blue">&nbsp;</div>&nbsp;') +
                "Plex",
            "VPortal",
            "",
            _("Demo — moving test pattern"),
            _("Local videos"),
            // OTTPLAY_FULL_ONLY_BEGIN
            "OTTCLUB",
            "Эдем / iLookTV",
            "Шура ТВ",
            "ITV.LIVE",
            "TV.Team",
            "GlanzTV",
            "GREAT IPTV",
            "Top-Tv",
            "Shara.club (ClubTV.pro)",
            "Shara-TV",
            "BEST LiST IPTV [HLS Playlist]",
            "BEST LiST IPTV [Stalker/Ministra Portal]",
            "All4you.tv",
            "IpStream.one",
            "KORONA TV",
            "АнтиФриз.ТВ",
            "KBC (Kinoboom)",
            "Fox-TV",
            "VIP-IP.COM",
            "TV DOSUG",
            "TOP-IPTV",
            "1OTT.NET",
            "New Look",
            "POLMEDIA",
            "Dragon Media PRO",
            "Only4.tv",
            "OTT Prime ONLINE",
            "ShockTv",
            "Diamond TV",
            "Fabryka.TV",
            "RUSSKOETV",
            "ULTIFL1X",
            "TVClub",
            "Vidok.TV",
            "Гомельсат (cbilling)",
            // OTTPLAY_FULL_ONLY_END
        ];

    // OTTPLAY_FULL_ONLY_BEGIN
    var cbkey = stbGetItem("cbkey");
    if (!cbkey) {
        for (var i = 0; i < providerLabels.length; i++) {
            if (providerLabels[i] === "Гомельсат (cbilling)") {
                providerLabels.splice(i, 1);
                break;
            }
        }
    }

    // OTTPLAY_FULL_ONLY_END

    /**
     * Display the "about" description HTML for the currently selected provider.
     * Loads the built-in or legacy external provider description into #listDetail, then copies it into
     * #listAbout as a full-screen overlay.
     *
     * Side effects: Saves/restores CPD (current page data); shows #listAbout;
     * installs aboutKeyHandler to dismiss on any key press.
     */
    function showAbout(): void {
        $("#listAbout").html(
            '<div style="font-size:larger;">' +
                listDetail.innerHTML.replace("display:none", "") +
                "</div>"
        );
        saveListPanelState();
        aboutKeyHandler = function () {
            restoreListPanelState();
            $("#listAbout").hide();
            return true;
        };
        $("#listAbout").show();
    }

    /**
     * Select and persist a provider by its string ID, then reload via loadProv().
     * Re-selecting Stalker opens its current editor; other active providers
     * return to optionsList. Also updates the recent-providers list in storage.
     *
     * @param id - Provider identifier (e.g. 'm3u', 'stalker').
     *
     * Side effects: Writes 'ottplayprov' and 'ottplayprovs' to stb storage.
     */
    function selectProv(id: string): void {
        if ((window as any).__ottKiosk && (window as any).__ottKiosk.enabled())
            return;
        if (!id || !isProviderAllowed(id)) return;
        var localMedia = (window as any).__ottLocalMedia;
        if (id === "offline" && localMedia) {
            localMedia.open();
            return;
        }
        if (savedProvId === id) {
            var edit = (window as any).__ottEditProvider;
            if (
                (id === "stalker" || id === "plex" || id === "vportal") &&
                !Number.parseInt(stbGetItem("noProvParam") || "0") &&
                edit &&
                edit()
            )
                return;
            optionsList(showProviderSelection);
            return;
        }
        stbSetItem("ottplayprov", id);
        if (providerIds.indexOf(id) > recentCount) {
            var recent = recentProviders.slice();
            var idx = recent.indexOf(id);
            if (idx !== -1) recent.splice(idx, 1);
            recent.push(id);
            stbSetItem("ottplayprovs", JSON.stringify(recent));
        }
        loadProv(
            id === "demo" || (window as any).ottplayDemoActive === true
                ? id
                : undefined
        );
    }

    var recentCount = providerIds.indexOf("");
    var savedProvId = stbGetItem("ottplayprov") || "no";
    var recentProviders: string[] = [];
    try {
        recentProviders = JSON.parse(stbGetItem("ottplayprovs") || "[]");
    } catch (e) {
        console.error(e);
        recentProviders = [];
    }
    if (isPlayDistribution()) {
        if (!Array.isArray(recentProviders)) recentProviders = [];
        recentProviders = recentProviders.filter(function (prov) {
            return isProviderAllowed(prov);
        });
    }
    recentProviders.forEach(function (prov) {
        // Generic protocol shortcuts keep their fixed positions.
        if (isPlayDistribution() && prov !== "demo") return;
        // OTTPLAY_FULL_ONLY_BEGIN
        if (!cbkey && prov === "cbilling") return;
        // OTTPLAY_FULL_ONLY_END
        var idx = providerIds.indexOf(prov);
        if (idx <= recentCount) return;
        providerIds.splice(idx, 1);
        providerIds.splice(recentCount + 1, 0, prov);
        var name = providerLabels![idx];
        providerLabels!.splice(idx, 1);
        providerLabels!.splice(recentCount + 1, 0, name);
    });

    selIndex = providerIds.indexOf(savedProvId);
    if (selIndex === -1 || selIndex >= providerLabels!.length) selIndex = 0;
    listArray = providerLabels!;
    listDataArray = providerLabels!;
    getListItemFn = function (item: string, idx: number) {
        return (
            "&nbsp;&nbsp;" +
            (sNoNumbersKeys || idx < recentCount + 1 || idx > 9 + recentCount
                ? ""
                : '<div class="btn">' + (idx - recentCount) + "</div>&nbsp;") +
            item
        );
    };
    detailListAction = function () {
        var id = providerIds[selIndex];
        if (id && isProviderAllowed(id)) {
            var builtIn = (window as any).__ottProviderDrivers.registry.has(id);
            var aboutUrl =
                host + (builtIn ? "/providers/" : "/prov/") + id + "/about";
            var lang = stbGetItem("ottplaylang") || "";
            lang = builtIn
                ? lang === "_rus"
                    ? "-ru"
                    : ""
                : lang === "_eng"
                  ? ""
                  : lang;
            $("#listDetail").load(
                "" + aboutUrl + lang + ".html?" + __av,
                function (_e: any, status: string) {
                    if (status === "error")
                        $("#listDetail").load(aboutUrl + ".html?" + __av);
                }
            );
        }
    };
    listKeyHandlerFn = function (key: number) {
        switch (key) {
            case keys.N1:
            case keys.N2:
            case keys.N3:
            case keys.N4:
            case keys.N5:
            case keys.N6:
            case keys.N7:
            case keys.N8:
            case keys.N9:
                selectProv(providerIds[key - 49 + recentCount + 1]);
                return true;
            case keys.RED:
                selectProv("m3u");
                return true;
            case keys.GREEN:
                selectProv("stalker");
                return true;
            case keys.YELLOW:
                selectProv("xtream");
                return true;
            case keys.BLUE:
                selectProv("plex");
                return true;
            case keys.ENTER:
                selectProv(providerIds[selIndex]);
                return true;
            case keys.RETURN:
                if (typeof duneAddSettings !== "function") {
                    firstRun();
                } else optionsList(showProviderSelection);
                return true;
            case keys.RIGHT:
                if (sArrowFun !== 2) return false;
            // fall through
            case keys.N0:
            case keys.INFO:
                showAbout();
                return true;
            case keys.FF:
                if (sRewFun !== 1) return false;
                showAbout();
                return true;
            case keys.NEXT:
                if (sPNFun !== 1) return false;
                showAbout();
                return true;
            default:
                return false;
        }
    };
    listCaptionElement.innerHTML = _("Choose provider");
    listFooter!.innerHTML =
        renderButtonHint(keys.RETURN, strRETURN, "Close") +
        renderButtonHint(keys.N0, strInfo, "Description", "0");
    $("#listPopUp").hide();
    showPage();
}

// ─── Edit dealer (enter provider code) ────────────────────────────────────────

/**
 * Open the "Enter Provider Code" editor UI.
 * Prompts the user to type a dealer (provider activation) code, then
 * fetches the corresponding script from /d/{prefix}.js and calls
 * doDealer() with the entered value.
 *
 * Inner functions:
 * - showError(msg): Alerts the error and re-shows the editor.
 * - setEdit: Triggered on submit; validates editvar, loads the script.
 *
 * Side effects: Sets editCaption, editvar; overrides setEdit and
 * showEditKey globals; loads a script dynamically.
 */
export function edit_dealer(): void {
    if (isPlayDistribution()) {
        showProviderSelection();
        return;
    }
    // OTTPLAY_FULL_ONLY_BEGIN
    /**
     * Show an error alert for invalid dealer codes and re-open the editor.
     *
     * @param msg - Translation key for the error message.
     */
    function showError(msg: string): void {
        alert(_(msg));
        setTimeout(function () {
            showEditKey([0, 1, 2]);
        });
    }
    editCaption = _("Enter Provider Code");
    editvar = "";
    /** Validate the entered code, load the dealer script, and process it. */
    setEdit = function () {
        if (!editvar) showError("Error Code!");
        else
            getScriptDOM(
                host + "/d/" + editvar.split(":")[0] + ".js?" + __cv,
                function () {
                    try {
                        doDealer(editvar);
                    } catch (e) {
                        console.error(e);
                        showError("Error Code!");
                    }
                },
                function () {
                    showError("Error Code!");
                }
            );
    };
    showEditKey([0, 1, 2]);
    // OTTPLAY_FULL_ONLY_END
}

// ─── Edit dealer remote (enter provider code via web) ─────────────────────────

/**
 * Open the remote "Enter Provider Code" editor UI.
 * Sends a request to the OTT cloud service (host_ott/swop/a.php) to
 * generate a one-time code, displays a QR code for the user to scan,
 * then polls the server until the code is submitted via the web interface.
 *
 * Inner functions:
 * - showError(msg): Alerts and cleans up.
 * - cleanup(): Cancels polling and hides the editor overlay.
 * - poll(): Periodically checks the cloud server for the entered value.
 *
 * Side effects: DOM mutations to #listEdit; AJAX POST requests to
 * host_ott/swop/a.php; loads a dynamic script on success; sets a
 * 10-minute timeout auto-cleanup.
 */
export function edit_dealer_remote(): void {
    if (isPlayDistribution()) {
        showProviderSelection();
        return;
    }
    // OTTPLAY_FULL_ONLY_BEGIN
    /**
     * Show an error alert and trigger cleanup.
     *
     * @param msg - Translation key for the error message.
     */
    function showError(msg: string): void {
        alert(_(msg));
        setTimeout(function () {
            cleanup();
        });
    }
    var cancelled = false;
    var code: string;

    /**
     * Cancel the remote dealer polling and hide the editor overlay.
     * Called on success, error, or 10-minute timeout.
     *
     * Side effects: Clears the timeout, hides #listEdit.
     */
    function cleanup(): void {
        clearTimeout(timer);
        cancelled = true;
        $("#listEdit").hide();
    }
    var timer = setTimeout(cleanup, 6e5);

    /**
     * Poll the cloud server for the dealer code value.
     * If the status is 'forbidden', retry after 5 seconds.
     * If 'success', parse the response, load the dealer script,
     * and call doDealer().
     *
     * Side effects: AJAX POST to host_ott/swop/a.php; may load
     * a dynamic script; may call showError() or hide #listEdit.
     */
    function poll(): void {
        if (cancelled) return;
        $.ajax({
            cache: false,
            data: { c: "get_val", d: code },
            error: function (jqXHR: any) {
                $("#listEdit").html(
                    '<div style="text-align:center;font-size:larger;color:red"><br/><br/>ERROR:<br/>' +
                        metadataText(jqXHR.responseText) +
                        "</div>"
                );
            },
            success: function (data: any) {
                if (cancelled) return;
                if (data.status === "forbidden") setTimeout(poll, 5e3);
                else if (data.status === "success") {
                    if (!data.data) showError("Error Code!");
                    else
                        getScriptDOM(
                            host +
                                "/d/" +
                                data.data.split(":")[0] +
                                ".js?" +
                                __cv,
                            function () {
                                try {
                                    doDealer(data.data);
                                    $("#listEdit").hide();
                                } catch (e) {
                                    console.error(e);
                                    showError("Error Code!");
                                }
                            },
                            function () {
                                showError("Error Code!");
                            }
                        );
                }
            },
            timeout: 1e4,
            type: "POST",
            url: host_ott_proto + host_ott + "/swop/a.php",
        });
    }

    listFooter!.innerHTML = renderButtonHint(keys.RETURN, strRETURN, "Close");
    $("#listEdit")
        .html(
            '<div style="text-align:center;font-size:larger;"><br/><br/>' +
                _("Send request") +
                "...</div>"
        )
        .show();
    editKey = function (key: number) {
        if (key === keys.RETURN || key === keys.EXIT) cleanup();
        return true;
    };
    $.ajax({
        cache: false,
        data: { c: "get_var", n: _("Enter Provider Code"), v: "" },
        error: function (jqXHR: any) {
            $("#listEdit").html(
                '<div style="text-align:center;font-size:larger;color:red"><br/><br/>ERROR:<br/>' +
                    metadataText(jqXHR.responseText) +
                    "</div>"
            );
        },
        success: function (data: any) {
            code = data.code;
            $("#listEdit").html(
                '<div style="text-align:center;font-size:larger;"><br/>' +
                    _("Request sended!") +
                    "<br/><br/>" +
                    _("For enter value open") +
                    '<br/><span style="font-size:larger;color:' +
                    curColor +
                    '">' +
                    __test +
                    "ott-play.com/swop</span> " +
                    _("and enter code") +
                    ' <span style="font-size:larger;color:' +
                    curColor +
                    '">' +
                    code +
                    "</span><br/><br/>" +
                    _("or scan") +
                    ":<br/><br/>" +
                    '<div><img src="https://chart.googleapis.com/chart?cht=qr&chs=300x300&chld=|1&chl=https://' +
                    __test +
                    "ott-play.com/swop/?" +
                    code +
                    '" style="height:30%;"/></div>' +
                    "</div>"
            );
            setTimeout(poll, 1e4);
        },
        timeout: 1e4,
        type: "POST",
        url: host_ott_proto + host_ott + "/swop/a.php",
    });
    // OTTPLAY_FULL_ONLY_END
}

// ─── Dune add settings (provider hook) ────────────────────────────────────────

/**
 * Called by provider scripts (provider.js) to extend the settings/popup UI.
 * Override point — providers assign a function that inserts their own
 * settings entries into popupActions/popupArray/popupDetail at the
 * given index.
 * Initially null; set by provider scripts after load.
 *
 * @param _index - The index in popupActions where provider items should
 *                 be inserted.
 */
declare var duneAddSettings: ((_index: number) => void) | null;

// ─── getChannelsArray callback pattern ─────────────────────────────────────────

/**
 * Called by provider scripts to supply the channel list.
 * Override point — providers implement this function to parse their
 * channel data and populate cats/channels/etc., then invoke the callback.
 * The default implementation immediately calls the callback (no-op).
 *
 * @param _callback - Function to call once channel data is loaded.
 */
export function getChannelsArray(
    _callback: () => void,
    _settled?: () => void
): void {
    // Override in provider scripts
    _callback();
}

// ─── Channel list UI ──────────────────────────────────────────────────────────

/**
 * Render the channel list for a given category, with selection index set
 * to channelIdx. Builds the channel row template (number, archive indicator,
 * picon, name, program progress bar) and installs list handlers.
 *
 * @param catIdx - Category index in catsArray.
 * @param channelIdx - Initial selection index within the category.
 *
 * Side effects: Populates getListItemFn, detailListAction, listKeyHandlerFn;
 * writes to listDetail, listCaptionElement, listFooter, #listPopUp;
 * calls setPopupChannels() and showPage(). Sets previewChan if sPreview
 * matches.
 *
 * Edge cases:
 * - If catsArray[catIdx] is undefined, shows an error via infoBox().
 * - Channel rendering skips missing channels with an error message.
 * - Parental-restricted channels get red styling.
 * - If stbPlayPip exists, a PiP button is added to the footer.
 */
function _channelsList(catIdx: number, channelIdx: number): void {
    if (catsArray[catIdx] === undefined) {
        infoBox(
            _(
                "ERROR: Category #%1 does not exist!<br>Please select another category.",
                catIdx
            )
        );
        sendClientFeedback(
            "category_trouble_channelsList: " +
                catIdx +
                " / " +
                catsArray.length +
                " / " +
                Object.keys(providerGetJson("cats", {})).length
        );
    }
    selIndex = channelIdx;
    (window as any).selIndex = selIndex;
    listCatIndex = catIdx;
    listArray = cats[catsArray[listCatIndex]] || [];
    var wglob = window as any;
    // Both typed settings and legacy s* properties read the same SettingsStore.
    // Rendering reads that state; normalization and updates belong to the store.
    var state = wglob.settings;
    var showNum = state.showNumber;
    var showName = state.showName;
    var channelLogoMode = state.channelLogoMode;
    var showProgress = state.showProgress;
    var showProgram = state.showProgram;
    var showArchive = state.showArchive;
    var showPreview = state.preview;
    var numWidth: number,
        archWidth: number,
        channelLogoSize: number,
        channelLogoMargin: number,
        progWidth: number,
        progBarH: number,
        progMargin: number,
        boxH: number;
    function measureChannelRow(): void {
        var wk = getViewportWidthScale();
        // Honor settings.pageSize. Companion sizes picon/progress from the
        // 90-chrome font formula (setFontSize); showPage row boxes use 130 /
        // live #listIn via listRowHeight — do not mix those bases.
        var pageSz = state.pageSize;
        wglob.listPageSize = pageSz;
        var itemH =
            (window.innerHeight - 90 * getViewportHeightScale()) / pageSz;
        if (!(itemH > 0) || isNaN(itemH)) {
            itemH = Math.max(12 * getViewportHeightScale(), 16);
        }
        // Real showPage row box (130 / live #listIn) — cap picon/archive to it.
        var rowH =
            typeof wglob.listRowHeight === "function"
                ? wglob.listRowHeight(pageSz)
                : (window.innerHeight - 130 * getViewportHeightScale()) /
                  pageSz;
        if (!(rowH > 0) || isNaN(rowH)) rowH = itemH;
        boxH = Math.max(1, Math.floor(Math.min(itemH, rowH)));
        numWidth = 0;
        if (showNum)
            try {
                var testEl = $("#testFont");
                testEl.text("9");
                numWidth =
                    testEl.width() * listArray.length.toString().length +
                    6 * wk;
                testEl.text("");
            } catch (e) {
                console.error(e);
            }
        archWidth = showArchive ? 3 * wk : 0;
        // Picon/progress geometry must fit the real showPage row box (boxH).
        // Sizing from taller 90-chrome itemH made flex children outgrow #itN in
        // WKWebView even with max-height on the row.
        var channelLogoRawSize = [0, Math.max(0, boxH - 2), boxH * 1.5][
            channelLogoMode
        ];
        channelLogoSize = channelLogoRawSize > 0 ? channelLogoRawSize : 0;
        channelLogoMargin = channelLogoSize || !archWidth ? 6 * wk : 0;
        progWidth = showProgress ? 40 * wk : 0;
        progBarH = Math.max(1, Math.floor(boxH / 3.5));
        // Vertical-only margins — all-side margin inflated the flex cross-size.
        progMargin = showProgress ? Math.floor((boxH - progBarH) / 2) : 0;
    }
    measureChannelRow();

    var channelItemFormatter = function (chId: string, idx: number) {
        var ch = channels[chId];
        if (!ch)
            return (
                "&nbsp;&nbsp;" +
                _("Channel is not available!!!") +
                " id=" +
                metadataText(chId)
            );
        // Keep the legacy string formatter ABI. Structural classes and the
        // scoped DOM pass below work under Tauri's nonced style policy.
        // Queue EPG fill for every visible row (OTT). Re-read ch after call:
        // deferred processCurrentProgramQueue may not have run yet; time_to hit returns true.
        observeCurrentProgramme(chId, updateChannelListRow);
        var nowSec = Date.now() / 1e3;
        var progName =
            ch.time_to && ch.time_to >= nowSec && ch.name
                ? metadataText(ch.name)
                : "";
        if (ch.outdated === true)
            progName =
                '<i class="ott-channel-no-epg">' +
                _("no epg at current time") +
                "</i>";
        return (
            (numWidth
                ? '<div class="ott-channel-number">' + (idx + 1) + "</div>"
                : "") +
            (archWidth ? '<div class="ott-channel-archive"></div>' : "") +
            (channelLogoSize
                ? '<div class="img ott-channel-picon"></div>'
                : "") +
            '<div class="ott-channel-label" data-channel-id="' +
            metadataText(chId) +
            '">&nbsp;' +
            (showName ? metadataText(ch.channel_name) + "&nbsp;" : "") +
            (showProgram
                ? '<span id="pn' +
                  metadataText(chId) +
                  '" class="ott-channel-programme">' +
                  progName +
                  "</span></div>"
                : "</div>") +
            (progWidth
                ? '<div class="progress_div ott-channel-progress"><div id="pr' +
                  metadataText(chId) +
                  '" class="ott-channel-progress-fill"></div></div>'
                : "")
        );
    };
    getListItemFn = channelItemFormatter;
    wglob.applyChannelListStyles = function (container: HTMLElement): void {
        // A later menu/provider can replace the formatter. Never apply channel
        // styling to another list or replay styles supplied in metadata.
        if (getListItemFn !== channelItemFormatter) return;
        measureChannelRow();
        var labels = container.querySelectorAll(".ott-channel-label");
        var accent =
            (typeof curColor === "string" && curColor) ||
            wglob.curColor ||
            "gold";
        var foreground =
            (typeof bodyColor === "string" && bodyColor) ||
            wglob.bodyColor ||
            "#f0f0f0";
        for (var li = 0; li < labels.length; li++) {
            var label = labels[li] as HTMLElement;
            var chId = label.getAttribute("data-channel-id") || "";
            var ch = channels[chId];
            var row = label.parentElement;
            if (!ch || !row) continue;
            label.style.color = foreground;
            $(row).toggleClass(
                "ott-playing",
                playType >= 0 && chId === String(curList[primaryIndex])
            );
            var number = row.querySelector(
                ".ott-channel-number"
            ) as HTMLElement | null;
            if (number) {
                number.style.flexBasis = numWidth + "px";
                number.style.maxWidth = numWidth + "px";
                number.style.color =
                    sPSchannels &&
                    parentPIN !== "*" &&
                    parentalArray.indexOf(
                        listArray[Number(row.getAttribute("data-idx"))]
                    ) !== -1
                        ? "#a00"
                        : "";
            }
            var archive = row.querySelector(
                ".ott-channel-archive"
            ) as HTMLElement | null;
            if (archive) {
                archive.style.flexBasis = archWidth + "px";
                archive.style.margin = archWidth + "px";
                archive.style.height = Math.max(1, boxH - archWidth * 2) + "px";
                archive.style.backgroundColor = ch.rec
                    ? state.interfaceTheme === 2
                        ? accent
                        : "lime"
                    : "";
            }
            var picon = row.querySelector(
                ".ott-channel-picon"
            ) as HTMLElement | null;
            if (picon) {
                var safePic = "";
                try {
                    var picUrl = "";
                    try {
                        picUrl =
                            typeof getChannelPicon === "function"
                                ? getChannelPicon(chId) || ""
                                : String((ch as any).logo || "");
                    } catch (_pic) {
                        picUrl = String((ch as any).logo || "");
                    }
                    safePic = metadataCssUrl(picUrl);
                } catch (_invalidPicon) {}
                picon.style.flexBasis = channelLogoSize + "px";
                picon.style.width = channelLogoSize + "px";
                picon.style.height =
                    Math.max(1, Math.min(channelLogoSize, boxH - 2)) + "px";
                picon.style.marginLeft = channelLogoMargin + "px";
                picon.style.backgroundImage = safePic
                    ? 'url("' + safePic + '")'
                    : "";
            }
            var programme = row.querySelector(
                ".ott-channel-programme"
            ) as HTMLElement | null;
            if (programme) programme.style.color = accent;
            var progress = row.querySelector(
                ".ott-channel-progress"
            ) as HTMLElement | null;
            if (progress) {
                progress.style.flexBasis = progWidth + "px";
                progress.style.width = progWidth + "px";
                progress.style.marginTop = progMargin + "px";
                progress.style.marginBottom = progMargin + "px";
                var fill = progress.firstElementChild as HTMLElement | null;
                if (fill) {
                    var current =
                        ch.time_to &&
                        ch.time_to >= Date.now() / 1e3 &&
                        ch.time_to > ch.time;
                    fill.style.width =
                        (current
                            ? Math.max(
                                  0,
                                  Math.min(
                                      100,
                                      ((Date.now() / 1e3 - ch.time) /
                                          (ch.time_to - ch.time)) *
                                          100
                                  )
                              )
                            : 0) + "%";
                    fill.style.height = progBarH + "px";
                    fill.style.backgroundColor = accent;
                }
            }
        }
    };
    listDetail.innerHTML = "";
    detailListAction = detailProg;
    listKeyHandlerFn = channelsKeyHandler;
    // Step 3 FCC: show active favorites list name in caption when on Favorites
    var catName = catsArray[listCatIndex] || "";
    if (catName === "Favorites" || catName === _("Favorites")) {
        var favListName = favoritesListLabel(getActiveFavoritesListName());
        if (favListName && favListName !== _("Favorites")) {
            catName = catName + " - " + favListName;
        }
    }
    listCaptionElement.textContent = _("Channel list. Category: ") + catName;
    listFooter!.innerHTML =
        renderButtonHint(
            keys.RED,
            "",
            "EPG",
            strEPG,
            sArrowFun === 2
                ? strRIGHT
                : sRewFun === 1
                  ? strFF
                  : sPNFun === 1
                    ? strNEXT
                    : ""
        ) +
        renderButtonHint(
            keys.BLUE,
            "",
            "Category",
            strPlayPause,
            sArrowFun === 2
                ? strLEFT
                : sRewFun === 1
                  ? strRW
                  : sPNFun === 1
                    ? strPREV
                    : ""
        ) +
        renderButtonHint(keys.YELLOW, "", "Actions", strTools, "0") +
        renderButtonHint(keys.N2, strInfo, "Description", "2") +
        (typeof stbPlayPip === "function"
            ? renderButtonHint(keys.PIP, strPip, "Open in PiP", strSTOP, "5")
            : "");
    setPopupChannels();
    $("#listPopUp").hide();
    (window as any).listDataArray = listArray;
    previewChan =
        showPreview && catIdx === catIndex && channelIdx === primaryIndex
            ? { c: catIdx, ch_id: listArray[selIndex], i: channelIdx }
            : null;
    showPage();
}

// ─── First run setup wizard ───────────────────────────────────────────────────

/**
 * Show the "First Run Setup" list — a wizard that appears when no provider
 * is yet configured. Provides options to enter a provider code, load
 * settings, or manually select a provider.
 *
 * Side effects: Populates listArray with action entries; installs list
 * handlers; writes to listCaptionElement, listFooter; calls showPage().
 *
 * Edge case: If loadOpt (loadAllOptions) is a function, inserts an extra
 * "Load settings from storage" entry at index 3.
 */
export function firstRun(): void {
    listArray = [
        // OTTPLAY_FULL_ONLY_BEGIN
        { action: edit_dealer, name: _("Enter Provider Code") },
        {
            action: edit_dealer_remote,
            name: _("Enter Provider Code on PC or Phone"),
        },
        { action: loadSettings, name: _("Load settings") },
        { action: noop, name: "" },
        // OTTPLAY_FULL_ONLY_END
        { action: showProviderSelection, name: _("Manual setup") },
    ];
    // OTTPLAY_FULL_ONLY_BEGIN
    if (typeof loadOpt === "function")
        listArray.splice(3, 0, {
            action: loadOpt,
            name: _("Load settings from storage"),
        });
    // OTTPLAY_FULL_ONLY_END
    listArray.unshift({
        action: function () {
            // Change only the selection: existing provider credentials,
            // playlists and provider-scoped settings remain untouched.
            stbSetItem("ottplayprov", "demo");
            loadProv("demo");
        },
        name: _("Try demo"),
    });
    if (isPlayDistribution())
        listArray.push({
            action: function () {
                var showPrivacy = (window as any).privacyPolicy;
                if (typeof showPrivacy === "function") showPrivacy(firstRun);
            },
            name: _("Privacy policy"),
        });
    selIndex = 0;
    getListItemFn = function (item: any, _idx: number) {
        return "&nbsp;&nbsp;" + (item.name || "");
    };
    detailListAction = function () {
        listDetail.innerHTML = listArray[selIndex].name || "";
    };
    listKeyHandlerFn = function (key: number) {
        switch (key) {
            case keys.EXIT:
            case keys.RETURN:
                selectLang();
                return true;
            case keys.ENTER:
                if ((listArray[selIndex] as any).action)
                    (listArray[selIndex] as any).action();
                return true;
        }
        return false;
    };
    listCaptionElement.innerHTML = _("First Run Setup");
    listFooter!.innerHTML = renderButtonHint(keys.RETURN, strRETURN, "Close");
    $("#listPopUp").hide();
    listDataArray = listArray;
    showPage();
}
